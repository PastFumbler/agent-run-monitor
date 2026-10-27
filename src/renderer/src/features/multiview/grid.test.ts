import { describe, expect, it } from 'vitest';
import { gridFor, gridLabel, MAX_TILES_PER_PAGE, pageCap, paginate } from './grid';

// The table from docs/PLAN.md 5.3.
const EXPECTED: Record<number, string> = {
  1: '1x1',
  2: '2x1',
  3: '2x2',
  4: '2x2',
  5: '3x2',
  6: '3x2',
  7: '3x3',
  8: '3x3',
  9: '3x3',
  10: '4x3',
  11: '4x3',
  12: '4x3',
};

describe('gridFor', () => {
  it.each(Object.entries(EXPECTED).map(([n, g]) => [Number(n), g] as const))('%i tiles -> %s', (n, g) => {
    expect(gridLabel(gridFor(n))).toBe(g);
  });

  it('every grid has room for its tiles and no spare row', () => {
    for (let n = 1; n <= 12; n++) {
      const { cols, rows } = gridFor(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(cols * (rows - 1)).toBeLessThan(n);
    }
  });

  it('more than 12 uses the 12-tile grid (the rest goes to later pages)', () => {
    for (const n of [13, 24, 25, 100]) expect(gridFor(n)).toEqual({ cols: 4, rows: 3 });
  });

  it('nothing or nonsense falls back to one tile', () => {
    expect(gridFor(0)).toEqual({ cols: 1, rows: 1 });
    expect(gridFor(-3)).toEqual({ cols: 1, rows: 1 });
    expect(gridFor(Number.NaN)).toEqual({ cols: 1, rows: 1 });
  });
});

describe('pageCap', () => {
  it('follows the setting but never exceeds 12 or drops below 1', () => {
    expect(pageCap(12)).toBe(12);
    expect(pageCap(6)).toBe(6);
    expect(pageCap(40)).toBe(MAX_TILES_PER_PAGE);
    expect(pageCap(0)).toBe(1);
    expect(pageCap(Number.NaN)).toBe(12);
  });
});

describe('paginate', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

  it('one page up to the cap', () => {
    const p = paginate(ids(12), 12, 0);
    expect(p).toMatchObject({ pageCount: 1, page: 0, offset: 0 });
    expect(p.items).toHaveLength(12);
  });

  it('13 runs: a full page then a page of one', () => {
    expect(paginate(ids(13), 12, 0).items).toHaveLength(12);
    const last = paginate(ids(13), 12, 1);
    expect(last).toMatchObject({ pageCount: 2, page: 1, offset: 12, items: ['r12'] });
    expect(gridFor(last.items.length)).toEqual({ cols: 1, rows: 1 });
  });

  it('25 runs: 12 + 12 + 1', () => {
    expect([0, 1, 2].map((p) => paginate(ids(25), 12, p).items.length)).toEqual([12, 12, 1]);
    expect(paginate(ids(25), 12, 0).pageCount).toBe(3);
  });

  it('respects a smaller tile limit', () => {
    const p = paginate(ids(10), 4, 2);
    expect(p).toMatchObject({ pageCount: 3, page: 2, items: ['r8', 'r9'] });
  });

  it('clamps the page into range', () => {
    expect(paginate(ids(5), 12, 7).page).toBe(0);
    expect(paginate(ids(30), 12, 9).page).toBe(2);
    expect(paginate(ids(30), 12, -1).page).toBe(0);
    expect(paginate([], 12, 3)).toMatchObject({ pageCount: 1, page: 0, items: [] });
  });
});
