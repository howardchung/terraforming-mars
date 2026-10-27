import fs from 'fs';
import path from 'path';
import {ChildProcess, spawn} from 'child_process';
import {Phase} from '../../common/Phase';
import {GameId, PlayerId, SpectatorId} from '../../common/Types';
import {GameLoader} from '../database/GameLoader';
import {IGame} from '../IGame';
import {IPlayer} from '../IPlayer';
import {
  buildDefaultInputResponse,
  createEmptyStagingState,
  decodeActionSpace,
  PlayerStagingState,
} from './ActionCodec';
import {PolicyNetwork, SerializedModelWeights} from './PolicyNetwork';
import {RlGameEnvironment, selectHeuristicAction, StepObservation} from './RlEnvironment';
import {encodeGameState} from './StateEncoder';

export type AgentPolicyType = 'rl' | 'heuristic' | 'random';

export interface ManagedGameAiConfig {
  game: IGame;
  gameId: GameId;
  spectatorId: SpectatorId;
  mode: 'human_vs_ai' | 'ai_vs_ai' | 'training';
  aiPlayers: Map<PlayerId, AgentPolicyType>;
  stagings: Map<PlayerId, PlayerStagingState>;
  paused: boolean;
  delayMs: number;
  createdAt: number;
  lastStepAt: number;
  lastDecision?: {
    playerName: string;
    playerColor: string;
    policyType: AgentPolicyType;
    promptTitle: string;
    chosenLabel: string;
    probability: number;
    valueEstimate: number;
    winProbability: number;
    topCandidates: Array<{label: string; probability: number}>;
    generation: number;
    timestamp: number;
  };
}

export interface GameSummaryForUi {
  gameId: GameId;
  spectatorId: SpectatorId;
  name: string;
  mode: 'human_vs_ai' | 'ai_vs_ai' | 'training' | 'standard';
  generation: number;
  phase: string;
  temperature: number;
  oxygen: number;
  oceans: number;
  paused: boolean;
  delayMs: number;
  players: Array<{
    id: PlayerId;
    name: string;
    color: string;
    isAi: boolean;
    policyType?: AgentPolicyType;
    tr: number;
    vp: number;
    mc: number;
    valueEstimate?: number;
    winProbability?: number;
  }>;
  lastDecision?: ManagedGameAiConfig['lastDecision'];
}

export class AgentManager {
  private static instance: AgentManager;

  public readonly policyNet: PolicyNetwork;
  public readonly managedGames = new Map<GameId, ManagedGameAiConfig>();
  public readonly trainingEnvs = new Map<string, RlGameEnvironment>();
  private loopTimer: NodeJS.Timeout | undefined;
  private trainingProcess: ChildProcess | null = null;
  private trainingLogs: Array<string> = [];
  private trainingConfig: {
    numWorkers: number;
    envsPerWorker: number;
    parallelEnvs: number;
    episodes: number;
    opponent: string;
  } = {
      numWorkers: 2,
      envsPerWorker: 4,
      parallelEnvs: 8,
      episodes: 200,
      opponent: 'mixed',
    };

  private constructor() {
    this.policyNet = new PolicyNetwork();
    this.reloadWeightsIfAvailable();
    this.startLoop();
  }

  public static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  public getCheckpointsDir(): string {
    return path.resolve(process.cwd(), 'rl', 'checkpoints');
  }

  public reloadWeightsIfAvailable(): boolean {
    const dir = this.getCheckpointsDir();
    const bestPath = path.join(dir, 'best_weights.json');
    const latestPath = path.join(dir, 'latest_weights.json');
    if (fs.existsSync(bestPath)) {
      return this.policyNet.maybeReloadFromDisk(bestPath);
    }
    if (fs.existsSync(latestPath)) {
      return this.policyNet.maybeReloadFromDisk(latestPath);
    }
    return false;
  }

  public updateWeightsInMemory(weights: SerializedModelWeights, source = 'trainer-push'): boolean {
    return this.policyNet.loadFromSerialized(weights, source);
  }

