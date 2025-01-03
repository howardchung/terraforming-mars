// Call API to create game with VP visible

import { Color } from "@/common/Color";
import { InputResponse, SelectInitialCardsResponse } from "@/common/inputs/InputResponse";
import { Database } from "@/server/database/Database";
import { Game } from "@/server/Game";
import { SelectInitialCards } from "@/server/inputs/SelectInitialCards";
import { Player } from "@/server/Player";
import { PlayerInput } from "@/server/routes/PlayerInput";

start2();
async function start2() {
// Use in memory sqlite
process.env.SQLITE_FILE_NAME = ':memory:';
await Database.getInstance().initialize();
// instead of calling public APIs, can we just directly make the same internal calls to the server? might be faster without http
const players = [new Player(
              'AI1',
              Color.RED,
              false,
              0,
              'pid1',
            ),
            new Player(
                'AI2',
                Color.GREEN,
                false,
                0,
                'pid2',
              )];
const game = Game.newInstance('g_TEST', players, players[0], {}, 1);
// console.log(game);
// iterate over each players waitingFor
// if undefined, not waiting for player to take an action
const waitingFors = game.getPlayers().forEach(p => {
    const wf = p.getWaitingFor();
    // has available options
    // need to process into an inputresponse
    if (wf?.type === 'initialCards') {
        (wf as SelectInitialCards).agent(p);
    }
});
}

