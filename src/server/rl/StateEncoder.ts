import {CardResource} from '../../common/CardResource';
import {GlobalParameter} from '../../common/GlobalParameter';
import {Phase} from '../../common/Phase';
import {TileType} from '../../common/TileType';
import {AwardScorer} from '../awards/AwardScorer';
import {isIActionCard} from '../cards/ICard';
import {OrOptions} from '../inputs/OrOptions';
import {SelectCard} from '../inputs/SelectCard';
import {SelectInitialCards} from '../inputs/SelectInitialCards';
import {SelectSpace} from '../inputs/SelectSpace';
import {IPlayer} from '../IPlayer';
import {PlayerStagingState} from './ActionCodec';
import {
  ACTION_OFFSET_BLUE_PROJECT,
  ACTION_OFFSET_CARD,
  ACTION_OFFSET_CORP_ACTION,
  ACTION_OFFSET_SPACE,
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
  THARSIS_ADJACENCY,
  THARSIS_SPACE_BONUS_VALUES,
} from './CardIndex';

type PlayerVpBreakdown = ReturnType<IPlayer['getVictoryPoints']>;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function titleToLower(title: unknown): string {
  if (!title) {
    return '';
  }
  if (typeof title === 'string') {
    return title.toLowerCase();
  }
  if (typeof title === 'object' && 'message' in title && typeof (title as {message?: unknown}).message === 'string') {
    return (title as {message: string}).message.toLowerCase();
  }
  return '';
}

function computeEffectiveMc(p: IPlayer): number {
  return (
    p.megaCredits +
    p.steel * p.getSteelValue() +
    p.titanium * p.getTitaniumValue() +
    (p.canUseHeatAsMegaCredits ? p.heat : 0)
  );
}

function computeNextGenIncome(p: IPlayer): number {
  return (
    p.terraformRating +
    p.production.megacredits +
    p.production.steel * p.getSteelValue() +
    p.production.titanium * p.getTitaniumValue()
  );
}

function computeGlobalCardDiscount(p: IPlayer): number {
  let discount = p.colonies.cardDiscount;
  for (const card of p.tableau) {
    const cd = card.cardDiscount;
    if (cd === undefined) {
      continue;
    }
    const list = Array.isArray(cd) ? cd : [cd];
    for (const d of list) {
      if (d.tag === undefined && d.per === undefined) {
        discount += d.amount;
      }
    }
  }
  return discount;
}

