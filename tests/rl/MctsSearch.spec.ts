import {expect} from 'chai';
import {Phase} from '../../src/common/Phase';
import {Database} from '../../src/server/database/Database';
import {decodeActionSpace} from '../../src/server/rl/ActionCodec';
import {AgentManager} from '../../src/server/rl/AgentManager';
import {determinizeSerializedGame, MctsSearch} from '../../src/server/rl/MctsSearch';
import {PolicyNetwork} from '../../src/server/rl/PolicyNetwork';
import {RlGameEnvironment, selectHeuristicAction} from '../../src/server/rl/RlEnvironment';

describe('MctsSearch (Determinized PUCT MCTS)', function() {
  // eslint-disable-next-line no-invalid-this
  this.timeout(15000);

  function advanceToActionPhase(env: RlGameEnvironment): void {
    let guard = 0;
    while (!env.isDone() && env.game.phase !== Phase.ACTION && guard < 100) {
      guard++;
      const activeIdx = env.getActivePlayerIndex();
      const decoded = env.getDecoded();
      const action = selectHeuristicAction(env.players[activeIdx], decoded);
      env.applyAction(action);
    }
  }

  it('determinizes hidden cards while preserving observer hand and card multiset', () => {
    const env = new RlGameEnvironment('mcts_det_test', false);
    env.resetGame(2026, ['MCTS-P1', 'MCTS-P2']);
    advanceToActionPhase(env);

    const observer = env.players[0];
    const opponent = env.players[1];
    const original = env.game.serialize();
    const copy = structuredClone(original);

    const origObserverHand = [...copy.players[0].cardsInHand];
    const origOppHandLen = copy.players[1].cardsInHand.length;
    const origHiddenPool = [...copy.projectDeck.drawPile, ...copy.players[1].cardsInHand].sort();

    let s = 12345;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };

    determinizeSerializedGame(copy, observer.id, rand);

    // Observer hand untouched
    expect(copy.players[0].cardsInHand).to.deep.equal(origObserverHand);
    // Opponent hand size preserved
    expect(copy.players[1].cardsInHand.length).to.eq(origOppHandLen);
    // Total unseen card multiset conserved
    const newHiddenPool = [...copy.projectDeck.drawPile, ...copy.players[1].cardsInHand].sort();
    expect(newHiddenPool).to.deep.equal(origHiddenPool);
    // Original opponent hand object not mutated
    expect(opponent.cardsInHand.length).to.eq(origOppHandLen);
  });

  it('runs determinized PUCT simulations in ACTION phase without mutating root game or writing to DB', () => {
    const db = Database.getInstance();
    let dbWriteCount = 0;
    const origSaveGame = db.saveGame.bind(db);
    db.saveGame = async (game) => {
      dbWriteCount++;
      return origSaveGame(game);
    };

    try {
      const env = new RlGameEnvironment('mcts_search_test', false);
      env.resetGame(999, ['MCTS-Red', 'MCTS-Blue']);
      advanceToActionPhase(env);
      expect(env.game.phase).to.eq(Phase.ACTION);

      const activeIdx = env.getActivePlayerIndex();
      const player = env.players[activeIdx];
      const staging = env.stagings[activeIdx];
      const decoded = decodeActionSpace(player, staging);
      const legalIndices = decoded.mask
        .map((ok, idx) => (ok ? idx : -1))
        .filter((idx) => idx >= 0);

      const beforeAge = env.game.gameAge;
      const beforeMc = player.megaCredits;
      const beforeGen = env.game.generation;

      const net = new PolicyNetwork();
      const mcts = new MctsSearch(net, {
        maxSimulations: 12,
        timeBudgetMs: 5000,
        maxDepth: 6,
        seed: 42,
      });

      const result = mcts.search(env.game, player, staging, decoded);

      expect(legalIndices).to.include(result.actionIndex);
      expect(result.simulationsRun).to.be.greaterThan(0);
      expect(result.usedFallback).to.be.false;
      expect(result.winProbability).to.be.within(0, 1);
      expect(result.topActions.length).to.be.greaterThan(0);
      expect(result.allActions.length).to.eq(legalIndices.length);

      const totalVisits = result.allActions.reduce((acc, a) => acc + a.visits, 0);
      expect(totalVisits).to.eq(result.simulationsRun);

      // Root game state must not be mutated by search
      expect(env.game.gameAge).to.eq(beforeAge);
      expect(player.megaCredits).to.eq(beforeMc);
      expect(env.game.generation).to.eq(beforeGen);
      expect(dbWriteCount).to.eq(0);
    } finally {
      db.saveGame = origSaveGame;
    }
  });

  it('integrates mcts policy with AgentManager name inference and turn stepping', () => {
    expect(AgentManager.inferPolicyFromPlayerName('[mcts] Alpha')).to.eq('mcts');
    expect(AgentManager.inferPolicyFromPlayerName('mcts-bot')).to.eq('mcts');

    const env = new RlGameEnvironment('mcts_agent_mgr_test', false);
    env.resetGame(321, ['MCTS-Red', 'Heuristic-Blue']);
    advanceToActionPhase(env);

    const manager = AgentManager.getInstance();
    // Temporarily use a fast simulation count for the unit test
    const origMaxSims = manager.mctsSearch.config.maxSimulations;
    const origBudget = manager.mctsSearch.config.timeBudgetMs;
    manager.mctsSearch.config.maxSimulations = 6;
    manager.mctsSearch.config.timeBudgetMs = 2000;

    try {
      const cfg = manager.registerGame(
        env.game,
        [
          {playerId: env.players[0].id, policyType: 'mcts'},
          {playerId: env.players[1].id, policyType: 'mcts'},
        ],
        {mode: 'ai_vs_ai', paused: true},
      );

      const stepped = manager.stepOneAiTurnInGame(env.game, cfg);
      expect(stepped).to.be.true;
      expect(cfg.lastDecision).to.not.be.undefined;
      expect(cfg.lastDecision!.policyType).to.eq('mcts');
      expect(cfg.lastDecision!.availableMoves.length).to.be.greaterThan(0);

      manager.managedGames.delete(env.game.id);
    } finally {
      manager.mctsSearch.config.maxSimulations = origMaxSims;
      manager.mctsSearch.config.timeBudgetMs = origBudget;
    }
  });
});
