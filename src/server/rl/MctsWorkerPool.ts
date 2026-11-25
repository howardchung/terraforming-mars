import path from 'path';
import {Worker} from 'worker_threads';
import {Phase} from '../../common/Phase';
import {IGame} from '../IGame';
import {IPlayer} from '../IPlayer';
import {decodeActionSpace, DecodedActionSpace, PlayerStagingState} from './ActionCodec';
import {
  DEFAULT_MCTS_CONFIG,
  MctsConfig,
  MctsSearch,
  MctsSearchResult,
  serializeStagingState,
} from './MctsSearch';
import {MctsWorkerRequest, MctsWorkerResponse} from './MctsWorker';
import {PolicyNetwork} from './PolicyNetwork';
import {encodeGameState} from './StateEncoder';

interface PendingRequest {
  resolve: (result: MctsSearchResult) => void;
  reject: (err: Error) => void;
}

/**
 * Offloads Determinized PUCT MCTS search to a persistent Node `worker_threads`
 * worker so `AgentManager`'s event loop stays responsive during live games.
 *
 * Lazily spawns the worker on first request, syncs `PolicyNetwork` weights only
 * when metadata changes, unrefs the worker when idle so tests/processes exit
 * cleanly, and falls back to in-process `MctsSearch` if the worker is unavailable.
 */
export class MctsWorkerPool {
  private readonly policyNet: PolicyNetwork;
  public readonly config: MctsConfig;
  private worker: Worker | null = null;
  private workerBroken = false;
  private lastSyncedWeightsKey = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(policyNet: PolicyNetwork, config?: Partial<MctsConfig>) {
    this.policyNet = policyNet;
    this.config = {...DEFAULT_MCTS_CONFIG, ...config};
  }

  public isWorkerActive(): boolean {
    return this.worker !== null && !this.workerBroken;
  }

  private getWeightsKey(): string {
    const m = this.policyNet.metadata;
    return `${m.version}:${m.step}:${m.episodes}:${m.updatedAt}:${m.loadedFrom}`;
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }

    try {
      const isTs = __filename.endsWith('.ts');
      const workerFile = path.join(__dirname, isTs ? 'MctsWorker.ts' : 'MctsWorker.js');
      const execArgv = isTs ? [...process.execArgv] : [];
      if (isTs && !execArgv.some((arg) => arg.includes('tsx'))) {
        execArgv.push('--import=tsx');
      }

      const worker = new Worker(workerFile, {execArgv});
      worker.unref();

      worker.on('message', (msg: MctsWorkerResponse) => {
        const entry = this.pending.get(msg.requestId);
        if (!entry) {
          return;
        }
        this.pending.delete(msg.requestId);
        if (this.pending.size === 0) {
          worker.unref();
        }
        if (msg.type === 'result') {
          entry.resolve(msg.result);
        } else {
          entry.reject(new Error(msg.message));
        }
      });

      worker.on('error', (err) => {
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        this.worker = null;
        this.workerBroken = true;
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          this.failAllPending(new Error(`MctsWorker exited with code ${code}`));
        }
        this.worker = null;
      });

      this.worker = worker;
      this.lastSyncedWeightsKey = '';
      return worker;
    } catch (_err) {
      this.workerBroken = true;
      return null;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending.entries()) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  private syncWeightsIfNeeded(worker: Worker): void {
    const key = this.getWeightsKey();
    if (key === this.lastSyncedWeightsKey) {
      return;
    }
    const msg: MctsWorkerRequest = {
      type: 'update_weights',
      weights: this.policyNet.serialize(),
    };
    worker.postMessage(msg);
    this.lastSyncedWeightsKey = key;
  }

  public async searchAsync(
    game: IGame,
    rootPlayer: IPlayer,
    rootStaging: PlayerStagingState,
    rootDecoded?: DecodedActionSpace,
    configOverride?: Partial<MctsConfig>,
  ): Promise<MctsSearchResult> {
    const decoded = rootDecoded ?? decodeActionSpace(rootPlayer, rootStaging);
    const legalIndices: Array<number> = [];
    for (let i = 0; i < decoded.mask.length; i++) {
      if (decoded.mask[i]) {
        legalIndices.push(i);
      }
    }

    const effectiveConfig: MctsConfig = {...this.config, ...configOverride};

    // Fast path: 0-1 legal actions or unserializable mid-action prompts -> run synchronously
    if (
      legalIndices.length <= 1 ||
      game.phase === Phase.END ||
      game.phase === Phase.PRELUDES ||
      game.deferredActions.length > 0
    ) {
      return new MctsSearch(this.policyNet, effectiveConfig).search(
        game,
        rootPlayer,
        rootStaging,
        decoded,
      );
    }

    const worker = this.ensureWorker();
    if (!worker) {
      return new MctsSearch(this.policyNet, effectiveConfig).search(
        game,
        rootPlayer,
        rootStaging,
        decoded,
      );
    }

    let serializedGame;
    try {
      serializedGame = game.serialize();
      serializedGame.gameLog = [];
    } catch (_err) {
      return new MctsSearch(this.policyNet, effectiveConfig).search(
        game,
        rootPlayer,
        rootStaging,
        decoded,
      );
    }

    const rootStateVec = encodeGameState(rootPlayer, rootStaging, decoded.mask);
    this.syncWeightsIfNeeded(worker);

    const requestId = this.nextRequestId++;
    const req: MctsWorkerRequest = {
      type: 'search',
      requestId,
      serializedGame,
      rootPlayerId: rootPlayer.id,
      rootStaging: serializeStagingState(rootStaging),
      rootStateVec,
      rootMask: [...decoded.mask],
      legalIndices,
      config: effectiveConfig,
    };

    try {
      return await new Promise<MctsSearchResult>((resolve, reject) => {
        this.pending.set(requestId, {resolve, reject});
        worker.ref();
        worker.postMessage(req);
      });
    } catch (_err) {
      // Fall back cleanly to in-process MCTS if the worker errors out
      return new MctsSearch(this.policyNet, effectiveConfig).search(
        game,
        rootPlayer,
        rootStaging,
        decoded,
      );
    }
  }

  public async shutdown(): Promise<void> {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      this.failAllPending(new Error('MctsWorkerPool shut down'));
      await w.terminate();
    }
  }
}
