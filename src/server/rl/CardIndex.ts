import {BoardName} from '../../common/boards/BoardName';
import {CardName} from '../../common/cards/CardName';
import {Tag} from '../../common/cards/Tag';
import {SpaceId} from '../../common/Types';
import {DEFAULT_GAME_OPTIONS, GameOptions} from '../game/GameOptions';
import {GameCards} from '../GameCards';
import {SeededRandom} from '../../common/utils/Random';
import {TharsisBoard} from '../boards/TharsisBoard';

/**
 * Canonical game options for RL training:
 * - Map: Tharsis
 * - 2 Players
 * - Base + Corporate Era + Preludes only
 */
export const RL_TRAINING_GAME_OPTIONS: GameOptions = {
  ...DEFAULT_GAME_OPTIONS,
  boardName: BoardName.THARSIS,
  corporateEra: true,
  preludeExtension: true,
  prelude2Expansion: false,
  venusNextExtension: false,
  coloniesExtension: false,
  turmoilExtension: false,
  promoCardsOption: false,
  communityCardsOption: false,
  aresExtension: false,
  aresHazards: false,
  aresExtremeVariant: false,
  moonExpansion: false,
  pathfindersExpansion: false,
  ceoExtension: false,
  starWarsExpansion: false,
  underworldExpansion: false,
  deltaProjectExpansion: false,
  draftVariant: false,
  initialDraftVariant: false,
  preludeDraftVariant: false,
  ceosDraftVariant: false,
  solarPhaseOption: false,
  shuffleMapOption: false,
  undoOption: false,
  fastModeOption: false,
  showOtherPlayersVP: true,
  startingCorporations: 2,
  startingPreludes: 4,
  expansions: {
    corpera: true,
    prelude: true,
    prelude2: false,
    venus: false,
    colonies: false,
    turmoil: false,
    promo: false,
    community: false,
    ares: false,
    moon: false,
    pathfinders: false,
    ceo: false,
    starwars: false,
    underworld: false,
    deltaProject: false,
  },
};

const rlCards = new GameCards(RL_TRAINING_GAME_OPTIONS);

export const CANONICAL_CORP_CARDS: ReadonlyArray<CardName> = rlCards
  .getCorporationCards()
  .map((c) => c.name)
  .sort((a, b) => a.localeCompare(b));

export const CANONICAL_PRELUDE_CARDS: ReadonlyArray<CardName> = rlCards
  .getPreludeCards()
  .map((c) => c.name)
  .sort((a, b) => a.localeCompare(b));

export const CANONICAL_PROJECT_CARDS: ReadonlyArray<CardName> = rlCards
  .getProjectCards()
  .map((c) => c.name)
  .sort((a, b) => a.localeCompare(b));

export const ALL_CANONICAL_CARDS: ReadonlyArray<CardName> = [
  ...CANONICAL_CORP_CARDS,
  ...CANONICAL_PRELUDE_CARDS,
  ...CANONICAL_PROJECT_CARDS,
];

export const NUM_CORP_CARDS = CANONICAL_CORP_CARDS.length; // 17
export const NUM_PRELUDE_CARDS = CANONICAL_PRELUDE_CARDS.length; // 35
export const NUM_PROJECT_CARDS = CANONICAL_PROJECT_CARDS.length; // 215
export const NUM_TOTAL_CARDS = ALL_CANONICAL_CARDS.length; // 267

export const CARD_TO_INDEX = new Map<CardName, number>(
  ALL_CANONICAL_CARDS.map((name, idx) => [name, idx]),
);

export const PROJECT_CARD_TO_OFFSET = new Map<CardName, number>(
  CANONICAL_PROJECT_CARDS.map((name, idx) => [name, idx]),
);

export const CORP_CARD_TO_OFFSET = new Map<CardName, number>(
  CANONICAL_CORP_CARDS.map((name, idx) => [name, idx]),
);

const referenceBoard = TharsisBoard.newInstance(RL_TRAINING_GAME_OPTIONS, new SeededRandom(0));
export const THARSIS_SPACE_IDS: ReadonlyArray<SpaceId> = referenceBoard.spaces.map((s) => s.id);
export const NUM_BOARD_SPACES = THARSIS_SPACE_IDS.length; // 63
export const SPACE_ID_TO_OFFSET = new Map<SpaceId, number>(
  THARSIS_SPACE_IDS.map((id, idx) => [id, idx]),
);

export const STANDARD_PROJECT_CARDS: ReadonlyArray<CardName> = [
  CardName.AQUIFER_STANDARD_PROJECT,
  CardName.CITY_STANDARD_PROJECT,
  CardName.POWER_PLANT_STANDARD_PROJECT,
  CardName.GREENERY_STANDARD_PROJECT,
  CardName.ASTEROID_STANDARD_PROJECT,
  CardName.SELL_PATENTS_STANDARD_PROJECT,
];
export const NUM_STANDARD_PROJECTS = STANDARD_PROJECT_CARDS.length; // 6
export const STANDARD_PROJECT_TO_OFFSET = new Map<CardName, number>(
  STANDARD_PROJECT_CARDS.map((name, idx) => [name, idx]),
);

