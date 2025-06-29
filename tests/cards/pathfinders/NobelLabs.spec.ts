import {expect} from 'chai';
import {NobelLabs} from '../../../src/server/cards/pathfinders/NobelLabs';
import {IGame} from '../../../src/server/IGame';
import {TestPlayer} from '../../TestPlayer';
import {testGame} from '../../TestGame';
import {IProjectCard} from '../../../src/server/cards/IProjectCard';
import {RegolithEaters} from '../../../src/server/cards/base/RegolithEaters';
import {SearchForLife} from '../../../src/server/cards/base/SearchForLife';
import {FloatingHabs} from '../../../src/server/cards/venusNext/FloatingHabs';
import {MartianCulture} from '../../../src/server/cards/pathfinders/MartianCulture';
import {SelectCard} from '../../../src/server/inputs/SelectCard';
import {cast} from '../../TestingUtils';

describe('NobelLabs', () => {
  let card: NobelLabs;
  let player: TestPlayer;
  let game: IGame;
  let floater: IProjectCard;
  let microbe: IProjectCard;
  let data: IProjectCard;
  let science: IProjectCard;

  beforeEach(() => {
    card = new NobelLabs();
    [game, player] = testGame(1);

    floater = new FloatingHabs();
    microbe = new RegolithEaters();
    data = new MartianCulture();
    science = new SearchForLife();
  });

  it('canPlay', () => {
    player.megaCredits = card.cost;
    player.tagsForTest = {science: 3};
    expect(player.canPlay(card)).is.false;
    player.tagsForTest = {science: 4};
    expect(player.canPlay(card)).is.true;
  });

  it('canAct', () => {
    expect(card.canAct(player)).is.false;
    player.playedCards.set(science);
    expect(card.canAct(player)).is.false;
    player.playedCards.set(data);
    expect(card.canAct(player)).is.true;
    player.playedCards.set(microbe);
    expect(card.canAct(player)).is.true;
    player.playedCards.set(floater);
    expect(card.canAct(player)).is.true;
  });

  it('action', () => {
    player.playedCards.push(floater, data, microbe, science);

    card.action(player);

    const selectCard = cast(game.deferredActions.pop()?.execute(), SelectCard);
    expect(selectCard.cards).to.have.members([floater, microbe, data]);

    selectCard.cb([floater]);
    expect(floater.resourceCount).eq(2);
    selectCard.cb([microbe]);
    expect(microbe.resourceCount).eq(2);
    selectCard.cb([data]);
    expect(data.resourceCount).eq(2);
  });
});
