const NAME_MAX = 80;
const EMAIL_MAX = 120;
const GUEST_MAX = 80;
const GUESTS_MAX = 10;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const LANTERN_NAME_MAX = 60;
const LANTERN_ROLE_MAX = 60;
const LANTERN_MSG_MAX = 2000;
const LANTERN_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const LANTERN_MEDIA_MAX_COUNT = 4;

const BOOK_NAME_MAX = 200;
const BOOK_EMAIL_MAX = 320;
const BOOK_ADDRESS_MAX = 1000;

// Source-of-truth book table. The client sends a `bookId`; the server
// looks up title/author here and stores both. Keep in sync with the
// BOOKS constant in preview.html.
const BOOKS = {
  walking: {
    title: "Walking with God through Pain and Suffering",
    author: "Timothy Keller",
  },
  mere:    { title: "Mere Christianity",    author: "C. S. Lewis" },
  proof:   { title: "Proof of Heaven",      author: "Eben Alexander, M.D." },
  imagine: { title: "Imagine Heaven",       author: "John Burke" },
  making:  { title: "Making Sense of God",  author: "Timothy Keller" },
};
const BOOK_FORMATS = new Set(["paperback", "audiobook", "kindle"]);
const BOOK_EMAIL_RE = /.+@.+\..+/;

const LANTERN_MEDIA_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};
// Accepts the legacy `lanterns/<uuid>.<ext>` form alongside the new
// `lanterns/<uuid>-<index>.<ext>` form used for multi-photo lanterns.
const MEDIA_KEY_RE = /^lanterns\/[a-f0-9-]{16,64}(-\d+)?\.(png|jpg|webp|avif)$/;

// Cloudflare's "always passes" Turnstile keys for local/CI use.
// Production replaces both via wrangler secret put / scripts/rsvp-config.js.
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/api/rsvp" && request.method === "POST") {
        return await handleCreateRsvp(request, env, ctx);
      }

      if (pathname === "/api/rsvps" && request.method === "GET") {
        return await handleListRsvps(request, env);
      }

      const rsvpIdMatch = pathname.match(/^\/api\/rsvps\/(\d+)$/);
      if (rsvpIdMatch) {
        const id = Number(rsvpIdMatch[1]);
        if (request.method === "PATCH") return await handleUpdateRsvp(request, env, id);
        if (request.method === "DELETE") return await handleDeleteRsvp(request, env, id);
      }

      if (pathname === "/api/lanterns" && request.method === "GET") {
        return await handleListLanterns(env);
      }

      if (pathname === "/api/lanterns" && request.method === "POST") {
        return await handleCreateLantern(request, env);
      }

      const lanternMatch = /^\/api\/lanterns\/([a-z0-9-]{4,64})$/.exec(pathname);
      if (lanternMatch && request.method === "DELETE") {
        return await handleDeleteLantern(request, env, lanternMatch[1]);
      }

      if (pathname === "/api/book-claims" && request.method === "POST") {
        return await handleCreateBookClaim(request, env);
      }

      if (pathname === "/api/book-claims" && request.method === "GET") {
        return await handleListBookClaims(request, env);
      }

      const bookClaimMatch = /^\/api\/book-claims\/(\d+)$/.exec(pathname);
      if (bookClaimMatch && request.method === "DELETE") {
        return await handleDeleteBookClaim(request, env, Number(bookClaimMatch[1]));
      }

      if (pathname.startsWith("/media/") && request.method === "GET") {
        return await handleMedia(env, pathname.slice("/media/".length));
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("worker_unhandled", err?.message ?? String(err));
      return jsonResponse({ error: "Server error" }, 500);
    }
  },
};

