import {expect} from 'chai';
import {IGame} from '../../../src/server/IGame';
import {testGame} from '../../TestGame';
import {MoonData} from '../../../src/server/moon/MoonData';
import {MoonExpansion} from '../../../src/server/moon/MoonExpansion';
import {cast} from '../../TestingUtils';
import {TestPlayer} from '../../TestPlayer';
import {LunaTrainStation} from '../../../src/server/cards/moon/LunaTrainStation';
import {TileType} from '../../../src/common/TileType';
import {PlaceSpecialMoonTile} from '../../../src/server/moon/PlaceSpecialMoonTile';

describe('LunaTrainStation', () => {
  let game: IGame;
  let player: TestPlayer;
  let moonData: MoonData;
  let card: LunaTrainStation;

  beforeEach(() => {
    [game, player] = testGame(1, {moonExpansion: true});
    moonData = MoonExpansion.moonData(game);
    card = new LunaTrainStation();
  });

  it('can play', () => {
    player.cardsInHand = [card];
    player.megaCredits = card.cost;

    player.steel = 2;
    moonData.logisticRate = 5;
    expect(player.getPlayableCards()).does.include(card);

    player.steel = 2;
    moonData.logisticRate = 4;
    expect(player.getPlayableCards()).does.not.include(card);

    player.steel = 1;
    moonData.logisticRate = 5;
    expect(player.getPlayableCards()).does.not.include(card);
  });

  it('play', () => {
    player.steel = 3;
    expect(player.production.steel).eq(0);
    expect(player.getTerraformRating()).eq(14);
    expect(moonData.miningRate).eq(0);

    card.play(player);

    expect(player.steel).eq(1);
    expect(player.production.megacredits).eq(4);
    expect(player.getTerraformRating()).eq(15);
    expect(moonData.logisticRate).eq(1);

    const space = moonData.moon.spaces[2];
    const placeTileAction = cast(game.deferredActions.peek(), PlaceSpecialMoonTile);
    placeTileAction.execute()!.cb(space);

    expect(space.player).eq(player);
    expect(space.tile!.tileType).eq(TileType.LUNA_TRAIN_STATION);
    expect(space.tile!.card).eq(card.name);
  });

  it('getVictoryPoints', () => {
    // This space has room to surround it with roads.
    const space = moonData.moon.getSpaceOrThrow('m15');
    space.tile = {tileType: TileType.LUNA_TRAIN_STATION, card: card.name};

    expect(card.getVictoryPoints(player)).eq(0);
    const adjacentSpaces = moonData.moon.getAdjacentSpaces(space);

    adjacentSpaces[0].tile = {tileType: TileType.MOON_ROAD};
    expect(card.getVictoryPoints(player)).eq(2);

    adjacentSpaces[1].tile = {tileType: TileType.MOON_ROAD};
    expect(card.getVictoryPoints(player)).eq(4);

    adjacentSpaces[2].tile = {tileType: TileType.MOON_ROAD};
    expect(card.getVictoryPoints(player)).eq(6);
  });
});

