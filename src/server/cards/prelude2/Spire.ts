import {CorporationCard} from '../corporation/CorporationCard';
import {CardName} from '../../../common/cards/CardName';
import {CardRenderer} from '../render/CardRenderer';
import {CardType} from '../../../common/cards/CardType';
import {IPlayer} from '../../IPlayer';
import {ICard} from '../ICard';
import {Tag} from '../../../common/cards/Tag';
import {digit} from '../Options';
import {SelectCard} from '../../inputs/SelectCard';
import {CardResource} from '../../../common/CardResource';
import {ICorporationCard} from '../corporation/ICorporationCard';

export class Spire extends CorporationCard implements ICorporationCard {
  constructor() {
    super({
      name: CardName.SPIRE,
      tags: [Tag.CITY, Tag.EARTH],
      startingMegaCredits: 50,
      initialActionText: 'Draw 4 cards, then discard 3 cards.',
      resourceType: CardResource.SCIENCE,

      metadata: {
        cardNumber: 'PC05', // Renumber
        renderData: CardRenderer.builder((b) => {
          b.megacredits(50).plus().cards(4, {digit}).minus().cards(3, {digit}).br,
          b.plainText('You start with 50 M€. As your first action, draw 4 cards, ' +
              'then discard 3 cards from your hand.').br;

          b.effect('When you play a card with at least 2 tags. including this, add 1 science resource here.',
            (eb) => eb.emptyTag(2).asterix().startEffect.resource(CardResource.SCIENCE)).br;
          b.effect('When you pay for a standard project, science resources here may be used as 2 M€ each.',
            (eb) => eb.plate('Standard Project').startEffect.resource(CardResource.SCIENCE).equals().megacredits(2)).br;
        }),
      },
    });
  }

  public initialAction(player: IPlayer) {
    player.drawCard(4);
    return new SelectCard('Select 3 cards to discard', 'Discard', player.cardsInHand, {min: 3, max: 3})
      .andThen((cards) => {
        for (const card of cards) {
          player.discardCardFromHand(card);
        }
        return undefined;
      });
  }

  public onCardPlayedForCorps(player: IPlayer, card: ICard) {
    const count = card.tags.length + (card.type === CardType.EVENT ? 1 : 0);
    if (count >= 2) {
      player.addResourceTo(this, {qty: 1, log: true});
    }
  }
}