  public registerGame(
    game: IGame,
    aiPlayerConfigs: Array<{playerId: PlayerId; policyType: AgentPolicyType}>,
    options?: {mode?: 'human_vs_ai' | 'ai_vs_ai' | 'training'; delayMs?: number; paused?: boolean},
  ): ManagedGameAiConfig {
    const aiMap = new Map<PlayerId, AgentPolicyType>();
    const stagings = new Map<PlayerId, PlayerStagingState>();
    for (const cfg of aiPlayerConfigs) {
      aiMap.set(cfg.playerId, cfg.policyType);
      stagings.set(cfg.playerId, createEmptyStagingState());
    }
    const isAllAi = aiMap.size === game.players.length;
    const mode = options?.mode ?? (isAllAi ? 'ai_vs_ai' : 'human_vs_ai');
    const defaultDelay = mode === 'human_vs_ai' ? 250 : mode === 'ai_vs_ai' ? 500 : 50;

    // Speed up game saves on AI games if needed, while keeping game in GameLoader
    const config: ManagedGameAiConfig = {
      game,
      gameId: game.id,
      spectatorId: game.spectatorId,
      mode,
      aiPlayers: aiMap,
      stagings,
      paused: options?.paused ?? false,
      delayMs: options?.delayMs ?? defaultDelay,
      createdAt: Date.now(),
      lastStepAt: 0,
    };
    this.managedGames.set(game.id, config);
    return config;
  }

  public static inferPolicyFromPlayerName(name: string): AgentPolicyType | undefined {
    const lower = name.trim().toLowerCase();
    if (
      lower.startsWith('[ai]') ||
      lower.startsWith('[rl]') ||
      lower.startsWith('rl-agent') ||
      lower.startsWith('ai-agent') ||
      lower === 'rl agent' ||
      lower === 'ai agent' ||
      lower === 'bot'
    ) {
      return 'rl';
    }
    if (lower.startsWith('[heuristic]') || lower.startsWith('heuristic-ai')) {
      return 'heuristic';
    }
    if (lower.startsWith('[random]') || lower.startsWith('random-ai')) {
      return 'random';
    }
    return undefined;
  }

