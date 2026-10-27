// The renderer's notion of "now". Normally the real clock; the fixture backend can shift it so
// screenshots and e2e runs with ?now=... show the same relative times every time.

let offset = 0;

export function nowMs(): number {
  return Date.now() + offset;
}

/** Makes nowMs() return `at` right now (and keep ticking from there). */
export function setClockTo(at: number): void {
  offset = at - Date.now();
}

export function shiftClock(ms: number): void {
  offset += ms;
}
