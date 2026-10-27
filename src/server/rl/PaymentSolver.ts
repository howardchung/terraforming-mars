import {CardName} from '../../common/cards/CardName';
import {CardType} from '../../common/cards/CardType';
import {DEFAULT_PAYMENT_VALUES, Payment, PaymentOptions} from '../../common/inputs/Payment';
import {Tag} from '../../common/cards/Tag';
import {Units} from '../../common/Units';
import {IProjectCard} from '../cards/IProjectCard';
import {IStandardProjectCard} from '../cards/IStandardProjectCard';
import {SelectPayment} from '../inputs/SelectPayment';
import {IPlayer} from '../IPlayer';
import {MoonExpansion} from '../moon/MoonExpansion';

export function solvePayment(
  player: IPlayer,
  targetCost: number,
  options: Partial<PaymentOptions>,
  reserveUnits: Readonly<Units> = Units.EMPTY,
): Payment {
  const payment: Payment = {...Payment.EMPTY};
  if (targetCost <= 0) {
    return payment;
  }

  const availMc = Math.max(0, player.megaCredits - (reserveUnits.megacredits ?? 0));
  const availSteel = Math.max(0, player.steel - (reserveUnits.steel ?? 0));
  const availTitanium = Math.max(0, player.titanium - (reserveUnits.titanium ?? 0));
  const availHeat = Math.max(0, player.heat - (reserveUnits.heat ?? 0));
  const availPlants = Math.max(0, player.plants - (reserveUnits.plants ?? 0));
  const availMicrobes = player.getSpendable('microbes');
  const availFloaters = player.getSpendable('floaters');
  const availSeeds = player.getSpendable('seeds');

  const steelVal = player.getSteelValue();
  let titaniumVal = player.getTitaniumValue();
  let canUseTitanium = Boolean(options.titanium);
  if (!canUseTitanium && player.canUseTitaniumAsMegacredits) {
    canUseTitanium = true;
    titaniumVal = Math.max(1, titaniumVal - 1);
  }
  const canUseSteel = Boolean(options.steel);
  const canUseHeat = Boolean(options.heat ?? player.canUseHeatAsMegaCredits);
  const canUsePlants = Boolean(options.plants ?? player.canUsePlantsAsMegacredits);
  const canUseMicrobes = Boolean(options.microbes);
  const canUseFloaters = Boolean(options.floaters);
  const canUseSeeds = Boolean(options.seeds);

  let remaining = targetCost;

  // 1. Spend card-specific resources without overpaying first
  if (canUseSeeds && availSeeds > 0 && remaining > 0) {
    const val = DEFAULT_PAYMENT_VALUES.seeds;
    const use = Math.min(availSeeds, Math.floor(remaining / val));
    payment.seeds += use;
    remaining -= use * val;
  }
  if (canUseFloaters && availFloaters > 0 && remaining > 0) {
    const val = DEFAULT_PAYMENT_VALUES.floaters;
    const use = Math.min(availFloaters, Math.floor(remaining / val));
    payment.floaters += use;
    remaining -= use * val;
  }
  if (canUseMicrobes && availMicrobes > 0 && remaining > 0) {
    const val = DEFAULT_PAYMENT_VALUES.microbes;
    const use = Math.min(availMicrobes, Math.floor(remaining / val));
    payment.microbes += use;
    remaining -= use * val;
  }

  // 2. Spend titanium & steel without overpaying first
  if (canUseTitanium && availTitanium > 0 && remaining > 0) {
    const use = Math.min(availTitanium, Math.floor(remaining / titaniumVal));
    payment.titanium += use;
    remaining -= use * titaniumVal;
  }
  if (canUseSteel && availSteel > 0 && remaining > 0) {
    const use = Math.min(availSteel, Math.floor(remaining / steelVal));
    payment.steel += use;
    remaining -= use * steelVal;
  }
  if (canUsePlants && availPlants > 0 && remaining > 0) {
    const val = DEFAULT_PAYMENT_VALUES.plants;
    const use = Math.min(availPlants, Math.floor(remaining / val));
    payment.plants += use;
    remaining -= use * val;
  }

  // 3. Spend megacredits
  if (availMc > 0 && remaining > 0) {
    const use = Math.min(availMc, remaining);
    payment.megacredits += use;
    remaining -= use;
  }

  // 4. Spend heat (Helion)
  if (canUseHeat && availHeat > 0 && remaining > 0) {
    const use = Math.min(availHeat, remaining);
    payment.heat += use;
    remaining -= use;
  }

  // 5. If still remaining > 0, we need to overpay with a larger denomination resource
  // Reclaim M€/heat if we add a larger denomination unit so we don't waste M€!
  const addOverpayUnit = (
    canUse: boolean,
    avail: number,
    key: keyof Payment,
    unitVal: number,
  ) => {
    while (canUse && payment[key] < avail && remaining > 0) {
      payment[key]++;
      remaining -= unitVal;
    }
  };

  addOverpayUnit(canUseMicrobes, availMicrobes, 'microbes', DEFAULT_PAYMENT_VALUES.microbes);
  addOverpayUnit(canUsePlants, availPlants, 'plants', DEFAULT_PAYMENT_VALUES.plants);
  addOverpayUnit(canUseSteel, availSteel, 'steel', steelVal);
  addOverpayUnit(canUseTitanium, availTitanium, 'titanium', titaniumVal);
  addOverpayUnit(canUseFloaters, availFloaters, 'floaters', DEFAULT_PAYMENT_VALUES.floaters);
  addOverpayUnit(canUseSeeds, availSeeds, 'seeds', DEFAULT_PAYMENT_VALUES.seeds);

  // If we overpaid (`remaining < 0`), refund any excess heat or M€ we committed earlier
  if (remaining < 0) {
    let overpaid = -remaining;
    if (payment.heat > 0) {
      const refundHeat = Math.min(payment.heat, overpaid);
      payment.heat -= refundHeat;
      overpaid -= refundHeat;
    }
    if (payment.megacredits > 0 && overpaid > 0) {
      const refundMc = Math.min(payment.megacredits, overpaid);
      payment.megacredits -= refundMc;
      overpaid -= refundMc;
    }
  }

  return payment;
}

