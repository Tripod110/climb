---
name: deploy
description: Ship the testing branch to the live site (tripod110.github.io/climb). Use only when the owner explicitly says "deploy" or "push testing to main".
---

# Deploy `testing` to live

Pushing to `main` publishes the site to every player, so only do this on an explicit request.

1. Check the state:
   - `git ls-remote origin main` gives the live commit (call it LIVE).
   - `git merge-base --is-ancestor LIVE testing` must succeed (testing builds on what's live).
   - `git status --short` is clean, and `node js/tests.js` passes.
2. Tag what's live now so it can be restored: find its version with
   `git show LIVE:sw.js | grep -o "climb-v[0-9]*"`, then `git tag vN-live LIVE` and
   `git push origin vN-live`.
3. Ship: `git push origin testing:main`.
4. Fix the local ref so it matches: `git update-ref refs/heads/main $(git rev-parse testing)`.
5. Wait for GitHub Pages: poll `gh api repos/Tripod110/climb/pages/builds/latest --jq '.status + " " + .commit'`
   every ~10s until it says `built <the testing sha>` (usually under a minute; `errored` means stop
   and report).
6. Verify the live files, bypassing caches:
   - `curl -s "https://tripod110.github.io/climb/index.html?nocache=$(date +%s)" | grep -o 'v=[0-9]*' | sort | uniq -c`
     shows only the new version.
   - `curl -s "https://tripod110.github.io/climb/sw.js?nocache=$(date +%s)" | grep -o "climb-v[0-9]*"`
     shows the new version.

To roll back: `git push --force origin vN-live:main` (the tag from step 2), then repeat step 5.
