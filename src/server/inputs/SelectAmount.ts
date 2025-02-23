import {Message} from '../../common/logs/Message';
import {BasePlayerInput} from '../PlayerInput';
import {InputResponse, isSelectAmountResponse, SelectAmountResponse} from '../../common/inputs/InputResponse';
import {SelectAmountModel} from '../../common/models/PlayerInputModel';
import {InputError} from './InputError';
import { IPlayer } from '../IPlayer';
import { Random } from '@/common/utils/Random';

export class SelectAmount extends BasePlayerInput<number> {
  public selected: number = -1;

  constructor(
    title: string | Message,
    buttonLabel: string = 'Save',
    public min: number,
    public max: number,
    public maxByDefault?: boolean,
  ) {
    super('amount', title);
    this.buttonLabel = buttonLabel;
  }

  public toModel(): SelectAmountModel {
    return {
      title: this.title,
      buttonLabel: this.buttonLabel,
      type: 'amount',
      max: this.max,
      min: this.min,
      maxByDefault: this.maxByDefault ?? false,
    };
  }

  public process(input: InputResponse) {
    if (!isSelectAmountResponse(input)) {
      throw new InputError('Not a valid SelectAmountResponse');
    }
    if (isNaN(input.amount)) {
      throw new InputError('Amount is not a number');
    }
    if (input.amount > this.max) {
      throw new InputError('Amount provided too high (max ' + String(this.max) + ')');
    }
    if (input.amount < this.min) {
      throw new InputError('Amount provided too low (min ' + String(this.min) + ')');
    }
    this.selected = input.amount;
    return this.cb(input.amount);
  }
  public getActionSpace(_p: IPlayer) {
    const output = [];
    for (let i = this.min; i <= this.max; i++) {
      output.push(this.title + ' ' + i);
    }
    return output;
  }

  public agent(algo: AgentAlgo, _p: IPlayer, rand: Random): SelectAmountResponse {
    let amount = this.max;
    if (algo === 'random') {
      const range = this.max - this.min;
      amount = rand.nextInt(range) + this.min;
    }
    return { type: 'amount', amount };
  }
}
