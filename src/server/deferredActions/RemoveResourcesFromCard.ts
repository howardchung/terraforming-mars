import {IPlayer} from '../IPlayer';
import {CardResource} from '../../common/CardResource';
import {OrOptions} from '../inputs/OrOptions';
import {SelectCard} from '../inputs/SelectCard';
import {SelectOption} from '../inputs/SelectOption';
import {ICard} from '../cards/ICard';
import {DeferredAction, Priority} from './DeferredAction';
import {Message} from '../../common/logs/Message';
import {UnderworldExpansion} from '../underworld/UnderworldExpansion';

export type Source = 'self' | 'opponents' | 'all';
export type Response = {card: ICard, owner: IPlayer, blocked: boolean}
export class RemoveResourcesFromCard extends DeferredAction<Response> {
  public cardResource: CardResource | undefined;
  public count: number;
  private source: Source;
  private mandatory: boolean;
  private blockable: boolean;
  private title: string | Message;

  public override priority = Priority.ATTACK_OPPONENT;
  constructor(
    player: IPlayer,
    cardResource: CardResource | undefined,
    count: number = 1,
    options?: {
      source?: Source, // default all
      mandatory?: boolean, // default true (Resource must be removed (either it's a cost or the icon is not red-bordered))
      title?: string | Message,
      blockable?: boolean,
    }) {
    super(player, Priority.ATTACK_OPPONENT);
    this.cardResource = cardResource;
    this.count = count;
    this.source = options?.source ?? 'all';
    this.mandatory = options?.mandatory ?? true;
    this.blockable = options?.blockable ?? true;
    this.title = options?.title ?? (`Select card to remove ${count} ${cardResource}(s)`);
    if (this.source === 'self') {
      this.priority = Priority.LOSE_RESOURCE_OR_PRODUCTION;
      if (this.blockable) {
        throw new Error('Cannot block removing resources from self');
      }
    }
  }

  public execute() {
    if (this.source !== 'self' && this.player.game.isSoloMode()) {
      this.player.resolveInsuranceInSoloGame();
      return undefined;
    }

    const cards = RemoveResourcesFromCard.getAvailableTargetCards(this.player, this.cardResource, this.source);

    if (cards.length === 0) {
      return undefined;
    }

    const selectCard = new SelectCard(
      this.title,
      'Remove resource(s)',
      cards,
      {showOwner: true})
      .andThen(([card]) => {
        this.attack(card);
        return undefined;
      });

    if (this.mandatory) {
      if (cards.length === 1) {
        this.attack(cards[0]);
        return undefined;
      }
      return selectCard;
    }

    return new OrOptions(
      selectCard,
      new SelectOption('Do not remove'));
  }

  private attack(card: ICard) {
    const target = this.player.game.getCardPlayerOrThrow(card.name);

    // // TODO(kberg): Consolidate the blockable in mayBlock.
    // if (this.blockable === false) {
    //   target.removeResourceFrom(card, this.count, {removingPlayer: this.player});
    //   this.cb(true);
    //   return;
    // }
    return UnderworldExpansion.maybeBlockAttack(target, this.player, ((proceed) => {
      if (proceed) {
        target.removeResourceFrom(card, this.count, {removingPlayer: this.player});
      }
      this.cb({card: card, owner: target, blocked: proceed});
      return undefined;
    }));
  }

  public static getAvailableTargetCards(player: IPlayer, resourceType: CardResource | undefined, source: Source = 'all'): Array<ICard> {
    const resourceCards: Array<ICard> = [];
    for (const p of player.game.getPlayers()) {
      // Making this a function just to delay calling getCardsWithResources unless it's needed.
      const get = () => p.getCardsWithResources(resourceType).filter((card) => card.protectedResources !== true);
      if (p === player) {
        if (source !== 'opponents') {
          resourceCards.push(...get());
        }
      } else {
        if (source !== 'self') {
          switch (resourceType) {
          case CardResource.ANIMAL:
          case CardResource.MICROBE:
            if (!p.hasProtectedHabitats()) {
              resourceCards.push(...get());
            }
            break;
          default:
            resourceCards.push(...get());
          }
        }
      }
    }
    return resourceCards;
  }
}
