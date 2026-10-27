<template>
  <div v-if="isVisible" class="rl-ai-control-bar">
    <div class="rl-ai-bar-top">
      <div class="rl-ai-badge-group">
        <span class="rl-ai-badge rl-ai-badge--mode">
          {{ modeLabel }}
        </span>
        <span
          v-for="p in aiPlayerBadges"
          :key="p.id"
          class="rl-ai-player-pill"
          :class="'player_bg_color_' + p.color"
        >
          🤖 {{ p.name }} ({{ formatAgentType(p.agentType) }})
          <span
            class="rl-ai-pill-win"
            :title="'Estimated chance of winning (V=' + formatSigned(getPlayerValueEstimate(p)) + ')'"
          >
            · 🎯 {{ formatWinPercent(getPlayerWinProb(p)) }} Win
          </span>
        </span>
        <span v-if="status && status.policy" class="rl-ai-model-tag">
          {{ status.policy.hasTrainedWeights ? '🧠 Neural Net Loaded' : '⚡ Untrained / Warmstart' }}
        </span>
      </div>

      <div class="rl-ai-controls">
        <template v-if="aiState && aiState.hasAi">
          <button
            class="btn btn-sm"
            :class="aiState.paused ? 'btn-success' : 'btn-warning'"
            @click="togglePause"
          >
            {{ aiState.paused ? '▶ Resume AI' : '⏸ Pause AI' }}
          </button>

          <button
            class="btn btn-sm btn-primary"
            :disabled="!aiState.paused"
            title="Step forward exactly 1 AI action"
            @click="stepOnce"
          >
            ⏭ Step 1 Action
          </button>

          <div class="rl-speed-control">
            <label>Speed:</label>
            <select :value="currentDelayPreset" @change="onSpeedChange($event)" class="rl-speed-select">
              <option :value="50">Turbo (50ms)</option>
              <option :value="200">Fast (200ms)</option>
              <option :value="500">Normal (500ms)</option>
              <option :value="1200">Slow (1.2s)</option>
              <option :value="2500">Step-by-step (2.5s)</option>
            </select>
          </div>
        </template>

        <button
          class="btn btn-sm"
          @click="showInspector = !showInspector"
        >
          {{ showInspector ? 'Hide AI Thoughts' : '🔍 AI Thoughts' }}
        </button>

        <button
          v-if="isSpectator && hasPlayerHands"
          class="btn btn-sm"
          @click="showHands = !showHands"
        >
          {{ showHands ? 'Hide Hands' : '🃏 Inspect Hands' }}
        </button>

        <a href="/rl" class="btn btn-sm rl-arena-link">
          🚀 RL Arena
        </a>
      </div>
    </div>

    <!-- Always-visible Agent Estimated Chance of Winning Bar -->
    <div v-if="aiPlayerBadges.length > 0" class="rl-win-chance-strip">
      <div
        v-for="p in aiPlayerBadges"
        :key="'win-' + p.id"
        class="rl-win-chance-item"
      >
        <div class="rl-win-chance-header">
          <span class="rl-win-chance-title">
            🎯 <strong>{{ p.name }}</strong> Estimated Chance of Winning:
          </span>
          <span class="rl-win-chance-metrics">
            <span
              class="rl-win-chance-pct"
              :class="getPlayerWinProb(p) >= 0.5 ? 'rl-val-pos' : 'rl-val-neg'"
            >
              {{ formatWinPercent(getPlayerWinProb(p)) }}
            </span>
            <span class="rl-win-chance-v">
              (V(s): {{ formatSigned(getPlayerValueEstimate(p)) }})
            </span>
          </span>
        </div>
        <div class="rl-win-bar-track">
          <div class="rl-win-bar-midline" title="50% Even Odds"></div>
          <div
            class="rl-win-bar-fill"
            :class="getPlayerWinProb(p) >= 0.5 ? 'rl-win-bar-fill--favored' : 'rl-win-bar-fill--behind'"
            :style="{ width: Math.min(100, Math.max(2, getPlayerWinProb(p) * 100)) + '%' }"
          ></div>
        </div>
      </div>
    </div>

    <!-- Neural Network Decision Inspector -->
    <div v-if="showInspector && lastDecision" class="rl-ai-inspector">
      <div class="rl-inspector-header">
        <div>
          <strong>Last AI Move:</strong>
          <span class="rl-decision-player" :class="'player_bg_color_' + lastDecision.playerColor">
            {{ lastDecision.playerName }}
          </span>
          chose
          <span class="rl-chosen-action">{{ lastDecision.chosenLabel }}</span>
        </div>
        <div class="rl-value-readout">
          <span class="rl-value-label">Est. Chance of Winning:</span>
          <span
            class="rl-value-number"
            :class="getDecisionWinProb(lastDecision) >= 0.5 ? 'rl-val-pos' : 'rl-val-neg'"
          >
            {{ formatWinPercent(getDecisionWinProb(lastDecision)) }}
          </span>
          <span class="rl-win-prob">
            (Critic V(s): {{ formatSigned(lastDecision.valueEstimate) }})
          </span>
        </div>
      </div>

      <div v-if="lastDecision.topCandidates && lastDecision.topCandidates.length > 0" class="rl-candidates-row">
        <div
          v-for="cand in lastDecision.topCandidates"
          :key="cand.actionIndex"
          class="rl-candidate-chip"
          :class="{ 'rl-candidate-chip--chosen': cand.actionIndex === lastDecision.chosenAction }"
        >
          <div class="rl-cand-top">
            <span class="rl-cand-label">{{ cand.label }}</span>
            <span class="rl-cand-prob">{{ (cand.probability * 100).toFixed(1) }}%</span>
          </div>
          <div class="rl-cand-bar-bg">
            <div class="rl-cand-bar-fill" :style="{ width: Math.min(100, Math.max(2, cand.probability * 100)) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Spectator Hand Inspector (reuses standard Terraforming Mars Card component) -->
    <div v-if="isSpectator && showHands && hasPlayerHands" class="rl-spectator-hands">
      <div
        v-for="p in aiState?.players || []"
        :key="p.id"
        class="rl-spectator-player-hand"
      >
        <div class="rl-hand-header">
          <span class="rl-ai-player-pill" :class="'player_bg_color_' + p.color">
            {{ p.name }}
          </span>
          <span class="rl-hand-count">
            {{ getPlayerHandCards(p.id).length }} Project Cards in Hand
            <template v-if="getPlayerPreludeCards(p.id).length > 0">
              · {{ getPlayerPreludeCards(p.id).length }} Preludes
            </template>
          </span>
        </div>
        <div v-if="getPlayerPreludeCards(p.id).length > 0" class="rl-cards-row">
          <div
            v-for="cardModel in getPlayerPreludeCards(p.id)"
            :key="'pre-' + cardModel.name"
            class="cardbox"
          >
            <Card :card="cardModel" />
          </div>
        </div>
        <div v-if="getPlayerHandCards(p.id).length > 0" class="rl-cards-row">
          <div
            v-for="cardModel in getPlayerHandCards(p.id)"
            :key="cardModel.name"
            class="cardbox"
          >
            <Card :card="cardModel" />
          </div>
        </div>
        <div v-else class="rl-empty-hand">No cards currently in hand.</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import {defineComponent} from 'vue';
