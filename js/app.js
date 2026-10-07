/* app.js — wiring: load cache -> render instantly -> refresh from the API -> render again.
   No numbers are computed here; everything comes from Engine so the tests cover it. */
(function () {
  'use strict';
  const E = window.Engine, A = window.Api, S = window.Store, C = window.Charts, P = window.Play;
  const ACCT = E.ACCOUNT_ID;
  const HISTORY_TTL = 3 * 60 * 1000;
  const ASSET_TTL = 7 * 86400 * 1000;
  const BLEND_DAYS = 120;   // unranked games older than this never enter a baseline

  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = {
    history: S.get('history', null),      // { at, matches: [...normalized] }
    lobbies: S.get('lobbies', {}),        // { matchId: compactLobby }
    assets: S.get('assets', null),        // { at, heroes: {id: {name, icon}}, tiers: [names] }
    settings: Object.assign({ window: 'last20', blend: false, games: 'all' }, S.get('settings', {})),
    helper: S.get('helper', null),        // last /sessions payload from the local helper, + `at`
    helperLive: false,                    // did the helper answer this time?
    status: '', busy: false,
  };

  // ---------------------------------------------------------------- formatting
  const heroName = id => (state.assets && state.assets.heroes[id] && state.assets.heroes[id].name) || 'Hero ' + id;
  const heroIcon = id => (state.assets && state.assets.heroes[id] && state.assets.heroes[id].icon) || '';
  const tiers = () => state.assets && state.assets.tiers;
  const pct = x => Math.round(x * 100) + '%';
  const signed = C.signed;
  const ago = t => {
    const s = Date.now() / 1000 - t;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 14) return Math.round(s / 86400) + 'd ago';
    return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const formWord = s => s >= 0.75 ? 'well above your usual' : s >= 0.2 ? 'above your usual' : s > -0.2 ? 'around your usual' : s > -0.75 ? 'below your usual' : 'well below your usual';
  const scoreTxt = s => (s >= 0 ? '+' : '−') + Math.abs(s).toFixed(1);
  const ICON = { 1: '▲', 0: '■', '-1': '▼', null: '·' };

  // ---------------------------------------------------------------- derived model
  function model() {
    const all = (state.history && state.history.matches) || [];
    const ranked = all.filter(m => m.mode === 'ranked');
    const season = E.seasonOf(ranked);
    const since = season.length ? season[0].t : 0;
    // 'all' = every ranked + unranked game since the ranked season began. Rank points still come
    // only from ranked games (summarize skips null deltas), so the rank signal stays honest.
    const allMode = state.settings.games === 'all';
    const scope = allMode ? all.filter(m => m.t >= since) : season;
    const blendFrom = Math.max(since, Date.now() / 1000 - BLEND_DAYS * 86400);
    const pool = allMode ? scope
      : state.settings.blend ? all.filter(m => m.mode === 'ranked' ? m.t >= since : m.t >= blendFrom)
      : season;
    const perf = E.perfScores(pool, state.lobbies, scope);
    const w = E.windowsFor(state.settings.window, allMode ? scope : ranked);
    const cur = E.summarize(w.cur, perf, state.lobbies);
    const prev = w.prev.length ? E.summarize(w.prev, perf, state.lobbies) : null;
    const curRanked = E.summarize(w.cur.filter(m => m.mode === 'ranked'), perf, state.lobbies);
    const v = E.verdict(cur, prev, E.rankUnit(season));
    const seasonSum = E.summarize(season, perf, state.lobbies);
    return { all, ranked, season, scope, allMode, pool, perf, w, cur, prev, curRanked, v, seasonSum };
  }

  // ---------------------------------------------------------------- render
  function render() {
    const M = model();
    renderHeader(M);
    renderPlay(M);
    renderTabs();
    renderVerdict(M);
    renderRank(M);
    renderMix(M);
    renderGames(M);
    renderHeroes(M);
    renderFooter(M);
  }

  function renderHeader(M) {
    const last = M.ranked[M.ranked.length - 1];
    const badge = last && last.badge;
    $('#identity').innerHTML = !M.all.length ? '<p class="muted">Loading your matches…</p>' : `
      ${badge ? `<img class="badge" src="${A.rankImage(badge)}" alt="" width="56" height="56">` : ''}
      <div>
        <div class="rank-name">${esc(E.badgeName(badge, tiers()))}</div>
        <div class="muted">Season: ${M.seasonSum.wins}–${M.seasonSum.losses} · ${M.seasonSum.hasDelta ? signed(M.seasonSum.net) + ' rank pts' : 'no rank-point data'} · ${M.season.length} ranked games</div>
      </div>`;
    $('#status').textContent = state.status;
    $('#refresh').disabled = state.busy;
  }

  // ---------------------------------------------------------------- play time
  const clock = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayLabel = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
  const hourLabel = h => { const f = x => (x % 12 || 12) + (x % 24 < 12 ? ' AM' : ' PM'); return f(h) + '–' + f(h + 1); };

  function renderPlay(M) {
    const now = Date.now() / 1000;
    let H = state.helper;
    // Helper unreachable: an open session can't be trusted past the last time it reported.
    if (H && !state.helperLive) {
      H = Object.assign({}, H, { playing: false, sessions: H.sessions.map(x => x.end == null ? { start: x.start, end: H.at / 1000 } : x) });
    }
    const p = P.summary(H, M.all, now);
    const live = state.helperLive && p.playing;
    $('#play-live').hidden = !live;

    const vs = p.avgSecs == null ? ''
      : `<div class="muted">Your usual: <b class="ink">${P.dur(p.avgSecs)}</b> a day over the last ${p.avgDays} days` +
        (p.todaySecs > p.avgSecs + 600 ? ` · today is <b class="ink">${P.dur(p.todaySecs - p.avgSecs)} over</b>` : '') + '</div>';
    const sessions = H ? `${p.todaySessions} session${p.todaySessions === 1 ? '' : 's'}${live && p.playingSince ? ' · this one since ' + clock(p.playingSince) : ''}`
      : 'from matches on deadlock-api (can lag)';
    const apiToday = M.all.filter(m => P.dayKey(m.t) === p.today).length;
    $('#play-today').innerHTML = `
      <div class="big">${P.dur(p.todaySecs)}</div>
      <div class="muted">${sessions}${H ? ` · ${apiToday} match${apiToday === 1 ? '' : 'es'} on deadlock-api so far` : ''}</div>
      ${vs}`;

    p.cells.forEach(c => { c.today = c.key === p.today; });
    C.heatmap($('#play-heat'), p.cells, {
      label: 'Hours played per day over the last 12 weeks',
      tipHtml: c => `<b>${dayLabel(c.key)}</b><br>${c.secs ? P.dur(c.secs) : 'Didn’t play'}<br><span class="muted">${c.src === 'helper' ? 'helper: time in game' : 'deadlock-api: matches only'}</span>`,
    });
    C.hourBars($('#play-hours'), p.hours, {
      label: 'Time played by hour of day over the last 4 weeks',
      tipHtml: (h, v) => `<b>${hourLabel(h)}</b><br>${v ? P.dur(v) + ' over 4 weeks' : 'Never'}`,
    });

    const since = H && H.since ? new Date(H.since * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
    $('#play-src').innerHTML = !H
      ? 'Counting match time from deadlock-api, which can lag or miss games. Run the Climb helper on your PC (<code>helper/install-task.ps1</code>) for real play time.'
      : `From ${since}: the helper on your PC, counting all time with Deadlock open (queue and menus too). Before that: match time from deadlock-api.` +
        (state.helperLive ? '' : ` <b class="ink">Helper not reachable</b>, showing what it reported ${ago(state.helper.at / 1000)}.`);
  }

  async function loadHelper() {
    const h = await A.helper();
    state.helperLive = !!h;
    if (h) { state.helper = Object.assign(h, { at: Date.now() }); S.set('helper', state.helper); }
  }

  function renderTabs() {
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.w === state.settings.window));
    document.querySelectorAll('#scope button').forEach(b => b.setAttribute('aria-pressed', b.dataset.g === state.settings.games));
  }

  function signalLine(s, M) {
    const d = s.detail, prevLabel = M.w.prevLabel;
    let text;
    if (s.text === 'rank') {
      const R = M.curRanked;
      if (M.allMode && d.net != null) Object.assign(d, { wins: R.wins, losses: R.losses });
      const of = M.allMode ? ` over ${R.n} ranked game${R.n === 1 ? '' : 's'}` : '';
      text = M.allMode && !R.n ? `<b>No ranked games here</b>, so no rank points. Overall ${M.cur.wins}–${M.cur.losses}.`
        : d.net == null ? `${d.wins}–${d.losses}, but these games carry no rank-point data`
        : s.dir === 1 ? `<b>Up ${C.fmtInt(d.net)} rank points</b>${of} (${d.wins}–${d.losses})`
        : s.dir === -1 ? `<b>Down ${C.fmtInt(-d.net)} rank points</b>${of} (${d.wins}–${d.losses})`
        : `<b>About even on rank</b>: ${signed(d.net)} pts${of} (${d.wins}–${d.losses})`;
    } else if (s.text === 'form') {
      if (s.dir == null) text = `<b>Form</b>: only ${d.classified} scored game${d.classified === 1 ? '' : 's'} here, and it needs 3 to call it. (A hero's games are scored once you have ${E.MIN_HERO_GAMES}+ games on it.)`;
      else if (d.tougher) text = `<b>Placing a little lower</b> than ${esc(prevLabel)}, but your lobbies got about ${Math.round(M.v.lobbyShift)} subranks tougher. Keeping pace there counts.`;
      else {
        const vs = d.hasRef ? esc(prevLabel) : 'your usual';
        const nums = `form ${scoreTxt(d.score)} vs ${scoreTxt(d.ref)}`;
        text = s.dir === 1 ? `<b>Playing better</b> than ${vs}: ${nums}`
          : s.dir === -1 ? `<b>Playing worse</b> than ${vs}: ${nums}`
          : `<b>Playing about the same</b> as ${vs}: ${nums}`;
      }
    } else {
      if (s.dir == null) text = d.of ? `<b>${d.rough} rough game${d.rough === 1 ? '' : 's'}</b> of ${d.of} scored. Nothing earlier to compare with.` : '<b>Consistency</b>: not enough scored games yet.';
      else if (d.tougher) text = `<b>More rough games</b> (${pct(d.rate)} vs ${pct(d.ref)}) while your lobbies got tougher.`;
      else text = s.dir === 1 ? `<b>Fewer rough games</b>: ${d.rough} of ${d.of} (${pct(d.rate)}) vs ${pct(d.ref)} before`
        : s.dir === -1 ? `<b>More rough games</b>: ${d.rough} of ${d.of} (${pct(d.rate)}) vs ${pct(d.ref)} before`
        : `<b>Steady</b>: ${d.rough} rough of ${d.of} (${pct(d.rate)}) vs ${pct(d.ref)} before`;
    }
    const dir = s.dir == null ? 'na' : s.dir === 1 ? 'up' : s.dir === -1 ? 'down' : 'flat';
    return `<li class="sig ${dir}"><span class="sig-icon" aria-hidden="true">${ICON[s.dir]}</span><span>${text}</span></li>`;
  }

  function renderVerdict(M) {
    const v = M.v;
    const WORD = { improving: 'Improving', holding: 'Holding', slipping: 'Slipping', unknown: 'Not enough games' };
    const ICONV = { improving: '▲', holding: '■', slipping: '▼', unknown: '·' };
    const sub = M.cur.n
      ? `${esc(M.w.label)}: ${M.cur.n} game${M.cur.n === 1 ? '' : 's'}${M.prev ? ' vs ' + esc(M.w.prevLabel) : ''}`
      : `No ${M.allMode ? '' : 'ranked '}games in this window yet.`;
    $('#verdict').className = 'card verdict v-' + v.call;
    $('#verdict').innerHTML = `
      <div class="v-head">
        <span class="v-icon" aria-hidden="true">${ICONV[v.call]}</span>
        <div>
          <div class="v-word">${WORD[v.call]}</div>
          <div class="muted">${sub}${v.confidence === 'low' && M.cur.n ? ' · small sample, so treat it as a hint' : ''}</div>
        </div>
      </div>
      <ul class="signals">${v.signals.map(s => signalLine(s, M)).join('')}</ul>`;
  }

  function renderRank(M) {
    const pts = E.rankSeries(M.season);
    // First ranked point inside the window (in 'all' mode the window may start on an unranked game).
    const t0 = M.w.cur.length ? M.w.cur[0].t : Infinity;
    const hiFrom = state.settings.window === 'season' ? null : pts.findIndex(p => p.t >= t0);
    C.rankLine($('#rank-chart'), pts, {
      hiFrom: hiFrom < 0 ? null : hiFrom,
      label: 'Cumulative rank points across the season',
      tipHtml: p => `<b>${signed(p.cum)} pts</b> · ${esc(E.badgeName(p.badge, tiers()))}<br>${p.won ? 'Win' : 'Loss'} on ${esc(heroName(p.hero))} (${signed(p.delta)})<br><span class="muted">${new Date(p.t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`,
    });
  }

  function renderMix(M) {
    const rows = [{ label: state.settings.window === 'season' ? '2nd half' : 'Now', q: M.cur.q }];
    if (M.prev) rows.push({ label: state.settings.window === 'season' ? '1st half' : 'Before', q: M.prev.q });
    C.mixBars($('#mix-chart'), rows, E.QUADS, E.QUAD_LABEL);
    $('#mix-legend').innerHTML = E.QUADS.map(q =>
      `<li><span class="key q-${q}"></span>${E.QUAD_LABEL[q]} <span class="num">${M.cur.q[q]}${M.prev ? ' <span class="muted">/ ' + M.prev.q[q] + '</span>' : ''}</span></li>`).join('');
    const unscored = M.cur.n - M.cur.classified;
    $('#mix-note').textContent = unscored > 0 ? `${unscored} game${unscored === 1 ? ' in this window isn’t' : 's in this window aren’t'} scored yet (a hero needs ${E.MIN_HERO_GAMES}+ games, or lobby data is still loading).` : '';
  }

  function gameRow(m, M) {
    const p = M.perf.get(m.id), L = state.lobbies[m.id];
    const st = L ? E.lobbyStats(L) : null;
    const cls = E.classify(m, p);
    const heroGames = M.pool.filter(x => x.hero === m.hero && state.lobbies[x.id]).length;
    const chip = cls ? `<span class="chip"><span class="key q-${cls}"></span>${E.QUAD_LABEL[cls]}</span>`
      : `<span class="chip muted">${L ? `Unscored · ${heroGames}/${E.MIN_HERO_GAMES} games` : 'Lobby loading…'}</span>`;
    const modeTag = M.allMode && m.mode !== 'ranked' ? '<span class="tag mode">Unranked</span>' : '';
    const tags = modeTag + (st ? st.tags.map(t => `<span class="tag">${E.TAG_LABEL[t]}</span>`).join('') : '');
    const delta = m.delta == null ? '' : `<span class="delta ${m.delta > 0 ? 'pos' : m.delta < 0 ? 'neg' : ''}">${signed(m.delta)}</span>`;
    const icon = heroIcon(m.hero);
    let detail = '';
    if (st) {
      const n = st.size;
      const place = (label, r, note) => `<div class="place"><span class="muted">${label}</span><b>#${r}</b><span class="muted">/${n}${note ? ' ' + note : ''}</span></div>`;
      const zRow = p ? ['souls', 'dmg', 'ka', 'deaths'].map(k => {
        const z = p.z[k]; if (z == null) return '';
        const lab = { souls: 'Souls', dmg: 'Damage', ka: 'Kills + assists', deaths: 'Staying alive' }[k];
        return `<li><span>${lab}</span><span class="${z >= 0.2 ? 'pos' : z <= -0.2 ? 'neg' : 'muted'}">${scoreTxt(z)}</span></li>`;
      }).join('') : '';
      detail = `
        <div class="detail">
          <div class="places">
            ${place('Souls', st.ranks.souls)}${place('Damage', st.ranks.dmg)}${place('K+A', st.ranks.ka)}${place('Deaths', st.ranks.deaths, '(fewest = #1)')}
          </div>
          <p class="muted small">${m.k}/${m.d}/${m.a} · ${C.fmtInt(m.souls)} souls · ${Math.round(m.dur / 60)} min${L.avgBadge ? ' · lobby avg ' + esc(E.badgeName(L.avgBadge, tiers())) : ''}</p>
          ${p ? `<p class="small">Form <b>${scoreTxt(p.score)}</b>, ${formWord(p.score)}, compared with your ${p.base} other ${esc(heroName(m.hero))} games:</p><ul class="zs">${zRow}</ul>`
              : `<p class="small muted">No form score yet. This game is compared only once you have ${E.MIN_HERO_GAMES}+ games on ${esc(heroName(m.hero))}.</p>`}
        </div>`;
    }
    return `
      <li><details>
        <summary>
          ${icon ? `<img class="hero-ic" src="${icon}" alt="" width="36" height="36" loading="lazy">` : '<span class="hero-ic"></span>'}
          <span class="g-main">
            <span class="g-title"><b>${esc(heroName(m.hero))}</b> <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span> ${delta}</span>
            <span class="g-sub">${chip}${tags}</span>
          </span>
          <span class="g-time muted">${ago(m.t)}</span>
        </summary>
        ${detail}
      </details></li>`;
  }

  function renderGames(M) {
    const games = M.w.cur.slice().reverse();
    $('#games-title').textContent = state.settings.window === 'season' ? 'Games: second half of season' : 'Games: ' + M.w.label.toLowerCase();
    $('#games').innerHTML = games.length ? games.map(m => gameRow(m, M)).join('') : `<li class="muted">No ${M.allMode ? '' : 'ranked '}games here yet.</li>`;
  }

  function renderHeroes(M) {
    const rows = E.heroBreakdown(M.scope, M.perf);
    $('#heroes').innerHTML = `
      <thead><tr><th>Hero</th><th class="n">Games</th><th class="n">W–L</th><th class="n">Rank pts</th><th>Form</th><th>Mix</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td class="h">${heroIcon(r.hero) ? `<img src="${heroIcon(r.hero)}" alt="" width="24" height="24" loading="lazy">` : ''}${esc(heroName(r.hero))}</td>
          <td class="n">${r.games}</td>
          <td class="n">${r.wins}–${r.losses}</td>
          <td class="n">${r.hasDelta ? signed(r.net) : '—'}</td>
          <td>${!r.ready ? `<span class="muted">${r.games}/${E.MIN_HERO_GAMES} games</span>` : r.trend == null ? '<span class="muted">building</span>' : `<span class="${r.trend >= 0.2 ? 'pos' : r.trend <= -0.2 ? 'neg' : 'muted'}">${r.trend >= 0.2 ? '▲ rising' : r.trend <= -0.2 ? '▼ dipping' : '■ steady'}</span>`}</td>
          <td>${C.miniMix(r.q, E.QUADS)}</td>
        </tr>`).join('')}</tbody>`;
  }

  function renderFooter(M) {
    $('#blend').checked = state.settings.blend;
    $('#blend').closest('label').hidden = M.allMode;   // 'all' already uses every game
    const need = lobbyTargets(M);
    const have = need.filter(id => state.lobbies[id]).length;
    $('#data-status').textContent = `${M.all.length} matches on record · lobby data for ${have}/${need.length} games in use` +
      (state.history ? ` · history updated ${ago(state.history.at / 1000)}` : '');
  }

  // ---------------------------------------------------------------- loading
  function lobbyTargets(M) {
    return (M || model()).pool.map(m => m.id);
  }

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

  async function loadHistory(force) {
    if (!force && state.history && Date.now() - state.history.at < HISTORY_TTL) return;
    const rows = await A.history(ACCT);
    state.history = { at: Date.now(), matches: E.normalizeHistory(rows) };
    S.set('history', state.history);
  }

  async function loadLobbies() {
    const missing = lobbyTargets().filter(id => !(id in state.lobbies)).reverse(); // newest first
    for (let i = 0; i < missing.length; i += A.BATCH) {
      const ids = missing.slice(i, i + A.BATCH);
      setStatus(`Loading lobbies… ${Math.min(i + A.BATCH, missing.length)}/${missing.length}`);
      const metas = await A.metadata(ids);
      const got = new Set();
      for (const meta of metas) {
        const L = E.compactLobby(meta, ACCT);
        if (L) { state.lobbies[meta.match_id] = L; got.add(meta.match_id); }
      }
      // A match the API has no metadata for is recorded as null so we don't ask forever.
      for (const id of ids) if (!got.has(id)) state.lobbies[id] = null;
      S.set('lobbies', state.lobbies);
      render();
      if (i + A.BATCH < missing.length) await A.sleep(A.SPACING_MS);
    }
  }

  function setStatus(s) { state.status = s; $('#status').textContent = s; }

  async function refresh(force) {
    if (state.busy) return;
    state.busy = true; setStatus('Updating…'); render();
    loadHelper().then(render);
    try {
      await loadAssets();
      await loadHistory(force);
      render();
      await loadLobbies();
      setStatus('');
    } catch (e) {
      setStatus(e.waitMs ? 'deadlock-api is rate-limiting. Try again in a minute.' : 'Couldn’t reach deadlock-api: ' + e.message);
    } finally {
      state.busy = false; render();
    }
  }

  // ---------------------------------------------------------------- events
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-w]');
    if (!b) return;
    state.settings.window = b.dataset.w; S.set('settings', state.settings); render();
  });
  $('#scope').addEventListener('click', e => {
    const b = e.target.closest('button[data-g]');
    if (!b) return;
    state.settings.games = b.dataset.g; S.set('settings', state.settings); render(); refresh(false);
  });
  $('#refresh').addEventListener('click', () => refresh(true));
  $('#blend').addEventListener('change', e => {
    state.settings.blend = e.target.checked; S.set('settings', state.settings); render(); refresh(false);
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderRank(model()), 120); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  // The helper is local and cheap, so poll it once a minute while the page is visible.
  setInterval(() => { if (!document.hidden) loadHelper().then(render); }, 60 * 1000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  refresh(false);
})();
