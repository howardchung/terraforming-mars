import {CardName} from '../../../common/cards/CardName';
import {IPlayer} from '../../IPlayer';
import {PlayerInput} from '../../PlayerInput';
import {CardRenderer} from '../render/CardRenderer';
import {CeoCard} from './CeoCard';
import {MAX_COLONY_TRACK_POSITION} from '../../../common/constants';
import {OrOptions} from '../../inputs/OrOptions';
import {SelectOption} from '../../inputs/SelectOption';
import {ColoniesHandler} from '../../colonies/ColoniesHandler';
import {Resource} from '../../../common/Resource';
import {ICeoCard} from './ICeoCard';

export class Naomi extends CeoCard implements ICeoCard {
  constructor() {
    super({
      name: CardName.NAOMI,
      metadata: {
        cardNumber: 'L14',
        renderData: CardRenderer.builder((b) => {
          b.br;
          b.effect('When you build a colony, gain 2 energy and 3 M€.', (eb) => {
            eb.colonies(1).startEffect.energy(2).megacredits(3);
          });
          b.br.br.br;
          b.opgArrow().text('SET ALL').colonies(1).asterix();
        }),
        description: 'Once per game, move each colony tile track marker to its highest or lowest value.',
      },
    });
  }

  public override canAct(player: IPlayer): boolean {
    return super.canAct(player) && ColoniesHandler.tradeableColonies(player.game).length > 0;
  }

  public action(player: IPlayer): PlayerInput | undefined {
    this.isDisabled = true;
    const game = player.game;
    const activeColonies = game.colonies.filter((colony) => colony.isActive);

    activeColonies.forEach((colony) => {
      player.defer(() => new OrOptions(
        new SelectOption('Move the ' + colony.name + ' tile track marker to its HIGHEST value').andThen(() => {
          colony.trackPosition = MAX_COLONY_TRACK_POSITION;
          return undefined;
        }),
        new SelectOption('Move the ' + colony.name + ' tile track marker to its LOWEST value').andThen(() => {
          colony.trackPosition = colony.colonies.length;
          return undefined;
        }),
      ));
    });
    return undefined;
  }

  public onColonyAddedByAnyPlayer(cardOwner: IPlayer, colonyOwner: IPlayer) {
    if (colonyOwner === cardOwner) {
      cardOwner.stock.add(Resource.ENERGY, 2, {log: true});
      cardOwner.stock.add(Resource.MEGACREDITS, 3, {log: true});
    }
  }
}
