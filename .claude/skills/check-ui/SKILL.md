---
name: check-ui
description: Check a Climb UI change in a real browser at desktop and phone width (cache cleared, no overflow, no console errors, screenshots). Use after any change to views.js, style.css or charts.js, before committing.
---

# Check a UI change

1. Start the app with the `climb` launch config (`.claude/launch.json`, a static server on
   port 8765) and open the tab that changed.
2. The service worker serves the old files until cleared. In the page, run:
   ```js
   for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
   for (const k of await caches.keys()) await caches.delete(k);
   location.reload();
   ```
3. A fresh browser has no account: set one in localStorage (`climb.settings` →
   `{"account": <steam account id>, …}`) or paste a profile on the welcome page, then reload and
   give the data a few seconds to load.
4. Desktop (~1200px): screenshot the changed section. Check alignment, that green/red only mark
   good/bad, and that no explanation sentence crept into the body (it belongs behind an "i").
5. Phone (375px): `document.documentElement.scrollWidth` must equal the viewport width. If not,
   find the culprit with
   ```js
   const W = document.documentElement.clientWidth;
   [...document.querySelectorAll('#view *')].filter(e => e.getBoundingClientRect().right > W + 1)
   ```
   Wide tables inside `.table-wrap` are allowed to scroll on their own.
6. Read the console for errors.
7. States you can't reach with real data (no focus habit, a saved Gemini analysis, …) can be
   faked by writing the matching `climb.<account>.<key>` in localStorage. Save the old values
   first and restore them after, and never send a fake key to a real API.
8. Reset the viewport to desktop when done.
