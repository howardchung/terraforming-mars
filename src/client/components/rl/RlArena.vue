<template>
  <div id="rl-arena" class="rl-arena-page">
    <div class="rl-arena-header">
      <div>
        <h1 class="rl-arena-title">
          <a href="/" class="rl-back-link">Terraforming Mars</a>
          <span class="rl-title-sep">—</span>
          <span>RL AI Arena &amp; Training Center</span>
        </h1>
        <p class="rl-arena-subtitle">
          Map: <strong>Tharsis (2 Players)</strong> · Expansions: <strong>Base + Corporate Era + Preludes</strong> ·
          State Dim: <strong>{{ status?.stateDim || 1532 }}</strong> · Action Space: <strong>{{ status?.actionSpaceSize || 605 }}</strong>
        </p>
      </div>
      <div class="rl-header-actions">
        <a href="/" class="btn btn-lg">Home</a>
        <a href="/new-game" class="btn btn-lg">Custom Game Setup</a>
        <button class="btn btn-lg btn-primary" @click="fetchStatus">↻ Refresh</button>
      </div>
    </div>

    <!-- Top Row: Play vs AI & Agent vs Agent Launchers -->
    <div class="rl-grid-two">
      <!-- Card 1: Play vs AI Agent -->
      <div class="rl-panel rl-panel--highlight">
        <h2 class="rl-panel-title">⚔️ Play Against the AI Agent</h2>
        <p class="rl-panel-desc">
          Start a 2-player game on Tharsis (Base + Corporate Era + Preludes) and play directly in the standard Terraforming Mars UI against the trained agent.
        </p>
        <div class="rl-form-grid">
          <div class="rl-form-field">
            <label>Your Name</label>
            <input v-model="humanName" type="text" class="rl-input" placeholder="Human Player" />
          </div>
          <div class="rl-form-field">
            <label>Opponent AI Policy</label>
            <select v-model="humanOpponentType" class="rl-select">
              <option value="rl">RL Agent (Masked PPO Neural Network)</option>
              <option value="heuristic">Heuristic Baseline Agent</option>
              <option value="random">Random Valid Action Agent</option>
            </select>
          </div>
          <div class="rl-form-field">
            <label>AI Action Delay</label>
            <select v-model.number="humanAiDelayMs" class="rl-select">
              <option :value="100">Fast (100ms)</option>
              <option :value="300">Normal (300ms)</option>
              <option :value="800">Relaxed (800ms)</option>
            </select>
          </div>
        </div>
        <div class="rl-panel-footer">
          <button
            class="btn btn-lg btn-success rl-launch-btn"
            :disabled="launching"
            @click="startHumanVsAi"
          >
            ▶ Play Human vs AI Game
          </button>
        </div>
      </div>

      <!-- Card 2: Agent vs Agent Match -->
      <div class="rl-panel rl-panel--highlight">
        <h2 class="rl-panel-title">🤖 Start Agent vs Agent Match</h2>
        <p class="rl-panel-desc">
          Launch a match between two AI agents on Tharsis and watch them play in real time inside the Terraforming Mars Spectator UI with full card &amp; neural net inspection.
        </p>
        <div class="rl-form-grid">
          <div class="rl-form-field">
            <label>Red Player (Agent 1)</label>
            <select v-model="ai1Type" class="rl-select">
              <option value="rl">RL Agent (Masked PPO Neural Network)</option>
              <option value="heuristic">Heuristic Baseline Agent</option>
              <option value="random">Random Valid Action Agent</option>
            </select>
          </div>
          <div class="rl-form-field">
            <label>Blue Player (Agent 2)</label>
            <select v-model="ai2Type" class="rl-select">
              <option value="rl">RL Agent (Masked PPO Neural Network)</option>
              <option value="heuristic">Heuristic Baseline Agent</option>
              <option value="random">Random Valid Action Agent</option>
            </select>
          </div>
          <div class="rl-form-field">
            <label>Playback Speed</label>
            <select v-model.number="aiVsAiDelayMs" class="rl-select">
              <option :value="50">Turbo (50ms / action)</option>
              <option :value="250">Fast (250ms / action)</option>
              <option :value="600">Normal (600ms / action)</option>
              <option :value="1500">Slow (1.5s / action)</option>
            </select>
          </div>
        </div>
        <div class="rl-panel-footer">
          <button
            class="btn btn-lg btn-primary rl-launch-btn"
            :disabled="launching"
            @click="startAiVsAi"
          >
            👁 Launch &amp; Watch Agent vs Agent
          </button>
        </div>
      </div>
    </div>

    <!-- Active & Recent Games Table (Watch Training & Matches in Standard Game UI) -->
    <div class="rl-panel">
      <div class="rl-panel-header-row">
        <div>
          <h2 class="rl-panel-title">📺 Live &amp; Recent Games (Watch in Game UI)</h2>
          <p class="rl-panel-desc">
            Every game below—including live RL training episodes, Agent vs Agent matches, and Human vs Agent games—uses the full Terraforming Mars engine and can be opened in the standard Game UI.
          </p>
        </div>
      </div>

      <div v-if="!gamesList || gamesList.length === 0" class="rl-empty-box">
        No active games yet. Click <strong>Play Human vs AI Game</strong>, <strong>Launch &amp; Watch Agent vs Agent</strong>, or <strong>Start RL Training</strong> below!
      </div>

      <div v-else class="rl-table-wrap">
        <table class="rl-table">
          <thead>
            <tr>
              <th>Game ID</th>
              <th>Type</th>
              <th>Phase / Gen</th>
              <th>Terraforming Progress</th>
              <th>Players (TR / VP)</th>
              <th>Actions (Standard TM Game UI)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in gamesList" :key="g.gameId">
              <td class="rl-mono">{{ g.gameId }}</td>
              <td>
                <span v-if="g.isTrainingGame" class="rl-tag rl-tag--train">🎓 RL Training</span>
                <span v-else-if="isAllAi(g)" class="rl-tag rl-tag--aivsai">🤖 Agent vs Agent</span>
                <span v-else class="rl-tag rl-tag--human">⚔️ Human vs AI</span>
              </td>
              <td>
                <strong>Gen {{ g.generation }}</strong>
                <span class="rl-phase-pill" :class="'rl-phase--' + g.phase">{{ g.phase }}</span>
              </td>
              <td>
                <span class="rl-param">🌡 {{ g.temperature }}°C</span>
                <span class="rl-param">💨 {{ g.oxygenLevel }}%</span>
                <span class="rl-param">💧 {{ g.oceans }}/9</span>
              </td>
              <td>
                <div class="rl-players-cell">
                  <span
                    v-for="p in g.players"
                    :key="p.id"
                    class="rl-player-mini"
                    :class="'player_bg_color_' + p.color"
                  >
                    {{ p.isAi ? '🤖' : '👤' }} {{ p.name }} (TR {{ p.terraformRating }}<template v-if="p.isAi && p.winProbability !== undefined"> · 🎯 {{ (p.winProbability * 100).toFixed(1) }}% win</template>)
                  </span>
                </div>
              </td>
              <td>
                <div class="rl-row-actions">
                  <a
                    v-if="g.spectatorId && g.phase !== 'end'"
                    :href="'/spectator?id=' + g.spectatorId"
                    class="btn btn-sm btn-primary"
                  >
                    👁 Watch in Game UI
                  </a>
                  <a
                    v-for="hp in getHumanPlayers(g)"
                    :key="hp.id"
                    :href="'/player?id=' + hp.id"
                    class="btn btn-sm btn-success"
                  >
                    🎮 Play as {{ hp.name }}
                  </a>
                  <a
                    v-if="g.phase === 'end' && (g.spectatorId || (g.players && g.players[0]))"
                    :href="'/the-end?id=' + (g.spectatorId || g.players[0].id)"
                    class="btn btn-sm"
                  >
                    🏆 View Results
                  </a>
                  <a
                    v-else-if="g.spectatorId"
                    :href="'/spectator?id=' + g.spectatorId + '&noredirect'"
                    class="btn btn-sm"
                  >
                    🔍 Inspect Board
                  </a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- RL Training Control & Metrics Panel -->
    <div class="rl-panel">
      <div class="rl-panel-header-row">
        <div>
          <h2 class="rl-panel-title">🧠 Parallel Reinforcement Learning Training &amp; Neural Network Status</h2>
          <p class="rl-panel-desc">
            Train the Masked PPO Actor-Critic network (<code>1532 → 256 → 256 → 605</code>) across parallel Node.js worker processes on Tharsis 2P (Base + Corporate Era + Preludes). Weights are exported to <code>rl/checkpoints/</code> and hot-reloaded by the server.
          </p>
        </div>
        <div class="rl-train-status-badge">
          <span
            class="rl-status-dot"
            :class="status?.training?.running ? 'rl-dot--running' : 'rl-dot--idle'"
          ></span>
          <strong>
            {{
              status?.training?.running
                ? 'Parallel Training Running (' +
                  latestMetrics.numWorkers +
                  'W × ' +
                  latestMetrics.envsPerWorker +
                  'E = ' +
                  latestMetrics.parallelEnvs +
                  ' Games' +
                  (status.training.pid ? ' · PID ' + status.training.pid : '') +
                  ')'
                : 'Training Idle'
            }}
          </strong>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div class="rl-kpi-grid">
        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Model Checkpoint</div>
          <div class="rl-kpi-value">
            {{ status?.policy?.hasTrainedWeights ? 'Loaded ✓' : 'Untrained' }}
          </div>
          <div class="rl-kpi-sub">{{ status?.policy?.updatedAt || 'No checkpoint yet' }}</div>
        </div>

        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Trained Episodes / Steps</div>
          <div class="rl-kpi-value">
            {{ latestMetrics.episodes }} eps / {{ latestMetrics.totalSteps.toLocaleString() }}
          </div>
          <div class="rl-kpi-sub">Tharsis 2P · Base + CE + Prelude</div>
        </div>

        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Parallel Speed (Throughput)</div>
          <div class="rl-kpi-value rl-val-pos">
            {{ latestMetrics.sps }} steps/s
          </div>
          <div class="rl-kpi-sub">
            {{ latestMetrics.numWorkers }} Workers × {{ latestMetrics.envsPerWorker }} Envs ({{ latestMetrics.parallelEnvs }} Games)
          </div>
        </div>

        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Win Rate (Curriculum / Random)</div>
          <div class="rl-kpi-value rl-val-pos">
            {{ (latestMetrics.evalRandomWinRate * 100).toFixed(1) }}%
          </div>
          <div class="rl-kpi-sub">Avg VP: {{ latestMetrics.evalRandomAvgVp.toFixed(1) }}</div>
        </div>

        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Win Rate vs Heuristic</div>
          <div class="rl-kpi-value">
            {{ (latestMetrics.evalHeuristicWinRate * 100).toFixed(1) }}%
          </div>
          <div class="rl-kpi-sub">Best Eval: {{ ((status?.policy?.bestEvalWinRate || 0) * 100).toFixed(1) }}%</div>
        </div>

        <div class="rl-kpi-card">
          <div class="rl-kpi-label">Rolling Avg VP / TR</div>
          <div class="rl-kpi-value">
            {{ latestMetrics.avgVp.toFixed(1) }} VP · {{ latestMetrics.avgTr.toFixed(1) }} TR
          </div>
          <div class="rl-kpi-sub">Avg Gen: {{ latestMetrics.avgGeneration.toFixed(1) }}</div>
        </div>
      </div>

      <!-- Training Controls -->
      <div class="rl-train-controls-bar">
        <div class="rl-form-field rl-field-inline">
          <label>Episodes:</label>
          <input v-model.number="trainEpisodes" type="number" min="4" max="200000" class="rl-input rl-input--sm" />
        </div>
        <div class="rl-form-field rl-field-inline">
          <label>Opponent Curriculum:</label>
          <select v-model="trainOpponent" class="rl-select rl-select--sm">
            <option value="mixed">Mixed (Self-Play + Heuristic + Random)</option>
            <option value="self">Pure Self-Play</option>
            <option value="heuristic">Vs Heuristic Baseline</option>
          </select>
        </div>
        <div class="rl-form-field rl-field-inline">
          <label>Warm-start Steps:</label>
          <input v-model.number="trainWarmstartSteps" type="number" min="0" max="5000" step="100" class="rl-input rl-input--sm" />
        </div>
        <div class="rl-form-field rl-field-inline">
          <label>Parallel Workers:</label>
          <input v-model.number="trainNumWorkers" type="number" min="1" max="16" class="rl-input rl-input--sm" />
        </div>
        <div class="rl-form-field rl-field-inline">
          <label>Envs/Worker:</label>
          <input v-model.number="trainEnvsPerWorker" type="number" min="1" max="16" class="rl-input rl-input--sm" />
        </div>
        <span class="rl-tag rl-tag--train">
          ⚡ {{ Math.max(1, trainNumWorkers || 1) * Math.max(1, trainEnvsPerWorker || 1) }} Parallel Games
        </span>

        <button
          v-if="!status?.training?.running"
          class="btn btn-success"
          @click="startTraining(false)"
        >
          🚀 Start Parallel Training
        </button>
        <template v-else>
          <button
            class="btn btn-primary"
            @click="startTraining(true)"
          >
            ⚡ Restart with Parallel Config
          </button>
          <button
            class="btn btn-error"
            @click="stopTraining"
          >
            ⏹ Stop Training
          </button>
        </template>

        <button class="btn" @click="reloadWeights">
          🔄 Reload Checkpoint Weights
        </button>
      </div>

      <!-- Training History & Live Log -->
      <div class="rl-grid-two rl-mt-12">
        <div>
          <h3 class="rl-sub-heading">📈 Training Progress History</h3>
          <div v-if="trainingHistory.length === 0" class="rl-empty-box">
            No training history recorded yet.
          </div>
          <div v-else class="rl-history-table-wrap">
            <table class="rl-table rl-table--compact">
              <thead>
                <tr>
                  <th>Ep</th>
                  <th>Steps</th>
                  <th>SPS</th>
                  <th>Win%</th>
                  <th>Avg VP</th>
                  <th>Avg TR</th>
                  <th>Gen</th>
                  <th>PLoss</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, idx) in trainingHistory.slice().reverse().slice(0, 12)" :key="idx">
                  <td>{{ row.episode }}</td>
                  <td class="rl-mono">{{ row.totalSteps }}</td>
                  <td class="rl-mono">{{ row.sps || latestMetrics.sps }}</td>
                  <td>{{ ((row.winRate || 0) * 100).toFixed(0) }}%</td>
                  <td><strong>{{ (row.avgVp || 0).toFixed(1) }}</strong></td>
                  <td>{{ (row.avgTr || 0).toFixed(1) }}</td>
                  <td>{{ (row.avgGeneration || 0).toFixed(1) }}</td>
                  <td class="rl-mono">{{ (row.policyLoss || 0).toFixed(4) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 class="rl-sub-heading">🖥 Training Process Log</h3>
          <pre class="rl-log-terminal">{{ trainingLogs }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import {defineComponent} from 'vue';
import {setDocumentTitle} from '@/client/utils/documentTitle';

export default defineComponent({
  name: 'RlArena',
  data() {
    return {
      status: null as any,
      launching: false,
      humanName: 'Player 1',
      humanOpponentType: 'rl',
      humanAiDelayMs: 250,
      ai1Type: 'rl',
      ai2Type: 'heuristic',
      aiVsAiDelayMs: 250,
      trainEpisodes: 60,
      trainOpponent: 'mixed',
      trainWarmstartSteps: 400,
      trainNumWorkers: 2,
      trainEnvsPerWorker: 4,
      pollTimer: undefined as number | undefined,
    };
  },
  computed: {
    gamesList(): Array<any> {
      return this.status?.games ?? [];
    },
    trainingHistory(): Array<any> {
      return this.status?.training?.metrics?.history ?? [];
    },
    latestMetrics(): {
      episodes: number;
      totalSteps: number;
      avgVp: number;
      avgTr: number;
      avgGeneration: number;
      evalRandomWinRate: number;
      evalRandomAvgVp: number;
      evalHeuristicWinRate: number;
      sps: number;
      numWorkers: number;
      envsPerWorker: number;
      parallelEnvs: number;
      } {
      const m = this.status?.training?.metrics;
      const last = this.trainingHistory.length > 0 ? this.trainingHistory[this.trainingHistory.length - 1] : null;
      const lastEval = m?.evalHistory && m.evalHistory.length > 0 ? m.evalHistory[m.evalHistory.length - 1] : null;
      const numWorkers = m?.numWorkers ?? this.status?.training?.numWorkers ?? this.trainNumWorkers ?? 2;
      const envsPerWorker = m?.envsPerWorker ?? this.status?.training?.envsPerWorker ?? this.trainEnvsPerWorker ?? 4;
      const parallelEnvs = m?.parallelEnvs ?? this.status?.training?.parallelEnvs ?? numWorkers * envsPerWorker;
      return {
        episodes: m?.episodesCompleted ?? this.status?.policy?.episodes ?? (last?.episode || 0),
        totalSteps: m?.totalSteps ?? this.status?.policy?.totalSteps ?? (last?.totalSteps || 0),
        avgVp: m?.latestAvgVp ?? last?.avgVp ?? 0,
        avgTr: m?.latestAvgTr ?? last?.avgTr ?? 0,
        avgGeneration: m?.latestAvgGen ?? last?.avgGeneration ?? 0,
        evalRandomWinRate:
          m?.evalVsRandom?.win_rate ??
          lastEval?.vsRandom?.winRate ??
          m?.latestWinRate ??
          last?.winRate ??
          0,
        evalRandomAvgVp:
          m?.evalVsRandom?.avg_vp ??
          lastEval?.vsRandom?.avgVp ??
          m?.latestAvgVp ??
          last?.avgVp ??
          0,
        evalHeuristicWinRate:
          m?.evalVsHeuristic?.win_rate ??
          lastEval?.vsHeuristic?.winRate ??
          this.status?.policy?.bestEvalWinRate ??
          m?.latestWinRate ??
          0,
        sps: m?.latestSps ?? last?.sps ?? 0,
        numWorkers,
        envsPerWorker,
        parallelEnvs,
      };
    },
    trainingLogs(): string {
      const logs: Array<string> = this.status?.training?.recentLogs ?? [];
      if (logs.length > 0) {
        return logs.slice(-25).join('\n');
      }
      if (this.trainingHistory.length > 0) {
        return this.trainingHistory
          .slice(-12)
          .map((r: any) => `[PPO] Ep ${r.episode} | Steps ${r.totalSteps} (${r.sps || 0} sps) | WinRate ${((r.winRate || 0) * 100).toFixed(1)}% | AvgVP ${(r.avgVp || 0).toFixed(1)} | AvgTR ${(r.avgTr || 0).toFixed(1)} | Gen ${(r.avgGeneration || 0).toFixed(1)}`)
          .join('\n');
      }
      return 'Ready. Click "Start Parallel Training" or run `python3 rl/train.py` in a terminal.';
    },
  },
  mounted() {
    setDocumentTitle('RL AI Arena - Terraforming Mars');
    this.fetchStatus();
    this.pollTimer = window.setInterval(() => {
      this.fetchStatus();
    }, 1500);
  },
  beforeUnmount() {
    if (this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  },
  methods: {
    async fetchStatus() {
      try {
        const resp = await fetch('/api/rl');
        if (!resp.ok) return;
        const data = await resp.json();
        this.status = data.status;
      } catch (_err) {
        // Ignore transient errors
      }
    },
    isAllAi(game: any): boolean {
      if (!game.players || game.players.length === 0) return false;
      return game.players.every((p: any) => p.isAi);
    },
    getHumanPlayers(game: any): Array<any> {
      if (!game.players) return [];
      return game.players.filter((p: any) => !p.isAi);
    },
    async startHumanVsAi() {
      this.launching = true;
      try {
        const resp = await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            action: 'start_match',
            mode: 'human_vs_ai',
            humanName: this.humanName || 'Human',
            ai1Type: this.humanOpponentType,
            delayMs: this.humanAiDelayMs,
          }),
        });
        if (!resp.ok) {
          throw new Error('Failed to create Human vs AI match');
        }
        const data = await resp.json();
        if (data.humanPlayerId) {
          window.location.href = `/player?id=${data.humanPlayerId}`;
        }
      } catch (err) {
        alert('Error starting Human vs AI game: ' + err);
      } finally {
        this.launching = false;
      }
    },
    async startAiVsAi() {
      this.launching = true;
      try {
        const resp = await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            action: 'start_match',
            mode: 'ai_vs_ai',
            ai1Type: this.ai1Type,
            ai2Type: this.ai2Type,
            delayMs: this.aiVsAiDelayMs,
          }),
        });
        if (!resp.ok) {
          throw new Error('Failed to create Agent vs Agent match');
        }
        const data = await resp.json();
        if (data.spectatorId) {
          window.location.href = `/spectator?id=${data.spectatorId}`;
        }
      } catch (err) {
        alert('Error starting Agent vs Agent game: ' + err);
      } finally {
        this.launching = false;
      }
    },
    async startTraining(restart = false) {
      try {
        await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            action: 'start_training',
            episodes: this.trainEpisodes,
            opponentType: this.trainOpponent,
            warmstartSteps: this.trainWarmstartSteps,
            numWorkers: this.trainNumWorkers,
            envsPerWorker: this.trainEnvsPerWorker,
            restart,
          }),
        });
        await this.fetchStatus();
      } catch (err) {
        alert('Error starting training: ' + err);
      }
    },
    async stopTraining() {
      try {
        await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'stop_training'}),
        });
        await this.fetchStatus();
      } catch (err) {
        alert('Error stopping training: ' + err);
      }
    },
    async reloadWeights() {
      try {
        await fetch('/api/rl', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'reload_weights'}),
        });
        await this.fetchStatus();
      } catch (err) {
        console.error(err);
      }
    },
  },
});
</script>

