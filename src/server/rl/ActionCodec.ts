import {CardName} from '../../common/cards/CardName';
import {InputResponse} from '../../common/inputs/InputResponse';
import {Units} from '../../common/Units';
import {PRODUCTION_MINIMUMS} from '../../common/constants';
import {ICard} from '../cards/ICard';
import {IStandardProjectCard} from '../cards/IStandardProjectCard';
import {AndOptions} from '../inputs/AndOptions';
import {GainResources} from '../inputs/GainResources';
import {OrOptions} from '../inputs/OrOptions';
import {SelectAmount} from '../inputs/SelectAmount';
import {SelectCard} from '../inputs/SelectCard';
import {SelectInitialCards} from '../inputs/SelectInitialCards';
import {SelectOption} from '../inputs/SelectOption';
import {SelectPayment} from '../inputs/SelectPayment';
import {SelectPlayer} from '../inputs/SelectPlayer';
import {SelectProductionToLose} from '../inputs/SelectProductionToLose';
import {SelectProjectCardToPlay} from '../inputs/SelectProjectCardToPlay';
import {SelectResource} from '../inputs/SelectResource';
import {SelectResources} from '../inputs/SelectResources';
import {SelectSpace} from '../inputs/SelectSpace';
import {SelectStandardProjectToPlay} from '../inputs/SelectStandardProjectToPlay';
import {UndoActionOption} from '../inputs/UndoActionOption';
import {IPlayer} from '../IPlayer';
import {PlayerInput} from '../PlayerInput';
import {
  ACTION_CONFIRM_SELECTION,
  ACTION_CONVERT_HEAT,
  ACTION_CONVERT_PLANTS,
  ACTION_END_TURN,
  ACTION_OFFSET_AWARD,
  ACTION_OFFSET_BLUE_PROJECT,
  ACTION_OFFSET_CARD,
  ACTION_OFFSET_CORP_ACTION,
  ACTION_OFFSET_GENERIC,
  ACTION_OFFSET_MILESTONE,
  ACTION_OFFSET_RESOURCE,
  ACTION_OFFSET_SPACE,
  ACTION_OFFSET_STD_PROJECT,
  ACTION_PASS,
  ACTION_SPACE_SIZE,
  AWARD_TO_OFFSET,
  CARD_TO_INDEX,
  CORP_CARD_TO_OFFSET,
  MILESTONE_TO_OFFSET,
  NUM_GENERIC_ACTIONS,
  PROJECT_CARD_TO_OFFSET,
  RESOURCE_KEYS,
  SPACE_ID_TO_OFFSET,
  STANDARD_PROJECT_TO_OFFSET,
} from './CardIndex';
import {
  solvePaymentForProjectCard,
  solvePaymentForStandardProject,
  solveSelectPayment,
} from './PaymentSolver';

export interface PlayerStagingState {
  waitingForRef: PlayerInput | undefined;
  initialStage: 'corp' | 'prelude1' | 'prelude2' | 'projects';
  selectedCorp: CardName | undefined;
  selectedPreludes: Array<CardName>;
  selectedProjects: Array<CardName>;
  multiCardSelected: Array<CardName>;
  inSellPatentsSubstep: boolean;
  sellPatentsOptIdx: number;
  selectedUnits: Units;
}

export function createEmptyStagingState(): PlayerStagingState {
  return {
    waitingForRef: undefined,
    initialStage: 'corp',
    selectedCorp: undefined,
    selectedPreludes: [],
    selectedProjects: [],
    multiCardSelected: [],
    inSellPatentsSubstep: false,
    sellPatentsOptIdx: -1,
    selectedUnits: Units.of({}),
  };
}

export function syncStagingState(player: IPlayer, staging: PlayerStagingState): void {
  const wf = player.getWaitingFor();
  if (wf !== staging.waitingForRef) {
    staging.waitingForRef = wf;
    staging.initialStage = 'corp';
    staging.selectedCorp = undefined;
    staging.selectedPreludes = [];
    staging.selectedProjects = [];
    staging.multiCardSelected = [];
    staging.inSellPatentsSubstep = false;
    staging.sellPatentsOptIdx = -1;
    staging.selectedUnits = Units.of({});
  }
}

export interface ActionBinding {
  actionIndex: number;
  label: string;
  execute: () => InputResponse | undefined;
}

export interface DecodedActionSpace {
  mask: Array<boolean>;
  bindings: Map<number, ActionBinding>;
  promptTitle: string;
}

