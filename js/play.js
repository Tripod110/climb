/* play.js — play-time model. Pure functions, tested in play-tests.js. No DOM, no network.

   Two sources of "when was I playing":
   - the local helper (helper/helper.py): real sessions {start, end} from whether deadlock.exe was
     running. Includes queue, lobby and menu time. Trusted from `since` (when it started logging).
   - the API's match history: each match becomes [start, start + duration]. Games only, and it can
     lag or miss matches, so it's used only for days BEFORE the helper started (or when there's no
     helper at all, e.g. on the phone).

   A "day" runs 5 AM to 5 AM local, so a 1 AM session counts toward the evening it belongs to. */
(function (root) {
  'use strict';
  const DAY_START_H = 5;
  const HEAT_WEEKS = 12;
  const AVG_DAYS = 28;
  // Heatmap steps in hours. Fixed (not relative to your max) so a square means the same thing every week.
  const LEVELS = [1, 2, 3, 4.5];

  const pad = n => (n < 10 ? '0' : '') + n;
  const keyOfDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parts = key => key.split('-').map(Number);

  /* The play-day a timestamp (seconds) belongs to. */
  function dayKey(t) {
    const d = new Date(t * 1000);
    if (d.getHours() < DAY_START_H) return keyOfDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
    return keyOfDate(d);
  }
  function addDays(key, n) {
    const [y, m, d] = parts(key);
    return keyOfDate(new Date(y, m - 1, d + n));
  }
  /* [start, end) of a play-day in seconds. Built from local dates, so DST days are 23h/25h. */
  function bounds(key) {
    const [y, m, d] = parts(key);
    return [new Date(y, m - 1, d, DAY_START_H) / 1000, new Date(y, m - 1, d + 1, DAY_START_H) / 1000];
  }
  const weekday = key => { const [y, m, d] = parts(key); return (new Date(y, m - 1, d).getDay() + 6) % 7; }; // Mon = 0

  /* Merge both sources into sorted, non-overlapping intervals {s, e, src}. */
  function intervals(helper, matches, now) {
    const cut = helper && helper.since ? helper.since : Infinity;
    const raw = [];
    for (const m of matches || []) {
      if (m.t < cut) raw.push({ s: m.t, e: Math.min(m.t + (m.dur || 0), cut), src: 'api' });
    }
    if (helper) {
      for (const x of helper.sessions || []) {
        const e = x.end == null ? now : x.end;
        if (e > x.start) raw.push({ s: x.start, e, src: 'helper' });
      }
    }
    raw.sort((a, b) => a.s - b.s);
    const out = [];
    for (const r of raw) {
      const last = out[out.length - 1];
      if (last && r.s <= last.e) { last.e = Math.max(last.e, r.e); if (r.src === 'helper') last.src = 'helper'; }
      else out.push(Object.assign({}, r));
    }
    return out;
  }

  /* Seconds per play-day: Map key -> secs. Intervals crossing 5 AM are split. */
  function perDay(ivs) {
    const days = new Map();
    for (const iv of ivs) {
      let key = dayKey(iv.s);
      for (let guard = 0; guard < 400; guard++) {
        const [a, b] = bounds(key);
        const secs = Math.min(iv.e, b) - Math.max(iv.s, a);
        if (secs > 0) days.set(key, (days.get(key) || 0) + secs);
        if (iv.e <= b) break;
        key = addDays(key, 1);
      }
    }
    return days;
  }

  /* Seconds per clock hour (0-23) within [from, to). */
  function hourProfile(ivs, from, to) {
    const bins = new Array(24).fill(0);
    for (const iv of ivs) {
      let s = Math.max(iv.s, from);
      const e = Math.min(iv.e, to);
      while (s < e) {
        const d = new Date(s * 1000);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1) / 1000;
        const stop = Math.min(e, next);
        bins[d.getHours()] += stop - s;
        s = stop;
      }
    }
    return bins;
  }

  const level = secs => secs <= 0 ? 0 : 1 + LEVELS.filter(h => secs >= h * 3600).length; // 0..5

  /* Everything the Play card shows. */
  function summary(helper, matches, now) {
    const ivs = intervals(helper, matches, now);
    const days = perDay(ivs);
    const today = dayKey(now);
    const [t0] = bounds(today);
    const todayIvs = ivs.filter(iv => iv.e > t0);
    const first = ivs.length ? dayKey(ivs[0].s) : today;

    // Average over the AVG_DAYS before today, counting zero days, but never before the data starts.
    let sum = 0, n = 0;
    for (let i = 1; i <= AVG_DAYS; i++) {
      const k = addDays(today, -i);
      if (k < first) break;
      sum += days.get(k) || 0; n++;
    }

    // Heatmap: HEAT_WEEKS columns of Mon..Sun ending with the current week.
    const startKey = addDays(today, -weekday(today) - 7 * (HEAT_WEEKS - 1));
    const cells = [];
    for (let i = 0; i < HEAT_WEEKS * 7; i++) {
      const k = addDays(startKey, i);
      const future = k > today;
      const secs = future ? 0 : days.get(k) || 0;
      cells.push({ key: k, secs, level: future ? -1 : level(secs), src: helper && helper.since && bounds(k)[1] > helper.since ? 'helper' : 'api', future });
    }

    const open = helper && (helper.sessions || []).find(x => x.end == null);
    return {
      today, todaySecs: days.get(today) || 0, todaySessions: todayIvs.length,
      playing: !!(helper && helper.playing), playingSince: open ? open.start : null,
      avgSecs: n >= 3 ? sum / n : null, avgDays: n,
      cells, hours: hourProfile(ivs, now - AVG_DAYS * 86400, now),
    };
  }

  /* "2h 05m", "45m", "0m". */
  function dur(secs) {
    const m = Math.round(secs / 60);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + pad(m % 60) + 'm';
  }

  const Play = { DAY_START_H, HEAT_WEEKS, AVG_DAYS, LEVELS, dayKey, addDays, bounds, weekday, intervals, perDay, hourProfile, level, summary, dur };
  root.Play = Play;
  if (typeof module === 'object' && module.exports) module.exports = Play;
})(typeof window !== 'undefined' ? window : globalThis);
