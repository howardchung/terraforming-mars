import {expect} from 'chai';
import {JovianEmbassy} from '../../../src/server/cards/promo/JovianEmbassy';
import {Game} from '../../../src/server/Game';
import {TestPlayer} from '../../TestPlayer';

describe('JovianEmbassy', function() {
  it('Should play', function() {
    const card = new JovianEmbassy();
    const player = TestPlayer.BLUE.newPlayer();
    const redPlayer = TestPlayer.RED.newPlayer();

    Game.newInstance('gameid', [player, redPlayer], player);

    card.play(player);
    expect(player.getTerraformRating()).to.eq(21);
    expect(card.getVictoryPoints()).to.eq(1);
  });
});