import Card from '@/client/components/card/Card.vue';
import {CardModel} from '@/common/models/CardModel';
import {CardName} from '@/common/cards/CardName';
import {vueRoot} from '@/client/components/vueRoot';
import {isPlayerId} from '@/common/Types';

interface TopCandidate {
  actionIndex: number;
  label: string;
  probability: number;
}

interface LastDecision {
  timestamp: number;
  playerId: string;
  playerName: string;
  playerColor: string;
  agentType: string;
  chosenAction: number;
  chosenLabel: string;
  valueEstimate: number;
  winProbability?: number;
  topCandidates: Array<TopCandidate>;
}

interface AiPlayerInfo {
  id: string;
  name: string;
  color: string;
  isAi: boolean;
  agentType: string | null;
  valueEstimate?: number;
  winProbability?: number;
}

interface AiGameState {
  gameId: string;
  hasAi: boolean;
  paused: boolean;
  delayMs: number;
  aiPlayers: Record<string, string>;
  lastDecision: LastDecision | null;
  isTrainingGame?: boolean;
  playerHands?: Record<string, {cardsInHand: Array<CardName>; preludeCardsInHand: Array<CardName>}>;
  players: Array<AiPlayerInfo>;
}

export default defineComponent({
  name: 'AiControlBar',
  components: {
    Card,
  },
  props: {
    participantId: {
      type: String,
      required: true,
    },
    isSpectator: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      aiState: null as AiGameState | null,
      status: null as any,
      showInspector: true,
      showHands: false,
      pollTimer: undefined as number | undefined,
      lastSeenDecisionTimestamp: 0,
    };
  },
  computed: {
    isVisible(): boolean {
      if (!this.aiState) return false;
      return Boolean(this.aiState.hasAi || this.aiState.isTrainingGame);
    },
    modeLabel(): string {
      if (!this.aiState) return 'AI Match';
      if (this.aiState.isTrainingGame) return '🎓 Live RL Training Game';
      const aiCount = this.aiPlayerBadges.length;
      const totalCount = this.aiState.players ? this.aiState.players.length : 2;
      if (aiCount >= totalCount) return '🤖 Agent vs Agent Match';
      return '⚔️ Human vs Agent Match';
    },
    aiPlayerBadges(): Array<AiPlayerInfo> {
      if (!this.aiState || !this.aiState.players) return [];
      return this.aiState.players.filter((p) => p.isAi);
    },
    lastDecision(): LastDecision | null {
      return this.aiState?.lastDecision ?? null;
    },
    currentDelayPreset(): number {
      const d = this.aiState?.delayMs ?? 350;
      const presets = [50, 200, 500, 1200, 2500];
      let closest = presets[0];
      for (const p of presets) {
        if (Math.abs(p - d) < Math.abs(closest - d)) {
          closest = p;
        }
      }
      return closest;
    },
    hasPlayerHands(): boolean {
      if (!this.aiState?.playerHands) return false;
      return Object.keys(this.aiState.playerHands).length > 0;
    },
  },
  mounted() {
    this.fetchState();
    this.pollTimer = window.setInterval(() => {
      this.fetchState();
    }, 600);
  },
  beforeUnmount() {
    if (this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  },
  methods: {
    async fetchState() {
      if (!this.participantId) return;
      try {
        const resp = await fetch(`/api/rl?participantId=${encodeURIComponent(this.participantId)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        this.status = data.status;
        if (data.aiState) {
          const prevTs = this.lastSeenDecisionTimestamp;
          const newTs = data.aiState.lastDecision?.timestamp ?? 0;
          this.aiState = data.aiState;
          if (newTs > prevTs) {
            this.lastSeenDecisionTimestamp = newTs;
            if (this.isSpectator) {
              try {
                const root = vueRoot(this);
                if (root && typeof root.updateSpectator === 'function') {
                  root.updateSpectator();
                }
              } catch (_e) {
                // Ignore if vueRoot is not attached in unit test
              }
            }
          }
        }
      } catch (_err) {
        // Ignore transient network errors during polling
      }
    },
    async sendControl(payload: Record<string, any>) {
      try {
        const resp = await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            action: 'control_game',
            participantId: this.participantId,
            ...payload,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.aiState) {
            this.aiState = data.aiState;
          }
          this.refreshGameView();
        }
      } catch (err) {
        console.error('Failed to send AI control:', err);
      }
    },
    togglePause() {
      if (!this.aiState) return;
      this.sendControl({paused: !this.aiState.paused});
    },
    stepOnce() {
      this.sendControl({stepOnce: true});
    },
    onSpeedChange(event: Event) {
      const target = event.target as HTMLSelectElement;
      const delayMs = Number(target.value);
      if (!isNaN(delayMs)) {
        this.sendControl({delayMs});
      }
    },
    refreshGameView() {
      try {
        const root = vueRoot(this);
        if (!root) return;
        if (isPlayerId(this.participantId) && typeof root.updatePlayer === 'function') {
          root.updatePlayer();
        } else if (typeof root.updateSpectator === 'function') {
          root.updateSpectator();
        }
      } catch (_e) {
        // Ignore in isolated tests
      }
    },
    formatAgentType(agentType: string | null): string {
      if (agentType === 'rl') return 'RL Policy';
      if (agentType === 'heuristic') return 'Heuristic';
      if (agentType === 'random') return 'Random';
      return 'AI';
    },
    formatSigned(val: number): string {
      const num = Number(val) || 0;
      return (num >= 0 ? '+' : '') + num.toFixed(3);
    },
    formatWinPercent(prob: number): string {
      const pct = Math.max(0, Math.min(100, (Number(prob) || 0) * 100));
      return pct.toFixed(1) + '%';
    },
    valueToWinProb(v: number): number {
      const clamped = Math.max(-2.0, Math.min(2.0, Number(v) || 0));
      return 1 / (1 + Math.exp(-2.2 * clamped));
    },
    getDecisionWinProb(decision: LastDecision): number {
      if (typeof decision.winProbability === 'number' && !isNaN(decision.winProbability)) {
        return decision.winProbability;
      }
      return this.valueToWinProb(decision.valueEstimate);
    },
    getPlayerValueEstimate(p: AiPlayerInfo): number {
      if (typeof p.valueEstimate === 'number' && !isNaN(p.valueEstimate)) {
        return p.valueEstimate;
      }
      if (
        this.lastDecision &&
        (this.lastDecision.playerId === p.id ||
          this.lastDecision.playerName === p.name ||
          this.aiPlayerBadges.length === 1)
      ) {
        return this.lastDecision.valueEstimate;
      }
      return 0;
    },
    getPlayerWinProb(p: AiPlayerInfo): number {
      if (typeof p.winProbability === 'number' && !isNaN(p.winProbability)) {
        return p.winProbability;
      }
      if (typeof p.valueEstimate === 'number' && !isNaN(p.valueEstimate)) {
        return this.valueToWinProb(p.valueEstimate);
      }
      if (
        this.lastDecision &&
        (this.lastDecision.playerId === p.id ||
          this.lastDecision.playerName === p.name ||
          this.aiPlayerBadges.length === 1)
      ) {
        return this.getDecisionWinProb(this.lastDecision);
      }
      return 0.5;
    },
    getPlayerHandCards(playerId: string): Array<CardModel> {
      const hand = this.aiState?.playerHands?.[playerId]?.cardsInHand ?? [];
      return hand.map((name) => ({name, resources: 0} as CardModel));
    },
    getPlayerPreludeCards(playerId: string): Array<CardModel> {
      const hand = this.aiState?.playerHands?.[playerId]?.preludeCardsInHand ?? [];
      return hand.map((name) => ({name, resources: 0} as CardModel));
    },
  },
});
</script>

<style scoped>
.rl-ai-control-bar {
  background: linear-gradient(135deg, #1b1512 0%, #261c18 100%);
  border: 1px solid #c65d21;
  border-radius: 6px;
  padding: 10px 14px;
  margin: 8px 0 12px 0;
  color: #f4ece6;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
  font-size: 13px;
}

.rl-ai-bar-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.rl-ai-badge-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.rl-ai-badge--mode {
  background: #c65d21;
  color: #fff;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 4px;
  letter-spacing: 0.3px;
}

.rl-ai-player-pill {
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
}

.rl-ai-pill-win {
  font-weight: 700;
  color: #ffe8cc;
  margin-left: 2px;
}

.rl-win-chance-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.rl-win-chance-item {
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  padding: 6px 10px;
}

.rl-win-chance-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
}

.rl-win-chance-title {
  color: #f4ece6;
}

.rl-win-chance-metrics {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rl-win-chance-pct {
  font-family: monospace;
  font-size: 14px;
  font-weight: 700;
}

.rl-win-chance-v {
  color: #adb5bd;
  font-size: 11px;
  font-family: monospace;
}

.rl-win-bar-track {
  position: relative;
  height: 7px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  overflow: hidden;
}

.rl-win-bar-midline {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.45);
  z-index: 1;
}

.rl-win-bar-fill {
  height: 100%;
  transition: width 0.25s ease;
}

.rl-win-bar-fill--favored {
  background: linear-gradient(90deg, #2b8a3e, #69db7c);
}

.rl-win-bar-fill--behind {
  background: linear-gradient(90deg, #c92a2a, #ff8787);
}

.rl-ai-model-tag {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: #ffd8a8;
}

.rl-ai-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.rl-speed-control {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(0, 0, 0, 0.35);
  padding: 2px 8px;
  border-radius: 4px;
}

.rl-speed-select {
  background: #1a1412;
  color: #fff;
  border: 1px solid #6e4730;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
}

.rl-arena-link {
  background: #2b4c7e !important;
  border-color: #3e6db3 !important;
  color: #fff !important;
  text-decoration: none;
}

.rl-ai-inspector {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.rl-inspector-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rl-decision-player {
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: bold;
  margin: 0 4px;
}

.rl-chosen-action {
  color: #ffb366;
  font-weight: 700;
  margin-left: 4px;
}

.rl-value-readout {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.3);
  padding: 2px 8px;
  border-radius: 4px;
}

.rl-value-number {
  font-family: monospace;
  font-weight: 700;
  font-size: 14px;
}

.rl-val-pos {
  color: #69db7c;
}

.rl-val-neg {
  color: #ff8787;
}

.rl-win-prob {
  color: #adb5bd;
  font-size: 12px;
}

.rl-candidates-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 6px;
}

.rl-candidate-chip {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 4px 8px;
}

.rl-candidate-chip--chosen {
  border-color: #ff922b;
  background: rgba(255, 146, 43, 0.14);
}

.rl-cand-top {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 3px;
  gap: 4px;
}

.rl-cand-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rl-cand-prob {
  font-family: monospace;
  color: #ffd8a8;
  flex-shrink: 0;
}

.rl-cand-bar-bg {
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.rl-cand-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff922b, #ffd43b);
}

.rl-spectator-hands {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
}

.rl-spectator-player-hand {
  margin-bottom: 12px;
}

.rl-hand-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.rl-hand-count {
  color: #ced4da;
  font-size: 12px;
}

.rl-cards-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rl-empty-hand {
  color: #868e96;
  font-style: italic;
  font-size: 12px;
}
</style>
