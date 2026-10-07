/* api.js — the only file that talks to the network: deadlock-api.com, plus the Climb helper on
   127.0.0.1 if this PC runs one (the CSP in index.html enforces that). Every call is either one-off (match history, assets) or batched
   (lobby metadata, 30 matches per request) because the API's limits are shared and tight:
   the bulk metadata endpoint allows 30 requests/min per IP. */
(function (root) {
  'use strict';
  const BASE = 'https://api.deadlock-api.com';
  const HELPER = 'http://127.0.0.1:47615';

  class RateLimited extends Error {
    constructor(waitMs) { super('rate limited'); this.waitMs = waitMs; }
  }

  async function getJSON(path) {
    const r = await fetch(BASE + path);
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      const s = j && j.error && j.error.quota && j.error.quota.next_request_in;
      throw new RateLimited(Math.max(2, s || 10) * 1000);
    }
    if (!r.ok) throw new Error('deadlock-api ' + r.status + ' on ' + path.split('?')[0]);
    return r.json();
  }

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  /* Retries a rate-limited call up to 3 times, waiting as long as the API asks. */
  async function polite(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof RateLimited) || attempt >= 3) throw e;
        await sleep(e.waitMs);
      }
    }
  }

  const Api = {
    BATCH: 30,
    SPACING_MS: 2200,
    history: acct => polite(() => getJSON('/v1/players/' + acct + '/match-history')),
    heroes: () => polite(() => getJSON('/v1/assets/heroes')),
    ranks: () => polite(() => getJSON('/v1/assets/ranks')),
    /* include_player_final_stats is the cheap flavour: the last sample of each stat instead of
       the whole time series. Still ~80KB per match, which is why we compact it immediately. */
    metadata: ids => polite(() => getJSON('/v1/matches/metadata?include_info=true&include_player_info=true' +
      '&include_player_kda=true&include_player_final_stats=true&match_ids=' + ids.join(','))),
    /* The local helper (helper/helper.py) on this PC. Resolves to null when it isn't running or
       this device doesn't have one (phone), so callers just hide what needs it. */
    helper: async () => {
      try {
        const r = await fetch(HELPER + '/sessions', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    },
    rankImage: badge => BASE + '/v1/assets/ranks/' + Math.floor(badge / 10) + '/' + (badge % 10) + '/image?format=webp',
    sleep,
  };
  root.Api = Api;
})(window);
