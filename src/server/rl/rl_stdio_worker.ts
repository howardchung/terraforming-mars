process.env.SQLITE_FILE_NAME = ':memory:';
try {
  require.resolve('pg');
} catch {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (req: string, ...rest: any[]) {
    if (req === 'pg') return {Pool: class {}, default: {Pool: class {}}};
    return origLoad.call(this, req, ...rest);
  };
}
import readline from 'readline';
import {Database} from '../database/Database';
import {IDatabase} from '../database/IDatabase';
import {SerializedGame} from '../SerializedGame';

const NOOP_DATABASE: IDatabase = {
  markFinished: () => Promise.resolve(),
  deleteGameNbrSaves: () => Promise.resolve(),
  getPlayerCount: () => Promise.resolve(0),
  getGame: () => Promise.resolve({} as SerializedGame),
  getGameId: () => Promise.resolve('g' as any),
  getGameVersion: () => Promise.resolve({} as SerializedGame),
  getGameIds: () => Promise.resolve([]),
  getSaveIds: () => Promise.resolve([]),
  initialize: () => Promise.resolve(),
  saveGameResults: () => {},
  saveGame: () => Promise.resolve(),
  purgeUnfinishedGames: () => Promise.resolve([]),
  compressCompletedGames: () => Promise.resolve(),
  stats: () => Promise.resolve({}),
  storeParticipants: () => Promise.resolve(),
  getParticipants: () => Promise.resolve([]),
  createSession: () => Promise.resolve(),
  deleteSession: () => Promise.resolve(),
  getSessions: () => Promise.resolve([]),
  deleteExpiredSessions: () => Promise.resolve(0),
};

Database.getInstance = () => NOOP_DATABASE;

import {globalInitialize} from '../globalInitialize';
import {CompactStepObservation, RlGameEnvironment, selectHeuristicAction, selectRusherAction, StepObservation} from './RlEnvironment';
import {ACTION_SPACE_SIZE, STATE_DIM} from './CardIndex';

globalInitialize();

const envs = new Map<string, RlGameEnvironment>();

function getEnv(envId: string): RlGameEnvironment {
  let env = envs.get(envId);
  if (!env) {
    env = new RlGameEnvironment(envId, false);
    envs.set(envId, env);
  }
  return env;
}

/**
 * Plays the auto-opponent's moves without building intermediate observations
 * (state encoding + VP scoring are only needed once control returns to the RL seat).
 */
function advanceAutoOpponent(
  env: RlGameEnvironment,
  autoOpponent?: 'heuristic' | 'random' | 'rusher',
  autoOpponentSeat: number = 1,
): void {
  if (!autoOpponent) {
    return;
  }
  while (!env.isDone() && env.getActivePlayerIndex() === autoOpponentSeat) {
    const oppPlayer = env.players[autoOpponentSeat];
    const dec = env.getDecoded();
    let oppAction: number;
    if (autoOpponent === 'rusher') {
      oppAction = selectRusherAction(oppPlayer, dec);
    } else if (autoOpponent === 'heuristic') {
      oppAction = selectHeuristicAction(oppPlayer, dec);
    } else {
      const legal: Array<number> = [];
      for (let i = 0; i < dec.mask.length; i++) {
        if (dec.mask[i]) legal.push(i);
      }
      oppAction = legal.length > 0 ? legal[Math.floor(Math.random() * legal.length)] : 0;
    }
    env.applyAction(oppAction);
  }
}

function observe(env: RlGameEnvironment, compact: boolean): StepObservation | CompactStepObservation {
  return compact ? env.getCompactObservation() : env.getObservation();
}

function doReset(
  env: RlGameEnvironment,
  item: {seed?: number; playerNames?: [string, string]; autoOpponent?: 'heuristic' | 'random' | 'rusher'; autoOpponentSeat?: number},
  compact: boolean,
) {
  env.resetGame(item.seed, item.playerNames);
  advanceAutoOpponent(env, item.autoOpponent, Number(item.autoOpponentSeat ?? 1));
  env.syncRewards();
  return observe(env, compact);
}

function doStep(
  env: RlGameEnvironment,
  action: number,
  autoOpponent: 'heuristic' | 'random' | 'rusher' | undefined,
  autoOpponentSeat: number,
  compact: boolean,
) {
  if (!env.isDone()) {
    env.applyAction(action);
    advanceAutoOpponent(env, autoOpponent, autoOpponentSeat);
    env.syncRewards();
  }
  return observe(env, compact);
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const req = JSON.parse(trimmed);
    const cmd = req.cmd;

    if (cmd === 'info') {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          stateDim: STATE_DIM,
          actionDim: ACTION_SPACE_SIZE,
        }) + '\n',
      );
      return;
    }

    // `compact: true` returns observations with `stateB64` (float32) instead of `state`/`mask` arrays.
    const compact = req.compact === true;

    if (cmd === 'reset') {
      const env = getEnv(String(req.envId ?? 'env_0'));
      const obs = doReset(env, req, compact);
      process.stdout.write(JSON.stringify({ok: true, obs}) + '\n');
      return;
    }

    if (cmd === 'batch_reset') {
      const items: Array<{
        envId: string;
        seed?: number;
        playerNames?: [string, string];
        autoOpponent?: 'heuristic' | 'random';
        autoOpponentSeat?: number;
      }> = req.items ?? [];
      const results = items.map((item) => ({obs: doReset(getEnv(item.envId), item, compact)}));
      process.stdout.write(JSON.stringify({ok: true, results}) + '\n');
      return;
    }

    if (cmd === 'step') {
      const env = getEnv(String(req.envId ?? 'env_0'));
      const obs = doStep(env, Number(req.action ?? 0), req.autoOpponent, Number(req.autoOpponentSeat ?? 1), compact);
      process.stdout.write(JSON.stringify({ok: true, obs}) + '\n');
      return;
    }

    if (cmd === 'heuristic_action') {
      const env = getEnv(String(req.envId ?? 'env_0'));
      const player = env.players[env.getActivePlayerIndex()];
      const action = selectHeuristicAction(player, env.getDecoded());
      process.stdout.write(JSON.stringify({ok: true, action}) + '\n');
      return;
    }

    if (cmd === 'batch_step') {
      const items: Array<{
        envId: string;
        action: number;
        autoOpponent?: 'heuristic' | 'random';
        autoOpponentSeat?: number;
      }> = req.items ?? [];
      const results = items.map((item) => {
        const env = getEnv(item.envId);
        const seat = Number(item.autoOpponentSeat ?? 1);
        const obs = doStep(env, item.action, item.autoOpponent, seat, compact);
        if (obs.done && req.autoReset) {
          const resetObs = doReset(env, {autoOpponent: item.autoOpponent, autoOpponentSeat: seat}, compact);
          return {terminalObs: obs, obs: resetObs};
        }
        return {obs};
      });
      process.stdout.write(JSON.stringify({ok: true, results}) + '\n');
      return;
    }

    process.stdout.write(JSON.stringify({ok: false, error: `Unknown cmd: ${cmd}`}) + '\n');
  } catch (err: any) {
    process.stdout.write(
      JSON.stringify({ok: false, error: err?.message ?? String(err)}) + '\n',
    );
  }
});