export function solvePaymentForProjectCard(
  player: IPlayer,
  card: IProjectCard,
  reserveOverride?: Readonly<Units>,
): Payment {
  const cost = player.getCardCost(card);
  const reserveUnits = reserveOverride ?? MoonExpansion.adjustedReserveCosts(player, card);
  const options: Partial<PaymentOptions> = {
    heat: player.canUseHeatAsMegaCredits,
    steel: player.lastCardPlayed === CardName.LAST_RESORT_INGENUITY || card.tags.includes(Tag.BUILDING),
    plants: card.tags.includes(Tag.BUILDING) && player.playedCards.has(CardName.MARTIAN_LUMBER_CORP),
    titanium: player.lastCardPlayed === CardName.LAST_RESORT_INGENUITY || card.tags.includes(Tag.SPACE),
    lunaTradeFederationTitanium: player.canUseTitaniumAsMegacredits,
    seeds: card.tags.includes(Tag.PLANT) || card.name === CardName.GREENERY_STANDARD_PROJECT,
    floaters: card.tags.includes(Tag.VENUS),
    microbes: card.tags.includes(Tag.PLANT),
    lunaArchivesScience: card.tags.includes(Tag.MOON),
    spireScience: card.type === CardType.STANDARD_PROJECT,
    auroraiData: card.type === CardType.STANDARD_PROJECT,
    graphene: card.tags.includes(Tag.CITY) || card.tags.includes(Tag.SPACE),
    kuiperAsteroids: card.name === CardName.AQUIFER_STANDARD_PROJECT || card.name === CardName.ASTEROID_STANDARD_PROJECT,
  };
  return solvePayment(player, cost, options, reserveUnits);
}

export function solvePaymentForStandardProject(
  player: IPlayer,
  card: IStandardProjectCard,
  overriddenCost?: number,
  reserveOverride?: Readonly<Units>,
): Payment {
  const cost = overriddenCost ?? card.getAdjustedCost(player);
  const canPayWith = card.canPayWith(player);
  const reserveUnits = reserveOverride ?? Units.EMPTY;
  const options: Partial<PaymentOptions> = {
    heat: player.canUseHeatAsMegaCredits,
    steel: canPayWith.steel,
    titanium: canPayWith.titanium,
    lunaTradeFederationTitanium: player.canUseTitaniumAsMegacredits,
    seeds: canPayWith.seeds,
    auroraiData: player.tableau.has(CardName.AURORAI),
    spireScience: player.tableau.has(CardName.SPIRE),
    kuiperAsteroids: canPayWith.kuiperAsteroids ? player.tableau.has(CardName.KUIPER_COOPERATIVE) : false,
  };
  return solvePayment(player, cost, options, reserveUnits);
}

export function solveSelectPayment(
  player: IPlayer,
  selectPayment: SelectPayment,
): Payment {
  return solvePayment(
    player,
    selectPayment.amount,
    selectPayment.paymentOptions,
    selectPayment.reserveUnits ?? Units.EMPTY,
  );
}
