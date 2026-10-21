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
  root.Store = Store;
})(window);
