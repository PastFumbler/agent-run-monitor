// Multiviewer layout math (docs/PLAN.md 5.3). Pure, so it is unit-tested on its own.
//
//   tiles  grid (cols x rows)
//   1      1x1  one tile, full width
//   2      2x1  side by side
//   3-4    2x2
//   5-6    3x2
//   7-9    3x3
//   10-12  4x3
//
// More runs than fit on a page are split into pages of `pageCap(limit)` tiles (at most 12).

export interface GridShape {
  cols: number;
  rows: number;
}

/** The most tiles a page can ever hold, whatever the setting says. */
export const MAX_TILES_PER_PAGE = 12;

/** Grid shape for a page holding `count` tiles. Counts above 12 use the 12-tile grid; 0 or less is 1x1. */
export function gridFor(count: number): GridShape {
  const n = Math.floor(count);
  if (!(n > 1)) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 3 };
}

/** "CxR", as rendered in data-grid. */
export function gridLabel(g: GridShape): string {
  return `${g.cols}x${g.rows}`;
}

/** Tiles per page: settings.gridTileLimit clamped to 1..12. */
export function pageCap(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_TILES_PER_PAGE;
  return Math.min(MAX_TILES_PER_PAGE, Math.max(1, Math.floor(limit)));
}

export interface Pagination<T> {
  /** Number of pages (at least 1, even when empty). */
  pageCount: number;
  /** The requested page, clamped into range. */
  page: number;
  /** Items on that page. */
  items: T[];
  /** Index of the page's first item in the full list. */
  offset: number;
}

/** Splits `all` into pages of `cap` and returns the requested page (clamped). */
export function paginate<T>(all: readonly T[], cap: number, page: number): Pagination<T> {
  const size = pageCap(cap);
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  const p = Math.min(pageCount - 1, Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)));
  const offset = p * size;
  return { pageCount, page: p, items: all.slice(offset, offset + size), offset };
}
