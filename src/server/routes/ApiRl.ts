import * as responses from '../server/responses';
import {Handler} from './Handler';
import {Context} from './IHandler';
import {Request} from '../Request';
import {Response} from '../Response';
import {readBody} from './readBody';
import {AgentManager, AgentPolicyType} from '../rl/AgentManager';
import {
  ACTION_SPACE_SIZE,
  RL_TRAINING_GAME_OPTIONS,
  STATE_DIM,
} from '../rl/CardIndex';
import {decodeActionSpace} from '../rl/ActionCodec';
import {selectHeuristicAction} from '../rl/RlEnvironment';
import {Game} from '../Game';
import {IGame} from '../IGame';
import {Player} from '../Player';
import {generateRandomId} from '../utils/server-ids';
import {
  isGameId,
  isPlayerId,
  isSpectatorId,
  safeCast,
  GameId,
} from '../../common/Types';
import {Server} from '../models/ServerModel';

function buildAiStateForGame(game: IGame, manager: AgentManager) {
  const cfg = manager.managedGames.get(game.id);
  const isTrainingGame = Array.from(manager.trainingEnvs.values()).some(
    (env) => env.game?.id === game.id,
  );
  const summary = manager.buildGameSummary(game, cfg);
  const aiPlayersMap: Record<string, string> = {};
  if (cfg) {
    for (const [pid, pol] of cfg.aiPlayers.entries()) {
      aiPlayersMap[pid] = pol;
    }
  } else if (isTrainingGame) {
    for (const p of game.playersInGenerationOrder) {
      aiPlayersMap[p.id] = 'rl';
    }
  }

  const playerHands: Record<string, {cardsInHand: Array<string>; preludeCardsInHand: Array<string>}> = {};
  for (const p of game.playersInGenerationOrder) {
    playerHands[p.id] = {
      cardsInHand: p.cardsInHand.map((c) => c.name),
      preludeCardsInHand: p.preludeCardsInHand.map((c) => c.name),
    };
  }

  return {
    gameId: game.id,
    spectatorId: game.spectatorId,
    hasAi: cfg !== undefined || isTrainingGame,
    isTrainingGame,
    paused: cfg?.paused ?? false,
    delayMs: cfg?.delayMs ?? 300,
    aiPlayers: aiPlayersMap,
    lastDecision: cfg?.lastDecision ? {
      timestamp: cfg.lastDecision.timestamp,
      playerId: '',
      playerName: cfg.lastDecision.playerName,
      playerColor: cfg.lastDecision.playerColor,
      agentType: cfg.lastDecision.policyType,
      chosenAction: -1,
      chosenLabel: cfg.lastDecision.chosenLabel,
      valueEstimate: cfg.lastDecision.valueEstimate,
      winProbability: cfg.lastDecision.winProbability,
      topCandidates: cfg.lastDecision.topCandidates.map((tc, idx) => ({
        actionIndex: idx,
        label: tc.label,
        probability: tc.probability,
      })),
    } : null,
    playerHands,
    players: summary.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isAi: p.isAi || isTrainingGame,
      agentType: p.policyType ?? (isTrainingGame ? 'rl' : null),
      terraformRating: p.tr,
      vp: p.vp,
      mc: p.mc,
      valueEstimate: p.valueEstimate,
      winProbability: p.winProbability,
    })),
  };
}

export class ApiRl extends Handler {
  public static readonly INSTANCE = new ApiRl();

  private constructor() {
    super();
  }