<style scoped>
.rl-arena-page {
  max-width: 1240px;
  margin: 0 auto;
  padding: 20px 24px 48px 24px;
  color: #f1e9e4;
}

.rl-arena-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 22px;
  padding-bottom: 14px;
  border-bottom: 2px solid #c65d21;
}

.rl-arena-title {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.4px;
}

.rl-back-link {
  color: #ff922b;
  text-decoration: none;
}

.rl-title-sep {
  margin: 0 10px;
  color: #868e96;
}

.rl-arena-subtitle {
  margin: 6px 0 0 0;
  color: #ced4da;
  font-size: 14px;
}

.rl-header-actions {
  display: flex;
  gap: 10px;
}

.rl-grid-two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
  gap: 18px;
  margin-bottom: 20px;
}

.rl-panel {
  background: #1e1815;
  border: 1px solid #4a352a;
  border-radius: 8px;
  padding: 18px 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}

.rl-panel--highlight {
  border-color: #c65d21;
  background: linear-gradient(160deg, #231a16 0%, #191310 100%);
  margin-bottom: 0;
}

.rl-panel-title {
  margin: 0 0 6px 0;
  font-size: 20px;
  color: #ffd8a8;
}

.rl-panel-desc {
  margin: 0 0 14px 0;
  color: #adb5bd;
  font-size: 13px;
  line-height: 1.45;
}

.rl-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.rl-form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
}

