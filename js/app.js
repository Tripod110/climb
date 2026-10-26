/* app.js — state, loading and routing. The page is four tabs (Overview, Matches, Heroes, Play
   time) plus About, addressed by the URL hash so the back button works. Views live in views.js
   and only turn the model into HTML; every number comes from Engine so the tests cover it. */
(function () {
  'use strict';
  const E = window.Engine, A = window.Api, S = window.Store, C = window.Charts, P = window.Play, V = window.Views, K = window.Coach;
  const LOG = window.CHANGELOG || [];
  const VERSION = LOG.length ? LOG[0].v : 0;
  const HISTORY_TTL = 3 * 60 * 1000;
  const ASSET_TTL = 7 * 86400 * 1000;
  const PROFILE_TTL = 86400 * 1000;
  const PATCH_TTL = 86400 * 1000;
  const CURVE_TTL = 3600 * 1000;   // the API caches analytics for an hour, so asking sooner gains nothing
  const BLEND_DAYS = 120;          // unranked games older than this never enter a baseline

  const $ = s => document.querySelector(s);

  const settings = Object.assign({ window: 'last20', blend: false, games: 'all', benchT: 1200, account: null }, S.get('settings', {}));

  /* One-time move from the single-account Climb (v1–v5): its caches sat at climb.<key> and the
     account was hard-coded. Adopt that account and carry its history over. */
  if (!settings.account && S.get('history', null)) {
    settings.account = E.ACCOUNT_ID;
    S.useAccount(settings.account);
    S.setData('history', S.get('history', null));
    S.set('history', null); S.set('lobbies', null); S.set('curves', null);
  }
  if (settings.seenV == null) settings.seenV = settings.account ? 0 : VERSION;
  S.set('settings', settings);

  const state = {
    coach: S.get('coach', { key: '', model: null, models: [] }),   // your Gemini key: this browser only
    items: S.get('items', null),          // { at, map: compactItems }
    coaching: {},                         // matchId -> 'working' while a debrief runs
    analyzing: null,                      // status text while the overall analysis runs
    detailsBusy: false,
    settings,
    assets: S.get('assets', null),        // { at, heroes: {id: {name, icon}}, tiers: [names] }
    patch: S.get('patch', null),          // { at, t }: the last big patch day
    helper: S.get('helper', null),        // last /sessions payload from the local helper, + `at`
    helperLive: false,
    status: '', busy: false,
    route: { tab: 'overview' },
    search: null,                         // onboarding: { q, results, busy, error }
  };
  function loadAccountData() {
    S.useAccount(settings.account);
    state.history = S.getData('history', null);     // { at, matches: [...normalized] }
    state.added = S.getData('added', {});           // { matchId: match } games Valve's history left out, added by id
    state.lobbies = S.getData('lobbies', {});       // { matchId: compactLobby | null }
    state.curves = S.getData('curves', {});         // { key: { at, c } } curves + hero stats
    state.profile = S.getData('profile', null);     // { at, name, avatar, rank }
    state.debriefs = S.getData('debriefs', {});     // { matchId: { at, model, data } | { error } }
    state.details = S.getData('details', {});       // { matchId: compactMatchDetail } (last ~60)
    state.analysis = S.getData('analysis', null);   // { at, lastId, n, model, data } (+ error)
    state.focus = S.getData('focus', { active: null, history: [] });  // the focus loop (see Engine.focusProgress)
    state.friends = S.getData('friends', null);     // { at, mates: [...mate-stats rows], people: {acct: {name, avatar, badge}} }
  }
  loadAccountData();

  // ---------------------------------------------------------------- model
  function model() {
    const all = E.mergeAdded((state.history && state.history.matches) || [], state.added);
    const ranked = all.filter(m => m.mode === 'ranked');
    const season = E.seasonOf(ranked);
    const since = season.length ? season[0].t : 0;
    // 'all' = every ranked + unranked game since the ranked season began. Rank points still come
    // only from ranked games (summarize skips null deltas), so the rank signal stays honest.
    const allMode = settings.games === 'all';
    const scope = allMode ? all.filter(m => m.t >= since) : season;
    const blendFrom = Math.max(since, Date.now() / 1000 - BLEND_DAYS * 86400);
    const pool = allMode ? scope
      : settings.blend ? all.filter(m => m.mode === 'ranked' ? m.t >= since : m.t >= blendFrom)
      : season;
    const perf = E.perfScores(pool, state.lobbies, scope);
    const w = E.windowsFor(settings.window, allMode ? scope : ranked);
    const cur = E.summarize(w.cur, perf, state.lobbies);
    const prev = w.prev.length ? E.summarize(w.prev, perf, state.lobbies) : null;
    const curRanked = E.summarize(w.cur.filter(m => m.mode === 'ranked'), perf, state.lobbies);
    const v = E.verdict(cur, prev, E.rankUnit(season));
    const seasonSum = E.summarize(season, perf, state.lobbies);
    const lastRanked = ranked[ranked.length - 1];
    const badge = (state.profile && state.profile.badge) || (lastRanked && lastRanked.badge) || null;
    return { all, ranked, season, scope, allMode, pool, perf, w, cur, prev, curRanked, v, seasonSum, badge };
  }

  // ---------------------------------------------------------------- context handed to views
  const heroName = id => (state.assets && state.assets.heroes[id] && state.assets.heroes[id].name) || 'Hero ' + id;
  const heroIcon = id => (state.assets && state.assets.heroes[id] && state.assets.heroes[id].icon) || '';
  const ctx = {
    E, A, C, P, S, state, settings, LOG, VERSION,
    heroName, heroIcon,
    tiers: () => state.assets && state.assets.tiers,
    tierName: t => E.badgeName(t * 10, state.assets && state.assets.tiers),
    esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    signed: C.signed, fmtInt: C.fmtInt,
    pct: x => x == null ? '—' : Math.round(x * 100) + '%',
    kfmt: v => v == null ? '—' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)),
    ago: t => {
      const s = Date.now() / 1000 - t;
      if (s < 60) return 'just now';
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      if (s < 86400 * 14) return Math.round(s / 86400) + 'd ago';
      return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    },
    go: hash => { if (location.hash !== hash) location.hash = hash; else render(); },
    save: () => S.set('settings', settings),
    render: () => render(),
    benchPlan, ensureHeroLadder, searchAccount, setAccount, runDebrief, saveCoachKey, setCoachModel, clearCoach, ensureMatchDetail, matchWin, ensureDetails, runAnalysis, analysisEntries, ANALYSIS_N: 30,
    focusEntries, focusCatalog, focusNow, startFocus, endFocus, coachPickHabit,
    ensureFriends, ensureDetailsFor, friendList, entryOf: m => ({ m, L: state.lobbies[m.id], D: state.details[m.id] }), dismissRecap, dismissMissing, freshnessNow,
    addMatch,
  };

  // ---------------------------------------------------------------- routing + render
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const tab = ['overview', 'coach', 'matches', 'match', 'heroes', 'friends', 'friend', 'play', 'about'].includes(parts[0]) ? parts[0] : 'overview';
    return { tab, id: parts[1] ? Number(parts[1]) : null };
  }

  function render() {
    state.route = parseRoute();
    const onboarding = !settings.account;
    document.body.classList.toggle('onboarding', onboarding);
    renderTop(onboarding);
    const main = $('#view');
    if (onboarding) { V.welcome(main, ctx); return; }
    const M = model();
    ctx.M = M;
    const tab = state.route.tab === 'match' ? 'matches' : state.route.tab === 'friend' ? 'friends' : state.route.tab;
    document.querySelectorAll('#nav a').forEach(a => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
    const view = { overview: V.overview, coach: V.coach, matches: V.matches, match: V.match, heroes: V.heroes, friends: V.friends, friend: V.friend, play: V.play, about: V.about }[state.route.tab];
    view(main, ctx);
    $('#status').textContent = state.status;
  }

  function renderTop(onboarding) {
    $('#nav').hidden = onboarding;
    $('#refresh').hidden = onboarding;
    $('#refresh').disabled = state.busy;
    const p = state.profile;
    $('#who').hidden = onboarding;
    $('#who').innerHTML = onboarding ? '' : `
      ${p && p.avatar ? `<img src="${ctx.esc(p.avatar)}" alt="" width="28" height="28">` : '<span class="av-ph"></span>'}
      <span class="who-name">${ctx.esc((p && p.name) || 'Account ' + settings.account)}</span>`;
  }

  function setStatus(s) { state.status = s; const el = $('#status'); if (el) el.textContent = s; }

  // ---------------------------------------------------------------- account
  async function searchAccount(q) {
    const parsed = E.parseSteamInput(q);
    if (!parsed) return;
    if (parsed.account) { await setAccount(parsed.account); return; }
    state.search = { q, results: null, busy: true, error: null };
    render();
    try {
      const rows = await A.steamSearch(parsed.search);
      state.search = { q, busy: false, error: null, results: (rows || []).map(r => ({ account: r.account_id, name: r.personaname, avatar: r.avatarmedium || r.avatar, games: r.matches_played_last_30d })) };
    } catch (e) {
      state.search = { q, busy: false, results: null, error: 'Couldn’t search right now: ' + e.message };
    }
    render();
  }

  async function setAccount(acct) {
    settings.account = acct;
    settings.seenV = VERSION;
    ctx.save();
    state.search = null;
    loadAccountData();
    location.hash = '#/overview';
    render();
    await refresh(false);
  }

  // ---------------------------------------------------------------- loading
  async function loadAssets() {
    if (state.assets && Date.now() - state.assets.at < ASSET_TTL) return;
    const [heroes, ranks] = await Promise.all([A.heroes(), A.ranks()]);
    const h = {};
    for (const x of heroes) h[x.id] = { name: x.name, icon: x.images && (x.images.icon_image_small_webp || x.images.icon_image_small) };
    const t = [];
    for (const r of ranks) t[r.tier] = r.name;
    state.assets = { at: Date.now(), heroes: h, tiers: t };
    S.set('assets', state.assets);
  }

  async function loadProfile() {
    if (state.profile && Date.now() - state.profile.at < PROFILE_TTL) return;
    const acct = settings.account;
    const [p, r] = await Promise.all([A.steamProfile(acct).catch(() => null), A.rank(acct).catch(() => null)]);
    if (acct !== settings.account) return;
    state.profile = { at: Date.now(), name: p && p.personaname, avatar: p && (p.avatarmedium || p.avatar), badge: (r && r.badge) || null };
    S.setData('profile', state.profile);
  }

  async function loadHistory(force) {
    if (!force && state.history && Date.now() - state.history.at < HISTORY_TTL) return;
    const acct = settings.account;
    const rows = await A.history(acct);
    if (acct !== settings.account) return;
    state.history = { at: Date.now(), matches: E.normalizeHistory(rows) };
    S.setData('history', state.history);
  }

  async function loadPatch() {
    if (state.patch && Date.now() - state.patch.at < PATCH_TTL) return;
    const t = E.lastBigPatch(await A.bigPatchDays(), Date.now() / 1000);
    state.patch = { at: Date.now(), t };
    S.set('patch', state.patch);
  }

  /* Lobbies for every game in the pool (season, or season + blend). A cached lobby of an older
     shape counts as missing so roles get computed for it. */
  async function loadLobbies() {
    const acct = settings.account;
    // The season pool first (it feeds form and the verdict), then every older match so the
    // Matches tab can read any game. Once cached, a lobby is never fetched again.
    const M0 = model();
    const inPool = new Set(M0.pool.map(m => m.id));
    const want = [...M0.all.filter(m => !inPool.has(m.id)).map(m => m.id), ...inPool];
    const missing = want.filter(id => !(id in state.lobbies) || (state.lobbies[id] && state.lobbies[id].v !== E.LOBBY_V)).reverse();
    for (let i = 0; i < missing.length; i += A.BATCH) {
      const ids = missing.slice(i, i + A.BATCH);
      setStatus(`Loading lobbies… ${Math.min(i + A.BATCH, missing.length)}/${missing.length}`);
      const metas = await A.metadata(ids);
      if (acct !== settings.account) return;
      const got = new Set();
      for (const meta of metas) {
        const L = E.compactLobby(meta, acct);
        if (L) { state.lobbies[meta.match_id] = L; got.add(meta.match_id); }
      }
      // A match the API has no metadata for is recorded as null so we don't ask forever.
      for (const id of ids) if (!got.has(id)) state.lobbies[id] = null;
      S.setData('lobbies', state.lobbies);
      render();
      if (i + A.BATCH < missing.length) await A.sleep(A.SPACING_MS);
    }
  }

  async function loadHelper() {
    const h = await A.helper();
    state.helperLive = !!h;
    if (h) { state.helper = Object.assign(h, { at: Date.now() }); S.set('helper', state.helper); }
  }

  /* Runs fetch jobs 4 at a time (the analytics limit is 200/min, so this never trips it). */
  async function runJobs(jobs, label) {
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const j = jobs.shift();
        const data = await j.fetch();
        state.curves[j.key] = { at: Date.now(), c: j.compact(data) };
        done++;
        setStatus(`${label}… ${done}`);
        if (done % 4 === 0) render();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  const fresh = key => state.curves[key] && Date.now() - state.curves[key].at < CURVE_TTL;

  // ---------------------------------------------------------------- per-hero ladder data
  /* The window for a hero: games since the last big patch, widened to 60 days under 8 games
     (Engine.benchWindow). A hero with too few games still gets the 60-day window so the ladder
     can show what the ranks do, with your row marked as thin. */
  function benchPlan(M, hero) {
    const now = Date.now() / 1000;
    const patchT = state.patch ? state.patch.t : null;
    const w = E.benchWindow(M.all, hero, patchT, now);
    const wideFrom = Math.min(patchT == null ? Infinity : patchT, Math.floor(now / 86400 - E.BENCH_WIDE_DAYS) * 86400);
    const n = M.all.filter(m => m.hero === hero && m.t >= wideFrom).length;
    return w || { hero, from: wideFrom, n, widened: true, spansPatch: patchT != null && wideFrom < patchT, thin: true };
  }
  const ladderKeys = (hero, from, acct) => {
    const f = Math.floor(from);
    const k = { me: `c|${hero}|${f}|a${acct}`, meStats: `s|${f}|a${acct}`, tiers: {} };
    for (const t of E.LADDER_TIERS) k.tiers[t] = { curve: `c|${hero}|${f}|t${t}`, stats: `s|${f}|t${t}` };
    return k;
  };
  ctx.ladderKeys = ladderKeys;

  let ladderBusy = null;
  async function ensureHeroLadder(hero) {
    if (ladderBusy === hero) return;
    const M = model();
    const plan = benchPlan(M, hero);
    const acct = settings.account;
    const k = ladderKeys(hero, plan.from, acct);
    const jobs = [];
    const curveJob = (key, who) => ({ key, fetch: () => A.curve(hero, plan.from, who), compact: E.compactCurve });
    const statsJob = (key, who) => ({ key, fetch: () => A.heroStats(plan.from, who), compact: E.compactHeroStats });
    if (!fresh(k.me)) jobs.push(curveJob(k.me, { account: acct }));
    if (!fresh(k.meStats)) jobs.push(statsJob(k.meStats, { account: acct }));
    for (const t of E.LADDER_TIERS) {
      const who = { minBadge: t * 10 + 1, maxBadge: t * 10 + 6 };
      if (!fresh(k.tiers[t].curve)) jobs.push(curveJob(k.tiers[t].curve, who));
      if (!fresh(k.tiers[t].stats)) jobs.push(statsJob(k.tiers[t].stats, who));
    }
    if (!jobs.length) return;
    ladderBusy = hero;
    try {
      await runJobs(jobs, 'Loading rank comparison');
      // Drop cached curves/stats nothing points at any more (old windows, other heroes > 7 days).
      for (const key of Object.keys(state.curves)) if (Date.now() - state.curves[key].at > 7 * 86400 * 1000) delete state.curves[key];
      S.setData('curves', state.curves);
      setStatus('');
    } catch (e) {
      setStatus(e.waitMs ? 'deadlock-api is rate-limiting. Try again in a minute.' : 'Couldn’t load the rank comparison: ' + e.message);
    } finally {
      ladderBusy = null;
      render();
    }
  }

  // ---------------------------------------------------------------- coach (Gemini)
  async function saveCoachKey(key) {
    key = String(key || '').trim();
    if (!key) return { error: 'Paste a key first.' };
    try {
      const list = await K.models(key);
      if (!list.length) return { error: 'That key works, but it can’t reach any Gemini text models.' };
      state.coach = { key, models: list, model: K.pickDefault(list) };
      S.set('coach', state.coach);
      render();
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }
  function setCoachModel(id) { state.coach.model = id; S.set('coach', state.coach); }
  function clearCoach() { state.coach = { key: '', model: null, models: [] }; S.set('coach', state.coach); render(); }

  async function loadItems() {
    if (state.items && Date.now() - state.items.at < ASSET_TTL) return;
    state.items = { at: Date.now(), map: E.compactItems(await A.upgradeItems()) };
    S.set('items', state.items);
  }

  /* Debrief one match: full match detail + item names + (if loadable) your rank ladder on that
     hero -> a compact brief -> Gemini -> cached per match. `force` re-asks. */
  /* One match's detail for the match page (win chance needs it). Cached with the others; an
     older or missing detail is fetched once per visit. */
  const detailTried = new Set();
  async function ensureMatchDetail(matchId) {
    const have = state.details[matchId];
    if ((have && have.v === E.DETAIL_V) || detailTried.has(matchId)) return;
    detailTried.add(matchId);
    try {
      const meta = await A.matchDetail(matchId);
      const D = meta && E.compactMatchDetail(meta, settings.account);
      if (D) { state.details[matchId] = D; S.setData('details', state.details); }
    } catch (e) { /* the card says it couldn't load */ }
    render();
  }

  /* Win chance for a match: timeline, turning points and death costs, or null without a model
     or detail. window.WPMODEL comes from js/wpmodel.js (model/train.py). */
  function matchWin(matchId) {
    const W = window.WPMODEL, D = state.details[matchId];
    if (!W || !D || D.v !== E.DETAIL_V) return null;
    const me = D.players.find(p => p.items);
    if (!me) return null;
    return { W, D, timeline: E.winTimeline(D, W, me.team), turning: E.turningPoints(D, W, 3), deaths: E.deathCosts(D, W) };
  }

  async function runDebrief(matchId, force) {
    if (state.coaching[matchId]) return;
    if (!state.coach.key || !state.coach.model) return;
    if (!force && state.debriefs[matchId] && state.debriefs[matchId].data) return;
    const M = model();
    const m = M.all.find(x => x.id === matchId);
    const L = state.lobbies[matchId];
    if (!m || !L || L.v !== E.LOBBY_V) return;
    state.coaching[matchId] = 'Reading the match…'; render();
    try {
      const [meta] = await Promise.all([A.matchDetail(matchId), loadItems()]);
      const D = meta && E.compactMatchDetail(meta, settings.account);
      if (!D) throw new Error('deadlock-api has no detailed data for this match yet.');
      state.details[matchId] = D;
      state.coaching[matchId] = 'Comparing with your rank…'; render();
      let ladder = null;
      const yourTier = M.badge ? Math.floor(M.badge / 10) : 0;
      try {
        await ensureHeroLadder(m.hero);
        const plan = benchPlan(M, m.hero), k = ladderKeys(m.hero, plan.from, settings.account);
        const get = key => state.curves[key] ? state.curves[key].c : null;
        const tiersData = {};
        for (const t of E.LADDER_TIERS) tiersData[t] = { curve: get(k.tiers[t].curve), stats: get(k.tiers[t].stats) };
        const mine = { curve: get(k.me), stats: get(k.meStats) };
        if (mine.curve && mine.stats) ladder = E.rankLadder(m.hero, 1200, mine, tiersData, yourTier);
      } catch (e) { /* the debrief still works without the ladder */ }
      const brief = E.debriefBrief(m, L, D, E.gameRole(L, m.won), M.perf.get(m.id), {
        heroName, items: state.items.map, tierName: ctx.tierName, ladder, yourTier, win: matchWin(matchId),
      });
      state.coaching[matchId] = 'Coach is thinking…'; render();
      const out = await K.json(state.coach.key, state.coach.model, E.DEBRIEF_SYSTEM, JSON.stringify(brief), E.DEBRIEF_SCHEMA,
        K.fallbacks(state.coach.models || [], state.coach.model), msg => { state.coaching[matchId] = msg; render(); });
      state.debriefs[matchId] = { at: Date.now(), model: out.model, data: out.data, tokens: out.usage && out.usage.totalTokenCount };
    } catch (e) {
      state.debriefs[matchId] = { at: Date.now(), error: e.message };
    } finally {
      delete state.coaching[matchId];
      S.setData('debriefs', state.debriefs);
      render();
    }
  }

  // ---------------------------------------------------------------- overall analysis (Coach tab)
  const ANALYSIS_N = 30;
  const DETAILS_KEEP = 60;
  const lastGames = () => model().all.slice(-ANALYSIS_N);
  /* Games that need match detail: the last ANALYSIS_N, plus everything since the focus started. */
  const detailGames = () => {
    const all = model().all;
    const f = state.focus && state.focus.active;
    const since = f ? all.filter(m => m.t >= f.start).length : 0;
    return all.slice(-Math.min(DETAILS_KEEP, Math.max(ANALYSIS_N, since)));
  };

  /* Match detail for your last ANALYSIS_N games, 10 per request, cached. Details older than the
     last DETAILS_KEEP games are dropped so localStorage stays small (~6KB each). */
  async function ensureDetails() {
    if (state.detailsBusy || !settings.account) return;
    const acct = settings.account;
    const missing = detailGames().filter(m => !state.details[m.id] || state.details[m.id].v !== E.DETAIL_V).map(m => m.id);
    if (!missing.length) return;
    state.detailsBusy = true; render();
    try {
      await loadItems();
      for (let i = 0; i < missing.length; i += 10) {
        const ids = missing.slice(i, i + 10);
        setStatus(`Reading match details… ${Math.min(i + 10, missing.length)}/${missing.length}`);
        const metas = await A.matchDetails(ids);
        if (acct !== settings.account) return;
        for (const meta of metas || []) {
          const D = E.compactMatchDetail(meta, acct);
          if (D) state.details[meta.match_id] = D;
          const L = E.compactLobby(meta, acct);
          const have = state.lobbies[meta.match_id];
          if (L && !(have && have.v === E.LOBBY_V)) state.lobbies[meta.match_id] = L;
        }
        render();
      }
      const keep = new Set(model().all.slice(-DETAILS_KEEP).map(m => m.id));
      // Keep the last DETAILS_KEEP games plus up to 40 shared games with friends (fetched on their page).
      const shared = new Set(friendList().flatMap(f => f.ids.slice(-10)));
      for (const id of Object.keys(state.details)) if (!keep.has(Number(id)) && !shared.has(Number(id))) delete state.details[id];
      S.setData('details', state.details);
      S.setData('lobbies', state.lobbies);
      setStatus('');
    } catch (e) {
      setStatus(e.waitMs ? 'deadlock-api is rate-limiting. Try again in a minute.' : 'Couldn’t load match details: ' + e.message);
    } finally {
      state.detailsBusy = false; render();
    }
  }

  // ---------------------------------------------------------------- focus loop
  const entryOf = m => ({ m, L: state.lobbies[m.id], D: state.details[m.id] });
  function focusEntries() { return detailGames().map(entryOf); }
  /* The habit catalog over your last ANALYSIS_N games (the baseline any new habit starts from). */
  function focusCatalog() { return E.habitCatalog(lastGames().map(entryOf), state.items && state.items.map); }
  function focusNow() {
    const f = state.focus.active;
    return f ? E.focusProgress(f, focusEntries(), state.items && state.items.map) : null;
  }
  function saveFocus() { S.setData('focus', state.focus); }

  /* Start a habit now. Its baseline is your pass rate over the last ANALYSIS_N games, so the
     verdict compares the new you with the you who picked it. Only games after this moment count. */
  function startFocus(habitId, why, how, by) {
    const c = focusCatalog().find(x => x.id === habitId);
    if (!c) return;
    if (state.focus.active) endFocus('switched');
    state.focus.active = { habit: habitId, start: Math.floor(Date.now() / 1000), baseline: { rate: c.passRate, n: c.n, wrPass: c.wrPass, wrFail: c.wrFail },
      why: why || null, how: how || null, by: by || 'you' };
    saveFocus(); render();
  }

  /* outcome: 'graduated' | 'dropped' | 'switched'. The result is kept in history either way. */
  function endFocus(outcome) {
    const f = state.focus.active;
    if (!f) return;
    const p = focusNow();
    state.focus.history.unshift({ habit: f.habit, start: f.start, end: Math.floor(Date.now() / 1000), baseline: f.baseline.rate,
      rate: p ? p.rate : null, n: p ? p.n : 0, verdict: p ? p.verdict : 'early', outcome });
    state.focus.history = state.focus.history.slice(0, 30);
    state.focus.active = null;
    saveFocus(); render();
  }

  /* Ask Gemini to choose from the eligible habits (an enum, so it can't invent one). Uses the
     30-game aggregate as context. Falls back to Climb's own pick if there's no key. */
  async function coachPickHabit() {
    if (state.analyzing) return;
    const setA = msg => { state.analyzing = msg; render(); };
    try {
      setA('Reading your last games…');
      await ensureDetails();
      const cat = focusCatalog();
      const eligible = cat.filter(c => c.eligible);
      if (!eligible.length) throw new Error('No habit splits your wins from your losses clearly enough yet. Play a few more games.');
      if (!state.coach.key || !state.coach.model) {
        const s = E.suggestHabit(cat);
        startFocus(s.id, `Climb’s pick: you win ${Math.round(s.wrPass * 100)}% of games when you pass it vs ${Math.round(s.wrFail * 100)}% when you don’t, and you pass it in ${Math.round(s.passRate * 100)}% of games.`, null, 'climb');
        return;
      }
      const agg = E.aggregateGames(analysisEntries(), state.items && state.items.map, heroName);
      const pc = v => v == null ? null : Math.round(v * 100) + '%';
      const brief = {
        recent_stats: E.analysisBrief(agg, {}),
        habit_catalog: cat.map(c => ({ id: c.id, habit: c.label, eligible: c.eligible, outcome: c.outcome, you_pass_it: pc(c.passRate),
          win_rate_when_passed: pc(c.wrPass), win_rate_when_not: pc(c.wrFail), games: c.n })),
        past_habits: state.focus.history.slice(0, 5).map(h => ({ habit: (E.habitById(h.habit) || {}).label, outcome: h.outcome, pass_rate_before: pc(h.baseline), pass_rate_during: pc(h.rate) })),
      };
      setA('Coach is choosing your habit…');
      const out = await K.json(state.coach.key, state.coach.model, E.FOCUS_SYSTEM, JSON.stringify(brief), E.focusSchema(eligible.map(c => c.id)),
        K.fallbacks(state.coach.models || [], state.coach.model), setA);
      const pick = eligible.find(c => c.id === out.data.habit_id) || E.suggestHabit(cat);
      startFocus(pick.id, out.data.why, out.data.how, 'coach');
    } catch (e) {
      state.focusError = e.message;
    } finally {
      state.analyzing = null; render();
    }
  }

  // ---------------------------------------------------------------- friends
  const FRIENDS_TTL = 86400 * 1000;
  let friendsBusy = false;
  /* Teammate history (who you queue with) + names, avatars and ranks for the repeat ones. */
  async function ensureFriends(force) {
    if (friendsBusy || !settings.account) return;
    if (!force && state.friends && Date.now() - state.friends.at < FRIENDS_TTL) return;
    friendsBusy = true;
    const acct = settings.account;
    try {
      const mates = (await A.mateStats(acct) || []).filter(x => x.matches_played >= E.FRIEND_MIN);
      const ids = mates.map(x => x.mate_id).slice(0, 40);
      const [profiles, ranks] = await Promise.all([A.steamProfiles(ids).catch(() => []), A.playerRanks(ids).catch(() => [])]);
      if (acct !== settings.account) return;
      const people = {};
      for (const p of profiles || []) people[p.account_id] = { name: p.personaname, avatar: p.avatarmedium || p.avatar };
      for (const k of ranks || []) people[k.account_id] = Object.assign(people[k.account_id] || {}, { badge: k.badge || null });
      state.friends = { at: Date.now(), mates, people };
      S.setData('friends', state.friends);
    } catch (e) {
      setStatus('Couldn’t load friends: ' + e.message);
    } finally { friendsBusy = false; render(); }
  }
  function friendList() {
    if (!state.friends) return [];
    return E.friendStats(state.friends.mates, model().all).map(f => Object.assign(f, state.friends.people[f.acct] || {}));
  }

  /* Match detail for specific games (a friend's shared games), 10 per request. */
  const detailsAsked = new Set();
  async function ensureDetailsFor(ids) {
    const missing = ids.filter(id => (!state.details[id] || state.details[id].v !== E.DETAIL_V) && !detailsAsked.has(id));
    if (!missing.length || state.detailsBusy) return;
    missing.forEach(id => detailsAsked.add(id));
    state.detailsBusy = true;
    try {
      for (let i = 0; i < missing.length; i += 10) {
        const metas = await A.matchDetails(missing.slice(i, i + 10));
        for (const meta of metas || []) { const D = E.compactMatchDetail(meta, settings.account); if (D) state.details[meta.match_id] = D; }
      }
      S.setData('details', state.details);
    } catch (e) { /* the view shows what it has */ }
    finally { state.detailsBusy = false; render(); }
  }

  function dismissRecap(end) { settings.recapSeen = end; ctx.save(); render(); }
  /* A game Valve's match history leaves out, added by its match id. deadlock-api must already have
     it (someone sent it the match key, e.g. the ingest tool while you opened it in-game). Resolves
     to { ok, msg, id }; the game and its lobby are cached so it's never fetched again. */
  async function addMatch(input) {
    const id = Number(String(input || '').replace(/\D/g, ''));
    if (!id) return { ok: false, msg: 'That doesn’t look like a match id. It’s the long number on the match in Deadlock’s match history.' };
    if (model().all.some(m => m.id === id)) return { ok: true, id, msg: 'That game is already in your matches.' };
    const acct = settings.account;
    let meta;
    try { meta = (await A.metadata([id]))[0]; } catch (e) { return { ok: false, msg: 'Couldn’t reach deadlock-api: ' + e.message }; }
    if (acct !== settings.account) return { ok: false, msg: '' };
    if (!meta) return { ok: false, msg: 'deadlock-api doesn’t have that match yet. Open it in Deadlock’s match history while the ingest tool runs, wait a minute, then try again.' };
    const m = E.matchFromMeta(meta, acct);
    if (!m) return { ok: false, msg: 'This account isn’t in that match.' };
    if (m.mode === 'other') return { ok: false, msg: 'That isn’t a normal ranked or unranked game, so Climb doesn’t count it.' };
    state.added[id] = m;
    S.setData('added', state.added);
    const L = E.compactLobby(meta, acct);
    if (L) { state.lobbies[id] = L; S.setData('lobbies', state.lobbies); }
    render();
    return { ok: true, id, msg: '' };
  }
  function dismissMissing(id) { settings.missingSeen = id; ctx.save(); render(); }
  /* How current deadlock-api is for this account (Engine.freshness), using the helper's sessions. */
  function freshnessNow() { return E.freshness(model().all, state.helper, Date.now() / 1000); }

  function analysisEntries() {
    return lastGames().map(m => ({ m, L: state.lobbies[m.id], D: state.details[m.id] }));
  }

  /* Aggregate locally, add the next-rank gaps for your two most-played heroes in the sample,
     then ONE Gemini call. Cached until you play a new game (keyed on the latest match id). */
  async function runAnalysis(force) {
    if (state.analyzing || !state.coach.key || !state.coach.model) return;
    const games = lastGames();
    if (!games.length) return;
    const lastId = games[games.length - 1].id;
    if (!force && state.analysis && state.analysis.data && state.analysis.lastId === lastId) return;
    const setA = msg => { state.analyzing = msg; render(); };
    try {
      setA('Reading your last ' + games.length + ' games…');
      await ensureDetails();
      const agg = E.aggregateGames(analysisEntries(), state.items && state.items.map, heroName);
      if (agg.n < 5) throw new Error('Not enough games with match detail yet (' + agg.n + '). Try again in a minute.');
      setA('Comparing your top heroes with the next rank…');
      const M = model();
      const yourTier = M.badge ? Math.floor(M.badge / 10) : 0;
      const gaps = [];
      for (const h of agg.heroes.slice(0, 2)) {
        try {
          await ensureHeroLadder(h.hero);
          const plan = benchPlan(M, h.hero), k = ladderKeys(h.hero, plan.from, settings.account);
          const get = key => state.curves[key] ? state.curves[key].c : null;
          const tiersData = {};
          for (const t of E.LADDER_TIERS) tiersData[t] = { curve: get(k.tiers[t].curve), stats: get(k.tiers[t].stats) };
          const mine = { curve: get(k.me), stats: get(k.meStats) };
          if (!mine.curve || !mine.stats) continue;
          const lad = E.rankLadder(h.hero, 1200, mine, tiersData, yourTier);
          for (const r of lad.toNext.slice(0, 2)) {
            gaps.push({ hero: h.name, stat: r.label, you: Math.round(r.you * 100) / 100, next_rank_avg: Math.round(r.next.v * 100) / 100, at: r.src === 'curve' ? '20:00' : 'whole game' });
          }
        } catch (e) { /* the analysis still works without these */ }
      }
      const brief = E.analysisBrief(agg, { rankName: M.badge ? E.badgeName(M.badge, ctx.tiers()) : null, ladderGaps: gaps });
      setA('Coach is reading ' + agg.n + ' games…');
      const out = await K.json(state.coach.key, state.coach.model, E.ANALYSIS_SYSTEM, JSON.stringify(brief), E.ANALYSIS_SCHEMA,
        K.fallbacks(state.coach.models || [], state.coach.model), setA);
      state.analysis = { at: Date.now(), lastId, n: agg.n, model: out.model, data: out.data, tokens: out.usage && out.usage.totalTokenCount };
    } catch (e) {
      state.analysis = Object.assign({}, state.analysis || {}, { errorAt: Date.now(), error: e.message });
    } finally {
      state.analyzing = null;
      S.setData('analysis', state.analysis);
      render();
    }
  }

  // ---------------------------------------------------------------- refresh
  async function refresh(force) {
    if (state.busy || !settings.account) return;
    state.busy = true; setStatus('Updating…'); render();
    loadHelper().then(render);
    try {
      await loadAssets();
      await Promise.all([loadProfile(), loadHistory(force), loadPatch()]);
      render();
      await loadLobbies();
      // A habit is being tracked: read the new games' details so their ✓/✗ shows up.
      if (state.focus.active) await ensureDetails();
      setStatus('');
    } catch (e) {
      setStatus(e.waitMs ? 'deadlock-api is rate-limiting. Try again in a minute.' : 'Couldn’t reach deadlock-api: ' + e.message);
    } finally {
      state.busy = false; render();
    }
  }

  // ---------------------------------------------------------------- events
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  $('#refresh').addEventListener('click', () => refresh(true));
  $('#who').addEventListener('click', () => ctx.go('#/about'));
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  // The helper is local and cheap, so poll it once a minute while the page is visible.
  setInterval(() => { if (!document.hidden && settings.account) loadHelper().then(() => { if (state.route.tab === 'play') render(); }); }, 60 * 1000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  refresh(false);
})();