  public override async get(_req: Request, res: Response, ctx: Context): Promise<void> {
    const manager = AgentManager.getInstance();
    const gameIdParam = ctx.url.searchParams.get('gameId');
    const participantIdParam = ctx.url.searchParams.get('participantId');

    if (gameIdParam || participantIdParam) {
      let game = undefined;
      if (gameIdParam && isGameId(gameIdParam)) {
        game = await ctx.gameLoader.getGame(gameIdParam);
      } else if (participantIdParam && (isPlayerId(participantIdParam) || isSpectatorId(participantIdParam))) {
        game = await ctx.gameLoader.getGame(participantIdParam);
      }
      if (!game) {
        responses.writeJson(res, ctx, {found: false});
        return;
      }
      const cfg = manager.managedGames.get(game.id);
      const isTrainingEnv = Array.from(manager.trainingEnvs.values()).some(
        (env) => env.game?.id === game.id,
      );
      const aiState = buildAiStateForGame(game, manager);
      const meta = manager.policyNet.metadata;
      responses.writeJson(res, ctx, {
        found: true,
        isAiGame: cfg !== undefined || isTrainingEnv,
        summary: manager.buildGameSummary(game, cfg),
        modelMetadata: meta,
        aiState,
        status: {
          stateDim: STATE_DIM,
          actionSpaceSize: ACTION_SPACE_SIZE,
          policy: {
            hasTrainedWeights: meta.loadedFrom !== 'initialized',
            loadedFrom: meta.loadedFrom,
            updatedAt: meta.updatedAt,
            totalSteps: meta.step,
            episodes: meta.episodes,
            bestEvalWinRate: meta.winRate,
          },
        },
      });
      return;
    }

    const activeGames = await manager.getActiveGamesSummary();
    const trainingStatus = manager.getTrainingStatus();
    const meta = manager.policyNet.metadata;

    const gamesForUi = activeGames.map((g) => ({
      ...g,
      isTrainingGame: g.mode === 'training',
      oxygenLevel: g.oxygen,
      players: g.players.map((p) => ({
        ...p,
        agentType: p.policyType ?? null,
        terraformRating: p.tr,
      })),
    }));

    const status = {
      stateDim: STATE_DIM,
      actionSpaceSize: ACTION_SPACE_SIZE,
      policy: {
        hasTrainedWeights: meta.loadedFrom !== 'initialized',
        loadedFrom: meta.loadedFrom,
        updatedAt: meta.updatedAt,
        totalSteps: meta.step,
        episodes: meta.episodes,
        bestEvalWinRate: meta.winRate,
      },
      training: {
        running: Boolean(trainingStatus.isTraining),
        pid: trainingStatus.pid,
        numWorkers: trainingStatus.numWorkers,
        envsPerWorker: trainingStatus.envsPerWorker,
        parallelEnvs: trainingStatus.parallelEnvs,
        metrics: trainingStatus.metrics,
        recentLogs: trainingStatus.recentLogs,
      },
      games: gamesForUi,
    };

    responses.writeJson(res, ctx, {
      envSpec: {
        map: 'tharsis',
        players: 2,
        expansions: ['base', 'corpera', 'prelude'],
        stateDim: STATE_DIM,
        actionDim: ACTION_SPACE_SIZE,
      },
      training: trainingStatus,
      activeGames,
      status,
    });
  }

