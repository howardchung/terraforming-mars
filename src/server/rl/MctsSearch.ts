import {Phase} from '../../common/Phase';
import {PlayerId, GameId, isGameId, safeCast} from '../../common/Types';
import {Units} from '../../common/Units';
import {SeededRandom} from '../../common/utils/Random';
import {GameLoader} from '../database/GameLoader';
import {Game} from '../Game';
import {IGame} from '../IGame';
import {IPlayer} from '../IPlayer';
import {SerializedGame} from '../SerializedGame';
import {
  buildDefaultInputResponse,
  createEmptyStagingState,
  decodeActionSpace,
  DecodedActionSpace,
  PlayerStagingState,
} from './ActionCodec';
import {PolicyNetwork} from './PolicyNetwork';
import {encodeGameState} from './StateEncoder';

export interface MctsConfig {
  /** Maximum number of determinized PUCT simulations per decision. */
  maxSimulations: number;
  /** Wall-clock time budget in milliseconds per decision (0 = unlimited). */
  timeBudgetMs: number;
  /** Exploration constant c_puct for PUCT selection. */
  cPuct: number;
  /** Maximum tree/simulation steps from root before leaf evaluation. */
  maxDepth: number;
  /** Softmax temperature applied to PolicyNetwork priors. */
  priorTemperature: number;
  /** Action selection temperature on root visit counts (0 = greedy argmax). */
  visitTemperature: number;
  /** Whether to shuffle hidden cards (opponent hand + draw pile) per simulation. */
  determinize: boolean;
  /** Optional deterministic RNG seed for reproducible tests. */
  seed?: number;
}

export const DEFAULT_MCTS_CONFIG: MctsConfig = {
  maxSimulations: 48,
  timeBudgetMs: 350,
  cPuct: 1.4,
  maxDepth: 12,
  priorTemperature: 1.0,
  visitTemperature: 0.0,
  determinize: true,
};

export interface MctsActionStat {
  actionIndex: number;
  visits: number;
  qValue: number;
  prior: number;
  probability: number;
}

export interface MctsSearchResult {
  actionIndex: number;
  probability: number;
  valueEstimate: number;
  winProbability: number;
  simulationsRun: number;
  elapsedMs: number;
  usedFallback: boolean;
  topActions: Array<{actionIndex: number; probability: number}>;
  allActions: Array<MctsActionStat>;
}

interface MctsEdge {
  actionIndex: number;
  prior: number;
  visits: number;
  valueSum: number;
  availabilityVisits: number;
  child: MctsNode | undefined;
}

interface MctsNode {
  expanded: boolean;
  edges: Map<number, MctsEdge>;
}

let cloneCounter = 0;

