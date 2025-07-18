import {expect} from 'chai';
import {testGame} from '../../TestGame';
import {TestPlayer} from '../../TestPlayer';
import {Predators} from '../../../src/server/cards/base/Predators';
import {ResearchOutpost} from '../../../src/server/cards/base/ResearchOutpost';
import {Aridor} from '../../../src/server/cards/colonies/Aridor';
import {IGame} from '../../../src/server/IGame';
import {Venus} from '../../../src/server/cards/community/Venus';
import {Celestic} from '../../../src/server/cards/venusNext/Celestic';
import {Tag} from '../../../src/common/cards/Tag';
import {Player} from '../../../src/server/Player';
import {cast, runAllActions} from '../../TestingUtils';
import {SelectColony} from '../../../src/server/inputs/SelectColony';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {ColonyName} from '../../../src/common/colonies/ColonyName';
import {GHGProducingBacteria} from '../../../src/server/cards/base/GHGProducingBacteria';
import {Leavitt} from '../../../src/server/cards/community/Leavitt';

let card: Aridor;
let game: IGame;
let player: TestPlayer;
let player2: TestPlayer;

describe('Aridor', () => {
  beforeEach(() => {
    card = new Aridor();
    // 2-player so as to not bother with pre-game action that drops a colony.
    [game, player, player2] = testGame(2, {coloniesExtension: true});
  });

  it('Should play', () => {
    cast(card.play(player), undefined);
    player.corporations.push(card);

    // Predators has an Animal tag
    player.playCard(new Predators());
    expect(player.production.megacredits).to.eq(1);

    // Research Outpost has a Science tag, City tag, and Building tag
    player2.playCard(new ResearchOutpost());
    expect(player2.production.megacredits).to.eq(0);
    player.playCard(new ResearchOutpost());
    expect(player.production.megacredits).to.eq(4);

    // GHG Producing Bacteria has a Science tag and a Microbe tag.
    player.playCard(new GHGProducingBacteria());
    expect(player.production.megacredits).to.eq(5);
  });

  // A test that directly calls initialAction is also good, but this
  // is extra due to a bug #3882
  it('initialAction from input', () => {
    player.deferInitialAction(card);
    runAllActions(game);

    const colonyInPlay = game.colonies[0];
    const discardedColony = game.discardedColonies[0];

    expect(game.colonies).does.not.include(discardedColony);
    expect(game.colonies).has.length(5);

    expect(() => player.process(<InputResponse>{})).to.throw(/Not a valid SelectColonyResponse/);
    expect(() => player.process({type: 'colony', colonyName: undefined as unknown as ColonyName})).to.throw(/No colony selected/);
    expect(() => player.process({type: 'colony', colonyName: colonyInPlay.name})).to.throw(/Colony .* not found/);

    player.process({type: 'colony', colonyName: discardedColony.name});

    expect(game.colonies).includes(discardedColony);
    expect(game.colonies).has.length(6);
  });


  it('initialAction - chooses Venus which cannot be activated', () => {
    const venus = new Venus();
    game.discardedColonies.push(venus);
    player.deferInitialAction(card);
    runAllActions(game);
    const playerInput = cast(player.popWaitingFor(), SelectColony);
    expect(playerInput?.colonies).contains(venus);

    playerInput?.cb(venus);

    expect(game.colonies).includes(venus);
    expect(venus.isActive).is.false;
  });

  it('initialAction - chooses Venus, which is activated', () => {
    player2.corporations.push(new Celestic());
    const venus = new Venus();
    game.discardedColonies.push(venus);
    player.deferInitialAction(card);
    runAllActions(game);
    const playerInput = cast(player.popWaitingFor(), SelectColony);
    expect(playerInput?.colonies).contains(venus);

    playerInput?.cb(venus);

    expect(game.colonies).includes(venus);
    expect(venus.isActive).is.true;
  });

  it('serialization test for Player with Aridor', () => {
    card.play(player);
    player.corporations.push(card);
    player.playCard(new Predators());
    player2.playCard(new ResearchOutpost());
    player.playCard(new ResearchOutpost());

    expect(Array.from(card.allTags)).deep.eq([Tag.ANIMAL, Tag.SCIENCE, Tag.CITY, Tag.BUILDING]);

    const serializedPlayer = player.serialize();

    expect(serializedPlayer.playedCards?.[0].allTags).deep.eq([Tag.ANIMAL, Tag.SCIENCE, Tag.CITY, Tag.BUILDING]);

    const reserializedPlayer = Player.deserialize(serializedPlayer);
    const reserializedAridor = cast(reserializedPlayer.playedCards.corporations()[0], Aridor);

    expect(Array.from(reserializedAridor.allTags)).deep.eq([Tag.ANIMAL, Tag.SCIENCE, Tag.CITY, Tag.BUILDING]);
  });

  it('Compatible with Leavitt #6349', () => {
    player.corporations.push(card);

    expect(player.production.megacredits).eq(0);

    const leavitt = new Leavitt();
    leavitt.addColony(player);

    runAllActions(game);
    expect(player.production.megacredits).eq(1);
  });
});
