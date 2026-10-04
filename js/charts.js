/* charts.js — hand-rolled SVG/HTML charts. Specs follow the dataviz rules: 2px lines, >=8px
   markers with a surface ring, hairline solid grid, text in ink tokens (never series colour),
   a crosshair tooltip on the line and a hover tooltip on every bar segment. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const fmtInt = n => Math.round(n).toLocaleString('en-US');
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(Math.abs(n));

  /* One tooltip element per page, positioned in the chart's own box. */
  function tooltip(host) {
    let tip = host.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; host.appendChild(tip); }
    return {
      show(html, x, y) {
        tip.innerHTML = html; tip.hidden = false;
        const w = tip.offsetWidth, hw = host.clientWidth;
        tip.style.left = Math.max(0, Math.min(hw - w, x - w / 2)) + 'px';
        tip.style.top = Math.max(0, y - tip.offsetHeight - 12) + 'px';
      },
      hide() { tip.hidden = true; },
    };
  }

  function niceStep(range, target) {
    const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f >= 5 ? 10 : f >= 2 ? 5 : f >= 1 ? 2 : 1) * mag;
  }

  /* Cumulative rank points across the season. `hiFrom` = index where the selected window
     starts, shaded so the line reads "here's where you are in the bigger picture". Rank-up /
     rank-down points (badge changes) get a marker. */
  function rankLine(host, pts, opts) {
    host.querySelectorAll('svg').forEach(n => n.remove());
    if (pts.length < 2) { host.querySelector('.empty') || host.insertAdjacentHTML('beforeend', '<p class="empty">Not enough ranked games with rank-point data yet.</p>'); return; }
    const e = host.querySelector('.empty'); if (e) e.remove();
    const W = Math.max(280, host.clientWidth), H = 200;
    const m = { l: 48, r: 16, t: 14, b: 26 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, null);
    host.insertBefore(svg, host.firstChild);

    const ys = pts.map(p => p.cum).concat([0]);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const step = niceStep(Math.max(1, hi - lo), 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = i => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
    const y = v => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

    // window shade
    if (opts.hiFrom != null && opts.hiFrom < pts.length) {
      const x0 = opts.hiFrom > 0 ? (x(opts.hiFrom - 1) + x(opts.hiFrom)) / 2 : m.l;
      el('rect', { x: x0, y: m.t, width: W - m.r - x0, height: H - m.t - m.b, class: 'shade' }, svg);
    }
    // grid + y ticks
    for (let v = lo; v <= hi + 1e-9; v += step) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
      const t = el('text', { x: m.l - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
      t.textContent = v === 0 ? '0' : signed(v);
    }
    // x ticks: first / last date
    const date = t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    [[0, 'start'], [pts.length - 1, 'end']].forEach(([i, a]) => {
      const t = el('text', { x: x(i), y: H - 6, class: 'tick', 'text-anchor': a }, svg);
      t.textContent = date(pts[i].t);
    });
    // area wash + line
    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.cum).toFixed(1)).join(' ');
    el('path', { d: d + ` L${x(pts.length - 1)} ${y(Math.max(lo, 0))} L${x(0)} ${y(Math.max(lo, 0))} Z`, class: 'wash' }, svg);
    el('path', { d, class: 'line' }, svg);
    // badge changes
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].badge != null && pts[i - 1].badge != null && pts[i].badge !== pts[i - 1].badge) {
        el('circle', { cx: x(i), cy: y(pts[i].cum), r: 4, class: pts[i].badge > pts[i - 1].badge ? 'mk up' : 'mk down' }, svg);
      }
    }
    // end label (selective: only the latest value)
    const last = pts[pts.length - 1];
    el('circle', { cx: x(pts.length - 1), cy: y(last.cum), r: 5, class: 'mk end' }, svg);

    // crosshair + tooltip
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
    const dot = el('circle', { r: 5, class: 'mk end', visibility: 'hidden' }, svg);
    const tip = tooltip(host);
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - m.l) / (W - m.l - m.r) * (pts.length - 1))));
      const p = pts[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.cum)); dot.setAttribute('visibility', 'visible');
      tip.show(opts.tipHtml(p, i), x(i) * (r.width / W), y(p.cum) * (r.height / H));
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  }

  /* Stacked 100% bars of the four match classes, one row per window. HTML not SVG: flex gives
     the 2px surface gap and rounded data-ends for free. */
  function mixBars(host, rows, quads, labels) {
    host.innerHTML = '';
    const tip = tooltip(host);
    for (const row of rows) {
      const total = quads.reduce((s, q) => s + row.q[q], 0);
      const line = document.createElement('div');
      line.className = 'mix-row';
      line.innerHTML = `<span class="mix-label">${row.label}</span>`;
      const bar = document.createElement('div');
      bar.className = 'mix-bar';
      if (!total) bar.innerHTML = '<span class="mix-none">no scored games</span>';
      for (const q of quads) {
        if (!row.q[q]) continue;
        const seg = document.createElement('span');
        seg.className = 'seg q-' + q;
        seg.style.flexGrow = row.q[q];
        const pct = Math.round(row.q[q] / total * 100);
        const html = `<b>${labels[q]}</b><br>${row.q[q]} of ${total} games · ${pct}%`;
        seg.setAttribute('aria-label', `${labels[q]}: ${row.q[q]} of ${total}`);
        seg.addEventListener('pointerenter', () => {
          const hr = host.getBoundingClientRect(), sr = seg.getBoundingClientRect();
          tip.show(html, sr.left - hr.left + sr.width / 2, sr.top - hr.top);
        });
        seg.addEventListener('pointerleave', () => tip.hide());
        bar.appendChild(seg);
      }
      line.appendChild(bar);
      host.appendChild(line);
    }
  }

  /* Tiny inline mix bar for table cells. */
  function miniMix(q, quads) {
    const total = quads.reduce((s, k) => s + q[k], 0);
    if (!total) return '<span class="muted">—</span>';
    return '<span class="mini-mix">' + quads.filter(k => q[k]).map(k => `<span class="seg q-${k}" style="flex-grow:${q[k]}"></span>`).join('') + '</span>';
  }

  root.Charts = { rankLine, mixBars, miniMix, signed, fmtInt };
})(window);
