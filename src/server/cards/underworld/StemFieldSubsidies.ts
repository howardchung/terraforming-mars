import {CardName} from '../../../common/cards/CardName';
import {CardRenderer} from '../render/CardRenderer';
import {Tag} from '../../../common/cards/Tag';
import {Card} from '../Card';
import {IProjectCard} from '../IProjectCard';
import {CardResource} from '../../../common/CardResource';
import {CardType} from '../../../common/cards/CardType';
import {IPlayer} from '../../IPlayer';
import {IdentifySpacesDeferred} from '../../underworld/IdentifySpacesDeferred';
import {AddResourcesToCard} from '../../deferredActions/AddResourcesToCard';
import {ICard} from '../ICard';

export class StemFieldSubsidies extends Card implements IProjectCard {
  constructor() {
    super({
      type: CardType.ACTIVE,
      name: CardName.STEM_FIELD_SUBSIDIES,
      cost: 10,
      tags: [Tag.SCIENCE],
      victoryPoints: {resourcesHere: {}, per: 3},
      resourceType: CardResource.DATA,

      metadata: {
        cardNumber: 'U43',
        renderData: CardRenderer.builder((b) => {
          b.effect('Whenever you play a science tag (including this), add 1 data to ANY card and identify an underground resource.',
            (eb) => eb.tag(Tag.SCIENCE).startEffect.resource(CardResource.DATA).asterix().identify(1));
        }),
        description: '1 VP per 3 data resources on this card.',
      },
    });
  }

  public onCardPlayed(player: IPlayer, card: ICard) {
    const count = player.tags.cardTagCount(card, Tag.SCIENCE);
    this.onScienceTagAdded(player, count);
  }
  public onColonyAddedToLeavitt(player: IPlayer): void {
    this.onScienceTagAdded(player, 1);
  }
  public onScienceTagAdded(player: IPlayer, count: number) {
    if (count > 0) {
      player.game.defer(new IdentifySpacesDeferred(player, count));
    }
    for (let idx = 0; idx < count; idx++) {
      player.game.defer(new AddResourcesToCard(player, CardResource.DATA));
    }
  }
}
