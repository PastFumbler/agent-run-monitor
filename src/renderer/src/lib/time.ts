// Time formatting and day bucketing. Every function takes `now` explicitly so tests and the fixture
// clock (?now=) give stable output.

import type { TimeFormat } from '@shared/settings';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type DayBucket = 'today' | 'yesterday' | 'earlier';

export function dayBucket(ts: number, now: number): DayBucket {
  const today = startOfDay(now);
  if (ts >= today) return 'today';
  if (ts >= today - DAY) return 'yesterday';
  return 'earlier';
}

export function relativeTime(ts: number, now: number): string {
  const d = now - ts;
  if (d < 0) return 'just now';
  if (d < 45_000) return 'just now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    return `${h} h ago`;
  }
  const days = Math.floor(d / DAY);
  if (days < 14) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Clock time per settings.timeFormat ('relative' falls back to relative text). */
export function formatTime(ts: number, fmt: TimeFormat, now: number): string {
  if (fmt === 'relative') return relativeTime(ts, now);
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: fmt === '12h' });
  const bucket = dayBucket(ts, now);
  if (bucket === 'today') return time;
  if (bucket === 'yesterday') return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** Short list-row time: clock time today, else relative/date. */
export function rowTime(ts: number, fmt: TimeFormat, now: number): string {
  if (fmt === 'relative' || now - ts < HOUR) return relativeTime(ts, now);
  return formatTime(ts, fmt, now);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export const TIME = { MIN, HOUR, DAY };