export const THARSIS_MILESTONES: ReadonlyArray<string> = [
  'Terraformer',
  'Mayor',
  'Gardener',
  'Builder',
  'Planner',
];
export const NUM_MILESTONES = THARSIS_MILESTONES.length; // 5
export const MILESTONE_TO_OFFSET = new Map<string, number>(
  THARSIS_MILESTONES.map((name, idx) => [name, idx]),
);

export const THARSIS_AWARDS: ReadonlyArray<string> = [
  'Landlord',
  'Scientist',
  'Banker',
  'Thermalist',
  'Miner',
];
export const NUM_AWARDS = THARSIS_AWARDS.length; // 5
export const AWARD_TO_OFFSET = new Map<string, number>(
  THARSIS_AWARDS.map((name, idx) => [name, idx]),
);

export const RL_TAGS: ReadonlyArray<Tag> = [
  Tag.BUILDING,
  Tag.SPACE,
  Tag.SCIENCE,
  Tag.POWER,
  Tag.EARTH,
  Tag.JOVIAN,
  Tag.PLANT,
  Tag.MICROBE,
  Tag.ANIMAL,
  Tag.CITY,
  Tag.EVENT,
  Tag.WILD,
];

export const RESOURCE_KEYS = [
  'megacredits',
  'steel',
  'titanium',
  'plants',
  'energy',
  'heat',
] as const;

/**
 * Discrete Action Space Layout (Total = 605 actions):
 * - [0 .. 266]   (267): Play / Select Card (17 Corps + 35 Preludes + 215 Projects)
 * - [267 .. 481] (215): Activate Blue Action on Project Card (0 .. 214)
 * - [482 .. 498] (17) : Activate Corporation Action / Initial Action (0 .. 16)
 * - [499 .. 561] (63) : Select Board Space on Tharsis (0 .. 62)
 * - [562 .. 567] (6)  : Standard Projects (Aquifer, City, Power Plant, Greenery, Asteroid, Sell Patents)
 * - [568 .. 572] (5)  : Claim Milestone (Terraformer, Mayor, Gardener, Builder, Planner)
 * - [573 .. 577] (5)  : Fund Award (Landlord, Scientist, Banker, Thermalist, Miner)
 * - [578]        (1)  : Convert 8 Plants into Greenery
 * - [579]        (1)  : Convert 8 Heat into Temperature
 * - [580]        (1)  : End Turn (after 1st action)
 * - [581]        (1)  : Pass for Generation / Skip Final Greenery
 * - [582]        (1)  : Confirm / Finish Multi-Card Selection
 * - [583 .. 588] (6)  : Select Resource / Production Type (M€, Steel, Titanium, Plants, Energy, Heat)
 * - [589 .. 604] (16) : Generic Option / Amount / Player / Fallback Slots (0 .. 15)
 */
export const ACTION_OFFSET_CARD = 0;
export const ACTION_OFFSET_BLUE_PROJECT = ACTION_OFFSET_CARD + NUM_TOTAL_CARDS; // 267
export const ACTION_OFFSET_CORP_ACTION = ACTION_OFFSET_BLUE_PROJECT + NUM_PROJECT_CARDS; // 482
export const ACTION_OFFSET_SPACE = ACTION_OFFSET_CORP_ACTION + NUM_CORP_CARDS; // 499
export const ACTION_OFFSET_STD_PROJECT = ACTION_OFFSET_SPACE + NUM_BOARD_SPACES; // 562
export const ACTION_OFFSET_MILESTONE = ACTION_OFFSET_STD_PROJECT + NUM_STANDARD_PROJECTS; // 568
export const ACTION_OFFSET_AWARD = ACTION_OFFSET_MILESTONE + NUM_MILESTONES; // 573
export const ACTION_CONVERT_PLANTS = ACTION_OFFSET_AWARD + NUM_AWARDS; // 578
export const ACTION_CONVERT_HEAT = ACTION_CONVERT_PLANTS + 1; // 579
export const ACTION_END_TURN = ACTION_CONVERT_HEAT + 1; // 580
export const ACTION_PASS = ACTION_END_TURN + 1; // 581
export const ACTION_CONFIRM_SELECTION = ACTION_PASS + 1; // 582
export const ACTION_OFFSET_RESOURCE = ACTION_CONFIRM_SELECTION + 1; // 583
export const ACTION_OFFSET_GENERIC = ACTION_OFFSET_RESOURCE + 6; // 589
export const NUM_GENERIC_ACTIONS = 16;
export const ACTION_SPACE_SIZE = ACTION_OFFSET_GENERIC + NUM_GENERIC_ACTIONS; // 605

/**
 * State Vector Dimension:
 * - Global game features: 25
 * - Milestones & Awards features: 40 (5 * 4 + 5 * 4)
 * - Self player features: 42
 * - Opponent player features: 42
 * - Board spaces features: 315 (63 * 5)
 * - Card channels: 1068 (267 * 4: inHand/selectable, playable, selfTableau, oppTableau)
 * Total = 1532
 */
export const STATE_DIM = 25 + 40 + 42 + 42 + (NUM_BOARD_SPACES * 5) + (NUM_TOTAL_CARDS * 4); // 1532
