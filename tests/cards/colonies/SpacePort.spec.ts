import {expect} from 'chai';
import {SpacePort} from '../../../src/server/cards/colonies/SpacePort';
import {SelectSpace} from '../../../src/server/inputs/SelectSpace';
import {Resource} from '../../../src/common/Resource';
import {cast, runAllActions} from '../../TestingUtils';
import {testGame} from '../../TestGame';
import {TestPlayer} from '../../TestPlayer';
import {ColonyName} from '../../../src/common/colonies/ColonyName';

describe('SpacePort', function() {
  let card: SpacePort;
  let player: TestPlayer;

  beforeEach(function() {
    card = new SpacePort();
    [/* game */, player] = testGame(2, {coloniesExtension: true, customColoniesList: [
      ColonyName.CERES,
      ColonyName.CALLISTO,
      ColonyName.ENCELADUS,
      ColonyName.EUROPA,
      ColonyName.GANYMEDE,
    ]});
  });

  it('Can not play without colony', function() {
    player.production.add(Resource.ENERGY, 1);
    expect(card.canPlay(player)).is.not.true;
  });

  it('Can not play without energy production', function() {
    player.game.colonies[0].colonies.push(player.id);
    expect(card.canPlay(player)).is.not.true;
  });

  it('Should play', function() {
    player.production.add(Resource.ENERGY, 1);
    player.game.colonies[0].colonies.push(player.id);
    expect(card.canPlay(player)).is.true;

    cast(card.play(player), undefined);
    runAllActions(player.game);
    const action = cast(player.popWaitingFor(), SelectSpace);

    action.cb(action.spaces[0]);
    expect(player.production.energy).to.eq(0);
    expect(player.production.megacredits).to.eq(4);
  });
});
