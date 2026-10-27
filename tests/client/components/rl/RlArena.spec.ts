import {shallowMount} from '@vue/test-utils';
import {expect} from 'chai';
import {globalConfig} from '../getLocalVue';
import RlArena from '@/client/components/rl/RlArena.vue';

describe('RlArena', () => {
  it('mounts without errors and renders arena and parallel training sections', () => {
    const wrapper = shallowMount(RlArena, {
      ...globalConfig,
    });
    expect(wrapper.exists()).to.be.true;
    expect(wrapper.text()).to.include('RL AI Arena');
    expect(wrapper.text()).to.include('Play Against the AI Agent');
    expect(wrapper.text()).to.include('Start Agent vs Agent Match');
    expect(wrapper.text()).to.include('Parallel Workers');
    expect(wrapper.text()).to.include('Envs/Worker');
    expect(wrapper.text()).to.include('8 Parallel Games');
    expect(wrapper.text()).to.include('Start Parallel Training');
    wrapper.unmount();
  });
});
