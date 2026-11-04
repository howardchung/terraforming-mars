import {Phase} from '../../common/Phase';
import {isPlayerId, isSpectatorId, isGameId, safeCast, GameId, PlayerId, SpectatorId} from '../../common/Types';
import {GameLoader} from '../database/GameLoader';
import {Game} from '../Game';
import {IPlayer} from '../IPlayer';

type PlayerVpBreakdown = ReturnType<IPlayer['getVictoryPoints']>;
import {Player} from '../Player';
import {generateRandomId} from '../utils/server-ids';
import {
  createEmptyStagingState,
  decodeActionSpace,
  DecodedActionSpace,
  PlayerStagingState,
  buildDefaultInputResponse,
} from './ActionCodec';
import {SpaceBonus} from '../../common/boards/SpaceBonus';
import {CardName} from '../../common/cards/CardName';
import {Tag} from '../../common/cards/Tag';
import {TileType} from '../../common/TileType';
import {ICard} from '../cards/ICard';
import {
  ACTION_CONFIRM_SELECTION,
  ACTION_CONVERT_HEAT,
  ACTION_CONVERT_PLANTS,
  ACTION_END_TURN,
  ACTION_OFFSET_AWARD,
  ACTION_OFFSET_BLUE_PROJECT,
  ACTION_OFFSET_CARD,
  ACTION_OFFSET_CORP_ACTION,
  ACTION_OFFSET_MILESTONE,
  ACTION_OFFSET_RESOURCE,
  ACTION_OFFSET_SPACE,
  ACTION_OFFSET_STD_PROJECT,
  ACTION_PASS,
  ALL_CANONICAL_CARDS,
  CANONICAL_CARDS_BY_NAME,
  CANONICAL_CORP_CARDS,
  CANONICAL_PROJECT_CARDS,
  NUM_AWARDS,
  NUM_BOARD_SPACES,
  NUM_CORP_CARDS,
  NUM_MILESTONES,
  NUM_PRELUDE_CARDS,
  NUM_PROJECT_CARDS,
  NUM_STANDARD_PROJECTS,
  NUM_TOTAL_CARDS,
  RL_TRAINING_GAME_OPTIONS,
} from './CardIndex';
import {encodeGameState} from './StateEncoder';

export interface PlayerProgressSnapshot {
  tr: number;
  vp: number;
  oppVp: number;
  prodValue: number;
}

export interface StepObservation {
  envId: string;
  gameId: GameId;
  spectatorId: SpectatorId;
  activePlayerIndex: number; // 0 or 1
  activePlayerId: PlayerId;
  generation: number;
  phase: string;
  promptTitle: string;
  state: Array<number>;
  mask: Array<boolean>;
  legalActionIndices: Array<number>;
  done: boolean;
  rewards: [number, number]; // cumulative step rewards for [player0, player1] since their last decision
  info: {
    p0Vp: number;
    p1Vp: number;
    p0Tr: number;
    p1Tr: number;
    winner: number | null; // 0, 1, or -1 (tie), null if not done
    stepsCount: number;
  };
}

/** StepObservation with the state as base64-encoded little-endian float32 and no mask. */
export type CompactStepObservation = Omit<StepObservation, 'state' | 'mask'> & {stateB64: string};

function computePlayerProgress(
  player: IPlayer,
  vpTotal: number,
  oppVpTotal: number,
): PlayerProgressSnapshot {
  const game = player.game;
  const oxy = game.getOxygenLevel();
  const temp = game.getTemperature();
  const oceans = game.board.getOceanSpaces().length;
  const remSteps = Math.max(0, (14 - oxy) + Math.round((8 - temp) / 2) + (9 - oceans));
  const remFactor = Math.min(1.0, remSteps / 35.0);

  const p = player.production;
  const prodValue =
    remFactor *
    (1.0 * p.megacredits +
      1.8 * p.steel +
      2.6 * p.titanium +
      1.6 * p.plants +
      1.4 * p.energy +
      0.9 * p.heat);

  return {
    tr: player.terraformRating,
    vp: vpTotal,
    oppVp: oppVpTotal,
    prodValue,
  };
}

