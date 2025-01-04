import {Message} from '../../common/logs/Message';
import {BasePlayerInput} from '../PlayerInput';
import {IPlayer} from '../IPlayer';
import {InputResponse, isSelectPlayerResponse, SelectPlayerResponse} from '../../common/inputs/InputResponse';
import {SelectPlayerModel} from '../../common/models/PlayerInputModel';
import {InputError} from './InputError';
import { Random } from '@/common/utils/Random';

export class SelectPlayer extends BasePlayerInput<IPlayer> {
  constructor(public players: ReadonlyArray<IPlayer>, title: string | Message, buttonLabel: string = 'Save') {
    super('player', title);
    this.buttonLabel = buttonLabel;
  }

  public override toModel(): SelectPlayerModel {
    return {
      title: this.title,
      buttonLabel: this.buttonLabel,
      type: 'player',
      players: this.players.map((player) => player.color),
    };
  }

  public process(input: InputResponse) {
    if (!isSelectPlayerResponse(input)) {
      throw new InputError('Not a valid SelectPlayerResponse');
    }
    const foundPlayer = this.players.find((player) => player.color === input.player);
    if (foundPlayer === undefined) {
      throw new InputError('Player not available');
    }
    return this.cb(foundPlayer);
  }

  public getActionSpace() {
    return this.players.map(p => this.title + ' ' + p.id);
  }

  public agent(algo: AgentAlgo, _p: IPlayer, rand: Random): SelectPlayerResponse {
    let index = 0;
    if (algo === 'random') {
      index = rand.nextInt(this.players.length);
    }
    return { type: 'player', player: this.players[index].color };
  }
}
