const NAME_MAX = 80;
const EMAIL_MAX = 120;
const GUEST_MAX = 80;
const GUESTS_MAX = 10;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const LANTERN_NAME_MAX = 60;
const LANTERN_ROLE_MAX = 60;
const LANTERN_MSG_MAX = 2000;
const LANTERN_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const LANTERN_MEDIA_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};
const MEDIA_KEY_RE = /^lanterns\/[a-f0-9-]{16,64}\.(png|jpg|webp|avif)$/;

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
        return await handleCreateRsvp(request, env);
      }

      if (pathname === "/api/rsvps" && request.method === "GET") {
        return await handleListRsvps(request, env);
      }

      if (pathname === "/api/lanterns" && request.method === "GET") {
        return await handleListLanterns(env);
      }

      if (pathname === "/api/lanterns" && request.method === "POST") {
        return await handleCreateLantern(request, env);
      }

      const lanternMatch = /^\/api\/lanterns\/([a-f0-9-]{16,64})$/.exec(pathname);
      if (lanternMatch && request.method === "DELETE") {
        return await handleDeleteLantern(request, env, lanternMatch[1]);
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

async function handleCreateRsvp(request, env) {
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

  try {
    await env.DB.prepare(
      "INSERT INTO rsvps (name, email, guest_names, party_size, user_agent, ip_country) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(name, email, JSON.stringify(guests), partySize, userAgent, ipCountry)
      .run();
  } catch (err) {
    console.error("rsvp_insert_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  return jsonResponse({ ok: true }, 200);
}

function validateRsvp(body) {
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

async function handleListRsvps(request, env) {
  const presented = parseBearer(request.headers.get("authorization"));
  const expected = env.ADMIN_TOKEN ?? "";
  if (!presented || !expected || !(await constantTimeEquals(presented, expected))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

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

async function handleListLanterns(env) {
  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT id, name, role, msg, media_key, media_type, created_at FROM lanterns ORDER BY created_at DESC"
    ).all();
    rows = result.results ?? [];
  } catch (err) {
    console.error("lantern_list_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  const lanterns = rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role ?? "",
    msg: r.msg,
    media_key: r.media_key ?? null,
    media_type: r.media_type ?? null,
    created_at: r.created_at,
  }));

  return jsonResponse({ lanterns });
}

async function handleCreateLantern(request, env) {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, 415);
  }

  const presented = request.headers.get("x-post-password") ?? "";
  const expected = env.POST_PASSWORD ?? "";
  if (!presented || !expected || !(await constantTimeEquals(presented, expected))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

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

  const turnstileToken = (form.get("turnstileToken") ?? "").toString().trim();
  if (!turnstileToken) {
    return jsonResponse({ error: "Bot check failed. Please try again." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const turnstileOk = await verifyTurnstile(turnstileToken, env, ip);
  if (!turnstileOk) {
    return jsonResponse({ error: "Bot check failed. Please try again." }, 400);
  }

  const mediaFile = form.get("media");
  let mediaKey = null;
  let mediaType = null;
  let mediaBytes = null;

  if (mediaFile && typeof mediaFile === "object" && "size" in mediaFile && mediaFile.size > 0) {
    if (mediaFile.size > LANTERN_MEDIA_MAX_BYTES) {
      return jsonResponse({ error: "Photo must be 8 MB or smaller." }, 400);
    }
    const t = (mediaFile.type ?? "").toLowerCase();
    const ext = LANTERN_MEDIA_MIME_EXT[t];
    if (!ext) {
      return jsonResponse({ error: "Photos only — PNG, JPEG, WebP, or AVIF." }, 400);
    }
    mediaType = t;
    try {
      mediaBytes = await mediaFile.arrayBuffer();
    } catch (err) {
      console.error("lantern_media_read_failed", err?.message ?? String(err));
      return jsonResponse({ error: "Could not read photo." }, 400);
    }
  }

  const id = crypto.randomUUID();
  if (mediaBytes) {
    const ext = LANTERN_MEDIA_MIME_EXT[mediaType];
    mediaKey = `lanterns/${id}.${ext}`;
    try {
      await env.MEDIA.put(mediaKey, mediaBytes, {
        httpMetadata: { contentType: mediaType },
      });
    } catch (err) {
      console.error("lantern_media_put_failed", err?.message ?? String(err));
      return jsonResponse({ error: "Server error" }, 500);
    }
  }

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200) || null;
  const ipCountry = request.headers.get("cf-ipcountry") ?? null;

  try {
    await env.DB.prepare(
      "INSERT INTO lanterns (id, name, role, msg, media_key, media_type, user_agent, ip_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, name.value, role.value || null, msg.value, mediaKey, mediaType, userAgent, ipCountry)
      .run();
  } catch (err) {
    console.error("lantern_insert_failed", err?.message ?? String(err));
    if (mediaKey) {
      try { await env.MEDIA.delete(mediaKey); } catch {}
    }
    return jsonResponse({ error: "Server error" }, 500);
  }

  const row = await env.DB.prepare(
    "SELECT id, name, role, msg, media_key, media_type, created_at FROM lanterns WHERE id = ?"
  ).bind(id).first();

  return jsonResponse({
    ok: true,
    lantern: {
      id: row.id,
      name: row.name,
      role: row.role ?? "",
      msg: row.msg,
      media_key: row.media_key ?? null,
      media_type: row.media_type ?? null,
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
  try {
    row = await env.DB.prepare(
      "SELECT media_key FROM lanterns WHERE id = ?"
    ).bind(id).first();
  } catch (err) {
    console.error("lantern_lookup_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }
  if (!row) return jsonResponse({ error: "Not found" }, 404);

  try {
    await env.DB.prepare("DELETE FROM lanterns WHERE id = ?").bind(id).run();
  } catch (err) {
    console.error("lantern_delete_failed", err?.message ?? String(err));
    return jsonResponse({ error: "Server error" }, 500);
  }

  if (row.media_key) {
    try {
      await env.MEDIA.delete(row.media_key);
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