async function start() {
const server = 'http://azure.howardchung.net:8081';
const settings = {
    "players": [
        {
            "name": "AI1",
            "color": "red",
            "beginner": false,
            "handicap": 0,
            "first": false
        },
        {
            "name": "AI2",
            "color": "green",
            "beginner": false,
            "handicap": 0,
            "first": false
        }
    ],
    "corporateEra": true,
    "prelude": false,
    "prelude2Expansion": false,
    "draftVariant": false,
    "showOtherPlayersVP": true,
    "venusNext": false,
    "colonies": false,
    "turmoil": false,
    "customCorporationsList": [],
    "customColoniesList": [],
    "customPreludes": [],
    "bannedCards": [],
    "includedCards": [],
    "board": "tharsis",
    // set deterministic seed for testing
    "seed": 1,
    "solarPhaseOption": false,
    "promoCardsOption": false,
    "communityCardsOption": false,
    "aresExtension": false,
    "aresExtremeVariant": false,
    "politicalAgendasExtension": "Standard",
    "moonExpansion": false,
    "pathfindersExpansion": false,
    "undoOption": false,
    "showTimers": false,
    "fastModeOption": false,
    "removeNegativeGlobalEventsOption": false,
    "includeFanMA": false,
    "modularMA": false,
    "startingCorporations": 2,
    "soloTR": false,
    "initialDraft": false,
    "preludeDraftVariant": false,
    "randomMA": "No randomization",
    "shuffleMapOption": false,
    "randomFirstPlayer": false,
    "requiresVenusTrackCompletion": false,
    "requiresMoonTrackCompletion": false,
    "moonStandardProjectVariant": false,
    "moonStandardProjectVariant1": false,
    "altVenusBoard": false,
    "escapeVelocityMode": false,
    "escapeVelocityBonusSeconds": 2,
    "twoCorpsVariant": false,
    "ceoExtension": false,
    "customCeos": [],
    "startingCeos": 3,
    "startingPreludes": 4,
    "starWarsExpansion": false,
    "underworldExpansion": false
};
const dataToSend = JSON.stringify(settings);
const resp = await fetch(server + '/game', { method: 'PUT', 'body': dataToSend, 'headers': {'Content-Type': 'application/json'} });
const game = await resp.json();
/*
{
    "activePlayer": "red",
    "id": "gad1e0c25845f",
    "phase": "research",
    "players": [
        {
            "color": "red",
            "id": "p1c00ca6da035",
            "name": "AI1"
        },
        {
            "color": "green",
            "id": "p4ae6d9a2512f",
            "name": "AI2"
        }
    ],
    "spectatorId": "s87cec9b1abb6",
    "gameOptions": {
        "altVenusBoard": false,
        "aresExtremeVariant": false,
        "boardName": "tharsis",
        "bannedCards": [],
        "draftVariant": false,
        "escapeVelocityMode": false,
        "escapeVelocityBonusSeconds": 2,
        "expansions": {
            "corpera": true,
            "promo": false,
            "venus": false,
            "colonies": false,
            "prelude": false,
            "prelude2": false,
            "turmoil": false,
            "community": false,
            "ares": false,
            "moon": false,
            "pathfinders": false,
            "ceo": false,
            "starwars": false,
            "underworld": false
        },
        "fastModeOption": false,
        "includedCards": [],
        "includeFanMA": false,
        "initialDraftVariant": false,
        "preludeDraftVariant": false,
        "politicalAgendasExtension": "Standard",
        "removeNegativeGlobalEvents": false,
        "showOtherPlayersVP": true,
        "showTimers": false,
        "shuffleMapOption": false,
        "solarPhaseOption": false,
        "soloTR": false,
        "randomMA": "No randomization",
        "requiresMoonTrackCompletion": false,
        "requiresVenusTrackCompletion": false,
        "twoCorpsVariant": false,
        "undoOption": false
    },
    "lastSoloGeneration": 14,
    "expectedPurgeTimeMs": 1736576581358
}
*/
console.log(game);
// Get the player IDs
const resp2 = await fetch(server + '/player?id=' + game.players[0].id);
const player = await resp2.json();
console.log(player);
if (player.phase === 'research') {
    // in research phase, select random cards
    /*
    {"runId":"rba0c00c2b044","type":"initialCards","responses":[{"type":"card","cards":["CrediCor"]},{"type":"card","cards":["Mineral Deposit"]}]}
    */
    // waitingFor lists the available corps and cards
    /*
     "waitingFor": {
        "title": " ",
        "buttonLabel": "Start",
        "type": "initialCards",
        "options": [
            {
                "title": "Select corporation",
                "buttonLabel": "Save",
                "type": "card",
                "cards": [
                    {
                        "resources": 0,
                        "name": "Interplanetary Cinematics",
                        "calculatedCost": 0
                    },
                    {
                        "resources": 0,
                        "name": "Mining Guild",
                        "calculatedCost": 0
                    }
                ],
                "max": 1,
                "min": 1,
                "showOnlyInLearnerMode": false,
                "selectBlueCardAction": false,
                "showOwner": false
            },
            {
                "title": "Select initial cards to buy",
                "buttonLabel": "Save",
                "type": "card",
                "cards": [
                    {
                        "resources": 0,
                        "name": "Herbivores",
                        "calculatedCost": 12
                    },
                    {
                        "resources": 0,
                        "name": "Moss",
                        "calculatedCost": 4
                    },
                    {
                        "resources": 0,
                        "name": "Sabotage",
                        "calculatedCost": 1
                    },
                    {
                        "resources": 0,
                        "name": "Mining Expedition",
                        "calculatedCost": 12
                    },
                    {
                        "resources": 0,
                        "name": "Land Claim",
                        "calculatedCost": 1
                    },
                    {
                        "resources": 0,
                        "name": "Immigrant City",
                        "calculatedCost": 13
                    },
                    {
                        "resources": 0,
                        "name": "Breathing Filters",
                        "calculatedCost": 11
                    },
                    {
                        "resources": 0,
                        "name": "Micro-Mills",
                        "calculatedCost": 3
                    },
                    {
                        "resources": 0,
                        "name": "Magnetic Field Dome",
                        "calculatedCost": 5
                    },
                    {
                        "resources": 0,
                        "name": "Large Convoy",
                        "calculatedCost": 36
                    }
                ],
                "max": 10,
                "min": 0,
                "showOnlyInLearnerMode": false,
                "selectBlueCardAction": false,
                "showOwner": false
            }
        ]
    },
    */
    // What if the random selection is invalid/too expensive? does server validate, so we can just retry until something works?
    const dataToSend2 = {
        runId: game.runId,
        type: "initialCards",
        responses: [
            {"type":"card","cards":["CrediCor"]},
            {"type":"card","cards":["Mineral Deposit"]}
        ]
    };
    const resp3 = await fetch(server + '/player/input?id=' + game.players[0].id, { method: 'POST', 'headers': {'Content-Type': 'application/json'}, body: dataToSend2 });
    const game2 = await resp3.json();
    // need to poll waitingfor endpoint until other player moves, or just request player state repeatedly until waitingFor property is available
    // https://terraforming-mars.herokuapp.com/api/waitingfor?id=p1c00ca6da035&gameAge=3&undoCount=0
    // {"result":"GO","waitingFor":["red"]}
    // get the game state again from https://terraforming-mars.herokuapp.com/api/player?id=p1c00ca6da035
    // available actions are in player.waitingFor.options
    /*
        "waitingFor": {
        "title": "Take your first action",
        "buttonLabel": "Take action",
        "type": "or",
        "options": [
            {
                "title": "Play project card",
                "buttonLabel": "Play card",
                "type": "projectCard",
                "cards": [
                    {
                        "name": "Mineral Deposit",
                        "calculatedCost": 5,
                        "reserveUnits": {
                            "megacredits": 0,
                            "steel": 0,
                            "titanium": 0,
                            "plants": 0,
                            "energy": 0,
                            "heat": 0
                        }
                    }
                ],
                "microbes": 0,
                "floaters": 0,
                "paymentOptions": {
                    "heat": false,
                    "lunaTradeFederationTitanium": false,
                    "plants": false,
                    "corruption": false
                },
                "lunaArchivesScience": 0,
                "seeds": 0,
                "graphene": 0,
                "kuiperAsteroids": 0,
                "corruption": 0
            },
            {
                "title": {
                    "data": [
                        {
                            "type": 1,
                            "value": "8"
                        }
                    ],
                    "message": "Fund an award (${0} M€)"
                },
                "buttonLabel": "Confirm",
                "type": "or",
                "options": [
                    {
                        "title": "Landlord",
                        "buttonLabel": "Fund - (Landlord)",
                        "type": "option"
                    },
                    {
                        "title": "Scientist",
                        "buttonLabel": "Fund - (Scientist)",
                        "type": "option"
                    },
                    {
                        "title": "Banker",
                        "buttonLabel": "Fund - (Banker)",
                        "type": "option"
                    },
                    {
                        "title": "Thermalist",
                        "buttonLabel": "Fund - (Thermalist)",
                        "type": "option"
                    },
                    {
                        "title": "Miner",
                        "buttonLabel": "Fund - (Miner)",
                        "type": "option"
                    }
                ],
                "initialIdx": 0
            },
            {
                "title": "Standard projects",
                "buttonLabel": "Confirm",
                "type": "card",
                "cards": [
                    {
                        "resources": 0,
                        "name": "Power Plant:SP",
                        "calculatedCost": 11
                    },
                    {
                        "resources": 0,
                        "name": "Asteroid:SP",
                        "calculatedCost": 14
                    },
                    {
                        "resources": 0,
                        "name": "Aquifer",
                        "calculatedCost": 18
                    },
                    {
                        "resources": 0,
                        "name": "Greenery",
                        "calculatedCost": 23
                    },
                    {
                        "resources": 0,
                        "name": "City",
                        "calculatedCost": 25
                    }
                ],
                "max": 1,
                "min": 1,
                "showOnlyInLearnerMode": false,
                "selectBlueCardAction": false,
                "showOwner": false
            },
            {
                "title": "Pass for this generation",
                "buttonLabel": "Pass",
                "type": "option"
            },
            {
                "title": "Sell patents",
                "buttonLabel": "Sell",
                "type": "card",
                "cards": [
                    {
                        "name": "Mineral Deposit",
                        "calculatedCost": 5
                    }
                ],
                "max": 1,
                "min": 1,
                "showOnlyInLearnerMode": false,
                "selectBlueCardAction": false,
                "showOwner": false
            }
        ],
        "initialIdx": 0
    },
    */
} else if (player.phase === 'action') {
    // in gameplay phase, take random action
    // if placing tile, place randomly
} else if (player.phase === 'end') {
    console.log('end');
}

// Add API to get available actions
// Agents make a random action
// Get reward heuristic (VP)
// pass results to python for reinforcement learning? Or setup environment with gymnasium and attach APIs
}

