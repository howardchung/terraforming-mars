import {RequirementType} from '../../../common/cards/RequirementType';
import {IPlayer} from '../../IPlayer';
import {IProjectCard} from '../IProjectCard';

export type Options = {
  max: boolean,
  all: boolean,
  text: string | undefined,
  nextTo: boolean,
  count: number,
};

/**
 * Information to evaluate a card requirement.
 *
 * This represents requirements such as global parameters and tags.
 *
 * This base class contains some common attributes, but subclasses will contain
 * new data.
 */
export abstract class CardRequirement {
  /** The type of requirement this represents, e.g. Oxygen. */
  public abstract readonly type: RequirementType;
  /** The count for this requirement (e.g. 5%) */
  public readonly count: number;
  /** When true, this requirement is a maximum vs minimum requirement (e.g. max 5%) */
  public readonly max: boolean;
  /**
   * When true, requirement applies to everyone's tiles or tags, etc.
   * (e.g. you have 2 cities vs all players have 2 cities.)
   */
  public readonly all: boolean;
  /** Used during card rendering. */
  public readonly text: string | undefined;
  /** Used during card rendering. */
  public readonly nextTo: boolean;

  constructor(options?: Partial<Options>) {
    this.count = options?.count ?? 1;
    this.max = options?.max ?? false;
    this.all = options?.all ?? false;
    this.nextTo = options?.nextTo ?? false;
    this.text = options?.text;
  }

  /**
   * Evaluate whether |player| satisfies this requirement. It takes into account any
   * player modifiers (e.g. Adaptation Technology, and fan-based Think Tank.)
   *
   * |card| is the project card with this requirement. It is currently only used for
   * setting Think Tank costs.
   *
   * Returns true if |player| can satisfy the requirement, false if it cannot.
   */
  public abstract satisfies(player: IPlayer, card: IProjectCard) : boolean;
}
