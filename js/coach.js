/* coach.js — the only file that talks to Gemini. The key is the user's own, pasted into About and
   kept in this browser's localStorage (climb.coach); it is never in the code or the repo, so the
   public site can ship this feature without exposing anyone's key. Calls go straight from the
   browser to generativelanguage.googleapis.com (CORS-enabled; allowed by the CSP). */
(function (root) {
  'use strict';
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

  async function call(key, path, body) {
    const r = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-goog-api-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
      const err = new Error(r.status === 400 && /key/i.test(msg) ? 'That API key isn’t valid.'
        : r.status === 429 ? 'Gemini quota reached. Wait a minute, or check your plan’s limits.'
        : r.status === 403 ? 'This key can’t use the Gemini API (is it enabled for the project?).'
        : msg);
      err.status = r.status;
      throw err;
    }
    return j;
  }

  /* Text models this key can call, newest first. Skips image/audio/embedding/live variants. */
  async function models(key) {
    const j = await call(key, 'models?pageSize=200');
    const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')
      && /^models\/gemini-/.test(m.name) && !/(image|tts|audio|live|embedding|vision|learnlm|robotics|computer)/i.test(m.name));
    const ver = n => { const x = n.match(/gemini-(\d+(?:\.\d+)?)/); return x ? parseFloat(x[1]) : 0; };
    return ok.map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
      .sort((a, b) => ver(b.id) - ver(a.id) || a.id.localeCompare(b.id));
  }

  /* The default: the newest stable Flash (fast and cheap), else the newest of anything. */
  function pickDefault(list) {
    const stable = list.filter(m => !/(preview|exp|lite)/i.test(m.id));
    return (stable.find(m => /flash/i.test(m.id)) || list.find(m => /flash/i.test(m.id)) || list[0] || {}).id || null;
  }

  async function json(key, model, system, user, schema) {
    const j = await call(key, 'models/' + encodeURIComponent(model) + ':generateContent', {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 },
    });
    const cand = (j.candidates || [])[0];
    if (!cand) throw new Error((j.promptFeedback && j.promptFeedback.blockReason) ? 'Gemini blocked the request: ' + j.promptFeedback.blockReason : 'Gemini returned no answer.');
    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    try { return { data: JSON.parse(text), usage: j.usageMetadata || null }; }
    catch (e) { throw new Error('Gemini’s answer wasn’t valid JSON' + (cand.finishReason && cand.finishReason !== 'STOP' ? ' (' + cand.finishReason + ')' : '') + '.'); }
  }

  root.Coach = { models, pickDefault, json };
})(window);
