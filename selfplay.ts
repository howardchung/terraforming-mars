// Call API to create game with VP visible

import { Color } from "@/common/Color";
import { SeededRandom } from "@/common/utils/Random";
import { registerBehaviorExecutor } from "@/server/behavior/BehaviorExecutor";
import { Executor } from "@/server/behavior/Executor";
import { Database } from "@/server/database/Database";
// import { GameLoader } from "@/server/database/GameLoader";
import { Game } from "@/server/Game";
import { Player } from "@/server/Player";

// Use in memory sqlite
process.env.SQLITE_FILE_NAME = ':memory:';
// Note, server may start listening later after we start the game
// require('src/server/server');
start2();
// Demo MVP that creates a game and plays itself with agents
// Should we set up server APIs we can call from Python to create game, fetch actions, take action, fetch reward state?
// Then can build an environment in Gymnasium for training
async function start2() {
    // Below called by the server, set it up if running standalone
    await Database.getInstance().initialize();
// set up the behavior executor
    registerBehaviorExecutor(new Executor());
// instead of calling public APIs, can we just directly make the same internal calls to the server? might be faster without http
    const players = [new Player(
              'AI1',
              Color.RED,
              false,
              0,
              'p1',
            ),
            new Player(
                'AI2',
                Color.GREEN,
                false,
                0,
                'p2',
              )];
    // Use the same seed to play the same game over and over again
    const gameSeed = 1;
    const game = Game.newInstance('g_TEST', players, players[0], {}, gameSeed);
    // Update gameloader if we want to read info from database later
    // GameLoader.getInstance().add(game);
    const agentSeed = 1;
    // 0.06541441624090338 broken?
    // 0.4892122666445651 broken?
    const rand = new SeededRandom(agentSeed);
    //await new Promise(resolve => setTimeout(resolve, 5000));
    while (true) {
        console.log('[STATUS] gen: %s, board: %s, oceans: %s, temp: %s, oxygen: %s, phase: %s, active: %s, seed: %s', game.generation, game.board.spaces.filter(s => s.tile).length + '/' + game.board.spaces.length, !game.canAddOcean(), game.getTemperature(), game.getOxygenLevel(), game.phase, game.activePlayer, agentSeed);
        if (game.generation > 100) {
            break;
        }
        if (game.phase === 'end') {
            break;
        }
        game.getPlayers().forEach((p, i) => {
            // if researching, all players need to act
            // otherwise, only active player should act
            if (game.phase === 'research' || game.activePlayer === p.id) { 
                // List the available actions (orOptions) and do the first one
                const actions = p.getWaitingFor();
                if (!actions) {
                    throw new Error('no actions');
                }
                // const algo = p.id === 'p1' ? 'random' : 'first';
                const algo = 'random';
                // TODO implement one step lookahead agent?
                // should try each action and pick the one that results in most VP?
                // other agent logic, maybe maximize production?
                // can we set up self-play/reinforcement learning?
                // probably need to set up a vector of all actions and then assign weights via training
                // Game actions are kind of nested right now
                // We probably want to produce a flat list of actions so Python frameworks can read more easily
                // But need to translate back into nested structure when creating inputresponse
                console.log('[ACTION] %s %s, actionspace: %s', p.id, actions.type, actions.getActionSpace(p));
                const input = actions.agent(algo, p, rand);
                if (!input) {
                    throw new Error('no input');
                }
                p.process(input);
            }
        });
        // Pause between each step
        // await new Promise(resolve => setTimeout(resolve, 100));
    }
    // show endgame state
    console.log(game.getPlayers().map(p => ({ 
        corp: p.corporations[0].name,
        points: p.getVictoryPoints().total,
        tableau: p.tableau.length,
        actions: p.actionsTakenThisGame,
        tr: p.getTerraformRating(),
        megacredits: `${p.megaCredits} +${p.production.asUnits().megacredits}`, 
        steel: `${p.steel} +${p.production.asUnits().steel}`, 
        titanium: `${p.titanium} +${p.production.asUnits().titanium}`, 
        plants: `${p.plants} +${p.production.asUnits().plants}`, 
        energy: `${p.energy} +${p.production.asUnits().energy}`, 
        heat: `${p.heat} +${p.production.asUnits().heat}` 
    })));
}