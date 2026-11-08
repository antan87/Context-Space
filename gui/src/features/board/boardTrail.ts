/**
 * Places the board keeps to step back through after a jump.
 *
 * A jump from the Now line, the news list, the index, a count, a step button or a picture
 * records where you were before it: the level (overview or which Area), the open row, its
 * tab and page, the fold, and the card or button that had focus.
 */

export const BOARD_TRAIL_CAP = 20;

export interface BoardTrailFocus {
  nodeId?: string;
  ariaLabel?: string;
  testId?: string;
  id?: string;
  selector?: string;
  text?: string;
  navItem?: string;
  countKind?: string;
}

export interface BoardTrailPlace {
  /** 'overview' or areaId */
  level: string;
  /** Label for Back button ("Overview" or Area title) */
  title: string;
  /** Open row id within the Area, if in an Area */
  openRow?: string | null;
  /** Active tab within the Area */
  tab?: string | null;
  /** Active page within the open row */
  page?: number;
  /** Overview fold state */
  fold?: boolean;
  /** Descriptor of the element that had focus before the jump */
  focus?: BoardTrailFocus | null;
  /** Whether the narrow sidebar was open before the jump */
  narrowNavOpen?: boolean;
}

export interface BoardTrail {
  entries: BoardTrailPlace[];
}

export function createBoardTrail(): BoardTrail {
  return { entries: [] };
}

export function isSameBoardPlace(a: BoardTrailPlace, b: BoardTrailPlace): boolean {
  return (
    a.level === b.level &&
    (a.openRow ?? null) === (b.openRow ?? null) &&
    (a.tab ?? null) === (b.tab ?? null) &&
    (a.page ?? 0) === (b.page ?? 0) &&
    Boolean(a.fold) === Boolean(b.fold) &&
    Boolean(a.narrowNavOpen) === Boolean(b.narrowNavOpen)
  );
}

export function pushBoardTrail(trail: BoardTrail, place: BoardTrailPlace): BoardTrail {
  const last = trail.entries[trail.entries.length - 1];
  if (last && isSameBoardPlace(last, place)) {
    return {
      entries: [...trail.entries.slice(0, -1), place],
    };
  }
  return {
    entries: [...trail.entries, place].slice(-BOARD_TRAIL_CAP),
  };
}

export function canGoBackBoard(trail: BoardTrail): boolean {
  return trail.entries.length > 0;
}

export function backBoardTrail(trail: BoardTrail): BoardTrail {
  return canGoBackBoard(trail) ? { entries: trail.entries.slice(0, -1) } : trail;
}

export function backBoardTarget(trail: BoardTrail): BoardTrailPlace | null {
  return canGoBackBoard(trail) ? trail.entries[trail.entries.length - 1]! : null;
}

export function backBoardLabel(place: BoardTrailPlace): string {
  return place.title || (place.level === 'overview' ? 'Overview' : place.level);
}
