process.env.SQLITE_FILE_NAME = ':memory:';
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
import {RlGameEnvironment, selectHeuristicAction, StepObservation} from './RlEnvironment';
import {decodeActionSpace} from './ActionCodec';
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

function advanceAutoOpponent(
  env: RlGameEnvironment,
  obs: StepObservation,
  autoOpponent?: 'heuristic' | 'random',
  autoOpponentSeat: number = 1,
): StepObservation {
  if (!autoOpponent) {
    return obs;
  }
  let cur = obs;
  while (!cur.done && cur.activePlayerIndex === autoOpponentSeat) {
    const oppPlayer = env.players[autoOpponentSeat];
    const oppStaging = env.stagings[autoOpponentSeat];
    const dec = env.lastDecoded ?? decodeActionSpace(oppPlayer, oppStaging);
    const oppAction =
      autoOpponent === 'heuristic' ?
        selectHeuristicAction(oppPlayer, dec) :
        cur.legalActionIndices[Math.floor(Math.random() * cur.legalActionIndices.length)];
    cur = env.step(oppAction);
  }
  return cur;
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

    if (cmd === 'reset') {
      const envId = String(req.envId ?? 'env_0');
      const env = getEnv(envId);
      let obs = env.reset(req.seed, req.playerNames);
      if (req.autoOpponent) {
        obs = advanceAutoOpponent(env, obs, req.autoOpponent, Number(req.autoOpponentSeat ?? 1));
      }
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
      const results = items.map((item) => {
        const env = getEnv(item.envId);
        let obs = env.reset(item.seed, item.playerNames);
        if (item.autoOpponent) {
          obs = advanceAutoOpponent(env, obs, item.autoOpponent, Number(item.autoOpponentSeat ?? 1));
        }
        return {obs};
      });
      process.stdout.write(JSON.stringify({ok: true, results}) + '\n');
      return;
    }

    if (cmd === 'step') {
      const envId = String(req.envId ?? 'env_0');
      const action = Number(req.action ?? 0);
      const env = getEnv(envId);
      let obs = env.step(action);
      if (req.autoOpponent) {
        obs = advanceAutoOpponent(env, obs, req.autoOpponent, Number(req.autoOpponentSeat ?? 1));
      }
      process.stdout.write(JSON.stringify({ok: true, obs}) + '\n');
      return;
    }

    if (cmd === 'heuristic_action') {
      const envId = String(req.envId ?? 'env_0');
      const env = getEnv(envId);
      const pIdx = env.getActivePlayerIndex();
      const player = env.players[pIdx];
      const staging = env.stagings[pIdx];
      const decoded = env.lastDecoded ?? decodeActionSpace(player, staging);
      const action = selectHeuristicAction(player, decoded);
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
        let obs = env.step(item.action);
        if (item.autoOpponent) {
          obs = advanceAutoOpponent(env, obs, item.autoOpponent, Number(item.autoOpponentSeat ?? 1));
        }
        if (obs.done && req.autoReset) {
          const terminalObs = obs;
          let resetObs = env.reset();
          if (item.autoOpponent) {
            resetObs = advanceAutoOpponent(env, resetObs, item.autoOpponent, Number(item.autoOpponentSeat ?? 1));
          }
          return {terminalObs, obs: resetObs};
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
