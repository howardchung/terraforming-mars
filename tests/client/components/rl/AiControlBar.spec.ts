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
});
