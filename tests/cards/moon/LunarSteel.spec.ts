import {Game} from '../../../src/server/Game';
import {Player} from '../../../src/server/Player';
import {setCustomGameOptions} from '../../TestingUtils';
import {TestPlayer} from '../../TestPlayer';
import {LunarSteel} from '../../../src/server/cards/moon/LunarSteel';
import {expect} from 'chai';

const MOON_OPTIONS = setCustomGameOptions({moonExpansion: true});

describe('LunarSteel', () => {
  let player: Player;
  let card: LunarSteel;

  beforeEach(() => {
    player = TestPlayer.BLUE.newPlayer();
    Game.newInstance('gameid', [player], player, MOON_OPTIONS);
    card = new LunarSteel();
  });

  it('play', () => {
    expect(player.getSteelValue()).to.eq(2);
    card.play(player);
    expect(player.getSteelValue()).to.eq(3);
  });
});

