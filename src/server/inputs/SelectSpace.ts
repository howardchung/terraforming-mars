import {Message} from '../../common/logs/Message';
import {Space} from '../boards/Space';
import {InputResponse, isSelectSpaceResponse, SelectSpaceResponse} from '../../common/inputs/InputResponse';
import {SelectSpaceModel} from '../../common/models/PlayerInputModel';
import {BasePlayerInput} from '../PlayerInput';
import {InputError} from './InputError';
import { IPlayer } from '../IPlayer';
import { Random } from '@/common/utils/Random';

export class SelectSpace extends BasePlayerInput<Space> {
  constructor(
    title: string | Message,
    public spaces: ReadonlyArray<Space>) {
    super('space', title);
    if (spaces.length === 0) {
      throw new InputError('No available spaces');
    }
  }

  public override toModel(): SelectSpaceModel {
    return {
      title: this.title,
      buttonLabel: this.buttonLabel,
      type: 'space',
      spaces: this.spaces.map((space) => space.id),
    };
  }

  public process(input: InputResponse) {
    if (!isSelectSpaceResponse(input)) {
      throw new InputError('Not a valid SelectSpaceResponse');
    }
    const space = this.spaces.find((space) => space.id === input.spaceId);
    if (space === undefined) {
      throw new InputError('Space not available');
    }
    return this.cb(space);
  }

  public getActionSpace(_p: IPlayer) {
    return this.spaces.map(sp => ((typeof this.title === 'string') ? this.title : this.title?.message) + ' ' + sp.id);
  }

  public agent(algo: AgentAlgo, _p: IPlayer, rand: Random): SelectSpaceResponse {
    let index = 0;
    if (algo === 'random') {
      index = rand.nextInt(this.spaces.length);
    }
    return { type: 'space', spaceId: this.spaces[index].id };
  }
}