function titleToString(title: PlayerInput['title'] | undefined): string {
  if (!title) {
    return '';
  }
  if (typeof title === 'string') {
    return title;
  }
  return title.message ?? '';
}

function getCardActionIdx(cardName: CardName, fallbackCursor: {val: number}): number {
  const idx = CARD_TO_INDEX.get(cardName);
  if (idx !== undefined) {
    return ACTION_OFFSET_CARD + idx;
  }
  const fb = ACTION_OFFSET_GENERIC + (fallbackCursor.val % NUM_GENERIC_ACTIONS);
  fallbackCursor.val++;
  return fb;
}

function getBlueActionIdx(cardName: CardName, fallbackCursor: {val: number}): number {
  const projOffset = PROJECT_CARD_TO_OFFSET.get(cardName);
  if (projOffset !== undefined) {
    return ACTION_OFFSET_BLUE_PROJECT + projOffset;
  }
  const corpOffset = CORP_CARD_TO_OFFSET.get(cardName);
  if (corpOffset !== undefined) {
    return ACTION_OFFSET_CORP_ACTION + corpOffset;
  }
  const fb = ACTION_OFFSET_GENERIC + (fallbackCursor.val % NUM_GENERIC_ACTIONS);
  fallbackCursor.val++;
  return fb;
}

function isPaidBuySelectCard(selectCard: SelectCard<ICard>): boolean {
  const t = titleToString(selectCard.title).toLowerCase();
  const btn = (selectCard.buttonLabel ?? '').toLowerCase();
  return (
    t.includes('buy') ||
    btn.includes('buy') ||
    t.includes('select card(s) to buy') ||
    t.includes('cannot afford any cards')
  );
}

/**
 * Builds a guaranteed-valid default InputResponse for any PlayerInput, used for
 * nested inputs or emergency fallback.
 */
export function buildDefaultInputResponse(player: IPlayer, input: PlayerInput): InputResponse {
  if (input instanceof SelectOption) {
    return {type: 'option'};
  }
  if (input instanceof SelectSpace) {
    return {type: 'space', spaceId: input.spaces[0].id};
  }
  if (input instanceof SelectPayment) {
    return {type: 'payment', payment: solveSelectPayment(player, input)};
  }
  if (input instanceof SelectAmount) {
    const val = input.maxByDefault ? input.max : input.min;
    return {type: 'amount', amount: val};
  }
  if (input instanceof SelectPlayer) {
    return {type: 'player', player: input.players[0].color};
  }
  if (input instanceof SelectResource) {
    return {type: 'resource', resource: input.include[0]};
  }
  if (input instanceof SelectResources) {
    const units = Units.of({});
    units.megacredits = input.count;
    return {type: 'resources', units};
  }
  if (input instanceof GainResources) {
    const responses: Array<InputResponse> = [
      {type: 'amount', amount: input.count},
      {type: 'amount', amount: 0},
      {type: 'amount', amount: 0},
      {type: 'amount', amount: 0},
      {type: 'amount', amount: 0},
      {type: 'amount', amount: 0},
    ];
    return {type: 'and', responses};
  }
  if (input instanceof SelectProductionToLose) {
    const units = Units.of({});
    let rem = input.unitsToLose;
    for (const k of RESOURCE_KEYS) {
      const reducable = player.production[k] - PRODUCTION_MINIMUMS[k];
      if (reducable > 0 && rem > 0) {
        const take = Math.min(reducable, rem);
        units[k] = take;
        rem -= take;
      }
    }
    return {type: 'productionToLose', units};
  }
  if (input instanceof SelectProjectCardToPlay) {
    const card = input.cards[0];
    const meta = input.extras.get(card.name);
    const payment = solvePaymentForProjectCard(player, card, meta?.reserveUnits);
    return {type: 'projectCard', card: card.name, payment};
  }
  if (input instanceof SelectStandardProjectToPlay) {
    const enabledIdx = input.enabled ? input.enabled.findIndex((e) => e) : 0;
    const card = input.cards[Math.max(0, enabledIdx)];
    const meta = input.extras.get(card.name);
    const payment = solvePaymentForStandardProject(player, card, meta?.overriddenCost, meta?.reserveUnits);
    return {type: 'projectCard', card: card.name, payment};
  }
  if (input instanceof SelectCard) {
    const chosen: Array<CardName> = [];
    const paid = isPaidBuySelectCard(input);
    for (let i = 0; i < input.cards.length && chosen.length < input.config.min; i++) {
      if (input.config.enabled?.[i] === false) {
        continue;
      }
      if (paid && (chosen.length + 1) * player.cardCost > player.spendableMegacredits()) {
        break;
      }
      chosen.push(input.cards[i].name);
    }
    return {type: 'card', cards: chosen};
  }
  if (input instanceof OrOptions) {
    const idx = input.options.findIndex((o) => !(o instanceof UndoActionOption));
    const safeIdx = Math.max(0, idx);
    return {
      type: 'or',
      index: safeIdx,
      response: buildDefaultInputResponse(player, input.options[safeIdx]),
    };
  }
  if (input instanceof AndOptions) {
    return {
      type: 'and',
      responses: input.options.map((o) => buildDefaultInputResponse(player, o)),
    };
  }
  if (input instanceof SelectInitialCards) {
    const corp = player.dealtCorporationCards[0];
    const responses: Array<InputResponse> = [];
    for (const opt of input.options) {
      if (opt === input.inputs.corp) {
        responses.push({type: 'card', cards: [corp.name]});
      } else if (opt === input.inputs.prelude) {
        responses.push({
          type: 'card',
          cards: player.dealtPreludeCards.slice(0, 2).map((c) => c.name),
        });
      } else if (opt === input.inputs.project) {
        responses.push({type: 'card', cards: []});
      } else {
        responses.push(buildDefaultInputResponse(player, opt));
      }
    }
    return {type: 'initialCards', responses};
  }
  return {type: 'option'};
}

