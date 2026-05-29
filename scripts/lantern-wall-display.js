// Standalone display script for lantern-wall.html.
// Renders every lantern in a single horizontal row sized to fill the viewport
// top-to-bottom. The wall autoplays as a slow seamless marquee, but the user
// can drag, swipe, scroll-wheel, or use keyboard arrows to move it manually.
// A floating control bar offers play/pause and speed −/+. Carousels in each
// lantern auto-advance at independent random intervals.

(function () {
  const ENDPOINT = "/api/lanterns";
  const POLL_MS = 60_000;
  const SLIDE_MIN_MS = 4000;
  const SLIDE_MAX_MS = 9000;
  const ASPECT = 0.62;

  // Speed model: discrete tiers in px/sec. Default is the second-slowest so
  // there's room to step further down.
  const SPEEDS = [10, 20, 40, 60, 100, 160];
  const DEFAULT_SPEED_INDEX = 1;        // 20 px/s
  const SPEED_KEY = "lantern-wall::speed";
  const PAUSED_KEY = "lantern-wall::paused";
  const MANUAL_RESUME_MS = 2500;        // autoplay yields this long after a manual nudge
  const CONTROLS_HIDE_MS = 4000;        // controls fade out this long after last input

  const track = document.getElementById("track");
  const marquee = document.getElementById("marquee");
  const controls = document.getElementById("controls");
  const playBtn = document.getElementById("playBtn");
  const playIcon = document.getElementById("playIcon");
  const speedDown = document.getElementById("speedDown");
  const speedUp = document.getElementById("speedUp");
  const speedLabel = document.getElementById("speedLabel");

  let entries = [];
  let carousels = [];
  let oneCopyW = 0;            // one full copy of the lantern row, in px
  let speedIdx = loadSpeedIndex();
  let paused = loadPaused();
  let lastTs = 0;
  let manualUntil = 0;         // timestamp until which autoplay should stay yielded
  let rafId = null;
  let layoutPending = false;

  init();

  function init() {
    applySpeedToUI();
    applyPausedToUI();
    bindControls();
    bindManualScroll();

    refresh(true).catch((err) => {
      console.error("lantern_wall_initial_load_failed", err);
      track.innerHTML = `<div class="empty">Couldn't reach the wall just now. We'll keep trying.</div>`;
    });

    setInterval(() => {
      refresh(false).catch((err) => console.error("lantern_wall_refresh_failed", err));
    }, POLL_MS);
    window.addEventListener("resize", scheduleLayout);

    rafId = requestAnimationFrame(tick);
  }

  // ─── data ───────────────────────────────────────────────────────────────

  async function refresh(isInitial) {
    const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("server_" + res.status);
    const data = await res.json();
    const list = Array.isArray(data?.lanterns) ? data.lanterns : [];
    const next = list.map(normalize);
    if (!isInitial && sameSet(entries, next)) return;
    entries = isInitial ? shuffle(next) : mergeOrder(entries, next);
    rebuild();
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const ids = new Set(a.map((e) => e.id));
    for (const e of b) if (!ids.has(e.id)) return false;
    return true;
  }

  function mergeOrder(prev, next) {
    const byId = new Map(next.map((e) => [e.id, e]));
    const out = [];
    const seen = new Set();
    for (const e of prev) {
      if (byId.has(e.id)) { out.push(byId.get(e.id)); seen.add(e.id); }
    }
    for (const e of next) {
      if (!seen.has(e.id)) out.push(e);
    }
    return out;
  }

  // ─── render ─────────────────────────────────────────────────────────────

  function rebuild() {
    for (const c of carousels) c.clear();
    carousels = [];
    track.innerHTML = "";

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Be the first to light a lantern.";
      track.appendChild(empty);
      oneCopyW = 0;
      return;
    }

    const copyA = entries.map(renderLantern);
    const copyB = entries.map(renderLantern);
    for (const el of copyA) track.appendChild(el);
    for (const el of copyB) track.appendChild(el);

    entries.forEach((e, i) => {
      if (e.media.length > 1) {
        carousels.push(startCarousel(copyA[i], e.media.length));
        carousels.push(startCarousel(copyB[i], e.media.length, /* offset */ true));
      }
    });

    scheduleLayout();
  }

  function renderLantern(e) {
    const wrap = document.createElement("article");
    wrap.className = "lantern";
    wrap.dataset.id = e.id;

    const body = document.createElement("div");
    body.className = "body";

    if (e.media.length) {
      const photo = document.createElement("div");
      photo.className = "photo";
      e.media.forEach((m, i) => {
        const slide = document.createElement("div");
        slide.className = "slide" + (i === 0 ? " is-active" : "");
        const img = document.createElement("img");
        img.src = m.src;
        img.alt = "";
        img.loading = "lazy";
        slide.appendChild(img);
        photo.appendChild(slide);
      });
      if (e.media.length > 1) {
        const dots = document.createElement("div");
        dots.className = "dots";
        e.media.forEach((_, i) => {
          const dot = document.createElement("span");
          dot.className = "dot" + (i === 0 ? " is-active" : "");
          dots.appendChild(dot);
        });
        photo.appendChild(dots);
      }
      body.appendChild(photo);
    }

    const name = document.createElement("h3");
    name.className = "name";
    name.textContent = e.name;
    body.appendChild(name);

    const role = document.createElement("div");
    role.className = "role";
    role.textContent = e.role || "";
    body.appendChild(role);

    const text = document.createElement("p");
    text.className = "text";
    text.textContent = e.msg;
    body.appendChild(text);

    wrap.appendChild(body);
    return wrap;
  }

  function scheduleLayout() {
    if (layoutPending) return;
    layoutPending = true;
    requestAnimationFrame(() => {
      layoutPending = false;
      layout();
    });
  }

  function layout() {
    const titleH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--title-h")) || 96;
    const lanternH = Math.max(240, window.innerHeight - titleH - 24);
    const lanternW = Math.round(lanternH * ASPECT);
    document.documentElement.style.setProperty("--lantern-h", `${lanternH}px`);
    document.documentElement.style.setProperty("--lantern-w", `${lanternW}px`);

    requestAnimationFrame(() => {
      const lanterns = track.querySelectorAll(".lantern");
      const half = entries.length;
      if (lanterns.length >= half * 2 && half > 0) {
        const aRect = lanterns[0].getBoundingClientRect();
        const bRect = lanterns[half].getBoundingClientRect();
        oneCopyW = bRect.left - aRect.left;
      } else {
        oneCopyW = track.scrollWidth / 2;
      }
      track.querySelectorAll(".lantern").forEach(fitMessageText);
      // Keep current scroll position within the first copy for stability.
      if (oneCopyW > 0) {
        marquee.scrollLeft = ((marquee.scrollLeft % oneCopyW) + oneCopyW) % oneCopyW;
      }
    });
  }

  function fitMessageText(lanternEl) {
    const textEl = lanternEl.querySelector(".text");
    if (!textEl) return;
    let size = 18;
    textEl.style.fontSize = `${size}px`;
    while (size > 10 && textEl.scrollHeight > textEl.clientHeight + 1) {
      size -= 1;
      textEl.style.fontSize = `${size}px`;
    }
  }

  // ─── autoplay loop ──────────────────────────────────────────────────────

  function tick(ts) {
    if (lastTs && oneCopyW > 0) {
      const dt = (ts - lastTs) / 1000;
      const yielding = ts < manualUntil;
      if (!paused && !yielding && dt > 0 && dt < 0.5) {
        const px = SPEEDS[speedIdx] * dt;
        marquee.scrollLeft += px;
      }
      // Wrap so we can scroll forever within copy A's [0, oneCopyW) range.
      if (marquee.scrollLeft >= oneCopyW) {
        marquee.scrollLeft -= oneCopyW;
      } else if (marquee.scrollLeft < 0) {
        marquee.scrollLeft += oneCopyW;
      }
    }
    lastTs = ts;
    rafId = requestAnimationFrame(tick);
  }

  // ─── controls ───────────────────────────────────────────────────────────

  function bindControls() {
    playBtn.addEventListener("click", () => setPaused(!paused));
    speedDown.addEventListener("click", () => stepSpeed(-1));
    speedUp.addEventListener("click", () => stepSpeed(1));

    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); setPaused(!paused); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); stepSpeed(1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); stepSpeed(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nudge(window.innerWidth * 0.3); }
      else if (e.key === "ArrowLeft")  { e.preventDefault(); nudge(-window.innerWidth * 0.3); }
    });

    // Auto-hide the control bar when idle. Show on any user input.
    let hideTimer = null;
    const wake = () => {
      controls.classList.remove("is-hidden");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => controls.classList.add("is-hidden"), CONTROLS_HIDE_MS);
    };
    wake();
    ["mousemove", "touchstart", "wheel", "keydown", "pointerdown"].forEach((ev) => {
      window.addEventListener(ev, wake, { passive: true });
    });
    controls.addEventListener("mouseenter", () => {
      controls.classList.remove("is-hidden");
      clearTimeout(hideTimer);
    });
    controls.addEventListener("mouseleave", wake);
  }

  function setPaused(next) {
    paused = !!next;
    try { sessionStorage.setItem(PAUSED_KEY, paused ? "1" : "0"); } catch {}
    applyPausedToUI();
  }

  function applyPausedToUI() {
    if (paused) {
      playBtn.setAttribute("aria-label", "Play");
      // ▶ play triangle
      playIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
    } else {
      playBtn.setAttribute("aria-label", "Pause");
      playIcon.innerHTML = `<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>`;
    }
  }

  function stepSpeed(dir) {
    speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, speedIdx + dir));
    try { sessionStorage.setItem(SPEED_KEY, String(speedIdx)); } catch {}
    applySpeedToUI();
  }

  function applySpeedToUI() {
    speedLabel.textContent = `${SPEEDS[speedIdx]} px/s`;
    speedDown.disabled = speedIdx === 0;
    speedUp.disabled = speedIdx === SPEEDS.length - 1;
  }

  function loadSpeedIndex() {
    try {
      const raw = sessionStorage.getItem(SPEED_KEY);
      const n = raw == null ? NaN : parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n < SPEEDS.length) return n;
    } catch {}
    return DEFAULT_SPEED_INDEX;
  }

  function loadPaused() {
    // Default: paused if reduced-motion is on, otherwise playing.
    try {
      const raw = sessionStorage.getItem(PAUSED_KEY);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {}
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // ─── manual scroll ──────────────────────────────────────────────────────

  function bindManualScroll() {
    // Wheel handling — translate vertical wheel into horizontal motion so a
    // mouse wheel works without holding shift, and yield autoplay on any
    // wheel event (including native horizontal touchpad swipes) so we don't
    // fight the user's input.
    marquee.addEventListener("wheel", (e) => {
      manualUntil = performance.now() + MANUAL_RESUME_MS;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // let native horizontal scroll happen
      e.preventDefault();
      nudge(e.deltaY);
    }, { passive: false });

    // Pointer drag (mouse & touch via Pointer Events).
    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    let pointerId = null;

    marquee.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true;
      pointerId = e.pointerId;
      startX = e.clientX;
      startScroll = marquee.scrollLeft;
      marquee.classList.add("is-grabbing");
      // Yield autoplay while the finger/mouse is down — feels much steadier.
      manualUntil = performance.now() + 1e9;
      try { marquee.setPointerCapture(pointerId); } catch {}
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      marquee.classList.remove("is-grabbing");
      try { if (pointerId != null) marquee.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      // Now arm the regular brief yield.
      manualUntil = performance.now() + MANUAL_RESUME_MS;
    };
    marquee.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.preventDefault();
      marquee.scrollLeft = startScroll - (e.clientX - startX);
    });
    marquee.addEventListener("pointerup", endDrag);
    marquee.addEventListener("pointercancel", endDrag);
    marquee.addEventListener("pointerleave", endDrag);

    // Native horizontal scroll (two-finger swipe, scrollbar drag, swipe on
    // touch) bubbles through automatically because .marquee has overflow-x:
    // auto. The wheel/pointer handlers above are responsible for arming the
    // manual-yield timer; the loop just stops contributing during it.
  }

  // Move scroll by `dx` and yield autoplay briefly.
  function nudge(dx) {
    if (!oneCopyW) return;
    marquee.scrollLeft += dx;
    manualUntil = performance.now() + MANUAL_RESUME_MS;
  }

  // ─── carousels ──────────────────────────────────────────────────────────

  function startCarousel(el, count, offset = false) {
    if (count <= 1) return { clear() {} };
    const slides = el.querySelectorAll(".photo .slide");
    const dots = el.querySelectorAll(".photo .dot");
    let i = 0;

    const tick = () => {
      slides[i].classList.remove("is-active");
      if (dots[i]) dots[i].classList.remove("is-active");
      i = (i + 1) % slides.length;
      slides[i].classList.add("is-active");
      if (dots[i]) dots[i].classList.add("is-active");
      timer = setTimeout(tick, randInterval());
    };

    let timer = setTimeout(tick, randInterval(true) + (offset ? 1500 : 0));
    return { clear() { clearTimeout(timer); } };
  }

  function randInterval(initial = false) {
    const base = SLIDE_MIN_MS + Math.random() * (SLIDE_MAX_MS - SLIDE_MIN_MS);
    return initial ? Math.random() * SLIDE_MAX_MS : base;
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  function normalize(row) {
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
      media,
    };
  }

  function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
})();