function computeDeltaReward(prev: PlayerProgressSnapshot, curr: PlayerProgressSnapshot): number {
  const dTr = curr.tr - prev.tr;
  const dNetVp = (curr.vp - 0.5 * curr.oppVp) - (prev.vp - 0.5 * prev.oppVp);
  const dProd = curr.prodValue - prev.prodValue;
  return 0.015 * dTr + 0.02 * dNetVp + 0.005 * dProd;
}

export class RlGameEnvironment {
  public readonly envId: string;
  public game!: Game;
  public players!: [Player, Player];
  public stagings!: [PlayerStagingState, PlayerStagingState];
  public snapshots!: [PlayerProgressSnapshot, PlayerProgressSnapshot];
  public cachedVps!: [PlayerVpBreakdown, PlayerVpBreakdown];
  public lastDecoded: DecodedActionSpace | undefined;
  public pendingRewards: [number, number] = [0, 0];
  public terminalAssigned = false;
  public stepsCount = 0;
  public registerInGameLoader: boolean;
  private maxGenerations = 22;
  private maxSteps = 1800;

  constructor(envId: string, registerInGameLoader: boolean = true) {
    this.envId = envId;
    this.registerInGameLoader = registerInGameLoader;
    this.reset();
  }

  public reset(seed?: number, playerNames?: [string, string] | null): StepObservation {
    this.resetGame(seed, playerNames);
    return this.getObservation();
  }

  /** Starts a new game without building an observation. Call observe() afterwards. */
  public resetGame(seed?: number, playerNames?: [string, string] | null): void {
    const names: [string, string] = playerNames ?? ['RL-Agent-1', 'RL-Agent-2'];
    if (this.game !== undefined) {
      if (this.registerInGameLoader) {
        const loader = GameLoader.getInstance();
        if (loader instanceof GameLoader) {
          void loader.removeTrainingGame(this.game);
        }
      } else {
        GameLoader.unmarkTrainingGame(this.game.id);
      }
    }

    const gameId = safeCast(generateRandomId('g'), isGameId);
    const spectatorId = safeCast(generateRandomId('s'), isSpectatorId);
    const p0Id = safeCast(generateRandomId('p'), isPlayerId);
    const p1Id = safeCast(generateRandomId('p'), isPlayerId);

    // Mark as training game BEFORE Game.newInstance() runs so initial save() is also a no-op
    GameLoader.markAsTrainingGame(gameId);

    const p0 = new Player(names[0], 'red', false, 0, p0Id);
    const p1 = new Player(names[1], 'blue', false, 0, p1Id);
    this.players = [p0, p1];

    const actualSeed = seed ?? Math.random();
    const firstPlayer = actualSeed < 0.5 ? p0 : p1;

    this.game = Game.newInstance(
      gameId,
      [p0, p1],
      firstPlayer,
      spectatorId,
      {...RL_TRAINING_GAME_OPTIONS},
      actualSeed,
    );

    // Avoid synchronous database writes on every turn during fast training,
    // while keeping the game live in GameLoader's in-memory map for UI viewing!
    this.game.save = () => {
      this.game.lastSaveId++;
    };

    if (this.registerInGameLoader) {
      void GameLoader.getInstance().add(this.game);
    } else {
      // Suppress log message allocations during headless training
      this.game.log = () => {};
    }

    this.stagings = [createEmptyStagingState(), createEmptyStagingState()];
    const vpb0 = p0.getVictoryPoints();
    const vpb1 = p1.getVictoryPoints();
    this.cachedVps = [vpb0, vpb1];
    this.snapshots = [
      computePlayerProgress(p0, vpb0.total, vpb1.total),
      computePlayerProgress(p1, vpb1.total, vpb0.total),
    ];
    this.lastDecoded = undefined;
    this.pendingRewards = [0, 0];
    this.terminalAssigned = false;
    this.stepsCount = 0;
  }

