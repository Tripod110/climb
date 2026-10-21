/* views.js — one function per page. Each takes (host, ctx) and writes HTML from ctx.M (the model
   app.js builds) and Engine. No fetching here except asking app.js to ensure data it needs. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- shared bits
  const ICONV = { improving: '▲', holding: '■', slipping: '▼', unknown: '·' };
  const WORD = { improving: 'Improving', holding: 'Holding', slipping: 'Slipping', unknown: 'Not enough games' };
  const roleClass = (E, r) => E.ROLE_GOOD[r] > 0 ? 'good' : E.ROLE_GOOD[r] < 0 ? 'bad' : 'flat';
  const roleChip = (c, g, id) => g ? `<span class="role ${roleClass(c.E, g.role)}">${c.E.ROLE_LABEL[g.role]}</span>`
    : id != null && c.state.lobbies[id] === null ? '<span class="role pending">No lobby data</span>' : '<span class="role pending">Reading lobby…</span>';
  const tagChips = (c, g, max) => !g ? '' : g.tags.slice(0, max || 99).map(t => `<span class="tag${c.E.TAG2_GOOD[t] < 0 ? ' warn' : ''}">${c.E.TAG2_LABEL[t]}</span>`).join('');
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
    const rolesPrev = M.w.prev.length ? E.roleSummary(M.w.prev, c.state.lobbies) : null;
    const delta = (a, b, good) => a == null || b == null ? '' : (() => {
      const d = a - b; if (Math.abs(d) < 0.02) return '<span class="muted">same as before</span>';
      const up = d > 0; return `<span class="${up === good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))} pts</span>`;
    })();
    const tile = (label, value, sub) => `<div class="tile"><div class="t-label">${label}</div><div class="t-val">${value}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    const R = M.curRanked;
    const fresh = c.LOG.filter(e => e.v > S.seenV).slice(0, 2);
    const recent = M.all.slice(-8).reverse();
    const heroes = E.heroBreakdown(M.w.cur, M.perf).slice(0, 5);

    host.innerHTML = `
      ${fresh.length ? `<section class="card whatsnew"><div class="wn-head"><h2>What’s new</h2><button id="wn-ok" class="btn ghost-btn" type="button">Got it</button></div>
        ${fresh.map(e => `<h3>v${e.v} · ${c.esc(e.title)}</h3><ul>${e.items.map(i => `<li>${c.esc(i)}</li>`).join('')}</ul>`).join('')}</section>` : ''}

      <div class="page-head">
        <div class="ident">
          ${M.badge ? `<img class="badge" src="${c.A.rankImage(M.badge)}" alt="" width="64" height="64">` : ''}
          <div>
            <div class="rank-name">${c.esc(E.badgeName(M.badge, c.tiers()))}</div>
            <div class="muted">Season ${M.seasonSum.wins}–${M.seasonSum.losses}${M.seasonSum.hasDelta ? ' · ' + c.signed(M.seasonSum.net) + ' rank pts' : ''} · ${M.all.length} matches tracked</div>
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
          ${tile('Win rate', c.pct(M.cur.winRate), `${M.cur.wins}–${M.cur.losses}`)}
          ${tile('Rank points', R.hasDelta ? c.signed(R.net) : '—', R.n ? `${R.n} ranked games` : 'no ranked games')}
          ${tile('Carried', roles.n ? c.pct(roles.carry) : '—', rolesPrev ? delta(roles.carry, rolesPrev.carry, true) : 'your team’s #1 impact')}
          ${tile('Key player', roles.n ? c.pct(roles.key) : '—', rolesPrev ? delta(roles.key, rolesPrev.key, true) : 'top 2 on your team')}
          ${tile('Dragged / passenger', roles.n ? c.pct(roles.dragged) : '—', rolesPrev ? delta(roles.dragged, rolesPrev.dragged, false) : 'bottom of your team')}
          ${tile('MVP awards', roles.n ? String(roles.mvp) : '—', roles.n ? `in ${roles.n} games` : '')}
        </div>
      </div>

      <section class="card">
        <div class="card-head"><h2>How your games went</h2><a href="#/matches" class="more">All matches →</a></div>
        ${roleBars(c, roles)}
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
          <div class="card-head"><h2>Heroes in this window</h2><a href="#/heroes" class="more">Compare vs ranks →</a></div>
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
  }

  function trendTxt(h) {
    if (!h.ready || h.trend == null) return '<span class="muted small">—</span>';
    return h.trend >= 0.2 ? '<span class="pos small">▲ rising</span>' : h.trend <= -0.2 ? '<span class="neg small">▼ dipping</span>' : '<span class="muted small">■ steady</span>';
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

  // ---------------------------------------------------------------- matches list
  const matchFilter = { hero: 'all', result: 'all', role: 'all', mode: 'all' };
  function matches(host, c) {
    const M = c.M, E = c.E;
    const heroes = [...new Set(M.all.map(m => m.hero))].sort((a, b) => c.heroName(a).localeCompare(c.heroName(b)));
    const rows = M.all.slice().reverse().map(m => ({ m, g: E.gameRole(c.state.lobbies[m.id], m.won), L: c.state.lobbies[m.id] }))
      .filter(({ m, g }) => (matchFilter.hero === 'all' || m.hero === Number(matchFilter.hero))
        && (matchFilter.result === 'all' || (matchFilter.result === 'win') === m.won)
        && (matchFilter.mode === 'all' || m.mode === matchFilter.mode)
        && (matchFilter.role === 'all' || (g && g.role === matchFilter.role)));
    const shown = rows.slice(0, 150);
    const opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${c.esc(l)}</option>`;
    host.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Matches</h1><p class="muted small">${rows.length} of ${M.all.length} matches. Click one for the full lobby.</p></div>
        <div class="filters">
          <select id="f-hero" aria-label="Hero">${opt('all', 'All heroes', matchFilter.hero)}${heroes.map(h => opt(h, c.heroName(h), matchFilter.hero)).join('')}</select>
          <select id="f-result" aria-label="Result">${opt('all', 'Wins and losses', matchFilter.result)}${opt('win', 'Wins', matchFilter.result)}${opt('loss', 'Losses', matchFilter.result)}</select>
          <select id="f-role" aria-label="Role">${opt('all', 'Any role', matchFilter.role)}${Object.keys(E.ROLE_LABEL).map(k => opt(k, E.ROLE_LABEL[k], matchFilter.role)).join('')}</select>
          <select id="f-mode" aria-label="Mode">${opt('all', 'Ranked + unranked', matchFilter.mode)}${opt('ranked', 'Ranked', matchFilter.mode)}${opt('unranked', 'Unranked', matchFilter.mode)}</select>
        </div></div>
      <section class="card flush">
        <div class="mrow mhead"><span>Hero</span><span>Result</span><span>Role</span><span class="n">K / D / A</span><span class="n hide-s">Souls</span><span class="n hide-s">Damage</span><span class="hide-s">Impact</span><span class="n">Rank</span><span class="n">When</span></div>
        ${shown.length ? shown.map(({ m, g, L }) => {
          const me = L && L.p[L.me];
          return `<a class="mrow ${m.won ? 'w' : 'l'}" href="#/match/${m.id}">
            <span class="mh">${icon(c, m.hero, 32)}<span><b>${c.esc(c.heroName(m.hero))}</b><span class="muted small">${m.mode === 'ranked' ? 'Ranked' : 'Unranked'} · ${mins(m.dur)}</span></span></span>
            <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span>
            <span class="mrole">${roleChip(c, g, m.id)}<span class="tags">${tagChips(c, g, 2)}</span></span>
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
    const roleNote = g.role === 'key' && g.teamRank > 2 && g.mvp >= 1 && g.mvp <= 3
      ? `Valve named you ${g.mvp === 1 ? 'MVP' : g.mvp === 2 ? '2nd MVP' : '3rd MVP'} for this game, though by Climb’s impact score you were #${g.teamRank} on your team.`
      : E.ROLE_NOTE[g.role];
    const team = t => {
      const idx = L.p.map((x, i) => i).filter(i => L.p[i][0] === t).sort((a, b) => L.p[b][1] - L.p[a][1]);
      const won = L.win == null ? null : L.win === t;
      return `<div class="team"><div class="team-h"><b>${t === L.p[L.me][0] ? 'Your team' : 'Enemy team'}</b>${won == null ? '' : `<span class="${won ? 'win' : 'loss'}">${won ? 'Won' : 'Lost'}</span>`}</div>
        <div class="sb sb-h"><span>Hero</span><span class="n">K/D/A</span><span class="n">Souls</span><span class="n">Damage</span><span class="n hide-s">Heal</span><span class="n hide-s">Obj</span><span class="hide-s">Impact</span></div>
        ${idx.map(i => {
          const r = L.p[i], you = i === L.me;
          return `<div class="sb${you ? ' you' : ''}"><span class="mh">${icon(c, r[7], 26)}<span>${c.esc(c.heroName(r[7]))}${you ? ' <span class="you-tag">You</span>' : ''}${r[12] >= 1 && r[12] <= 3 ? ` <span class="tag">MVP${r[12] > 1 ? ' ' + r[12] : ''}</span>` : ''}</span></span>
            <span class="n">${r[2]}<span class="sl">/</span>${r[3]}<span class="sl">/</span>${r[4]}</span><span class="n">${c.kfmt(r[1])}</span><span class="n">${c.kfmt(r[5])}</span>
            <span class="n hide-s">${c.kfmt(r[6])}</span><span class="n hide-s">${c.kfmt(r[8])}</span><span class="hide-s">${impactBar(imp[i].impact)}</span></div>`;
        }).join('')}</div>`;
    };
    const myTeam = L.p[L.me][0];
    host.innerHTML = head + `
      <div class="grid-2">
        <section class="card role-card ${roleClass(E, g.role)}">
          <div class="t-label">Your role</div>
          <div class="role-big">${E.ROLE_LABEL[g.role]}</div>
          <p class="muted">${roleNote}</p>
          <p>#${g.teamRank} of ${g.teamSize} on your team by impact · impact <b>${g.impact.toFixed(2)}</b> <span class="muted small">(1.00 = an average teammate)</span></p>
          <div class="tags">${tagChips(c, g)}</div>
        </section>
        <section class="card">
          <div class="t-label">You vs an average teammate <span class="muted">(100% = average)</span></div>
          <div class="shares">${share('souls', 'Souls')}${share('dmg', 'Damage')}${share('ka', 'Kills + assists')}${share('obj', 'Objectives')}${share('deaths', 'Deaths', true)}</div>
          ${p ? `<div class="t-label" style="margin-top:14px">Compared with your usual ${c.esc(c.heroName(m.hero))} (${p.base} games)</div><ul class="zs">${zs}</ul>`
              : `<p class="muted small">Form vs your usual appears once you have ${E.MIN_HERO_GAMES}+ games on this hero.</p>`}
        </section>
      </div>
      <section class="card flush scoreboard">${team(myTeam)}${team(1 - myTeam)}</section>`;
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
      <div class="page-head"><div><h1 class="page-title">Heroes</h1><p class="muted small">Pick a hero to see how you compare with players at every rank on it.</p></div></div>
      <div class="hero-pick" role="tablist" aria-label="Hero">${list.map(h => `<a href="#/heroes/${h}" class="hp${h === hero ? ' on' : ''}" role="tab" aria-selected="${h === hero}" title="${c.esc(c.heroName(h))}">${icon(c, h, 36)}<span>${c.esc(c.heroName(h))}</span><span class="muted small">${counts.get(h)}</span></a>`).join('')}</div>

      <section class="card hero-sum">
        <div class="ident">${icon(c, hero, 56)}<div><div class="rank-name">${c.esc(c.heroName(hero))}</div>
          <div class="muted">${games.length} games tracked · ${sum.wins}–${sum.losses} (${c.pct(sum.winRate)})${sum.hasDelta ? ' · ' + c.signed(sum.net) + ' rank pts' : ''}</div></div></div>
        <div class="tiles tiles-5">
          <div class="tile"><div class="t-label">Carried</div><div class="t-val">${roles.n ? c.pct(roles.carry) : '—'}</div><div class="t-sub">team’s #1 impact</div></div>
          <div class="tile"><div class="t-label">Key player</div><div class="t-val">${roles.n ? c.pct(roles.key) : '—'}</div><div class="t-sub">top 2 on team</div></div>
          <div class="tile"><div class="t-label">Dragged / passenger</div><div class="t-val">${roles.n ? c.pct(roles.dragged) : '—'}</div><div class="t-sub">bottom of team</div></div>
          <div class="tile"><div class="t-label">Avg impact</div><div class="t-val">${roles.impact == null ? '—' : roles.impact.toFixed(2)}</div><div class="t-sub">1.00 = avg teammate</div></div>
          <div class="tile"><div class="t-label">MVP awards</div><div class="t-val">${roles.n ? roles.mvp : '—'}</div><div class="t-sub">${roles.n} games read</div></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>You vs every rank on ${c.esc(c.heroName(hero))}</h2>
          <p class="muted small">Your average game against the average ${c.esc(c.heroName(hero))} game in each rank’s lobbies, over ${window} (${plan.n} of your games${plan.thin ? ', fewer than ' + E.MIN_HERO_GAMES + ', so treat it as a rough read' : ''}). Win rate and accuracy are whole-game; the rest are at the minute you pick.</p></div>
          ${seg('Game time', [[900, '15 min'], [1200, '20 min'], [1800, '30 min']], T).replace('class="seg-ctl"', 'class="seg-ctl" id="bt"')}</div>
        ${!ready ? `<p class="muted">Loading the comparison… ${loaded}/${E.LADDER_TIERS.length} ranks</p>` : ladderHtml(c, lad, yourTier, nextTier, fmt, tn)}
      </section>`;
    bindSeg(host, '#bt', v2 => { S.benchT = Number(v2); c.save(); c.render(); });
    if (!ready) c.ensureHeroLadder(hero);
  }

  function ladderHtml(c, lad, yourTier, nextTier, fmt, tn) {
    const E = c.E;
    const yours = yourTier ? tn(yourTier) : 'your rank';
    const nextName = tn(nextTier);
    const gapTxt = (r, cmp) => cmp && cmp.rel != null ? (cmp.rel > 0 ? '+' : '−') + Math.abs(Math.round(cmp.rel * 100)) + '%' : '';
    const verdict = cmp => !cmp || !cmp.status ? '<span class="muted">—</span>'
      : cmp.status === 'par' ? '<span class="muted" title="Within your normal game-to-game swing">≈ on par</span>'
      : `<span class="${cmp.status === 'ahead' ? 'pos' : 'neg'}">${cmp.status === 'ahead' ? '▲' : '▼'} ${gapTxt(null, cmp)}</span>`;
    const toNext = lad.toNext.slice(0, 3);
    const strengths = lad.ahead.slice(0, 3);
    const summary = `
      <div class="grid-2 ladder-sum">
        <div class="focus bad"><div class="t-label">Holding you back from ${c.esc(nextName)}</div>
          ${toNext.length ? `<ol>${toNext.map(r => `<li><b>${r.label}</b> <span class="neg">${gapTxt(r, r.next)}</span> <span class="muted small">(${fmt(r, r.you)} vs ${fmt(r, r.next.v)})</span></li>`).join('')}</ol>`
            : `<p class="muted small">Nothing clearly below ${c.esc(nextName)} average here. The gap is in what these numbers don’t measure: decisions, timing, positioning.</p>`}</div>
        <div class="focus good"><div class="t-label">Already above ${c.esc(yours)}</div>
          ${strengths.length ? `<ol>${strengths.map(r => `<li><b>${r.label}</b> <span class="pos">${gapTxt(r, r.own)}</span> <span class="muted small">(${fmt(r, r.you)} vs ${fmt(r, r.own.v)})</span></li>`).join('')}</ol>`
            : `<p class="muted small">No stat clearly above your rank’s average yet.</p>`}</div>
      </div>`;
    const levelCell = r => r.noLevel || r.level == null ? '<span class="muted">—</span>'
      : r.level === 'flat' ? '<span class="muted" title="Varies less than 8% between Initiate and Eternus">same at every rank</span>'
      : `<span class="${r.level > yourTier ? 'pos' : r.level < yourTier ? 'neg' : ''}">${c.esc(tn(r.level))}</span>`;
    const table = `
      <div class="table-wrap"><table class="tbl ladder">
        <thead><tr><th>Stat</th><th class="n">You</th><th class="n">${c.esc(yours)}</th><th class="n">${c.esc(nextName)}</th><th>vs ${c.esc(yours)}</th><th>vs ${c.esc(nextName)}</th><th>Plays like</th></tr></thead>
        <tbody>${lad.rows.map(r => `<tr>
          <td>${r.label}</td><td class="n"><b>${fmt(r, r.you)}</b></td>
          <td class="n muted">${fmt(r, r.own && r.own.v)}</td><td class="n muted">${fmt(r, r.next && r.next.v)}</td>
          <td>${verdict(r.own)}</td><td>${verdict(r.next)}</td><td>${levelCell(r)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    const tiers = E.LADDER_TIERS;
    const full = `
      <details class="full-ladder"><summary>Every rank, Initiate to Eternus</summary>
        <div class="table-wrap"><table class="tbl ladder-full">
          <thead><tr><th>Stat</th><th class="n you-col">You</th>${tiers.map(t => `<th class="n${t === yourTier ? ' cur' : ''}">${c.esc(tn(t))}</th>`).join('')}</tr></thead>
          <tbody>${lad.rows.map(r => `<tr><td>${r.label}</td><td class="n you-col"><b>${fmt(r, r.you)}</b></td>${r.ladder.map(L => {
            const beat = r.you != null && L.v != null && (r.higher ? r.you >= L.v : r.you <= L.v);
            return `<td class="n${L.tier === yourTier ? ' cur' : ''}${beat ? ' beat' : ''}">${fmt(r, L.v)}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <p class="muted small">Shaded cells are ranks whose average you match or beat. “Plays like” is the rank whose average is closest to yours; “same at every rank” means the stat moves less than 8% from Initiate to Eternus, so it doesn’t separate ranks on this hero. A gap is only called when it’s bigger than your normal game-to-game swing.</p>
      </details>`;
    return summary + table + full;
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
        <section class="card"><h2>Data</h2>
          <p class="muted small">${c.M.all.length} matches on record · ${lob.filter(L => L && L.v === E.LOBBY_V).length} lobbies read${st.history ? ` · history updated ${c.ago(st.history.at / 1000)}` : ''}</p>
          <label class="toggle"><input type="checkbox" id="blend"${S.blend ? ' checked' : ''}${S.games === 'all' ? ' disabled' : ''}> Blend unranked games (last 120 days) into hero baselines when “Ranked” is selected</label>
          <p class="muted small">Data from <a href="https://deadlock-api.com" rel="noopener" target="_blank">deadlock-api.com</a>. New games can take a while to show up there.</p>
        </section>
      </div>
      <section class="card how"><h2>How Climb reads your games</h2><ul>
        <li><b>Improving / Holding / Slipping</b> combines rank points, form and consistency, each compared with the window before. If your lobbies got 3+ subranks tougher, placing lower there isn’t held against you.</li>
        <li><b>Impact</b> is your share of your team’s souls, damage (or healing, for supports), kills + assists and objective damage, each relative to an average teammate, minus a penalty for dying more than them. 1.00 = an average teammate.</li>
        <li><b>Roles</b>. Won: <i>Carried</i> (your team’s #1 by a clear margin), <i>Key player</i> (top 2, or a Valve MVP), <i>Solid win</i>, <i>Passenger</i> (bottom two). Lost: <i>Couldn’t carry</i> (#1 by a clear margin), <i>Key player</i>, <i>Tough loss</i>, <i>Dragged down</i> (last on your team, or far below an average teammate).</li>
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
  }

  root.Views = { welcome, overview, matches, match, heroes, play, about };
})(window);
