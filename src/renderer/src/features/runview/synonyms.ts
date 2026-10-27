// Words that stand in for "Running" while a run is active (settings.synonyms). Decoration only:
// the real status is always the StatusMark shape and the polite live region.

export const SYNONYMS = [
  'Cogitating',
  'Percolating',
  'Noodling',
  'Wrangling',
  'Ruminating',
  'Conjuring',
  'Tinkering',
  'Marinating',
  'Pondering',
  'Finagling',
  'Untangling',
  'Brewing',
  'Fiddling',
  'Mulling',
  'Whittling',
  'Spelunking',
  'Kneading',
  'Simmering',
  'Rummaging',
  'Doodling',
  'Plotting',
  'Herding bytes',
  'Sleuthing',
  'Puttering',
  'Untwisting',
  'Calibrating vibes',
  'Polishing semicolons',
  'Consulting the rubber duck',
] as const;

/** A stable shuffled order per run, so two runs don't rotate in lockstep. */
export function synonymsFor(seedText: string): string[] {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  const out = [...SYNONYMS];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const j = (h >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
