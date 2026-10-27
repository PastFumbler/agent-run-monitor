# Third-party notices

Agent Run Monitor is MIT licensed (see `LICENSE`), **except** the files in
`src/renderer/src/vendor/react-bits/`, which are adapted from React Bits and stay under React Bits'
own licence (MIT + Commons Clause, reproduced in full below and in
`src/renderer/src/vendor/react-bits/LICENSE.md`). Those files may be used and modified as part of this
application, but may not be sold, sublicensed, or redistributed on their own (alone, in a bundle, or as
a ported version), and they are not relicensed under MIT by being in this repository. Forks inherit the
same terms for that folder.

This file also lists the npm packages the app ships with and their licences.

## React Bits (MIT + Commons Clause)

- Project: React Bits by David Haz, <https://github.com/DavidHDev/react-bits> (the free public
  repository; no React Bits Pro components are used).
- Source commit: `e12c22192ac7b4b452c5e2feb9b586d74765d696` (branch `main`, 2026-10-19).
- Variant: the plain-CSS TypeScript copies under `src/ts-default/`.
- Every vendored file carries a header with its source URL, the commit, the copyright line, the licence
  and a "Modified for Agent Run Monitor" note.

| Component | Upstream path (at the commit above) | Local path | Modifications |
| --- | --- | --- | --- |
| StatusMark | `src/ts-default/Micro/StatusMark/StatusMark.{tsx,css}` | `vendor/react-bits/StatusMark/` | A distinct shape per run status (spinning ring segment / static arc, pause bars, hollow circle, check, cross in an octagon, clock with a slash, question mark in a dashed circle); CSS spin gated by the motion policy instead of an infinite per-frame motion value; reduced-motion "breathe" loop removed; theme colour variables; accessible name from the app's status words; draw-in only on a status change. |
| LatticeLoader | `src/ts-default/Micro/LatticeLoader/LatticeLoader.{tsx,css}` | `vendor/react-bits/LatticeLoader/` | Cell loop only when the motion policy allows infinite animation (static lit pattern otherwise); no blur on label swaps; glow only when layered effects are allowed; 1 s timer from data instead of a 100 ms interval; opt-in live region; theme colours. |
| CallChip | `src/ts-default/Micro/CallChip/CallChip.{tsx,css}` | `vendor/react-bits/CallChip/` | Icons for every tool kind; cross glyph for errors and no retry button (the app is read-only); 1 s timer from the tool's start time instead of a never-ending requestAnimationFrame loop, paused while hidden; no shake under reduce motion or low GPU; no blur or clip-path transitions; opt-in live region; theme colours; compact size; visible "failed" word. |
| ThoughtLine | `src/ts-default/Micro/ThoughtLine/ThoughtLine.{tsx,css}` | `vendor/react-bits/ThoughtLine/` | Breathing glyph, shimmer and pulse only when infinite animation is allowed; no blur; no internal timers or ResizeObserver (elapsed comes from data); :focus-visible outline on the toggle; opt-in live region; wrapping steps; theme colours. |
| RubberSegment | `src/ts-default/Micro/RubberSegment/RubberSegment.{tsx,css}` | `vendor/react-bits/RubberSegment/` | Reads the app motion policy (snaps under reduce motion, low GPU or a hidden window); theme colours; unselected labels at full opacity in the muted text colour for contrast; a bordered thumb edge; per-item tooltip. |
| AnimatedList | `src/ts-default/Components/AnimatedList/AnimatedList.{tsx,css}` | `vendor/react-bits/AnimatedList/` | Reduced to a per-row `AnimatedListItem` that works inside a virtualised list: keeps the tile look and the entrance poses/spring easing for newly inserted rows only; no backdrop-filter frame, box-shadows, brightness filters or mask fades; no window keydown listener; no demo items; theme colours; obeys the motion policy. |
| Counter | `src/ts-default/Components/Counter/Counter.{tsx,css}` | `vendor/react-bits/Counter/` | Reads the motion policy instead of matchMedia; motion blur (SVG filter) and edge mask only when layered effects are allowed and off by default; intro spin off by default; no will-change layers in low-GPU mode. |
| RotatingText | `src/ts-default/TextAnimations/RotatingText/RotatingText.{tsx,css}` | `vendor/react-bits/RotatingText/` | Removed its own `MotionConfig reducedMotion="user"` so the app policy applies; no 3D flip, blur or layout animation in low-GPU mode; instant swaps under reduce motion; stops rotating while hidden; whole component aria-hidden and the visually hidden copy removed (decoration only); theme colour for the highlight. |

### React Bits licence (full text)

```text
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software **as part of an application, website, or product**, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## Commons Clause Restriction

You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**

The same restriction covers the React Bits tools (Background Studio, Texture Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the sounds in the sound library. **You may not sell, sublicense, or redistribute the tools or the sounds themselves, or offer the tools or a substantially similar copy of them as a hosted service-whether alone, in a bundle, or as a ported version.**

What you make with the tools is yours to use. You can use exported code, images, videos, and audio files in any personal or commercial application, website, or product, including paid ones. **You may not sell or redistribute the exports on their own, either individually or as the product itself, such as a sound, texture, background, or template pack.**

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm packages shipped with the app

All of these are under the MIT License. The copyright line of each comes from the package's own
`LICENSE` file; the MIT permission text they share is reproduced once below.

| Package | Used for | Licence | Copyright |
| --- | --- | --- | --- |
| `react`, `react-dom` (and `scheduler`) | UI | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `motion` (and `framer-motion`, `motion-dom`, `motion-utils`) | Animation (used by the React Bits components) | MIT | Copyright (c) 2024 Motion B.V. (`framer-motion`: Copyright (c) 2018 Framer B.V.) |
| `@hugeicons/react`, `@hugeicons/core-free-icons` | Icons (free set) | MIT | Copyright (c) 2025 Hugeicons |
| `zustand` | State store | MIT | Copyright (c) 2019 Paul Henschel |
| `cmdk` (and its `@radix-ui/*` dependencies) | Command palette | MIT | Copyright (c) 2022 Paco Coursey (`@radix-ui/*`: Copyright (c) 2022 WorkOS) |
| `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` | Multiviewer tile drag | MIT | Copyright (c) 2021, Claudéric Demers |
| `@tanstack/react-virtual` (and `@tanstack/virtual-core`) | Virtualised lists | MIT | Copyright (c) 2021-present Tanner Linsley |
| `chokidar` | File watching (main process) | MIT | Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker |
| `sql.js` | Read-only SQLite in WebAssembly (main process) | MIT (bundles SQLite, which is in the public domain) | Copyright (c) 2017 sql.js authors |
| `electron` | Desktop shell | MIT | Copyright (c) Electron contributors. Electron bundles Chromium and other components under their own licences; packaged builds include Electron's `LICENSES.chromium.html`. |

Development-only tools (TypeScript, Vite, electron-vite, electron-builder, Vitest, Playwright, jsdom,
Testing Library) are not shipped in the app.

### MIT License (shared text)

```text
MIT License

Copyright (c) <see the table above for each package>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
