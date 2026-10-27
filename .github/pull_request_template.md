## What and why

<!-- What does this change, and why? Link the issue it fixes, e.g. "Fixes #123". -->

## How it was tested

<!-- Commands you ran, and anything you checked by hand. For UI changes, add before/after screenshots taken from the browser demo (npm run dev:web), never from your real runs. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] New or changed behaviour has tests (unit tests, and e2e tests in `e2e/` for UI changes).
- [ ] If colours or themes changed: the contrast test passes and colour is never the only signal.
- [ ] If animation changed: it goes through the motion policy and respects reduced motion and low-GPU mode.
- [ ] No real data: no real session files or excerpts, usernames, paths, hosts, e-mail addresses or keys. Fixtures are anonymised or synthesized.
- [ ] `npm run scan-secrets` is clean (with my own `ARM_PRIVATE_TERMS` file).
- [ ] Nothing writes to agent files, and nothing new talks to the network.
- [ ] Docs updated where needed: README, CONTRIBUTING.md, docs/PLAN.md, and a line in CHANGELOG.md under Unreleased.

### For a new or changed source adapter

- [ ] I followed "Adding a source adapter" in CONTRIBUTING.md, including its checklist.
- [ ] Provenance is recorded in the adapter header and the fixture README (versions checked, or repository and commit).
- [ ] Corrupt and unknown-record fixtures are included and tested.
