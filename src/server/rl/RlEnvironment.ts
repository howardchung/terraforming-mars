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
  ACTION_OFFSET_SPACE,
  ACTION_OFFSET_STD_PROJECT,
  ACTION_PASS,
  NUM_AWARDS,
  NUM_BOARD_SPACES,
  NUM_CORP_CARDS,
  NUM_MILESTONES,
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

    return this.getObservation();
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

    const pIdx = this.getActivePlayerIndex();
    const player = this.players[pIdx];
    const staging = this.stagings[pIdx];
    const decoded = this.lastDecoded ?? decodeActionSpace(player, staging);

    let binding = decoded.bindings.get(actionIndex);
    if (binding === undefined) {
      const firstLegal = Array.from(decoded.bindings.values())[0];
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
    this.updateDenseRewards();
    this.maybeAssignTerminalRewards();

    return this.getObservation();
  }

  public getObservation(): StepObservation {
    const done = this.isDone();
    const winner = done ? this.maybeAssignTerminalRewards() : null;
    const pIdx = this.getActivePlayerIndex();
    const player = this.players[pIdx];
    const staging = this.stagings[pIdx];

    const decoded = decodeActionSpace(player, staging);
    this.lastDecoded = decoded;
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
      state: Array.from(stateTyped),
      mask: decoded.mask,
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
export function selectHeuristicAction(player: IPlayer, decoded: DecodedActionSpace): number {
  const legal: Array<number> = [];
  for (let i = 0; i < decoded.mask.length; i++) {
    if (decoded.mask[i]) {
      legal.push(i);
    }
  }
  if (legal.length === 0) {
    return 0;
  }
  if (legal.length === 1) {
    return legal[0];
  }

  let bestIdx = legal[0];
  let bestScore = -1e9;

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

    if (score > bestScore) {
      bestScore = score;
      bestIdx = aIdx;
    }
  }

  return bestIdx;
}
