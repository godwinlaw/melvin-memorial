const NAME_MAX = 80;
const EMAIL_MAX = 120;
const GUEST_MAX = 80;
const GUESTS_MAX = 10;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

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

function parseBearer(headerValue) {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : null;
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