export function decodeActionSpace(player: IPlayer, staging: PlayerStagingState): DecodedActionSpace {
  syncStagingState(player, staging);
  const mask = new Array<boolean>(ACTION_SPACE_SIZE).fill(false);
  const bindings = new Map<number, ActionBinding>();
  const waitingFor = player.getWaitingFor();

  if (waitingFor === undefined) {
    return {mask, bindings, promptTitle: 'Waiting'};
  }

  const addBinding = (actionIndex: number, label: string, execute: () => InputResponse | undefined) => {
    if (actionIndex < 0 || actionIndex >= ACTION_SPACE_SIZE) {
      return;
    }
    if (!mask[actionIndex]) {
      mask[actionIndex] = true;
      bindings.set(actionIndex, {actionIndex, label, execute});
    }
  };

  const fallbackCursor = {val: 0};
  const promptTitle = titleToString(waitingFor.title);

  // 1. SelectInitialCards (decomposed into sequential corp -> prelude1 -> prelude2 -> projects)
  if (waitingFor instanceof SelectInitialCards) {
    const buildFinalInitialResponse = (): InputResponse => {
      const corpName = staging.selectedCorp ?? player.dealtCorporationCards[0].name;
      const preludes =
        staging.selectedPreludes.length === 2 ?
          staging.selectedPreludes :
          player.dealtPreludeCards.slice(0, 2).map((c) => c.name);
      const projects = staging.selectedProjects;
      const responses: Array<InputResponse> = [];
      for (const opt of waitingFor.options) {
        if (opt === waitingFor.inputs.corp) {
          responses.push({type: 'card', cards: [corpName]});
        } else if (opt === waitingFor.inputs.prelude) {
          responses.push({type: 'card', cards: [...preludes]});
        } else if (opt === waitingFor.inputs.project) {
          responses.push({type: 'card', cards: [...projects]});
        } else {
          responses.push(buildDefaultInputResponse(player, opt));
        }
      }
      return {type: 'initialCards', responses};
    };

    if (staging.initialStage === 'corp') {
      for (const corp of player.dealtCorporationCards) {
        const aIdx = getCardActionIdx(corp.name, fallbackCursor);
        addBinding(aIdx, `Pick Corporation: ${corp.name}`, () => {
          staging.selectedCorp = corp.name;
          if (waitingFor.inputs.prelude !== undefined && player.dealtPreludeCards.length >= 2) {
            staging.initialStage = 'prelude1';
            return undefined;
          }
          staging.initialStage = 'projects';
          return undefined;
        });
      }
      return {mask, bindings, promptTitle: 'Select Initial Corporation'};
    }

    if (staging.initialStage === 'prelude1') {
      for (const prel of player.dealtPreludeCards) {
        const aIdx = getCardActionIdx(prel.name, fallbackCursor);
        addBinding(aIdx, `Pick 1st Prelude: ${prel.name}`, () => {
          staging.selectedPreludes = [prel.name];
          staging.initialStage = 'prelude2';
          return undefined;
        });
      }
      return {mask, bindings, promptTitle: 'Select 1st Prelude'};
    }

    if (staging.initialStage === 'prelude2') {
      for (const prel of player.dealtPreludeCards) {
        if (staging.selectedPreludes.includes(prel.name)) {
          continue;
        }
        const aIdx = getCardActionIdx(prel.name, fallbackCursor);
        addBinding(aIdx, `Pick 2nd Prelude: ${prel.name}`, () => {
          staging.selectedPreludes.push(prel.name);
          staging.initialStage = 'projects';
          return undefined;
        });
      }
      return {mask, bindings, promptTitle: 'Select 2nd Prelude'};
    }

    // Stage: 'projects'
    const corpObj =
      player.dealtCorporationCards.find((c) => c.name === staging.selectedCorp) ??
      player.dealtCorporationCards[0];
    const cardCost = corpObj.cardCost !== undefined ? corpObj.cardCost : player.cardCost;
    const maxAffordable = Math.floor(corpObj.startingMegaCredits / cardCost);

    // Always allow finishing project card selection
    addBinding(
      ACTION_CONFIRM_SELECTION,
      `Confirm Initial Cards (${staging.selectedProjects.length} projects)`,
      () => buildFinalInitialResponse(),
    );

    if (staging.selectedProjects.length < maxAffordable) {
      for (const proj of player.dealtProjectCards) {
        if (staging.selectedProjects.includes(proj.name)) {
          continue;
        }
        const aIdx = getCardActionIdx(proj.name, fallbackCursor);
        addBinding(aIdx, `Keep Initial Project: ${proj.name}`, () => {
          staging.selectedProjects.push(proj.name);
          if (
            staging.selectedProjects.length >= maxAffordable ||
            staging.selectedProjects.length >= player.dealtProjectCards.length
          ) {
            return buildFinalInitialResponse();
          }
          return undefined;
        });
      }
    }
    return {mask, bindings, promptTitle: 'Select Initial Project Cards'};
  }

  // 2. Direct SelectSpace
  if (waitingFor instanceof SelectSpace) {
    for (const space of waitingFor.spaces) {
      const sOff = SPACE_ID_TO_OFFSET.get(space.id);
      const aIdx =
        sOff !== undefined ?
          ACTION_OFFSET_SPACE + sOff :
          ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
      addBinding(aIdx, `Select Space ${space.id}`, () => ({
        type: 'space',
        spaceId: space.id,
      }));
    }
    return {mask, bindings, promptTitle};
  }

  // 3. Direct SelectProjectCardToPlay
  if (waitingFor instanceof SelectProjectCardToPlay) {
    for (let i = 0; i < waitingFor.cards.length; i++) {
      if (waitingFor.enabled?.[i] === false) {
        continue;
      }
      const card = waitingFor.cards[i];
      const aIdx = getCardActionIdx(card.name, fallbackCursor);
      addBinding(aIdx, `Play Card: ${card.name}`, () => {
        const meta = waitingFor.extras.get(card.name);
        const payment = solvePaymentForProjectCard(player, card, meta?.reserveUnits);
        return {type: 'projectCard', card: card.name, payment};
      });
    }
    return {mask, bindings, promptTitle};
  }

  // 4. Direct SelectStandardProjectToPlay
  if (waitingFor instanceof SelectStandardProjectToPlay) {
    for (let i = 0; i < waitingFor.cards.length; i++) {
      if (waitingFor.enabled?.[i] === false) {
        continue;
      }
      const sp = waitingFor.cards[i];
      const spOff = STANDARD_PROJECT_TO_OFFSET.get(sp.name);
      const aIdx =
        spOff !== undefined ?
          ACTION_OFFSET_STD_PROJECT + spOff :
          ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
      addBinding(aIdx, `Standard Project: ${sp.name}`, () => {
        const meta = waitingFor.extras.get(sp.name);
        const payment = solvePaymentForStandardProject(player, sp, meta?.overriddenCost, meta?.reserveUnits);
        return {type: 'projectCard', card: sp.name, payment};
      });
    }
    return {mask, bindings, promptTitle};
  }

  // 5. Direct SelectCard
  if (waitingFor instanceof SelectCard) {
    const min = waitingFor.config.min;
    const max = waitingFor.config.max;
    const isBuy = isPaidBuySelectCard(waitingFor);
    const isBlue = waitingFor.config.selectBlueCardAction;

    const availableCards: Array<ICard> = [];
    for (let i = 0; i < waitingFor.cards.length; i++) {
      if (waitingFor.config.enabled?.[i] === false) {
        continue;
      }
      const c = waitingFor.cards[i];
      if (!staging.multiCardSelected.includes(c.name)) {
        availableCards.push(c);
      }
    }

    if (min === 1 && max === 1) {
      for (const card of availableCards) {
        const aIdx = isBlue ?
          getBlueActionIdx(card.name, fallbackCursor) :
          getCardActionIdx(card.name, fallbackCursor);
        addBinding(aIdx, `Select Card: ${card.name}`, () => ({
          type: 'card',
          cards: [card.name],
        }));
      }
      if (bindings.size === 0) {
        addBinding(ACTION_CONFIRM_SELECTION, 'Select 0 Cards', () => ({
          type: 'card',
          cards: [],
        }));
      }
      return {mask, bindings, promptTitle};
    }

    // Multi-card or 0..N card selection
    const curCount = staging.multiCardSelected.length;
    const canAffordNext = !isBuy || (curCount + 1) * player.cardCost <= player.spendableMegacredits();

    if (curCount >= min) {
      addBinding(
        ACTION_CONFIRM_SELECTION,
        `Confirm Selected Cards (${curCount})`,
        () => ({
          type: 'card',
          cards: [...staging.multiCardSelected],
        }),
      );
    }

    if (curCount < max && canAffordNext && availableCards.length > 0) {
      for (const card of availableCards) {
        const aIdx = getCardActionIdx(card.name, fallbackCursor);
        addBinding(aIdx, `Select Card (${curCount + 1}/${max}): ${card.name}`, () => {
          staging.multiCardSelected.push(card.name);
          const nextCount = staging.multiCardSelected.length;
          const canAffordMore = !isBuy || (nextCount + 1) * player.cardCost <= player.spendableMegacredits();
          const remainingEnabled = availableCards.length - 1;
          if (
            nextCount >= max ||
            remainingEnabled === 0 ||
            (!canAffordMore && nextCount >= min)
          ) {
            return {
              type: 'card',
              cards: [...staging.multiCardSelected],
            };
          }
          return undefined;
        });
      }
    }

    // Safety fallback if nothing could be added
    if (bindings.size === 0) {
      addBinding(ACTION_CONFIRM_SELECTION, 'Confirm Cards', () =>
        buildDefaultInputResponse(player, waitingFor),
      );
    }
    return {mask, bindings, promptTitle};
  }

  // 6. OrOptions (Main Action Phase or Card/Greenery Choices)
  if (waitingFor instanceof OrOptions) {
    // Check if we are in the Sell Patents sub-step of getActions()
    if (
      staging.inSellPatentsSubstep &&
      staging.sellPatentsOptIdx >= 0 &&
      staging.sellPatentsOptIdx < waitingFor.options.length
    ) {
      const sellOpt = waitingFor.options[staging.sellPatentsOptIdx];
      if (sellOpt instanceof SelectCard) {
        const curCount = staging.multiCardSelected.length;
        if (curCount >= 1) {
          addBinding(ACTION_CONFIRM_SELECTION, `Sell ${curCount} Patent(s)`, () => ({
            type: 'or',
            index: staging.sellPatentsOptIdx,
            response: {type: 'card', cards: [...staging.multiCardSelected]},
          }));
        }
        for (const card of sellOpt.cards) {
          if (staging.multiCardSelected.includes(card.name)) {
            continue;
          }
          const aIdx = getCardActionIdx(card.name, fallbackCursor);
          addBinding(aIdx, `Mark Patent to Sell: ${card.name}`, () => {
            staging.multiCardSelected.push(card.name);
            if (staging.multiCardSelected.length >= sellOpt.cards.length) {
              return {
                type: 'or',
                index: staging.sellPatentsOptIdx,
                response: {type: 'card', cards: [...staging.multiCardSelected]},
              };
            }
            return undefined;
          });
        }
        return {mask, bindings, promptTitle: 'Sell Patents'};
      }
    }

    for (let optIdx = 0; optIdx < waitingFor.options.length; optIdx++) {
      const opt = waitingFor.options[optIdx];
      if (opt instanceof UndoActionOption) {
        continue;
      }
      const optTitle = titleToString(opt.title);
      const optTitleLower = optTitle.toLowerCase();

      if (opt instanceof SelectProjectCardToPlay) {
        for (let i = 0; i < opt.cards.length; i++) {
          if (opt.enabled?.[i] === false) {
            continue;
          }
          const card = opt.cards[i];
          const aIdx = getCardActionIdx(card.name, fallbackCursor);
          addBinding(aIdx, `Play Project Card: ${card.name}`, () => {
            const meta = opt.extras.get(card.name);
            const payment = solvePaymentForProjectCard(player, card, meta?.reserveUnits);
            return {
              type: 'or',
              index: optIdx,
              response: {type: 'projectCard', card: card.name, payment},
            };
          });
        }
        continue;
      }

      if (opt instanceof SelectStandardProjectToPlay) {
        for (let i = 0; i < opt.cards.length; i++) {
          if (opt.enabled?.[i] === false) {
            continue;
          }
          const sp: IStandardProjectCard = opt.cards[i];
          const spOff = STANDARD_PROJECT_TO_OFFSET.get(sp.name);
          const aIdx =
            spOff !== undefined ?
              ACTION_OFFSET_STD_PROJECT + spOff :
              ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, `Standard Project: ${sp.name}`, () => {
            const meta = opt.extras.get(sp.name);
            const payment = solvePaymentForStandardProject(
              player,
              sp,
              meta?.overriddenCost,
              meta?.reserveUnits,
            );
            return {
              type: 'or',
              index: optIdx,
              response: {type: 'projectCard', card: sp.name, payment},
            };
          });
        }
        continue;
      }

      if (opt instanceof SelectCard) {
        if (opt.config.selectBlueCardAction || optTitleLower.includes('action from a played card')) {
          for (let i = 0; i < opt.cards.length; i++) {
            if (opt.config.enabled?.[i] === false) {
              continue;
            }
            const card = opt.cards[i];
            const aIdx = getBlueActionIdx(card.name, fallbackCursor);
            addBinding(aIdx, `Use Card Action: ${card.name}`, () => ({
              type: 'or',
              index: optIdx,
              response: {type: 'card', cards: [card.name]},
            }));
          }
          continue;
        }

        if (optTitleLower.includes('sell patents')) {
          const sellOff = STANDARD_PROJECT_TO_OFFSET.get(CardName.SELL_PATENTS_STANDARD_PROJECT) ?? 5;
          addBinding(ACTION_OFFSET_STD_PROJECT + sellOff, 'Sell Patents', () => {
            if (opt.cards.length === 1) {
              return {
                type: 'or',
                index: optIdx,
                response: {type: 'card', cards: [opt.cards[0].name]},
              };
            }
            staging.inSellPatentsSubstep = true;
            staging.sellPatentsOptIdx = optIdx;
            staging.multiCardSelected = [];
            return undefined;
          });
          continue;
        }

        // Other SelectCard inside OrOptions (e.g. Prelude play, discard card, etc.)
        if (opt.config.min === 1 && opt.config.max === 1) {
          for (let i = 0; i < opt.cards.length; i++) {
            if (opt.config.enabled?.[i] === false) {
              continue;
            }
            const card = opt.cards[i];
            const aIdx = getCardActionIdx(card.name, fallbackCursor);
            addBinding(aIdx, `${optTitle || 'Select Card'}: ${card.name}`, () => ({
              type: 'or',
              index: optIdx,
              response: {type: 'card', cards: [card.name]},
            }));
          }
        } else {
          const aIdx = ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, optTitle || `Card Option ${optIdx}`, () => ({
            type: 'or',
            index: optIdx,
            response: buildDefaultInputResponse(player, opt),
          }));
        }
        continue;
      }

      if (opt instanceof OrOptions) {
        if (optTitleLower.includes('claim a milestone')) {
          for (let mIdx = 0; mIdx < opt.options.length; mIdx++) {
            const mOpt = opt.options[mIdx];
            const mName = titleToString(mOpt.title);
            const mOff = MILESTONE_TO_OFFSET.get(mName);
            const aIdx =
              mOff !== undefined ?
                ACTION_OFFSET_MILESTONE + mOff :
                ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
            addBinding(aIdx, `Claim Milestone: ${mName}`, () => ({
              type: 'or',
              index: optIdx,
              response: {
                type: 'or',
                index: mIdx,
                response: {type: 'option'},
              },
            }));
          }
          continue;
        }

        if (optTitleLower.includes('fund an award')) {
          for (let aSubIdx = 0; aSubIdx < opt.options.length; aSubIdx++) {
            const aOpt = opt.options[aSubIdx];
            const aName = titleToString(aOpt.title);
            const aOff = AWARD_TO_OFFSET.get(aName);
            const aIdx =
              aOff !== undefined ?
                ACTION_OFFSET_AWARD + aOff :
                ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
            addBinding(aIdx, `Fund Award: ${aName}`, () => ({
              type: 'or',
              index: optIdx,
              response: {
                type: 'or',
                index: aSubIdx,
                response: {type: 'option'},
              },
            }));
          }
          continue;
        }

        // Other nested OrOptions
        for (let subIdx = 0; subIdx < opt.options.length; subIdx++) {
          const subOpt = opt.options[subIdx];
          const aIdx = ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, `${optTitle} -> ${titleToString(subOpt.title)}`, () => ({
            type: 'or',
            index: optIdx,
            response: {
              type: 'or',
              index: subIdx,
              response: buildDefaultInputResponse(player, subOpt),
            },
          }));
        }
        continue;
      }

      if (opt instanceof SelectSpace) {
        if (optTitleLower.includes('convert') && optTitleLower.includes('plants')) {
          addBinding(ACTION_CONVERT_PLANTS, `Convert Plants (${opt.spaces[0].id})`, () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'space', spaceId: opt.spaces[0].id},
          }));
        }
        for (const space of opt.spaces) {
          const sOff = SPACE_ID_TO_OFFSET.get(space.id);
          const aIdx =
            sOff !== undefined ?
              ACTION_OFFSET_SPACE + sOff :
              ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, `${optTitle || 'Place Tile'} at ${space.id}`, () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'space', spaceId: space.id},
          }));
        }
        continue;
      }

      if (opt instanceof SelectOption) {
        if (optTitleLower.includes('convert') && optTitleLower.includes('heat')) {
          addBinding(ACTION_CONVERT_HEAT, 'Convert 8 Heat into Temperature', () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'option'},
          }));
        } else if (optTitleLower === 'end turn') {
          addBinding(ACTION_END_TURN, 'End Turn', () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'option'},
          }));
        } else if (
          optTitleLower.includes('pass for this generation') ||
          optTitleLower.includes("don't place a greenery")
        ) {
          addBinding(ACTION_PASS, optTitle || 'Pass', () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'option'},
          }));
        } else if (optTitleLower.includes('first action of') && player.pendingInitialActions.length > 0) {
          const corp = player.pendingInitialActions[0];
          const corpOff = CORP_CARD_TO_OFFSET.get(corp.name);
          const aIdx =
            corpOff !== undefined ?
              ACTION_OFFSET_CORP_ACTION + corpOff :
              ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, `Initial Action: ${corp.name}`, () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'option'},
          }));
        } else {
          const aIdx = ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
          addBinding(aIdx, optTitle || `Option ${optIdx + 1}`, () => ({
            type: 'or',
            index: optIdx,
            response: {type: 'option'},
          }));
        }
        continue;
      }

      // Any other child option inside OrOptions (SelectAmount, SelectPlayer, SelectResource, etc.)
      const aIdx = ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
      addBinding(aIdx, optTitle || `Choice ${optIdx + 1}`, () => ({
        type: 'or',
        index: optIdx,
        response: buildDefaultInputResponse(player, opt),
      }));
    }

    if (bindings.size === 0) {
      addBinding(ACTION_CONFIRM_SELECTION, 'Default Option', () =>
        buildDefaultInputResponse(player, waitingFor),
      );
    }
    return {mask, bindings, promptTitle};
  }

  // 7. Direct SelectPayment
  if (waitingFor instanceof SelectPayment) {
    addBinding(ACTION_CONFIRM_SELECTION, `Pay ${waitingFor.amount} M€`, () => ({
      type: 'payment',
      payment: solveSelectPayment(player, waitingFor),
    }));
    return {mask, bindings, promptTitle};
  }

  // 8. Direct SelectOption
  if (waitingFor instanceof SelectOption) {
    addBinding(ACTION_CONFIRM_SELECTION, promptTitle || 'Confirm', () => ({
      type: 'option',
    }));
    return {mask, bindings, promptTitle};
  }

  // 9. Direct SelectAmount
  if (waitingFor instanceof SelectAmount) {
    const min = waitingFor.min;
    const max = waitingFor.max;
    const span = max - min;
    if (span <= 0) {
      addBinding(ACTION_OFFSET_GENERIC, `Amount: ${min}`, () => ({
        type: 'amount',
        amount: min,
      }));
    } else {
      const steps = Math.min(span + 1, NUM_GENERIC_ACTIONS);
      for (let i = 0; i < steps; i++) {
        const amt =
          i === steps - 1 ?
            max :
            min + Math.round((i * span) / Math.max(1, steps - 1));
        addBinding(ACTION_OFFSET_GENERIC + i, `Amount: ${amt}`, () => ({
          type: 'amount',
          amount: amt,
        }));
      }
    }
    return {mask, bindings, promptTitle};
  }

  // 10. Direct SelectPlayer
  if (waitingFor instanceof SelectPlayer) {
    for (let i = 0; i < waitingFor.players.length; i++) {
      const target = waitingFor.players[i];
      addBinding(
        ACTION_OFFSET_GENERIC + (i % NUM_GENERIC_ACTIONS),
        `Target Player: ${target.name} (${target.color})`,
        () => ({
          type: 'player',
          player: target.color,
        }),
      );
    }
    return {mask, bindings, promptTitle};
  }

  // 11. Direct SelectResource
  if (waitingFor instanceof SelectResource) {
    for (const resKey of waitingFor.include) {
      const rIdx = RESOURCE_KEYS.indexOf(resKey);
      const aIdx =
        rIdx >= 0 ?
          ACTION_OFFSET_RESOURCE + rIdx :
          ACTION_OFFSET_GENERIC + (fallbackCursor.val++ % NUM_GENERIC_ACTIONS);
      addBinding(aIdx, `Select Resource: ${resKey}`, () => ({
        type: 'resource',
        resource: resKey,
      }));
    }
    return {mask, bindings, promptTitle};
  }

  // 12. Direct SelectResources or GainResources
  if (waitingFor instanceof SelectResources || waitingFor instanceof GainResources) {
    const totalNeeded = waitingFor.count;
    for (let rIdx = 0; rIdx < RESOURCE_KEYS.length; rIdx++) {
      const resKey = RESOURCE_KEYS[rIdx];
      addBinding(ACTION_OFFSET_RESOURCE + rIdx, `Gain ${resKey}`, () => {
        staging.selectedUnits[resKey] += 1;
        const currentSum = RESOURCE_KEYS.reduce((acc, k) => acc + staging.selectedUnits[k], 0);
        if (currentSum >= totalNeeded) {
          if (waitingFor instanceof GainResources) {
            return {
              type: 'and',
              responses: RESOURCE_KEYS.map((k) => ({
                type: 'amount',
                amount: staging.selectedUnits[k],
              })),
            };
          }
          return {
            type: 'resources',
            units: {...staging.selectedUnits},
          };
        }
        return undefined;
      });
    }
    return {mask, bindings, promptTitle};
  }

  // 13. Direct SelectProductionToLose
  if (waitingFor instanceof SelectProductionToLose) {
    const totalToLose = waitingFor.unitsToLose;
    for (let rIdx = 0; rIdx < RESOURCE_KEYS.length; rIdx++) {
      const resKey = RESOURCE_KEYS[rIdx];
      const minProd = PRODUCTION_MINIMUMS[resKey];
      const alreadyLosing = staging.selectedUnits[resKey];
      if (player.production[resKey] - alreadyLosing > minProd) {
        addBinding(ACTION_OFFSET_RESOURCE + rIdx, `Lose 1 ${resKey} Production`, () => {
          staging.selectedUnits[resKey] += 1;
          const currentSum = RESOURCE_KEYS.reduce((acc, k) => acc + staging.selectedUnits[k], 0);
          if (currentSum >= totalToLose) {
            return {
              type: 'productionToLose',
              units: {...staging.selectedUnits},
            };
          }
          return undefined;
        });
      }
    }
    if (bindings.size === 0) {
      addBinding(ACTION_CONFIRM_SELECTION, 'Lose Production', () =>
        buildDefaultInputResponse(player, waitingFor),
      );
    }
    return {mask, bindings, promptTitle};
  }

  // 14. Generic fallback for any other AndOptions or custom PlayerInput
  addBinding(ACTION_CONFIRM_SELECTION, promptTitle || 'Confirm Action', () =>
    buildDefaultInputResponse(player, waitingFor),
  );
  return {mask, bindings, promptTitle};
}