function createRng(seed?: number): () => number {
  let state = ((seed ?? (Date.now() ^ Math.floor(Math.random() * 0x7fffffff))) >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffleInPlace<T>(arr: Array<T>, rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function cloneStagingState(src: PlayerStagingState | undefined, waitingForRef: PlayerStagingState['waitingForRef']): PlayerStagingState {
  if (!src) {
    return createEmptyStagingState();
  }
  return {
    waitingForRef,
    initialStage: src.initialStage,
    selectedCorp: src.selectedCorp,
    selectedPreludes: [...src.selectedPreludes],
    selectedProjects: [...src.selectedProjects],
    multiCardSelected: [...src.multiCardSelected],
    inSellPatentsSubstep: src.inSellPatentsSubstep,
    sellPatentsOptIdx: src.sellPatentsOptIdx,
    selectedUnits: Units.of({...src.selectedUnits}),
  };
}

function createNode(): MctsNode {
  return {
    expanded: false,
    edges: new Map(),
  };
}

/**
 * Convert PolicyNetwork's raw critic output to [-1, +1] range so leaf
 * evaluations sit on the same scale as terminal outcomes (+1 win, -1 loss).
 */
function criticValueToUnitScale(rawValue: number): number {
  const winProb = PolicyNetwork.valueToWinProbability(rawValue);
  return 2 * winProb - 1;
}

/**
 * Convert a [-1, +1] MCTS Q-value back to PolicyNetwork's logit-like value scale
 * so `PolicyNetwork.valueToWinProbability(valueEstimate)` recovers `(q + 1) / 2`.
 */
function unitScaleToValueEstimate(q: number): number {
  const winProb = Math.max(0.01, Math.min(0.99, (q + 1) * 0.5));
  return Math.log(winProb / (1 - winProb)) / 2.2;
}

function evaluateTerminalValue(game: IGame, perspectivePlayerId: PlayerId): number {
  const self = game.players.find((p) => p.id === perspectivePlayerId);
  if (!self || game.players.length < 2) {
    return 0;
  }
  const myVp = self.getVictoryPoints().total;
  let bestOppVp = -Infinity;
  let bestOppMc = -Infinity;
  for (const other of game.players) {
    if (other.id === self.id) {
      continue;
    }
    const ovp = other.getVictoryPoints().total;
    if (ovp > bestOppVp || (ovp === bestOppVp && other.megaCredits > bestOppMc)) {
      bestOppVp = ovp;
      bestOppMc = other.megaCredits;
    }
  }
  if (myVp > bestOppVp || (myVp === bestOppVp && self.megaCredits > bestOppMc)) {
    return 1.0;
  }
  if (myVp < bestOppVp || (myVp === bestOppVp && self.megaCredits < bestOppMc)) {
    return -1.0;
  }
  return 0.0;
}

function findWaitingPlayer(game: IGame): IPlayer | undefined {
  if (game.activePlayer.getWaitingFor() !== undefined) {
    return game.activePlayer;
  }
  for (const p of game.playersInGenerationOrder) {
    if (p.getWaitingFor() !== undefined) {
      return p;
    }
  }
  return undefined;
}

/**
 * Determinize hidden information in a cloned SerializedGame from `observerId`'s perspective:
 * - Pools opponent(s)' `cardsInHand` with `projectDeck.drawPile`, shuffles, and redeals
 *   the same hand sizes so MCTS cannot peek at opponent hands or deck order.
 * - Shuffles `preludeDeck.drawPile` and `corporationDeck.drawPile`.
 * - Reseeds the RNG so future draws/shuffles vary across simulations.
 */
export function determinizeSerializedGame(
  serialized: SerializedGame,
  observerId: PlayerId,
  rand: () => number,
): void {
  // 1. Project cards: pool unseen opponent hands + draw pile
  const hiddenProjectPool: Array<typeof serialized.projectDeck.drawPile[number]> = [
    ...serialized.projectDeck.drawPile,
  ];
  const oppHandSizes: Array<{playerIdx: number; count: number}> = [];

  for (let i = 0; i < serialized.players.length; i++) {
    const p = serialized.players[i];
    if (p.id === observerId) {
      continue;
    }
    if (p.cardsInHand.length > 0) {
      oppHandSizes.push({playerIdx: i, count: p.cardsInHand.length});
      hiddenProjectPool.push(...p.cardsInHand);
    }
  }

  if (hiddenProjectPool.length > 1) {
    shuffleInPlace(hiddenProjectPool, rand);
    let cursor = 0;
    for (const entry of oppHandSizes) {
      serialized.players[entry.playerIdx].cardsInHand = hiddenProjectPool.slice(cursor, cursor + entry.count);
      cursor += entry.count;
    }
    serialized.projectDeck.drawPile = hiddenProjectPool.slice(cursor);
  }

  // 2. Shuffle remaining unseen draw piles
  if (serialized.preludeDeck.drawPile.length > 1) {
    shuffleInPlace(serialized.preludeDeck.drawPile, rand);
  }
  if (serialized.corporationDeck.drawPile.length > 1) {
    shuffleInPlace(serialized.corporationDeck.drawPile, rand);
  }

  // 3. Reseed RNG for this determinization
  serialized.rng = new SeededRandom(rand()).serialize();
}

function instantiateIsolatedClone(
  baseSerialized: SerializedGame,
  observerId: PlayerId,
  determinize: boolean,
  rand: () => number,
): {game: Game; cloneId: GameId} {
  const copy = structuredClone(baseSerialized);
  const cloneId = safeCast(`g_mcts_${++cloneCounter}_${Math.floor(rand() * 1e6)}`, isGameId);
  copy.id = cloneId;
  // Clear log history to avoid unnecessary cloning/memory overhead
  copy.gameLog = [];

  if (determinize) {
    determinizeSerializedGame(copy, observerId, rand);
  }

  // Mark as training game BEFORE deserialize so any internal save() is a no-op
  GameLoader.markAsTrainingGame(cloneId);
  const game = Game.deserialize(copy);
  game.save = () => {
    game.lastSaveId++;
  };
  game.log = () => {};
  return {game, cloneId};
}

function applyDecodedAction(player: IPlayer, decoded: DecodedActionSpace, actionIndex: number): boolean {
  const binding = decoded.bindings.get(actionIndex);
  if (!binding) {
    return false;
  }
  const response = binding.execute();
  if (response === undefined) {
    return true;
  }
  try {
    player.process(response);
    return true;
  } catch (_err) {
    try {
      const wf = player.getWaitingFor();
      if (wf !== undefined) {
        player.process(buildDefaultInputResponse(player, wf));
        return true;
      }
    } catch (_err2) {
      // Ignore fallback failure
    }
    return false;
  }
}

function buildFallbackResult(
  policyNet: PolicyNetwork,
  stateVec: Float32Array,
  decoded: DecodedActionSpace,
  legalIndices: ReadonlyArray<number>,
  startMs: number,
  temperature: number,
): MctsSearchResult {
  const evalRes = policyNet.evaluate(stateVec, decoded.mask, 'greedy', temperature);
  const allActions: Array<MctsActionStat> = evalRes.allActions.map((a) => ({
    actionIndex: a.actionIndex,
    visits: 0,
    qValue: criticValueToUnitScale(evalRes.valueEstimate),
    prior: a.probability,
    probability: a.probability,
  }));
  return {
    actionIndex: evalRes.actionIndex ?? legalIndices[0] ?? 0,
    probability: evalRes.probability,
    valueEstimate: evalRes.valueEstimate,
    winProbability: evalRes.winProbability,
    simulationsRun: 0,
    elapsedMs: Date.now() - startMs,
    usedFallback: true,
    topActions: evalRes.topActions,
    allActions,
  };
}

/**
 * Determinized PUCT Monte Carlo Tree Search (ISMCTS) guided by `PolicyNetwork`.
 *
 * Uses the existing actor head for action priors P(s, a) and critic head for
 * leaf value estimates V(s), with per-simulation determinization of hidden
 * opponent hands and draw piles.
 */
export class MctsSearch {
  public readonly policyNet: PolicyNetwork;
  public readonly config: MctsConfig;

  constructor(policyNet: PolicyNetwork, config?: Partial<MctsConfig>) {
    this.policyNet = policyNet;
    this.config = {...DEFAULT_MCTS_CONFIG, ...config};
  }

  public search(
    game: IGame,
    rootPlayer: IPlayer,
    rootStaging: PlayerStagingState,
    rootDecoded?: DecodedActionSpace,
  ): MctsSearchResult {
    const startMs = Date.now();
    const decoded = rootDecoded ?? decodeActionSpace(rootPlayer, rootStaging);
    const legalIndices: Array<number> = [];
    for (let i = 0; i < decoded.mask.length; i++) {
      if (decoded.mask[i]) {
        legalIndices.push(i);
      }
    }

    const rootStateVec = encodeGameState(rootPlayer, rootStaging, decoded.mask);

    // Single legal action or no legal actions: return immediately
    if (legalIndices.length <= 1) {
      const actionIndex = legalIndices[0] ?? 0;
      const rawVal = this.policyNet.forwardValue(rootStateVec);
      const winProb = PolicyNetwork.valueToWinProbability(rawVal);
      return {
        actionIndex,
        probability: 1.0,
        valueEstimate: rawVal,
        winProbability: winProb,
        simulationsRun: 0,
        elapsedMs: Date.now() - startMs,
        usedFallback: false,
        topActions: [{actionIndex, probability: 1.0}],
        allActions: [{
          actionIndex,
          visits: 0,
          qValue: criticValueToUnitScale(rawVal),
          prior: 1.0,
          probability: 1.0,
        }],
      };
    }

    // Game.deserialize() only restores top-level phase prompts, not mid-card
    // deferred actions or prelude selection prompts. Fall back cleanly to PolicyNetwork.
    if (
      game.phase === Phase.END ||
      game.phase === Phase.PRELUDES ||
      game.deferredActions.length > 0
    ) {
      return buildFallbackResult(
        this.policyNet,
        rootStateVec,
        decoded,
        legalIndices,
        startMs,
        this.config.priorTemperature,
      );
    }

    let baseSerialized: SerializedGame;
    try {
      baseSerialized = game.serialize();
    } catch (_err) {
      return buildFallbackResult(
        this.policyNet,
        rootStateVec,
        decoded,
        legalIndices,
        startMs,
        this.config.priorTemperature,
      );
    }

    const rand = createRng(this.config.seed);

    // Evaluate root with PolicyNetwork to initialize root priors
    const rootEval = this.policyNet.evaluate(
      rootStateVec,
      decoded.mask,
      'greedy',
      this.config.priorTemperature,
    );
    const rootNode = createNode();
    rootNode.expanded = true;
    for (const item of rootEval.allActions) {
      rootNode.edges.set(item.actionIndex, {
        actionIndex: item.actionIndex,
        prior: item.probability,
        visits: 0,
        valueSum: 0,
        availabilityVisits: 0,
        child: undefined,
      });
    }

    // Verify at least one clone matches the root legal action space before looping
    let simulationsRun = 0;
    const deadline = this.config.timeBudgetMs > 0 ? startMs + this.config.timeBudgetMs : Infinity;

    for (let sim = 0; sim < this.config.maxSimulations; sim++) {
      if (sim > 0 && Date.now() >= deadline) {
        break;
      }

      let cloneId: GameId | undefined;
      try {
        const cloned = instantiateIsolatedClone(
          baseSerialized,
          rootPlayer.id,
          this.config.determinize,
          rand,
        );
        cloneId = cloned.cloneId;
        const simGame = cloned.game;

        const simRootPlayer = simGame.players.find((p) => p.id === rootPlayer.id);
        if (!simRootPlayer || simRootPlayer.getWaitingFor() === undefined) {
          if (sim === 0) {
            return buildFallbackResult(
              this.policyNet,
              rootStateVec,
              decoded,
              legalIndices,
              startMs,
              this.config.priorTemperature,
            );
          }
          continue;
        }

        const simStagings = new Map<PlayerId, PlayerStagingState>();
        for (const p of simGame.players) {
          if (p.id === rootPlayer.id) {
            simStagings.set(p.id, cloneStagingState(rootStaging, p.getWaitingFor()));
          } else {
            simStagings.set(p.id, createEmptyStagingState());
          }
        }

        // On first simulation, verify the deserialized root matches our legal actions
        if (sim === 0) {
          const simRootStaging = simStagings.get(simRootPlayer.id) ?? createEmptyStagingState();
          const checkDecoded = decodeActionSpace(simRootPlayer, simRootStaging);
          let overlap = 0;
          for (const idx of legalIndices) {
            if (checkDecoded.mask[idx]) {
              overlap++;
            }
          }
          if (overlap < legalIndices.length) {
            return buildFallbackResult(
              this.policyNet,
              rootStateVec,
              decoded,
              legalIndices,
              startMs,
              this.config.priorTemperature,
            );
          }
        }

        this.runSingleSimulation(simGame, simStagings, rootNode);
        simulationsRun++;
      } catch (_err) {
        if (sim === 0 && simulationsRun === 0) {
          return buildFallbackResult(
            this.policyNet,
            rootStateVec,
            decoded,
            legalIndices,
            startMs,
            this.config.priorTemperature,
          );
        }
      } finally {
        if (cloneId !== undefined) {
          GameLoader.unmarkTrainingGame(cloneId);
        }
      }
    }

    if (simulationsRun === 0) {
      return buildFallbackResult(
        this.policyNet,
        rootStateVec,
        decoded,
        legalIndices,
        startMs,
        this.config.priorTemperature,
      );
    }

    // Aggregate root statistics
    let totalVisits = 0;
    for (const edge of rootNode.edges.values()) {
      totalVisits += edge.visits;
    }

    const stats: Array<MctsActionStat> = [];
    for (const idx of legalIndices) {
      const edge = rootNode.edges.get(idx);
      const visits = edge?.visits ?? 0;
      const prior = edge?.prior ?? 0;
      const qValue = (edge && visits > 0) ? edge.valueSum / visits : criticValueToUnitScale(rootEval.valueEstimate);
      const probability = totalVisits > 0 ? visits / totalVisits : prior;
      stats.push({
        actionIndex: idx,
        visits,
        qValue,
        prior,
        probability,
      });
    }

    // Sort by visits desc, then qValue desc, then prior desc
    stats.sort((a, b) => {
      if (b.visits !== a.visits) {
        return b.visits - a.visits;
      }
      if (b.qValue !== a.qValue) {
        return b.qValue - a.qValue;
      }
      return b.prior - a.prior;
    });

    const chosen = this.selectRootAction(stats, rand);
    const chosenWinProb = Math.max(0.01, Math.min(0.99, (chosen.qValue + 1) * 0.5));
    const chosenValueEstimate = unitScaleToValueEstimate(chosen.qValue);

    return {
      actionIndex: chosen.actionIndex,
      probability: chosen.probability,
      valueEstimate: chosenValueEstimate,
      winProbability: chosenWinProb,
      simulationsRun,
      elapsedMs: Date.now() - startMs,
      usedFallback: false,
      topActions: stats.slice(0, 5).map((s) => ({
        actionIndex: s.actionIndex,
        probability: s.probability,
      })),
      allActions: stats,
    };
  }

  private runSingleSimulation(
    simGame: Game,
    simStagings: Map<PlayerId, PlayerStagingState>,
    rootNode: MctsNode,
  ): void {
    const path: Array<{edge: MctsEdge; actingPlayerId: PlayerId}> = [];
    let currentNode = rootNode;
    let leafPlayerId: PlayerId = simGame.activePlayer.id;
    let leafValue = 0;

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      if (simGame.phase === Phase.END) {
        leafValue = evaluateTerminalValue(simGame, leafPlayerId);
        break;
      }

      const actingPlayer = findWaitingPlayer(simGame);
      if (!actingPlayer) {
        leafValue = evaluateTerminalValue(simGame, leafPlayerId);
        break;
      }
      leafPlayerId = actingPlayer.id;

      let staging = simStagings.get(actingPlayer.id);
      if (!staging) {
        staging = createEmptyStagingState();
        simStagings.set(actingPlayer.id, staging);
      }

      const decoded = decodeActionSpace(actingPlayer, staging);
      const legalIndices: Array<number> = [];
      for (let i = 0; i < decoded.mask.length; i++) {
        if (decoded.mask[i]) {
          legalIndices.push(i);
        }
      }
      if (legalIndices.length === 0) {
        leafValue = evaluateTerminalValue(simGame, leafPlayerId);
        break;
      }

      // Expansion: if this node hasn't been expanded yet, evaluate with PolicyNetwork and stop
      if (!currentNode.expanded) {
        const stateVec = encodeGameState(actingPlayer, staging, decoded.mask);
        const evalRes = this.policyNet.evaluate(
          stateVec,
          decoded.mask,
          'greedy',
          this.config.priorTemperature,
        );
        currentNode.expanded = true;
        for (const item of evalRes.allActions) {
          currentNode.edges.set(item.actionIndex, {
            actionIndex: item.actionIndex,
            prior: item.probability,
            visits: 0,
            valueSum: 0,
            availabilityVisits: 0,
            child: undefined,
          });
        }
        leafValue = criticValueToUnitScale(evalRes.valueEstimate);
        break;
      }

      // Selection (ISMCTS-PUCT): only consider edges legal in this determinization
      const legalEdges: Array<MctsEdge> = [];
      for (const idx of legalIndices) {
        let edge = currentNode.edges.get(idx);
        if (!edge) {
          // Action became legal in this determinization (e.g. different dealt cards)
          edge = {
            actionIndex: idx,
            prior: 1 / legalIndices.length,
            visits: 0,
            valueSum: 0,
            availabilityVisits: 0,
            child: undefined,
          };
          currentNode.edges.set(idx, edge);
        }
        edge.availabilityVisits++;
        legalEdges.push(edge);
      }

      let bestEdge = legalEdges[0];
      let bestScore = -Infinity;
      for (const edge of legalEdges) {
        const q = edge.visits > 0 ? edge.valueSum / edge.visits : 0;
        const u = this.config.cPuct * edge.prior * Math.sqrt(Math.max(1, edge.availabilityVisits)) / (1 + edge.visits);
        const score = q + u;
        if (score > bestScore) {
          bestScore = score;
          bestEdge = edge;
        }
      }

      path.push({edge: bestEdge, actingPlayerId: actingPlayer.id});

      const ok = applyDecodedAction(actingPlayer, decoded, bestEdge.actionIndex);
      if (!ok) {
        const stateVec = encodeGameState(actingPlayer, staging, decoded.mask);
        leafValue = criticValueToUnitScale(this.policyNet.forwardValue(stateVec));
        break;
      }

      if (!bestEdge.child) {
        bestEdge.child = createNode();
      }
      currentNode = bestEdge.child;

      // If we reached maxDepth, evaluate the resulting leaf state
      if (depth === this.config.maxDepth - 1) {
        if ((simGame.phase as Phase) === Phase.END) {
          leafValue = evaluateTerminalValue(simGame, leafPlayerId);
        } else {
          const nextPlayer = findWaitingPlayer(simGame) ?? actingPlayer;
          leafPlayerId = nextPlayer.id;
          const nextStaging = simStagings.get(nextPlayer.id) ?? createEmptyStagingState();
          const nextVec = encodeGameState(nextPlayer, nextStaging);
          leafValue = criticValueToUnitScale(this.policyNet.forwardValue(nextVec));
        }
      }
    }

    // Backpropagation: sign value relative to each edge's acting player
    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i];
      const signedValue = step.actingPlayerId === leafPlayerId ? leafValue : -leafValue;
      step.edge.visits++;
      step.edge.valueSum += signedValue;
    }
  }

  private selectRootAction(stats: ReadonlyArray<MctsActionStat>, rand: () => number): MctsActionStat {
    const temp = this.config.visitTemperature;
    if (temp <= 1e-3 || stats.length === 1) {
      return stats[0];
    }
    const weights = stats.map((s) => Math.pow(Math.max(0, s.visits), 1 / temp));
    const sum = weights.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) {
      return stats[0];
    }
    const r = rand() * sum;
    let cumulative = 0;
    for (let i = 0; i < stats.length; i++) {
      cumulative += weights[i];
      if (r <= cumulative) {
        return stats[i];
      }
    }
    return stats[stats.length - 1];
  }
}
