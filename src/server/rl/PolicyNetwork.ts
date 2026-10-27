import fs from 'fs';
import path from 'path';
import {ACTION_SPACE_SIZE, STATE_DIM} from './CardIndex';

export interface SerializedModelWeights {
  version: number;
  step: number;
  episodes: number;
  winRate: number;
  avgVp: number;
  updatedAt: string;
  stateDim: number;
  hiddenDim: number;
  actionDim: number;
  fc1_weight_b64: string;
  fc1_bias_b64: string;
  fc2_weight_b64: string;
  fc2_bias_b64: string;
  actor_weight_b64: string;
  actor_bias_b64: string;
  critic_weight_b64: string;
  critic_bias_b64: string;
}

export interface PolicyEvaluationResult {
  actionIndex: number;
  probability: number;
  logProb: number;
  valueEstimate: number;
  winProbability: number;
  topActions: Array<{actionIndex: number; probability: number}>;
}

function decodeBase64Float32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.byteLength; i++) {
    view[i] = buf[i];
  }
  return new Float32Array(ab);
}

export function encodeFloat32Base64(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return buf.toString('base64');
}

function seededGaussian(seedObj: {s: number}): number {
  const nextU = () => {
    seedObj.s = (seedObj.s * 1664525 + 1013904223) >>> 0;
    return (seedObj.s + 0.5) / 4294967296.0;
  };
  const u1 = Math.max(1e-7, nextU());
  const u2 = nextU();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export class PolicyNetwork {
  public readonly stateDim: number;
  public readonly hiddenDim: number;
  public readonly actionDim: number;

  public fc1Weight: Float32Array;
  public fc1Bias: Float32Array;
  public fc2Weight: Float32Array;
  public fc2Bias: Float32Array;
  public actorWeight: Float32Array;
  public actorBias: Float32Array;
  public criticWeight: Float32Array;
  public criticBias: Float32Array;

  public metadata = {
    version: 1,
    step: 0,
    episodes: 0,
    winRate: 0.5,
    avgVp: 0,
    updatedAt: new Date().toISOString(),
    loadedFrom: 'initialized',
  };

  private lastLoadedMtimeMs = 0;

  constructor(
    stateDim: number = STATE_DIM,
    hiddenDim: number = 256,
    actionDim: number = ACTION_SPACE_SIZE,
    seed: number = 42,
  ) {
    this.stateDim = stateDim;
    this.hiddenDim = hiddenDim;
    this.actionDim = actionDim;

    this.fc1Weight = new Float32Array(hiddenDim * stateDim);
    this.fc1Bias = new Float32Array(hiddenDim);
    this.fc2Weight = new Float32Array(hiddenDim * hiddenDim);
    this.fc2Bias = new Float32Array(hiddenDim);
    this.actorWeight = new Float32Array(actionDim * hiddenDim);
    this.actorBias = new Float32Array(actionDim);
    this.criticWeight = new Float32Array(hiddenDim);
    this.criticBias = new Float32Array(1);

    this.initWeights(seed);
  }

  private initWeights(seed: number): void {
    const rng = {s: seed >>> 0};
    const initLayer = (w: Float32Array, fanIn: number, scale: number) => {
      const std = scale * Math.sqrt(2.0 / fanIn);
      for (let i = 0; i < w.length; i++) {
        w[i] = seededGaussian(rng) * std;
      }
    };
    initLayer(this.fc1Weight, this.stateDim, 1.0);
    initLayer(this.fc2Weight, this.hiddenDim, 1.0);
    initLayer(this.actorWeight, this.hiddenDim, 0.01);
    initLayer(this.criticWeight, this.hiddenDim, 1.0);
  }

  public loadFromSerialized(data: SerializedModelWeights, sourceName: string = 'memory'): boolean {
    if (
      data.stateDim !== this.stateDim ||
      data.hiddenDim !== this.hiddenDim ||
      data.actionDim !== this.actionDim
    ) {
      return false;
    }
    this.fc1Weight = decodeBase64Float32(data.fc1_weight_b64);
    this.fc1Bias = decodeBase64Float32(data.fc1_bias_b64);
    this.fc2Weight = decodeBase64Float32(data.fc2_weight_b64);
    this.fc2Bias = decodeBase64Float32(data.fc2_bias_b64);
    this.actorWeight = decodeBase64Float32(data.actor_weight_b64);
    this.actorBias = decodeBase64Float32(data.actor_bias_b64);
    this.criticWeight = decodeBase64Float32(data.critic_weight_b64);
    this.criticBias = decodeBase64Float32(data.critic_bias_b64);

    this.metadata = {
      version: data.version ?? 1,
      step: data.step ?? 0,
      episodes: data.episodes ?? 0,
      winRate: data.winRate ?? 0.5,
      avgVp: data.avgVp ?? 0,
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      loadedFrom: sourceName,
    };
    return true;
  }

  public serialize(): SerializedModelWeights {
    return {
      version: this.metadata.version,
      step: this.metadata.step,
      episodes: this.metadata.episodes,
      winRate: this.metadata.winRate,
      avgVp: this.metadata.avgVp,
      updatedAt: this.metadata.updatedAt,
      stateDim: this.stateDim,
      hiddenDim: this.hiddenDim,
      actionDim: this.actionDim,
      fc1_weight_b64: encodeFloat32Base64(this.fc1Weight),
      fc1_bias_b64: encodeFloat32Base64(this.fc1Bias),
      fc2_weight_b64: encodeFloat32Base64(this.fc2Weight),
      fc2_bias_b64: encodeFloat32Base64(this.fc2Bias),
      actor_weight_b64: encodeFloat32Base64(this.actorWeight),
      actor_bias_b64: encodeFloat32Base64(this.actorBias),
      critic_weight_b64: encodeFloat32Base64(this.criticWeight),
      critic_bias_b64: encodeFloat32Base64(this.criticBias),
    };
  }

  public maybeReloadFromDisk(weightsPath: string): boolean {
    try {
      if (!fs.existsSync(weightsPath)) {
        return false;
      }
      const stat = fs.statSync(weightsPath);
      if (stat.mtimeMs <= this.lastLoadedMtimeMs) {
        return false;
      }
      const raw = fs.readFileSync(weightsPath, 'utf8');
      const parsed = JSON.parse(raw) as SerializedModelWeights;
      const ok = this.loadFromSerialized(parsed, path.basename(weightsPath));
      if (ok) {
        this.lastLoadedMtimeMs = stat.mtimeMs;
      }
      return ok;
    } catch (_err) {
      return false;
    }
  }

  public forward(state: Float32Array): {logits: Float32Array; value: number} {
    const H = this.hiddenDim;
    const S = this.stateDim;
    const A = this.actionDim;

    // Layer 1: h1 = ReLU(fc1Weight * state + fc1Bias)
    const h1 = new Float32Array(H);
    const w1 = this.fc1Weight;
    const b1 = this.fc1Bias;
    for (let i = 0; i < H; i++) {
      let sum = b1[i];
      const rowOffset = i * S;
      for (let j = 0; j < S; j++) {
        const v = state[j];
        if (v !== 0) {
          sum += w1[rowOffset + j] * v;
        }
      }
      h1[i] = sum > 0 ? sum : 0;
    }

    // Layer 2: h2 = ReLU(fc2Weight * h1 + fc2Bias)
    const h2 = new Float32Array(H);
    const w2 = this.fc2Weight;
    const b2 = this.fc2Bias;
    for (let i = 0; i < H; i++) {
      let sum = b2[i];
      const rowOffset = i * H;
      for (let j = 0; j < H; j++) {
        const v = h1[j];
        if (v !== 0) {
          sum += w2[rowOffset + j] * v;
        }
      }
      h2[i] = sum > 0 ? sum : 0;
    }

    // Actor head: logits = actorWeight * h2 + actorBias
    const logits = new Float32Array(A);
    const wa = this.actorWeight;
    const ba = this.actorBias;
    for (let i = 0; i < A; i++) {
      let sum = ba[i];
      const rowOffset = i * H;
      for (let j = 0; j < H; j++) {
        sum += wa[rowOffset + j] * h2[j];
      }
      logits[i] = sum;
    }

    // Critic head: value = criticWeight . h2 + criticBias[0]
    let value = this.criticBias[0];
    const wc = this.criticWeight;
    for (let j = 0; j < H; j++) {
      value += wc[j] * h2[j];
    }

    return {logits, value};
  }

  public forwardValue(state: Float32Array): number {
    const H = this.hiddenDim;
    const S = this.stateDim;

    const h1 = new Float32Array(H);
    const w1 = this.fc1Weight;
    const b1 = this.fc1Bias;
    for (let i = 0; i < H; i++) {
      let sum = b1[i];
      const rowOffset = i * S;
      for (let j = 0; j < S; j++) {
        const v = state[j];
        if (v !== 0) {
          sum += w1[rowOffset + j] * v;
        }
      }
      h1[i] = sum > 0 ? sum : 0;
    }

    const h2 = new Float32Array(H);
    const w2 = this.fc2Weight;
    const b2 = this.fc2Bias;
    for (let i = 0; i < H; i++) {
      let sum = b2[i];
      const rowOffset = i * H;
      for (let j = 0; j < H; j++) {
        const v = h1[j];
        if (v !== 0) {
          sum += w2[rowOffset + j] * v;
        }
      }
      h2[i] = sum > 0 ? sum : 0;
    }

    let value = this.criticBias[0];
    const wc = this.criticWeight;
    for (let j = 0; j < H; j++) {
      value += wc[j] * h2[j];
    }
    return value;
  }

  public static valueToWinProbability(valueEstimate: number): number {
    const clamped = Math.max(-2.0, Math.min(2.0, Number(valueEstimate) || 0));
    return 1 / (1 + Math.exp(-2.2 * clamped));
  }

  public evaluate(
    state: Float32Array,
    mask: ReadonlyArray<boolean>,
    mode: 'greedy' | 'sample' = 'sample',
    temperature: number = 1.0,
  ): PolicyEvaluationResult {
    const {logits, value} = this.forward(state);
    const winProbability = PolicyNetwork.valueToWinProbability(value);
    const legalIndices: Array<number> = [];
    let maxLogit = -Infinity;
    const temp = Math.max(0.05, temperature);

    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        legalIndices.push(i);
        const scaled = logits[i] / temp;
        if (scaled > maxLogit) {
          maxLogit = scaled;
        }
      }
    }

    if (legalIndices.length === 0) {
      return {
        actionIndex: 0,
        probability: 1.0,
        logProb: 0.0,
        valueEstimate: value,
        winProbability,
        topActions: [],
      };
    }

    const probs = new Float32Array(legalIndices.length);
    let sumExp = 0.0;
    for (let k = 0; k < legalIndices.length; k++) {
      const aIdx = legalIndices[k];
      const e = Math.exp(logits[aIdx] / temp - maxLogit);
      probs[k] = e;
      sumExp += e;
    }
    for (let k = 0; k < legalIndices.length; k++) {
      probs[k] /= sumExp;
    }

    let chosenLocalIdx = 0;
    if (mode === 'greedy' || legalIndices.length === 1) {
      let bestP = -1;
      for (let k = 0; k < legalIndices.length; k++) {
        if (probs[k] > bestP) {
          bestP = probs[k];
          chosenLocalIdx = k;
        }
      }
    } else {
      const r = Math.random();
      let c = 0.0;
      chosenLocalIdx = legalIndices.length - 1;
      for (let k = 0; k < legalIndices.length; k++) {
        c += probs[k];
        if (r <= c) {
          chosenLocalIdx = k;
          break;
        }
      }
    }

    const actionIndex = legalIndices[chosenLocalIdx];
    const probability = probs[chosenLocalIdx];
    const logProb = Math.log(Math.max(1e-12, probability));

    const pairs = legalIndices.map((idx, k) => ({
      actionIndex: idx,
      probability: probs[k],
    }));
    pairs.sort((a, b) => b.probability - a.probability);

    return {
      actionIndex,
      probability,
      logProb,
      valueEstimate: value,
      winProbability,
      topActions: pairs.slice(0, 5),
    };
  }
}