  public getActivePlayerIndex(): number {
    // Check game.activePlayer first if it has waitingFor
    const active = this.game.activePlayer;
    if (active.getWaitingFor() !== undefined) {
      return active.id === this.players[0].id ? 0 : 1;
    }
    if (this.players[0].getWaitingFor() !== undefined) {
      return 0;
    }
    if (this.players[1].getWaitingFor() !== undefined) {
      return 1;
    }
    return 0;
  }

  public isDone(): boolean {
    if (this.game.phase === Phase.END) {
      return true;
    }
    if (this.stepsCount >= this.maxSteps || this.game.generation > this.maxGenerations) {
      return true;
    }
    const anyWaiting =
      this.players[0].getWaitingFor() !== undefined ||
      this.players[1].getWaitingFor() !== undefined;
    return !anyWaiting;
  }

  private updateDenseRewards(): void {
    const p0 = this.players[0];
    const p1 = this.players[1];
    const vpb0 = p0.getVictoryPoints();
    const vpb1 = p1.getVictoryPoints();
    this.cachedVps = [vpb0, vpb1];
    const snap0 = computePlayerProgress(p0, vpb0.total, vpb1.total);
    const snap1 = computePlayerProgress(p1, vpb1.total, vpb0.total);

    this.pendingRewards[0] += computeDeltaReward(this.snapshots[0], snap0);
    this.pendingRewards[1] += computeDeltaReward(this.snapshots[1], snap1);

    this.snapshots[0] = snap0;
    this.snapshots[1] = snap1;
  }

  private maybeAssignTerminalRewards(): number | null {
    if (!this.isDone()) {
      return null;
    }
    const p0 = this.players[0];
    const p1 = this.players[1];
    const vp0 = this.cachedVps[0].total;
    const vp1 = this.cachedVps[1].total;

    let winner: number;
    if (vp0 > vp1) {
      winner = 0;
    } else if (vp1 > vp0) {
      winner = 1;
    } else if (p0.megaCredits > p1.megaCredits) {
      winner = 0;
    } else if (p1.megaCredits > p0.megaCredits) {
      winner = 1;
    } else {
      winner = -1;
    }

    if (!this.terminalAssigned) {
      this.terminalAssigned = true;
      const margin = Math.max(-1.0, Math.min(1.0, (vp0 - vp1) / 40.0)) * 0.5;
      const winBonus0 = winner === 0 ? 1.0 : winner === 1 ? -1.0 : 0.0;
      const winBonus1 = -winBonus0;

      // Penalty if truncated due to generation/step limit before terraforming
      const truncatedPenalty = this.game.phase !== Phase.END ? -0.25 : 0.0;

      this.pendingRewards[0] += winBonus0 + margin + truncatedPenalty;
      this.pendingRewards[1] += winBonus1 - margin + truncatedPenalty;
    }

    return winner;
  }

  public step(actionIndex: number): StepObservation {
    if (this.isDone()) {
      return this.getObservation();
    }
    this.applyAction(actionIndex);
    return this.observe();
  }

  /** Decoded action space for the currently active player (cached until the next action). */
  public getDecoded(): DecodedActionSpace {
    if (this.lastDecoded === undefined) {
      const pIdx = this.getActivePlayerIndex();
      this.lastDecoded = decodeActionSpace(this.players[pIdx], this.stagings[pIdx]);
    }
    return this.lastDecoded;
  }

