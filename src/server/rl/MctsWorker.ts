import {parentPort} from 'worker_threads';
import {PlayerId} from '../../common/Types';
import {globalInitialize} from '../globalInitialize';
import {SerializedGame} from '../SerializedGame';
import {
  MctsConfig,
  MctsSearch,
  MctsSearchResult,
  SerializableStagingState,
} from './MctsSearch';
import {PolicyNetwork, SerializedModelWeights} from './PolicyNetwork';

export type MctsWorkerRequest =
  | {
      type: 'update_weights';
      weights: SerializedModelWeights;
    }
  | {
      type: 'search';
      requestId: number;
      serializedGame: SerializedGame;
      rootPlayerId: PlayerId;
      rootStaging: SerializableStagingState;
      rootStateVec: Float32Array;
      rootMask: Array<boolean>;
      legalIndices: Array<number>;
      config?: Partial<MctsConfig>;
    };

export type MctsWorkerResponse =
  | {
      type: 'result';
      requestId: number;
      result: MctsSearchResult;
    }
  | {
      type: 'error';
      requestId: number;
      message: string;
    };

globalInitialize();

const policyNet = new PolicyNetwork();

if (parentPort) {
  const port = parentPort;
  port.on('message', (msg: MctsWorkerRequest) => {
    if (msg.type === 'update_weights') {
      policyNet.loadFromSerialized(msg.weights, 'worker-sync');
      return;
    }

    if (msg.type === 'search') {
      try {
        const search = new MctsSearch(policyNet, msg.config);
        const stateVec = msg.rootStateVec instanceof Float32Array ?
          msg.rootStateVec :
          new Float32Array(msg.rootStateVec);
        const result = search.searchFromSerialized(
          msg.serializedGame,
          msg.rootPlayerId,
          msg.rootStaging,
          stateVec,
          msg.rootMask,
          msg.legalIndices,
        );
        const reply: MctsWorkerResponse = {
          type: 'result',
          requestId: msg.requestId,
          result,
        };
        port.postMessage(reply);
      } catch (err) {
        const reply: MctsWorkerResponse = {
          type: 'error',
          requestId: msg.requestId,
          message: err instanceof Error ? err.message : String(err),
        };
        port.postMessage(reply);
      }
    }
  });
}