async function handleCreateRsvp(request, env, ctx) {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Expected application/json" }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const validated = validateRsvp(body);
  if (validated.error) {
    return jsonResponse({ error: validated.error }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const turnstileOk = await verifyTurnstile(validated.value.turnstileToken, env, ip);
  if (!turnstileOk) {
    return jsonResponse({ error: "Bot check failed. Please try again." }, 400);
  }

  const { name, email, guests } = validated.value;
  const partySize = 1 + guests.length;
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  const ipCountry = request.headers.get("cf-ipcountry") ?? null;

  let inserted;
  try {
    inserted = await env.DB.prepare(
      "INSERT INTO rsvps (name, email, guest_names, party_size, user_agent, ip_country) " +
        "VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at"
    )
      .bind(name, email, JSON.stringify(guests), partySize, userAgent, ipCountry)
      .first();
  } catch (err) {
    console.error("rsvp_insert_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  if (inserted && ctx?.waitUntil) {
    ctx.waitUntil(
      sendRsvpNotification(env, {
        id: inserted.id,
        created_at: inserted.created_at,
        name,
        email,
        guests,
        party_size: partySize,
        ip_country: ipCountry,
      })
    );
  }

  return jsonResponse({ ok: true }, 200);
}

async function sendRsvpNotification(env, rsvp) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("rsvp_notify_skipped", "RESEND_API_KEY not set");
    return;
  }
  const to = env.NOTIFY_TO || "godwin.law@acts2.network";
  const from = env.NOTIFY_FROM || "onboarding@resend.dev";

  const json = JSON.stringify(rsvp, null, 2);
  // Workers exposes btoa for base64; encode UTF-8 first so non-ASCII names survive.
  const contentB64 = btoa(unescape(encodeURIComponent(json)));

  const guestList = rsvp.guests.length
    ? rsvp.guests.map((g) => `  - ${g}`).join("\n")
    : "  (none)";
  const text =
    `New RSVP: ${rsvp.name} <${rsvp.email}>\n` +
    `Party size: ${rsvp.party_size}\n` +
    `Guests:\n${guestList}\n` +
    `Submitted: ${rsvp.created_at}\n`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `New RSVP — ${rsvp.name} (party of ${rsvp.party_size})`,
        text,
        attachments: [
          { filename: `rsvp-${rsvp.id}.json`, content: contentB64 },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("rsvp_notify_http", res.status, detail.slice(0, 300));
    }
  } catch (err) {
    console.error("rsvp_notify_error", err?.message ?? String(err));
  } finally {
    clearTimeout(timeoutId);
  }
}

function validateRsvp(body, { requireTurnstile = true } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Please enter your name." };
  if (name.length > NAME_MAX) return { error: `Name is too long (max ${NAME_MAX}).` };

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return { error: "Please enter your email." };
  if (email.length > EMAIL_MAX) return { error: `Email is too long (max ${EMAIL_MAX}).` };
  if (!EMAIL_RE.test(email)) return { error: "That email address doesn't look right." };

  const rawGuests = Array.isArray(body.guests) ? body.guests : [];
  const guests = [];
  for (const g of rawGuests) {
    if (typeof g !== "string") continue;
    const t = g.trim();
    if (!t) continue;
    if (t.length > GUEST_MAX) {
      return { error: `Each guest name must be under ${GUEST_MAX} characters.` };
    }
    guests.push(t);
  }
  if (guests.length > GUESTS_MAX) {
    return { error: `Please list at most ${GUESTS_MAX} additional guests.` };
  }

  if (!requireTurnstile) {
    return { value: { name, email, guests } };
  }

  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!turnstileToken) {
    return { error: "Bot check failed. Please try again." };
  }

  return { value: { name, email, guests, turnstileToken } };
}