  /**
   * Applies an action without building an observation. Used for auto-opponent moves whose
   * observations would be discarded. Dense rewards are computed lazily in observe(); because
   * the shaped reward is a linear function of snapshot differences, the accumulated value for
   * the observing player is the same as updating after every step.
   */
  public applyAction(actionIndex: number): void {
    if (this.isDone()) {
      return;
    }

    const pIdx = this.getActivePlayerIndex();
    const player = this.players[pIdx];
    const decoded = this.getDecoded();

    let binding = decoded.bindings.get(actionIndex);
    if (binding === undefined) {
      const firstLegal = decoded.bindings.values().next().value;
      binding = firstLegal;
    }

    if (binding !== undefined) {
      const response = binding.execute();
      if (response !== undefined) {
        try {
          player.process(response);
        } catch (_err) {
          // Fallback to default valid input response if a specific card interaction failed
          try {
            const wf = player.getWaitingFor();
            if (wf !== undefined) {
              player.process(buildDefaultInputResponse(player, wf));
            }
          } catch (_err2) {
            // Ignore
          }
        }
      }
    }

    this.stepsCount++;
    this.lastDecoded = undefined;
  }

  /** Updates dense/terminal rewards and returns the observation for the active player. */
  public observe(): StepObservation {
    this.syncRewards();
    return this.getObservation();
  }

  /** Brings pending dense/terminal rewards up to date with the current game state. */
  public syncRewards(): void {
    this.updateDenseRewards();
    this.maybeAssignTerminalRewards();
  }

  public getObservation(): StepObservation {
    const {stateTyped, ...rest} = this.buildObservation();
    return {...rest, state: Array.from(stateTyped), mask: this.lastDecoded!.mask};
  }

  /**
   * Compact observation for the stdio worker: the state vector is sent as base64 float32
   * and the mask is omitted (it is reconstructible from legalActionIndices). This avoids
   * boxing 1532 floats into a JS array and is ~10x cheaper to parse in Python.
   */
  public getCompactObservation(): CompactStepObservation {
    const {stateTyped, ...rest} = this.buildObservation();
    const stateB64 = Buffer.from(stateTyped.buffer, stateTyped.byteOffset, stateTyped.byteLength).toString('base64');
    return {...rest, stateB64};
  }

  private buildObservation(): Omit<StepObservation, 'state' | 'mask'> & {stateTyped: Float32Array} {
    const done = this.isDone();
    const winner = done ? this.maybeAssignTerminalRewards() : null;
    const pIdx = this.getActivePlayerIndex();
    const player = this.players[pIdx];
    const staging = this.stagings[pIdx];

    const decoded = this.getDecoded();
    const stateTyped = encodeGameState(player, staging, decoded.mask, {
      selfVp: this.cachedVps[pIdx],
      oppVp: this.cachedVps[1 - pIdx],
    });
    const legalActionIndices: Array<number> = [];
    for (let i = 0; i < decoded.mask.length; i++) {
      if (decoded.mask[i]) {
        legalActionIndices.push(i);
      }
    }

    // Consume accumulated rewards when returning observation
    const rewards: [number, number] = [this.pendingRewards[0], this.pendingRewards[1]];
    this.pendingRewards[pIdx] = 0;
    if (done) {
      this.pendingRewards[0] = 0;
      this.pendingRewards[1] = 0;
    }

    return {
      envId: this.envId,
      gameId: this.game.id,
      spectatorId: this.game.spectatorId,
      activePlayerIndex: pIdx,
      activePlayerId: player.id,
      generation: this.game.generation,
      phase: this.game.phase,
      promptTitle: decoded.promptTitle,
      stateTyped,
      legalActionIndices,
      done,
      rewards,
      info: {
        p0Vp: this.cachedVps[0].total,
        p1Vp: this.cachedVps[1].total,
        p0Tr: this.players[0].terraformRating,
        p1Tr: this.players[1].terraformRating,
        winner,
        stepsCount: this.stepsCount,
      },
    };
  }
}

/**
 * Heuristic action selector for baseline comparison & warm-start guidance.
 * Prioritizes:
 * 1. Claiming Milestones (+5 VP for 8 M€)
 * 2. Converting Plants into Greenery (+1 Oxygen/TR +1 VP)
 * 3. Using Blue Card Actions & Corporation Initial Actions
 * 4. Playing Project Cards & Preludes
 * 5. Converting 8 Heat into Temperature (+1 TR)
 * 6. Funding Awards (mid/late game when ahead)
 * 7. Standard Projects (Greenery/Aquifer/Asteroid when rich)
 * 8. Passing / Ending Turn only when no high-value actions remain
 */