.rl-field-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.rl-input,
.rl-select {
  background: #120e0c;
  color: #fff;
  border: 1px solid #6e4730;
  border-radius: 4px;
  padding: 7px 10px;
  font-size: 13px;
}

.rl-input--sm {
  width: 85px;
  padding: 5px 8px;
}

.rl-select--sm {
  padding: 5px 8px;
}

.rl-panel-footer {
  display: flex;
  justify-content: flex-end;
}

.rl-launch-btn {
  width: 100%;
  font-weight: 700;
  padding: 8px 16px;
}

.rl-panel-header-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.rl-empty-box {
  background: rgba(0, 0, 0, 0.25);
  border: 1px dashed #5c4033;
  padding: 18px;
  border-radius: 6px;
  color: #adb5bd;
  text-align: center;
}

.rl-table-wrap {
  overflow-x: auto;
}

.rl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.rl-table th,
.rl-table td {
  padding: 9px 10px;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.rl-table th {
  color: #ffd8a8;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.3);
}

.rl-table--compact th,
.rl-table--compact td {
  padding: 5px 8px;
  font-size: 12px;
}

.rl-mono {
  font-family: monospace;
}

.rl-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.rl-tag--train {
  background: #5f3dc4;
  color: #fff;
}

.rl-tag--aivsai {
  background: #1971c2;
  color: #fff;
}

.rl-tag--human {
  background: #2f9e44;
  color: #fff;
}

.rl-phase-pill {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.12);
}

