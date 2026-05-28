// Standalone display script for lantern-wall.html.
// Fetches /api/lanterns, renders each lantern in place with a randomized drift,
// shows the full message, and auto-advances per-lantern photo carousels at
// independent random intervals so they never sync. Polls every 60s and merges
// new entries without re-shuffling existing ones.

(function () {
  const ENDPOINT = "/api/lanterns";
  const POLL_MS = 60_000;
  const SLIDE_MIN_MS = 4000;
  const SLIDE_MAX_MS = 9000;

  const grid = document.getElementById("grid");
  const seen = new Map();   // id -> { entry, el, intervalId }
  let order = [];           // ids in render order

  init();

  async function init() {
    try {
      await refresh(true);
    } catch (err) {
      console.error("lantern_wall_initial_load_failed", err);
      grid.innerHTML = `<div class="empty">Couldn't reach the wall just now. We'll keep trying.</div>`;
    }
    setInterval(() => {
      refresh(false).catch((err) => console.error("lantern_wall_refresh_failed", err));
    }, POLL_MS);
  }

  async function refresh(isInitial) {
    const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("server_" + res.status);
    const data = await res.json();
    const list = Array.isArray(data?.lanterns) ? data.lanterns : [];

    if (isInitial) {
      grid.innerHTML = "";
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Be the first to light a lantern.";
        grid.appendChild(empty);
        return;
      }
      // Stable shuffle so the wall feels scattered but consistent across polls.
      const shuffled = shuffle(list);
      for (const row of shuffled) addLantern(row);
      order = shuffled.map((r) => r.id);
      return;
    }

    // Incremental: add only new lanterns; drop removed ones.
    const incomingIds = new Set(list.map((r) => r.id));
    for (const id of [...seen.keys()]) {
      if (!incomingIds.has(id)) removeLantern(id);
    }
    const fresh = list.filter((r) => !seen.has(r.id));
    if (fresh.length) {
      // Insert new ones at the start so they show up promptly on a TV.
      for (const row of fresh.reverse()) {
        addLantern(row, /* prepend */ true);
      }
    }

    // If we used to be empty, drop the placeholder.
    const placeholder = grid.querySelector(".empty");
    if (placeholder && seen.size > 0) placeholder.remove();
  }

  function addLantern(row, prepend = false) {
    const entry = normalize(row);
    const el = renderLantern(entry);
    if (prepend && grid.firstChild) {
      grid.insertBefore(el, grid.firstChild);
    } else {
      grid.appendChild(el);
    }
    const carousel = startCarousel(el, entry.media.length);
    seen.set(entry.id, { entry, el, carousel });
    order.push(entry.id);
  }

  function removeLantern(id) {
    const slot = seen.get(id);
    if (!slot) return;
    if (slot.carousel) slot.carousel.clear();
    if (slot.el && slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
    seen.delete(id);
    order = order.filter((x) => x !== id);
  }

  function renderLantern(e) {
    const wrap = document.createElement("article");
    wrap.className = "lantern";
    // Per-lantern animation params — independent so the wall doesn't pulse.
    const dur = (5.5 + Math.random() * 3.5).toFixed(2) + "s";
    const delay = (-Math.random() * 6).toFixed(2) + "s";
    const shiftX = (Math.random() * 8 - 4).toFixed(1) + "px";
    const tilt = (Math.random() * 1.4 - 0.7).toFixed(2) + "deg";
    wrap.style.setProperty("--dur", dur);
    wrap.style.setProperty("--delay", delay);
    wrap.style.setProperty("--shift-x", shiftX);
    wrap.style.setProperty("--tilt", tilt);

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

  function startCarousel(el, count) {
    if (count <= 1) return null;
    const slides = el.querySelectorAll(".photo .slide");
    const dots = el.querySelectorAll(".photo .dot");
    let i = 0;

    const tick = () => {
      slides[i].classList.remove("is-active");
      if (dots[i]) dots[i].classList.remove("is-active");
      i = (i + 1) % slides.length;
      slides[i].classList.add("is-active");
      if (dots[i]) dots[i].classList.add("is-active");
      // Re-arm with a fresh random interval each tick so two carousels with
      // matching first intervals immediately fall out of phase.
      timer = setTimeout(tick, randInterval());
    };

    let timer = setTimeout(tick, randInterval(/* initial */ true));

    return { clear() { clearTimeout(timer); } };
  }

  function randInterval(initial = false) {
    const base = SLIDE_MIN_MS + Math.random() * (SLIDE_MAX_MS - SLIDE_MIN_MS);
    // Stagger first ticks aggressively so all carousels start at different times.
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

  function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
})();
