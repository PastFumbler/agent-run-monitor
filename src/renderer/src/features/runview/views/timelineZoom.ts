// Timeline zoom maths, kept pure so it can be unit-tested: zoom clamps, wheel steps, the
// anchor that keeps a moment under the pointer while zooming, and adaptive time-axis ticks.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Buttons and the + / - keys zoom by this factor. */
export const ZOOM_STEP = 2;
/** Upper bound on the zoom factor, whatever the run length (keeps the track a sane width). */
export const MAX_ZOOM = 2000;
/** Fully zoomed in, the visible window never gets narrower than this (a few whole-second ticks). */
export const MIN_VISIBLE_MS = 5 * SEC;
/** Tick labels are at least this far apart, so they never overlap at any zoom ("03:06:30 PM" fits). */
export const MIN_TICK_GAP_PX = 96;
/** The gap for 24-hour labels, which are shorter ("15:06:30"). */
export const MIN_TICK_GAP_24H_PX = 72;

/** The largest useful zoom for a run of `spanMs`: 1 when the run is already that short. */
export function maxZoom(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 1;
  return Math.max(1, Math.min(MAX_ZOOM, spanMs / MIN_VISIBLE_MS));
}

export function clampZoom(zoom: number, spanMs: number): number {
  if (!Number.isFinite(zoom) || zoom < 1) return 1;
  return Math.min(maxZoom(spanMs), zoom);
}

/** The zoom after one Ctrl+wheel event: wheel up (negative deltaY) zooms in, smoothly for trackpads. */
export function wheelZoom(zoom: number, deltaY: number, deltaMode = 0): number {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const step = Math.max(-200, Math.min(200, px));
  return zoom * Math.exp(-step * 0.004);
}

/** Text for the zoom factor: "2×", "3.5×", "120×". */
export function zoomLabel(zoom: number): string {
  const z = zoom < 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom);
  return `${z}×`;
}

/**
 * The scroll position that puts the moment `t` at `offsetPx` from the left of the visible track,
 * for a track of `trackPx` covering [start, start + span].
 */
export function scrollFor(t: number, offsetPx: number, start: number, span: number, trackPx: number): number {
  if (span <= 0) return 0;
  return ((t - start) / span) * trackPx - offsetPx;
}

/** The moment at `offsetPx` into the visible track when scrolled to `scrollLeft`. */
export function timeAt(scrollLeft: number, offsetPx: number, start: number, span: number, trackPx: number): number {
  if (trackPx <= 0) return start;
  return start + ((scrollLeft + offsetPx) / trackPx) * span;
}

const STEPS = [
  SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC,
  MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY,
];

/** The smallest round step that keeps labels at least `minGapPx` apart over `widthPx`. */
export function tickStep(visibleMs: number, widthPx: number, minGapPx = MIN_TICK_GAP_PX): number {
  const w = widthPx > 0 ? widthPx : 600;
  for (const s of STEPS) if ((s / visibleMs) * w >= minGapPx) return s;
  // Runs spanning months: whole weeks, as many as it takes to keep the labels apart.
  return Math.ceil((minGapPx * visibleMs) / w / (7 * DAY)) * 7 * DAY;
}

const MAX_TICKS = 60;

/** Round local clock times in [from, to], every `step` ms (whole hours and days follow the local calendar). */
export function ticks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  if (!(to >= from) || !(step > 0)) return out;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (step < HOUR) {
    const base = d.getTime();
    for (let t = base + Math.ceil((from - base) / step) * step; t <= to && out.length < MAX_TICKS; t += step) out.push(t);
    return out;
  }
  // Hours and days: step the calendar so daylight-saving changes don't shift the labels.
  const hours = step / HOUR;
  for (let guard = 0; d.getTime() < from && guard < 400; guard++) advance(d, hours);
  while (d.getTime() <= to && out.length < MAX_TICKS) {
    out.push(d.getTime());
    advance(d, hours);
  }
  return out;
}

function advance(d: Date, hours: number): void {
  if (hours >= 24) d.setDate(d.getDate() + hours / 24);
  else d.setHours(d.getHours() + hours);
}

/** A tick's label: seconds when the step is under a minute, the date at midnight or for day steps. */
export function tickLabel(t: number, step: number, fmt: '12h' | '24h'): string {
  const d = new Date(t);
  const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  if (step >= DAY || (step >= HOUR && midnight)) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: step < MIN ? '2-digit' : undefined,
    hour12: fmt === '12h',
  });
}
