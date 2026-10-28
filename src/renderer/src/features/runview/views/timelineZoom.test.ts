import { describe, expect, it } from 'vitest';
import { clampZoom, MAX_ZOOM, maxZoom, MIN_TICK_GAP_PX, scrollFor, tickLabel, ticks, tickStep, timeAt, wheelZoom, zoomLabel } from './timelineZoom';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('zoom clamps', () => {
  it('never zooms out past the whole run', () => {
    expect(clampZoom(0.5, HOUR)).toBe(1);
    expect(clampZoom(Number.NaN, HOUR)).toBe(1);
    expect(clampZoom(-3, HOUR)).toBe(1);
  });

  it('stops when five seconds fill the view, and never past MAX_ZOOM', () => {
    expect(maxZoom(60 * SEC)).toBe(12);
    expect(clampZoom(1000, 60 * SEC)).toBe(12);
    expect(maxZoom(30 * DAY)).toBe(MAX_ZOOM);
  });

  it('cannot zoom a run of five seconds or less', () => {
    expect(maxZoom(5 * SEC)).toBe(1);
    expect(maxZoom(0)).toBe(1);
    expect(clampZoom(4, 800)).toBe(1);
  });
});

describe('wheelZoom', () => {
  it('wheel up zooms in, wheel down zooms out, by the same factor', () => {
    const inn = wheelZoom(4, -100);
    const out = wheelZoom(4, 100);
    expect(inn).toBeGreaterThan(4);
    expect(out).toBeLessThan(4);
    expect(inn * out).toBeCloseTo(16, 6);
  });

  it('treats line and page deltas as bigger steps, capped per event', () => {
    expect(wheelZoom(1, -3, 1)).toBeCloseTo(wheelZoom(1, -48, 0), 9);
    expect(wheelZoom(1, -10, 2)).toBeCloseTo(wheelZoom(1, -200, 0), 9);
  });
});

describe('anchoring', () => {
  it('keeps the moment under the pointer still across a zoom', () => {
    const start = 1_000_000;
    const span = 10 * MIN;
    const vw = 800;
    const pointer = 300;
    // At 2x, scrolled to 400 px.
    const t = timeAt(400, pointer, start, span, vw * 2);
    // After zooming to 5x the same moment is back under the pointer.
    const left = scrollFor(t, pointer, start, span, vw * 5);
    expect(timeAt(left, pointer, start, span, vw * 5)).toBeCloseTo(t, 6);
    expect(left).toBeCloseTo(((t - start) / span) * vw * 5 - pointer, 6);
  });
});

describe('tickStep', () => {
  it('fully zoomed out on a long run, labels stay at least MIN_TICK_GAP_PX apart', () => {
    for (const span of [MIN, HOUR, 8 * HOUR, 3 * DAY, 120 * DAY, 400 * DAY]) {
      const step = tickStep(span, 800);
      expect((step / span) * 800).toBeGreaterThanOrEqual(MIN_TICK_GAP_PX);
      expect(span / step).toBeLessThanOrEqual(800 / MIN_TICK_GAP_PX);
    }
  });

  it('fully zoomed in (five seconds on screen) uses whole seconds', () => {
    expect(tickStep(5 * SEC, 800)).toBe(SEC);
    expect(tickStep(5 * SEC, 300)).toBe(2 * SEC);
  });

  it('packs shorter 24-hour labels a little closer', () => {
    expect(tickStep(8 * MIN, 360)).toBe(5 * MIN);
    expect(tickStep(8 * MIN, 360, 72)).toBe(2 * MIN);
  });

  it('picks round steps', () => {
    expect(tickStep(10 * MIN, 1000)).toBe(MIN);
    expect(tickStep(2 * HOUR, 1000)).toBe(15 * MIN);
  });
});

describe('ticks', () => {
  it('lands on round local times inside the window', () => {
    const d = new Date(2026, 9, 27, 14, 3, 17).getTime();
    const out = ticks(d, d + 10 * MIN, 5 * MIN);
    expect(out.length).toBe(2);
    for (const t of out) {
      expect(t).toBeGreaterThanOrEqual(d);
      expect(new Date(t).getMinutes() % 5).toBe(0);
      expect(new Date(t).getSeconds()).toBe(0);
    }
  });

  it('steps whole hours on the local clock', () => {
    const d = new Date(2026, 9, 27, 1, 30).getTime();
    const out = ticks(d, d + 12 * HOUR, 3 * HOUR);
    expect(out.map((t) => new Date(t).getHours())).toEqual([3, 6, 9, 12]);
  });

  it('caps the number of ticks and survives an empty window', () => {
    expect(ticks(0, 10 * DAY, SEC).length).toBeLessThanOrEqual(60);
    expect(ticks(10, 5, SEC)).toEqual([]);
  });
});

describe('labels', () => {
  it('shows seconds only when the step is under a minute', () => {
    const t = new Date(2026, 9, 27, 14, 5, 30).getTime();
    expect(tickLabel(t, 5 * SEC, '24h')).toMatch(/30/);
    expect(tickLabel(new Date(2026, 9, 27, 14, 5, 0).getTime(), 5 * MIN, '24h')).not.toMatch(/:00:00|\d\d:\d\d:\d\d/);
  });

  it('shows the date at midnight and for day steps', () => {
    const midnight = new Date(2026, 9, 28).getTime();
    expect(tickLabel(midnight, 6 * HOUR, '24h')).toMatch(/28/);
    expect(tickLabel(midnight + 9 * HOUR, DAY, '24h')).toMatch(/28/);
  });

  it('formats the zoom factor', () => {
    expect(zoomLabel(2)).toBe('2×');
    expect(zoomLabel(3.46)).toBe('3.5×');
    expect(zoomLabel(120.4)).toBe('120×');
  });
});
