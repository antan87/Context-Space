import { describe, expect, it } from 'vitest';
import {
  BOARD_TRAIL_CAP,
  backBoardLabel,
  backBoardTarget,
  backBoardTrail,
  canGoBackBoard,
  createBoardTrail,
  isSameBoardPlace,
  pushBoardTrail,
  type BoardTrailPlace,
} from './boardTrail.js';

const overviewPlace: BoardTrailPlace = {
  level: 'overview',
  title: 'Overview',
  fold: false,
  focus: { testId: 'board-now-main' },
};

const area1Place: BoardTrailPlace = {
  level: 'checkpoint:reports',
  title: 'Reports CSV export',
  openRow: 'row:notes',
  tab: 'media',
  page: 1,
  fold: false,
  focus: { nodeId: 'checkpoint:reports', ariaLabel: 'Open 12 notes' },
};

const area2Place: BoardTrailPlace = {
  level: 'checkpoint:queue',
  title: 'Background job queue',
  openRow: null,
  tab: null,
  page: 0,
  fold: false,
  focus: null,
};

describe('boardTrail', () => {
  it('a new trail has nowhere to go back to', () => {
    const trail = createBoardTrail();
    expect(canGoBackBoard(trail)).toBe(false);
    expect(backBoardTarget(trail)).toBeNull();
    expect(backBoardTrail(trail)).toBe(trail);
  });

  it('push adds a place and back returns to it', () => {
    const trail = pushBoardTrail(createBoardTrail(), overviewPlace);
    expect(canGoBackBoard(trail)).toBe(true);
    expect(backBoardTarget(trail)).toEqual(overviewPlace);
    expect(backBoardLabel(overviewPlace)).toBe('Overview');

    const back = backBoardTrail(trail);
    expect(canGoBackBoard(back)).toBe(false);
    expect(backBoardTarget(back)).toBeNull();
    expect(back.entries).toEqual([]);
  });

  it('multiple jumps deep and stepping back one by one', () => {
    let trail = createBoardTrail();
    trail = pushBoardTrail(trail, overviewPlace);
    trail = pushBoardTrail(trail, area1Place);
    trail = pushBoardTrail(trail, area2Place);

    expect(trail.entries).toHaveLength(3);
    expect(backBoardTarget(trail)).toEqual(area2Place);
    expect(backBoardLabel(area2Place)).toBe('Background job queue');

    trail = backBoardTrail(trail);
    expect(trail.entries).toHaveLength(2);
    expect(backBoardTarget(trail)).toEqual(area1Place);
    expect(backBoardLabel(area1Place)).toBe('Reports CSV export');

    trail = backBoardTrail(trail);
    expect(trail.entries).toHaveLength(1);
    expect(backBoardTarget(trail)).toEqual(overviewPlace);

    trail = backBoardTrail(trail);
    expect(canGoBackBoard(trail)).toBe(false);
    expect(trail.entries).toHaveLength(0);
  });

  it('pushing the identical place adds nothing', () => {
    const trail = pushBoardTrail(createBoardTrail(), area1Place);
    const dup = pushBoardTrail(trail, { ...area1Place });
    expect(dup).toEqual(trail);
    expect(dup.entries).toHaveLength(1);
  });

  it('differentiates places with different row, tab, page or fold', () => {
    expect(isSameBoardPlace(area1Place, { ...area1Place, page: 2 })).toBe(false);
    expect(isSameBoardPlace(area1Place, { ...area1Place, tab: 'notes' })).toBe(false);
    expect(isSameBoardPlace(area1Place, { ...area1Place, openRow: 'row:commits' })).toBe(false);
    expect(isSameBoardPlace(overviewPlace, { ...overviewPlace, fold: true })).toBe(false);
  });

  it('caps entries at 20, dropping the oldest', () => {
    let trail = createBoardTrail();
    for (let i = 0; i < 30; i += 1) {
      trail = pushBoardTrail(trail, {
        level: `area:${i}`,
        title: `Area ${i}`,
        page: i,
      });
    }
    expect(trail.entries).toHaveLength(BOARD_TRAIL_CAP);
    expect(trail.entries[0]!.level).toBe('area:10');
    expect(trail.entries[BOARD_TRAIL_CAP - 1]!.level).toBe('area:29');
  });

  it('backBoardLabel falls back to level if title is empty', () => {
    expect(backBoardLabel({ level: 'checkpoint:test', title: '' })).toBe('checkpoint:test');
    expect(backBoardLabel({ level: 'overview', title: '' })).toBe('Overview');
  });

  it('replaces the old snapshot with the latest focus and title at the same place', () => {
    const trail1 = pushBoardTrail(createBoardTrail(), overviewPlace);
    expect(trail1.entries).toHaveLength(1);
    expect(trail1.entries[0]!.title).toBe('Overview');
    expect(trail1.entries[0]!.focus).toEqual({ testId: 'board-now-main' });

    const updatedOverview: BoardTrailPlace = {
      ...overviewPlace,
      title: 'Updated Overview',
      focus: { countKind: 'notes' },
    };
    const trail2 = pushBoardTrail(trail1, updatedOverview);
    expect(trail2.entries).toHaveLength(1);
    expect(trail2.entries[0]!.title).toBe('Updated Overview');
    expect(trail2.entries[0]!.focus).toEqual({ countKind: 'notes' });
  });
});
