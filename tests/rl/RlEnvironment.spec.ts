import {expect} from 'chai';
import {
  ACTION_CONVERT_HEAT,
  ACTION_CONVERT_PLANTS,
  ACTION_END_TURN,
  ACTION_OFFSET_STD_PROJECT,
  ACTION_PASS,
  ACTION_SPACE_SIZE,
  ALL_CANONICAL_CARDS,
  RL_TRAINING_GAME_OPTIONS,
  STATE_DIM,
} from '../../src/server/rl/CardIndex';
import {RlGameEnvironment, scoreRusherActions, selectHeuristicAction, selectRusherAction} from '../../src/server/rl/RlEnvironment';
import {decodeActionSpace, DecodedActionSpace} from '../../src/server/rl/ActionCodec';
import {PolicyNetwork} from '../../src/server/rl/PolicyNetwork';
import {BoardName} from '../../src/common/boards/BoardName';
import {ApiRl} from '../../src/server/routes/ApiRl';
import {Database} from '../../src/server/database/Database';
import {GameLoader} from '../../src/server/database/GameLoader';
import {MockResponse} from '../routes/HttpMocks';
import {RouteTestScaffolding} from '../routes/RouteTestScaffolding';

describe('RL Framework (Tharsis 2P Base + Corporate Era + Preludes)', function() {
  this.timeout(10000);

  it('verifies RL training game options and dimensions', () => {
    expect(RL_TRAINING_GAME_OPTIONS.boardName).to.eq(BoardName.THARSIS);
    expect(RL_TRAINING_GAME_OPTIONS.expansions.corpera).to.be.true;
    expect(RL_TRAINING_GAME_OPTIONS.expansions.prelude).to.be.true;
    expect(RL_TRAINING_GAME_OPTIONS.expansions.venus).to.be.false;
    expect(RL_TRAINING_GAME_OPTIONS.expansions.colonies).to.be.false;
    expect(RL_TRAINING_GAME_OPTIONS.expansions.turmoil).to.be.false;
    expect(ALL_CANONICAL_CARDS.length).to.eq(267);
    expect(STATE_DIM).to.eq(1532);
    expect(ACTION_SPACE_SIZE).to.eq(605);
  });

  it('runs a complete 2-player Tharsis game to phase=end using RlGameEnvironment without any database writes', () => {
    const db = Database.getInstance();
    let dbWriteCount = 0;
    const origSaveGame = db.saveGame.bind(db);
    const origSaveResults = db.saveGameResults.bind(db);
    const origMarkFinished = db.markFinished.bind(db);

    db.saveGame = async (game) => {
      dbWriteCount++;
      return origSaveGame(game);
    };
    db.saveGameResults = (...args) => {
      dbWriteCount++;
      return origSaveResults(...args);
    };
    db.markFinished = async (gameId) => {
      dbWriteCount++;
      return origMarkFinished(gameId);
    };

    try {
      const env = new RlGameEnvironment('rl_spec_test', true);
      const obs0 = env.reset(12345);
      expect(GameLoader.isTrainingGame(env.game.id)).to.be.true;
      expect(obs0.state.length).to.eq(STATE_DIM);
      expect(obs0.mask.length).to.eq(ACTION_SPACE_SIZE);
      expect(obs0.legalActionIndices.length).to.be.greaterThan(0);

      let obs = obs0;
      let steps = 0;
      while (!obs.done && steps < 2000) {
        const pIdx = obs.activePlayerIndex;
        const decoded = decodeActionSpace(env.players[pIdx], env.stagings[pIdx]);
        const action = selectHeuristicAction(env.players[pIdx], decoded);
        obs = env.step(action);
        steps++;
      }

      expect(obs.done).to.be.true;
      expect(env.game.phase).to.eq('end');
      expect(obs.generation).to.be.greaterThan(1);
      expect(dbWriteCount).to.eq(0);
    } finally {
      db.saveGame = origSaveGame;
      db.saveGameResults = origSaveResults;
      db.markFinished = origMarkFinished;
    }
  });

  it('evaluates PolicyNetwork forward pass and masked action selection', () => {
    const env = new RlGameEnvironment('rl_policy_test', false);
    const obs = env.reset(42);
    const net = new PolicyNetwork();
    const decision = net.evaluate(new Float32Array(obs.state), obs.mask, 'greedy');
    expect(obs.legalActionIndices).to.include(decision.actionIndex);
    expect(decision.topActions.length).to.be.greaterThan(0);
  });

  it('creates AI vs AI and Human vs AI matches via ApiRl and advances AI turns', async () => {
    const scaffolding = new RouteTestScaffolding();
    const resPost = new MockResponse();
    scaffolding.url = '/api/rl';

    const postPromise = scaffolding.post(ApiRl.INSTANCE, resPost);
    const emitPromise = Promise.resolve().then(() => {
      scaffolding.req.emitString(JSON.stringify({
        action: 'start_match',
        mode: 'ai_vs_ai',
        ai1Type: 'rl',
        ai2Type: 'heuristic',
        delayMs: 20,
      }));
      scaffolding.req.emitter.emit('end');
    });
    await Promise.all([emitPromise, postPromise]);

    const postData = JSON.parse(resPost.content);
    expect(postData.ok).to.be.true;
    expect(postData.spectatorId).to.be.a('string');

    // Wait 300ms for AgentManager to execute AI actions
    await new Promise((r) => setTimeout(r, 300));

    const resGet = new MockResponse();
    scaffolding.url = `/api/rl?participantId=${postData.spectatorId}`;
    await ApiRl.INSTANCE.get(scaffolding.req, resGet, scaffolding.ctx);
    const getData = JSON.parse(resGet.content);
    expect(getData.found).to.be.true;
    expect(getData.aiState.hasAi).to.be.true;
    expect(getData.aiState.lastDecision).to.not.be.null;
    expect(getData.aiState.lastDecision.chosenLabel).to.be.a('string');
    expect(getData.aiState.lastDecision.winProbability).to.be.a('number');
    expect(getData.aiState.players[0].winProbability).to.be.a('number');
    expect(getData.aiState.players[0].winProbability).to.be.within(0, 1);
    expect(getData.aiState.decisionHistory).to.be.an('array');
    expect(getData.aiState.decisionHistory.length).to.be.greaterThan(0);
    const firstDecision = getData.aiState.decisionHistory[0];
    expect(firstDecision.chosenLabel).to.be.a('string');
    expect(firstDecision.availableMoves).to.be.an('array');
    expect(firstDecision.availableMoves.length).to.be.greaterThan(0);
    expect(firstDecision.availableMoves[0].label).to.be.a('string');
    expect(firstDecision.availableMoves[0].score).to.be.a('number');
    expect(firstDecision.availableMoves[0].probability).to.be.a('number');
  });

  it('evaluates Rusher agent scoring and prioritizes terraforming actions', () => {
    const env = new RlGameEnvironment('test_rusher_eval', false);
    env.resetGame(123, ['Rusher-Red', 'Rusher-Blue']);
    const player = env.players[0];

    const mockMask = new Array(ACTION_SPACE_SIZE).fill(false);
    mockMask[ACTION_CONVERT_PLANTS] = true;
    mockMask[ACTION_CONVERT_HEAT] = true;
    mockMask[ACTION_OFFSET_STD_PROJECT + 4] = true; // Asteroid
    mockMask[ACTION_OFFSET_STD_PROJECT + 1] = true; // City
    mockMask[ACTION_END_TURN] = true;
    mockMask[ACTION_PASS] = true;

    const mockDecoded: DecodedActionSpace = {
      mask: mockMask,
      bindings: new Map(),
      promptTitle: 'Take Action',
    };

    const scored = scoreRusherActions(player, mockDecoded);
    expect(scored.length).to.eq(6);

    // Heat and plant conversion should be top scores (> 160)
    const plantScore = scored.find((s) => s.actionIndex === ACTION_CONVERT_PLANTS)!.score;
    const heatScore = scored.find((s) => s.actionIndex === ACTION_CONVERT_HEAT)!.score;
    const asteroidScore = scored.find((s) => s.actionIndex === ACTION_OFFSET_STD_PROJECT + 4)!.score;
    const cityScore = scored.find((s) => s.actionIndex === ACTION_OFFSET_STD_PROJECT + 1)!.score;
    const endTurnScore = scored.find((s) => s.actionIndex === ACTION_END_TURN)!.score;

    expect(plantScore).to.be.greaterThan(160);
    expect(heatScore).to.be.greaterThan(160);
    expect(asteroidScore).to.be.greaterThan(120);
    expect(cityScore).to.be.lessThan(20);
    expect(endTurnScore).to.be.lessThan(40);
    expect(asteroidScore).to.be.greaterThan(cityScore);

    const chosen = selectRusherAction(player, mockDecoded);
    expect([ACTION_CONVERT_PLANTS, ACTION_CONVERT_HEAT]).to.include(chosen);
  });

  it('runs game steps with rusher policy', () => {
    const env = new RlGameEnvironment('test_rusher_run', false);
    env.resetGame(777, ['Rusher-P1', 'Rusher-P2']);

    let steps = 0;
    while (!env.isDone() && steps < 50) {
      steps++;
      const activeIdx = env.getActivePlayerIndex();
      const dec = env.getDecoded();
      const action = selectRusherAction(env.players[activeIdx], dec);
      env.applyAction(action);
      expect(env.getActivePlayerIndex()).to.be.oneOf([0, 1]);
    }
    expect(steps).to.be.greaterThan(0);
  });
});
