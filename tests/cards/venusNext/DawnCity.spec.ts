import {expect} from 'chai';
import {DawnCity} from '../../../src/server/cards/venusNext/DawnCity';
import {testGame} from '../../TestGame';
import {Resource} from '../../../src/common/Resource';
import {cast} from '../../TestingUtils';

describe('DawnCity', () => {
  it('Should play', () => {
    const card = new DawnCity();
    const [/* game */, player] = testGame(2, {venusNextExtension: true});
    player.production.add(Resource.ENERGY, 1);
    expect(card.canPlay(player)).is.not.true;

    cast(card.play(player), undefined);
    expect(player.production.energy).to.eq(0);
    expect(player.production.titanium).to.eq(1);
  });
});
