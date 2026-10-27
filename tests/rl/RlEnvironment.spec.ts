import {expect} from 'chai';
import {ACTION_SPACE_SIZE, ALL_CANONICAL_CARDS, RL_TRAINING_GAME_OPTIONS, STATE_DIM} from '../../src/server/rl/CardIndex';
import {RlGameEnvironment, selectHeuristicAction} from '../../src/server/rl/RlEnvironment';
import {decodeActionSpace} from '../../src/server/rl/ActionCodec';
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
  });
});
