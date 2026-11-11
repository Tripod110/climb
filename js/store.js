/* store.js — localStorage, wrapped so a private window or full quota degrades to "fetch again"
   instead of a broken page. Everything here is a cache of public API data plus two settings;
   losing it costs one reload, never anything the user typed. */
(function (root) {
  'use strict';
  const P = 'climb.';
  /* Data caches live under climb.<account>.<key> so switching Steam accounts never mixes two
     players' games; settings and the chosen account stay global (climb.<key>). */
  let ns = '';
  const Store = {
    useAccount(acct) { ns = acct ? acct + '.' : ''; },
    getData(key, fallback) { return this.get(ns + key, fallback); },
    setData(key, value) { return this.set(ns + key, value); },
    get(key, fallback) {
      try {
        const v = localStorage.getItem(P + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(P + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    clear() {
      try { Object.keys(localStorage).filter(k => k.startsWith(P)).forEach(k => localStorage.removeItem(k)); } catch (e) { /* nothing to clear */ }
    },
  };
  /* Big things (a packed match review is ~0.5 MB, too much for localStorage's ~5 MB) go in IndexedDB,
     store "replays", keyed "<account>.<match>". Every call resolves (null / false) instead of throwing,
     so a private window or blocked storage just means the review is fetched again. Keeps the newest KEEP. */
  const KEEP = 12;
  let dbp = null;
  const db = () => dbp || (dbp = new Promise(res => {
    try {
      const rq = indexedDB.open('climb', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('replays');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
  const tx = (mode, fn) => db().then(d => d && new Promise(res => {
    try { const t = d.transaction('replays', mode), r = fn(t.objectStore('replays')); t.oncomplete = () => res(r && r.result); t.onerror = () => res(null); } catch (e) { res(null); }
  }));
  Store.big = {
    get: key => tx('readonly', s => s.get(key)).then(v => (v && v.value) || null),
    put: async (key, value) => {
      const ok = await tx('readwrite', s => s.put({ at: Date.now(), value }, key));
      const all = await tx('readonly', s => s.getAllKeys());
      if (all && all.length > KEEP) {
        const ages = await Promise.all(all.map(k => tx('readonly', s => s.get(k)).then(v => [k, v ? v.at : 0])));
        const old = ages.sort((a, b) => a[1] - b[1]).slice(0, ages.length - KEEP);
        await tx('readwrite', s => { old.forEach(([k]) => s.delete(k)); return null; });
      }
      return ok !== null;
    },
  };
  root.Store = Store;
})(window);