function countUnusedBlueActions(p: IPlayer): number {
  let count = 0;
  for (const card of p.tableau) {
    if (isIActionCard(card) && !p.actionsThisGeneration.has(card.name)) {
      count++;
    }
  }
  return count;
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

  const selfVp = precomputedVps?.selfVp ?? player.getVictoryPoints();
  const oppVp = precomputedVps?.oppVp ?? opponent.getVictoryPoints();
  const selfEffectiveMc = computeEffectiveMc(player);
  const oppEffectiveMc = computeEffectiveMc(opponent);
  const selfIncome = computeNextGenIncome(player);
  const oppIncome = computeNextGenIncome(opponent);

  // =========================================================================
  // 1. Global Game, Tempo, Differential & Prompt Features (45 floats)
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

  // Base prompt type indicators (4)
  const isInitialPrompt = waitingFor instanceof SelectInitialCards;
  const isSpacePrompt = waitingFor instanceof SelectSpace;
  const isCardPrompt = waitingFor instanceof SelectCard;
  const isOrPrompt = waitingFor instanceof OrOptions;

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
  vec[offset++] = isInitialPrompt ? 1.0 : 0.0;
  vec[offset++] = isSpacePrompt ? 1.0 : 0.0;
  vec[offset++] = isCardPrompt ? 1.0 : 0.0;
  vec[offset++] = isOrPrompt ? 1.0 : 0.0;

  // v2 Strategic differentials & terraforming tempo (8)
  const combinedHeatProd =
    player.production.heat + opponent.production.heat +
    player.production.energy + opponent.production.energy;
  const combinedPlantProd = player.production.plants + opponent.production.plants;
  const estStepsPerGen = Math.max(2.0, combinedHeatProd / 8.0 + combinedPlantProd / 8.0 + 1.5);
  const estGensLeft = clamp(totalRemSteps / estStepsPerGen, 0, 15.0) / 15.0;

  vec[offset++] = clamp((selfVp.total - oppVp.total) / 30.0, -2.0, 2.0);
  vec[offset++] = clamp((player.terraformRating - opponent.terraformRating) / 20.0, -2.0, 2.0);
  vec[offset++] = clamp((selfEffectiveMc - oppEffectiveMc) / 50.0, -2.0, 2.0);
  vec[offset++] = clamp((selfIncome - oppIncome) / 40.0, -2.0, 2.0);
  vec[offset++] = clamp(combinedHeatProd / 20.0, 0, 2.0);
  vec[offset++] = clamp(combinedPlantProd / 14.0, 0, 2.0);
  vec[offset++] = estGensLeft;
  vec[offset++] = clamp((player.actionsThisGeneration.size + opponent.actionsThisGeneration.size) / 10.0, 0, 2.0);

  // v2 Prompt & staging context (12)
  let initialRemainingMc = 0;
  if (isInitialPrompt && staging.selectedCorp !== undefined) {
    const corpCard = player.dealtCorporationCards.find((c) => c.name === staging.selectedCorp);
    const startMc = corpCard?.startingMegaCredits ?? 42;
    const cardCost = corpCard?.cardCost ?? player.cardCost;
    initialRemainingMc = clamp((startMc - cardCost * staging.selectedProjects.length) / 50.0, -0.5, 2.0);
  }
  const spaceTitle = isSpacePrompt ? titleToLower(waitingFor.title) : '';
  const spaceIsCity = isSpacePrompt && spaceTitle.includes('city');
  const spaceIsGreenery = isSpacePrompt && spaceTitle.includes('greenery');
  const spaceIsOcean = isSpacePrompt && spaceTitle.includes('ocean');
  const spaceIsSpecial = isSpacePrompt && !spaceIsCity && !spaceIsGreenery && !spaceIsOcean;

  vec[offset++] = isInitialPrompt && staging.initialStage === 'corp' ? 1.0 : 0.0;
  vec[offset++] = isInitialPrompt && (staging.initialStage === 'prelude1' || staging.initialStage === 'prelude2') ? 1.0 : 0.0;
  vec[offset++] = isInitialPrompt && staging.initialStage === 'projects' ? 1.0 : 0.0;
  vec[offset++] = initialRemainingMc;
  vec[offset++] = isCardPrompt ? clamp(waitingFor.config.min / 5.0, 0, 2.0) : 0.0;
  vec[offset++] = isCardPrompt ? clamp(waitingFor.config.max / 5.0, 0, 2.0) : 0.0;
  vec[offset++] = isCardPrompt ? clamp(staging.multiCardSelected.length / 5.0, 0, 2.0) : 0.0;
  vec[offset++] = staging.inSellPatentsSubstep ? 1.0 : 0.0;
  vec[offset++] = spaceIsCity ? 1.0 : 0.0;
  vec[offset++] = spaceIsGreenery ? 1.0 : 0.0;
  vec[offset++] = spaceIsOcean ? 1.0 : 0.0;
  vec[offset++] = spaceIsSpecial ? 1.0 : 0.0;

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
  // 3. Player Feature Extractor (50 floats per player x 2 = 100 floats)
  // =========================================================================
  const writePlayerFeatures = (
    p: IPlayer,
    vpb: PlayerVpBreakdown,
    effMc: number,
    income: number,
  ) => {
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

    // Tags (12) -> 42
    for (const tag of RL_TAGS) {
      vec[offset++] = clamp(p.tags.count(tag, 'raw') / 10.0, 0, 2.5);
    }

    // v2 Economy, discounts, requirement leeway & extra VP resources (8) -> 50
    const reqBonus = p.getGlobalParameterRequirementBonus(GlobalParameter.TEMPERATURE);
    vec[offset++] = clamp(effMc / 80.0, 0, 3.0);
    vec[offset++] = clamp(income / 80.0, -0.5, 3.0);
    vec[offset++] = clamp(computeGlobalCardDiscount(p) / 5.0, 0, 2.0);
    vec[offset++] = clamp(reqBonus / 4.0, 0, 2.0);
    vec[offset++] = clamp(p.getResourceCount(CardResource.SCIENCE) / 10.0, 0, 2.0);
    vec[offset++] = clamp(p.getResourceCount(CardResource.FIGHTER) / 10.0, 0, 2.0);
    vec[offset++] = clamp(countUnusedBlueActions(p) / 6.0, 0, 2.0);
    vec[offset++] = (p.plants >= p.plantsNeededForGreenery || p.heat >= 8) ? 1.0 : 0.0;
  };

  writePlayerFeatures(player, selfVp, selfEffectiveMc, selfIncome);
  writePlayerFeatures(opponent, oppVp, oppEffectiveMc, oppIncome);

  // =========================================================================
  // 4. Board Spaces Features (63 * 10 = 630 floats)
  // [0] ownerSelf, [1] ownerOpp, [2] isCity, [3] isGreenery, [4] isOceanOrSpecial,
  // [5] isLegalTarget, [6] adjOceans, [7] adjSelfCityOrGreenery, [8] adjOppCity, [9] emptyBonusVal
  // =========================================================================
  const bBase = offset;
  const tileKind = new Uint8Array(NUM_BOARD_SPACES); // 0=empty, 1=ocean, 2=selfCity, 3=oppCity, 4=selfGreenery, 5=oppGreenery, 6=special
  const legalSpaceSet = isSpacePrompt && decodedMask === undefined ?
    new Set(waitingFor.spaces.map((s) => s.id)) :
    undefined;

  for (const space of game.board.spaces) {
    const sIdx = SPACE_ID_TO_OFFSET.get(space.id);
    if (sIdx === undefined || sIdx >= NUM_BOARD_SPACES) {
      continue;
    }
    const slot = bBase + sIdx * 10;
    const ownerSelf = space.player?.id === player.id;
    const ownerOpp = space.player !== undefined && space.player.id !== player.id;
    const tt = space.tile?.tileType;
    const isCity = tt === TileType.CITY || tt === TileType.CAPITAL;
    const isGreenery = tt === TileType.GREENERY;
    const isOcean = tt === TileType.OCEAN;
    const isOceanOrSpecial = tt !== undefined && !isCity && !isGreenery;

    vec[slot] = ownerSelf ? 1.0 : 0.0;
    vec[slot + 1] = ownerOpp ? 1.0 : 0.0;
    vec[slot + 2] = isCity ? 1.0 : 0.0;
    vec[slot + 3] = isGreenery ? 1.0 : 0.0;
    vec[slot + 4] = isOceanOrSpecial ? 1.0 : 0.0;

    if (decodedMask !== undefined) {
      vec[slot + 5] = decodedMask[ACTION_OFFSET_SPACE + sIdx] ? 1.0 : 0.0;
    } else if (legalSpaceSet !== undefined) {
      vec[slot + 5] = legalSpaceSet.has(space.id) ? 1.0 : 0.0;
    }

    if (tt === undefined) {
      const bonusVal = THARSIS_SPACE_BONUS_VALUES[sIdx];
      if (bonusVal > 0) {
        vec[slot + 9] = clamp(bonusVal / 8.0, 0, 2.0);
      }
    } else if (isOcean) {
      tileKind[sIdx] = 1;
    } else if (isCity) {
      tileKind[sIdx] = ownerSelf ? 2 : 3;
    } else if (isGreenery) {
      tileKind[sIdx] = ownerSelf ? 4 : 5;
    } else {
      tileKind[sIdx] = 6;
    }
  }

  // Adjacency pass using precomputed Tharsis hex graph
  for (let sIdx = 0; sIdx < NUM_BOARD_SPACES; sIdx++) {
    const neighbors = THARSIS_ADJACENCY[sIdx];
    let adjOceans = 0;
    let adjSelfCityOrGreenery = 0;
    let adjOppCities = 0;
    for (const neighborIdx of neighbors) {
      const kind = tileKind[neighborIdx];
      if (kind === 1) {
        adjOceans++;
      } else if (kind === 2 || kind === 4) {
        adjSelfCityOrGreenery++;
      } else if (kind === 3) {
        adjOppCities++;
      }
    }
    const slot = bBase + sIdx * 10;
    if (adjOceans > 0) {
      vec[slot + 6] = clamp(adjOceans / 3.0, 0, 2.0);
    }
    if (adjSelfCityOrGreenery > 0) {
      vec[slot + 7] = clamp(adjSelfCityOrGreenery / 4.0, 0, 2.0);
    }
    if (adjOppCities > 0) {
      vec[slot + 8] = clamp(adjOppCities / 3.0, 0, 2.0);
    }
  }
  offset += NUM_BOARD_SPACES * 10;

  // =========================================================================
  // 5. Card Presence Channels (267 * 6 = 1602 floats)
  // Channel 0: Self in-hand (cardsInHand + preludeCardsInHand)
  // Channel 1: Self selectable / staged (0.5 selectable, 1.0 staged)
  // Channel 2: Self currently playable / activatable
  // Channel 3: Self tableau (1.0 + 0.1 * resourceCount)
  // Channel 4: Opponent tableau (1.0 + 0.1 * resourceCount)
  // Channel 5: Unused blue/corp actions this generation (+1 self, -1 opponent)
  // =========================================================================
  const ch0 = offset;
  const ch1 = offset + NUM_TOTAL_CARDS;
  const ch2 = offset + NUM_TOTAL_CARDS * 2;
  const ch3 = offset + NUM_TOTAL_CARDS * 3;
  const ch4 = offset + NUM_TOTAL_CARDS * 4;
  const ch5 = offset + NUM_TOTAL_CARDS * 5;

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

  if (isInitialPrompt) {
    for (const c of player.dealtCorporationCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = staging.selectedCorp === c.name ? 1.0 : 0.5;
      }
    }
    for (const c of player.dealtPreludeCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = staging.selectedPreludes.includes(c.name) ? 1.0 : 0.5;
      }
    }
    for (const c of player.dealtProjectCards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = staging.selectedProjects.includes(c.name) ? 1.0 : 0.5;
      }
    }
  } else if (isCardPrompt) {
    for (const c of waitingFor.cards) {
      const idx = CARD_TO_INDEX.get(c.name);
      if (idx !== undefined) {
        vec[ch1 + idx] = staging.multiCardSelected.includes(c.name) ? 1.0 : 0.5;
      }
    }
  }

  if (decodedMask !== undefined) {
    for (let i = 0; i < NUM_TOTAL_CARDS; i++) {
      if (decodedMask[ACTION_OFFSET_CARD + i]) {
        vec[ch2 + i] = 1.0;
      }
    }
    for (let i = 0; i < NUM_CORP_CARDS; i++) {
      if (decodedMask[ACTION_OFFSET_CORP_ACTION + i]) {
        vec[ch2 + i] = 1.0;
      }
    }
    const projBase = NUM_CORP_CARDS + NUM_PRELUDE_CARDS;
    for (let p = 0; p < NUM_PROJECT_CARDS; p++) {
      if (decodedMask[ACTION_OFFSET_BLUE_PROJECT + p]) {
        vec[ch2 + projBase + p] = 1.0;
      }
    }
  } else {
    for (const card of player.getPlayableCards()) {
      const idx = CARD_TO_INDEX.get(card.name);
      if (idx !== undefined) {
        vec[ch2 + idx] = 1.0;
      }
    }
    for (const card of player.getPlayableActionCards()) {
      const idx = CARD_TO_INDEX.get(card.name);
      if (idx !== undefined) {
        vec[ch2 + idx] = 1.0;
      }
    }
  }

  for (const card of player.tableau) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch3 + idx] = 1.0 + clamp((card.resourceCount ?? 0) * 0.1, 0, 2.0);
      if (isIActionCard(card) && !player.actionsThisGeneration.has(card.name)) {
        vec[ch5 + idx] = 1.0;
      }
    }
  }

  for (const card of opponent.tableau) {
    const idx = CARD_TO_INDEX.get(card.name);
    if (idx !== undefined) {
      vec[ch4 + idx] = 1.0 + clamp((card.resourceCount ?? 0) * 0.1, 0, 2.0);
      if (isIActionCard(card) && !opponent.actionsThisGeneration.has(card.name)) {
        vec[ch5 + idx] = -1.0;
      }
    }
  }

  return vec;
}
