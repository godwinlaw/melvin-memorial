// <lantern-wall> — server-backed message wall with text + photos and a focus view.
// Theme via CSS custom properties on the element:
//   --lw-bg, --lw-glow, --lw-ink, --lw-ink-soft, --lw-line, --lw-accent,
//   --lw-paper-1, --lw-paper-2, --lw-flame
// Endpoint via the `endpoint` attribute (default: "/api/lanterns").
// Posts go through POST {endpoint} with X-Post-Password (cached in sessionStorage).

(function () {
  const POST_PW_KEY = "lantern-wall::post-password";
  const NAME_MAX = 60;
  const ROLE_MAX = 60;
  const MSG_MAX = 2000;
  const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
  const MEDIA_MAX_COUNT = 4;
  const MEDIA_MIMES = ["image/png", "image/jpeg", "image/webp", "image/avif"];

  const css = `
:host {
  --lw-bg: rgba(13,15,18,0.5);
  --lw-glow: rgba(255,180,100,0.35);
  --lw-ink: #f3ead7;
  --lw-ink-soft: #b9b3a4;
  --lw-line: rgba(212,160,92,0.3);
  --lw-accent: #d4a05c;
  --lw-paper-1: #ffd28c;
  --lw-paper-2: #b97246;
  --lw-flame: #ffe5b3;
  --lw-serif: "Cormorant Garamond", "Newsreader", "Playfair Display", Georgia, serif;
  --lw-sans: "Inter", system-ui, sans-serif;
  display: block;
  color: var(--lw-ink);
  font-family: var(--lw-sans);
}
* { box-sizing: border-box; }

.form {
  max-width: 640px; margin: 0 auto 20px;
  border: 1px solid var(--lw-line);
  background: var(--lw-bg);
  padding: 30px;
  position: relative;
}
.form label { display: block; color: var(--lw-accent); font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; margin: 0 0 8px; }
.form input[type=text], .form textarea, .form input[type=password] {
  width: 100%; background: transparent; border: 0;
  border-bottom: 1px solid var(--lw-line);
  color: var(--lw-ink); font-family: var(--lw-serif); font-size: 18px;
  padding: 6px 0 12px; margin-bottom: 22px; outline: none; resize: vertical;
}
.form textarea { min-height: 100px; line-height: 1.55; font-size: 17px; }
.form input:focus, .form textarea:focus { border-bottom-color: var(--lw-accent); }
.form .row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 14px; }
.form .meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.form .count { color: var(--lw-ink-soft); font-size: 12px; opacity: 0.7; }
.form .optional { color: var(--lw-ink-soft); font-size: 11px; opacity: 0.6; }
.form .attach {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  color: var(--lw-accent); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  padding: 9px 14px; border: 1px solid var(--lw-line); background: transparent;
}
.form .attach:hover { border-color: var(--lw-accent); }
.form .attach svg { width: 14px; height: 14px; }
.form input[type=file] { display: none; }
.form .preview {
  margin: 14px 0 4px; display: none;
  padding: 8px; border: 1px dashed var(--lw-line);
  gap: 8px; flex-wrap: wrap;
}
.form .preview.shown { display: flex; }
.form .preview .item {
  position: relative; width: 96px; height: 96px;
  border: 1px solid var(--lw-line); overflow: hidden;
}
.form .preview .item img { display: block; width: 100%; height: 100%; object-fit: cover; }
.form .preview .item .clear {
  position: absolute; top: 2px; right: 2px;
  width: 22px; height: 22px; border-radius: 50%;
  background: rgba(0,0,0,0.65); color: white; border: 0; cursor: pointer; font-size: 13px;
  display: grid; place-items: center;
}
.form .preview .item .clear:hover { background: rgba(0,0,0,0.85); }
.form button.submit {
  background: var(--lw-accent); color: #1a1208; border: 0;
  padding: 13px 26px; font-family: var(--lw-sans); font-size: 11px;
  letter-spacing: 0.3em; text-transform: uppercase; font-weight: 600; cursor: pointer;
}
.form button.submit:hover:not(:disabled) { filter: brightness(1.06); }
.form button.submit:disabled { opacity: 0.6; cursor: not-allowed; }

.banner {
  border: 1px solid var(--lw-line); color: var(--lw-ink);
  padding: 12px 14px; margin: 0 0 18px; font-size: 14px; line-height: 1.4;
}
.banner.error { border-color: #d99c8a; color: #f0c8bb; }
.banner.info { border-color: var(--lw-accent); color: var(--lw-ink); }

.wall {
  position: relative;
  border-top: 1px solid var(--lw-line);
  border-bottom: 1px solid var(--lw-line);
  background:
    radial-gradient(ellipse at 50% 100%, var(--lw-glow), transparent 60%),
    radial-gradient(2px 2px at 15% 70%, rgba(255,225,170,0.4), transparent 50%),
    radial-gradient(1px 1px at 60% 50%, rgba(255,225,170,0.3), transparent 50%),
    radial-gradient(1.5px 1.5px at 85% 30%, rgba(255,225,170,0.45), transparent 50%),
    radial-gradient(1px 1px at 30% 20%, rgba(255,225,170,0.3), transparent 50%);
  padding: 60px 24px;
  min-height: 480px;
  overflow: hidden;
}
.controls {
  max-width: 1180px; margin: 0 auto 32px;
  display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
  color: var(--lw-ink-soft);
  font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
}
.controls .count-pill {
  display: inline-flex; align-items: center; gap: 10px;
  border: 1px solid var(--lw-line); padding: 9px 14px;
  color: var(--lw-accent);
}
.controls .count-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lw-accent); box-shadow: 0 0 8px var(--lw-accent); }
.controls .sort {
  display: inline-flex; gap: 0; border: 1px solid var(--lw-line);
}
.controls .sort button {
  background: transparent; color: var(--lw-ink-soft);
  border: 0; padding: 9px 14px; font: inherit; font-size: 11px;
  letter-spacing: 0.24em; text-transform: uppercase; cursor: pointer;
  border-right: 1px solid var(--lw-line);
}
.controls .sort button:last-child { border-right: 0; }
.controls .sort button.active { color: var(--lw-accent); background: rgba(212,160,92,0.08); }

.grid {
  max-width: 1180px; margin: 0 auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 28px 22px;
  align-items: start;
}
.lantern {
  position: relative;
  cursor: pointer;
  animation: bob 6s ease-in-out infinite;
  transition: transform 0.35s cubic-bezier(.2,.8,.2,1), filter 0.3s ease;
  isolation: isolate;
}
.lantern:nth-child(3n) { animation-delay: -2s; }
.lantern:nth-child(3n+1) { animation-delay: -4s; animation-duration: 7s; }
.lantern:nth-child(2n) { animation-duration: 5.5s; }
@keyframes bob {
  0%, 100% { transform: translateY(0) rotate(-0.6deg); }
  50% { transform: translateY(-6px) rotate(0.6deg); }
}
.lantern:hover {
  transform: translateY(-8px) scale(1.03);
  filter: drop-shadow(0 0 24px var(--lw-glow));
  z-index: 2;
}
.lantern::before {
  content: ""; position: absolute; left: 50%; top: -28px;
  width: 1px; height: 28px; background: rgba(255,225,170,0.4);
  transform: translateX(-50%);
}
.lantern .body {
  position: relative;
  padding: 20px 18px 22px;
  border-radius: 8px;
  background: radial-gradient(ellipse at 50% 40%, var(--lw-paper-1) 0%, var(--lw-paper-2) 100%);
  border: 1px solid rgba(255,225,170,0.55);
  box-shadow:
    0 0 28px var(--lw-glow),
    0 0 56px rgba(255,160,80,0.18),
    inset 0 0 22px rgba(255,230,180,0.45);
  color: #2a1608;
  text-align: left;
  min-height: 168px;
  display: flex; flex-direction: column;
}
.lantern .body::after {
  content: ""; position: absolute; left: 50%; top: -1px;
  transform: translate(-50%, -50%);
  width: 60%; height: 8px;
  background: rgba(80,40,15,0.6);
  border-radius: 4px;
}
.lantern .body .name {
  font-family: var(--lw-serif);
  font-size: 17px; line-height: 1.2;
  font-weight: 600; color: #3a1d08;
  margin-bottom: 2px;
}
.lantern .body .role {
  font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
  color: rgba(58,29,8,0.7);
  margin-bottom: 12px;
}
.lantern .body .text {
  font-family: var(--lw-serif);
  font-size: 14px; line-height: 1.45;
  color: #2a1608;
  flex: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
}
.lantern .thumb {
  position: relative;
  margin: -20px -18px 12px;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-radius: 8px 8px 0 0;
}
.lantern .thumb img {
  width: 100%; height: 100%; object-fit: cover; object-position: center; display: block;
}
.lantern .thumb .more {
  position: absolute; top: 8px; right: 8px;
  background: rgba(20,10,4,0.7); color: var(--lw-flame);
  font-family: var(--lw-sans); font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em;
  padding: 4px 8px; border-radius: 999px;
  border: 1px solid rgba(255,225,170,0.35);
  backdrop-filter: blur(2px);
}
.lantern .body .more {
  margin-top: 10px;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: rgba(58,29,8,0.65);
  display: flex; align-items: center; gap: 6px;
}
.lantern .body .more.has-overflow { color: rgba(58,29,8,0.9); font-weight: 600; }
.lantern .body .more::after { content: "→"; transform: translateX(0); transition: transform 0.2s ease; }
.lantern:hover .body .more::after { transform: translateX(4px); }
.lantern .body .tail {
  position: absolute; left: 50%; bottom: -12px; transform: translateX(-50%);
  width: 18px; height: 12px;
  background: linear-gradient(180deg, var(--lw-paper-2), transparent);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  filter: drop-shadow(0 4px 8px var(--lw-glow));
}

.empty {
  grid-column: 1 / -1;
  text-align: center; padding: 80px 20px;
  color: var(--lw-ink-soft);
  font-family: var(--lw-serif); font-size: 22px; font-style: italic;
}

/* ─── modal (focus view) ─── */
.modal {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.85);
  backdrop-filter: blur(14px);
  display: none;
  align-items: center; justify-content: center;
  padding: 32px;
  animation: fade 0.25s ease;
}
.modal.shown { display: flex; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.modal .sheet {
  background: radial-gradient(ellipse at 50% 0%, var(--lw-paper-1) 0%, var(--lw-paper-2) 80%);
  color: #2a1608;
  border: 1px solid rgba(255,225,170,0.5);
  box-shadow:
    0 0 80px var(--lw-glow),
    0 0 160px rgba(255,160,80,0.3),
    inset 0 0 60px rgba(255,230,180,0.35);
  border-radius: 14px;
  max-width: 720px; width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  position: relative;
  animation: rise 0.4s cubic-bezier(.2,.8,.2,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(20px) scale(0.96); } to { opacity: 1; transform: none; } }
.modal .close {
  position: absolute; top: 16px; right: 16px; z-index: 5;
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(0,0,0,0.45); color: white; border: 0;
  font-size: 18px; cursor: pointer;
  display: grid; place-items: center;
}
.modal .close:hover { background: rgba(0,0,0,0.7); }
.modal .nav-arrow {
  position: fixed; top: 50%; transform: translateY(-50%);
  width: 48px; height: 48px; border-radius: 50%;
  background: rgba(0,0,0,0.5); color: white; border: 1px solid rgba(255,255,255,0.2);
  cursor: pointer; font-size: 22px;
  display: grid; place-items: center;
  transition: background 0.2s ease;
}
.modal .nav-arrow:hover { background: rgba(0,0,0,0.8); }
.modal .nav-arrow.prev { left: 24px; }
.modal .nav-arrow.next { right: 24px; }
@media (max-width: 600px) { .modal .nav-arrow { width: 40px; height: 40px; }
  .modal .nav-arrow.prev { left: 8px; } .modal .nav-arrow.next { right: 8px; }
}

.modal .media {
  width: 100%;
  background: #1a0e05;
  border-radius: 14px 14px 0 0;
  overflow: hidden;
  position: relative;
}
.modal .media .carousel {
  position: relative;
  width: 100%; height: 50vh;
  overflow: hidden;
}
.modal .media .carousel-track {
  height: 100%;
  display: flex; align-items: center;
}
.modal .media .carousel-slide {
  flex: 0 0 auto;
  height: 100%;
  background: #1a0e05;
  position: relative;
}
.modal .media .carousel-slide img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: contain; display: block;
}
.modal .media .carousel-btn {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 44px; height: 44px; border-radius: 50%;
  background: rgba(0,0,0,0.55); color: white;
  border: 1px solid rgba(255,255,255,0.25);
  cursor: pointer; font-size: 22px;
  display: grid; place-items: center;
  transition: background 0.2s ease;
}
.modal .media .carousel-btn:hover { background: rgba(0,0,0,0.85); }
.modal .media .carousel-btn:focus-visible {
  outline: 2px solid var(--lw-flame); outline-offset: 2px;
}
.modal .media .carousel-btn.prev { left: 12px; }
.modal .media .carousel-btn.next { right: 12px; }
.modal .media .carousel-btn[hidden] { display: none; }
.modal .media .carousel-dots {
  position: absolute; left: 0; right: 0; bottom: 10px;
  display: flex; justify-content: center; gap: 8px;
}
.modal .media .carousel-dots[hidden] { display: none; }
.modal .media .carousel-dots button {
  width: 10px; height: 10px; border-radius: 50%;
  background: rgba(255,255,255,0.35); border: 0; padding: 0;
  cursor: pointer;
}
.modal .media .carousel-dots button[aria-selected="true"] { background: var(--lw-flame); }
.modal .media .carousel-dots button:focus-visible {
  outline: 2px solid var(--lw-flame); outline-offset: 2px;
}
.modal .body { padding: 36px 44px 40px; }
@media (max-width: 600px) { .modal .body { padding: 28px 24px 32px; } }
.modal .stamp {
  display: inline-block;
  font-size: 10px; letter-spacing: 0.32em; text-transform: uppercase;
  color: rgba(58,29,8,0.7);
  margin-bottom: 18px;
  border-bottom: 1px solid rgba(58,29,8,0.3);
  padding-bottom: 6px;
}
.modal h3 {
  font-family: var(--lw-serif); font-weight: 600;
  font-size: 32px; margin: 0 0 6px; line-height: 1.15;
  color: #2a1608;
}
.modal .role {
  font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
  color: rgba(58,29,8,0.7);
  margin-bottom: 22px;
}
.modal .text {
  font-family: var(--lw-serif);
  font-size: 22px; line-height: 1.55;
  color: #2a1608;
  white-space: pre-wrap;
}
.modal .text::first-letter {
  font-size: 56px; float: left; line-height: 0.85;
  padding: 8px 12px 0 0; font-weight: 600;
  color: #6b2a08;
}
.modal .when {
  margin-top: 28px; padding-top: 18px;
  border-top: 1px solid rgba(58,29,8,0.2);
  font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
  color: rgba(58,29,8,0.6);
  display: flex; justify-content: space-between; gap: 16px; align-items: center;
}
.modal .when .pos {
  font-family: var(--lw-serif); font-style: italic; font-size: 14px;
  letter-spacing: 0.02em; text-transform: none; color: rgba(58,29,8,0.7);
}

/* ─── password gate ─── */
.gate {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.85);
  backdrop-filter: blur(14px);
  display: none;
  align-items: center; justify-content: center;
  padding: 32px;
  animation: fade 0.2s ease;
}
.gate.shown { display: flex; }
.gate .card {
  max-width: 420px; width: 100%;
  background: rgba(15,29,49,0.95);
  border: 1px solid var(--lw-line);
  padding: 32px 28px;
  text-align: center;
}
.gate h3 {
  font-family: var(--lw-serif); font-weight: 500; font-size: 24px;
  margin: 0 0 10px;
}
.gate p { color: var(--lw-ink-soft); font-size: 14px; margin: 0 0 22px; }
.gate input[type=password] {
  width: 100%; background: transparent; border: 1px solid var(--lw-line);
  color: var(--lw-ink); font: inherit; font-size: 14px;
  padding: 12px 14px; outline: none; margin-bottom: 12px;
}
.gate input[type=password]:focus { border-color: var(--lw-accent); }
.gate .actions { display: flex; gap: 10px; justify-content: center; }
.gate button {
  font: inherit; font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  padding: 12px 18px; cursor: pointer; font-weight: 600; border: 0;
}
.gate button.go { background: var(--lw-accent); color: #1a1208; }
.gate button.go:hover { filter: brightness(1.06); }
.gate button.cancel {
  background: transparent; color: var(--lw-ink-soft);
  border: 1px solid var(--lw-line);
}
.gate button.cancel:hover { color: var(--lw-accent); border-color: var(--lw-accent); }
.gate .err { color: #d99c8a; font-size: 12px; min-height: 16px; margin: 0 0 12px; }
`;

  function fmtRelative(ts) {
    const diff = Date.now() - ts;
    const m = Math.round(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " minute" + (m === 1 ? "" : "s") + " ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + " hour" + (h === 1 ? "" : "s") + " ago";
    const d = Math.round(h / 24);
    if (d < 7) return d + " day" + (d === 1 ? "" : "s") + " ago";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function parseSqliteTs(s) {
    if (!s) return Date.now();
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  class LanternWall extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.entries = [];
      this.sort = "newest";
      this.focusIndex = -1;
      this._loaded = false;
      this._loadError = "";
      this._submitting = false;
      this._formError = "";
      this._pendingMedia = [];
      this._carouselCleanup = null;
    }

    get _endpoint() {
      return this.getAttribute("endpoint") || "/api/lanterns";
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>${css}</style>
        <form class="form" id="form" novalidate>
          <div class="banner error" id="formError" style="display:none" role="alert"></div>
          <label for="lname">From</label>
          <input id="lname" type="text" name="name" placeholder="Your name" maxlength="${NAME_MAX}" required>
          <label for="lrole">Your relationship to Melvin <span style="color:var(--lw-ink-soft);opacity:0.6;text-transform:none;letter-spacing:0;font-size:11px">(optional)</span></label>
          <input id="lrole" type="text" name="role" placeholder="e.g. Son · Friend · Hayward Fire Department crew" maxlength="${ROLE_MAX}">
          <label for="lmsg">Your message</label>
          <textarea id="lmsg" name="msg" placeholder="A memory, a thank-you, a goodbye. As long as you'd like." maxlength="${MSG_MAX}" required></textarea>
          <div class="preview" id="preview"></div>
          <div class="row">
            <div class="meta">
              <button type="button" class="attach" id="attachBtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                Photos
              </button>
              <span class="optional">(up to ${MEDIA_MAX_COUNT}, optional)</span>
              <input type="file" id="attachInput" accept="image/png,image/jpeg,image/webp,image/avif" multiple>
              <span class="count"><span id="lcount">0</span> / ${MSG_MAX}</span>
            </div>
            <button type="submit" class="submit" id="submitBtn">Light a Lantern</button>
          </div>
        </form>

        <div class="wall">
          <div class="controls">
            <span class="count-pill"><span class="dot"></span> <span id="totalCount">0</span> lanterns lit</span>
            <div class="sort">
              <button type="button" data-sort="newest" class="active">Newest</button>
              <button type="button" data-sort="oldest">Oldest</button>
              <button type="button" data-sort="random">Drift</button>
            </div>
          </div>
          <div class="grid" id="grid"></div>
        </div>

        <div class="modal" id="modal" role="dialog" aria-modal="true">
          <button class="nav-arrow prev" id="navPrev" aria-label="Previous">‹</button>
          <div class="sheet" id="sheet">
            <button class="close" id="closeBtn" aria-label="Close">×</button>
            <div class="media" id="media" style="display:none" role="region" aria-roledescription="carousel" aria-label="Photos"></div>
            <div class="body">
              <div class="stamp">A Message for Melvin</div>
              <h3 id="mName"></h3>
              <div class="role" id="mRole"></div>
              <div class="text" id="mText"></div>
              <div class="when">
                <span id="mWhen"></span>
                <span class="pos" id="mPos"></span>
              </div>
            </div>
          </div>
          <button class="nav-arrow next" id="navNext" aria-label="Next">›</button>
        </div>

        <div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
          <div class="card">
            <h3 id="gateTitle">Family password</h3>
            <p>This wall is for family and close friends. Enter the password you were given to light a lantern.</p>
            <form id="gateForm" autocomplete="off">
              <input id="gateInput" type="password" autocomplete="off" required placeholder="Password">
              <div class="err" id="gateErr" role="alert"></div>
              <div class="actions">
                <button type="button" class="cancel" id="gateCancel">Cancel</button>
                <button type="submit" class="go">Continue</button>
              </div>
            </form>
          </div>
        </div>
      `;
      this.bind();
      this.fetchEntries();
    }

    async fetchEntries() {
      const r = this.shadowRoot;
      const grid = r.getElementById("grid");
      grid.innerHTML = `<div class="empty">Loading…</div>`;
      try {
        const res = await fetch(this._endpoint, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("server_" + res.status);
        const data = await res.json();
        const list = Array.isArray(data?.lanterns) ? data.lanterns : [];
        this.entries = list.map((row) => normalizeEntry(row));
      } catch (err) {
        console.error("lantern_load_failed", err);
        this._loadError = "Couldn't load the wall. Refresh the page to try again.";
      }
      this._loaded = true;
      this.render();
    }

    bind() {
      const r = this.shadowRoot;
      const form = r.getElementById("form");
      const msg = r.getElementById("lmsg");
      const counter = r.getElementById("lcount");
      const attachBtn = r.getElementById("attachBtn");
      const attachInput = r.getElementById("attachInput");
      const preview = r.getElementById("preview");

      msg.addEventListener("input", () => { counter.textContent = msg.value.length; });

      attachBtn.addEventListener("click", () => attachInput.click());

      attachInput.addEventListener("change", () => {
        const incoming = Array.from(attachInput.files || []);
        attachInput.value = "";
        if (!incoming.length) return;
        if (this._pendingMedia.length + incoming.length > MEDIA_MAX_COUNT) {
          this._showFormError(`Up to ${MEDIA_MAX_COUNT} photos per lantern.`);
          return;
        }
        for (const file of incoming) {
          if (!MEDIA_MIMES.includes(file.type)) {
            this._showFormError("Photos only — PNG, JPEG, WebP, or AVIF.");
            return;
          }
          if (file.size > MEDIA_MAX_BYTES) {
            this._showFormError("Each photo must be 8 MB or smaller.");
            return;
          }
        }
        this._showFormError("");
        for (const file of incoming) this._pendingMedia.push(file);
        this._renderPreview();
      });

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this._submit();
      });

      r.querySelectorAll("[data-sort]").forEach((btn) => {
        btn.addEventListener("click", () => {
          r.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("active", b === btn));
          this.sort = btn.dataset.sort;
          this.render();
        });
      });

      r.getElementById("closeBtn").addEventListener("click", () => this.close());
      r.getElementById("modal").addEventListener("click", (e) => {
        if (e.target === r.getElementById("modal")) this.close();
      });
      r.getElementById("navPrev").addEventListener("click", () => this.shift(-1));
      r.getElementById("navNext").addEventListener("click", () => this.shift(1));

      document.addEventListener("keydown", (e) => {
        if (!r.getElementById("modal").classList.contains("shown")) return;
        if (e.key === "Escape") return this.close();
        if (e.key === "ArrowLeft") {
          if (this._carouselNav && this._carouselNav(-1)) return;
          this.shift(-1);
        } else if (e.key === "ArrowRight") {
          if (this._carouselNav && this._carouselNav(1)) return;
          this.shift(1);
        }
      });

      // Password gate
      const gate = r.getElementById("gate");
      const gateForm = r.getElementById("gateForm");
      const gateInput = r.getElementById("gateInput");
      const gateErr = r.getElementById("gateErr");
      const gateCancel = r.getElementById("gateCancel");

      this._gate = {
        open: () => {
          gateErr.textContent = "";
          gateInput.value = "";
          gate.classList.add("shown");
          setTimeout(() => gateInput.focus(), 0);
        },
        close: () => gate.classList.remove("shown"),
        setError: (m) => { gateErr.textContent = m || ""; },
      };

      gateForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = gateInput.value.trim();
        if (!v) return;
        sessionStorage.setItem(POST_PW_KEY, v);
        this._gate.close();
        this._submit();
      });

      gateCancel.addEventListener("click", () => this._gate.close());
    }

    _showFormError(message) {
      const banner = this.shadowRoot.getElementById("formError");
      this._formError = message || "";
      if (this._formError) {
        banner.textContent = this._formError;
        banner.style.display = "";
      } else {
        banner.textContent = "";
        banner.style.display = "none";
      }
    }

    _setSubmitting(flag) {
      this._submitting = flag;
      const r = this.shadowRoot;
      const btn = r.getElementById("submitBtn");
      btn.disabled = !!flag;
      btn.textContent = flag ? "Sending…" : "Light a Lantern";
    }

    _renderPreview() {
      const preview = this.shadowRoot.getElementById("preview");
      [...preview.querySelectorAll("img")].forEach((n) => {
        if (n.src && n.src.startsWith("blob:")) URL.revokeObjectURL(n.src);
      });
      preview.innerHTML = "";
      if (!this._pendingMedia.length) {
        preview.classList.remove("shown");
        return;
      }
      preview.classList.add("shown");
      this._pendingMedia.forEach((file, idx) => {
        const item = document.createElement("div");
        item.className = "item";
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.alt = "";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "clear";
        btn.setAttribute("aria-label", `Remove photo ${idx + 1}`);
        btn.textContent = "×";
        btn.addEventListener("click", () => {
          this._pendingMedia.splice(idx, 1);
          this._renderPreview();
        });
        item.appendChild(img);
        item.appendChild(btn);
        preview.appendChild(item);
      });
    }

    _clearPreview() {
      const preview = this.shadowRoot.getElementById("preview");
      [...preview.querySelectorAll("img")].forEach((n) => {
        if (n.src && n.src.startsWith("blob:")) URL.revokeObjectURL(n.src);
      });
      preview.innerHTML = "";
      preview.classList.remove("shown");
      this._pendingMedia = [];
    }

    async _submit() {
      if (this._submitting) return;
      const r = this.shadowRoot;
      const name = r.getElementById("lname").value.trim();
      const role = r.getElementById("lrole").value.trim();
      const msg = r.getElementById("lmsg").value.trim();

      if (!name) return this._showFormError("Please enter your name.");
      if (name.length > NAME_MAX) return this._showFormError(`Name is too long (max ${NAME_MAX}).`);
      if (role.length > ROLE_MAX) return this._showFormError(`Relationship is too long (max ${ROLE_MAX}).`);
      if (!msg) return this._showFormError("Please write a message.");
      if (msg.length > MSG_MAX) return this._showFormError(`Message is too long (max ${MSG_MAX}).`);

      const password = sessionStorage.getItem(POST_PW_KEY) || "";
      if (!password) {
        this._showFormError("");
        this._gate.open();
        return;
      }

      const fd = new FormData();
      fd.append("name", name);
      if (role) fd.append("role", role);
      fd.append("msg", msg);
      for (const f of this._pendingMedia) fd.append("media", f, f.name);

      this._showFormError("");
      this._setSubmitting(true);

      let res;
      try {
        res = await fetch(this._endpoint, {
          method: "POST",
          headers: { "X-Post-Password": password },
          body: fd,
        });
      } catch {
        this._setSubmitting(false);
        return this._showFormError("Couldn't reach the server. Please try again.");
      }

      if (res.status === 401) {
        sessionStorage.removeItem(POST_PW_KEY);
        this._setSubmitting(false);
        this._gate.open();
        this._gate.setError("That password isn't right.");
        return;
      }

      let body = null;
      try { body = await res.json(); } catch {}

      if (!res.ok) {
        this._setSubmitting(false);
        return this._showFormError(body?.error || "Something looked off with that submission.");
      }

      const created = body?.lantern ? normalizeEntry(body.lantern) : null;
      if (created) this.entries.unshift(created);

      // Clear form
      r.getElementById("form").reset();
      r.getElementById("lcount").textContent = "0";
      this._clearPreview();

      this._setSubmitting(false);

      this.render();
      this.openByIndex(0);
    }

    sortedEntries() {
      const arr = [...this.entries];
      if (this.sort === "newest") arr.sort((a, b) => b.ts - a.ts);
      else if (this.sort === "oldest") arr.sort((a, b) => a.ts - b.ts);
      else if (this.sort === "random") {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      }
      return arr;
    }

    render() {
      const r = this.shadowRoot;
      const grid = r.getElementById("grid");
      r.getElementById("totalCount").textContent = this.entries.length;
      const list = this.sortedEntries();
      this._currentList = list;

      if (this._loadError && !this.entries.length) {
        grid.innerHTML = `<div class="empty">${escapeHtml(this._loadError)}</div>`;
        return;
      }
      if (!list.length) {
        grid.innerHTML = `<div class="empty">${this._loaded ? "Be the first to light a lantern." : "Loading…"}</div>`;
        return;
      }

      grid.innerHTML = list.map((e, i) => {
        const hasMedia = e.media.length > 0;
        const overflow = e.msg.length > 200 || hasMedia;
        const thumb = hasMedia
          ? `<div class="thumb">
               <img src="${escapeHtml(e.media[0].src)}" alt="">
               ${e.media.length > 1 ? `<span class="more">+${e.media.length - 1}</span>` : ""}
             </div>`
          : "";
        return `
          <div class="lantern" data-i="${i}" tabindex="0" role="button">
            <div class="body">
              ${thumb}
              <div class="name">${escapeHtml(e.name)}</div>
              ${e.role ? `<div class="role">${escapeHtml(e.role)}</div>` : `<div class="role">&nbsp;</div>`}
              <div class="text">${escapeHtml(e.msg)}</div>
              <div class="more ${overflow ? "has-overflow" : ""}">${overflow ? "Read in full" : "Open"}</div>
              <div class="tail"></div>
            </div>
          </div>
        `;
      }).join("");

      grid.querySelectorAll(".lantern").forEach((el) => {
        const open = () => this.openByIndex(parseInt(el.dataset.i, 10));
        el.addEventListener("click", open);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
      });
    }

    openByIndex(i) {
      if (!this._currentList) this._currentList = this.sortedEntries();
      const list = this._currentList;
      if (!list.length) return;
      this.focusIndex = ((i % list.length) + list.length) % list.length;
      const e = list[this.focusIndex];
      const r = this.shadowRoot;
      r.getElementById("mName").textContent = e.name;
      r.getElementById("mRole").textContent = e.role || "";
      r.getElementById("mRole").style.display = e.role ? "" : "none";
      r.getElementById("mText").textContent = e.msg;
      r.getElementById("mWhen").textContent = fmtRelative(e.ts);
      r.getElementById("mPos").textContent = (this.focusIndex + 1) + " of " + list.length;

      this._renderMedia(e.media);
      r.getElementById("modal").classList.add("shown");
      r.getElementById("sheet").scrollTop = 0;
      document.body.style.overflow = "hidden";
    }

    _renderMedia(items) {
      const media = this.shadowRoot.getElementById("media");
      if (this._carouselCleanup) {
        this._carouselCleanup();
        this._carouselCleanup = null;
      }
      media.innerHTML = "";
      if (!items || !items.length) {
        media.style.display = "none";
        return;
      }
      media.style.display = "block";

      const track = document.createElement("div");
      track.className = "carousel-track";
      track.style.width = `${items.length * 100}%`;
      items.forEach((m, i) => {
        const slide = document.createElement("div");
        slide.className = "carousel-slide";
        slide.style.width = `${100 / items.length}%`;
        slide.setAttribute("role", "group");
        slide.setAttribute("aria-roledescription", "slide");
        slide.setAttribute("aria-label", `${i + 1} of ${items.length}`);
        const img = document.createElement("img");
        img.src = m.src;
        img.alt = "";
        slide.appendChild(img);
        track.appendChild(slide);
      });

      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "carousel-btn prev";
      prev.setAttribute("aria-label", "Previous photo");
      prev.textContent = "‹";

      const next = document.createElement("button");
      next.type = "button";
      next.className = "carousel-btn next";
      next.setAttribute("aria-label", "Next photo");
      next.textContent = "›";

      const dots = document.createElement("div");
      dots.className = "carousel-dots";
      dots.setAttribute("role", "tablist");
      const dotButtons = items.map((_, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("aria-label", `Photo ${i + 1}`);
        b.setAttribute("aria-selected", i === 0 ? "true" : "false");
        dots.appendChild(b);
        return b;
      });

      const single = items.length <= 1;
      if (single) {
        prev.hidden = true;
        next.hidden = true;
        dots.hidden = true;
      }

      let index = 0;
      const stepPct = 100 / items.length;
      const goTo = (i) => {
        index = ((i % items.length) + items.length) % items.length;
        track.style.transform = `translateX(-${index * stepPct}%)`;
        dotButtons.forEach((d, di) => {
          d.setAttribute("aria-selected", di === index ? "true" : "false");
        });
      };
      goTo(0);
      track.style.transition = "transform 0.25s ease";

      prev.addEventListener("click", () => goTo(index - 1));
      next.addEventListener("click", () => goTo(index + 1));
      dotButtons.forEach((d, i) => d.addEventListener("click", () => goTo(i)));

      if (!single) {
        this._carouselNav = (dir) => { goTo(index + dir); return true; };
      } else {
        this._carouselNav = null;
      }
      this._carouselCleanup = () => { this._carouselNav = null; };

      const carousel = document.createElement("div");
      carousel.className = "carousel";
      carousel.appendChild(track);
      carousel.appendChild(prev);
      carousel.appendChild(next);
      carousel.appendChild(dots);
      media.appendChild(carousel);
    }

    shift(dir) {
      if (!this._currentList || !this._currentList.length) return;
      this.openByIndex(this.focusIndex + dir);
    }

    close() {
      const r = this.shadowRoot;
      r.getElementById("modal").classList.remove("shown");
      document.body.style.overflow = "";
      if (this._carouselCleanup) {
        this._carouselCleanup();
        this._carouselCleanup = null;
      }
    }
  }

  function normalizeEntry(row) {
    const ts = parseSqliteTs(row.created_at);
    const media = Array.isArray(row.media)
      ? row.media
          .filter((m) => m && m.key)
          .map((m) => ({ src: "/media/" + m.key, type: m.type || "image/jpeg" }))
      : [];
    return {
      id: row.id,
      name: row.name || "",
      role: row.role || "",
      msg: row.msg || "",
      ts,
      media,
    };
  }

  if (!customElements.get("lantern-wall")) {
    customElements.define("lantern-wall", LanternWall);
  }
})();
