/* views.js — one function per page. Each takes (host, ctx) and writes HTML from ctx.M (the model
   app.js builds) and Engine. No fetching here except asking app.js to ensure data it needs. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- shared bits
  const ICONV = { improving: '▲', holding: '■', slipping: '▼', unknown: '·' };
  const WORD = { improving: 'Improving', holding: 'Holding', slipping: 'Slipping', unknown: 'Not enough games' };
  const firstChip = g => g && g.lobbyFirst ? '<span class="first" title="Valve named you MVP: 1st in the lobby">★ MVP</span>' : '';
  /* Team share is neutral on purpose: on the user's 400 games it didn't predict results (see
     the team-share note in engine.js). Gold ★ 1st (Valve's MVP) is the only highlight. */
  /* How the game went compared with YOUR usual on that hero (the form score), only when it is clearly
     above or below. It replaces "Top/Mid/Low share", which described your team's split and said
     nothing about how you played. */
  const FORM_GAME = 0.4;
  const roleChip = (c, g, id) => {
    if (!g) return id != null && c.state.lobbies[id] === null ? '<span class="role pending">No lobby data</span>' : '<span class="role pending">Reading lobby…</span>';
    const p = c.M.perf.get(id);
    const f = !p ? '' : p.score >= FORM_GAME ? '<span class="role good" title="You played above your usual on this hero (souls, farm by 12:00 vs your lane, damage, kills + assists, staying alive vs your other games on it).">Above your usual</span>'
      : p.score <= -FORM_GAME ? '<span class="role bad" title="You played below your usual on this hero (souls, farm by 12:00 vs your lane, damage, kills + assists, staying alive vs your other games on it).">Below your usual</span>' : '';
    return firstChip(g) + f;
  };

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

  const icon = (c, hero, size) => {
    const src = c.heroIcon(hero);
    return src ? `<img class="hero-ic" src="${src}" alt="" width="${size}" height="${size}" loading="lazy">` : `<span class="hero-ic" style="width:${size}px;height:${size}px"></span>`;
  };
  const kda = m => `${m.k}<span class="sl">/</span>${m.d}<span class="sl">/</span>${m.a}`;
  const deltaHtml = (c, m) => m.delta == null ? '<span class="muted">—</span>' : `<span class="${m.delta > 0 ? 'pos' : m.delta < 0 ? 'neg' : 'muted'}">${c.signed(m.delta)}</span>`;
  const mins = s => Math.round(s / 60) + 'm';
  const form1 = x => { const v = Math.round(x * 10) / 10; return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1); };
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
  /* Pace of your climb, in divisions you actually moved (never a points prediction: see Engine.rankForecast). */
  function forecastCard(c) {
    const E = c.E, fc = E.rankForecast(c.M.all.filter(m => m.mode === 'ranked'));
    if (fc.call === 'thin') return '';
    const nm = b => c.esc(E.badgeName(b, c.tiers()));
    const info = src('rule', `A rank step is one division, e.g. Ritualist 1 → Ritualist 2 (in Season 2, 1,000 rank points; the last step of a rank 1,500). Counts the steps you actually moved in your last ${E.RANK_FC_N} ranked games (placement games excluded) and only calls a direction when both halves of that stretch agree. This is where you’ve been; “Where your win rate takes you” below is where you’re heading.`);
    // Numbers first: games per division (or the call), then the stretch it was read from.
    const big = fc.call === 'climbing' ? `<span class="pace-n">${Math.round(fc.perDivision)}</span><span class="muted">games / rank step</span>`
      : `<span class="pace-w ${fc.call === 'sliding' ? 'neg' : ''}">${fc.call === 'sliding' ? '▼ Sliding' : fc.call === 'flat' ? '■ Flat' : '· Mixed'}</span>`;
    return `<div class="forecast"><div class="t-label">Pace ${info}</div><div class="pace">${big}</div>
      <div class="pace-sub small"><span>${nm(fc.from)} → ${nm(fc.to)}</span><span>${fc.n} ranked · ${c.pct(fc.winRate)}</span>
      ${fc.call === 'climbing' ? `<span>${fc.range[0]}–${fc.range[1]} games</span>${fc.next ? `<span>next <b>${nm(fc.next)}</b></span>` : ''}` : ''}</div></div>`;
  }

  /* Where your rank is heading: badges after +20/+50/+100 ranked games from your win rate (Engine.rankOutlook). */
  function projRow(c) {
    const E = c.E, pj = E.rankOutlook(c.M.all.filter(m => m.mode === 'ranked'));
    if (!pj) return '';
    const nm = b => c.esc(E.badgeName(b, c.tiers()));
    // "Mystic 2 – Mystic 5" reads as "Mystic 2–5" when both ends are in one tier.
    const span = (lo, hi) => Math.floor(lo / 10) === Math.floor(hi / 10) ? `${nm(lo)}–${hi % 10}` : `${nm(lo)} – ${nm(hi)}`;
    const rung = (k, b, sub, cls) => `<li class="rung ${cls || ''}"><span class="rung-k">${k}</span><img src="${c.A.rankImage(b)}" alt="" width="44" height="44"><b>${nm(b)}</b><span class="rung-r">${sub || '&nbsp;'}</span></li>`;
    const info = src('model', `From your win rate in your last ${pj.n} ranked games (${pj.wins}–${pj.n - pj.wins}), pulled toward 50% by ${E.OUTLOOK_K} games so a hot or cold streak doesn’t run away with it. Tested on 27 players’ Season 1 games: this was the best guess. Carrying your recent pace forward was the worst, and your lobbies’ average rank didn’t help. Even at 50%, Season 1 players drifted up about ${(E.OUTLOOK_DRIFT * 50).toFixed(1)} rank steps per 50 games (demotion shields stop some drops); that drift is included and gets re-checked once Season 2 has games. The range under each badge is where 6 in 10 players with that win rate ended up.`);
    return `<div class="proj ${pj.dir < 0 ? 'down' : 'up'}"><div class="t-label">Where your win rate takes you ${info}</div>
      <ol class="rungs">${rung('Today', pj.now, `${c.pct(pj.wr)} adj. win rate`)}${pj.steps.map(s => rung(`in ${s.games} games`, s.badge, s.lo === s.hi ? '' : 'range ' + span(s.lo, s.hi), pj.dir < 0 ? 'neg' : '')).join('')}</ol>
      ${pj.tierUp && pj.tierUp.games <= 300 ? `<div class="muted small num-line"><span><b>${nm(pj.tierUp.badge)}</b> in ~${pj.tierUp.games} games</span></div>` : ''}</div>`;
  }

  /* The rank line, for any player: a badge name, "Calibrating" during placement games, or "Unranked". */
  const rankTitle = c => c.E.rankStatus(c.M.ranked, c.M.badge).state === 'calibrating' ? 'Calibrating' : c.esc(c.E.badgeName(c.M.badge, c.tiers()));

  /* Overview section header: small-caps kicker between gilded rules, with an optional link. */
  const sh = (kicker, more) => `<header class="sh"><div class="sh-k"><span>${kicker}</span></div>${more ? `<div class="sh-row">${more}</div>` : ''}</header>`;

  /* A verdict signal as a number pair: now, and what it was (Engine.verdict's three signals). */
  function sigChip(c, s) {
    const d = s.detail, M = c.M;
    const sc = form1;
    const dir = s.dir == null ? 'na' : s.dir === 1 ? 'up' : s.dir === -1 ? 'down' : 'flat';
    const ic = { 1: '▲', 0: '■', '-1': '▼', null: '·' }[s.dir];
    let label, now, was = '';
    if (s.text === 'rank') { label = 'Rank points'; now = d.net == null ? '—' : c.signed(d.net); }
    else if (s.text === 'form') {
      label = 'Form ' + src('yours', FORM_INFO);
      if (s.dir == null) now = '—';
      else if (d.tougher) { now = 'Even'; was = `lobbies +${Math.round(M.v.lobbyShift)} subranks`; }
      else { now = sc(d.score); was = d.ref == null ? '' : (d.hasRef ? 'was ' : 'usual ') + sc(d.ref); }
    } else { label = 'Rough games ' + src('yours', 'Games you lost while playing below your usual (Form under 0), as a share of games with a Form score. Fewer is better, even before it shows as wins.'); now = s.dir == null ? (d.of ? `${d.rough}/${d.of}` : '—') : c.pct(d.rate); was = s.dir == null || d.ref == null ? '' : 'was ' + c.pct(d.ref); }
    return `<li class="sig ${dir}"><span class="sig-icon" aria-hidden="true">${ic}</span><span class="sig-k">${label}</span><b class="sig-v">${now}</b>${was ? `<span class="sig-was">${was}</span>` : ''}</li>`;
  }

  function overview(host, c) {
    const M = c.M, E = c.E, S = c.settings;
    if (!M.all.length) { host.innerHTML = `<div class="empty-state">${c.state.busy ? 'Loading your matches…' : 'No matches found for this account yet.'}</div>`; return; }
    const v = M.v;
    const items = c.state.items && c.state.items.map;
    const early = E.earlyRates(M.w.cur.map(c.entryOf), items);
    const earlyPrev = M.w.prev.length ? E.earlyRates(M.w.prev.map(c.entryOf), items) : null;
    const cat = c.focusCatalog();
    const catOf = id => cat.find(x => x.id === id);
    const splitNote = id => { const x = catOf(id); return x && x.n ? ` Over your last ${x.n} games you won ${c.pct(x.wrPass)} when you did this and ${c.pct(x.wrFail)} when you didn’t.` : ''; };
    const delta = (a, b, good) => a == null || b == null ? '' : (() => {
      const d = a - b; if (Math.abs(d) < 0.02) return '<span class="muted">■ same</span>';
      const up = d > 0; return `<span class="${up === good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))}% vs before</span>`;
    })();
    const fig = (label, value, sub, badge) => `<div class="fig"><div class="fig-v">${value}</div><div class="t-label">${label}${badge ? ' ' + badge : ''}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    const fresh = c.LOG.filter(e => e.v > S.seenV).slice(0, 2);
    const recent = M.all.slice(-8).reverse();
    const pace = forecastCard(c);
    const rs = E.rankStatus(M.ranked, M.badge);

    host.innerHTML = `
      ${fresh.length ? `<div class="dispatch"><details><summary><span class="t-label">New in ${c.verName(fresh[0].v)}</span> ${c.esc(fresh[0].title)}</summary>
        ${fresh.map(e => `<h3>${c.verName(e.v)} · ${c.esc(e.title)}</h3><ul>${e.items.map(i => `<li>${c.esc(i)}</li>`).join('')}</ul>`).join('')}</details>
        <button id="wn-ok" class="btn ghost-btn sm" type="button">Got it</button></div>` : ''}
      ${missingCard(c)}
      ${recapCard(c)}

      <div class="masthead">
        <div class="ident">
          ${M.badge ? `<img class="badge" src="${c.A.rankImage(M.badge)}" alt="" width="64" height="64">` : ''}
          <div>
            <div class="rank-name">${rankTitle(c)}</div>
            <div class="muted small num-line">${rs.state === 'calibrating' ? `<span>${rs.placed} placement game${rs.placed === 1 ? '' : 's'}</span>` : ''}<span>${M.seasonSum.wins}–${M.seasonSum.losses}</span>${M.seasonSum.hasDelta ? `<span>${c.signed(M.seasonSum.net)} pts</span>` : ''}<span>${M.all.length} games</span>${freshLine(c)}</div>
          </div>
        </div>
        <div class="ctl-row">
          ${seg('Time window', [['session', 'Last session'], ['last20', 'Last 20'], ['season', 'Season']], S.window).replace('class="seg-ctl"', 'class="seg-ctl" id="win"')}
          ${seg('Which games', [['all', 'All games'], ['ranked', 'Ranked']], S.games).replace('class="seg-ctl"', 'class="seg-ctl" id="scope"')}
        </div>
      </div>

      ${S.srcHint ? '' : `<div class="src-hint small"><span>Tap any ${src('yours', 'Like this one. Each says where a number comes from: Your games, Trained model, Rank data, Valve, Climb rule or AI. Tap any of them to see how it was worked out.')} to see how a number is worked out</span><button type="button" class="btn ghost-btn sm" id="hint-ok">Got it</button></div>`}
      <section class="ov-hero v-${v.call}">
        <div class="kicker">${M.cur.n} games${M.prev ? ' vs the ' + M.prev.n + ' before' : ''}${v.confidence === 'low' && M.cur.n ? ' · small sample' : ''}</div>
        <div class="v-line"><span class="v-icon" aria-hidden="true">${ICONV[v.call]}</span><h1 class="v-word">${WORD[v.call]}</h1></div>
        <ul class="signals">${v.signals.map(s => sigChip(c, s)).join('')}</ul>
      </section>
      <div class="ledger">
        ${fig('Win rate', c.pct(M.cur.winRate), `${M.cur.wins}–${M.cur.losses}`, src('yours', `Wins ÷ games in this window (${M.cur.n} games), from your match history on deadlock-api.`))}
        ${fig('Souls lead at 12:00', early.nAhead ? c.pct(early.ahead12) : '—', earlyPrev && earlyPrev.nAhead ? delta(early.ahead12, earlyPrev.ahead12, true) : `${early.nAhead} games`, src('yours', `Games where your souls at 12:00 beat your lane opponents’ average, out of ${early.nAhead} games in this window with match detail.` + splitNote('ahead12')))}
        ${fig('No deaths to 10:00', early.nClean ? c.pct(early.clean10) : '—', earlyPrev && earlyPrev.nClean ? delta(early.clean10, earlyPrev.clean10, true) : `${early.nClean} games`, src('yours', `Games with zero deaths in the first 10 minutes, out of ${early.nClean} games in this window with match detail.` + splitNote('early0')))}
        ${fig('Deaths a game', M.cur.n ? (M.w.cur.reduce((s, m) => s + m.d, 0) / M.cur.n).toFixed(1) : '—', M.prev && M.prev.n ? `${(M.w.prev.reduce((s, m) => s + m.d, 0) / M.prev.n).toFixed(1)} before` : '', src('yours', 'Average deaths per game in this window, from your match history.'))}
      </div>

      <section class="ov-sec">
        ${sh('Training', '<a href="#/coach" class="more">Coach →</a>')}
        <div class="train${pace ? '' : ' solo'}">${focusCard(c, false)}${pace}</div>
      </section>

      <section class="ov-sec">
        ${sh('Scouting · what wins you games', '<a href="#/coach" class="more">Pick a habit →</a>')}
        ${splitTable(c, cat)}
      </section>

      <section class="ov-sec">
        ${sh('Film room', '<a href="#/matches" class="more">All matches →</a>')}
        <ol class="reel">${recent.map(m => {
          const g = E.gameRole(c.state.lobbies[m.id], m.won);
          return `<li><a class="frame ${m.won ? 'w' : 'l'}" href="#/match/${m.id}">
            <span class="fm-res">${m.won ? 'Win' : 'Loss'}</span>${icon(c, m.hero, 52)}
            <b class="fm-hero">${c.esc(c.heroName(m.hero))}</b>
            <span class="fm-kda">${kda(m)}</span>
            <span class="fm-foot">${m.delta == null ? deltaHtml(c, m) : `<span>${deltaHtml(c, m)} <span class="muted">pts</span></span>`}<span class="muted">${c.ago(m.t)}</span></span>
            ${g ? `<span class="fm-chips">${roleChip(c, g, m.id)}</span>` : ''}</a></li>`;
        }).join('')}</ol>
      </section>

      <section class="ov-sec">
        ${sh('The climb · season rank points')}
        ${projRow(c)}
        <div id="rank-chart" class="chart"></div>
        ${E.rankSeries(M.season).length >= 2 ? '<div class="chart-key small"><span class="pos">▲</span> ranked up <span class="neg">▼</span> ranked down</div>' : ''}
      </section>`;

    const pts = E.rankSeries(M.season);
    const t0 = M.w.cur.length ? M.w.cur[0].t : Infinity;
    const hiFrom = S.window === 'season' ? null : pts.findIndex(p => p.t >= t0);
    c.C.rankLine(host.querySelector('#rank-chart'), pts, {
      hiFrom: hiFrom < 0 ? null : hiFrom,
      label: 'Cumulative rank points across the season',
      tipHtml: (p, i) => {
        const was = i > 0 ? pts[i - 1].badge : null, moved = p.badge != null && was != null && p.badge !== was;
        return `${moved ? `<b class="${p.badge > was ? 'pos' : 'neg'}">${p.badge > was ? '▲ Ranked up' : '▼ Ranked down'} to ${c.esc(E.badgeName(p.badge, c.tiers()))}</b><br>` : ''}<b>${c.signed(p.cum)} pts</b>${moved ? '' : ' · ' + c.esc(E.badgeName(p.badge, c.tiers()))}<br>${p.won ? 'Win' : 'Loss'} on ${c.esc(c.heroName(p.hero))} (${c.signed(p.delta)})`;
      },
    });
    bindSeg(host, '#win', v2 => { S.window = v2; c.save(); c.render(); });
    bindSeg(host, '#scope', v2 => { S.games = v2; c.save(); c.render(); });
    const hk = host.querySelector('#hint-ok');
    if (hk) hk.addEventListener('click', () => { S.srcHint = true; c.save(); c.render(); });
    // Tapping any tag also counts as having seen the hint (it goes on the next redraw, so the popover stays).
    if (!S.srcHint) host.addEventListener('click', e => { if (e.target.closest && e.target.closest('.src')) { S.srcHint = true; c.save(); } });
    const ok = host.querySelector('#wn-ok');
    if (ok) ok.addEventListener('click', () => { S.seenV = c.VERSION; c.save(); c.render(); });
    const mk = host.querySelector('#missing-ok');
    if (mk) mk.addEventListener('click', () => c.dismissMissing(c.freshnessNow().newestId));
    bindAddMatch(host, c);
    const rk = host.querySelector('#recap-ok');
    if (rk) rk.addEventListener('click', () => { const s0 = E.lastSession(M.all, c.state.helper, Date.now() / 1000, 18); if (s0) c.dismissRecap(s0.end); });
    if (!c.state.detailsBusy) c.ensureDetails();
  }

  /* One bar per habit, split at the centre. The point is the right half, green: how often you WIN with
     it. The left half is a quiet grey reference, how often you lost without it. Not "skipped": some of
     these (an early death) aren't fully up to you. Each half is 0–100%. Shared by Overview and Coach. */
  const splitHead = (c, n) => `<li class="dv-head small"><span>${src('yours', `From your last ${n} games with match detail. Right: the share of games you won when it happened. Left: the share you lost when it didn’t. These are measured before the game is decided, unless marked “follows result”.`)}</span>
    <span class="dv-scale"><span class="muted">◀ Lost without it</span><span class="pos">Won with it ▶</span></span></li>`;
  const splitLab = (c, x) => `<span class="sp-lab">${c.esc(x.label)}${x.outcome ? ' <span class="tag" title="Partly follows the result">follows result</span>' : ''}<span class="muted small" title="How often it happens">${c.pct(x.passRate)} of games</span></span>`;
  function splitBar(c, x) {
    const lose = 1 - x.wrFail, win = x.wrPass;
    return `<span class="dv" role="img" aria-label="You won ${c.pct(win)} of games with it and lost ${c.pct(lose)} without it">
      <b class="dv-off">${c.pct(lose)}</b><span class="dv-track"><span class="dv-bar l" style="right:50%;width:${(lose * 50).toFixed(1)}%"></span><span class="dv-bar w" style="left:50%;width:${(win * 50).toFixed(1)}%"></span></span><b class="pos">${c.pct(win)}</b></span>`;
  }

  /* The habits that split YOUR wins from losses most, from your last 30 games. Plain counts. */
  function splitTable(c, cat) {
    const rows = cat.filter(x => x.eligible).slice(0, 4);
    if (!rows.length) return '<p class="muted small">Counting once match details for your recent games have loaded…</p>';
    return `<ul class="splits">${splitHead(c, rows[0].n)}
      ${rows.map(x => `<li>${splitLab(c, x)}${splitBar(c, x)}</li>`).join('')}</ul>`;
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
    // One ruled row of figures: record, points, habit marks, early deaths, the biggest swing.
    const rf = (v, k, cls) => `<span class="rf"><b class="${cls || ''}">${v}</b><span class="t-label">${k}</span></span>`;
    return `<section class="recap-band"><span class="t-label rb-k">Last session · ${c.ago(s0.end)}</span>
      ${rf(`${w}–${g.length - w}`, 'record')}
      ${ranked ? rf(c.signed(pts), 'rank pts', pts > 0 ? 'pos' : pts < 0 ? 'neg' : '') : ''}
      ${f && marks.length ? `<span class="rf"><span class="dots">${marks.map(x => `<span class="dot ${x === '✓' ? 'y' : 'n'}">${x}</span>`).join('')}</span><span class="t-label">${c.esc(E.habitById(f.habit).short)}</span></span>` : ''}
      ${rf(early, 'deaths &lt; 10:00', early ? '' : 'pos')}
      ${swing ? `<a class="rf" href="#/match/${swing.m.id}"><b class="${swing.t.delta >= 0 ? 'pos' : 'neg'}">${swing.t.delta > 0 ? '+' : '−'}${Math.abs(Math.round(swing.t.delta * 100))}%</b><span class="t-label" title="Biggest win-chance swing">swing · ${c.esc(c.heroName(swing.m.hero))} ${mm(swing.t.from)}–${mm(swing.t.to)}${swing.t.myDeaths.length ? ' · ' + swing.t.myDeaths.length + (swing.t.myDeaths.length === 1 ? ' death' : ' deaths') : ''} →</span></a>` : ''}
      <button type="button" class="btn ghost-btn sm" id="recap-ok">Got it</button></section>`;
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

  /* ---- farm: souls by source against your lane opponents (see Engine.farmAt) ---- */
  const FARM_INFO = 'Climb reads the souls you had earned from each source by this minute against the average of the players in your lane on the other team. deadlock-api records totals a few times a match, not which camp or box was taken or when, so this says what you got, never which spawn you missed.';
  const gapHtml = (c, v) => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'}">${v > 0 ? '+' : v < 0 ? '−' : '±'}${c.fmtInt(Math.abs(Math.round(v)))}</span>`;
  const clk = t => Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0');

  let farmTab = 'sum';   // 'sum' | 'lane' | 'camps' | 'boxes'; module state because the page redraws as data loads
  const FARM_TABS = [['sum', 'Summary'], ['lane', 'Lane creeps'], ['camps', 'Jungle'], ['boxes', 'Boxes']];
  const laneName = l => {
    const c = Engine.laneColor(l.lane), pos = l.side ? l.side[0].toUpperCase() + l.side.slice(1) : null;
    return c ? c + ' lane' + (pos ? ' (' + pos.toLowerCase() + ')' : '') : 'Lane ' + l.lane;
  };
  const sgnN = (c, v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + c.fmtInt(Math.abs(Math.round(v)));
  /* Named lanes, with who stood in them: the same lane you were in is the one your numbers are compared in. */
  function lanesList(c, lanes) {
    const heroes = hs => hs.map(h => `<span class="fl-h${h.you ? ' you' : ''}" title="${c.esc(c.heroName(h.hero))}">${icon(c, h.hero, 22)}</span>`).join('');
    return `<ul class="farm-lanes">${lanes.map(l => `<li><span class="fl-name"><b>${laneName(l)}</b>${l.yours ? ' <span class="you-tag">Your lane</span>' : ''}</span>
      <span class="fl-who">${heroes(l.mineHeroes)} <span class="muted small">vs</span> ${heroes(l.theirHeroes)}</span>
      <span class="n">${c.fmtInt(Math.round(l.mine))} <span class="muted">vs</span> ${c.fmtInt(Math.round(l.theirs))}</span>${gapHtml(c, l.mine - l.theirs)}</li>`).join('')}</ul>`;
  }

  function farmMatchCard(c, m) {
    const E = c.E, D = c.state.details[m.id];
    if (!D || D.v !== E.DETAIL_V) return '';
    const f = E.farmAt(D);
    if (!f) return '';
    const lanes = E.farmLanes(D, f.t), yours = lanes && lanes.find(l => l.yours);
    const opps = yours ? yours.theirHeroes.map(h => c.esc(c.heroName(h.hero))).join(' and ') : '';
    const who = f.nOpp ? `<p class="muted small">Compared with the ${f.nOpp === 1 ? 'player' : f.nOpp + ' players'} against you in your own lane (${yours ? laneName(yours).toLowerCase() : 'your lane'}${opps ? ': ' + opps : ''}): your souls from each source against their average. Not the whole enemy team.</p>` : '';
    const tabs = seg('Farm view', FARM_TABS, farmTab).replace('class="seg-ctl"', 'class="seg-ctl" id="ft"');
    const head = `<div class="card-head"><div><div class="t-label">Farm ${src('yours', FARM_INFO)}</div><h2>${farmTab === 'sum' ? `Where your souls came from at ${clk(f.t)}` : c.esc((E.FARM_SRC.find(x => x[0] === farmTab) || [])[1])}</h2></div></div>${tabs}`;
    if (farmTab !== 'sum') {
      const rows = E.farmSeries(D, farmTab) || [];
      const ls = E.farmLanes(D, f.t, farmTab);
      return `<section class="card farm-card">${head}${who}
        <div class="table-wrap"><table class="tbl"><thead><tr><th>By</th><th class="n">You</th><th class="n">Lane opponents</th><th class="n">Gap</th>${farmTab === 'lane' ? '<th class="n">Creeps last-hit (you / them)</th>' : ''}</tr></thead>
        <tbody>${rows.map(r => `<tr><td>${clk(r.t)}</td><td class="n">${c.fmtInt(r.me)}</td><td class="n">${r.opp == null ? '—' : c.fmtInt(Math.round(r.opp))}</td><td class="n">${r.opp == null ? '—' : gapHtml(c, r.me - r.opp)}</td>${farmTab === 'lane' ? `<td class="n">${r.effMe == null ? '—' : Math.round(r.effMe * 100) + '%'}${r.effOpp == null ? '' : ' / ' + Math.round(r.effOpp * 100) + '%'}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        ${ls ? `<div class="t-label" style="margin-top:12px">Lane by lane at ${clk(f.t)} · souls per player from this source</div>${lanesList(c, ls)}` : ''}
      </section>`;
    }
    const rows = f.src.filter(x => x.opp != null);
    const worst = rows.slice().sort((a, b) => (a.me - a.opp) - (b.me - b.opp))[0];
    const P = E.farmProfile(c.analysisEntries());
    let line;
    if (!rows.length) line = 'No lane opponent found for this game, so there is nothing to compare against.';
    else if (worst && worst.me - worst.opp <= -E.FARM_MIN_GAP) {
      const gap = worst.me - worst.opp, u = P.ready ? (P.src.find(x => x.key === worst.key) || {}).gap : null;
      const usual = u == null ? '' : Math.abs(u) < E.FARM_MIN_GAP ? ` You’re usually about even here (${sgnN(c, u)}), so this game was unusual.`
        : u < 0 ? ` You’re usually ${sgnN(c, u)} here, so this is your pattern.` : ` You’re usually ${sgnN(c, u)} here, so this game was the exception.`;
      line = `Biggest gap: <b>${c.esc(worst.label.toLowerCase())}</b>, ${gapHtml(c, gap)} souls against your lane opponents by ${clk(f.t)}.${usual}`;
    } else line = `No source where you trailed your lane opponents by ${E.FARM_MIN_GAP}+ souls by ${clk(f.t)}.`;
    const me = D.players.find(p => p.items), early = me ? (me.deaths || []).filter(d => d[0] < f.t).length : null;
    const eff = f.eff.me == null ? '' : `<p class="muted small">Lane creeps last-hit by ${clk(f.t)}, of those you could reach: you ${Math.round(f.eff.me * 100)}%${f.eff.opp != null ? `, lane opponents ${Math.round(f.eff.opp * 100)}%` : ''}.${early != null ? ` You died ${early} time${early === 1 ? '' : 's'} before then, which costs farm too.` : ''}</p>`;
    return `<section class="card farm-card">${head}${who}
      <p>${line}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Source</th><th class="n">You</th><th class="n">Lane opponents</th><th class="n">Gap</th></tr></thead>
      <tbody>${f.src.map(x => `<tr><td>${c.esc(x.label)}</td><td class="n">${c.fmtInt(x.me)}</td><td class="n">${x.opp == null ? '—' : c.fmtInt(Math.round(x.opp))}</td><td class="n">${x.opp == null ? '—' : gapHtml(c, x.me - x.opp)}</td></tr>`).join('')}</tbody></table></div>
      ${eff}
      ${lanes && lanes.length > 1 ? `<div class="t-label" style="margin-top:12px">Lane by lane · souls per player from all three sources</div>${lanesList(c, lanes)}` : ''}
    </section>`;
  }

  /* Coach's farm section: per source, the gap to your lane opponents at 12:00 as a figure (you vs them
     under it), plus lane creeps killed. A gap is coloured only when Engine.farmProfile calls it. */
  function farmProfileCard(c) {
    const E = c.E, P = E.farmProfile(c.analysisEntries());
    if (!P.ready) return `<p class="muted small">${P.n}/${P.n + P.need} games with farm detail</p>`;
    const info = src('yours', FARM_INFO + ' A gap is coloured only when it is 150+ souls and shows in both halves of your games.');
    const cls = { ahead: 'pos', behind: 'neg', even: '' };
    const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + c.fmtInt(Math.abs(Math.round(v)));
    const fig = (label, v, cl, sub, badge) => `<div class="fig"><div class="fig-v ${cl}">${v}</div><div class="t-label">${label}${badge ? ' ' + badge : ''}</div><div class="t-sub">${sub}</div></div>`;
    return `<div class="ledger">
      ${P.src.map((x, i) => fig(x.label, sgn(x.gap), cls[x.call], `${c.fmtInt(Math.round(x.me))} vs ${c.fmtInt(Math.round(x.opp))}`, i ? '' : info)).join('')}
      ${P.eff ? fig('Creeps last-hit', Math.round(P.eff.me * 100) + '%', P.eff.me - P.eff.opp >= 0.05 ? 'pos' : P.eff.opp - P.eff.me >= 0.05 ? 'neg' : '', `lane ${Math.round(P.eff.opp * 100)}%`) : ''}
    </div>`;
  }

  function wpCard(c, m) {
    const W = window.WPMODEL;
    if (!W) return '';
    const w = c.matchWin(m.id);
    const q20 = W.quality && W.quality['1200'];
    const head = `<div class="card-head"><div><div class="t-label">Win chance ${src('model', `Climb’s win model, trained on ${c.fmtInt(W.matches)} Deadlock matches since the ${W.patch} patch (deadlock-api’s public data). It reads the gaps in souls, kills, objectives destroyed and mid-boss at each minute. Checked on matches it never saw: at 20:00 the team it favours wins ${q20 && q20.accuracy ? Math.round(q20.accuracy * 100) + '%' : '~75%'} of the time, and its percentages match real results to within ~1–2 points between 9 and 30 minutes. The Coach tab shows how it does on your own games.`)}</div><h2>How this game swung</h2></div></div>`;
    if (!w) return `<section class="card wp-card">${head}<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading the match timeline…</p></section>`;
    const pts = v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v * 100))}%`;
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
        <div><div class="t-label">Your deaths${w.deaths.length ? ` · about −${Math.round(total * 100)}% win chance in total` : ''} ${src('model', 'What a death like this USUALLY costs: the median souls swing for the dead player’s team, measured around deaths where nobody else in the lobby died, by game minute and by how rich the victim was. That swing is then turned into win chance with the model. It isn’t a measurement of that exact death: snapshots are 3–5 minutes apart, so most deaths (teamfights) can’t be isolated.')}</div>
          ${w.deaths.length ? `<ul class="wp-list">${w.deaths.map(d => `<li><span class="wp-when">${mmss(d.t)}</span>
            <span>Died to <b>${hero(d.killerHero)}</b>${d.ttk > 0 && d.ttk <= c.E.FAST_DEATH_S ? ` <span class="tag warn" title="Died within ${c.E.FAST_DEATH_S}s of first taking damage">caught out</span>` : ''}</span>
            <span class="muted small">${Math.round(d.total * 100) >= 1 ? `about <b class="neg">${pts(-d.total)}</b> win chance` : `under 1% of win chance${d.p < 0.05 || d.p > 0.95 ? ' (the game was already decided)' : ''}`} · a death like this usually swings ~${c.fmtInt(d.souls)} souls${d.share >= 1.2 ? ' (you were rich, so it cost more)' : ''}${d.objPts >= 0.005 ? ` · +${Math.round(d.objLift * 100)}% chance your team loses an objective in the next 90s` : ''}</span></li>`).join('')}</ul>`
            : '<p class="muted small">No deaths this game.</p>'}</div>
      </div>
      <p class="muted small">Model trained ${c.esc(W.trained_at.slice(0, 10))} on ${c.fmtInt(W.matches)} matches since the ${c.esc(W.patch)} patch${q && q.accuracy ? `. At 20:00 the team it favours goes on to win ${Math.round(q.accuracy * 100)}% of the time` : ''}. Death costs are what a death like that usually costs at that minute, measured around deaths where nobody else died, not a measurement of that exact death.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- missing games (data freshness)
  /* Why games are missing and the ways to get them to deadlock-api faster. The full setup (both
     ingest setups, privacy, uninstall) lives on ingest.html; this is the short version. The old
     launch-options-only advice failed on Windows ("cannot find the path specified", 2026-10-26),
     so the installer is now the main route. */
  function missingGuide(c) {
    return `<ol class="fix-steps">
      <li><b>Install deadlock-api’s ingest tool</b> (free, open source, two minutes). It sends each game to deadlock-api as soon as it ends, so it shows up here within minutes.
        <a class="btn" href="ingest.html">Open the setup guide</a>
        <span class="muted small">The guide covers the normal install, a more private setup that only runs while Deadlock is open, and what the tool does with your Steam login.</span></li>
      <li><b>Already use Deadlock Mod Manager or the Statlocker companion app?</b> They send your games to deadlock-api too. Both work by using your saved Steam login.</li>
      <li><b>Or support deadlock-api</b> ($1.50/month on their Patreon), which gives your account prioritized fetching.</li>
    </ol>`;
  }

  /* "Add a match by id": for a game deadlock-api has but Valve's match history leaves out. The
     page re-renders while lobbies load, so the typed id and the reply live here, not in the DOM. */
  const addState = { value: '', msg: '', busy: false };
  function addMatchForm(c) {
    return `<form class="acct-form small-form add-match" autocomplete="off">
        <input name="mid" inputmode="numeric" placeholder="Match id, e.g. 125201309" aria-label="Match id" value="${c.esc(addState.value)}">
        <button class="btn" type="submit"${addState.busy ? ' disabled' : ''}>Add match</button></form>
      <p class="add-msg small muted" aria-live="polite">${c.esc(addState.busy ? 'Looking it up…' : addState.msg)}</p>`;
  }
  function bindAddMatch(host, c) {
    host.querySelectorAll('form.add-match').forEach(f => {
      f.elements.mid.addEventListener('input', e => { addState.value = e.target.value; });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        if (addState.busy) return;
        addState.value = f.elements.mid.value; addState.busy = true; addState.msg = '';
        c.render();
        const r = await c.addMatch(addState.value);
        addState.busy = false;
        addState.msg = r.msg;
        if (r.ok) addState.value = '';
        if (r.ok && !r.msg) { addState.msg = ''; c.go('#/match/' + r.id); return; }
        c.render();
      });
    });
  }

  function freshLine(c) {
    const f = c.freshnessNow();
    if (!f.newestEnd) return '';
    const behind = f.unseenS >= 20 * 60;
    return `<span class="fresh${behind ? ' behind' : ''}" title="Newest match on deadlock-api">last game ${c.ago(f.newestEnd)}${behind ? ` · <a href="#/about">missing games?</a>` : ''}</span>`;
  }

  function missingCard(c) {
    const f = c.freshnessNow(), S = c.settings, P = c.P;
    if (!f.newestId || f.unseenS < 20 * 60 || S.missingSeen === f.newestId) return '';
    // Headline figure only; the why and the fixes fold away.
    return `<section class="dispatch missing"><details${addState.msg || addState.busy ? ' open' : ''}><summary><span class="t-label">Missing games</span> <b>~${P.dur(f.unseenS)}</b> <span class="muted">played, not on deadlock-api yet</span> ${src('yours', 'The Climb helper on your PC logged Deadlock being open after your newest match on deadlock-api ended. Games from that time aren’t on deadlock-api yet, so Climb can’t show them. Climb itself refreshes every few minutes; the delay is deadlock-api collecting the match from Valve.')}</summary>
      <p class="muted small">deadlock-api only has a game once someone sends it the game’s key from Valve. Any of these gets it there within minutes:</p>
      ${missingGuide(c)}
      <h3 class="add-h">Add a match by id</h3>
      ${addMatchForm(c)}</details>
      <button type="button" class="btn ghost-btn sm" id="missing-ok">Got it</button></section>`;
  }

  // ---------------------------------------------------------------- focus loop
  const pc0 = v => v == null ? '—' : Math.round(v * 100) + '%';
  const dots = recent => `<span class="dots" aria-label="${recent.filter(Boolean).length} of last ${recent.length} passed">${recent.map(x => `<span class="dot ${x ? 'y' : 'n'}">${x ? '✓' : '✗'}</span>`).join('')}${'<span class="dot e"></span>'.repeat(Math.max(0, 10 - recent.length))}</span>`;

  /* The Overview's focus: the habit, its ✓/✗ run, then pass rate and win rate as before → now figures. */
  function focusBrief(c, f, h, p) {
    const E = c.E, imp = E.focusImpact(f, c.M.all, p);
    const call = p.graduated ? ['pos', 'Mastered'] : p.verdict === 'early' ? ['muted', p.n ? `${p.passes}/${p.n} passed · ${p.needed} to go` : `${p.needed} games to call it`]
      : p.verdict === 'improved' ? ['pos', '▲ working'] : p.verdict === 'worse' ? ['neg', '▼ slipping'] : ['muted', '■ no change'];
    const pair = (k, a, b, cls, note) => `<span class="fb"><span class="t-label">${k}</span><b class="${cls}">${pc0(a)} <span class="muted">→</span> ${pc0(b)}</b><span class="t-sub">${note}</span></span>`;
    const wrCls = !imp ? '' : imp.call === 'up' ? 'pos' : imp.call === 'down' ? 'neg' : '';
    return `<section class="card focus-card${p.graduated ? ' done' : ''}">
      <div class="fc-head"><div><div class="t-label">Your focus</div><div class="fc-habit">${c.esc(h.label)}</div></div>${dots(p.recent)}</div>
      <div class="fb-row">${pair('Pass rate', p.baseline, p.n ? p.rate : null, call[0] === 'muted' ? '' : call[0], `<span class="${call[0]}">${call[1]}</span>${p.verdict === 'early' ? '' : ` · ${p.n} games`}`)}
        ${imp && imp.call !== 'early' ? pair('Win rate', imp.wrBefore, imp.wrAfter, wrCls, imp.call === 'same' ? 'within normal swing' : `${imp.nAfter} games`) : ''}</div></section>`;
  }

  /* full = the Coach tab version: the Overview brief, then the controls, with why/how and the games
     since you started folded away. Otherwise the Overview card. */
  function focusCard(c, full) {
    const E = c.E, st = c.state, f = st.focus.active;
    if (!f) {
      if (!full) return `<section class="card focus-card empty"><div><div class="t-label">Your focus</div><b>No habit picked</b></div><a class="btn" href="#/coach">Pick a habit</a></section>`;
      return '';
    }
    const h = E.habitById(f.habit), p = c.focusNow();
    if (!h || !p) return '';
    if (!full) return focusBrief(c, f, h, p);
    const res = p.results.slice().reverse().slice(0, 15);
    const more = (f.why ? `<p class="fc-why">${c.esc(f.why)}</p>` : '')
      + (f.how && f.how.length ? `<div class="t-label">How to pass it</div><ul class="fc-how">${f.how.map(x => `<li>${c.esc(x)}</li>`).join('')}</ul>` : '')
      + (res.length ? `<div class="t-label">Games since you started</div><ul class="fc-games">${res.map(r => `<li><a href="#/match/${r.m.id}">
        <span class="dot ${r.pass ? 'y' : 'n'}">${r.pass ? '✓' : '✗'}</span>${icon(c, r.m.hero, 22)}<span>${c.esc(c.heroName(r.m.hero))}</span>
        <span class="${r.m.won ? 'win' : 'loss'}">${r.m.won ? 'W' : 'L'}</span><span class="muted small">${c.ago(r.m.t)}</span></a></li>`).join('')}</ul>` : '');
    return `${focusBrief(c, f, h, p)}
      <div class="fc-actions">
        ${p.graduated ? '<button type="button" class="btn" data-focus="graduate">Mark mastered, pick the next</button>' : ''}
        <button type="button" class="btn ghost-btn sm" data-focus="drop">Drop this habit</button>
        <span class="muted small">before: ${pc0(f.baseline.rate)} of ${f.baseline.n} games${f.by === 'coach' ? ' · coach’s pick' : f.by === 'climb' ? ' · Climb’s pick' : ''}</span>
      </div>
      ${more ? `<details class="fold"><summary>How to pass it · games since you started</summary>${more}</details>` : ''}`;
  }

  /* Coach, no habit yet: the three habits that split your wins from losses most, as the Overview's
     split bars with a Pick button; every habit folds below. */
  function habitPicks(c) {
    const rows = c.focusCatalog().filter(x => x.eligible).slice(0, 3);
    if (!rows.length) return '<p class="muted small">Counting once match details for your recent games have loaded…</p>';
    return `<ul class="splits picks">${splitHead(c, rows[0].n)}
      ${rows.map(x => `<li>${splitLab(c, x)}${splitBar(c, x)}<button type="button" class="btn sm" data-pick="${x.id}">Pick</button></li>`).join('')}</ul>`;
  }
  /* Every habit with your pass rate and win-rate split, folded. */
  function habitPicker(c, title) {
    const E = c.E, rows = c.focusCatalog().filter(x => x.n);
    if (!rows.length) return '';
    return `<details class="fold"><summary>${title} (${rows.length}) ${src('rule', `Every game gets a ✓ or ✗. After ${E.FOCUS_MIN_GAMES} games Climb says whether your pass rate really moved, and a habit is mastered at ${E.FOCUS_GRAD[0]} of your last ${E.FOCUS_GRAD[1]}. Only habits that split your wins from your losses can be picked. From your last ${rows[0].n} games with match detail.`)}</summary>
      <div class="table-wrap"><table class="tbl habits"><thead><tr><th>Habit</th><th class="n">Happens</th><th class="n">Won with it</th><th class="n">Won without</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.eligible ? '' : 'dim'}"><td>${c.esc(x.label)}${x.outcome ? ' <span class="tag" title="Partly follows the result: losing games also causes this">follows result</span>' : ''}</td>
        <td class="n">${pc0(x.passRate)}</td><td class="n pos">${pc0(x.wrPass)}</td><td class="n muted">${pc0(x.wrFail)}</td>
        <td class="n">${x.eligible ? `<button type="button" class="btn ghost-btn sm" data-pick="${x.id}">Pick</button>` : '<span class="muted small" title="Made no clear difference to your win rate">no difference</span>'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function focusHistory(c) {
    const E = c.E, H = c.state.focus.history;
    if (!H.length) return '';
    const OUT = { graduated: 'Mastered', dropped: 'Dropped', switched: 'Switched' };
    return `<section class="ov-sec">${sh('Past habits')}<ul class="fc-hist">${H.map(x => `<li>
      <span>${c.esc((E.habitById(x.habit) || { label: x.habit }).label)}</span>
      <b>${pc0(x.baseline)} <span class="muted">→</span> ${pc0(x.rate)}</b><span class="muted small">${x.n} games</span>
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

  /* A wins-vs-losses figure: the number in your wins beside the number in your losses. better:
     'lower' | 'higher' decides which side is coloured good. (Coach, Heroes.) */
  function wlFig(label, x, fmt, better, sub, info) {
    const gap = x.win != null && x.loss != null ? x.win - x.loss : null;
    const cls = side => gap == null || gap === 0 ? '' : ((side === 'win') === ((better === 'lower') === (gap < 0))) ? 'pos' : 'muted';
    return `<div class="fig wlf"><div class="wl-pair"><span><b class="fig-v ${cls('win')}">${fmt(x.win)}</b><span class="t-sub">in wins</span></span>
      <span class="wl-vs muted">vs</span><span><b class="fig-v ${cls('loss')}">${fmt(x.loss)}</b><span class="t-sub">in losses</span></span></div>
      <div class="t-label">${label}${info ? ' ' + info : ''}</div><div class="t-sub">${better === 'lower' ? '↓ lower is better' : '↑ higher is better'}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
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
    const wl = wlFig;
    const busy = st.analyzing;
    const mast = `<div class="masthead"><div class="ident"><div><div class="rank-name">Coach</div>
      <div class="muted small num-line"><span>Last ${games.length} games</span>${A.n ? `<span>${A.wins}–${A.losses}</span>` : ''}<span>${have} with detail</span></div></div></div></div>`;
    if (!A.n) {
      host.innerHTML = mast + `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading match details… ${have}/${games.length}</p>`;
      return;
    }
    const econ12 = A.economy.find(e => e.t === 720), econ20 = A.economy.find(e => e.t === 1200);
    const maxPhase = Math.max(0.1, ...A.deaths.byPhase.flatMap(p => [p.win || 0, p.loss || 0]));
    const bar = (v, cls) => `<span class="pbar"><span class="${cls}" style="width:${v == null ? 0 : Math.round(100 * v / maxPhase)}%"></span></span>`;
    const pickBtn = `<button type="button" class="btn ghost-btn sm" data-focus="coach"${busy ? ' disabled' : ''}>${st.coach.key ? 'Let the coach pick' : 'Pick for me'}</button>`;
    const active = !!st.focus.active;

    host.innerHTML = mast + `
      <section class="ov-sec coach-train">
        ${sh(active ? 'Training' : 'Training · pick one habit', active ? '' : pickBtn)}
        ${busy ? `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(busy)}</p>` : ''}
        ${st.focusError ? `<p class="neg small">${c.esc(st.focusError)}</p>` : ''}
        ${active ? focusCard(c, true) : habitPicks(c)}
        ${habitPicker(c, active ? 'Switch habit' : 'All habits')}
      </section>

      <section class="ov-sec">
        ${sh('Your wins vs your losses')}
        <div class="ledger l3">
          ${wl('Deaths a game', A.deaths.perGame, one, 'lower')}
          ${wl('Deaths before 10:00', A.deaths.before10, one, 'lower')}
          ${wl('Souls vs lane · 12:00', econ12 ? econ12.diff : {}, sgn, 'higher', econ12 && econ12.aheadRate.all != null ? `ahead in ${c.pct(econ12.aheadRate.all)}` : '')}
          ${wl('Souls vs lane · 20:00', econ20 ? econ20.diff : {}, sgn, 'higher', econ20 && econ20.aheadRate.all != null ? `ahead in ${c.pct(econ20.aheadRate.all)}` : '')}
          ${wl('Souls vs lane · 20–30 min', A.lateSwing, sgn, 'higher', A.lateSwing.n ? `${A.lateSwing.n} games` : '', src('yours', 'Souls you gained between 20:00 and 30:00 minus your lane opponents’, in games that reached 30:00.'))}
          ${wl('First tier-4 item', A.items.tier4, mmss, 'lower', `tier-3 at ${mmss(A.items.tier3.all)}`)}
        </div>
      </section>

      <section class="ov-sec">
        ${sh('Farm · at ' + clk(E.FARM_T) + ' vs your lane')}
        ${farmProfileCard(c)}
      </section>

      <section class="ov-sec">
        ${sh('Deaths')}
        <div class="num-line deaths-line"><span><b>${A.deaths.total}</b> deaths</span><span>${A.n} games</span>${A.deaths.fastShare != null ? `<span><b>${c.pct(A.deaths.fastShare)}</b> caught out (≤${E.FAST_DEATH_S}s) ${src('yours', `Deaths that came within ${E.FAST_DEATH_S}s of first taking damage: no time to react or be saved.`)}</span>` : ''}</div>
        <div class="death-grid">
          <div><div class="t-label">A game, by phase · <span class="pos">wins</span> / <span class="neg">losses</span></div>
            <div class="phases">${A.deaths.byPhase.map(p => `<div class="ph"><span class="ph-l">${p.label}</span>
            <span class="ph-bars">${bar(p.win, 'w')}${bar(p.loss, 'l')}</span><span class="ph-v"><span class="pos">${one(p.win)}</span> / <span class="neg">${one(p.loss)}</span></span></div>`).join('')}</div></div>
          <div><div class="t-label">Where ${src('yours', 'Coarse zones, from your side of the map.')}</div><ol class="plain">${A.deaths.zones.map(z => `<li><span>${c.esc(z.zone)}</span><b>${c.pct(z.share)}</b></li>`).join('')}</ol></div>
          <div><div class="t-label">Killed most by</div><ol class="plain">${A.deaths.killers.map(k => `<li><span>${icon(c, k.hero, 20)}${c.esc(k.name)}</span><b>${k.n}</b></li>`).join('')}</ol></div>
        </div>
      </section>

      ${aiCard(c, A)}
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
    const info = src('yours', 'Steam’s own friends list isn’t reachable from a website (Steam’s API refuses browser requests, and deadlock-api doesn’t store it), so Climb finds friends from deadlock-api’s teammate history instead: anyone you’ve been on a team with 10+ times. Random teammates almost never repeat that often.');
    const mast = `<div class="masthead"><div class="ident"><div><div class="rank-name">Friends</div>
      <div class="muted small num-line"><span>${list.length} friends ${info}</span>${list.length ? `<span>${c.fmtInt(list.reduce((s0, f) => s0 + f.games, 0))} games together</span><span>100% = lobby average</span>` : ''}</div></div></div></div>`;
    if (!st.friends) { host.innerHTML = mast + '<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Finding the people you queue with…</p>'; return; }
    if (!list.length) { host.innerHTML = mast + `<p class="muted small">0 people with ${E.FRIEND_MIN}+ games together</p>`; return; }
    c.ensureSquad();
    const me = st.settings.account;
    const board = E.stackBoard(c.M.all, st.lobbies, me, list);
    // Death cost (the old ranking) stays as a column, from the last 90 days of match detail.
    const cost = new Map(E.friendBoard(c.squadRows(), me, list).map(p => [p.acct, p.cost]));
    const best = {};
    for (const k of STACK_COLS.map(x => x[0])) best[k] = Math.max(...board.map(p => p.stat[k]));
    host.innerHTML = mast + `
      <section class="ov-sec">
        ${sh('How you stack up', src('yours', `You and each friend in the games you played together on the same team (${E.STACK_MIN}+ games), from the lobby stats Climb keeps for every game. Each stat is against the lobby’s average player in that game, so 100% is average: souls; damage or healing, whichever is higher, so supports aren’t sunk; kills + assists; and staying alive (fewer deaths than the lobby is over 100%). Overall combines the four and is pulled toward 100 by ${E.STACK_K} games, so a small sample can’t top the board. “Ahead of you / behind you” needs a 5%+ gap in your shared games that holds in both halves; otherwise it’s even. Lost to deaths is the old ranking: win chance lost to their own deaths per game, last 90 days, lower is better.`))}
        ${board.length ? `<div class="stk stk-head"><span></span><span></span><span></span><span></span>${STACK_COLS.map(x => `<span class="n">${x[1]}</span>`).join('')}<span class="n hide-s">Lost to deaths</span><span class="n">Overall</span></div>
          <div class="stk-key small muted">${STACK_COLS.map(x => `<span>${x[1]}</span>`).join('')}<span>Overall</span></div>
          <ol class="board3">${board.map((p, i) => stackRow(c, p, i, list, best, cost)).join('')}</ol>`
          : `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading your games with friends…</p>`}
      </section>`;
  }

  // ---------------------------------------------------------------- squads
  const ptsLost = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const nameIn = (c, list, acct) => acct === c.state.settings.account ? ((c.state.profile && c.state.profile.name) || 'You')
    : ((list.find(f => f.acct === acct) || {}).name || 'Player ' + acct);
  // From the friend's side of the board: ahead of you, behind you, or too close to call.
  const CALL = { you: ['▼ behind you', 'muted'], them: ['▲ ahead of you', 'muted'], close: ['≈ even', 'muted'], self: ['you', 'brass'] };
  const STACK_COLS = [['souls', 'Souls'], ['out', 'Dmg / heal'], ['ka', 'K + A'], ['alive', 'Alive']];
  const stackPct = v => v == null ? '—' : Math.round(v * 100) + '%';
  const stackIdx = v => `<span class="${v >= 1.05 ? 'pos' : v <= 0.95 ? 'neg' : ''}">${Math.round(v * 100)}</span>`;
  function stackRow(c, p, i, list, best, cost) {
    const f = list.find(x => x.acct === p.acct) || {}, ca = CALL[p.call] || ['', ''];
    const av = p.self ? (c.state.profile && c.state.profile.avatar) : f.avatar;
    const inner = `<span class="b-rank">${i + 1}</span>${av ? `<img src="${c.esc(av)}" alt="" width="32" height="32">` : '<span class="av-ph"></span>'}
      <span class="fr-main"><b>${c.esc(nameIn(c, list, p.acct))}</b><span class="muted small">${p.n} games · <span class="${ca[1]}">${ca[0]}</span></span></span>
      <span class="stk-heroes">${p.heroes.map(h => icon(c, h, 20)).join('')}</span>
      ${STACK_COLS.map(([k], j) => `<span class="n stk-v s${j + 1}${p.stat[k] >= best[k] - 1e-9 ? ' best' : ''}">${stackPct(p.stat[k])}</span>`).join('')}
      <span class="n stk-v hide-s muted">${cost.has(p.acct) ? ptsLost(cost.get(p.acct)) : '—'}</span>
      <span class="n stk-o">${stackIdx(p.index)}</span>`;
    return `<li class="${p.self ? 'me' : ''}">${p.self ? `<div class="b-row stk">${inner}</div>` : `<a class="b-row stk" href="#/friend/${p.acct}">${inner}</a>`}</li>`;
  }

  /* You vs one friend: early-game habits + win chance lost, the catch-up plan, and "Coach us". */
  function scoreCard(c, sc, f) {
    const st = c.state, me = c.esc((st.profile && st.profile.name) || 'You'), them = c.esc(f.name || 'Your friend');
    const info = src('model', `Your last ${c.E.SQUAD_DAYS} days of shared games. Only habits measured before the game is decided are used (tested on 266 games: caught-out deaths after 15:00 mostly reflect a game already being lost). Win chance lost to deaths is priced by the trained win model, a typical cost per death, and only called when the gap holds in both halves of your games.`);
    if (!sc.n) return `<section class="ov-sec">${sh('Early game &amp; deaths · last ' + c.E.SQUAD_DAYS + ' days', info)}<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading your games together…</p></section>`;
    const val = (x, v) => v == null ? '—' : x.lowerBetter ? ptsLost(v) : c.pct(v);
    // The better side of each row is green (Engine.scorecard's call); the other stays plain.
    const rowsHtml = sc.metrics
      .map(x => `<div class="duel-row"><span class="duel-k">${c.esc(x.label)}${x.lowerBetter ? ' <span class="muted small">↓ better</span>' : ''}</span>
        <b class="${x.better === 'me' ? 'pos' : ''}">${val(x, x.me)}</b><b class="${x.better === 'them' ? 'pos' : ''}">${val(x, x.them)}</b></div>`).join('');
    const trail = sc.trailing === 'me' ? me : sc.trailing === 'them' ? them : null;
    const leader = sc.trailing === 'me' ? them : me;
    const plan = sc.plan.length ? `<section class="ov-sec">${sh(`How ${trail} catches up`)}<ol class="catch">${sc.plan.map(p => `<li>
        <span class="duel-k">${c.esc(p.label)}</span><b>${c.pct(p.from)} <span class="muted">→</span> <span class="brass">${c.pct(p.to)}</span></b>
        <span class="muted small">${leader}’s rate${p.wrPass != null && p.wrFail != null && p.nPass >= 5 && p.nFail >= 5 ? ` · together you won ${c.pct(p.wrPass)} with it, ${c.pct(p.wrFail)} without` : ''}</span>
        <details class="fold"><summary>How</summary><p class="small">${c.esc(p.how)}</p></details></li>`).join('')}</ol></section>` : '';
    return `<section class="ov-sec">${sh('Early game &amp; deaths · last ' + c.E.SQUAD_DAYS + ' days', info)}
      <div class="duel"><div class="duel-row duel-head"><span></span><span>${me}</span><span>${them}</span></div>${rowsHtml}</div>
      ${sc.vs.call === 'few' ? `<p class="muted small">${sc.n}/${c.E.BOARD_MIN} shared games with full data to call it</p>` : ''}</section>${plan}`;
  }
  function duoCoachCard(c, f) {
    const st = c.state, d = st.duoCoach[f.acct], busy = st.coaching['duo' + f.acct];
    const info = src('ai', 'Gemini reads only the scorecard above (rates, win chance lost, gaps and win-rate splits) and writes the plan. The numbers are Climb’s; the wording is Gemini’s.');
    const wrap = (more, body) => `<section class="ov-sec coach-notes">${sh('Coach us · Gemini', more)}${body}</section>`;
    if (!st.coach.key) return wrap('', `<p class="muted small">Add a Gemini key in <a class="more" href="#/about">Account & about</a> ${info}</p>`);
    if (busy) return wrap('', `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(busy)}</p>`);
    if (!d || (!d.data && !d.error)) return wrap('', `<button type="button" class="btn" data-duo="go">Coach us</button> ${info}`);
    if (d.error) return wrap(`<button type="button" class="btn ghost-btn sm" data-duo="go">Try again</button>`, `<p class="neg small">${c.esc(d.error)}</p>`);
    return wrap(`<button type="button" class="btn ghost-btn sm" data-duo="go">↻ Redo</button>`, `
      <p class="coach-sum">${c.esc(d.data.verdict)} ${info}</p>
      <details class="fold"><summary>Catch-up plan · together</summary><ul class="fc-how">${d.data.catch_up.map(x => `<li>${c.esc(x)}</li>`).join('')}</ul>
        <p class="small">${c.esc(d.data.together)}</p></details>
      <div class="muted small num-line"><span>${c.esc(d.model || '')}</span><span>${c.ago(d.at / 1000)}</span></div>`);
  }

  function friend(host, c) {
    const E = c.E, st = c.state, acct = st.route.id;
    c.ensureFriends();
    const f = c.friendList().find(x => x.acct === acct);
    if (!f) { host.innerHTML = '<div class="empty-state">' + (st.friends ? 'Not one of your friends here. <a href="#/friends">Back to friends</a>' : 'Loading…') + '</div>'; return; }
    const shared = c.M.all.filter(m => f.ids.includes(m.id)).slice(-10);
    c.ensureSquad();
    const sc = E.scorecard(c.squadRows(), st.settings.account, acct);
    const name = c.esc(f.name || 'Player ' + acct);
    const stk = E.stackBoard(c.M.all, st.lobbies, st.settings.account, [f]).find(p => p.acct === acct);
    const meName = c.esc((st.profile && st.profile.name) || 'You');
    const duel = (label, a, b, fmt) => `<div class="duel-row"><span class="duel-k">${label}</span><b class="${a > b + 0.02 ? 'pos' : ''}">${fmt(a)}</b><b class="${b > a + 0.02 ? 'pos' : ''}">${fmt(b)}</b></div>`;
    const stackHtml = !stk ? '' : `<section class="ov-sec">${sh('How you stack up · ' + stk.n + ' games together', src('yours', `The same games, same team, against each lobby’s average player (100%). Damage / heal is whichever is higher. Overall combines the four, pulled toward 100 by ${E.STACK_K} games.`))}
      <div class="duel"><div class="duel-row duel-head"><span></span><span>${meName}</span><span>${name}</span></div>
        ${duel('Overall', stk.you.index, stk.index, v => Math.round(v * 100))}
        ${STACK_COLS.map(([k, l]) => duel(l, stk.you.stat[k], stk.stat[k], stackPct)).join('')}</div></section>`;
    const fig = (label, value, sub) => `<div class="fig"><div class="fig-v">${value}</div><div class="t-label">${label}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    const gap = f.wrTogether != null && f.wrApart != null ? f.wrTogether - f.wrApart : null;
    host.innerHTML = `<a href="#/friends" class="back">← Friends</a>
      <div class="masthead"><div class="ident">${f.avatar ? `<img class="fr-av" src="${c.esc(f.avatar)}" alt="" width="56" height="56">` : ''}
        <div><div class="rank-name">${name}</div><div class="muted small num-line"><span>${f.badge ? c.esc(E.badgeName(f.badge, c.tiers())) : 'Unranked'}</span><span>${c.fmtInt(f.games)} games together</span>${f.last ? `<span>last ${c.ago(f.last)}</span>` : ''}</div></div></div></div>
      <div class="ledger l3">
        ${fig('Win rate together', `<span class="${gap == null || Math.abs(gap) < 0.03 ? '' : gap > 0 ? 'pos' : 'neg'}">${c.pct(f.wrTogether)}</span>`, `${f.seen} of your games`)}
        ${fig(`You without ${name}`, c.pct(f.wrApart), 'your other games')}
        ${fig('Shared, last ' + E.SQUAD_DAYS + ' days', sc.n ? `${sc.wins}–${sc.n - sc.wins}` : '—', `${sc.n} games`)}
      </div>
      ${stackHtml}
      ${scoreCard(c, sc, f)}
      ${sc.n ? duoCoachCard(c, f) : ''}
      <section class="ov-sec mlist">${sh('Recent games together')}
        ${shared.length ? matchHead(c) + shared.slice().reverse().map(m => matchRow(c, m, '', 'ago')).join('') : '<p class="muted small">0 shared games in your loaded history</p>'}
      </section>`;
    host.querySelectorAll('[data-duo]').forEach(b => b.addEventListener('click', () => c.runDuoCoach(acct)));
  }

  /* Coach's notes: Gemini's read, the one part of Coach that is sentences. The headline shows; each
     pattern and the plan fold open. */
  function aiCard(c, A) {
    const st = c.state, a = st.analysis;
    const info = src('ai', 'Gemini reads only the counted numbers on this tab (your last 30 games, wins vs losses) plus your gaps vs the next rank, and writes the patterns and plan. The numbers are Climb’s; the wording and advice are Gemini’s.');
    const wrap = (more, body) => `<section class="ov-sec coach-notes">${sh('Coach’s notes · Gemini', more)}${body}</section>`;
    if (!st.coach.key) return wrap('', `<p class="muted small">Add a Gemini key in <a class="more" href="#/about">Account & about</a> ${info}</p>`);
    if (st.analyzing) return wrap('', `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>${c.esc(st.analyzing)}</p>`);
    const lastId = c.M.all.length ? c.M.all[c.M.all.length - 1].id : null;
    const stale = a && a.data && a.lastId !== lastId;
    if (!a || !a.data) return wrap('', `<button type="button" class="btn" data-analyze="go">Analyze my last ${A.n} games</button> ${info}${a && a.error ? `<p class="neg small">${c.esc(a.error)}</p>` : ''}`);
    const x = a.data;
    return wrap(`<button type="button" class="btn ${stale ? '' : 'ghost-btn'} sm" data-analyze="again">${stale ? 'Update with new games' : '↻ Redo'}</button>`, `
      <p class="coach-sum">${c.esc(x.headline)} ${info}</p>
      <ol class="coach-pts">${(x.patterns || []).map((p, i) => `<li><details class="fold"><summary><b>${i + 1}.</b> ${c.esc(p.title)}</summary>
        <div class="cp-ev muted">${c.esc(p.evidence)}</div>
        <div class="cp-fix muted">${c.esc(p.why_it_costs_games)}</div>
        <div class="cp-fix"><b>Practice:</b> ${c.esc(p.practice)}</div></details></li>`).join('')}
        <li><details class="fold"><summary>Keep doing · next sessions</summary>
          <ul class="plain-ul">${(x.strengths || []).map(s => `<li><b class="pos">${c.esc(s.title)}</b> <span class="muted small">${c.esc(s.evidence)}</span></li>`).join('')}</ul>
          <ol class="plan">${(x.next_sessions_plan || []).map(s => `<li>${c.esc(s)}</li>`).join('')}</ol></details></li></ol>
      ${a.error ? `<p class="neg small">Last update failed: ${c.esc(a.error)}</p>` : ''}
      <div class="muted small num-line"><span>${c.esc(a.model)}</span><span>${a.n} games</span><span>${c.ago(a.at / 1000)}</span>${stale ? '<span>out of date</span>' : ''}</div>`);
  }

  // ---------------------------------------------------------------- matches list
  /* One game as a row of numbers (Matches tab, friend page): W/L, K/D/A, souls, damage, Form, points.
     when: 'clock' (time of day, under a day header) or 'ago'. */
  /* The rank you played at, as a small badge (Engine.matchRanks). Unranked games show your rank at the time, dimmer. */
  function rankMark(c, m, size) {
    const r = c.M.ranks && c.M.ranks.get(m.id);
    if (!r || !r.kind) return '';
    if (r.kind === 'placement') return '<span class="mr-plc" title="A placement game: no rank yet">Placement</span>';
    const nm = c.esc(c.E.badgeName(r.badge, c.tiers()));
    const t = r.kind === 'ranked' ? nm + ': your rank in this game' : nm + ': your rank at the time (unranked game)';
    return `<img class="mr-rank${r.kind === 'before' ? ' then' : ''}" src="${c.A.rankImage(r.badge)}" alt="${nm}" title="${t}" width="${size}" height="${size}" loading="lazy">`;
  }
  /* A player's rank in a match (Engine.playerRankAt): their rank in that game, or dimmer when it's only their rank now. */
  function playerRank(c, rk) {
    if (!rk) return '<span class="sb-rank none" title="No rank: unranked or in placement games"></span>';
    const nm = c.esc(c.E.badgeName(rk.badge, c.tiers()));
    return `<img class="sb-rank${rk.exact ? '' : ' then'}" src="${c.A.rankImage(rk.badge)}" alt="${nm}" title="${nm}: ${rk.exact ? 'their rank in this game' : 'their rank now (they’ve played ranked since)'}" width="18" height="18" loading="lazy">`;
  }
  /* Under a player's hero: games and win rate on it (all modes, all time), then tags (Engine.heroTags). */
  function heroLine(c, rec, badge) {
    const t = c.E.heroTags(rec);
    const tags = t.tags.map(x => `<span class="ptag ptag-${x.id}">${c.esc(x.label)}</span>`).join('');
    return `<span class="sb-sub">${badge || ''}${rec ? `<span>${c.fmtInt(rec.n)} games · ${c.pct(rec.wins / rec.n)}</span>` : ''}${tags}</span>`;
  }
  function matchRow(c, m, mark, when) {
    const L = c.state.lobbies[m.id], g = c.E.gameRole(L, m.won), me = L && L.p[L.me], p = c.M.perf.get(m.id);
    const form = !p ? '<span class="muted">—</span>' : `<span class="${p.score >= 0.2 ? 'pos' : p.score <= -0.2 ? 'neg' : 'muted'}">${form1(p.score)}</span>`;
    const t = when === 'clock' ? new Date(m.t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : c.ago(m.t);
    return `<a class="mr2 ${m.won ? 'w' : 'l'}${g && g.lobbyFirst ? ' gold' : ''}" href="#/match/${m.id}">
      <span class="mh">${icon(c, m.hero, 30)}<span><b>${c.esc(c.heroName(m.hero))}</b><span class="muted small mr-sub">${rankMark(c, m, 18)}${m.mode === 'ranked' ? 'Ranked' : 'Unranked'} · ${mins(m.dur)}</span></span></span>
      <span class="mr-marks">${mark || ''}${firstChip(g)}</span>
      <span class="mr-res ${m.won ? 'win' : 'loss'}">${m.won ? 'W' : 'L'}</span>
      <span class="n mr-kda">${kda(m)}</span>
      <span class="n hide-s">${c.kfmt(m.souls)}</span>
      <span class="n hide-s">${me ? c.kfmt(me[5]) : '—'}</span>
      <span class="n mr-form">${form}</span>
      <span class="n mr-pts">${deltaHtml(c, m)}</span>
      <span class="n muted small hide-s">${t}</span></a>`;
  }
  const FORM_INFO = 'How you played vs your usual on that hero: souls, farm by 12:00 vs your lane, damage, kills + assists and staying alive, against your other games on it. 0 is a normal game for you; +1.0 is a clearly better game than usual (about one standard deviation), −1.0 a clearly worse one. Needs 5+ games on the hero.';
  const matchHead = c => `<div class="mr2 mhead"><span>Hero</span><span></span><span></span><span class="n">K / D / A</span><span class="n hide-s">Souls</span><span class="n hide-s">Damage</span><span class="n">Form ${src('yours', FORM_INFO)}</span><span class="n">Rank pts</span><span class="n hide-s">Time</span></div>`;

  const matchFilter = { hero: 'all', result: 'all', role: 'all', mode: 'all' };
  let matchLimit = 60;   // games listed; "Show more" adds 60. Module state so a redraw keeps it
  function matches(host, c) {
    const M = c.M, E = c.E;
    const heroes = [...new Set(M.all.map(m => m.hero))].sort((a, b) => c.heroName(a).localeCompare(c.heroName(b)));
    const rows = M.all.slice().reverse().map(m => ({ m, g: E.gameRole(c.state.lobbies[m.id], m.won), L: c.state.lobbies[m.id] }))
      .filter(({ m, g }) => (matchFilter.hero === 'all' || m.hero === Number(matchFilter.hero))
        && (matchFilter.result === 'all' || (matchFilter.result === 'win') === m.won)
        && (matchFilter.mode === 'all' || m.mode === matchFilter.mode)
        && (matchFilter.role === 'all' || (g && (matchFilter.role === 'first' ? g.lobbyFirst
          : matchFilter.role === 'above' ? (c.M.perf.get(m.id) || { score: 0 }).score >= FORM_GAME : (c.M.perf.get(m.id) || { score: 0 }).score <= -FORM_GAME))));
    const shown = rows.slice(0, matchLimit);
    const fp = c.state.focus.active ? c.focusNow() : null;
    const fpass = new Map(fp ? fp.results.map(r => [r.m.id, r.pass]) : []);
    const fh = fp ? c.E.habitById(c.state.focus.active.habit) : null;
    const fmark = id => fpass.has(id) ? `<span class="dot ${fpass.get(id) ? 'y' : 'n'}" title="${c.esc(fh.label)}: ${fpass.get(id) ? 'passed' : 'missed'}">${fpass.get(id) ? '✓' : '✗'}</span>` : '';
    const opt = (v, l, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${c.esc(l)}</option>`;
    // Numbers first: totals for what the filters show, then the games by day, each day with its record.
    const T = E.matchTotals(rows.map(r => r.m)), days = E.matchDays(shown.map(r => r.m));
    const byId = new Map(shown.map(r => [r.m.id, r]));
    const fig = (label, value, sub, cls) => `<div class="fig${cls ? ' ' + cls : ''}"><div class="fig-v">${value}</div><div class="t-label">${label}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    const one = v => v == null ? '—' : v.toFixed(1);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayName = t => { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); const ago = Math.round((today - d) / 864e5);
      return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };
    const row = ({ m }) => matchRow(c, m, fmark(m.id), 'clock');
    host.innerHTML = `
      <div class="masthead"><div class="ident"><div><div class="rank-name">Matches</div>
        <div class="muted small num-line"><span>${rows.length === M.all.length ? `${M.all.length} games` : `${rows.length} of ${M.all.length} games`}</span></div></div></div>
        <div class="ctl-row">
          ${seg('Result', [['all', 'All'], ['win', 'Wins'], ['loss', 'Losses']], matchFilter.result).replace('class="seg-ctl"', 'class="seg-ctl" id="f-result"')}
          ${seg('Mode', [['all', 'All modes'], ['ranked', 'Ranked'], ['unranked', 'Unranked']], matchFilter.mode).replace('class="seg-ctl"', 'class="seg-ctl" id="f-mode"')}
          <div class="filters">
            <select id="f-hero" aria-label="Hero">${opt('all', 'All heroes', matchFilter.hero)}${heroes.map(h => opt(h, c.heroName(h), matchFilter.hero)).join('')}</select>
            <select id="f-role" aria-label="How you played">${opt('all', 'Any form', matchFilter.role)}${opt('first', '★ MVP', matchFilter.role)}${opt('above', 'Above your usual', matchFilter.role)}${opt('below', 'Below your usual', matchFilter.role)}</select>
          </div></div></div>

      <div class="ledger">
        ${fig('Win rate', T.n ? c.pct(T.winRate) : '—', `${T.wins}–${T.losses}`)}
        ${fig('K / D / A a game', T.n ? `${one(T.k)}<span class="sl">/</span>${one(T.d)}<span class="sl">/</span>${one(T.a)}` : '—', `${T.n} games`, 'kda-fig')}
        ${fig('Souls a game', T.n ? c.kfmt(T.souls) : '—')}
        ${fig('Rank points', T.ranked ? c.signed(T.net) : '—', `${T.ranked} ranked`)}
      </div>

      <details class="fold add-fold"${addState.msg || addState.busy ? ' open' : ''}><summary>Missing a game? ${src('rule', 'Climb lists what Valve’s match history returns, and that sometimes leaves a game out. If deadlock-api has the game (open it in Deadlock’s match history while the ingest tool runs), paste its match id here and Climb adds it.')}</summary>
        <div class="add-bar">${addMatchForm(c)}<a class="more small add-faster" href="ingest.html">Make new games show up faster →</a></div></details>

      <section class="ov-sec mlist">
        ${matchHead(c)}
        ${days.length ? days.map(dg => `<div class="mday"><span class="mday-k">${dayName(dg.t)}</span><span class="num-line"><span>${dg.tot.wins}–${dg.tot.losses}</span>${dg.tot.ranked ? `<span class="${dg.tot.net > 0 ? 'pos' : dg.tot.net < 0 ? 'neg' : ''}">${c.signed(dg.tot.net)} pts</span>` : ''}</span></div>
          ${dg.games.map(m => row(byId.get(m.id))).join('')}`).join('') : '<p class="empty-state">No matches with these filters.</p>'}
        ${rows.length > shown.length ? `<div class="more-row"><button type="button" class="btn ghost-btn sm" id="m-more">Show ${Math.min(60, rows.length - shown.length)} more</button><span class="muted small">${shown.length} of ${rows.length}</span></div>` : ''}
      </section>`;
    ['hero', 'role'].forEach(k => host.querySelector('#f-' + k).addEventListener('change', e => { matchFilter[k] = e.target.value; matches(host, c); }));
    bindSeg(host, '#f-result', v => { matchFilter.result = v; matches(host, c); });
    bindSeg(host, '#f-mode', v => { matchFilter.mode = v; matches(host, c); });
    const more = host.querySelector('#m-more');
    if (more) more.addEventListener('click', () => { matchLimit += 60; const y = scrollY; matches(host, c); scrollTo(0, y); });
    bindAddMatch(host, c);
  }

  // ---------------------------------------------------------------- match detail
  function match(host, c) {
    const M = c.M, E = c.E, id = c.state.route.id;
    const m = M.all.find(x => x.id === id);
    if (!m) { host.innerHTML = '<div class="empty-state">That match isn’t in your history. <a href="#/matches">Back to matches</a></div>'; return; }
    const L = c.state.lobbies[m.id];
    const g = E.gameRole(L, m.won);
    const mp = c.state.matchPlayers[m.id];
    const rankOf = acct => mp && mp.p[acct] ? mp.p[acct].rank : null;
    const lobbyAvg = L && L.avgBadge ? L.avgBadge : mp ? E.avgBadge(Object.values(mp.p).map(x => x.rank && x.rank.badge)) : null;
    const p = M.perf.get(m.id);
    const head = `
      <a href="#/matches" class="back">← Matches</a>
      <div class="page-head match-head">
        <div class="ident">${icon(c, m.hero, 56)}
          <div><div class="rank-name">${c.esc(c.heroName(m.hero))} <span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Win' : 'Loss'}</span></div>
          <div class="muted">${new Date(m.t * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${mins(m.dur)} · ${m.mode === 'ranked' ? 'Ranked' : 'Unranked'}${(() => { const r = M.ranks.get(m.id); return !r || !r.kind ? '' : r.kind === 'placement' ? ' · placement game' : ' · you ' + (r.kind === 'before' ? 'were ' : 'played at ') + c.esc(E.badgeName(r.badge, c.tiers())); })()}${lobbyAvg ? ` · lobby avg <b class="ink">${c.esc(E.badgeName(lobbyAvg, c.tiers()))}</b>` : ''} · #${m.id}${m.added ? ' · added by id' : ''}</div></div>
        </div>
        <div class="big-delta">${m.delta == null ? '' : `${deltaHtml(c, m)}<span class="muted small">rank pts</span>`}</div>
      </div>`;
    if (!L || L.v !== E.LOBBY_V) {
      host.innerHTML = head + `<section class="card"><p class="muted">${L === null ? 'deadlock-api has no lobby data for this match.' : 'Lobby data is still loading…'}</p></section>`;
      return;
    }
    const imp = E.lobbyImpact(L);
    const zs = p ? ['souls', 'farm', 'dmg', 'ka', 'deaths'].filter(k => p.z[k] != null).map(k => {
      const lab = { souls: 'Souls', farm: 'Farm by 12:00', dmg: 'Damage', ka: 'Kills + assists', deaths: 'Staying alive' }[k];
      return `<li><span>${lab}</span><span class="${p.z[k] >= 0.2 ? 'pos' : p.z[k] <= -0.2 ? 'neg' : 'muted'}">${form1(p.z[k])}</span></li>`;
    }).join('') : '';
    const share = (k, lab, inv) => {
      const v = g.r[k], good = inv ? v <= 1 : v >= 1;
      return `<div class="share"><span class="muted small">${lab}</span><b class="${Math.abs(v - 1) < 0.1 ? '' : good ? 'pos' : 'neg'}">${Math.round(v * 100)}%</b></div>`;
    };
    const team = t => {
      const idx = L.p.map((x, i) => i).filter(i => L.p[i][0] === t).sort((a, b) => L.p[b][1] - L.p[a][1]);
      const won = L.win == null ? null : L.win === t;
      const tAvg = mp ? E.avgBadge(idx.map(i => { const rk = rankOf(L.p[i][15]); return rk && rk.badge; })) : null;
      return `<div class="team"><div class="team-h"><b>${t === L.p[L.me][0] ? 'Your team' : 'Enemy team'}${tAvg ? ` <span class="muted small">avg ${c.esc(E.badgeName(tAvg, c.tiers()))}</span>` : ''}</b>${won == null ? '' : `<span class="${won ? 'win' : 'loss'}">${won ? 'Won' : 'Lost'}</span>`}</div>
        <div class="sb sb-h"><span>Hero</span><span class="n">K/D/A</span><span class="n">Souls</span><span class="n">Damage</span><span class="n hide-s">Heal</span><span class="n hide-s">Obj</span><span class="hide-s">Impact</span></div>
        ${idx.map(i => {
          const r = L.p[i], you = i === L.me;
          return `<div class="sb${you ? ' you' : ''}"><span class="mh">${icon(c, r[7], 26)}<span><span class="sb-name"><b>${c.esc(c.heroName(r[7]))}</b>${you ? ' <span class="you-tag">You</span>' : ''}${r[12] === 1 ? ' <span class="first">★ MVP</span>' : r[12] >= 2 && r[12] <= 3 ? ` <span class="tag">MVP ${r[12]}</span>` : ''}</span>${mp && mp.p[r[15]] ? heroLine(c, mp.p[r[15]].rec, playerRank(c, rankOf(r[15]))) : ''}</span></span>
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
          <p class="muted">on your team · impact <b>${g.impact.toFixed(2)}</b> <span class="small">(1.00 = an average teammate)</span></p>
        </section>
        <section class="card">
          <div class="t-label">You vs an average teammate <span class="muted">(100% = average)</span></div>
          <div class="shares">${share('souls', 'Souls')}${share('dmg', 'Damage')}${share('ka', 'Kills + assists')}${share('obj', 'Objectives')}${share('deaths', 'Deaths', true)}</div>
          ${p ? `<div class="t-label" style="margin-top:14px">Form vs your usual ${c.esc(c.heroName(m.hero))} (${p.base} games) ${src('yours', FORM_INFO)}</div><ul class="zs">${zs}</ul>`
              : `<p class="muted small">Form vs your usual appears once you have ${E.MIN_HERO_GAMES}+ games on this hero.</p>`}
        </section>
      </div>
      ${wpCard(c, m)}
      ${farmMatchCard(c, m)}
      ${coachCard(c, m)}
      <section class="card flush scoreboard"><div class="sb-info small muted">Rank, games and win rate on the hero ${src('yours', `Each badge is the player’s rank in this game when deadlock-api can tell (this was their latest ranked game, or they haven’t played ranked since); a dimmer badge is their rank now. Under each hero: their games and win rate on it, all modes, all time. Tags: One-trick (60%+ of their games, 50+ games), Main (30%+, 30+ games), New on it (under 5 games), and Wins / Loses a lot on it, from a win rate pulled toward 50% by ${E.TAG_K} games so a short streak can’t earn it.`)}</div>${team(myTeam)}${team(1 - myTeam)}</section>`;
    if (window.WPMODEL && !c.matchWin(m.id)) c.ensureMatchDetail(m.id);
    c.ensureMatchPlayers(m.id);
    bindSeg(host, '#ft', v2 => { farmTab = v2; c.render(); });
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

  // ---------------------------------------------------------------- heroes
  let heroTab = 'road';   // 'road' | 'coach'; kept here because the page redraws as data loads
  const HERO_COACH_GAMES = 30;

  /* Heroes → Coach me: the habits that split YOUR wins from losses on this hero (the Overview's split
     bars, the suggested one first, with a button), then deaths in wins vs losses. Nothing here is AI. */
  function heroCoachPanel(c, hero, games, items) {
    const E = c.E, name = c.esc(c.heroName(hero));
    const recent = games.slice(-HERO_COACH_GAMES);
    const missing = recent.filter(m => !c.state.details[m.id] || c.state.details[m.id].v !== E.DETAIL_V);
    if (missing.length) c.ensureDetailsFor(missing.map(m => m.id));
    const hc = E.heroCoach(recent.map(c.entryOf), items, c.heroName);
    const loading = missing.length && c.state.detailsBusy ? `<p class="muted coach-busy"><span class="spin" aria-hidden="true"></span>Reading your ${name} games…</p>` : '';
    const info = src('yours', `Counted from your last ${HERO_COACH_GAMES} ${c.heroName(hero)} games that have match detail. Habits are the same checks as the Coach tab. A habit is only suggested when passing it split YOUR ${c.heroName(hero)} wins from losses by ${Math.round(E.FOCUS_MIN_LIFT * 100)}+ points with ${E.FOCUS_MIN_SIDE}+ games on each side. Under ${E.HERO_COACH_FIRM} games the sample is flagged thin. Nothing here is written by AI.`);
    const head = sh(`Coach me · ${name}`, `<span class="muted small">${hc.n} games read${hc.thin ? ' · thin' : ''}</span> ${info}`);
    if (!hc.ready) return `<section class="ov-sec">${head}<p class="muted small">${hc.n}/${E.HERO_COACH_MIN} games with match detail</p>${loading}</section>`;
    const f = hc.focus, active = c.state.focus.active && c.state.focus.active.habit;
    const isF = k => !!(f && k.id === f.id);
    const rows = hc.catalog.filter(k => k.n >= 5 && !k.outcome).sort((a, b) => (isF(b) - isF(a)) || (b.eligible - a.eligible) || ((b.lift || -1) - (a.lift || -1))).slice(0, 5);
    const btn = k => !k.eligible ? '<span class="muted small">no clear split</span>' : active === k.id ? '<span class="tag">your focus</span>'
      : `<button type="button" class="btn sm${isF(k) ? '' : ' ghost-btn'}" data-pick="${k.id}">${isF(k) ? '★ Pick' : 'Pick'}</button>`;
    const d = hc.agg.deaths, r1 = v => v == null ? '—' : v.toFixed(1);
    return `<section class="ov-sec">${head}${loading}
      ${rows.length ? `<ul class="splits picks">${splitHead(c, hc.n)}${rows.map(k => `<li${k.eligible ? '' : ' class="dim"'}>${splitLab(c, k)}${splitBar(c, k)}${btn(k)}</li>`).join('')}</ul>` : ''}
      </section>
      <section class="ov-sec">${sh(`Deaths on ${name}`)}
        <div class="ledger l3">
          ${wlFig('Deaths a game', d.perGame, r1, 'lower', `${r1(d.perGame.all)} overall`)}
          ${wlFig('Deaths before 10:00', d.before10, r1, 'lower', `${r1(d.before10.all)} overall`)}
          <div class="fig"><div class="fig-v">${d.fastShare == null ? '—' : c.pct(d.fastShare)}</div><div class="t-label">Caught out ${src('yours', `Deaths within ${E.FAST_DEATH_S}s of first taking damage.`)}</div><div class="t-sub">of deaths · ≤${E.FAST_DEATH_S}s</div></div>
        </div>
        ${d.killers.length ? `<div class="num-line killers"><span class="t-label">Killed most by</span>${d.killers.slice(0, 3).map(k => `<span>${icon(c, k.hero, 18)} ${c.esc(k.name)} <b>${k.n}</b></span>`).join('')}${d.zones.length ? `<span class="t-label">Where</span><span>${c.esc(d.zones[0].zone)} <b>${c.pct(d.zones[0].share)}</b></span>` : ''}</div>` : ''}
      </section>`;
  }
  /* Heroes topline (Engine.heroInsights): best hero, the one to park, and tidbits, as cards that open the hero. */
  function heroScout(c, ins) {
    const E = c.E;
    if (!ins.rows.length) return '';
    const wl = h => `${h.wins}–${h.losses}`;
    const card = (k, h, value, sub, cls) => !h ? '' : `<a class="ins ${cls || ''}" href="#/heroes/${h.hero}"><span class="t-label">${k}</span>
      <span class="ins-h">${icon(c, h.hero, 34)}<b>${c.esc(c.heroName(h.hero))}</b></span><span class="ins-v">${value}</span><span class="t-sub">${sub}</span></a>`;
    const cards = [
      card('Your best', ins.best, c.pct(ins.best && ins.best.winRate), ins.best && `${wl(ins.best)} · ${ins.best.games} games`, 'good'),
      card('Park it for now', ins.avoid, c.pct(ins.avoid && ins.avoid.winRate), ins.avoid && `${wl(ins.avoid)} · ${ins.avoid.games} games`, 'bad'),
      card('Most rank points', ins.mostPts, ins.mostPts && c.signed(ins.mostPts.net) + ' pts', ins.mostPts && `${ins.mostPts.hasDelta} ranked`, 'good'),
      card('Biggest drain', ins.drain, ins.drain && c.signed(ins.drain.net) + ' pts', ins.drain && `${ins.drain.hasDelta} ranked`, 'bad'),
      card('On the rise', ins.rising, ins.rising && '▲ +' + ins.rising.trend.toFixed(1), 'form, last 5 vs before', 'good'),
      card('Most played', ins.most, ins.most && String(ins.most.games), ins.most && `games · ${c.pct(ins.most.winRate)}`),
    ].filter(Boolean);
    return `<section class="ov-sec">${sh('Scouting · last ' + ins.days + ' days', src('yours', `Over your games in the last ${ins.days} days. A hero’s win rate is adjusted for few games: pulled toward your overall ${c.pct(ins.base)} by ${E.HERO_INS_K} games, so a 4–0 hero can’t beat a 30–20 one; best and park-it need ${E.HERO_INS_MIN}+ games, and park-it must sit 5+ points under your overall. Rank points count ranked games only (5+). On the rise compares the form of your last 5 games on a hero with the ones before.`))}
      <div class="ins-row">${cards.join('')}</div></section>`;
  }

  /* The hero picker, sorted with intent: the heroes you climb on, steady ones, the ones to park (each best
     first by Engine.heroInsights' weighed win rate), then small chips for heroes with few games lately
     and ones not played in the window. */
  let heroJump = false;
  function heroPicker(c, ins, list, counts, hero) {
    const seen = new Set(ins.rows.map(h => h.hero));
    const tile = h => `<a href="#/heroes/${h.hero}" class="hpk ${h.group}${h.hero === hero ? ' on' : ''}" aria-current="${h.hero === hero}">${icon(c, h.hero, 30)}
      <span class="hpk-n">${c.esc(c.heroName(h.hero))}</span><b class="hpk-v">${c.pct(h.winRate)}</b>
      <span class="hpk-s">${h.wins}–${h.losses}${h.hasDelta ? ` · ${c.signed(h.net)} pts` : ''}</span></a>`;
    const chip = (id, sub) => `<a href="#/heroes/${id}" class="hchip${id === hero ? ' on' : ''}" aria-current="${id === hero}" title="${c.esc(c.heroName(id))}">${icon(c, id, 22)}<span>${c.esc(c.heroName(id))}</span><span class="muted small">${sub}</span></a>`;
    const group = (key, label, cls) => { const hs = ins.rows.filter(h => h.group === key); return hs.length ? `<div class="pk-g ${cls || ''}"><div class="pk-k">${label} <span class="muted">${hs.length}</span></div><div class="pk-tiles">${hs.map(tile).join('')}</div></div>` : ''; };
    const few = ins.rows.filter(h => h.group === 'few').sort((a, b) => b.games - a.games), old = list.filter(h => !seen.has(h)).sort((a, b) => counts.get(b) - counts.get(a));
    return `<section class="ov-sec">${sh('Your hero pool · last ' + ins.days + ' days', src('yours', `Heroes with ${c.E.HERO_INS_MIN}+ games in the last ${ins.days} days, grouped by their win rate adjusted for few games (pulled toward your overall ${c.pct(ins.base)} by ${c.E.HERO_INS_K} games): Climb on these is 2+ points above it, Park for now is 5+ points below, Steady is in between. Each group is best first. Numbers under each hero: wins–losses and rank points.`))}
      ${group('climb', 'Climb on these', 'good')}${group('steady', 'Steady')}${group('park', 'Park for now', 'bad')}
      ${few.length ? `<div class="pk-g"><div class="pk-k">Few games lately <span class="muted">${few.length}</span></div><div class="pk-chips">${few.map(h => chip(h.hero, h.games)).join('')}</div></div>` : ''}
      ${old.length ? `<div class="pk-g"><div class="pk-k">Not in ${ins.days} days <span class="muted">${old.length}</span></div><div class="pk-chips">${old.map(h => chip(h, counts.get(h))).join('')}</div></div>` : ''}
    </section>`;
  }

  function heroes(host, c) {
    const M = c.M, E = c.E, S = c.settings;
    const now = Date.now() / 1000;
    const counts = new Map();
    for (const m of M.all) counts.set(m.hero, (counts.get(m.hero) || 0) + 1);
    const recentCount = new Map();
    for (const m of M.all) if (now - m.t < 60 * 86400) recentCount.set(m.hero, (recentCount.get(m.hero) || 0) + 1);
    // Shown A–Z; with no hero picked, open the one you've played most in the last 60 days.
    const busiest = [...counts.keys()].sort((a, b) => (recentCount.get(b) || 0) - (recentCount.get(a) || 0) || counts.get(b) - counts.get(a));
    const list = busiest.slice().sort((a, b) => c.heroName(a).localeCompare(c.heroName(b)));
    if (!list.length) { host.innerHTML = '<div class="empty-state">No matches yet.</div>'; return; }
    const hero = c.state.route.id && counts.has(c.state.route.id) ? c.state.route.id : busiest[0];
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
    const road = E.roadTier(M.badge), nextTier = road.tier;
    const tn = t => c.tierName(t);
    const fmt = (r, v) => v == null ? '—' : r.fmt === 'pct' ? Math.round(v * 100) + '%' : r.fmt === 'dec' ? v.toFixed(1) : c.kfmt(v);
    const window = !plan.widened ? `games since the ${new Date(plan.from * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} patch`
      : `the last ${E.BENCH_WIDE_DAYS} days` + (plan.spansPatch ? ' (spans a patch)' : '');

    const ins = E.heroInsights(M.all, M.perf, now);
    const fig = (label, value, sub, badge) => `<div class="fig"><div class="fig-v">${value}</div><div class="t-label">${label}${badge ? ' ' + badge : ''}</div><div class="t-sub">${sub || '&nbsp;'}</div></div>`;
    host.innerHTML = `
      <div class="masthead"><div class="ident"><div><div class="rank-name">Heroes</div>
        <div class="muted small num-line"><span>${list.length} heroes</span><span>${ins.n} games in ${ins.days} days</span>${ins.base != null ? `<span>${c.pct(ins.base)} overall</span>` : ''}</div></div></div></div>
      ${heroScout(c, ins)}
      ${heroPicker(c, ins, list, counts, hero)}

      <div class="hero-head"><div class="ident">${icon(c, hero, 48)}<div><div class="rank-name">${c.esc(c.heroName(hero))}</div>
        <div class="muted small num-line"><span>${games.length} games</span><span>${sum.wins}–${sum.losses}</span>${sum.hasDelta ? `<span>${c.signed(sum.net)} pts</span>` : ''}</div></div></div>
        ${seg('Hero view', [['road', 'Rank road'], ['coach', 'Coach me']], heroTab).replace('class="seg-ctl"', 'class="seg-ctl" id="ht"')}</div>

      <div class="ledger l5">
        ${fig('Win rate', c.pct(sum.winRate), `${sum.wins}–${sum.losses}`)}
        ${fig('Rank points', sum.hasDelta ? c.signed(sum.net) : '—', 'on this hero')}
        ${fig('Souls lead at 12:00', heroEarly.nAhead ? c.pct(heroEarly.ahead12) : '—', `${heroEarly.nAhead} games`, src('yours', 'Games where your souls at 12:00 beat your lane opponents’ average, out of your recent games on this hero with match detail.'))}
        ${fig('No deaths to 10:00', heroEarly.nClean ? c.pct(heroEarly.clean10) : '—', `${heroEarly.nClean} games`)}
        ${fig('★ MVP games', roles.n ? roles.mvp : '—', `${roles.n} games read`, src('valve', 'Games where Valve named you MVP, 1st in the lobby.'))}
      </div>

      ${heroTab === 'coach' ? heroCoachPanel(c, hero, games, c.state.items && c.state.items.map) : `<section class="ov-sec">
        ${sh(road.kind === 'next' ? `Road to ${c.esc(tn(nextTier))}` : `vs the ${c.esc(tn(nextTier))} average`, seg('Game time', [[900, '15 min'], [1200, '20 min'], [1800, '30 min']], T).replace('class="seg-ctl"', 'class="seg-ctl" id="bt"'))}
        ${!ready ? `<p class="muted small">Loading the comparison… ${loaded}/${E.LADDER_TIERS.length} ranks</p>` : roadHtml(c, lad, nextTier, fmt, tn, T, tiersData, hero, `Your average ${c.heroName(hero)} game vs the average one in ${tn(nextTier)} lobbies, at ${T / 60}:00, over ${window} (${plan.n} of your games${plan.thin ? ', fewer than ' + E.MIN_HERO_GAMES + ', so treat it as a rough read' : ''}).`)}
      </section>`}`;
    // Picking a hero in the pool jumps to its section below instead of leaving you at the top.
    host.querySelectorAll('.hpk, .hchip').forEach(a => a.addEventListener('click', () => { heroJump = true; }));
    if (heroJump) { heroJump = false; const hh = host.querySelector('.hero-head'); if (hh) setTimeout(() => hh.scrollIntoView({ block: 'start' }), 0); }
    bindSeg(host, '#ht', v2 => { heroTab = v2; c.render(); });
    bindSeg(host, '#bt', v2 => { S.benchT = Number(v2); c.save(); c.render(); });
    host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { c.startFocus(b.dataset.pick, null, null, 'you'); c.go('#/coach'); }));
    if (!ready) c.ensureHeroLadder(hero);
  }

  /* The next-rank plan: up to three training targets and what's already at that rank's level. */
  function roadHtml(c, lad, nextTier, fmt, tn, T, tiersData, hero, window) {
    const E = c.E, plan = E.nextRankPlan(lad), nextName = tn(nextTier);
    const nNext = tiersData[nextTier] && tiersData[nextTier].curve && tiersData[nextTier].curve[T] ? tiersData[nextTier].curve[T].n : null;
    const active = c.state.focus.active && c.state.focus.active.habit;
    const why = `${window} Averages of ${nNext ? c.fmtInt(nNext) + ' ' : ''}${c.heroName(hero)} games in ${nextName} lobbies (lobby average badge in that rank) since the last big patch, from deadlock-api. A gap is only listed when it’s bigger than your own game-to-game swing.`;
    const targets = plan.gaps.slice(0, 3);
    // Each gap as a figure: you → their average, how far off, and the habit that trains it.
    return `${targets.length ? `<div class="ledger targets2" style="grid-template-columns:repeat(${targets.length}, minmax(0, 1fr))">${targets.map((g, i) => {
        const h = g.habit && E.habitById(g.habit);
        const habitBtn = !h ? '<span class="muted small">no per-game check yet</span>' : active === g.habit ? '<span class="tag">your focus</span>' : `<button type="button" class="btn ghost-btn sm" data-pick="${g.habit}">Train it</button>`;
        return `<div class="fig"><div class="fig-v">${fmt(g, g.you)} <span class="muted">→</span> <span class="brass">${fmt(g, g.target)}</span></div>
          <div class="t-label">${c.esc(g.label)}${i ? '' : ' ' + src('ranks', why)}</div>
          <div class="t-sub"><span class="neg">${g.rel > 0 ? '+' : '−'}${Math.abs(Math.round(g.rel * 100))}%</span> vs ${c.esc(nextName)}</div>${habitBtn}</div>`;
      }).join('')}</div>`
      : `<p class="muted small">Nothing clearly below the ${c.esc(nextName)} average at ${T / 60}:00. ${src('ranks', why + ' When nothing shows, the gap is in what these numbers can’t see (decisions, timing, positioning): the win-chance card on your matches finds the moments that cost you.')}</p>`}
      ${plan.strengths.length ? `<div class="num-line strengths"><span class="t-label">At ${c.esc(nextName)} level</span>${plan.strengths.map(x => `<span class="pos">${c.esc(x.label)}</span>`).join('')}</div>` : ''}`;
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


  /* About's glossary: every term or number that isn't self-explanatory, one line each. */
  const GLOSSARY = E => [
    ['Improving / Holding / Slipping', 'The overall call: rank points, Form and rough games, each against the window before.'],
    ['Rank points (pts)', 'Valve’s own rank-point change per ranked game. Placement games have none.'],
    ['Calibrating', 'Still in placement games: no rank yet, so rank comparisons use Initiate.'],
    ['Form', 'How a game went vs your usual on that hero. 0 = a normal game for you, +1.0 clearly better, −1.0 clearly worse. Needs 5+ games on the hero.'],
    ['Rough games', 'Losses where you also played below your usual (Form under 0).'],
    ['Rank step · Pace', 'One division, e.g. Ritualist 1 → 2 (1,000 rank points in Season 2). Pace = ranked games per step lately.'],
    ['Where your win rate takes you', 'Your rank after 20 / 50 / 100 more ranked games, from your recent win rate pulled toward 50%. Tested on other players’ seasons; the range is where 6 in 10 ended up.'],
    ['Souls lead at 12:00', 'Games where your souls beat your lane opponents’ average at 12:00.'],
    ['No deaths to 10:00', 'Games with zero deaths in the first 10 minutes.'],
    ['Habit', 'One thing to practise, checked ✓ or ✗ every game. Pass rate = how often you do it; mastered at ' + E.FOCUS_GRAD[0] + ' of your last ' + E.FOCUS_GRAD[1] + '.'],
    ['Won with it · Lost without it', 'How often you won when a habit happened, and lost when it didn’t.'],
    ['Follows result', 'A habit that partly happens because a game is already being lost.'],
    ['In wins · in losses', 'The same stat averaged over your wins and over your losses.'],
    ['Caught out', 'A death within ' + E.FAST_DEATH_S + 's of first taking damage.'],
    ['Win chance', 'Climb’s trained model: your team’s chance to win at that minute, from the souls, kills and objective gaps.'],
    ['−6% win chance (a death)', 'What a death like that usually costs at that minute, not an exact measure of that one.'],
    ['Creeps last-hit', 'Lane creeps you last-hit, out of those you could reach.'],
    ['★ MVP', 'Valve named you MVP: 1st in the lobby.'],
    ['Rank badge on a match', 'The rank you played that game at. Dimmer on unranked games: your rank at the time.'],
    ['Scoreboard ranks · tags', 'Each player’s rank in that game (dimmer: their rank now), games and win rate on the hero, and tags like One-trick or Wins a lot on it.'],
    ['#2 of 6 · impact', 'Your place on your own team by share of souls, damage or healing, kills + assists and objectives. 1.00 = an average teammate. Neutral: it doesn’t predict wins.'],
    ['Adjusted win rate', 'A hero’s win rate pulled toward your overall by ' + E.HERO_INS_K + ' games, so 4–0 can’t beat 30–20.'],
    ['Overall · 100%', 'Friends: souls, damage or healing, kills + assists and staying alive vs the lobby average. 100 = average.'],
    ['i (the small rings)', 'Where a number comes from: Your games · Trained model · Rank data · Valve · Climb rule (a rule of thumb) · AI (Gemini’s wording). Tap one to see how a number is worked out.'],
  ];

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
        ${calibrationCard(c)}
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
      <section class="card how"><h2>What the numbers mean</h2><dl class="gloss">${GLOSSARY(E).map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl></section>
      <section class="card how"><h2>Changelog</h2>${c.LOG.map(e => `<h3>${c.verName(e.v)} · ${c.esc(e.title)} <span class="muted small">${c.esc(e.date)}</span></h3><ul>${e.items.map(i => `<li>${c.esc(i)}</li>`).join('')}</ul>`).join('')}</section>`;
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
