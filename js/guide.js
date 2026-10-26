/* guide.js — the Copy buttons on ingest.html. If the browser refuses the clipboard, the command is
   selected instead so Ctrl+C works. */
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const el = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(el.textContent); b.textContent = 'Copied'; }
  catch (e) {
    const r = document.createRange(); r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    b.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => { b.textContent = 'Copy'; }, 2000);
}));
