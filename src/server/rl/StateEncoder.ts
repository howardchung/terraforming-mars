import {CardResource} from '../../common/CardResource';
import {Phase} from '../../common/Phase';
import {TileType} from '../../common/TileType';
import {AwardScorer} from '../awards/AwardScorer';
import {OrOptions} from '../inputs/OrOptions';
import {SelectCard} from '../inputs/SelectCard';
import {SelectInitialCards} from '../inputs/SelectInitialCards';
import {SelectSpace} from '../inputs/SelectSpace';
import {IPlayer} from '../IPlayer';
import {PlayerStagingState} from './ActionCodec';

type PlayerVpBreakdown = ReturnType<IPlayer['getVictoryPoints']>;
import {
  ACTION_OFFSET_BLUE_PROJECT,
  ACTION_OFFSET_CARD,
  ACTION_OFFSET_CORP_ACTION,
  AWARD_TO_OFFSET,
  CARD_TO_INDEX,
  MILESTONE_TO_OFFSET,
  NUM_AWARDS,
  NUM_BOARD_SPACES,
  NUM_CORP_CARDS,
  NUM_MILESTONES,
  NUM_PRELUDE_CARDS,
  NUM_PROJECT_CARDS,
  NUM_TOTAL_CARDS,
  RL_TAGS,
  SPACE_ID_TO_OFFSET,
  STATE_DIM,
} from './CardIndex';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function encodeGameState(
  player: IPlayer,
  staging: PlayerStagingState,
  decodedMask?: ReadonlyArray<boolean>,
  precomputedVps?: {selfVp: PlayerVpBreakdown; oppVp: PlayerVpBreakdown},
): Float32Array {
  const vec = new Float32Array(STATE_DIM);
  let offset = 0;

  const game = player.game;
  const opponent = player.opponents[0] ?? game.players.find((p) => p.id !== player.id) ?? player;
  const waitingFor = player.getWaitingFor();

  // =========================================================================
  // 1. Global Game Features (25 floats)
  // =========================================================================
  const genNorm = clamp(game.generation / 15.0, 0, 2);
  const oxy = game.getOxygenLevel();
  const temp = game.getTemperature();
  const oceans = game.board.getOceanSpaces().length;

  const oxyNorm = clamp(oxy / 14.0, 0, 1);
  const oxyRem = clamp((14 - oxy) / 14.0, 0, 1);
  const tempNorm = clamp((temp + 30) / 38.0, 0, 1);
  const tempRem = clamp((8 - temp) / 38.0, 0, 1);
  const oceansNorm = clamp(oceans / 9.0, 0, 1);
  const oceansRem = clamp((9 - oceans) / 9.0, 0, 1);
  const totalRemSteps = (14 - oxy) + Math.round((8 - temp) / 2) + (9 - oceans);
  const totalRemNorm = clamp(totalRemSteps / 42.0, 0, 1);

  const deckNorm = clamp(game.projectDeck.drawPile.length / 215.0, 0, 1);
  const discardNorm = clamp(game.projectDeck.discardPile.length / 215.0, 0, 1);
  const isFirstPlayer = game.first.id === player.id ? 1.0 : 0.0;
  const oppPassed = game.hasPassedThisActionPhase(opponent) ? 1.0 : 0.0;
  const selfPassed = game.hasPassedThisActionPhase(player) ? 1.0 : 0.0;
  const actionsTakenNorm = clamp(player.actionsTakenThisRound / 2.0, 0, 1);
  const claimedMilestonesNorm = clamp(game.claimedMilestones.length / 3.0, 0, 1);
  const fundedAwardsNorm = clamp(game.fundedAwards.length / 3.0, 0, 1);

  // Phase indicators (5)
  const isResearchPhase = game.phase === Phase.RESEARCH ? 1.0 : 0.0;
  const isPreludePhase = game.phase === Phase.PRELUDES ? 1.0 : 0.0;
  const isActionPhase = game.phase === Phase.ACTION ? 1.0 : 0.0;
  const isProductionOrSolar = (game.phase === Phase.PRODUCTION || game.phase === Phase.SOLAR) ? 1.0 : 0.0;
  const isEndPhase = game.phase === Phase.END ? 1.0 : 0.0;

  // Sub-step / prompt type indicators (4)
  const isInitialPrompt = waitingFor instanceof SelectInitialCards ? 1.0 : 0.0;
  const isSpacePrompt = waitingFor instanceof SelectSpace ? 1.0 : 0.0;
  const isCardPrompt = waitingFor instanceof SelectCard ? 1.0 : 0.0;
  const isOrPrompt = waitingFor instanceof OrOptions ? 1.0 : 0.0;

  vec[offset++] = genNorm;
  vec[offset++] = oxyNorm;
  vec[offset++] = oxyRem;
  vec[offset++] = tempNorm;
  vec[offset++] = tempRem;
  vec[offset++] = oceansNorm;
  vec[offset++] = oceansRem;
  vec[offset++] = totalRemNorm;
  vec[offset++] = deckNorm;
  vec[offset++] = discardNorm;
  vec[offset++] = isFirstPlayer;
  vec[offset++] = oppPassed;
  vec[offset++] = selfPassed;
  vec[offset++] = actionsTakenNorm;
  vec[offset++] = claimedMilestonesNorm;
  vec[offset++] = fundedAwardsNorm;
  vec[offset++] = isResearchPhase;
  vec[offset++] = isPreludePhase;
  vec[offset++] = isActionPhase;
  vec[offset++] = isProductionOrSolar;
  vec[offset++] = isEndPhase;
  vec[offset++] = isInitialPrompt;
  vec[offset++] = isSpacePrompt;
  vec[offset++] = isCardPrompt;
  vec[offset++] = isOrPrompt;

  // =========================================================================
  // 2. Milestones & Awards (40 floats: 5 * 4 + 5 * 4)
  // =========================================================================
  const mBase = offset;
  for (const m of game.milestones) {
    const mIdx = MILESTONE_TO_OFFSET.get(m.name);
    if (mIdx === undefined || mIdx >= NUM_MILESTONES) {
      continue;
    }
    const claimed = game.claimedMilestones.find((cm) => cm.milestone.name === m.name);
    const claimedSelf = claimed?.player.id === player.id ? 1.0 : 0.0;
    const claimedOpp = (claimed !== undefined && claimed.player.id !== player.id) ? 1.0 : 0.0;
    const selfScore = clamp(m.getScore(player) / 16.0, 0, 2);
    const oppScore = clamp(m.getScore(opponent) / 16.0, 0, 2);
    const slot = mBase + mIdx * 4;
    vec[slot] = claimedSelf;
    vec[slot + 1] = claimedOpp;
    vec[slot + 2] = selfScore;
    vec[slot + 3] = oppScore;
  }
  offset += NUM_MILESTONES * 4;

  const aBase = offset;
  for (const a of game.awards) {
    const aIdx = AWARD_TO_OFFSET.get(a.name);
    if (aIdx === undefined || aIdx >= NUM_AWARDS) {
      continue;
    }
    const funded = game.fundedAwards.some((fa) => fa.award.name === a.name) ? 1.0 : 0.0;
    const scorer = new AwardScorer(game, a);
    const sSelf = scorer.get(player);
    const sOpp = scorer.get(opponent);
    const selfLead = sSelf > sOpp ? 1.0 : sSelf === sOpp && sSelf > 0 ? 0.5 : 0.0;
    const slot = aBase + aIdx * 4;
    vec[slot] = funded;
    vec[slot + 1] = clamp(sSelf / 20.0, 0, 2);
    vec[slot + 2] = clamp(sOpp / 20.0, 0, 2);
    vec[slot + 3] = selfLead;
  }
  offset += NUM_AWARDS * 4;

  // =========================================================================
  // 3. Player Feature Extractor (42 floats per player x 2 = 84 floats)
  // =========================================================================
  const writePlayerFeatures = (p: IPlayer, preVp?: PlayerVpBreakdown) => {
    const vpb = preVp ?? p.getVictoryPoints();
    vec[offset++] = clamp((p.terraformRating - 20) / 40.0, -0.5, 2.0);
    vec[offset++] = clamp(vpb.total / 100.0, 0, 2.0);
    vec[offset++] = clamp(vpb.milestones / 15.0, 0, 1.0);
    vec[offset++] = clamp(vpb.awards / 15.0, 0, 1.0);
    vec[offset++] = clamp(vpb.greenery / 15.0, 0, 2.0);
    vec[offset++] = clamp(vpb.city / 15.0, 0, 2.0);
    vec[offset++] = clamp(vpb.victoryPoints / 30.0, -0.5, 2.0);

    // Resources (6)
    vec[offset++] = clamp(p.megaCredits / 60.0, 0, 3.0);
    vec[offset++] = clamp(p.steel / 20.0, 0, 3.0);
    vec[offset++] = clamp(p.titanium / 15.0, 0, 3.0);
    vec[offset++] = clamp(p.plants / 16.0, 0, 3.0);
    vec[offset++] = clamp(p.energy / 15.0, 0, 3.0);
    vec[offset++] = clamp(p.heat / 24.0, 0, 3.0);

    // Productions (6)
    vec[offset++] = clamp((p.production.megacredits + 5) / 30.0, 0, 3.0);
    vec[offset++] = clamp(p.production.steel / 10.0, 0, 3.0);
    vec[offset++] = clamp(p.production.titanium / 10.0, 0, 3.0);
    vec[offset++] = clamp(p.production.plants / 10.0, 0, 3.0);
    vec[offset++] = clamp(p.production.energy / 10.0, 0, 3.0);
    vec[offset++] = clamp(p.production.heat / 15.0, 0, 3.0);

    // Multipliers & status (8)
    vec[offset++] = clamp(p.getSteelValue() / 4.0, 0, 2.0);
    vec[offset++] = clamp(p.getTitaniumValue() / 5.0, 0, 2.0);
    vec[offset++] = clamp(p.cardCost / 3.0, 0, 2.0);
    vec[offset++] = clamp(p.plantsNeededForGreenery / 8.0, 0, 1.5);
    vec[offset++] = p.canUseHeatAsMegaCredits ? 1.0 : 0.0;
    vec[offset++] = clamp(p.cardsInHand.length / 15.0, 0, 2.0);
    vec[offset++] = clamp(p.preludeCardsInHand.length / 4.0, 0, 1.0);
    vec[offset++] = clamp(p.tableau.length / 30.0, 0, 2.0);

    // Card resources & board counts (3)
    vec[offset++] = clamp(p.getResourceCount(CardResource.MICROBE) / 10.0, 0, 2.0);
    vec[offset++] = clamp(p.getResourceCount(CardResource.ANIMAL) / 10.0, 0, 2.0);
    vec[offset++] = clamp(game.board.getCities(p).length / 8.0, 0, 2.0);

    // Tags (12) -> 7 + 6 + 6 + 8 + 3 + 12 = 42
    for (const tag of RL_TAGS) {
      vec[offset++] = clamp(p.tags.count(tag, 'raw') / 10.0, 0, 2.5);
    }
  };

  writePlayerFeatures(player, precomputedVps?.selfVp);
  writePlayerFeatures(opponent, precomputedVps?.oppVp);

  // =========================================================================
  // 4. Board Spaces Features (63 * 5 = 315 floats)
  // =========================================================================
  const bBase = offset;
  for (const space of game.board.spaces) {
    const sIdx = SPACE_ID_TO_OFFSET.get(space.id);
    if (sIdx === undefined || sIdx >= NUM_BOARD_SPACES) {
      continue;
    }
    const slot = bBase + sIdx * 5;
    const ownerSelf = space.player?.id === player.id ? 1.0 : 0.0;
    const ownerOpp = (space.player !== undefined && space.player.id !== player.id) ? 1.0 : 0.0;
    const tt = space.tile?.tileType;
    const isCity = tt === TileType.CITY || tt === TileType.CAPITAL ? 1.0 : 0.0;
    const isGreenery = tt === TileType.GREENERY ? 1.0 : 0.0;
    const isOceanOrSpecial =
      tt !== undefined && !isCity && !isGreenery ? 1.0 : 0.0;

    vec[slot] = ownerSelf;
    vec[slot + 1] = ownerOpp;
    vec[slot + 2] = isCity;
    vec[slot + 3] = isGreenery;
    vec[slot + 4] = isOceanOrSpecial;
  }
  offset += NUM_BOARD_SPACES * 5;

  // =========================================================================
  // 5. Card Presence Channels (267 * 4 = 1068 floats)
  // Channel 0: Self hand / dealt / selectable / staged
  // Channel 1: Self currently playable
  // Channel 2: Self tableau (1.0 + 0.1 * resourceCount)
  // Channel 3: Opponent tableau (1.0 + 0.1 * resourceCount)
  // =========================================================================
  const ch0 = offset;
  const ch1 = offset + NUM_TOTAL_CARDS;
  const ch2 = offset + NUM_TOTAL_CARDS * 2;
  const ch3 = offset + NUM_TOTAL_CARDS * 3;

  for (const card of player.cardsInHand) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch0 + idx] = 1.0;
    }
  }
  for (const card of player.preludeCardsInHand) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch0 + idx] = 1.0;
    }
  }
  if (waitingFor instanceof SelectInitialCards) {
    for (const c of player.dealtCorporationCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch0 + idx] = staging.selectedCorp === c.name ? 1.0 : 0.5;
      }
    }
    for (const c of player.dealtPreludeCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch0 + idx] = staging.selectedPreludes.includes(c.name) ? 1.0 : 0.5;
      }
    }
    for (const c of player.dealtProjectCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch0 + idx] = staging.selectedProjects.includes(c.name) ? 1.0 : 0.5;
      }
    }
  } else if (waitingFor instanceof SelectCard) {
    for (const c of waitingFor.cards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch0 + idx] = staging.multiCardSelected.includes(c.name) ? 1.0 : 0.75;
      }
    }
  }

  if (decodedMask !== undefined) {
    for (let i = 0; i < NUM_TOTAL_CARDS; i++) {
      if (decodedMask[ACTION_OFFSET_CARD + i]) {
        vec[ch1 + i] = 1.0;
      }
    }
    for (let i = 0; i < NUM_CORP_CARDS; i++) {
      if (decodedMask[ACTION_OFFSET_CORP_ACTION + i]) {
        vec[ch1 + i] = 1.0;
      }
    }
    const projBase = NUM_CORP_CARDS + NUM_PRELUDE_CARDS;
    for (let p = 0; p < NUM_PROJECT_CARDS; p++) {
      if (decodedMask[ACTION_OFFSET_BLUE_PROJECT + p]) {
        vec[ch1 + projBase + p] = 1.0;
      }
    }
  } else {
    for (const card of player.getPlayableCards()) {
      const idx = CARD_TO_INDEX.get(card.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = 1.0;
      }
    }
    for (const card of player.getPlayableActionCards()) {
      const idx = CARD_TO_INDEX.get(card.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = 1.0;
      }
    }
  }

  for (const card of player.tableau) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch2 + idx] = 1.0 + clamp((card.resourceCount ?? 0) * 0.1, 0, 2.0);
    }
  }

  for (const card of opponent.tableau) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch3 + idx] = 1.0 + clamp((card.resourceCount ?? 0) * 0.1, 0, 2.0);
    }
  }

  return vec;
}