async function verifyTurnstile(token, env, ip) {
  const secret = env.TURNSTILE_SECRET_KEY ?? TURNSTILE_TEST_SECRET;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("turnstile_http", res.status);
      return false;
    }
    const data = await res.json();
    if (data && data.success === true) return true;
    console.error("turnstile_failed", JSON.stringify(data?.["error-codes"] ?? []));
    return false;
  } catch (err) {
    console.error("turnstile_error", err?.message ?? String(err));
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requireAdmin(request, env) {
  const presented = parseBearer(request.headers.get("authorization"));
  const expected = env.ADMIN_TOKEN ?? "";
  if (!presented || !expected || !(await constantTimeEquals(presented, expected))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function handleListRsvps(request, env) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;

  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT id, name, email, guest_names, party_size, created_at FROM rsvps ORDER BY created_at DESC"
    ).all();
    rows = result.results ?? [];
  } catch (err) {
    console.error("rsvp_list_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  let totalAttendees = 0;
  const rsvps = rows.map((r) => {
    const partySize = Number(r.party_size) || 0;
    totalAttendees += partySize;
    let guestNames = [];
    try {
      const parsed = JSON.parse(r.guest_names ?? "[]");
      if (Array.isArray(parsed)) guestNames = parsed.filter((s) => typeof s === "string");
    } catch {}
    return {
      id: r.id,
      created_at: r.created_at,
      name: r.name,
      email: r.email,
      party_size: partySize,
      guest_names: guestNames,
    };
  });

  return jsonResponse({
    rsvps,
    total_parties: rsvps.length,
    total_attendees: totalAttendees,
  });
}

async function handleUpdateRsvp(request, env, id) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;

  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Expected application/json" }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const validated = validateRsvp(body, { requireTurnstile: false });
  if (validated.error) {
    return jsonResponse({ error: validated.error }, 400);
  }

  const { name, email, guests } = validated.value;
  const partySize = 1 + guests.length;

  let result;
  try {
    result = await env.DB.prepare(
      "UPDATE rsvps SET name = ?, email = ?, guest_names = ?, party_size = ? WHERE id = ?"
    )
      .bind(name, email, JSON.stringify(guests), partySize, id)
      .run();
  } catch (err) {
    console.error("rsvp_update_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  if (!result.meta?.changes) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

async function handleDeleteRsvp(request, env, id) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;

  let result;
  try {
    result = await env.DB.prepare("DELETE FROM rsvps WHERE id = ?").bind(id).run();
  } catch (err) {
    console.error("rsvp_delete_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  if (!result.meta?.changes) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

async function handleListLanterns(env) {
  let rows;
  let mediaRows;
  try {
    const result = await env.DB.prepare(
      "SELECT id, name, role, msg, created_at FROM lanterns ORDER BY created_at DESC"
    ).all();
    rows = result.results ?? [];
    if (rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      const mediaResult = await env.DB.prepare(
        `SELECT lantern_id, position, media_key, media_type
           FROM lantern_media
          WHERE lantern_id IN (${placeholders})
          ORDER BY lantern_id, position`
      ).bind(...rows.map((r) => r.id)).all();
      mediaRows = mediaResult.results ?? [];
    } else {
      mediaRows = [];
    }
  } catch (err) {
    console.error("lantern_list_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  const mediaByLantern = new Map();
  for (const m of mediaRows) {
    if (!mediaByLantern.has(m.lantern_id)) mediaByLantern.set(m.lantern_id, []);
    mediaByLantern.get(m.lantern_id).push({ key: m.media_key, type: m.media_type });
  }

  const lanterns = rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role ?? "",
    msg: r.msg,
    media: mediaByLantern.get(r.id) ?? [],
    created_at: r.created_at,
  }));

  return jsonResponse({ lanterns });
}

async function handleCreateLantern(request, env) {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, 415);
  }

  // TEMP: lantern post password disabled. Restore the block below to re-enable.
  // const presented = request.headers.get("x-post-password") ?? "";
  // const expected = env.POST_PASSWORD ?? "";
  // if (!presented || !expected || !(await constantTimeEquals(presented, expected))) {
  //   return jsonResponse({ error: "Unauthorized" }, 401);
  // }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid form data" }, 400);
  }

  const name = readField(form, "name", LANTERN_NAME_MAX);
  if (name.error) return jsonResponse({ error: name.error }, 400);

  const role = readField(form, "role", LANTERN_ROLE_MAX, true);
  if (role.error) return jsonResponse({ error: role.error }, 400);

  const msg = readField(form, "msg", LANTERN_MSG_MAX);
  if (msg.error) return jsonResponse({ error: msg.error }, 400);

  const rawMedia = form.getAll("media").filter(
    (v) => v && typeof v === "object" && "size" in v && v.size > 0
  );
  if (rawMedia.length > LANTERN_MEDIA_MAX_COUNT) {
    return jsonResponse(
      { error: `Up to ${LANTERN_MEDIA_MAX_COUNT} photos per lantern.` },
      400,
    );
  }

  const mediaItems = [];
  for (const file of rawMedia) {
    if (file.size > LANTERN_MEDIA_MAX_BYTES) {
      return jsonResponse({ error: "Each photo must be 8 MB or smaller." }, 400);
    }
    const t = (file.type ?? "").toLowerCase();
    const ext = LANTERN_MEDIA_MIME_EXT[t];
    if (!ext) {
      return jsonResponse({ error: "Photos only — PNG, JPEG, WebP, or AVIF." }, 400);
    }
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch (err) {
      console.error("lantern_media_read_failed", err?.message ?? String(err));
      return jsonResponse({ error: "Could not read photo." }, 400);
    }
    mediaItems.push({ ext, type: t, bytes });
  }

  const id = crypto.randomUUID();
  const uploadedKeys = [];
  for (let i = 0; i < mediaItems.length; i++) {
    const item = mediaItems[i];
    const key = `lanterns/${id}-${i}.${item.ext}`;
    try {
      await env.MEDIA.put(key, item.bytes, {
        httpMetadata: { contentType: item.type },
      });
      uploadedKeys.push(key);
      item.key = key;
    } catch (err) {
      console.error("lantern_media_put_failed", err?.message ?? String(err));
      for (const k of uploadedKeys) {
        try { await env.MEDIA.delete(k); } catch {}
      }
      return jsonResponse({ error: "Server error" }, 500);
    }
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  const ipCountry = request.headers.get("cf-ipcountry") ?? null;

  try {
    await env.DB.prepare(
      "INSERT INTO lanterns (id, name, role, msg, user_agent, ip_country) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(id, name.value, role.value || null, msg.value, userAgent, ipCountry)
      .run();
    if (mediaItems.length) {
      const stmt = env.DB.prepare(
        "INSERT INTO lantern_media (lantern_id, position, media_key, media_type) VALUES (?, ?, ?, ?)"
      );
      await env.DB.batch(
        mediaItems.map((m, i) => stmt.bind(id, i, m.key, m.type))
      );
    }
  } catch (err) {
    console.error("lantern_insert_failed", err?.message ?? String(err));
    for (const k of uploadedKeys) {
      try { await env.MEDIA.delete(k); } catch {}
    }
    return jsonResponse({ error: "Server error" }, 500);
  }

  const row = await env.DB.prepare(
    "SELECT id, name, role, msg, created_at FROM lanterns WHERE id = ?"
  ).bind(id).first();

  return jsonResponse({
    ok: true,
    lantern: {
      id: row.id,
      name: row.name,
      role: row.role ?? "",
      msg: row.msg,
      media: mediaItems.map((m) => ({ key: m.key, type: m.type })),
      created_at: row.created_at,
    },
  });
}

async function handleDeleteLantern(request, env, id) {
  const presented = parseBearer(request.headers.get("authorization"));
  const expected = env.ADMIN_TOKEN ?? "";
  if (!presented || !expected || !(await constantTimeEquals(presented, expected))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let row;
  let mediaRows;
  try {
    row = await env.DB.prepare(
      "SELECT media_key FROM lanterns WHERE id = ?"
    ).bind(id).first();
    if (!row) return jsonResponse({ error: "Not found" }, 404);
    const mediaResult = await env.DB.prepare(
      "SELECT media_key FROM lantern_media WHERE lantern_id = ?"
    ).bind(id).all();
    mediaRows = mediaResult.results ?? [];
  } catch (err) {
    console.error("lantern_lookup_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  try {
    await env.DB.prepare("DELETE FROM lantern_media WHERE lantern_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM lanterns WHERE id = ?").bind(id).run();
  } catch (err) {
    console.error("lantern_delete_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  const keys = new Set();
  if (row.media_key) keys.add(row.media_key);
  for (const m of mediaRows) {
    if (m.media_key) keys.add(m.media_key);
  }
  for (const k of keys) {
    try {
      await env.MEDIA.delete(k);
    } catch (err) {
      console.error("lantern_media_delete_failed", err?.message ?? String(err));
    }
  }

  return jsonResponse({ ok: true });
}

async function handleMedia(env, rawKey) {
  const key = decodeURIComponent(rawKey);
  if (!MEDIA_KEY_RE.test(key)) {
    return new Response("Not found", { status: 404 });
  }
  let object;
  try {
    object = await env.MEDIA.get(key);
  } catch (err) {
    console.error("media_get_failed", err?.message ?? String(err));
    return new Response("Server error", { status: 500 });
  }
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  if (object.httpMetadata?.contentType) {
    headers.set("Content-Type", object.httpMetadata.contentType);
  }
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

function readField(form, key, max, optional = false) {
  const raw = form.get(key);
  const v = (typeof raw === "string" ? raw : "").trim();
  if (!v) {
    if (optional) return { value: "" };
    return { error: `Please enter ${key}.` };
  }
  if (v.length > max) {
    return { error: `${key} is too long (max ${max}).` };
  }
  return { value: v };
}

function parseBearer(headerValue) {
  if (!headerValue) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return m ? m[1] : null;
}

async function constantTimeEquals(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function handleCreateBookClaim(request, env) {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Expected application/json" }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Body must be a JSON object" }, 400);
  }

  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!turnstileToken) {
    return jsonResponse({ error: "Bot check missing." }, 401);
  }
  const ip = request.headers.get("cf-connecting-ip") ?? null;
  const turnstileOk = await verifyTurnstile(turnstileToken, env, ip);
  if (!turnstileOk) {
    return jsonResponse({ error: "Bot check failed." }, 401);
  }

  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  const book = BOOKS[bookId];
  if (!book) return jsonResponse({ error: "Unknown book." }, 400);

  const format = typeof body.format === "string" ? body.format.trim() : "";
  if (!BOOK_FORMATS.has(format)) {
    return jsonResponse({ error: "Pick a format." }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return jsonResponse({ error: "Please enter your name." }, 400);
  if (name.length > BOOK_NAME_MAX) {
    return jsonResponse({ error: `Name is too long (max ${BOOK_NAME_MAX}).` }, 400);
  }

  let email = null;
  let address = null;
  if (format === "paperback") {
    const a = typeof body.address === "string" ? body.address.trim() : "";
    if (a.length <= 6) {
      return jsonResponse({ error: "Please enter a mailing address." }, 400);
    }
    if (a.length > BOOK_ADDRESS_MAX) {
      return jsonResponse({ error: `Address is too long (max ${BOOK_ADDRESS_MAX}).` }, 400);
    }
    address = a;
  } else {
    const e = typeof body.email === "string" ? body.email.trim() : "";
    if (!e || !BOOK_EMAIL_RE.test(e)) {
      return jsonResponse({ error: "Please enter a valid email." }, 400);
    }
    if (e.length > BOOK_EMAIL_MAX) {
      return jsonResponse({ error: `Email is too long (max ${BOOK_EMAIL_MAX}).` }, 400);
    }
    email = e;
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  const ipCountry = request.headers.get("cf-ipcountry") ?? null;

  try {
    await env.DB.prepare(
      "INSERT INTO book_claims (book_id, book_title, book_author, format, name, email, address, user_agent, ip_country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(bookId, book.title, book.author, format, name, email, address, userAgent, ipCountry)
      .run();
  } catch (err) {
    console.error("book_claim_insert_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  return jsonResponse({ ok: true }, 200);
}

async function handleListBookClaims(request, env) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;

  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT id, book_id, book_title, book_author, format, name, email, address, created_at " +
        "FROM book_claims ORDER BY created_at DESC"
    ).all();
    rows = result.results ?? [];
  } catch (err) {
    console.error("book_claim_list_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  return jsonResponse({ claims: rows });
}

async function handleDeleteBookClaim(request, env, id) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;

  let result;
  try {
    result = await env.DB.prepare("DELETE FROM book_claims WHERE id = ?").bind(id).run();
  } catch (err) {
    console.error("book_claim_delete_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  if (!result.meta?.changes) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  return jsonResponse({ ok: true });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
