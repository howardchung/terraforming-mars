import {CorporationCard} from '../corporation/CorporationCard';
import {IPlayer} from '../../IPlayer';
import {Tag} from '../../../common/cards/Tag';
import {CardName} from '../../../common/cards/CardName';
import {CardType} from '../../../common/cards/CardType';
import {IProjectCard} from '../IProjectCard';
import {SelectCard} from '../../inputs/SelectCard';
import {SelectPaymentDeferred} from '../../deferredActions/SelectPaymentDeferred';
import {CardRenderer} from '../render/CardRenderer';
import {Size} from '../../../common/cards/render/Size';
import {MoonExpansion} from '../../moon/MoonExpansion';
import {all} from '../Options';
import {SpecialDesignProxy} from './SpecialDesignProxy';
import {ICorporationCard} from '../corporation/ICorporationCard';

export class Playwrights extends CorporationCard implements ICorporationCard {
  constructor() {
    super({
      name: CardName.PLAYWRIGHTS,
      tags: [Tag.POWER],
      startingMegaCredits: 38,

      behavior: {
        production: {energy: 1},
      },

      metadata: {
        cardNumber: 'R40',
        description: 'You start with 38 M€ and 1 energy production.',
        renderData: CardRenderer.builder((b) => {
          b.br.br;
          b.megacredits(38).production((pb) => pb.energy(1));
          b.corpBox('action', (cb) => {
            cb.action('Replay a played event from any player (INCLUDING events that place special tiles) by paying its cost ONLY in M€ (discounts and rebates apply), then REMOVE IT FROM PLAY.', (eb) => {
              eb.megacredits(1, {text: '?'}).startAction;
              eb.text('replay', Size.SMALL, true);
              eb.nbsp.cards(1, {all, secondaryTag: Tag.EVENT});
            });
          });
        }),
      },
    });
  }

  // For Project Inspection
  private checkLoops = 0;

  public canAct(player: IPlayer): boolean {
    const replayableEvents = this.getReplayableEvents(player);
    return replayableEvents.length > 0;
  }

  public action(player: IPlayer): SelectCard<IProjectCard> | undefined {
    const players = player.game.getPlayers();
    const replayableEvents = this.getReplayableEvents(player);

    return new SelectCard<IProjectCard>(
      'Select event card to replay at cost in M€ and remove from play', 'Select', replayableEvents, {played: false})
      .andThen(
        ([card]) => {
          const selectedCard: IProjectCard = card;

          players.forEach((p) => {
            if (p.playedCards.get(selectedCard.name)) {
              p.playedCards.remove(card);
            }
          });

          const cost = player.getCardCost(selectedCard);
          player.game.defer(new SelectPaymentDeferred(player, cost, {title: 'Select how to pay to replay the event'}))
            .andThen(() => {
              player.playCard(selectedCard, undefined, 'nothing'); // Play the card but don't add it to played cards
              player.removedFromPlayCards.push(selectedCard); // Remove card from the game
              if (selectedCard.name === CardName.SPECIAL_DESIGN) {
                player.playedCards.push(new SpecialDesignProxy());
              } else if (selectedCard.name === CardName.LAW_SUIT) {
              /*
               * If the card played is Law Suit we need to remove it from the newly sued player's played cards.
               * Needs to be deferred to happen after Law Suit's `play()` method.
               */
                player.defer(() => {
                  player.game.getPlayers().some((p) => {
                    const card = p.playedCards.last();
                    if (card?.name === selectedCard.name) {
                      p.playedCards.remove(card);
                      return true;
                    }
                    return false;
                  });
                  return undefined;
                });
              }
            });
          return undefined;
        },
      );
  }

  public getCheckLoops(): number {
    return this.checkLoops;
  }

  private getReplayableEvents(player: IPlayer): Array<IProjectCard> {
    const playedEvents : IProjectCard[] = [];

    this.checkLoops++;
    try {
      player.game.getPlayers().forEach((p) => {
        for (const card of p.playedCards.projects()) {
          // Special case Price Wars, which is not easy to work with.
          if (card.name === CardName.PRICE_WARS) {
            continue;
          }
          if (card.type !== CardType.EVENT) {
            continue;
          }

          const canAffordOptions = {
            cost: player.getCardCost(card),
            reserveUnits: MoonExpansion.adjustedReserveCosts(player, card),
          };
          // Can player.canPlay(card) replace this?
          if (player.canAfford(canAffordOptions) && card.canPlay(player, canAffordOptions)) {
            playedEvents.push(card);
          }
        }
      });
    } finally {
      this.checkLoops--;
    }

    return playedEvents;
  }
}