/*
    {
    "cardsInHand": [
        {
            "name": "Mineral Deposit",
            "calculatedCost": 5
        }
    ],
    "ceoCardsInHand": [],
    "dealtCorporationCards": [
        {
            "name": "CrediCor",
            "calculatedCost": 0
        },
        {
            "name": "Teractor",
            "calculatedCost": 0,
            "discount": [
                {
                    "tag": "earth",
                    "amount": 3
                }
            ]
        }
    ],
    "dealtPreludeCards": [],
    "dealtCeoCards": [],
    "dealtProjectCards": [
        {
            "name": "Mineral Deposit",
            "calculatedCost": 5
        },
        {
            "name": "Cartel",
            "calculatedCost": 8
        },
        {
            "name": "Tundra Farming",
            "calculatedCost": 16
        },
        {
            "name": "Release of Inert Gases",
            "calculatedCost": 14
        },
        {
            "name": "Subterranean Reservoir",
            "calculatedCost": 11
        },
        {
            "name": "Bushes",
            "calculatedCost": 10
        },
        {
            "name": "Local Heat Trapping",
            "calculatedCost": 1
        },
        {
            "name": "Anti-Gravity Technology",
            "calculatedCost": 14,
            "discount": [
                {
                    "amount": 2
                }
            ]
        },
        {
            "name": "Mass Converter",
            "calculatedCost": 8,
            "discount": [
                {
                    "tag": "space",
                    "amount": 2,
                    "per": "card"
                }
            ]
        },
        {
            "name": "Capital",
            "calculatedCost": 26
        }
    ],
    "draftedCards": [],
    "game": {
        "awards": [
            {
                "playerName": "",
                "playerColor": "",
                "name": "Landlord",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Scientist",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Banker",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Thermalist",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Miner",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            }
        ],
        "colonies": [],
        "deckSize": 188,
        "discardedColonies": [],
        "expectedPurgeTimeMs": 1736576581358,
        "gameAge": 3,
        "gameOptions": {
            "altVenusBoard": false,
            "aresExtremeVariant": false,
            "boardName": "tharsis",
            "bannedCards": [],
            "draftVariant": false,
            "escapeVelocityMode": false,
            "escapeVelocityBonusSeconds": 2,
            "expansions": {
                "corpera": true,
                "promo": false,
                "venus": false,
                "colonies": false,
                "prelude": false,
                "prelude2": false,
                "turmoil": false,
                "community": false,
                "ares": false,
                "moon": false,
                "pathfinders": false,
                "ceo": false,
                "starwars": false,
                "underworld": false
            },
            "fastModeOption": false,
            "includedCards": [],
            "includeFanMA": false,
            "initialDraftVariant": false,
            "preludeDraftVariant": false,
            "politicalAgendasExtension": "Standard",
            "removeNegativeGlobalEvents": false,
            "showOtherPlayersVP": true,
            "showTimers": false,
            "shuffleMapOption": false,
            "solarPhaseOption": false,
            "soloTR": false,
            "randomMA": "No randomization",
            "requiresMoonTrackCompletion": false,
            "requiresVenusTrackCompletion": false,
            "twoCorpsVariant": false,
            "undoOption": false
        },
        "generation": 1,
        "globalsPerGeneration": [],
        "isSoloModeWin": false,
        "lastSoloGeneration": 14,
        "milestones": [
            {
                "playerName": "",
                "playerColor": "",
                "name": "Terraformer",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 20
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 20
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Mayor",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Gardener",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Builder",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 0
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            },
            {
                "playerName": "",
                "playerColor": "",
                "name": "Planner",
                "scores": [
                    {
                        "playerColor": "red",
                        "playerScore": 1
                    },
                    {
                        "playerColor": "green",
                        "playerScore": 0
                    }
                ]
            }
        ],
        "oceans": 0,
        "oxygenLevel": 0,
        "passedPlayers": [],
        "phase": "research",
        "spaces": [
            {
                "x": -1,
                "y": -1,
                "id": "01",
                "spaceType": "colony",
                "bonus": []
            },
            {
                "x": -1,
                "y": -1,
                "id": "02",
                "spaceType": "colony",
                "bonus": []
            },
            {
                "x": 4,
                "y": 0,
                "id": "03",
                "spaceType": "land",
                "bonus": [
                    1,
                    1
                ]
            },
            {
                "x": 5,
                "y": 0,
                "id": "04",
                "spaceType": "ocean",
                "bonus": [
                    1,
                    1
                ]
            },
            {
                "x": 6,
                "y": 0,
                "id": "05",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 7,
                "y": 0,
                "id": "06",
                "spaceType": "ocean",
                "bonus": [
                    3
                ]
            },
            {
                "x": 8,
                "y": 0,
                "id": "07",
                "spaceType": "ocean",
                "bonus": []
            },
            {
                "x": 3,
                "y": 1,
                "id": "08",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 4,
                "y": 1,
                "id": "09",
                "spaceType": "land",
                "bonus": [
                    1
                ]
            },
            {
                "x": 5,
                "y": 1,
                "id": "10",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 6,
                "y": 1,
                "id": "11",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 7,
                "y": 1,
                "id": "12",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 8,
                "y": 1,
                "id": "13",
                "spaceType": "ocean",
                "bonus": [
                    3,
                    3
                ]
            },
            {
                "x": 2,
                "y": 2,
                "id": "14",
                "spaceType": "land",
                "bonus": [
                    3
                ]
            },
            {
                "x": 3,
                "y": 2,
                "id": "15",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 4,
                "y": 2,
                "id": "16",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 5,
                "y": 2,
                "id": "17",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 6,
                "y": 2,
                "id": "18",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 7,
                "y": 2,
                "id": "19",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 8,
                "y": 2,
                "id": "20",
                "spaceType": "land",
                "bonus": [
                    1
                ]
            },
            {
                "x": 1,
                "y": 3,
                "id": "21",
                "spaceType": "land",
                "bonus": [
                    2,
                    0
                ]
            },
            {
                "x": 2,
                "y": 3,
                "id": "22",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 3,
                "y": 3,
                "id": "23",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 4,
                "y": 3,
                "id": "24",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 5,
                "y": 3,
                "id": "25",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 6,
                "y": 3,
                "id": "26",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 7,
                "y": 3,
                "id": "27",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 8,
                "y": 3,
                "id": "28",
                "spaceType": "ocean",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 0,
                "y": 4,
                "id": "29",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 1,
                "y": 4,
                "id": "30",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 2,
                "y": 4,
                "id": "31",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 3,
                "y": 4,
                "id": "32",
                "spaceType": "ocean",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 4,
                "y": 4,
                "id": "33",
                "spaceType": "ocean",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 5,
                "y": 4,
                "id": "34",
                "spaceType": "ocean",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 6,
                "y": 4,
                "id": "35",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 7,
                "y": 4,
                "id": "36",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 8,
                "y": 4,
                "id": "37",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 1,
                "y": 5,
                "id": "38",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 2,
                "y": 5,
                "id": "39",
                "spaceType": "land",
                "bonus": [
                    2,
                    2
                ]
            },
            {
                "x": 3,
                "y": 5,
                "id": "40",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 4,
                "y": 5,
                "id": "41",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 5,
                "y": 5,
                "id": "42",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 6,
                "y": 5,
                "id": "43",
                "spaceType": "ocean",
                "bonus": [
                    2
                ]
            },
            {
                "x": 7,
                "y": 5,
                "id": "44",
                "spaceType": "ocean",
                "bonus": [
                    2
                ]
            },
            {
                "x": 8,
                "y": 5,
                "id": "45",
                "spaceType": "ocean",
                "bonus": [
                    2
                ]
            },
            {
                "x": 2,
                "y": 6,
                "id": "46",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 3,
                "y": 6,
                "id": "47",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 4,
                "y": 6,
                "id": "48",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 5,
                "y": 6,
                "id": "49",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 6,
                "y": 6,
                "id": "50",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 7,
                "y": 6,
                "id": "51",
                "spaceType": "land",
                "bonus": [
                    2
                ]
            },
            {
                "x": 8,
                "y": 6,
                "id": "52",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 3,
                "y": 7,
                "id": "53",
                "spaceType": "land",
                "bonus": [
                    1,
                    1
                ]
            },
            {
                "x": 4,
                "y": 7,
                "id": "54",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 5,
                "y": 7,
                "id": "55",
                "spaceType": "land",
                "bonus": [
                    3
                ]
            },
            {
                "x": 6,
                "y": 7,
                "id": "56",
                "spaceType": "land",
                "bonus": [
                    3
                ]
            },
            {
                "x": 7,
                "y": 7,
                "id": "57",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 8,
                "y": 7,
                "id": "58",
                "spaceType": "land",
                "bonus": [
                    0
                ]
            },
            {
                "x": 4,
                "y": 8,
                "id": "59",
                "spaceType": "land",
                "bonus": [
                    1
                ]
            },
            {
                "x": 5,
                "y": 8,
                "id": "60",
                "spaceType": "land",
                "bonus": [
                    1,
                    1
                ]
            },
            {
                "x": 6,
                "y": 8,
                "id": "61",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 7,
                "y": 8,
                "id": "62",
                "spaceType": "land",
                "bonus": []
            },
            {
                "x": 8,
                "y": 8,
                "id": "63",
                "spaceType": "ocean",
                "bonus": [
                    0,
                    0
                ]
            },
            {
                "x": -1,
                "y": -1,
                "id": "69",
                "spaceType": "colony",
                "bonus": []
            }
        ],
        "spectatorId": "s87cec9b1abb6",
        "temperature": -30,
        "isTerraformed": false,
        "undoCount": 0,
        "venusScaleLevel": 0,
        "step": 1
    },
    "id": "p1c00ca6da035",
    "runId": "rba0c00c2b044",
    "pickedCorporationCard": [
        {
            "name": "CrediCor",
            "calculatedCost": 0
        }
    ],
    "preludeCardsInHand": [],
    "thisPlayer": {
        "actionsTakenThisRound": 0,
        "actionsTakenThisGame": 0,
        "actionsThisGeneration": [],
        "availableBlueCardActionCount": 0,
        "cardCost": 3,
        "cardDiscount": 0,
        "cardsInHandNbr": 1,
        "citiesCount": 0,
        "coloniesCount": 0,
        "color": "red",
        "energy": 0,
        "energyProduction": 0,
        "fleetSize": 1,
        "heat": 0,
        "heatProduction": 0,
        "influence": 0,
        "isActive": true,
        "megaCredits": 0,
        "megaCreditProduction": 0,
        "name": "AI1",
        "needsToResearch": true,
        "noTagsCount": 0,
        "plants": 0,
        "plantProduction": 0,
        "protectedResources": {
            "megacredits": "off",
            "steel": "off",
            "titanium": "off",
            "plants": "off",
            "energy": "off",
            "heat": "off"
        },
        "protectedProduction": {
            "megacredits": "off",
            "steel": "off",
            "titanium": "off",
            "plants": "off",
            "energy": "off",
            "heat": "off"
        },
        "tableau": [],
        "selfReplicatingRobotsCards": [],
        "steel": 0,
        "steelProduction": 0,
        "steelValue": 2,
        "tags": {
            "building": 0,
            "space": 0,
            "science": 0,
            "power": 0,
            "earth": 0,
            "jovian": 0,
            "venus": 0,
            "moon": 0,
            "mars": 0,
            "plant": 0,
            "microbe": 0,
            "animal": 0,
            "city": 0,
            "wild": 0,
            "clone": 0,
            "event": 0
        },
        "terraformRating": 20,
        "timer": {
            "sumElapsed": 0,
            "startedAt": 1735885381161,
            "running": false,
            "afterFirstAction": true,
            "lastStoppedAt": 1735885868966
        },
        "titanium": 0,
        "titaniumProduction": 0,
        "titaniumValue": 3,
        "tradesThisGeneration": 0,
        "victoryPointsBreakdown": {
            "terraformRating": 20,
            "milestones": 0,
            "awards": 0,
            "greenery": 0,
            "city": 0,
            "escapeVelocity": 0,
            "moonHabitats": 0,
            "moonMines": 0,
            "moonRoads": 0,
            "planetaryTracks": 0,
            "victoryPoints": 0,
            "total": 20,
            "detailsCards": [],
            "detailsMilestones": [],
            "detailsAwards": [],
            "detailsPlanetaryTracks": []
        },
        "victoryPointsByGeneration": [],
        "corruption": 0,
        "excavations": 0
    },
    "players": [
        {
            "actionsTakenThisRound": 0,
            "actionsTakenThisGame": 0,
            "actionsThisGeneration": [],
            "availableBlueCardActionCount": 0,
            "cardCost": 3,
            "cardDiscount": 0,
            "cardsInHandNbr": 1,
            "citiesCount": 0,
            "coloniesCount": 0,
            "color": "red",
            "energy": 0,
            "energyProduction": 0,
            "fleetSize": 1,
            "heat": 0,
            "heatProduction": 0,
            "influence": 0,
            "isActive": true,
            "megaCredits": 0,
            "megaCreditProduction": 0,
            "name": "AI1",
            "needsToResearch": true,
            "noTagsCount": 0,
            "plants": 0,
            "plantProduction": 0,
            "protectedResources": {
                "megacredits": "off",
                "steel": "off",
                "titanium": "off",
                "plants": "off",
                "energy": "off",
                "heat": "off"
            },
            "protectedProduction": {
                "megacredits": "off",
                "steel": "off",
                "titanium": "off",
                "plants": "off",
                "energy": "off",
                "heat": "off"
            },
            "tableau": [],
            "selfReplicatingRobotsCards": [],
            "steel": 0,
            "steelProduction": 0,
            "steelValue": 2,
            "tags": {
                "building": 0,
                "space": 0,
                "science": 0,
                "power": 0,
                "earth": 0,
                "jovian": 0,
                "venus": 0,
                "moon": 0,
                "mars": 0,
                "plant": 0,
                "microbe": 0,
                "animal": 0,
                "city": 0,
                "wild": 0,
                "clone": 0,
                "event": 0
            },
            "terraformRating": 20,
            "timer": {
                "sumElapsed": 0,
                "startedAt": 1735885381161,
                "running": false,
                "afterFirstAction": true,
                "lastStoppedAt": 1735885868966
            },
            "titanium": 0,
            "titaniumProduction": 0,
            "titaniumValue": 3,
            "tradesThisGeneration": 0,
            "victoryPointsBreakdown": {
                "terraformRating": 20,
                "milestones": 0,
                "awards": 0,
                "greenery": 0,
                "city": 0,
                "escapeVelocity": 0,
                "moonHabitats": 0,
                "moonMines": 0,
                "moonRoads": 0,
                "planetaryTracks": 0,
                "victoryPoints": 0,
                "total": 20,
                "detailsCards": [],
                "detailsMilestones": [],
                "detailsAwards": [],
                "detailsPlanetaryTracks": []
            },
            "victoryPointsByGeneration": [],
            "corruption": 0,
            "excavations": 0
        },
        {
            "actionsTakenThisRound": 0,
            "actionsTakenThisGame": 0,
            "actionsThisGeneration": [],
            "availableBlueCardActionCount": 0,
            "cardCost": 3,
            "cardDiscount": 0,
            "cardsInHandNbr": 0,
            "citiesCount": 0,
            "coloniesCount": 0,
            "color": "green",
            "energy": 0,
            "energyProduction": 0,
            "fleetSize": 1,
            "heat": 0,
            "heatProduction": 0,
            "influence": 0,
            "isActive": false,
            "megaCredits": 0,
            "megaCreditProduction": 0,
            "name": "AI2",
            "needsToResearch": true,
            "noTagsCount": 0,
            "plants": 0,
            "plantProduction": 0,
            "protectedResources": {
                "megacredits": "off",
                "steel": "off",
                "titanium": "off",
                "plants": "off",
                "energy": "off",
                "heat": "off"
            },
            "protectedProduction": {
                "megacredits": "off",
                "steel": "off",
                "titanium": "off",
                "plants": "off",
                "energy": "off",
                "heat": "off"
            },
            "tableau": [],
            "selfReplicatingRobotsCards": [],
            "steel": 0,
            "steelProduction": 0,
            "steelValue": 2,
            "tags": {
                "building": 0,
                "space": 0,
                "science": 0,
                "power": 0,
                "earth": 0,
                "jovian": 0,
                "venus": 0,
                "moon": 0,
                "mars": 0,
                "plant": 0,
                "microbe": 0,
                "animal": 0,
                "city": 0,
                "wild": 0,
                "clone": 0,
                "event": 0
            },
            "terraformRating": 20,
            "timer": {
                "sumElapsed": 0,
                "startedAt": 1735885381161,
                "running": true,
                "afterFirstAction": false,
                "lastStoppedAt": 1735885868966
            },
            "titanium": 0,
            "titaniumProduction": 0,
            "titaniumValue": 3,
            "tradesThisGeneration": 0,
            "victoryPointsBreakdown": {
                "terraformRating": 20,
                "milestones": 0,
                "awards": 0,
                "greenery": 0,
                "city": 0,
                "escapeVelocity": 0,
                "moonHabitats": 0,
                "moonMines": 0,
                "moonRoads": 0,
                "planetaryTracks": 0,
                "victoryPoints": 0,
                "total": 20,
                "detailsCards": [],
                "detailsMilestones": [],
                "detailsAwards": [],
                "detailsPlanetaryTracks": []
            },
            "victoryPointsByGeneration": [],
            "corruption": 0,
            "excavations": 0
        }
    ],
    "autopass": false
}
    */