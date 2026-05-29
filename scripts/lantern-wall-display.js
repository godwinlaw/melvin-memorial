// Standalone display script for lantern-wall.html.
// Fetches /api/lanterns, lays them out in a single horizontal row sized to fill
// the viewport top-to-bottom, then loops the row left at a slow constant speed
// so the whole wall can be read by waiting. Lanterns are ordered so long
// messages and short messages alternate (longest weaves with shortest), giving
// the marquee a balanced visual rhythm. Per-lantern photo carousels auto-
// advance at independent random intervals so they never sync. Polls every
// 60s and re-balances the order whenever the set changes.

(function () {
  const ENDPOINT = "/api/lanterns";
  const POLL_MS = 60_000;
  const SLIDE_MIN_MS = 4000;
  const SLIDE_MAX_MS = 9000;
  const SCROLL_PX_PER_SEC = 15;   // marquee speed
  const ASPECT = 0.62;            // lantern width / height — portrait card

  const track = document.getElementById("track");
  const marquee = document.getElementById("marquee");
  let entries = [];
  let carousels = [];
  let layoutPending = false;

  init();

  async function init() {
    try {
      await refresh(true);
    } catch (err) {
      console.error("lantern_wall_initial_load_failed", err);
      track.innerHTML = `<div class="empty">Couldn't reach the wall just now. We'll keep trying.</div>`;
    }
    setInterval(() => {
      refresh(false).catch((err) => console.error("lantern_wall_refresh_failed", err));
    }, POLL_MS);
    window.addEventListener("resize", scheduleLayout);
  }

  async function refresh(isInitial) {
    const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("server_" + res.status);
    const data = await res.json();
    const list = Array.isArray(data?.lanterns) ? data.lanterns : [];

    const next = list.map(normalize);
    if (!isInitial && sameSet(entries, next)) return; // nothing changed

    entries = balanceByLength(next);
    rebuild();
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const ids = new Set(a.map((e) => e.id));
    for (const e of b) if (!ids.has(e.id)) return false;
    return true;
  }

  // Order lanterns so long messages and short messages alternate, giving the
  // marquee a balanced visual rhythm instead of clusters of dense text.
  // Strategy: sort by word count descending (id tiebreak for stability across
  // reloads), then weave longest / shortest from the ends inward — produces
  // [L1, S1, L2, S2, L3, S3, ...] with the median lantern at the end.
  function balanceByLength(list) {
    const sorted = [...list].sort((a, b) => {
      const wa = wordCount(a.msg);
      const wb = wordCount(b.msg);
      if (wa !== wb) return wb - wa;
      return String(a.id).localeCompare(String(b.id));
    });
    const out = [];
    let lo = 0;
    let hi = sorted.length - 1;
    let takeLong = true;
    while (lo <= hi) {
      if (takeLong) out.push(sorted[lo++]);
      else          out.push(sorted[hi--]);
      takeLong = !takeLong;
    }
    return out;
  }

  function wordCount(s) {
    const t = (s || "").trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  function rebuild() {
    for (const c of carousels) c.clear();
    carousels = [];
    track.innerHTML = "";

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Be the first to light a lantern.";
      track.appendChild(empty);
      track.style.removeProperty("--track-w");
      track.style.removeProperty("--dur");
      return;
    }

    // Render two copies back-to-back so translateX(-trackWidth) loops seamlessly.
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
      // The seamless loop translates by exactly the distance between the first
      // child of copy A and the first child of copy B. Measuring that distance
      // (instead of dividing scrollWidth by 2) accounts for track padding/gap
      // correctly so the loop has no jump.
      const lanterns = track.querySelectorAll(".lantern");
      const half = entries.length;
      let shift = 0;
      if (lanterns.length >= half * 2) {
        const aRect = lanterns[0].getBoundingClientRect();
        const bRect = lanterns[half].getBoundingClientRect();
        shift = bRect.left - aRect.left;
      } else {
        shift = track.scrollWidth / 2;
      }
      track.style.setProperty("--track-w", `${shift}px`);
      const seconds = Math.max(20, shift / SCROLL_PX_PER_SEC);
      track.style.setProperty("--dur", `${seconds.toFixed(1)}s`);

      // Auto-shrink message text per lantern so the full message fits.
      track.querySelectorAll(".lantern").forEach(fitMessageText);
    });
  }

  function fitMessageText(lanternEl) {
    const textEl = lanternEl.querySelector(".text");
    if (!textEl) return;
    let size = 18;
    textEl.style.fontSize = `${size}px`;
    const overflow = () => textEl.scrollHeight > textEl.clientHeight + 1;
    while (size > 10 && overflow()) {
      size -= 1;
      textEl.style.fontSize = `${size}px`;
    }
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

})();
