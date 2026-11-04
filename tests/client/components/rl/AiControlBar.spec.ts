import {shallowMount} from '@vue/test-utils';
import {expect} from 'chai';
import {globalConfig} from '../getLocalVue';
import AiControlBar from '@/client/components/rl/AiControlBar.vue';

describe('AiControlBar', () => {
  it('mounts without errors and stays hidden when no AI is present', () => {
    const wrapper = shallowMount(AiControlBar, {
      ...globalConfig,
      props: {
        participantId: 'p-test-player-id',
        isSpectator: false,
      },
    });
    expect(wrapper.exists()).to.be.true;
    expect((wrapper.vm as any).isVisible).to.be.false;
    wrapper.unmount();
  });

  it('becomes visible when aiState has AI players', async () => {
    const wrapper = shallowMount(AiControlBar, {
      ...globalConfig,
      props: {
        participantId: 's-test-spectator-id',
        isSpectator: true,
      },
    });
    (wrapper.vm as any).aiState = {
      gameId: 'g-test-game',
      hasAi: true,
      paused: false,
      delayMs: 250,
      aiPlayers: {'p-ai-1': 'rl'},
      lastDecision: {
        timestamp: 1000,
        playerId: 'p-ai-1',
        playerName: 'RL Agent',
        playerColor: 'red',
        agentType: 'rl',
        chosenAction: 1,
        chosenLabel: 'Pass / End Turn',
        valueEstimate: 0.42,
        topCandidates: [{actionIndex: 1, label: 'Pass / End Turn', probability: 0.85}],
      },
      players: [
        {id: 'p-ai-1', name: 'RL Agent', color: 'red', isAi: true, agentType: 'rl', valueEstimate: 0.42, winProbability: 0.716},
        {id: 'p-ai-2', name: 'Heuristic AI', color: 'blue', isAi: true, agentType: 'heuristic', valueEstimate: -0.25, winProbability: 0.366},
      ],
    };
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).isVisible).to.be.true;
    expect(wrapper.text()).to.include('Agent vs Agent Match');
    expect(wrapper.text()).to.include('Pass / End Turn');
    expect(wrapper.text()).to.include('Estimated Chance of Winning:');
    expect(wrapper.text()).to.include('71.6%');
    expect(wrapper.text()).to.include('36.6%');
    wrapper.unmount();
  });

  it('renders decision history with available moves and assigned scores', async () => {
    const wrapper = shallowMount(AiControlBar, {
      ...globalConfig,
      props: {
        participantId: 's-test-spectator-id',
        isSpectator: true,
      },
    });
    const decisionHistory = [
      {
        step: 1,
        turn: 1,
        generation: 1,
        timestamp: 1000,
        playerId: 'p-ai-1',
        playerName: 'RL Agent',
        playerColor: 'red',
        agentType: 'rl',
        promptTitle: 'Take Action',
        chosenAction: 10,
        chosenLabel: 'Standard Project: Greenery (23 M€)',
        valueEstimate: 0.25,
        winProbability: 0.634,
        topCandidates: [{actionIndex: 10, label: 'Standard Project: Greenery (23 M€)', probability: 0.75}],
        availableMoves: [
          {actionIndex: 10, label: 'Standard Project: Greenery (23 M€)', probability: 75.0, score: 2.45, isChosen: true},
          {actionIndex: 11, label: 'Standard Project: Asteroid (14 M€)', probability: 15.0, score: 0.82, isChosen: false},
          {actionIndex: 1, label: 'Pass / End Turn', probability: 10.0, score: -0.15, isChosen: false},
        ],
      },
      {
        step: 2,
        turn: 2,
        generation: 1,
        timestamp: 2000,
        playerId: 'p-ai-2',
        playerName: 'Heuristic AI',
        playerColor: 'blue',
        agentType: 'heuristic',
        promptTitle: 'Take Action',
        chosenAction: 20,
        chosenLabel: 'Convert 8 Plants -> Greenery',
        valueEstimate: -0.10,
        winProbability: 0.445,
        topCandidates: [{actionIndex: 20, label: 'Convert 8 Plants -> Greenery', probability: 1.0}],
        availableMoves: [
          {actionIndex: 20, label: 'Convert 8 Plants -> Greenery', probability: 100.0, score: 85.0, isChosen: true},
          {actionIndex: 1, label: 'Pass / End Turn', probability: 0.0, score: 1.0, isChosen: false},
        ],
      },
    ];

    (wrapper.vm as any).aiState = {
      gameId: 'g-test-game',
      hasAi: true,
      paused: false,
      delayMs: 250,
      aiPlayers: {'p-ai-1': 'rl', 'p-ai-2': 'heuristic'},
      lastDecision: decisionHistory[1],
      decisionHistory,
      players: [
        {id: 'p-ai-1', name: 'RL Agent', color: 'red', isAi: true, agentType: 'rl'},
        {id: 'p-ai-2', name: 'Heuristic AI', color: 'blue', isAi: true, agentType: 'heuristic'},
      ],
    };
    await wrapper.vm.$nextTick();

    // Verify Decision History button shows count
    expect(wrapper.text()).to.include('Decision History (2)');

    // Inspector shows latest decision
    expect(wrapper.text()).to.include('Turn #2');
    expect(wrapper.text()).to.include('Convert 8 Plants -> Greenery');

    // Step back to Turn #1
    (wrapper.vm as any).prevDecision();
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).selectedHistoryIndex).to.eq(0);
    expect((wrapper.vm as any).displayedDecision.step).to.eq(1);
    expect((wrapper.vm as any).displayedDecision.chosenLabel).to.eq('Standard Project: Greenery (23 M€)');
    expect(wrapper.text()).to.include('Standard Project: Greenery (23 M€)');
    expect(wrapper.text()).to.include('Viewing Past Turn');

    // Return to live decision
    (wrapper.vm as any).selectLatestDecision();
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).selectedHistoryIndex).to.eq(-1);
    expect((wrapper.vm as any).displayedDecision.step).to.eq(2);

    // Open Full Decision History modal
    (wrapper.vm as any).toggleHistoryModal();
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).showHistoryModal).to.be.true;

    // Check available moves for turn 1
    (wrapper.vm as any).selectDecision(0);
    await wrapper.vm.$nextTick();
    const moves = (wrapper.vm as any).displayedAvailableMoves;
    expect(moves.length).to.eq(3);
    expect(moves[0].label).to.eq('Standard Project: Greenery (23 M€)');
    expect(moves[0].score).to.eq(2.45);
    expect(moves[0].isChosen).to.be.true;
    expect(moves[1].label).to.eq('Standard Project: Asteroid (14 M€)');
    expect(moves[1].score).to.eq(0.82);

    // Filter available moves by search query
    (wrapper.vm as any).historySearchQuery = 'asteroid';
    expect((wrapper.vm as any).displayedAvailableMoves.length).to.eq(1);
    expect((wrapper.vm as any).displayedAvailableMoves[0].label).to.include('Asteroid');

    wrapper.unmount();
  });
});
