---
name: release
description: Cut a new Climb version on the testing branch (version bump, both changelogs, tests, fsck, commit). Use after finishing any change to the app, or when asked to "release", "bump the version" or "commit this".
---

# Release a version (on `testing`)

1. Find the current version: `grep -o "climb-v[0-9]*" sw.js`. The new one is N+1.
2. Bump every cache-buster: `sed -i 's/?v=OLD/?v=NEW/g; s/climb-vOLD/climb-vNEW/' index.html sw.js`,
   then confirm with `grep -c "v=NEW" index.html sw.js` (index.html has one per asset, sw.js 3+).
3. Add the entry at the top of `root.CHANGELOG` in `js/changelog.js`:
   `{ v: NEW, date: 'YYYY-MM-DD', title: '…', items: ['…'] }`. Plain language for players: what
   they'll see, not how it's coded. Two to four items.
4. Add `## 0.NEW (YYYY-MM-DD): <same title>` at the top of `CHANGELOG.md` (under the intro), with
   the code-level notes: functions added or changed, constants, how many tests.
5. Run `node js/tests.js` and `node js/play-tests.js`. Both must end in PASS / all passed.
6. Run `git fsck --full`. Dangling objects are fine; anything else (missing, corrupt) stops the
   release.
7. Make sure you're on `testing` (`git branch --show-current`), stage only the files you changed,
   and commit `0.NEW: <what changed>` with a short body saying why.

Don't push or deploy here; that's the `deploy` skill, and only when the owner asks.