export function scoreHeuristicActions(
  player: IPlayer,
  decoded: DecodedActionSpace,
): Array<{actionIndex: number; score: number}> {
  const legal: Array<number> = [];
  for (let i = 0; i < decoded.mask.length; i++) {
    if (decoded.mask[i]) {
      legal.push(i);
    }
  }
  if (legal.length === 0) {
    return [];
  }

  const results: Array<{actionIndex: number; score: number}> = [];
  for (const aIdx of legal) {
    let score = Math.random() * 0.25; // slight tie-breaking noise

    // Milestones: highest priority
    if (aIdx >= ACTION_OFFSET_MILESTONE && aIdx < ACTION_OFFSET_MILESTONE + NUM_MILESTONES) {
      score += 100.0;
    } else if (aIdx === ACTION_CONVERT_PLANTS) {
      // Convert plants
      score += 85.0;
    } else if (aIdx >= ACTION_OFFSET_SPACE && aIdx < ACTION_OFFSET_SPACE + NUM_BOARD_SPACES) {
      // Board space placement (greenery / tile placement)
      const sOff = aIdx - ACTION_OFFSET_SPACE;
      const space = player.game.board.spaces[sOff];
      const bonusScore = (space?.bonus.length ?? 0) * 4.0;
      score += 80.0 + bonusScore;
    } else if (
      (aIdx >= ACTION_OFFSET_BLUE_PROJECT && aIdx < ACTION_OFFSET_BLUE_PROJECT + NUM_PROJECT_CARDS) ||
      (aIdx >= ACTION_OFFSET_CORP_ACTION && aIdx < ACTION_OFFSET_CORP_ACTION + NUM_CORP_CARDS)
    ) {
      // Blue card actions & corp initial actions
      score += 75.0;
    } else if (aIdx >= ACTION_OFFSET_CARD && aIdx < ACTION_OFFSET_CARD + NUM_TOTAL_CARDS) {
      // Card play / card selection
      const isInitialOrBuy =
        decoded.promptTitle.includes('Initial') ||
        decoded.promptTitle.toLowerCase().includes('buy') ||
        decoded.mask[ACTION_CONFIRM_SELECTION];
      if (isInitialOrBuy) {
        // During card buying, buy 2-4 good cards rather than all 10
        const currentHand = player.cardsInHand.length;
        score += currentHand < 5 ? 60.0 : 15.0;
      } else {
        // Playing a project card or prelude from hand
        score += 70.0;
      }
    } else if (aIdx === ACTION_CONVERT_HEAT) {
      score += 65.0;
    } else if (aIdx >= ACTION_OFFSET_AWARD && aIdx < ACTION_OFFSET_AWARD + NUM_AWARDS) {
      if (player.game.generation >= 6 && player.megaCredits >= 20) {
        score += 55.0;
      } else {
        score += 5.0;
      }
    } else if (aIdx >= ACTION_OFFSET_STD_PROJECT && aIdx < ACTION_OFFSET_STD_PROJECT + NUM_STANDARD_PROJECTS) {
      const spOff = aIdx - ACTION_OFFSET_STD_PROJECT;
      // Avoid Sell Patents (offset 5) unless desperate
      if (spOff === 5) {
        score += -20.0;
      } else if (player.megaCredits >= 25) {
        score += 40.0;
      } else {
        score += 10.0;
      }
    } else if (aIdx === ACTION_CONFIRM_SELECTION) {
      score += 35.0;
    } else if (aIdx === ACTION_END_TURN) {
      score += 12.0;
    } else if (aIdx === ACTION_PASS) {
      score += 1.0;
    } else {
      score += 30.0;
    }

    results.push({actionIndex: aIdx, score});
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function selectHeuristicAction(player: IPlayer, decoded: DecodedActionSpace): number {
  const scored = scoreHeuristicActions(player, decoded);
  if (scored.length === 0) {
    return 0;
  }
  return scored[0].actionIndex;
}

export interface CardTerraformProfile {
  directTerraform: boolean;
  tr: boolean;
  heatOrPlant: boolean;
}

export function getCardTerraformProfile(cardName: CardName, cardObj?: ICard): CardTerraformProfile {
  const card = cardObj ?? CANONICAL_CARDS_BY_NAME.get(cardName);
  let directTerraform = false;
  let trBonus = false;
  let heatOrPlant = false;

  if (card) {
    const props = (card as any).properties ?? {};
    const b = props.behavior ?? (card as any).behavior;
    const a = props.action ?? (card as any).action;
    const tr = props.tr ?? (card as any).tr;
    const tags: ReadonlyArray<Tag> = card.tags ?? [];
    const tilesBuilt: ReadonlyArray<TileType> = props.tilesBuilt ?? (card as any).tilesBuilt ?? [];

    directTerraform = Boolean(
      b?.global?.temperature ||
      b?.global?.oxygen ||
      b?.ocean ||
      b?.greenery ||
      a?.global?.temperature ||
      a?.global?.oxygen ||
      a?.ocean ||
      a?.greenery ||
      b?.tile?.type === TileType.GREENERY ||
      b?.tile?.type === TileType.OCEAN ||
      tilesBuilt.includes(TileType.GREENERY) ||
      tilesBuilt.includes(TileType.OCEAN),
    );

    trBonus = Boolean(
      tr !== undefined ||
      b?.tr !== undefined ||
      a?.tr !== undefined,
    );

    heatOrPlant = Boolean(
      b?.production?.heat ||
      b?.production?.plants ||
      b?.stock?.heat ||
      b?.stock?.plants ||
      a?.production?.heat ||
      a?.production?.plants ||
      a?.stock?.heat ||
      a?.stock?.plants ||
      tags.includes(Tag.PLANT) ||
      tags.includes(Tag.POWER),
    );
  }

  const nameLower = cardName.toLowerCase();
  if (
    nameLower.includes('asteroid') ||
    nameLower.includes('comet') ||
    nameLower.includes('aquifer') ||
    nameLower.includes('melt') ||
    nameLower.includes('moss') ||
    nameLower.includes('trees') ||
    nameLower.includes('grass') ||
    nameLower.includes('forest')
  ) {
    directTerraform = true;
  }
  if (
    nameLower.includes('mohole') ||
    nameLower.includes('geothermal') ||
    nameLower.includes('generator') ||
    nameLower.includes('greenhouse')
  ) {
    heatOrPlant = true;
  }

  return {directTerraform, tr: trBonus, heatOrPlant};
}

/**
 * Rusher Policy Heuristic:
 * Aggressively prioritizes increasing Terraform Rating (TR) and ending the game quickly:
 * 1. Convert Plants into Greenery (+1 Oxygen -> +1 TR, tile VP, advances end)
 * 2. Convert Heat into Temperature (+1 Temp -> +1 TR, advances end)
 * 3. Board space tile placement (greenery / ocean / etc.)
 * 4. Claim Milestones (Terraformer, Gardener)
 * 5. Standard Projects that raise global parameters (Asteroid, Aquifer, Greenery)
 * 6. Blue card actions and cards that directly terraform or grant TR / heat / plants
 * 7. Fast passing / ending turns to advance generations rather than buying engine cards
 */
export function scoreRusherActions(
  player: IPlayer,
  decoded: DecodedActionSpace,
): Array<{actionIndex: number; score: number}> {
  const legal: Array<number> = [];
  for (let i = 0; i < decoded.mask.length; i++) {
    if (decoded.mask[i]) {
      legal.push(i);
    }
  }
  if (legal.length === 0) {
    return [];
  }

  const oxy = player.game.getOxygenLevel();
  const temp = player.game.getTemperature();
  const oceans = player.game.board.getOceanSpaces().length;
  const maxOxy = player.game.max.oxygen;
  const maxTemp = player.game.max.temperature;
  const maxOceans = player.game.max.oceans;

  const oxyOpen = oxy < maxOxy;
  const tempOpen = temp < maxTemp;
  const oceanOpen = oceans < maxOceans;
  const totalRemSteps = Math.max(0, (maxOxy - oxy) + Math.ceil((maxTemp - temp) / 2) + (maxOceans - oceans));

  const results: Array<{actionIndex: number; score: number}> = [];
  for (const aIdx of legal) {
    let score = Math.random() * 0.25;

    // 1. Plant conversion (8 plants -> Greenery)
    if (aIdx === ACTION_CONVERT_PLANTS) {
      score += oxyOpen ? 165.0 : 80.0;
    }
    // 2. Heat conversion (8 heat -> Temp)
    else if (aIdx === ACTION_CONVERT_HEAT) {
      score += tempOpen ? 165.0 : 20.0;
    }
    // 3. Tile placement on board space
    else if (aIdx >= ACTION_OFFSET_SPACE && aIdx < ACTION_OFFSET_SPACE + NUM_BOARD_SPACES) {
      const sOff = aIdx - ACTION_OFFSET_SPACE;
      const space = player.game.board.spaces[sOff];
      const bonusScore = (space?.bonus.length ?? 0) * 3.0;
      let placementScore = 155.0 + bonusScore;
      if (space?.bonus.some((b) => b === SpaceBonus.PLANT || b === SpaceBonus.HEAT || b === SpaceBonus.OCEAN)) {
        placementScore += 6.0;
      }
      score += placementScore;
    }
    // 4. Claim Milestone (e.g. Terraformer, Gardener)
    else if (aIdx >= ACTION_OFFSET_MILESTONE && aIdx < ACTION_OFFSET_MILESTONE + NUM_MILESTONES) {
      score += 135.0;
    }
    // 5. Standard Projects
    else if (aIdx >= ACTION_OFFSET_STD_PROJECT && aIdx < ACTION_OFFSET_STD_PROJECT + NUM_STANDARD_PROJECTS) {
      const spOff = aIdx - ACTION_OFFSET_STD_PROJECT;
      // SP 4: Asteroid (14 MC, +1 Temp, +1 TR)
      if (spOff === 4) {
        score += tempOpen ? 130.0 : 0.0;
      }
      // SP 0: Aquifer (18 MC, +1 Ocean, +1 TR)
      else if (spOff === 0) {
        score += oceanOpen ? 125.0 : 0.0;
      }
      // SP 3: Greenery (23 MC, +1 Greenery, +1 Oxygen, +1 TR)
      else if (spOff === 3) {
        score += oxyOpen ? 115.0 : 35.0;
      }
      // SP 2: Power Plant (11 MC, +1 energy prod)
      else if (spOff === 2) {
        score += (tempOpen && totalRemSteps > 3) ? 45.0 : 20.0;
      }
      // SP 1: City (25 MC, 0 TR, no terraforming)
      else if (spOff === 1) {
        score += 10.0;
      }
      // SP 5: Sell Patents
      else if (spOff === 5) {
        score += -15.0;
      } else {
        score += 20.0;
      }
    }
    // 6. Blue card actions & corp actions
    else if (
      (aIdx >= ACTION_OFFSET_BLUE_PROJECT && aIdx < ACTION_OFFSET_BLUE_PROJECT + NUM_PROJECT_CARDS) ||
      (aIdx >= ACTION_OFFSET_CORP_ACTION && aIdx < ACTION_OFFSET_CORP_ACTION + NUM_CORP_CARDS)
    ) {
      let cardName: CardName | undefined;
      if (aIdx >= ACTION_OFFSET_BLUE_PROJECT && aIdx < ACTION_OFFSET_BLUE_PROJECT + NUM_PROJECT_CARDS) {
        cardName = CANONICAL_PROJECT_CARDS[aIdx - ACTION_OFFSET_BLUE_PROJECT];
      } else {
        cardName = CANONICAL_CORP_CARDS[aIdx - ACTION_OFFSET_CORP_ACTION];
      }
      const profile = cardName ? getCardTerraformProfile(cardName) : undefined;
      if (profile?.directTerraform || profile?.tr || profile?.heatOrPlant) {
        score += 120.0;
      } else {
        score += 60.0;
      }
    }
    // 7. Cards (Play or Buy)
    else if (aIdx >= ACTION_OFFSET_CARD && aIdx < ACTION_OFFSET_CARD + NUM_TOTAL_CARDS) {
      const cIdx = aIdx - ACTION_OFFSET_CARD;
      const cardName = ALL_CANONICAL_CARDS[cIdx];
      const profile = getCardTerraformProfile(cardName);
      const isInitialOrBuy =
        decoded.promptTitle.includes('Initial') ||
        decoded.promptTitle.toLowerCase().includes('buy') ||
        decoded.mask[ACTION_CONFIRM_SELECTION];

      if (isInitialOrBuy) {
        if (cIdx < NUM_CORP_CARDS) {
          // Corp selection: prefer Ecoline (greenery for 7 plants), Helion (heat as MC), etc.
          if (cardName === CardName.ECOLINE || cardName === CardName.HELION) {
            score += 150.0;
          } else if (profile.directTerraform || profile.heatOrPlant || profile.tr) {
            score += 120.0;
          } else {
            score += 80.0;
          }
        } else if (cIdx < NUM_CORP_CARDS + NUM_PRELUDE_CARDS) {
          // Prelude selection: prefer terraforming / heat / plant preludes
          if (profile.directTerraform || profile.tr) {
            score += 145.0;
          } else if (profile.heatOrPlant) {
            score += 130.0;
          } else {
            score += 85.0;
          }
        } else {
          // Research phase buying project cards: buy lean!
          const currentHand = player.cardsInHand.length;
          if (profile.directTerraform || profile.tr) {
            score += currentHand < 4 ? 75.0 : 30.0;
          } else if (profile.heatOrPlant) {
            score += currentHand < 3 ? 55.0 : 20.0;
          } else {
            score += 5.0; // Avoid buying engine cards
          }
        }
      } else {
        // Playing a card from hand
        if (profile.directTerraform || profile.tr) {
          score += 135.0;
        } else if (profile.heatOrPlant) {
          score += 100.0;
        } else {
          score += 40.0;
        }
      }
    }
    // 8. Awards
    else if (aIdx >= ACTION_OFFSET_AWARD && aIdx < ACTION_OFFSET_AWARD + NUM_AWARDS) {
      if (totalRemSteps <= 4 && player.megaCredits >= 25) {
        score += 50.0;
      } else {
        score += 2.0;
      }
    }
    // 9. Confirm Selection
    else if (aIdx === ACTION_CONFIRM_SELECTION) {
      score += 45.0;
    }
    // 10. Resource Selection (favor heat / plants)
    else if (aIdx >= ACTION_OFFSET_RESOURCE && aIdx < ACTION_OFFSET_RESOURCE + 6) {
      const rOff = aIdx - ACTION_OFFSET_RESOURCE;
      // 0: MC, 1: Steel, 2: Titanium, 3: Plants, 4: Energy, 5: Heat
      if (rOff === 3 || rOff === 5) {
        score += 75.0; // Plants or Heat
      } else if (rOff === 4) {
        score += 60.0; // Energy
      } else if (rOff === 0) {
        score += 55.0; // MC
      } else {
        score += 45.0;
      }
    }
    // 11. End turn / Pass
    else if (aIdx === ACTION_END_TURN) {
      score += 28.0;
    } else if (aIdx === ACTION_PASS) {
      score += 8.0;
    } else {
      score += 30.0;
    }

    results.push({actionIndex: aIdx, score});
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function selectRusherAction(player: IPlayer, decoded: DecodedActionSpace): number {
  const scored = scoreRusherActions(player, decoded);
  if (scored.length === 0) {
    return 0;
  }
  return scored[0].actionIndex;
}