  private startLoop(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
    }
    this.loopTimer = setInterval(() => {
      void this.tickManagedGames();
    }, 80);
    if (this.loopTimer.unref) {
      this.loopTimer.unref();
    }
  }

  private async tickManagedGames(): Promise<void> {
    this.reloadWeightsIfAvailable();
    const now = Date.now();
    for (const [gameId, cfg] of this.managedGames.entries()) {
      if (cfg.paused || cfg.mode === 'training') {
        continue;
      }
      if (now - cfg.lastStepAt < cfg.delayMs) {
        continue;
      }
      const game = cfg.game ?? (await GameLoader.getInstance().getGame(gameId));
      if (!game || game.phase === Phase.END) {
        continue;
      }
      this.stepOneAiTurnInGame(game, cfg);
    }
  }

  public stepOneAiTurnInGame(game: IGame, cfg: ManagedGameAiConfig): boolean {
    if (game.phase === Phase.END) {
      return false;
    }

    // Find an AI player in this game that currently has a waitingFor input
    let targetPlayer: IPlayer | undefined;
    let policyType: AgentPolicyType = 'rl';

    // Prefer game.activePlayer if it is an AI player and waiting
    if (
      cfg.aiPlayers.has(game.activePlayer.id) &&
      game.activePlayer.getWaitingFor() !== undefined
    ) {
      targetPlayer = game.activePlayer;
      policyType = cfg.aiPlayers.get(game.activePlayer.id)!;
    } else {
      for (const p of game.playersInGenerationOrder) {
        if (cfg.aiPlayers.has(p.id) && p.getWaitingFor() !== undefined) {
          targetPlayer = p;
          policyType = cfg.aiPlayers.get(p.id)!;
          break;
        }
      }
    }

    if (!targetPlayer) {
      return false;
    }

    let staging = cfg.stagings.get(targetPlayer.id);
    if (!staging) {
      staging = createEmptyStagingState();
      cfg.stagings.set(targetPlayer.id, staging);
    }

    // Execute sub-steps until an actual InputResponse is submitted to the game engine
    let subSteps = 0;
    while (subSteps < 16 && targetPlayer.getWaitingFor() !== undefined) {
      subSteps++;
      const stateVec = encodeGameState(targetPlayer, staging);
      const decoded = decodeActionSpace(targetPlayer, staging);
      const legalIndices: Array<number> = [];
      for (let i = 0; i < decoded.mask.length; i++) {
        if (decoded.mask[i]) {
          legalIndices.push(i);
        }
      }
      if (legalIndices.length === 0) {
        break;
      }

      let chosenActionIdx = legalIndices[0];
      let probability = 1.0;
      let valueEstimate = 0.0;
      let topCandidates: Array<{label: string; probability: number}> = [];

      if (policyType === 'rl') {
        const evalRes = this.policyNet.evaluate(stateVec, decoded.mask, 'sample', 0.65);
        chosenActionIdx = evalRes.actionIndex;
        probability = evalRes.probability;
        valueEstimate = evalRes.valueEstimate;
        topCandidates = evalRes.topActions.map((ta) => ({
          label: decoded.bindings.get(ta.actionIndex)?.label ?? `Action #${ta.actionIndex}`,
          probability: Number(ta.probability.toFixed(3)),
        }));
      } else if (policyType === 'heuristic') {
        chosenActionIdx = selectHeuristicAction(targetPlayer, decoded);
        valueEstimate = this.policyNet.forwardValue(stateVec);
        topCandidates = [{label: decoded.bindings.get(chosenActionIdx)?.label ?? 'Heuristic', probability: 1.0}];
      } else {
        chosenActionIdx = legalIndices[Math.floor(Math.random() * legalIndices.length)];
        valueEstimate = this.policyNet.forwardValue(stateVec);
        topCandidates = [{label: decoded.bindings.get(chosenActionIdx)?.label ?? 'Random', probability: Number((1 / legalIndices.length).toFixed(3))}];
      }

      const binding = decoded.bindings.get(chosenActionIdx) ?? Array.from(decoded.bindings.values())[0];
      if (!binding) {
        break;
      }

      const response = binding.execute();
      const winProbability = PolicyNetwork.valueToWinProbability(valueEstimate);
      cfg.lastDecision = {
        playerName: targetPlayer.name,
        playerColor: targetPlayer.color,
        policyType,
        promptTitle: decoded.promptTitle,
        chosenLabel: binding.label,
        probability: Number(probability.toFixed(3)),
        valueEstimate: Number(valueEstimate.toFixed(3)),
        winProbability: Number(winProbability.toFixed(3)),
        topCandidates,
        generation: game.generation,
        timestamp: Date.now(),
      };
      cfg.lastStepAt = Date.now();

      if (response !== undefined) {
        const prevGameAge = game.gameAge;
        try {
          targetPlayer.process(response);
        } catch (_err) {
          try {
            const wf = targetPlayer.getWaitingFor();
            if (wf !== undefined) {
              targetPlayer.process(buildDefaultInputResponse(targetPlayer, wf));
            }
          } catch (_err2) {
            // Ignore
          }
        }
        // Ensure gameAge increments even on silent state changes (e.g. initial card pick)
        // so SpectatorHome / WaitingFor polling immediately refreshes!
        if (game.gameAge === prevGameAge) {
          game.gameAge++;
        }
        return true;
      }
    }

    return false;
  }

  public setGameControl(
    gameId: GameId,
    updates: {paused?: boolean; delayMs?: number; stepOnce?: boolean},
  ): ManagedGameAiConfig | undefined {
    const cfg = this.managedGames.get(gameId);
    if (!cfg) {
      return undefined;
    }
    if (updates.paused !== undefined) {
      cfg.paused = Boolean(updates.paused);
    }
    if (updates.delayMs !== undefined && Number.isFinite(updates.delayMs)) {
      cfg.delayMs = Math.max(20, Math.min(5000, Number(updates.delayMs)));
    }
    if (updates.stepOnce) {
      if (cfg.game) {
        this.stepOneAiTurnInGame(cfg.game, cfg);
      } else {
        void GameLoader.getInstance().getGame(gameId).then((game) => {
          if (game) {
            this.stepOneAiTurnInGame(game, cfg);
          }
        });
      }
    }
    return cfg;
  }

  public async getActiveGamesSummary(): Promise<Array<GameSummaryForUi>> {
    const summaries: Array<GameSummaryForUi> = [];
    const seenIds = new Set<GameId>();

    // 1. Include managed games (Human vs AI, AI vs AI)
    for (const [gameId, cfg] of this.managedGames.entries()) {
      const game = cfg.game ?? (await GameLoader.getInstance().getGame(gameId));
      if (!game) {
        continue;
      }
      seenIds.add(gameId);
      summaries.push(this.buildGameSummary(game, cfg));
    }

    // 2. Include live RL training environment games
    for (const env of this.trainingEnvs.values()) {
      const game = env.game;
      if (!game || seenIds.has(game.id)) {
        continue;
      }
      seenIds.add(game.id);
      summaries.push({
        gameId: game.id,
        spectatorId: game.spectatorId,
        name: `${game.name} (${env.envId})`,
        mode: 'training',
        generation: game.generation,
        phase: game.phase,
        temperature: game.getTemperature(),
        oxygen: game.getOxygenLevel(),
        oceans: game.board.getOceanSpaces().length,
        paused: false,
        delayMs: 0,
        players: game.playersInGenerationOrder.map((p, idx) => {
          const est = this.evaluatePlayerWinEstimate(p, env.stagings?.[idx]);
          return {
            id: p.id,
            name: p.name,
            color: p.color,
            isAi: true,
            policyType: 'rl',
            tr: p.terraformRating,
            vp: p.getVictoryPoints().total,
            mc: p.megaCredits,
            valueEstimate: est.valueEstimate,
            winProbability: est.winProbability,
          };
        }),
      });
    }

    return summaries.sort((a, _b) => (a.mode === 'training' ? 1 : -1));
  }

  public evaluatePlayerWinEstimate(
    player: IPlayer,
    staging?: PlayerStagingState,
  ): {valueEstimate: number; winProbability: number} {
    const game = player.game;
    if (game.phase === Phase.END && game.players.length > 1) {
      const myVp = player.getVictoryPoints().total;
      let bestOtherVp = -Infinity;
      let bestOtherMc = -Infinity;
      for (const other of game.players) {
        if (other.id === player.id) continue;
        const ovp = other.getVictoryPoints().total;
        if (ovp > bestOtherVp || (ovp === bestOtherVp && other.megaCredits > bestOtherMc)) {
          bestOtherVp = ovp;
          bestOtherMc = other.megaCredits;
        }
      }
      if (myVp > bestOtherVp || (myVp === bestOtherVp && player.megaCredits > bestOtherMc)) {
        return {valueEstimate: 1.0, winProbability: 1.0};
      }
      if (myVp === bestOtherVp && player.megaCredits === bestOtherMc) {
        return {valueEstimate: 0.0, winProbability: 0.5};
      }
      return {valueEstimate: -1.0, winProbability: 0.0};
    }

    const st = staging ?? createEmptyStagingState();
    const stateVec = encodeGameState(player, st);
    const val = this.policyNet.forwardValue(stateVec);
    const winProb = PolicyNetwork.valueToWinProbability(val);
    return {
      valueEstimate: Number(val.toFixed(3)),
      winProbability: Number(winProb.toFixed(3)),
    };
  }

  public buildGameSummary(game: IGame, cfg?: ManagedGameAiConfig): GameSummaryForUi {
    return {
      gameId: game.id,
      spectatorId: game.spectatorId,
      name: game.name,
      mode: cfg?.mode ?? 'standard',
      generation: game.generation,
      phase: game.phase,
      temperature: game.getTemperature(),
      oxygen: game.getOxygenLevel(),
      oceans: game.board.getOceanSpaces().length,
      paused: cfg?.paused ?? false,
      delayMs: cfg?.delayMs ?? 500,
      players: game.playersInGenerationOrder.map((p) => {
        const est = this.evaluatePlayerWinEstimate(p, cfg?.stagings.get(p.id));
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          isAi: cfg?.aiPlayers.has(p.id) ?? false,
          policyType: cfg?.aiPlayers.get(p.id),
          tr: p.terraformRating,
          vp: p.getVictoryPoints().total,
          mc: p.megaCredits,
          valueEstimate: est.valueEstimate,
          winProbability: est.winProbability,
        };
      }),
      lastDecision: cfg?.lastDecision,
    };
  }

  // =========================================================================
  // Vectorized Training Environment Management (for Python RL Trainer)
  // =========================================================================

  public getOrCreateTrainingEnv(envId: string): RlGameEnvironment {
    let env = this.trainingEnvs.get(envId);
    if (!env) {
      env = new RlGameEnvironment(envId, true);
      this.trainingEnvs.set(envId, env);
    }
    return env;
  }

  public resetTrainingEnv(
    envId: string,
    seed?: number,
    playerNames?: [string, string],
  ): StepObservation {
    const env = this.getOrCreateTrainingEnv(envId);
    return env.reset(seed, playerNames);
  }

  public stepTrainingEnv(envId: string, actionIndex: number): StepObservation {
    const env = this.getOrCreateTrainingEnv(envId);
    return env.step(actionIndex);
  }

  // =========================================================================
  // Background Python RL Training Process Control (Start/Stop from UI)
  // =========================================================================

  public startTrainingProcess(options: {
    episodes?: number;
    lr?: number;
    opponent?: 'self' | 'heuristic' | 'mixed';
    warmstartSteps?: number;
    numWorkers?: number;
    envsPerWorker?: number;
    restart?: boolean;
  } = {}): {running: boolean; pid?: number; message: string; numWorkers: number; envsPerWorker: number; parallelEnvs: number} {
    if (this.trainingProcess && this.trainingProcess.exitCode === null) {
      if (options.restart) {
        this.trainingProcess.kill('SIGTERM');
        this.trainingProcess = null;
      } else {
        return {
          running: true,
          pid: this.trainingProcess.pid,
          message: 'Training process is already running.',
          numWorkers: this.trainingConfig.numWorkers,
          envsPerWorker: this.trainingConfig.envsPerWorker,
          parallelEnvs: this.trainingConfig.parallelEnvs,
        };
      }
    }

    const numWorkers = Math.max(1, Math.min(16, Number(options.numWorkers ?? 2)));
    const envsPerWorker = Math.max(1, Math.min(16, Number(options.envsPerWorker ?? 4)));
    const parallelEnvs = numWorkers * envsPerWorker;
    const episodes = Math.max(1, Number(options.episodes ?? 200));
    const opponent = String(options.opponent ?? 'mixed');

    const scriptPath = path.resolve(process.cwd(), 'rl', 'train.py');
    if (!fs.existsSync(scriptPath)) {
      return {
        running: false,
        message: `Training script not found at ${scriptPath}`,
        numWorkers,
        envsPerWorker,
        parallelEnvs,
      };
    }

    this.trainingConfig = {
      numWorkers,
      envsPerWorker,
      parallelEnvs,
      episodes,
      opponent,
    };

    const args = [
      scriptPath,
      '--episodes',
      String(episodes),
      '--lr',
      String(options.lr ?? 0.0003),
      '--opponent',
      opponent,
      '--warmstart-steps',
      String(options.warmstartSteps ?? 400),
      '--num-workers',
      String(numWorkers),
      '--envs-per-worker',
      String(envsPerWorker),
      '--bridge-mode',
      'stdio',
    ];

    this.trainingLogs = [`[${new Date().toISOString()}] Starting parallel training (${numWorkers} workers × ${envsPerWorker} envs = ${parallelEnvs} parallel games): python3 ${args.join(' ')}`];
    const child = spawn('python3', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.trainingProcess = child;

    const appendLog = (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        this.trainingLogs.push(line);
        if (this.trainingLogs.length > 100) {
          this.trainingLogs.shift();
        }
      }
    };

    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);
    child.on('exit', (code) => {
      this.trainingLogs.push(`[${new Date().toISOString()}] Training exited with code ${code}`);
      if (this.trainingProcess === child) {
        this.trainingProcess = null;
      }
      this.reloadWeightsIfAvailable();
    });

    return {
      running: true,
      pid: child.pid,
      message: `Started parallel RL training (${numWorkers} workers × ${envsPerWorker} envs = ${parallelEnvs} parallel games).`,
      numWorkers,
      envsPerWorker,
      parallelEnvs,
    };
  }

  public stopTrainingProcess(): {running: boolean; message: string} {
    if (this.trainingProcess && this.trainingProcess.exitCode === null) {
      this.trainingProcess.kill('SIGTERM');
      this.trainingProcess = null;
      return {running: false, message: 'Stopped RL training process.'};
    }
    return {running: false, message: 'No training process was running.'};
  }

  public getTrainingStatus(): Record<string, unknown> {
    this.reloadWeightsIfAvailable();
    const metricsFile = path.join(this.getCheckpointsDir(), 'training_metrics.json');
    let metricsHistory: Record<string, unknown> = {};
    if (fs.existsSync(metricsFile)) {
      try {
        metricsHistory = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
      } catch (_e) {
        // Ignore
      }
    }
    const isSubprocessRunning =
      this.trainingProcess !== null && this.trainingProcess.exitCode === null;
    // Also detect if an external CLI training process is actively updating metrics (< 15s old)
    const updatedAtMs = typeof metricsHistory.updatedAtMs === 'number' ? metricsHistory.updatedAtMs : 0;
    const isExternalRunning =
      metricsHistory.status === 'training' && Date.now() - updatedAtMs < 15000;

    const numWorkers =
      typeof metricsHistory.numWorkers === 'number' ?
        metricsHistory.numWorkers :
        this.trainingConfig.numWorkers;
    const envsPerWorker =
      typeof metricsHistory.envsPerWorker === 'number' ?
        metricsHistory.envsPerWorker :
        this.trainingConfig.envsPerWorker;
    const parallelEnvs =
      typeof metricsHistory.parallelEnvs === 'number' ?
        metricsHistory.parallelEnvs :
        numWorkers * envsPerWorker;

    return {
      isTraining: isSubprocessRunning || isExternalRunning,
      pid: this.trainingProcess?.pid,
      numWorkers,
      envsPerWorker,
      parallelEnvs,
      modelMetadata: this.policyNet.metadata,
      metrics: metricsHistory,
      recentLogs: this.trainingLogs.slice(-30),
    };
  }
}
