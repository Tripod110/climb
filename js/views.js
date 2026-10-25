/* views.js — one function per page. Each takes (host, ctx) and writes HTML from ctx.M (the model
   app.js builds) and Engine. No fetching here except asking app.js to ensure data it needs. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- shared bits
  const ICONV = { improving: '▲', holding: '■', slipping: '▼', unknown: '·' };
  const WORD = { improving: 'Improving', holding: 'Holding', slipping: 'Slipping', unknown: 'Not enough games' };
  const roleClass = (E, r) => E.ROLE_GOOD[r] > 0 ? 'good' : E.ROLE_GOOD[r] < 0 ? 'bad' : 'flat';
  const firstChip = g => g && g.lobbyFirst ? '<span class="first" title="Valve named you MVP: 1st in the lobby">★ 1st</span>' : '';
  /* Team share is neutral on purpose: on the user's 400 games it didn't predict results (see
     Engine.teamShare). Gold ★ 1st (Valve's MVP) is the only highlight. */
  const roleChip = (c, g, id) => g ? `${firstChip(g)}<span class="role share" title="Your share of your own team's stats: #${g.teamRank} of ${g.teamSize}. Describes your part, doesn't predict wins.">${g.teamRank <= 2 ? 'Top share' : g.teamRank >= g.teamSize - 1 ? 'Low share' : 'Mid share'}</span>`
    : id != null && c.state.lobbies[id] === null ? '<span class="role pending">No lobby data</span>' : '<span class="role pending">Reading lobby…</span>';

  /* Where a number comes from. Tap a badge to see how it was worked out. Kinds:
     yours = counted from your own games · model = Climb's trained win model · ranks = averages
     of other players' games by rank · valve = straight from the game · rule = a Climb rule of
     thumb, not proven to predict wins · ai = Gemini's wording. */
  const SRC = { yours: 'Your games', model: 'Trained model', ranks: 'Rank data', valve: 'Valve', rule: 'Climb rule', ai: 'AI' };
  const src = (kind, note) => `<button type="button" class="src src-${kind}" data-note="${String(note).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" aria-label="${SRC[kind]}: how this was worked out">${SRC[kind]}</button>`;
  let popover = null;
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.src');
    if (popover && (!b || popover.dataset.for !== b.dataset.note)) { popover.remove(); popover = null; }
    if (!b || popover) return;
    popover = document.createElement('div');
    popover.className = 'src-pop'; popover.dataset.for = b.dataset.note;
    popover.innerHTML = `<b>${b.textContent}</b><p>${b.dataset.note}</p>`;
    document.body.appendChild(popover);
    const r = b.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 24);
    popover.style.width = w + 'px';
    popover.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + window.scrollX - 8)) + 'px';
    popover.style.top = (r.bottom + window.scrollY + 6) + 'px';
  });

  // MVP #1 already shows as the gold ★ 1st chip, so its tag is left out of the tag list.
  const tagChips = (c, g, max) => !g ? '' : g.tags.filter(t => t !== 'mvp1').slice(0, max || 99).map(t => `<span class="tag${c.E.TAG2_GOOD[t] < 0 ? ' warn' : ''}">${c.E.TAG2_LABEL[t]}</span>`).join('');
  const icon = (c, hero, size) => {
    const src = c.heroIcon(hero);
    return src ? `<img class="hero-ic" src="${src}" alt="" width="${size}" height="${size}" loading="lazy">` : `<span class="hero-ic" style="width:${size}px;height:${size}px"></span>`;
  };
  const kda = m => `${m.k}<span class="sl">/</span>${m.d}<span class="sl">/</span>${m.a}`;
  const deltaHtml = (c, m) => m.delta == null ? '<span class="muted">—</span>' : `<span class="${m.delta > 0 ? 'pos' : m.delta < 0 ? 'neg' : 'muted'}">${c.signed(m.delta)}</span>`;
  const mins = s => Math.round(s / 60) + 'm';
  const seg = (name, opts, cur) => `<div class="seg-ctl" role="group" aria-label="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
  const bindSeg = (host, sel, fn) => host.querySelectorAll(sel + ' button').forEach(b => b.addEventListener('click', () => fn(b.dataset.v)));
  const impactBar = v => {
    const w = Math.max(4, Math.min(100, (v / 2) * 100));
    return `<span class="ibar" title="Impact ${v.toFixed(2)} (1.00 = an average teammate)"><span style="width:${w}%" class="${v >= 1.3 ? 'hi' : v < 0.8 ? 'lo' : ''}"></span></span>`;
  };

  // ---------------------------------------------------------------- welcome / onboarding
  function welcome(host, c) {
    const s = c.state.search;
    host.innerHTML = `
      <section class="welcome">
        <div class="brand-xl">Climb</div>
        <h1>Find out what's holding your rank back.</h1>
        <p class="lede">Your Deadlock matches, read for you: whether you're improving, which games you carried, and how each of your heroes compares with players at every rank from Initiate to Eternus.</p>
        <form id="acct-form" class="acct-form" autocomplete="off">
          <label for="acct-in" class="sr">Steam profile, SteamID or name</label>
          <input id="acct-in" type="text" placeholder="Steam profile URL, SteamID or name" value="${c.esc(s ? s.q : '')}" spellcheck="false">
          <button type="submit" class="btn">Look up</button>
        </form>
        <p class="hint">Paste your Steam profile link (steamcommunity.com/profiles/…), a SteamID64, or just search your Steam name. Match data comes from deadlock-api.com, so your Deadlock match history needs to be public there.</p>
        <div id="acct-results">${!s ? '' : s.busy ? '<p class="muted">Searching…</p>'
          : s.error ? `<p class="neg">${c.esc(s.error)}</p>`
          : !s.results.length ? '<p class="muted">No Deadlock players found with that name. Try your profile URL instead.</p>'
          : `<ul class="pick">${s.results.map(r => `<li><button type="button" data-acct="${r.account}">
              ${r.avatar ? `<img src="${c.esc(r.avatar)}" alt="" width="36" height="36">` : '<span class="av-ph"></span>'}
              <span><b>${c.esc(r.name || 'Unknown')}</b><span class="muted small">${r.games} games in the last 30 days · ID ${r.account}</span></span>
            </button></li>`).join('')}</ul>`}</div>
      </section>`;
    host.querySelector('#acct-form').addEventListener('submit', e => { e.preventDefault(); c.searchAccount(host.querySelector('#acct-in').value); });
    host.querySelectorAll('[data-acct]').forEach(b => b.addEventListener('click', () => c.setAccount(Number(b.dataset.acct))));
    if (!s) host.querySelector('#acct-in').focus();
  }

  // ---------------------------------------------------------------- overview
  function overview(host, c) {
    const M = c.M, E = c.E, S = c.settings;
    if (!M.all.length) { host.innerHTML = `<div class="empty-state">${c.state.busy ? 'Loading your matches…' : 'No matches found for this account yet.'}</div>`; return; }
    const v = M.v;
    const roles = E.roleSummary(M.w.cur, c.state.lobbies);
    const items = c.state.items && c.state.items.map;
    const early = E.earlyRates(M.w.cur.map(c.entryOf), items);
    const earlyPrev = M.w.prev.length ? E.earlyRates(M.w.prev.map(c.entryOf), items) : null;
    const cat = c.focusCatalog();
    const catOf = id => cat.find(x => x.id === id);
    const splitNote = id => { const x = catOf(id); return x && x.n ? ` Over your last ${x.n} games you won ${c.pct(x.wrPass)} when you did this and ${c.pct(x.wrFail)} when you didn’t.` : ''; };
    const delta = (a, b, good) => a == null || b == null ? '' : (() => {
      const d = a - b; if (Math.abs(d) < 0.02) return '<span class="muted">same as before</span>';
      const up = d > 0; return `<span class="${up === good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))} pts</span>`;
    })();
    const tile = (label, value, sub, badge) => `<div class="tile"><div class="t-label">${label}${badge ? ' ' + badge : ''}</div><div class="t-val">${value}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    const R = M.curRanked;
    const fresh = c.LOG.filter(e => e.v > S.seenV).slice(0, 2);
    const recent = M.all.slice(-8).reverse();
    const heroes = E.heroBreakdown(M.w.cur, M.perf).slice(0, 5);

    host.innerHTML = `
      ${fresh.length ? `<section class="card whatsnew"><div class="wn-head"><h2>What’s new</h2><button id="wn-ok" class="btn ghost-btn" type="button">Got it</button></div>
        ${fresh.map(e => `<h3>v${e.v} · ${c.esc(e.title)}</h3><ul>${e.items.map(i => `<li>${c.esc(i)}</li>`).join('')}</ul>`).join('')}</section>` : ''}
      ${missingCard(c)}
      ${recapCard(c)}
      ${focusCard(c, false)}

      <div class="page-head">
        <div class="ident">
          ${M.badge ? `<img class="badge" src="${c.A.rankImage(M.badge)}" alt="" width="64" height="64">` : ''}
          <div>
            <div class="rank-name">${c.esc(E.badgeName(M.badge, c.tiers()))}</div>
            <div class="muted">Season ${M.seasonSum.wins}–${M.seasonSum.losses}${M.seasonSum.hasDelta ? ' · ' + c.signed(M.seasonSum.net) + ' rank pts' : ''} · ${M.all.length} matches tracked</div>
            ${freshLine(c)}
          </div>
        </div>
        <div class="ctl-row">
          ${seg('Time window', [['session', 'Last session'], ['last20', 'Last 20'], ['season', 'Season']], S.window).replace('class="seg-ctl"', 'class="seg-ctl" id="win"')}
          ${seg('Which games', [['all', 'All games'], ['ranked', 'Ranked']], S.games).replace('class="seg-ctl"', 'class="seg-ctl" id="scope"')}
        </div>
      </div>

      <div class="grid-ov">
        <section class="card verdict v-${v.call}">
          <div class="v-head"><span class="v-icon" aria-hidden="true">${ICONV[v.call]}</span>
            <div><div class="v-word">${WORD[v.call]}</div>
            <div class="muted small">${c.esc(M.w.label)} · ${M.cur.n} games${M.prev ? ' vs ' + c.esc(M.w.prevLabel) : ''}${v.confidence === 'low' && M.cur.n ? ' · small sample' : ''}</div></div></div>
          <ul class="signals">${v.signals.map(s => signalLine(c, s)).join('')}</ul>
        </section>
        <div class="tiles">
          ${tile('Win rate', c.pct(M.cur.winRate), `${M.cur.wins}–${M.cur.losses}`, src('yours', `Wins ÷ games in this window (${M.cur.n} games), from your match history on deadlock-api.`))}
          ${tile('Rank points', R.hasDelta ? c.signed(R.net) : '—', R.n ? `${R.n} ranked games` : 'no ranked games', src('valve', 'The sum of Valve’s own rank-point change for each ranked game in this window.'))}
          ${tile('Ahead of lane at 12:00', early.nAhead ? c.pct(early.ahead12) : '—', earlyPrev && earlyPrev.nAhead ? delta(early.ahead12, earlyPrev.ahead12, true) : `${early.nAhead} games with detail`, src('yours', `Games where your souls at 12:00 beat your lane opponents’ average, out of ${early.nAhead} games in this window with match detail.` + splitNote('ahead12')))}
          ${tile('No deaths before 10:00', early.nClean ? c.pct(early.clean10) : '—', earlyPrev && earlyPrev.nClean ? delta(early.clean10, earlyPrev.clean10, true) : `${early.nClean} games with detail`, src('yours', `Games with zero deaths in the first 10 minutes, out of ${early.nClean} games in this window with match detail.` + splitNote('early0')))}
          ${tile('Deaths per game', M.cur.n ? (M.w.cur.reduce((s, m) => s + m.d, 0) / M.cur.n).toFixed(1) : '—', M.prev && M.prev.n ? `${(M.w.prev.reduce((s, m) => s + m.d, 0) / M.prev.n).toFixed(1)} before` : '', src('yours', 'Average deaths per game in this window, from your match history.'))}
          ${tile('MVP awards', roles.n ? String(roles.mvp) : '—', roles.n ? `in ${roles.n} games` : '', src('valve', 'Valve’s post-game MVP (1st to 3rd in the lobby), as recorded in the match data.'))}
        </div>
      </div>

      <section class="card">
        <div class="card-head"><h2>What separates your wins from your losses</h2><a href="#/coach" class="more">Pick a habit to work on →</a></div>
        ${splitTable(c, cat)}
      </section>

      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2>Recent matches</h2><a href="#/matches" class="more">See all →</a></div>
          <ul class="mini-list">${recent.map(m => {
            const g = E.gameRole(c.state.lobbies[m.id], m.won);
            return `<li><a href="#/match/${m.id}">${icon(c, m.hero, 30)}
              <span class="ml-main"><b>${c.esc(c.heroName(m.hero))}</b> <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'W' : 'L'}</span> ${roleChip(c, g, m.id)}</span>
              <span class="ml-kda">${kda(m)}</span><span class="ml-d">${deltaHtml(c, m)}</span><span class="muted small ml-t">${c.ago(m.t)}</span></a></li>`;
          }).join('')}</ul>
        </section>
        <section class="card">
          <div class="card-head"><h2>Heroes in this window</h2><a href="#/heroes" class="more">Your road to the next rank →</a></div>
          <ul class="mini-list">${heroes.map(h => `<li><a href="#/heroes/${h.hero}">${icon(c, h.hero, 30)}
            <span class="ml-main"><b>${c.esc(c.heroName(h.hero))}</b> <span class="muted small">${h.games} games</span></span>
            <span class="ml-kda">${h.wins}–${h.losses}</span><span class="ml-d">${h.hasDelta ? `<span class="${h.net > 0 ? 'pos' : h.net < 0 ? 'neg' : 'muted'}">${c.signed(h.net)}</span>` : ''}</span>
            <span class="ml-t">${trendTxt(h)}</span></a></li>`).join('')}</ul>
        </section>
      </div>

      <section class="card">
        <h2>Rank points this season</h2>
        <p class="muted small">Running total of points gained and lost. The shaded area is the window you’re looking at.</p>
        <div id="rank-chart" class="chart"></div>
      </section>`;

    const pts = E.rankSeries(M.season);
    const t0 = M.w.cur.length ? M.w.cur[0].t : Infinity;
    const hiFrom = S.window === 'season' ? null : pts.findIndex(p => p.t >= t0);
    c.C.rankLine(host.querySelector('#rank-chart'), pts, {
      hiFrom: hiFrom < 0 ? null : hiFrom,
      label: 'Cumulative rank points across the season',
      tipHtml: p => `<b>${c.signed(p.cum)} pts</b> · ${c.esc(E.badgeName(p.badge, c.tiers()))}<br>${p.won ? 'Win' : 'Loss'} on ${c.esc(c.heroName(p.hero))} (${c.signed(p.delta)})`,
    });
    bindSeg(host, '#win', v2 => { S.window = v2; c.save(); c.render(); });
    bindSeg(host, '#scope', v2 => { S.games = v2; c.save(); c.render(); });
    const ok = host.querySelector('#wn-ok');
    if (ok) ok.addEventListener('click', () => { S.seenV = c.VERSION; c.save(); c.render(); });
    const mk = host.querySelector('#missing-ok');
    if (mk) mk.addEventListener('click', () => c.dismissMissing(c.freshnessNow().newestId));
    const rk = host.querySelector('#recap-ok');
    if (rk) rk.addEventListener('click', () => { const s0 = E.lastSession(M.all, c.state.helper, Date.now() / 1000, 18); if (s0) c.dismissRecap(s0.end); });
    if (!c.state.detailsBusy) c.ensureDetails();
  }

  function trendTxt(h) {
    if (!h.ready || h.trend == null) return '<span class="muted small">—</span>';
    return h.trend >= 0.2 ? '<span class="pos small">▲ rising</span>' : h.trend <= -0.2 ? '<span class="neg small">▼ dipping</span>' : '<span class="muted small">■ steady</span>';
  }

  /* The habits that split YOUR wins from losses most, from your last 30 games. Plain counts. */
  function splitTable(c, cat) {
    const rows = cat.filter(x => x.eligible).slice(0, 4);
    if (!rows.length) return '<p class="muted small">Counting once match details for your recent games have loaded…</p>';
    return `<ul class="splits">${rows.map(x => `<li><span>${c.esc(x.label)}${x.outcome ? ' <span class="tag" title="Partly follows the result">follows result</span>' : ''}</span>
      <span class="sp-bars"><span class="sp-w" style="width:${Math.round(x.wrPass * 100)}%"></span></span>
      <span class="sp-num"><b class="pos">${c.pct(x.wrPass)}</b> when you do · <span class="neg">${c.pct(x.wrFail)}</span> when you don’t · you do it in ${c.pct(x.passRate)}</span></li>`).join('')}</ul>
      <p class="muted small">${src('yours', `Win rate in your last ${rows[0].n} games with match detail, split by whether you passed each check. These are measured before the game is decided, unless marked “follows result”.`)} Win rate when you pass each check vs when you don’t, over your last ${rows[0].n} games.</p>`;
  }

  /* After a session: record, the habit row and the biggest swing, once. */
  function recapCard(c) {
    const st = c.state, E = c.E, S = c.settings;
    const H = st.helperLive ? st.helper : st.helper && Object.assign({}, st.helper, { playing: false });
    const s0 = E.lastSession(c.M.all, H, Date.now() / 1000, 18);
    if (!s0 || S.recapSeen === s0.end) return '';
    const g = s0.games, w = g.filter(m => m.won).length, pts = g.reduce((s, m) => s + (m.delta || 0), 0), ranked = g.some(m => m.delta != null);
    const f = st.focus.active, fp = f ? c.focusNow() : null;
    const marks = fp ? g.map(m => { const r = fp.results.find(x => x.m.id === m.id); return r ? (r.pass ? '✓' : '✗') : null; }).filter(Boolean) : [];
    let swing = null;
    for (const m of g) { const wv = c.matchWin(m.id); if (!wv) continue; for (const t of wv.turning) if (!swing || Math.abs(t.delta) > Math.abs(swing.t.delta)) swing = { m, t }; }
    const early = g.reduce((s, m) => { const D = st.details[m.id]; const me = D && D.players.find(p => p.items); return s + (me ? (me.deaths || []).filter(d => d[0] < 600).length : 0); }, 0);
    const mm = x => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
    return `<section class="card recap"><div class="wn-head"><div><div class="t-label">Last session · ${c.ago(s0.end)}</div>
      <h2>${w}–${g.length - w}${ranked ? ` · <span class="${pts > 0 ? 'pos' : pts < 0 ? 'neg' : ''}">${c.signed(pts)} rank pts</span>` : ''}</h2></div>
      <button type="button" class="btn ghost-btn" id="recap-ok">Got it</button></div>
      <ul class="recap-list">
        ${f && marks.length ? `<li><span class="muted">Your habit</span> <span class="dots">${marks.map(x => `<span class="dot ${x === '✓' ? 'y' : 'n'}">${x}</span>`).join('')}</span> <span class="muted small">${c.esc(E.habitById(f.habit).short)}</span></li>` : ''}
        <li><span class="muted">Deaths before 10:00</span> <b>${early}</b> <span class="muted small">across ${g.length} game${g.length > 1 ? 's' : ''}</span></li>
        ${swing ? `<li><span class="muted">Biggest swing</span> <a href="#/match/${swing.m.id}"><b class="${swing.t.delta >= 0 ? 'pos' : 'neg'}">${swing.t.delta > 0 ? '+' : '−'}${Math.abs(Math.round(swing.t.delta * 100))} pts</b> on ${c.esc(c.heroName(swing.m.hero))}, ${mm(swing.t.from)}–${mm(swing.t.to)}${swing.t.myDeaths.length ? `, you died ${swing.t.myDeaths.length === 1 ? 'at ' + mm(swing.t.myDeaths[0]) : swing.t.myDeaths.length + ' times'}` : ''} →</a></li>` : ''}
      </ul></section>`;
  }

  function roleBars(c, roles) {
    if (!roles.n) return '<p class="muted small">Roles appear once lobby data has loaded.</p>';
    const order = ['carried', 'key', 'solid', 'passenger', 'lonewolf', 'tough', 'dragged'];
    return `<div class="rolebar" role="img" aria-label="Game roles">${order.filter(k => roles.counts[k]).map(k =>
      `<span class="rb-seg r-${k}" style="flex:${roles.counts[k]}" title="${c.E.ROLE_LABEL[k]}: ${roles.counts[k]}"></span>`).join('')}</div>
      <ul class="role-legend">${order.map(k => `<li><span class="key r-${k}"></span><span>${c.E.ROLE_LABEL[k]}</span><b>${roles.counts[k]}</b></li>`).join('')}</ul>
      <p class="muted small">Impact is your share of your team’s souls, damage (or healing), kills + assists and objective damage, minus extra deaths. ${roles.n} of these games have lobby data.</p>`;
  }

  function signalLine(c, s) {
    const d = s.detail, M = c.M;
    const scoreTxt = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1);
    let text;
    if (s.text === 'rank') {
      const R = M.curRanked;
      text = M.allMode && !R.n ? `<b>No ranked games here</b>, so no rank points.`
        : d.net == null ? `${d.wins}–${d.losses}, no rank-point data`
        : s.dir === 1 ? `<b>Up ${c.fmtInt(d.net)} rank points</b>`
        : s.dir === -1 ? `<b>Down ${c.fmtInt(-d.net)} rank points</b>`
        : `<b>About even on rank</b> (${c.signed(d.net)})`;
    } else if (s.text === 'form') {
      if (s.dir == null) text = `<b>Form</b>: not enough scored games yet`;
      else if (d.tougher) text = `<b>Keeping pace</b> in lobbies ${Math.round(M.v.lobbyShift)} subranks tougher`;
      else text = (s.dir === 1 ? '<b>Playing better</b>' : s.dir === -1 ? '<b>Playing worse</b>' : '<b>Playing about the same</b>') + ` than ${d.hasRef ? c.esc(M.w.prevLabel) : 'your usual'} (${scoreTxt(d.score)} vs ${scoreTxt(d.ref)})`;
    } else {
      if (s.dir == null) text = d.of ? `<b>${d.rough} rough game${d.rough === 1 ? '' : 's'}</b> of ${d.of}` : '<b>Consistency</b>: not enough games yet';
      else text = (s.dir === 1 ? '<b>Fewer rough games</b>' : s.dir === -1 ? '<b>More rough games</b>' : '<b>Steady</b>') + `: ${c.pct(d.rate)} vs ${c.pct(d.ref)} before`;
    }
    const dir = s.dir == null ? 'na' : s.dir === 1 ? 'up' : s.dir === -1 ? 'down' : 'flat';
    const ic = { 1: '▲', 0: '■', '-1': '▼', null: '·' }[s.dir];
    return `<li class="sig ${dir}"><span class="sig-icon" aria-hidden="true">${ic}</span><span>${text}</span></li>`;
  }

  // ---------------------------------------------------------------- win chance (match page)
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

  function wpChart(c, w) {
    const W = 720, H = 220, m = { l: 64, r: 14, t: 14, b: 30 };   // wide left margin: phones enlarge the tick labels
    const tl = w.timeline, dur = tl[tl.length - 1].t || 1;
    const x = t => m.l + (W - m.l - m.r) * t / dur, y = p => m.t + (H - m.t - m.b) * (1 - p);
    const line = tl.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('');
    const pAt = t => { for (let i = 1; i < tl.length; i++) if (tl[i].t >= t) { const a = tl[i - 1], b = tl[i]; return a.p + (b.p - a.p) * (t - a.t) / Math.max(1, b.t - a.t); } return tl[tl.length - 1].p; };
    const ticks = [];
    for (let t = 0; t <= dur; t += 300) ticks.push(t);
    const swings = w.turning.map(s => `<rect class="swing" x="${x(s.from).toFixed(1)}" y="${m.t}" width="${(x(s.to) - x(s.from)).toFixed(1)}" height="${H - m.t - m.b}"/>`).join('');
    const deaths = w.deaths.map(d => `<circle class="wp-death" cx="${x(d.t).toFixed(1)}" cy="${y(pAt(d.t)).toFixed(1)}" r="4"><title>You died at ${mmss(d.t)}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your team's win chance over the match">
      ${[0, 0.25, 0.5, 0.75, 1].map(p => `<line class="${p === 0.5 ? 'axis' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${y(p)}" y2="${y(p)}"/><text class="tick" x="${m.l - 6}" y="${y(p) + 4}" text-anchor="end">${p * 100}%</text>`).join('')}
      ${ticks.map(t => `<text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t / 60}m</text>`).join('')}
      ${swings}<path class="line" d="${line}"/>${deaths}</svg>`;
  }

  function wpCard(c, m) {
    const W = window.WPMODEL;
    if (!W) return '';
    const w = c.matchWin(m.id);
    const q20 = W.quality && W.quality['1200'];
    const head = `<div class="card-head"><div><div class="t-label">Win chance ${src('model', `Climb’s win model, trained on ${c.fmtInt(W.matches)} Deadlock matches since the ${W.patch} patch (deadlock-api’s public data). It reads the gaps in souls, kills, objectives destroyed and mid-boss at each minute. Checked on matches it never saw: at 20:00 the team it favours wins ${q20 && q20.accuracy ? Math.round(q20.accuracy * 100) + '%' : '~75%'} of the time, and its percentages match real results to within ~1–2 points between 9 and 30 minutes. The Coach tab shows how it does on your own games.`)}</div><h2>How this game swung</h2></div></div>`;
    if (!w) return `<section class="card wp-card">${head}<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading the match timeline…</p></section>`;
    const pts = v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v * 100))}`;
    const hero = id => id != null ? c.esc(c.heroName(id)) : 'unknown';
    const q = W.quality && (W.quality['1200'] || Object.values(W.quality)[0]);
    const swingLine = s => {
      const bits = [];
      if (s.myDeaths.length) bits.push(`you died ${s.myDeaths.length === 1 ? 'at ' + mmss(s.myDeaths[0]) : s.myDeaths.length + ' times'}`);
      if (s.teamDeaths || s.enemyDeaths) bits.push(`deaths ${s.teamDeaths}–${s.enemyDeaths} (your team–theirs)`);
      if (s.objLost) bits.push(`lost ${s.objLost} objective${s.objLost > 1 ? 's' : ''}`);
      if (s.objTaken) bits.push(`took ${s.objTaken} objective${s.objTaken > 1 ? 's' : ''}`);
      if (s.midboss.length) bits.push(`mid-boss: ${s.midboss.join(', ')}`);
      bits.push(`souls gap ${s.soulsSwing >= 0 ? '+' : '−'}${c.fmtInt(Math.abs(s.soulsSwing))}`);
      return `<li><span class="wp-when">${mmss(s.from)}–${mmss(s.to)}</span>
        <b class="${s.delta >= 0 ? 'pos' : 'neg'}">${Math.round(s.p0 * 100)}% → ${Math.round(s.p1 * 100)}% (${pts(s.delta)})</b>
        <span class="muted small">${bits.join(' · ')}</span></li>`;
    };
    const total = w.deaths.reduce((s, d) => s + d.total, 0);
    return `<section class="card wp-card">${head}
      <div class="chart wp-chart">${wpChart(c, w)}</div>
      <p class="muted small"><span class="key wp-key-swing"></span> biggest swings · <span class="key wp-key-death"></span> your deaths</p>
      <div class="grid-2 wp-cols">
        <div><div class="t-label">Turning points</div><ul class="wp-list">${w.turning.map(swingLine).join('')}</ul></div>
        <div><div class="t-label">Your deaths${w.deaths.length ? ` · about ${Math.round(total * 100)} pts in total` : ''} ${src('model', 'What a death like this USUALLY costs: the median souls swing for the dead player’s team, measured around deaths where nobody else in the lobby died, by game minute and by how rich the victim was. That swing is then turned into win chance with the model. It isn’t a measurement of that exact death: snapshots are 3–5 minutes apart, so most deaths (teamfights) can’t be isolated.')}</div>
          ${w.deaths.length ? `<ul class="wp-list">${w.deaths.map(d => `<li><span class="wp-when">${mmss(d.t)}</span>
            <span>Died to <b>${hero(d.killerHero)}</b>${d.ttk > 0 && d.ttk <= c.E.FAST_DEATH_S ? ' <span class="tag warn">caught out</span>' : ''}</span>
            <span class="muted small">${Math.round(d.total * 100) >= 1 ? `about <b class="neg">${pts(-d.total)} pts</b> win chance` : `under 1 pt of win chance${d.p < 0.05 || d.p > 0.95 ? ' (the game was already decided)' : ''}`} · a death like this usually swings ~${c.fmtInt(d.souls)} souls${d.share >= 1.2 ? ' (you were rich, so it cost more)' : ''}${d.objPts >= 0.005 ? ` · +${Math.round(d.objLift * 100)}% chance your team loses an objective in the next 90s` : ''}</span></li>`).join('')}</ul>`
            : '<p class="muted small">No deaths this game.</p>'}</div>
      </div>
      <p class="muted small">Model trained ${c.esc(W.trained_at.slice(0, 10))} on ${c.fmtInt(W.matches)} matches since the ${c.esc(W.patch)} patch${q && q.accuracy ? `. At 20:00 the team it favours goes on to win ${Math.round(q.accuracy * 100)}% of the time` : ''}. Death costs are what a death like that usually costs at that minute, measured around deaths where nobody else died, not a measurement of that exact death.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- missing games (data freshness)
  /* Why games are missing and the ways to get them to deadlock-api faster, safest first. Only
     options that never give anything your Steam login or touch the game's memory are offered as
     steps; the rest are mentioned with what they do. Checked against deadlock-api-ingest's README
     on 2026-10-25. */
  function missingGuide(c) {
    return `<ol class="fix-steps">
      <li><b>Upload your Steam cache now</b> (one time, nothing to install). Open <a class="more" href="https://deadlock-api.com/ingest-cache" target="_blank" rel="noopener">deadlock-api.com/ingest-cache</a> and drop in this folder:
        <code class="path">C:\\Program Files (x86)\\Steam\\appcache\\httpcache</code>
        <span class="muted small">It reads the match links Steam saved when you looked at the post-game screen, so it catches games you checked the scoreboard for.</span></li>
      <li><b>Let it happen automatically while you play</b> with deadlock-api’s open-source <a class="more" href="https://github.com/deadlock-api/deadlock-api-ingest" target="_blank" rel="noopener">ingest tool</a>, run from Deadlock’s launch options so it only runs while the game is open:
        <span class="muted small">Download it to <code>%LOCALAPPDATA%\\deadlock-api-ingest\\</code>, then in Steam: Deadlock → Properties → General → Launch Options:</span>
        <code class="path">"C:\\Users\\YOUR_USER\\AppData\\Local\\deadlock-api-ingest\\deadlock-api-ingest.exe" --no-memory -- %command%</code>
        <span class="muted small">Started this way it never uses your Steam login, and <code>--no-memory</code> stops it reading the game’s memory, so it only watches Steam’s cache folder. Keep any launch options you already have after <code>%command%</code>. Avoid the default installer if you don’t want that: it also logs in with your saved Steam session to fetch your friends’ matches.</span></li>
      <li><b>Already use Deadlock Mod Manager?</b> Its match-sync setting does the same job. Note it works by using your saved Steam login.</li>
      <li><b>Or support deadlock-api</b> ($1.50/month on their Patreon), which gives your account prioritized fetching.</li>
    </ol>`;
  }

  function freshLine(c) {
    const f = c.freshnessNow();
    if (!f.newestEnd) return '';
    const behind = f.unseenS >= 20 * 60;
    return `<div class="fresh small${behind ? ' behind' : ''}">Newest match on deadlock-api: ${c.ago(f.newestEnd)}${behind ? ` · <a href="#/about">you’ve played since, why is it missing?</a>` : ''}</div>`;
  }

  function missingCard(c) {
    const f = c.freshnessNow(), S = c.settings, P = c.P;
    if (!f.newestId || f.unseenS < 20 * 60 || S.missingSeen === f.newestId) return '';
    return `<section class="card missing"><div class="wn-head"><div><div class="t-label">Missing games? ${src('yours', 'The Climb helper on your PC logged Deadlock being open after your newest match on deadlock-api ended. Games from that time aren’t on deadlock-api yet, so Climb can’t show them. Climb itself refreshes every few minutes; the delay is deadlock-api collecting the match from Valve.')}</div>
      <h2>You’ve played about ${P.dur(f.unseenS)} since your newest match on deadlock-api</h2></div>
      <button type="button" class="btn ghost-btn" id="missing-ok">Got it</button></div>
      <p class="muted">deadlock-api only has a game once someone sends it the game’s key from Valve, which can take hours for accounts it doesn’t watch. Any of these gets your games there within minutes:</p>
      ${missingGuide(c)}</section>`;
  }

  // ---------------------------------------------------------------- focus loop
  const pc0 = v => v == null ? '—' : Math.round(v * 100) + '%';
  const dots = recent => `<span class="dots" aria-label="${recent.filter(Boolean).length} of last ${recent.length} passed">${recent.map(x => `<span class="dot ${x ? 'y' : 'n'}">${x ? '✓' : '✗'}</span>`).join('')}${'<span class="dot e"></span>'.repeat(Math.max(0, 10 - recent.length))}</span>`;

  function verdictLine(c, p) {
    const E = c.E;
    if (p.graduated) return `<span class="pos"><b>Mastered.</b> ${p.recent.filter(Boolean).length} of your last 10 passed. Time for the next habit.</span>`;
    if (p.verdict === 'early') return `<span class="muted">${p.n ? `${p.passes} of ${p.n} so far. ` : 'No games since you started. '}Climb can call it after ${E.FOCUS_MIN_GAMES} games (${p.needed} to go).</span>`;
    const from = `${pc0(p.baseline)} → ${pc0(p.rate)} over ${p.n} games`;
    return p.verdict === 'improved' ? `<span class="pos"><b>It’s working:</b> ${from}.</span>`
      : p.verdict === 'worse' ? `<span class="neg"><b>Slipping:</b> ${from}.</span>`
      : `<span><b>No real change yet:</b> ${from}. Keep at it, or try a different habit.</span>`;
  }

  /* full = the Coach tab version (why/how, games since start, controls); otherwise the Overview card. */
  function focusCard(c, full) {
    const E = c.E, st = c.state, f = st.focus.active;
    if (!f) {
      if (!full) return `<section class="card focus-card empty"><div><div class="t-label">Your focus</div><b>No habit picked yet.</b>
        <span class="muted small">One habit at a time, checked every game.</span></div><a class="btn" href="#/coach">Pick a habit</a></section>`;
      return '';
    }
    const h = E.habitById(f.habit), p = c.focusNow();
    if (!h || !p) return '';
    const head = `<div class="fc-head"><div><div class="t-label">Your focus${f.by === 'coach' ? ' · picked by the coach' : f.by === 'climb' ? ' · Climb’s pick' : ''}</div>
      <div class="fc-habit">${c.esc(h.label)}</div></div>${dots(p.recent)}</div>
      <p class="fc-line">${verdictLine(c, p)}</p>
      <p class="muted small">Before you started: you passed it in ${pc0(f.baseline.rate)} of your last ${f.baseline.n} games, and won ${pc0(f.baseline.wrPass)} of those vs ${pc0(f.baseline.wrFail)} of the rest.</p>`;
    if (!full) return `<section class="card focus-card${p.graduated ? ' done' : ''}">${head}<a class="more" href="#/coach">Details →</a></section>`;
    const res = p.results.slice().reverse().slice(0, 15);
    return `<section class="card focus-card${p.graduated ? ' done' : ''}">${head}
      ${f.why ? `<p class="fc-why">${c.esc(f.why)}</p>` : ''}
      ${f.how && f.how.length ? `<div class="t-label">How to pass it</div><ul class="fc-how">${f.how.map(x => `<li>${c.esc(x)}</li>`).join('')}</ul>` : ''}
      ${res.length ? `<div class="t-label">Games since you started</div><ul class="fc-games">${res.map(r => `<li><a href="#/match/${r.m.id}">
        <span class="dot ${r.pass ? 'y' : 'n'}">${r.pass ? '✓' : '✗'}</span>${icon(c, r.m.hero, 22)}<span>${c.esc(c.heroName(r.m.hero))}</span>
        <span class="${r.m.won ? 'win' : 'loss'}">${r.m.won ? 'W' : 'L'}</span><span class="muted small">${c.ago(r.m.t)}</span></a></li>`).join('')}</ul>` : ''}
      <div class="fc-actions">
        ${p.graduated ? '<button type="button" class="btn" data-focus="graduate">Mark mastered, pick the next</button>' : ''}
        <button type="button" class="btn ghost-btn" data-focus="drop">Drop this habit</button>
      </div></section>`;
  }

  /* The Coach tab's habit picker: every habit with your pass rate and win-rate split. */
  function habitPicker(c) {
    const E = c.E, st = c.state;
    const cat = c.focusCatalog();
    const rows = cat.filter(x => x.n);
    const busy = st.analyzing;
    const hasKey = !!st.coach.key;
    return `<section class="card">
      <div class="card-head"><div><div class="t-label">Focus loop</div><h2>Pick one habit to work on</h2>
        <p class="muted small">Every game gets a ✓ or ✗. After ${E.FOCUS_MIN_GAMES} games Climb says whether your pass rate really moved, and a habit is mastered at ${E.FOCUS_GRAD[0]} of your last ${E.FOCUS_GRAD[1]}. Only habits that split <i>your</i> wins from your losses can be picked.</p></div>
        <button type="button" class="btn" data-focus="coach"${busy ? ' disabled' : ''}>${hasKey ? 'Let the coach pick' : 'Pick for me'}</button></div>
      ${busy ? `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(busy)}</p>` : ''}
      ${st.focusError ? `<p class="neg small">${c.esc(st.focusError)}</p>` : ''}
      <div class="table-wrap"><table class="tbl habits"><thead><tr><th>Habit</th><th class="n">You pass it</th><th class="n">Win rate passed</th><th class="n">Not passed</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.eligible ? '' : 'dim'}"><td>${c.esc(x.label)}${x.outcome ? ' <span class="tag" title="Partly follows the result: losing games also causes this">follows result</span>' : ''}</td>
        <td class="n">${pc0(x.passRate)}</td><td class="n pos">${pc0(x.wrPass)}</td><td class="n neg">${pc0(x.wrFail)}</td>
        <td class="n">${x.eligible ? `<button type="button" class="btn ghost-btn sm" data-pick="${x.id}">Pick</button>` : `<span class="muted small" title="Passing it made no clear difference to your win rate">no difference</span>`}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">From your last ${rows.length ? rows[0].n : 0} games with match detail.</p>
    </section>`;
  }

  function focusHistory(c) {
    const E = c.E, H = c.state.focus.history;
    if (!H.length) return '';
    const OUT = { graduated: 'Mastered', dropped: 'Dropped', switched: 'Switched' };
    return `<section class="card"><h2>Past habits</h2><ul class="fc-hist">${H.map(x => `<li>
      <span>${c.esc((E.habitById(x.habit) || { label: x.habit }).label)}</span>
      <span class="muted small">${pc0(x.baseline)} → ${pc0(x.rate)} over ${x.n} games</span>
      <span class="role ${x.outcome === 'graduated' ? 'good' : ''}">${OUT[x.outcome] || x.outcome}</span></li>`).join('')}</ul></section>`;
  }

  function bindFocus(host, c) {
    host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => c.startFocus(b.dataset.pick, null, null, 'you')));
    host.querySelectorAll('[data-focus]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.focus;
      if (a === 'coach') c.coachPickHabit();
      else if (a === 'drop') c.endFocus('dropped');
      else if (a === 'graduate') { c.endFocus('graduated'); }
    }));
  }

  // ---------------------------------------------------------------- coach (last 30 games)
  function coach(host, c) {
    const E = c.E, st = c.state, N = c.ANALYSIS_N;
    const games = c.M.all.slice(-N);
    const have = games.filter(m => st.details[m.id]).length;
    if (have < games.length && !st.detailsBusy) c.ensureDetails();
    const A = E.aggregateGames(c.analysisEntries(), st.items && st.items.map, c.heroName);
    const mmss = s => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const one = v => v == null ? '—' : v.toFixed(1);
    const sgn = v => v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + c.fmtInt(Math.abs(v));
    // A wins-vs-losses tile. better: 'lower' | 'higher' decides which side is coloured good.
    const wl = (label, x, fmt, better, sub) => {
      const gap = x.win != null && x.loss != null ? x.win - x.loss : null;
      const cls = side => gap == null || gap === 0 ? '' : ((side === 'win') === ((better === 'lower') === (gap < 0))) ? 'pos' : 'neg';
      return `<div class="tile wl"><div class="t-label">${label}</div>
        <div class="wl-row"><span class="wl-k">Wins</span><b class="${cls('win')}">${fmt(x.win)}</b></div>
        <div class="wl-row"><span class="wl-k">Losses</span><b class="${cls('loss')}">${fmt(x.loss)}</b></div>
        <div class="t-sub">${sub || ''}</div></div>`;
    };
    const head = `<div class="page-head"><div><h1 class="page-title">Coach</h1>
      <p class="muted small">Your last ${games.length} games read together: ${A.n ? `${A.wins} wins, ${A.losses} losses` : 'loading'}. The numbers are counted exactly from your match data; the analysis below them is Gemini’s read of those numbers.</p></div></div>`;
    if (!A.n) {
      host.innerHTML = head + `<section class="card"><p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading match details for your last ${games.length} games… ${have}/${games.length}</p></section>`;
      return;
    }
    const econ12 = A.economy.find(e => e.t === 720), econ20 = A.economy.find(e => e.t === 1200);
    const maxPhase = Math.max(0.1, ...A.deaths.byPhase.flatMap(p => [p.win || 0, p.loss || 0]));
    const bar = (v, cls) => `<span class="pbar"><span class="${cls}" style="width:${v == null ? 0 : Math.round(100 * v / maxPhase)}%"></span></span>`;

    host.innerHTML = head + `
      ${c.state.focus.active ? focusCard(c, true) : habitPicker(c)}
      ${calibrationCard(c)}
      ${aiCard(c, A)}
      <div class="t-label sec">The numbers · wins vs losses</div>
      <div class="tiles tiles-6">
        ${wl('Deaths per game', A.deaths.perGame, one, 'lower')}
        ${wl('Deaths before 10:00', A.deaths.before10, one, 'lower')}
        ${wl('Souls vs lane opp. at 12:00', econ12 ? econ12.diff : {}, sgn, 'higher', econ12 && econ12.aheadRate.all != null ? `ahead in ${Math.round(econ12.aheadRate.all * 100)}% of games` : '')}
        ${wl('Souls vs lane opp. at 20:00', econ20 ? econ20.diff : {}, sgn, 'higher', econ20 && econ20.aheadRate.all != null ? `ahead in ${Math.round(econ20.aheadRate.all * 100)}% of games` : '')}
        ${wl('Souls gained 20–30 min vs lane opp.', A.lateSwing, sgn, 'higher', A.lateSwing.n ? `${A.lateSwing.n} games reached 30:00` : '')}
        ${wl('First tier-4 item', A.items.tier4, mmss, 'lower', `first tier-3: ${mmss(A.items.tier3.all)}`)}
      </div>
      <div class="grid-2">
        <section class="card"><h2>When you die</h2><p class="muted small">Deaths per game in each phase. ${A.deaths.fastShare != null ? `${Math.round(A.deaths.fastShare * 100)}% of all deaths came within ${E.FAST_DEATH_S}s of taking damage (caught out).` : ''}</p>
          <div class="phases">${A.deaths.byPhase.map(p => `<div class="ph"><span class="ph-l">${p.label}</span>
            <span class="ph-bars">${bar(p.win, 'w')}${bar(p.loss, 'l')}</span><span class="ph-v"><span class="pos">${one(p.win)}</span> / <span class="neg">${one(p.loss)}</span></span></div>`).join('')}</div>
          <p class="muted small"><span class="key r-carried"></span> wins <span class="key r-dragged"></span> losses</p></section>
        <section class="card"><h2>Where and to whom</h2>
          <div class="two-lists"><div><div class="t-label">Zones</div><ol class="plain">${A.deaths.zones.map(z => `<li><span>${c.esc(z.zone)}</span><b>${Math.round(z.share * 100)}%</b></li>`).join('')}</ol></div>
          <div><div class="t-label">Killed most by</div><ol class="plain">${A.deaths.killers.map(k => `<li><span>${icon(c, k.hero, 20)}${c.esc(k.name)}</span><b>${k.n}</b></li>`).join('')}</ol></div></div>
          <p class="muted small">Zones are coarse and from your side of the map. ${A.deaths.total} deaths in ${A.n} games.</p></section>
      </div>
      <section class="card flush"><div class="pad"><h2>Heroes in these games</h2></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Hero</th><th class="n">Games</th><th class="n">Win rate</th><th class="n">Deaths / game</th><th class="n">Before 10:00</th></tr></thead>
        <tbody>${A.heroes.map(h => `<tr><td><a class="mh" href="#/heroes/${h.hero}">${icon(c, h.hero, 24)}<span>${c.esc(h.name)}</span></a></td><td class="n">${h.n}</td><td class="n">${Math.round(h.winRate * 100)}%</td><td class="n">${one(h.deathsPerGame)}</td><td class="n">${one(h.before10PerGame)}</td></tr>`).join('')}</tbody></table></div></section>
      ${c.state.focus.active ? habitPicker(c).replace('Pick one habit to work on', 'Switch habit') : ''}
      ${focusHistory(c)}`;
    bindFocus(host, c);
    const go = host.querySelector('[data-analyze]');
    if (go) go.addEventListener('click', () => c.runAnalysis(go.dataset.analyze === 'again'));
  }

  /* Does the win model hold up on YOUR games? The one check a skeptic can verify themselves. */
  function calibrationCard(c) {
    const W = window.WPMODEL;
    if (!W) return '';
    const cal = c.E.calibration(c.analysisEntries(), W, 1200);
    if (cal.n < 5) return '';
    const b = cal.bins;
    const row = (x, label) => x.n ? `<li><span>${label}</span><b>${x.wins} of ${x.n}</b><span class="muted small">won (${Math.round(100 * x.wins / x.n)}%)</span></li>` : '';
    return `<section class="card"><div class="card-head"><div><div class="t-label">Can you trust the win chance? ${src('yours', 'For each of your last games that reached 20:00, Climb’s model gave your team a win chance at 20:00. This compares that with what actually happened. A well-behaved model should be right about 3 games in 4 at 20:00, and its high-chance games should mostly be wins.')}</div>
      <h2>On your own games, the side it favoured at 20:00 won ${cal.right} of ${cal.n}</h2></div></div>
      <ul class="cal">${row(b[2], 'When it gave you 65%+')}${row(b[1], 'When it was close (35–65%)')}${row(b[0], 'When it gave you under 35%')}</ul>
      <p class="muted small">Your last ${cal.n} games that reached 20:00, with match detail. Small samples swing. On the held-out fifth of the ${c.fmtInt(W.matches)} training matches, the favourite at 20:00 won ${W.quality && W.quality['1200'] && W.quality['1200'].accuracy ? Math.round(W.quality['1200'].accuracy * 100) : 75}%.</p></section>`;
  }

  // ---------------------------------------------------------------- friends
  function friends(host, c) {
    const E = c.E, st = c.state;
    c.ensureFriends();
    const list = c.friendList();
    const head = `<div class="page-head"><div><h1 class="page-title">Friends</h1><p class="muted small">People you’ve played ${E.FRIEND_MIN}+ games with, found from your match history. ${src('yours', 'Steam’s own friends list isn’t reachable from a website (Steam’s API refuses browser requests, and deadlock-api doesn’t store it), so Climb finds friends from deadlock-api’s teammate history instead: anyone you’ve been on a team with 10+ times. Random teammates almost never repeat that often.')}</p></div></div>`;
    if (!st.friends) { host.innerHTML = head + '<section class="card"><p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Finding the people you queue with…</p></section>'; return; }
    if (!list.length) { host.innerHTML = head + `<section class="card"><p class="muted">No one with ${E.FRIEND_MIN}+ games together yet.</p></section>`; return; }
    host.innerHTML = head + `<section class="card flush"><ul class="friends">${list.map(f => `<li><a href="#/friend/${f.acct}">
      ${f.avatar ? `<img src="${c.esc(f.avatar)}" alt="" width="36" height="36">` : '<span class="av-ph"></span>'}
      <span class="fr-main"><b>${c.esc(f.name || 'Player ' + f.acct)}</b><span class="muted small">${f.badge ? c.esc(E.badgeName(f.badge, c.tiers())) : 'Unranked'} · ${c.fmtInt(f.games)} games together${f.last ? ' · last ' + c.ago(f.last) : ''}</span></span>
      <span class="fr-wr"><b class="${f.wrTogether != null && f.wrApart != null ? (f.wrTogether - f.wrApart >= 0.03 ? 'pos' : f.wrTogether - f.wrApart <= -0.03 ? 'neg' : '') : ''}">${c.pct(f.wrTogether)}</b><span class="muted small">together</span></span>
      <span class="fr-wr hide-s"><b>${c.pct(f.wrApart)}</b><span class="muted small">without</span></span></a></li>`).join('')}</ul></section>`;
  }

  function friend(host, c) {
    const E = c.E, st = c.state, acct = st.route.id;
    c.ensureFriends();
    const f = c.friendList().find(x => x.acct === acct);
    if (!f) { host.innerHTML = '<div class="empty-state">' + (st.friends ? 'Not one of your friends here. <a href="#/friends">Back to friends</a>' : 'Loading…') + '</div>'; return; }
    const shared = c.M.all.filter(m => f.ids.includes(m.id)).slice(-10);
    c.ensureDetailsFor(shared.map(m => m.id));
    const entries = shared.map(c.entryOf);
    const focus = st.focus.active && st.focus.active.habit;
    const habitId = focus && !['tier3', 'tier4', 'rate', 'late2'].includes(focus) ? focus : 'early0';
    const du = E.duo(entries, st.settings.account, acct, habitId, st.items && st.items.map);
    const name = c.esc(f.name || 'Player ' + acct), me = c.esc((st.profile && st.profile.name) || 'You');
    host.innerHTML = `<a href="#/friends" class="back">← Friends</a>
      <div class="page-head"><div class="ident">${f.avatar ? `<img class="fr-av" src="${c.esc(f.avatar)}" alt="" width="56" height="56">` : ''}
        <div><div class="rank-name">${name}</div><div class="muted">${f.badge ? c.esc(E.badgeName(f.badge, c.tiers())) : 'Unranked'} · ${c.fmtInt(f.games)} games together</div></div></div></div>
      <div class="tiles">
        <div class="tile"><div class="t-label">Win rate together</div><div class="t-val">${c.pct(f.wrTogether)}</div><div class="t-sub">${f.seen} of your games</div></div>
        <div class="tile"><div class="t-label">You without ${name}</div><div class="t-val">${c.pct(f.wrApart)}</div><div class="t-sub">your other games</div></div>
        <div class="tile"><div class="t-label">Last played together</div><div class="t-val">${f.last ? c.ago(f.last) : '—'}</div><div class="t-sub">&nbsp;</div></div>
      </div>
      <section class="card"><div class="card-head"><div><div class="t-label">Head to head ${src('yours', 'From the match details of your last shared games: both of you are in the same match data, so the same check is run for each seat.')}</div>
        <h2>${c.esc(E.habitById(du.habit).label)}</h2>
        <p class="muted small">${du.n ? `Your last ${du.n} shared games with match detail.` : 'Reading your shared games…'}${focus && habitId !== focus ? ' (Your focus habit can’t be checked for a friend, so this uses early deaths.)' : ''}</p></div></div>
        ${du.n ? `<div class="h2h">
          <div><span class="muted small">${me}</span><b>${du.mePass} of ${du.meN}</b><span class="muted small">${du.meEarly != null ? du.meEarly.toFixed(1) + ' deaths before 10:00 a game' : ''}</span></div>
          <div><span class="muted small">${name}</span><b>${du.themPass} of ${du.themN}</b><span class="muted small">${du.themEarly != null ? du.themEarly.toFixed(1) + ' deaths before 10:00 a game' : ''}</span></div>
        </div>
        ${du.firstMe + du.firstThem ? `<p>In the losses, the first of you two to die was <b>${du.firstMe > du.firstThem ? 'you' : du.firstMe < du.firstThem ? name : 'split evenly'}</b> (${me} ${du.firstMe}, ${name} ${du.firstThem}).</p>` : ''}` : ''}
      </section>
      <section class="card flush"><div class="pad"><h2>Recent games together</h2></div>
        ${shared.length ? shared.slice().reverse().map(m => `<a class="mrow ${m.won ? 'w' : 'l'}" href="#/match/${m.id}">
          <span class="mh">${icon(c, m.hero, 28)}<span><b>${c.esc(c.heroName(m.hero))}</b><span class="muted small">${mins(m.dur)}</span></span></span>
          <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span><span></span><span class="n">${kda(m)}</span><span class="hide-s"></span><span class="hide-s"></span><span class="hide-s"></span>
          <span class="n">${deltaHtml(c, m)}</span><span class="n muted small">${c.ago(m.t)}</span></a>`).join('') : '<p class="muted pad">No shared games in your loaded history.</p>'}
      </section>`;
  }

  function aiCard(c, A) {
    const st = c.state, a = st.analysis;
    const head = `<div class="card-head"><div><div class="t-label">AI coach ${src('ai', 'Gemini reads only the counted numbers shown on this tab (your last 30 games, wins vs losses) plus your gaps vs the next rank, and writes the patterns and plan. The numbers are Climb’s; the wording and advice are Gemini’s.')}</div><h2>State of your game</h2></div>`;
    if (!st.coach.key) return `<section class="card coach">${head}</div><p class="muted">Add your Gemini key in <a class="more" href="#/about">Account & about</a> to get the three patterns costing you the most games, and a plan for your next sessions.</p></section>`;
    if (st.analyzing) return `<section class="card coach">${head}</div><p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(st.analyzing)}</p></section>`;
    const lastId = c.M.all.length ? c.M.all[c.M.all.length - 1].id : null;
    const stale = a && a.data && a.lastId !== lastId;
    if (!a || !a.data) {
      return `<section class="card coach">${head}<button type="button" class="btn" data-analyze="go">Analyze my last ${A.n} games</button></div>
        <p class="muted small">One Gemini call (${c.esc(st.coach.model)}) with the numbers below: about 3 KB, nothing else.</p>
        ${a && a.error ? `<p class="neg">${c.esc(a.error)}</p>` : ''}</section>`;
    }
    const x = a.data;
    return `<section class="card coach">${head}<button type="button" class="btn ${stale ? '' : 'ghost-btn'}" data-analyze="again">${stale ? 'Update with new games' : '↻ Redo'}</button></div>
      <p class="coach-sum">${c.esc(x.headline)}</p>
      <ol class="coach-pts">${(x.patterns || []).map((p, i) => `<li class="bad">
        <div class="cp-title">${i + 1}. ${c.esc(p.title)}</div>
        <div class="cp-ev muted">${c.esc(p.evidence)}</div>
        <div class="cp-fix muted">${c.esc(p.why_it_costs_games)}</div>
        <div class="cp-fix"><b>Practice:</b> ${c.esc(p.practice)}</div></li>`).join('')}</ol>
      <div class="grid-2 coach-foot">
        <div class="focus good"><div class="t-label">Keep doing</div><ul class="plain-ul">${(x.strengths || []).map(s => `<li><b>${c.esc(s.title)}</b> <span class="muted small">${c.esc(s.evidence)}</span></li>`).join('')}</ul></div>
        <div class="coach-focus"><span class="t-label">Next few sessions</span><ol class="plan">${(x.next_sessions_plan || []).map(s => `<li>${c.esc(s)}</li>`).join('')}</ol></div>
      </div>
      ${a.error ? `<p class="neg small">Last update failed: ${c.esc(a.error)}</p>` : ''}
      <p class="muted small">Gemini ${c.esc(a.model)} · ${a.n} games · ${c.ago(a.at / 1000)}${a.tokens ? ' · ' + c.fmtInt(a.tokens) + ' tokens' : ''}${stale ? ' · you’ve played since, so this is out of date' : ''}.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- matches list
  const matchFilter = { hero: 'all', result: 'all', role: 'all', mode: 'all' };
  function matches(host, c) {
    const M = c.M, E = c.E;
    const heroes = [...new Set(M.all.map(m => m.hero))].sort((a, b) => c.heroName(a).localeCompare(c.heroName(b)));
    const rows = M.all.slice().reverse().map(m => ({ m, g: E.gameRole(c.state.lobbies[m.id], m.won), L: c.state.lobbies[m.id] }))
      .filter(({ m, g }) => (matchFilter.hero === 'all' || m.hero === Number(matchFilter.hero))
        && (matchFilter.result === 'all' || (matchFilter.result === 'win') === m.won)
        && (matchFilter.mode === 'all' || m.mode === matchFilter.mode)
        && (matchFilter.role === 'all' || (g && (matchFilter.role === 'first' ? g.lobbyFirst
          : matchFilter.role === (g.teamRank <= 2 ? 'top' : g.teamRank >= g.teamSize - 1 ? 'low' : 'mid')))));
    const shown = rows.slice(0, 150);
    const fp = c.state.focus.active ? c.focusNow() : null;
    const fpass = new Map(fp ? fp.results.map(r => [r.m.id, r.pass]) : []);
    const fh = fp ? c.E.habitById(c.state.focus.active.habit) : null;
    const fmark = id => fpass.has(id) ? `<span class="dot ${fpass.get(id) ? 'y' : 'n'}" title="${c.esc(fh.label)}: ${fpass.get(id) ? 'passed' : 'missed'}">${fpass.get(id) ? '✓' : '✗'}</span>` : '';
    const opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${c.esc(l)}</option>`;
    host.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Matches</h1><p class="muted small">${rows.length} of ${M.all.length} matches. Click one for the full lobby.</p></div>
        <div class="filters">
          <select id="f-hero" aria-label="Hero">${opt('all', 'All heroes', matchFilter.hero)}${heroes.map(h => opt(h, c.heroName(h), matchFilter.hero)).join('')}</select>
          <select id="f-result" aria-label="Result">${opt('all', 'Wins and losses', matchFilter.result)}${opt('win', 'Wins', matchFilter.result)}${opt('loss', 'Losses', matchFilter.result)}</select>
          <select id="f-role" aria-label="Team share">${opt('all', 'Any team share', matchFilter.role)}${opt('first', '★ 1st in the lobby', matchFilter.role)}${opt('top', 'Top share', matchFilter.role)}${opt('mid', 'Mid share', matchFilter.role)}${opt('low', 'Low share', matchFilter.role)}</select>
          <select id="f-mode" aria-label="Mode">${opt('all', 'Ranked + unranked', matchFilter.mode)}${opt('ranked', 'Ranked', matchFilter.mode)}${opt('unranked', 'Unranked', matchFilter.mode)}</select>
        </div></div>
      <section class="card flush">
        <div class="mrow mhead"><span>Hero</span><span>Result</span><span>Team share</span><span class="n">K / D / A</span><span class="n hide-s">Souls</span><span class="n hide-s">Damage</span><span class="hide-s">Impact</span><span class="n">Rank</span><span class="n">When</span></div>
        ${shown.length ? shown.map(({ m, g, L }) => {
          const me = L && L.p[L.me];
          return `<a class="mrow ${m.won ? 'w' : 'l'}${g && g.lobbyFirst ? ' gold' : ''}" href="#/match/${m.id}">
            <span class="mh">${icon(c, m.hero, 32)}<span><b>${c.esc(c.heroName(m.hero))}</b><span class="muted small">${m.mode === 'ranked' ? 'Ranked' : 'Unranked'} · ${mins(m.dur)}</span></span></span>
            <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span>
            <span class="mrole">${fmark(m.id)}${roleChip(c, g, m.id)}<span class="tags">${tagChips(c, g, 2)}</span></span>
            <span class="n">${kda(m)}</span>
            <span class="n hide-s">${c.kfmt(m.souls)}</span>
            <span class="n hide-s">${me ? c.kfmt(me[5]) : '—'}</span>
            <span class="hide-s">${g ? impactBar(g.impact) : ''}</span>
            <span class="n">${deltaHtml(c, m)}</span>
            <span class="n muted small">${c.ago(m.t)}</span></a>`;
        }).join('') : '<p class="empty-state">No matches with these filters.</p>'}
        ${rows.length > shown.length ? `<p class="muted small pad">Showing the latest ${shown.length}. Narrow the filters to see older ones.</p>` : ''}
      </section>`;
    ['hero', 'result', 'role', 'mode'].forEach(k => host.querySelector('#f-' + k).addEventListener('change', e => { matchFilter[k] = e.target.value; matches(host, c); }));
  }

  // ---------------------------------------------------------------- match detail
  function match(host, c) {
    const M = c.M, E = c.E, id = c.state.route.id;
    const m = M.all.find(x => x.id === id);
    if (!m) { host.innerHTML = '<div class="empty-state">That match isn’t in your history. <a href="#/matches">Back to matches</a></div>'; return; }
    const L = c.state.lobbies[m.id];
    const g = E.gameRole(L, m.won);
    const p = M.perf.get(m.id);
    const head = `
      <a href="#/matches" class="back">← Matches</a>
      <div class="page-head match-head">
        <div class="ident">${icon(c, m.hero, 56)}
          <div><div class="rank-name">${c.esc(c.heroName(m.hero))} <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span></div>
          <div class="muted">${new Date(m.t * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${mins(m.dur)} · ${m.mode === 'ranked' ? 'Ranked' : 'Unranked'}${L && L.avgBadge ? ' · lobby ' + c.esc(E.badgeName(L.avgBadge, c.tiers())) : ''} · #${m.id}</div></div>
        </div>
        <div class="big-delta">${m.delta == null ? '' : `${deltaHtml(c, m)}<span class="muted small">rank pts</span>`}</div>
      </div>`;
    if (!L || L.v !== E.LOBBY_V) {
      host.innerHTML = head + `<section class="card"><p class="muted">${L === null ? 'deadlock-api has no lobby data for this match.' : 'Lobby data is still loading…'}</p></section>`;
      return;
    }
    const imp = E.lobbyImpact(L);
    const zs = p ? ['souls', 'dmg', 'ka', 'deaths'].filter(k => p.z[k] != null).map(k => {
      const lab = { souls: 'Souls', dmg: 'Damage', ka: 'Kills + assists', deaths: 'Staying alive' }[k];
      return `<li><span>${lab}</span><span class="${p.z[k] >= 0.2 ? 'pos' : p.z[k] <= -0.2 ? 'neg' : 'muted'}">${(p.z[k] >= 0 ? '+' : '−') + Math.abs(p.z[k]).toFixed(1)}</span></li>`;
    }).join('') : '';
    const share = (k, lab, inv) => {
      const v = g.r[k], good = inv ? v <= 1 : v >= 1;
      return `<div class="share"><span class="muted small">${lab}</span><b class="${Math.abs(v - 1) < 0.1 ? '' : good ? 'pos' : 'neg'}">${Math.round(v * 100)}%</b></div>`;
    };
    const team = t => {
      const idx = L.p.map((x, i) => i).filter(i => L.p[i][0] === t).sort((a, b) => L.p[b][1] - L.p[a][1]);
      const won = L.win == null ? null : L.win === t;
      return `<div class="team"><div class="team-h"><b>${t === L.p[L.me][0] ? 'Your team' : 'Enemy team'}</b>${won == null ? '' : `<span class="${won ? 'win' : 'loss'}">${won ? 'Won' : 'Lost'}</span>`}</div>
        <div class="sb sb-h"><span>Hero</span><span class="n">K/D/A</span><span class="n">Souls</span><span class="n">Damage</span><span class="n hide-s">Heal</span><span class="n hide-s">Obj</span><span class="hide-s">Impact</span></div>
        ${idx.map(i => {
          const r = L.p[i], you = i === L.me;
          return `<div class="sb${you ? ' you' : ''}"><span class="mh">${icon(c, r[7], 26)}<span>${c.esc(c.heroName(r[7]))}${you ? ' <span class="you-tag">You</span>' : ''}${r[12] === 1 ? ' <span class="first">★ MVP</span>' : r[12] >= 2 && r[12] <= 3 ? ` <span class="tag">MVP ${r[12]}</span>` : ''}</span></span>
            <span class="n">${r[2]}<span class="sl">/</span>${r[3]}<span class="sl">/</span>${r[4]}</span><span class="n">${c.kfmt(r[1])}</span><span class="n">${c.kfmt(r[5])}</span>
            <span class="n hide-s">${c.kfmt(r[6])}</span><span class="n hide-s">${c.kfmt(r[8])}</span><span class="hide-s">${impactBar(imp[i].impact)}</span></div>`;
        }).join('')}</div>`;
    };
    const myTeam = L.p[L.me][0];
    host.innerHTML = head + `
      <div class="grid-2">
        <section class="card role-card${g.lobbyFirst ? ' gold' : ''}">
          <div class="t-label">Your share of your team ${src('rule', 'Your share of your own team’s souls, damage (or healing), kills + assists and objectives, minus extra deaths: 1.00 = an average teammate. Tested on your last 400 games, it does NOT predict whether you win (being your team’s #1 won 49% of the time), because the whole team wins or loses together. It describes your part; the win-chance card below measures what moved the game.')}</div>
          ${g.lobbyFirst ? '<div class="first-line">★ 1st in the lobby · Valve’s MVP</div>' : g.mvp >= 2 && g.mvp <= 3 ? `<div class="muted small">Valve’s ${g.mvp === 2 ? '2nd' : '3rd'} MVP</div>` : ''}
          <div class="role-big">#${g.teamRank} of ${g.teamSize}</div>
          <p class="muted">${g.teamRank <= 2 ? 'Top share' : g.teamRank >= g.teamSize - 1 ? 'Low share' : 'Mid share'} of your team’s stats · impact <b>${g.impact.toFixed(2)}</b> <span class="small">(1.00 = an average teammate)</span></p>
          <div class="tags">${tagChips(c, g)}</div>
        </section>
        <section class="card">
          <div class="t-label">You vs an average teammate <span class="muted">(100% = average)</span></div>
          <div class="shares">${share('souls', 'Souls')}${share('dmg', 'Damage')}${share('ka', 'Kills + assists')}${share('obj', 'Objectives')}${share('deaths', 'Deaths', true)}</div>
          ${p ? `<div class="t-label" style="margin-top:14px">Compared with your usual ${c.esc(c.heroName(m.hero))} (${p.base} games)</div><ul class="zs">${zs}</ul>`
              : `<p class="muted small">Form vs your usual appears once you have ${E.MIN_HERO_GAMES}+ games on this hero.</p>`}
        </section>
      </div>
      ${wpCard(c, m)}
      ${coachCard(c, m)}
      <section class="card flush scoreboard">${team(myTeam)}${team(1 - myTeam)}</section>`;
    if (window.WPMODEL && !c.matchWin(m.id)) c.ensureMatchDetail(m.id);
    const cb = host.querySelector('[data-coach]');
    if (cb) cb.addEventListener('click', () => c.runDebrief(m.id, cb.dataset.coach === 'again'));
  }

  function coachCard(c, m) {
    const st = c.state, d = st.debriefs[m.id], busy = st.coaching[m.id];
    const head = `<div class="card-head"><div><div class="t-label">AI coach ${src('ai', 'Gemini writes this from a ~5 KB summary of the match that Climb builds: your deaths, items, souls vs lane opponents, scoreboards, the win-chance timeline and your gaps vs the next rank. It is told to use only those numbers, and they are checkable on this page, but the wording and the advice are Gemini’s.')}</div><h2>Debrief</h2></div>`;
    if (!st.coach.key) {
      return `<section class="card coach">${head}</div><p class="muted">Get three specific points on this match: what decided it, what you did well, and one thing to change next game. It reads your deaths, item timings, souls vs your lane opponents and your gaps against the next rank.</p>
        <p><a class="more" href="#/about">Add your Gemini API key in Account & about →</a></p></section>`;
    }
    if (busy) return `<section class="card coach">${head}</div><p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(busy)}</p></section>`;
    if (!d) {
      return `<section class="card coach">${head}<button type="button" class="btn" data-coach="go">Coach me</button></div>
        <p class="muted small">Sends a ~5 KB summary of this match to Gemini (${c.esc(st.coach.model)}) with your key. About 15 seconds.</p></section>`;
    }
    if (d.error) {
      return `<section class="card coach">${head}<button type="button" class="btn ghost-btn" data-coach="again">Try again</button></div><p class="neg">${c.esc(d.error)}</p></section>`;
    }
    const x = d.data;
    return `<section class="card coach">${head}<button type="button" class="btn ghost-btn" data-coach="again" title="Ask again">↻ Redo</button></div>
      <p class="coach-sum">${c.esc(x.summary)}</p>
      <ol class="coach-pts">${(x.points || []).map(p => `<li class="${p.kind === 'strength' ? 'good' : 'bad'}">
        <div class="cp-title">${p.kind === 'strength' ? '▲' : '▼'} ${c.esc(p.title)}</div>
        <div class="cp-ev muted">${c.esc(p.evidence)}</div>
        <div class="cp-fix"><b>Next game:</b> ${c.esc(p.fix)}</div></li>`).join('')}</ol>
      <div class="coach-focus"><span class="t-label">Focus next ${c.esc(c.heroName(m.hero))} game</span><div>${c.esc(x.focus_next_game)}</div></div>
      <p class="muted small">Gemini ${c.esc(d.model)} · ${c.ago(d.at / 1000)}${d.tokens ? ' · ' + c.fmtInt(d.tokens) + ' tokens' : ''}. It only sees this match’s numbers, so treat it as a second opinion, not gospel.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- heroes + rank ladder
  function heroes(host, c) {
    const M = c.M, E = c.E, S = c.settings;
    const now = Date.now() / 1000;
    const counts = new Map();
    for (const m of M.all) counts.set(m.hero, (counts.get(m.hero) || 0) + 1);
    const recentCount = new Map();
    for (const m of M.all) if (now - m.t < 60 * 86400) recentCount.set(m.hero, (recentCount.get(m.hero) || 0) + 1);
    const list = [...counts.keys()].sort((a, b) => (recentCount.get(b) || 0) - (recentCount.get(a) || 0) || counts.get(b) - counts.get(a));
    if (!list.length) { host.innerHTML = '<div class="empty-state">No matches yet.</div>'; return; }
    const hero = c.state.route.id && counts.has(c.state.route.id) ? c.state.route.id : list[0];
    const games = M.all.filter(m => m.hero === hero);
    const sum = E.summarize(games, M.perf, c.state.lobbies);
    const roles = E.roleSummary(games, c.state.lobbies);
    const heroEarly = E.earlyRates(games.map(c.entryOf), c.state.items && c.state.items.map);
    const plan = c.benchPlan(M, hero);
    const yourTier = M.badge ? Math.floor(M.badge / 10) : 0;
    const k = c.ladderKeys(hero, plan.from, S.account);
    const get = key => c.state.curves[key] ? c.state.curves[key].c : null;
    const tiersData = {};
    let loaded = 0;
    for (const t of E.LADDER_TIERS) { tiersData[t] = { curve: get(k.tiers[t].curve), stats: get(k.tiers[t].stats) }; if (tiersData[t].curve) loaded++; }
    const mine = { curve: get(k.me), stats: get(k.meStats) };
    const T = S.benchT;
    const ready = mine.curve && mine.stats && loaded === E.LADDER_TIERS.length;
    const lad = ready ? E.rankLadder(hero, T, mine, tiersData, yourTier) : null;
    const nextTier = Math.min(11, yourTier + 1);
    const tn = t => c.tierName(t);
    const fmt = (r, v) => v == null ? '—' : r.fmt === 'pct' ? Math.round(v * 100) + '%' : r.fmt === 'dec' ? v.toFixed(1) : c.kfmt(v);
    const window = !plan.widened ? `games since the ${new Date(plan.from * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} patch`
      : `the last ${E.BENCH_WIDE_DAYS} days` + (plan.spansPatch ? ' (spans a patch)' : '');

    host.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Heroes</h1><p class="muted small">Pick a hero to see what stands between you and the next rank on it.</p></div></div>
      <div class="hero-pick" role="tablist" aria-label="Hero">${list.map(h => `<a href="#/heroes/${h}" class="hp${h === hero ? ' on' : ''}" role="tab" aria-selected="${h === hero}" title="${c.esc(c.heroName(h))}">${icon(c, h, 36)}<span>${c.esc(c.heroName(h))}</span><span class="muted small">${counts.get(h)}</span></a>`).join('')}</div>

      <section class="card hero-sum">
        <div class="ident">${icon(c, hero, 56)}<div><div class="rank-name">${c.esc(c.heroName(hero))}</div>
          <div class="muted">${games.length} games tracked · ${sum.wins}–${sum.losses} (${c.pct(sum.winRate)})${sum.hasDelta ? ' · ' + c.signed(sum.net) + ' rank pts' : ''}</div></div></div>
        <div class="tiles tiles-5">
          <div class="tile"><div class="t-label">Win rate</div><div class="t-val">${c.pct(sum.winRate)}</div><div class="t-sub">${sum.wins}–${sum.losses}</div></div>
          <div class="tile"><div class="t-label">Rank points</div><div class="t-val">${sum.hasDelta ? c.signed(sum.net) : '—'}</div><div class="t-sub">on this hero</div></div>
          <div class="tile"><div class="t-label">Ahead at 12:00</div><div class="t-val">${heroEarly.nAhead ? c.pct(heroEarly.ahead12) : '—'}</div><div class="t-sub">${heroEarly.nAhead} recent games</div></div>
          <div class="tile"><div class="t-label">No early deaths</div><div class="t-val">${heroEarly.nClean ? c.pct(heroEarly.clean10) : '—'}</div><div class="t-sub">before 10:00</div></div>
          <div class="tile"><div class="t-label">MVP awards</div><div class="t-val">${roles.n ? roles.mvp : '—'}</div><div class="t-sub">${roles.n} games read</div></div>
        </div>
      </section>

      <section class="card road">
        <div class="card-head"><div><div class="t-label">Your road to ${c.esc(tn(nextTier))}</div><h2>What ${c.esc(tn(nextTier))} players do on ${c.esc(c.heroName(hero))} that you don’t, yet</h2>
          <p class="muted small">Your average ${c.esc(c.heroName(hero))} game vs the average one in ${c.esc(tn(nextTier))} lobbies, at ${T / 60}:00, over ${window} (${plan.n} of your games${plan.thin ? ', fewer than ' + E.MIN_HERO_GAMES + ', so treat it as a rough read' : ''}).</p></div>
          ${seg('Game time', [[900, '15 min'], [1200, '20 min'], [1800, '30 min']], T).replace('class="seg-ctl"', 'class="seg-ctl" id="bt"')}</div>
        ${!ready ? `<p class="muted">Loading the comparison… ${loaded}/${E.LADDER_TIERS.length} ranks</p>` : roadHtml(c, lad, yourTier, nextTier, fmt, tn, T, tiersData, hero)}
      </section>`;
    bindSeg(host, '#bt', v2 => { S.benchT = Number(v2); c.save(); c.render(); });
    host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { c.startFocus(b.dataset.pick, null, null, 'you'); c.go('#/coach'); }));
    if (!ready) c.ensureHeroLadder(hero);
  }

  /* The next-rank plan: up to three training targets, what's already there, and the full ladder
     folded away. */
  function roadHtml(c, lad, yourTier, nextTier, fmt, tn, T, tiersData, hero) {
    const E = c.E, plan = E.nextRankPlan(lad), nextName = tn(nextTier);
    const nNext = tiersData[nextTier] && tiersData[nextTier].curve && tiersData[nextTier].curve[T] ? tiersData[nextTier].curve[T].n : null;
    const active = c.state.focus.active && c.state.focus.active.habit;
    const why = `Averages of ${nNext ? c.fmtInt(nNext) + ' ' : ''}${c.heroName(hero)} games in ${nextName} lobbies (lobby average badge in that rank) since the last big patch, from deadlock-api. A gap is only listed when it’s bigger than your own game-to-game swing.`;
    const targets = plan.gaps.slice(0, 3);
    return `${targets.length ? `<ol class="targets">${targets.map(g => {
        const h = g.habit && E.habitById(g.habit);
        const habitBtn = !h ? '' : active === g.habit ? `<span class="tag">your current focus</span>` : `<button type="button" class="btn ghost-btn sm" data-pick="${g.habit}">Train it: ${c.esc(h.short)}</button>`;
        return `<li><div class="tg-head"><b>${c.esc(g.label)}</b> ${src('ranks', why)}</div>
          <div class="tg-num"><span class="tg-you">${fmt(g, g.you)}</span> → <span class="tg-target">${fmt(g, g.target)}</span> <span class="neg small">${g.rel > 0 ? '+' : '−'}${Math.abs(Math.round(g.rel * 100))}% vs ${c.esc(nextName)}</span></div>
          <div class="muted small">${h ? `Climb checks this every game through the “${c.esc(h.label)}” habit.` : 'No per-game check for this yet. Watch it here after your next few games.'}</div>
          ${habitBtn}</li>`;
      }).join('')}</ol>`
      : `<p class="road-none">Nothing here is clearly below the ${c.esc(nextName)} average at ${T / 60}:00. On this hero the gap is in what these numbers can’t see (decisions, timing, positioning), so use the win-chance card on your matches to find the moments that cost you.</p>`}
      ${plan.strengths.length ? `<p class="muted small">Already at ${c.esc(nextName)} level or above: ${plan.strengths.map(x => `<b class="pos">${c.esc(x.label)}</b>`).join(', ')}.</p>` : ''}
      ${ladderHtml(c, lad, yourTier, nextTier, fmt, tn, T)}`;
  }

  const SHADE_OK = new Set(['acc', 'souls', 'lane', 'jungle', 'dmg', 'obj']);   // stats where beating a rank's average means playing like them
  function ladderHtml(c, lad, yourTier, nextTier, fmt, tn, T) {
    const E = c.E;
    const yours = yourTier ? tn(yourTier) : 'your rank';
    const nextName = tn(nextTier);
    const gapTxt = (r, cmp) => cmp && cmp.rel != null ? (cmp.rel > 0 ? '+' : '−') + Math.abs(Math.round(cmp.rel * 100)) + '%' : '';
    const verdict = cmp => !cmp || !cmp.status ? '<span class="muted">—</span>'
      : cmp.status === 'par' ? '<span class="muted" title="Within your normal game-to-game swing">≈ on par</span>'
      : `<span class="${cmp.status === 'ahead' ? 'pos' : 'neg'}">${cmp.status === 'ahead' ? '▲' : '▼'} ${gapTxt(null, cmp)}</span>`;
    const levelCell = r => r.noLevel || r.level == null ? '<span class="muted">—</span>'
      : r.level === 'flat' ? '<span class="muted" title="Varies less than 8% between Initiate and Eternus">same at every rank</span>'
      : `<span class="${r.level > yourTier ? 'pos' : r.level < yourTier ? 'neg' : ''}">${c.esc(tn(r.level))}</span>`;
    const table = `<details class="full-ladder"><summary>Compare with your rank and the next</summary>
      <div class="table-wrap"><table class="tbl ladder">
        <thead><tr><th>Stat</th><th class="n">You</th><th class="n">${c.esc(yours)}</th><th class="n">${c.esc(nextName)}</th><th>vs ${c.esc(yours)}</th><th>vs ${c.esc(nextName)}</th><th>Plays like</th></tr></thead>
        <tbody>${lad.rows.map(r => `<tr>
          <td>${r.label}</td><td class="n"><b>${fmt(r, r.you)}</b></td>
          <td class="n muted">${fmt(r, r.own && r.own.v)}</td><td class="n muted">${fmt(r, r.next && r.next.v)}</td>
          <td>${verdict(r.own)}</td><td>${verdict(r.next)}</td><td>${levelCell(r)}</td></tr>`).join('')}</tbody>
      </table></div></details>`;
    const tiers = E.LADDER_TIERS;
    const full = `
      <details class="full-ladder"><summary>Every rank, Initiate to Eternus (lobby averages at ${T / 60}:00)</summary>
        <div class="table-wrap"><table class="tbl ladder-full">
          <thead><tr><th>Stat</th><th class="n you-col">You</th>${tiers.map(t => `<th class="n${t === yourTier ? ' cur' : ''}">${c.esc(tn(t))}</th>`).join('')}</tr></thead>
          <tbody>${lad.rows.map(r => `<tr><td>${r.label}</td><td class="n you-col"><b>${fmt(r, r.you)}</b></td>${r.ladder.map(L => {
            const beat = SHADE_OK.has(r.key) && r.you != null && L.v != null && r.you >= L.v;
            return `<td class="n${L.tier === yourTier ? ' cur' : ''}${beat ? ' beat' : ''}">${fmt(r, L.v)}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <p class="muted small">Each column is the average game in that rank’s lobbies; win rate and accuracy are whole-game, the rest are at ${T / 60}:00. Shaded cells are ranks whose average you match or beat, only for farm, damage, objectives and accuracy. Deaths, kills and assists aren’t shaded: higher ranks fight more, so those rise with rank for reasons that aren’t “better”. Win rate sits near 50% at every rank by design of matchmaking.</p>
      </details>`;
    return table + full;
  }

  // ---------------------------------------------------------------- play time
  function play(host, c) {
    const P = c.P, C = c.C, st = c.state;
    const now = Date.now() / 1000;
    let H = st.helper;
    if (H && !st.helperLive) H = Object.assign({}, H, { playing: false, sessions: H.sessions.map(x => x.end == null ? { start: x.start, end: H.at / 1000 } : x) });
    const p = P.summary(H, c.M.all, now);
    const live = st.helperLive && p.playing;
    const clock = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dayLabel = key => { const [y, mo, d] = key.split('-').map(Number); return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
    const hourLabel = h => { const f = x => (x % 12 || 12) + (x % 24 < 12 ? ' AM' : ' PM'); return f(h) + '–' + f(h + 1); };
    const since = H && H.since ? new Date(H.since * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
    host.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Play time</h1><p class="muted small">How much you play, and when. To see the habit, not to judge it.</p></div>${live ? '<span class="live"><span class="dot"></span>Playing now</span>' : ''}</div>
      <div class="grid-ov">
        <section class="card"><div class="t-label">Today</div><div class="big">${P.dur(p.todaySecs)}</div>
          <p class="muted small">${H ? `${p.todaySessions} session${p.todaySessions === 1 ? '' : 's'}${live && p.playingSince ? ' · this one since ' + clock(p.playingSince) : ''}` : 'from matches on deadlock-api (can lag)'}</p>
          ${p.avgSecs == null ? '' : `<p class="muted small">Your usual: <b class="ink">${P.dur(p.avgSecs)}</b> a day over the last ${p.avgDays} days${p.todaySecs > p.avgSecs + 600 ? ` · today is <b class="ink">${P.dur(p.todaySecs - p.avgSecs)} over</b>` : ''}</p>`}</section>
        <section class="card play"><h2>Last 12 weeks</h2><div id="play-heat" class="chart"></div>
          <div class="heat-legend small muted" aria-hidden="true"><span>None</span><span class="cell lvl-0"></span><span class="cell lvl-1"></span><span class="cell lvl-2"></span><span class="cell lvl-3"></span><span class="cell lvl-4"></span><span class="cell lvl-5"></span><span>4½h+</span></div></section>
      </div>
      <section class="card"><h2>When you play <span class="muted">(last 4 weeks)</span></h2><div id="play-hours" class="chart"></div>
        <p class="muted small">${!H ? 'Counting match time from deadlock-api, which can lag or miss games. Run the Climb helper on your PC (<code>helper/install-task.ps1</code>) for real play time.'
          : `From ${since}: the helper on your PC, counting all time with Deadlock open. Before that: match time from deadlock-api.` + (st.helperLive ? '' : ` <b class="ink">Helper not reachable</b>, showing what it reported ${c.ago(st.helper.at / 1000)}.`)}</p></section>`;
    p.cells.forEach(x => { x.today = x.key === p.today; });
    C.heatmap(host.querySelector('#play-heat'), p.cells, { label: 'Hours played per day over the last 12 weeks',
      tipHtml: x => `<b>${dayLabel(x.key)}</b><br>${x.secs ? P.dur(x.secs) : 'Didn’t play'}` });
    C.hourBars(host.querySelector('#play-hours'), p.hours, { label: 'Time played by hour of day over the last 4 weeks',
      tipHtml: (h, v) => `<b>${hourLabel(h)}</b><br>${v ? P.dur(v) + ' over 4 weeks' : 'Never'}` });
  }

  // ---------------------------------------------------------------- about / settings
  function about(host, c) {
    const S = c.settings, st = c.state, E = c.E;
    const lob = Object.values(st.lobbies);
    host.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Account & about</h1></div></div>
      <div class="grid-2">
        <section class="card"><h2>Account</h2>
          <p>${st.profile && st.profile.name ? `<b>${c.esc(st.profile.name)}</b> · ` : ''}Steam account ID ${S.account}</p>
          <form id="acct-form" class="acct-form small-form" autocomplete="off">
            <input id="acct-in" type="text" placeholder="Switch: profile URL, SteamID or name" spellcheck="false">
            <button type="submit" class="btn">Switch</button>
          </form>
          <div id="acct-results"></div>
          <p class="muted small">Each account keeps its own cache in this browser. Nothing leaves your device except requests to deadlock-api.com.</p>
        </section>
        <section class="card"><h2>AI coach (Gemini)</h2>
          ${st.coach.key ? `<p>Key saved in this browser · ${st.coach.models.length} models available</p>
            <label class="field"><span class="muted small">Model</span><select id="coach-model">${st.coach.models.map(m => `<option value="${c.esc(m.id)}"${m.id === st.coach.model ? ' selected' : ''}>${c.esc(m.label)} (${c.esc(m.id)})</option>`).join('')}</select></label>
            <button type="button" class="btn ghost-btn" id="coach-clear">Remove key</button>`
          : `<p class="muted small">Paste your own Gemini API key (from Google AI Studio). It’s stored only in this browser and sent only to Google, never anywhere else. Match summaries you debrief go to Google with it.</p>
            <form id="coach-form" class="acct-form small-form" autocomplete="off">
              <input id="coach-key" type="password" placeholder="Gemini API key" spellcheck="false" autocomplete="off">
              <button type="submit" class="btn">Save</button>
            </form><p id="coach-msg" class="small"></p>`}
        </section>
        <section class="card"><h2>Missing games?</h2>
          <p class="muted small">${freshLine(c)}</p>
          <p class="muted small">Climb shows what deadlock-api has. A game reaches deadlock-api once someone sends it the game’s key from Valve, which can take hours. To get yours there within minutes:</p>
          ${missingGuide(c)}
        </section>
        <section class="card"><h2>Data</h2>
          <p class="muted small">${c.M.all.length} matches on record · ${lob.filter(L => L && L.v === E.LOBBY_V).length} lobbies read${st.history ? ` · history updated ${c.ago(st.history.at / 1000)}` : ''}</p>
          <label class="toggle"><input type="checkbox" id="blend"${S.blend ? ' checked' : ''}${S.games === 'all' ? ' disabled' : ''}> Blend unranked games (last 120 days) into hero baselines when “Ranked” is selected</label>
          <p class="muted small">Data from <a href="https://deadlock-api.com" rel="noopener" target="_blank">deadlock-api.com</a>. New games can take a while to show up there.</p>
        </section>
      </div>
      <section class="card how"><h2>How Climb reads your games</h2><ul>
        <li><b>Improving / Holding / Slipping</b> combines rank points, form and consistency, each compared with the window before. If your lobbies got 3+ subranks tougher, placing lower there isn’t held against you.</li>
        <li><b>Impact</b> is your share of your team’s souls, damage (or healing, for supports), kills + assists and objective damage, each relative to an average teammate, minus a penalty for dying more than them. 1.00 = an average teammate.</li>
        <li><b>Team share</b> (Top / Mid / Low share) is your rank on your own team by impact. It describes your part and is kept neutral: tested on 400 games, it doesn’t predict whether you win, because a whole team wins or loses together. What does predict wins is early-game play, measured before the result is decided, which is what the habits and the Overview tiles use.</li>
        <li><b>Where numbers come from</b>: every key number has a small badge. <i>Your games</i> = counted from your matches. <i>Rank data</i> = averages of other players’ games by rank. <i>Trained model</i> = Climb’s win model. <i>Valve</i> = straight from the game. <i>Climb rule</i> = a rule of thumb, not proven. <i>AI</i> = Gemini’s wording. Tap one to see how it was worked out.</li>
        <li><b>Tags</b>: Valve’s MVP awards, then lobby bests (top farmer, top damage, most kills, playmaker, objectives, healer, frontline, survivor), plus Fed (10+ deaths), Stomp / Stomped (under 20 min) and Marathon (45+ min).</li>
        <li><b>Form</b> scores a game against your other games on the same hero, using your share of the lobby’s souls, damage, kills + assists and deaths.</li>
        <li><b>Rank comparison</b> (Heroes tab): for the hero you pick, your average against the average game in each rank’s lobbies, over the same dates: games since the last big patch, or the last 60 days if you have fewer than 8. A gap is only called when it’s bigger than your normal game-to-game swing.</li>
      </ul></section>
      <section class="card how"><h2>Changelog</h2>${c.LOG.map(e => `<h3>v${e.v} · ${c.esc(e.title)} <span class="muted small">${c.esc(e.date)}</span></h3><ul>${e.items.map(i => `<li>${c.esc(i)}</li>`).join('')}</ul>`).join('')}</section>`;
    host.querySelector('#acct-form').addEventListener('submit', async e => {
      e.preventDefault();
      const q = host.querySelector('#acct-in').value;
      const parsed = E.parseSteamInput(q);
      if (!parsed) return;
      if (parsed.account) { c.setAccount(parsed.account); return; }
      const out = host.querySelector('#acct-results');
      out.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const rows = await c.A.steamSearch(parsed.search);
        out.innerHTML = rows && rows.length ? `<ul class="pick">${rows.map(r => `<li><button type="button" data-acct="${r.account_id}">
          ${r.avatarmedium ? `<img src="${c.esc(r.avatarmedium)}" alt="" width="32" height="32">` : '<span class="av-ph"></span>'}
          <span><b>${c.esc(r.personaname || 'Unknown')}</b><span class="muted small">${r.matches_played_last_30d} games in 30 days</span></span></button></li>`).join('')}</ul>`
          : '<p class="muted">No Deadlock players found with that name.</p>';
        out.querySelectorAll('[data-acct]').forEach(b => b.addEventListener('click', () => c.setAccount(Number(b.dataset.acct))));
      } catch (err) { out.innerHTML = `<p class="neg">Couldn’t search right now: ${c.esc(err.message)}</p>`; }
    });
    host.querySelector('#blend').addEventListener('change', e => { S.blend = e.target.checked; c.save(); });
    const cf = host.querySelector('#coach-form');
    if (cf) cf.addEventListener('submit', async e => {
      e.preventDefault();
      const msg = host.querySelector('#coach-msg');
      msg.className = 'small muted'; msg.textContent = 'Checking the key…';
      const r = await c.saveCoachKey(host.querySelector('#coach-key').value);
      if (r && r.error) { msg.className = 'small neg'; msg.textContent = r.error; }
    });
    const sel = host.querySelector('#coach-model');
    if (sel) sel.addEventListener('change', e => c.setCoachModel(e.target.value));
    const clr = host.querySelector('#coach-clear');
    if (clr) clr.addEventListener('click', () => c.clearCoach());
  }

  root.Views = { welcome, overview, coach, matches, match, heroes, friends, friend, play, about };
})(window);