.rl-phase--end {
  background: #e67700;
  color: #fff;
}

.rl-param {
  margin-right: 10px;
  white-space: nowrap;
}

.rl-players-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rl-player-mini {
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.rl-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rl-train-status-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.4);
  padding: 6px 12px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.rl-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.rl-dot--running {
  background: #51cf66;
  box-shadow: 0 0 8px #51cf66;
}

.rl-dot--idle {
  background: #adb5bd;
}

.rl-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.rl-kpi-card {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 12px 14px;
}

.rl-kpi-label {
  font-size: 12px;
  color: #adb5bd;
  margin-bottom: 4px;
}

.rl-kpi-value {
  font-size: 19px;
  font-weight: 700;
  color: #fff;
}

.rl-kpi-sub {
  font-size: 11px;
  color: #868e96;
  margin-top: 4px;
}

.rl-val-pos {
  color: #69db7c;
}

.rl-train-controls-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  background: rgba(0, 0, 0, 0.28);
  padding: 12px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.rl-mt-12 {
  margin-top: 16px;
}

.rl-sub-heading {
  font-size: 15px;
  margin: 0 0 8px 0;
  color: #ffd8a8;
}

.rl-history-table-wrap {
  max-height: 260px;
  overflow-y: auto;
}

.rl-log-terminal {
  background: #0d0a09;
  color: #8ce99a;
  border: 1px solid #3d2c24;
  border-radius: 6px;
  padding: 10px 12px;
  font-family: monospace;
  font-size: 12px;
  height: 235px;
  overflow-y: auto;
  margin: 0;
  white-space: pre-wrap;
}
</style>