  public override async post(req: Request, res: Response, ctx: Context): Promise<void> {
    const manager = AgentManager.getInstance();
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const action = body.action;

    if (action === 'start_game' || action === 'start_match') {
      const mode: 'human_vs_ai' | 'ai_vs_ai' =
        body.mode === 'human_vs_ai' ? 'human_vs_ai' : 'ai_vs_ai';
      const humanName = String(body.humanName || 'Human Player');
      const humanFirst: 'first' | 'second' | 'random' = body.humanOrder || 'random';
      const ai1Policy: AgentPolicyType = body.ai1Policy || body.ai1Type || 'rl';
      const ai2Policy: AgentPolicyType = body.ai2Policy || body.ai2Type || 'rl';
      const delayMs = Number(body.delayMs ?? (mode === 'human_vs_ai' ? 250 : 500));

      const gameId = safeCast(generateRandomId('g'), isGameId);
      const spectatorId = safeCast(generateRandomId('s'), isSpectatorId);
      const p1Id = safeCast(generateRandomId('p'), isPlayerId);
      const p2Id = safeCast(generateRandomId('p'), isPlayerId);

      let p1: Player;
      let p2: Player;
      const aiConfigs: Array<{playerId: typeof p1Id; policyType: AgentPolicyType}> = [];

      if (mode === 'human_vs_ai') {
        const aiLabel =
          ai1Policy === 'rl' ?
            'RL-Agent (PPO)' :
            ai1Policy === 'heuristic' ?
              'Heuristic-AI' :
              'Random-AI';
        p1 = new Player(humanName, 'red', false, 0, p1Id);
        p2 = new Player(aiLabel, 'blue', false, 0, p2Id);
        aiConfigs.push({playerId: p2Id, policyType: ai1Policy});
      } else {
        const label1 =
          ai1Policy === 'rl' ?
            'RL-Agent-Alpha' :
            ai1Policy === 'heuristic' ?
              'Heuristic-Alpha' :
              'Random-Alpha';
        const label2 =
          ai2Policy === 'rl' ?
            'RL-Agent-Beta' :
            ai2Policy === 'heuristic' ?
              'Heuristic-Beta' :
              'Random-Beta';
        p1 = new Player(label1, 'red', false, 0, p1Id);
        p2 = new Player(label2, 'blue', false, 0, p2Id);
        aiConfigs.push({playerId: p1Id, policyType: ai1Policy});
        aiConfigs.push({playerId: p2Id, policyType: ai2Policy});
      }

      let firstPlayer = p1;
      if (humanFirst === 'second') {
        firstPlayer = p2;
      } else if (humanFirst === 'random') {
        firstPlayer = Math.random() < 0.5 ? p1 : p2;
      }

      const game = Game.newInstance(
        gameId,
        [p1, p2],
        firstPlayer,
        spectatorId,
        {...RL_TRAINING_GAME_OPTIONS},
        Math.random(),
      );

      await ctx.gameLoader.add(game);
      manager.registerGame(game, aiConfigs, {mode, delayMs, paused: false});

      responses.writeJson(res, ctx, {
        ok: true,
        mode,
        gameId: game.id,
        spectatorId: game.spectatorId,
        humanPlayerId: mode === 'human_vs_ai' ? p1.id : undefined,
        players: game.playersInGenerationOrder.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
        })),
        simpleGameModel: Server.getSimpleGameModel(game),
      });
      return;
    }

    if (action === 'control_game') {
      let gameId = body.gameId as GameId | undefined;
      let game: IGame | undefined = undefined;
      if (gameId && isGameId(gameId)) {
        game = await ctx.gameLoader.getGame(gameId);
      } else if (body.participantId && (isPlayerId(body.participantId) || isSpectatorId(body.participantId))) {
        game = await ctx.gameLoader.getGame(body.participantId);
        if (game) {
          gameId = game.id;
        }
      }
      if (!gameId) {
        responses.writeJson(res, ctx, {ok: false});
        return;
      }
      const updated = manager.setGameControl(gameId, {
        paused: body.paused,
        delayMs: body.delayMs,
        stepOnce: body.stepOnce,
      });
      responses.writeJson(res, ctx, {
        ok: updated !== undefined,
        paused: updated?.paused,
        delayMs: updated?.delayMs,
        lastDecision: updated?.lastDecision,
        aiState: game ? buildAiStateForGame(game, manager) : undefined,
      });
      return;
    }

    if (action === 'start_training') {
      const resStatus = manager.startTrainingProcess({
        episodes: body.episodes,
        lr: body.lr,
        opponent: body.opponent || body.opponentType,
        warmstartSteps: body.warmstartSteps,
        numWorkers: body.numWorkers,
        envsPerWorker: body.envsPerWorker,
        device: typeof body.device === 'string' ? body.device : undefined,
        restart: Boolean(body.restart),
      });
      responses.writeJson(res, ctx, resStatus);
      return;
    }

    if (action === 'stop_training') {
      const resStatus = manager.stopTrainingProcess();
      responses.writeJson(res, ctx, resStatus);
      return;
    }

    if (action === 'reload_weights') {
      manager.reloadWeightsIfAvailable();
      responses.writeJson(res, ctx, {
        ok: true,
        modelMetadata: manager.policyNet.metadata,
      });
      return;
    }

    // Bridge endpoints for Python RL trainer running over HTTP
    if (action === 'env_reset') {
      const envId = String(body.envId ?? 'env_0');
      const obs = manager.resetTrainingEnv(envId, body.seed, body.playerNames);
      responses.writeJson(res, ctx, {ok: true, obs});
      return;
    }

    if (action === 'env_step') {
      const envId = String(body.envId ?? 'env_0');
      const actIdx = Number(body.actionIndex ?? 0);
      const obs = manager.stepTrainingEnv(envId, actIdx);
      responses.writeJson(res, ctx, {ok: true, obs});
      return;
    }

    if (action === 'env_heuristic') {
      const envId = String(body.envId ?? 'env_0');
      const env = manager.getOrCreateTrainingEnv(envId);
      const pIdx = env.getActivePlayerIndex();
      const player = env.players[pIdx];
      const staging = env.stagings[pIdx];
      const decoded = decodeActionSpace(player, staging);
      const actIdx = selectHeuristicAction(player, decoded);
      responses.writeJson(res, ctx, {ok: true, action: actIdx});
      return;
    }

    if (action === 'env_batch_step') {
      const items: Array<{
        envId: string;
        action: number;
        autoOpponent?: 'heuristic' | 'random';
      }> = body.items ?? [];
      const results = items.map((item) => {
        const env = manager.getOrCreateTrainingEnv(item.envId);
        let obs = env.step(item.action);
        while (!obs.done && item.autoOpponent && obs.activePlayerIndex === 1) {
          const p1 = env.players[1];
          const st1 = env.stagings[1];
          const dec1 = decodeActionSpace(p1, st1);
          const oppAction =
            item.autoOpponent === 'heuristic' ?
              selectHeuristicAction(p1, dec1) :
              obs.legalActionIndices[Math.floor(Math.random() * obs.legalActionIndices.length)];
          obs = env.step(oppAction);
        }
        if (obs.done && body.autoReset) {
          const terminalObs = obs;
          const resetObs = env.reset();
          return {terminalObs, obs: resetObs};
        }
        return {obs};
      });
      responses.writeJson(res, ctx, {ok: true, results});
      return;
    }

    responses.badRequest(req, res, `Unknown RL API action: ${String(action)}`);
  }
}
