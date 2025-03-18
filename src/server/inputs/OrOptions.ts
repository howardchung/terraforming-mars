import {PlayerInput} from '../PlayerInput';
import {InputResponse, isOrOptionsResponse, OrOptionsResponse} from '../../common/inputs/InputResponse';
import {IPlayer} from '../IPlayer';
import {OrOptionsModel} from '../../common/models/PlayerInputModel';
import {OptionsInput} from './OptionsPlayerInput';
import {InputError} from './InputError';
import { Random } from '@/common/utils/Random';
import { SelectCard } from './SelectCard';

export class OrOptions extends OptionsInput<undefined> {
  constructor(...options: Array<PlayerInput>) {
    super('or', 'Select one option', options);
  }

  public toModel(player: IPlayer): OrOptionsModel {
    const initialIdx = this.options.findIndex((option) => option.eligibleForDefault !== false);
    const model: OrOptionsModel = {
      title: this.title,
      buttonLabel: this.buttonLabel,
      type: 'or',
      options: this.options.map((option) => option.toModel(player)),
    };
    if (initialIdx > -1) {
      model.initialIdx = initialIdx;
    }
    return model;
  }

  public process(input: InputResponse, player: IPlayer) {
    if (!isOrOptionsResponse(input)) {
      throw new InputError('Not a valid OrOptionsResponse');
    }
    if (this.options.length <= input.index) {
      throw new InputError('Invalid index');
    }
    player.runInput(input.response, this.options[input.index]);
    return this.cb(undefined);
  }

  private getActionable(p: IPlayer): [number, PlayerInput][] {
    const output: [number, PlayerInput][] = [];
    this.options.forEach((opt, i: number) => {
      if (opt instanceof SelectCard && opt.type === 'card' && opt.title === 'Standard projects' && opt.toModel(p).cards.every(c => c.isDisabled)) {
        // Standard projects are always present in the list, but marked disabled in config if can't be performed
        // If we detect there are no playable cards, remove the option from the list
        return;
      }
      // keep the original index
      output.push([i, opt]);
    });
    return output;
  }

  public getFirst(algo: AgentAlgo, p: IPlayer, rand: Random) {
    const first = this.getActionable(p)[0];
    return { index: first?.[0], response: (first?.[1] as any)?.agent(algo, p, rand) };
  }

  public getRandom(algo: AgentAlgo, p: IPlayer, rand: Random) {
    const arr = this.getActionable(p);
    const first = arr[rand.nextInt(arr.length)];
    return { index: first?.[0], response: (first?.[1] as any)?.agent(algo, p, rand) };
  }

  public agent(algo: AgentAlgo, p: IPlayer, rand: Random) {
    // choice may be another OrOptions, in that case the response should be nested
    // response should look like {"type":"or","index":1,"response":{"type":"or","index":0,"response":{"type":"option"}}}
    let choice;
    if (algo === 'random') {
      choice = this.getRandom(algo, p, rand);
    } else {
      // Just pick the first choice
      choice = this.getFirst(algo, p, rand);
    }
    const response: OrOptionsResponse = { type: 'or', ...choice };
    return response;
  }

  public getActionSpace(p: IPlayer) {
    // Return a flat list of all the options available
    // If one of the options has nested values, e.g. play a card, we should return flatten all of those as items
    const arr = this.options.map((opt: any) => opt.getActionSpace(p));
    return arr.flat();
  }

  public reduce(): PlayerInput | undefined {
    if (this.options.length === 0) {
      return undefined;
    }
    if (this.options.length === 1) {
      return this.options[0].cb();
    }
    return this;
  }
}
