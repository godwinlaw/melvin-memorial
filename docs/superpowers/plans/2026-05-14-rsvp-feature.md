# RSVP Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let memorial-site visitors RSVP through a modal form on `index.html`; submissions land in a Cloudflare D1 database and the host can view/export them through a token-gated `admin.html`.

**Architecture:** Add a Cloudflare Worker entry script (`src/worker.js`) that owns `POST /api/rsvp` and `GET /api/rsvps` and falls through to static-asset serving for everything else. The form is an autonomous custom element (`<rsvp-form>`) rendered inside a native `<dialog>` opened from the existing Service card. Admin page is a separate static file with its own server-enforced bearer-token gate.

**Tech Stack:** Cloudflare Workers (assets binding), Cloudflare D1 (SQLite), wrangler v3+ CLI, vanilla custom elements with shadow DOM, native `<dialog>`. No build step, no package manager, no test framework.

**Spec:** [`docs/superpowers/specs/2026-05-14-rsvp-feature-design.md`](../specs/2026-05-14-rsvp-feature-design.md)

---

## Project conventions you must respect

This is a small static site with strong conventions documented in `CLAUDE.md`:

- **No build step, no package manager, no test framework.** Do not introduce one. Do not add a `package.json` or `vitest`/`jest`/etc.
- **Scripts are loaded as plain `<script>` tags**, not modules. The Worker script (`src/worker.js`) is the exception — Cloudflare bundles it.
- **Custom elements use shadow DOM** and theme via CSS custom properties on the host. Match the `<lantern-wall>` pattern in `scripts/lantern-wall.js`.
- **Page-specific styles live inline** in the page's `<style>` block. Only put rules in `styles/shared.css` if they are reusable primitives (border colors there use `currentColor`).
- **Don't add comments** unless they explain a non-obvious *why*. Don't write multi-line docstrings.
- **The existing `login.html` gate is cosmetic** — its password lives in client JS. The new admin gate is *real* (server-enforced). Don't conflate them.

This plan has no automated tests because the project has no test infrastructure. Each task ends with **manual verification** the engineer must perform; "pass" means the verification step matches expected output.

---

## File structure

**Created:**
- `src/worker.js` — Worker entry; routes `/api/rsvp`, `/api/rsvps`, falls through to `env.ASSETS`.
- `scripts/rsvp-form.js` — `<rsvp-form>` custom element.
- `scripts/rsvp-config.js` — public Turnstile site key. Committed; only `TURNSTILE_SECRET_KEY` is a secret.
- `admin.html` — token-gated RSVP list + CSV export.
- `migrations/0001_create_rsvps.sql` — D1 schema.
- `docs/RSVP_SETUP.md` — one-time setup notes for the host (D1 create, secrets, Turnstile, deploy).

**Modified:**
- `wrangler.jsonc` — add `main`, `d1_databases` binding, migrations dir.
- `index.html` — RSVP button on Service card, dialog, `<rsvp-form>`, open/close wiring, footer link, page-specific styles, load `scripts/rsvp-form.js`.

**Untouched:** `login.html`, `gallery.html`, `styles/shared.css`, `scripts/image-slot.js`, `scripts/lantern-wall.js`.

---

## Task 1: Create the D1 database and migration

**Files:**
- Create: `migrations/0001_create_rsvps.sql`
- Create: `docs/RSVP_SETUP.md`
- Modify: `wrangler.jsonc`

Cloudflare D1 is SQLite hosted on the edge. The schema lives in a checked-in `.sql` file under `migrations/`. The Worker references the database via a binding declared in `wrangler.jsonc`. The actual database is created out-of-source via `wrangler d1 create`, which prints a `database_id` UUID we paste into `wrangler.jsonc`.

- [ ] **Step 1: Write the migration file**

Create `migrations/0001_create_rsvps.sql`:

```sql
CREATE TABLE rsvps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  guest_names   TEXT    NOT NULL DEFAULT '[]',
  party_size    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent    TEXT,
  ip_country    TEXT
);

CREATE INDEX idx_rsvps_created_at ON rsvps(created_at DESC);
```

- [ ] **Step 2: Update `wrangler.jsonc`**

Replace the file's contents with:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "melvin-memorial",
  "compatibility_date": "2026-05-12",
  "main": "src/worker.js",
  "observability": {
    "enabled": true
  },
  "assets": {
    "directory": ".",
    "binding": "ASSETS"
  },
  "compatibility_flags": [
    "nodejs_compat"
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "melvin-rsvps",
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ]
}
```

Two important changes besides adding the D1 block:
- `"main": "src/worker.js"` — tells Cloudflare to run our Worker script. Without `main`, the project is "assets only" and we can't intercept any request.
- `"binding": "ASSETS"` was added to `assets` so the Worker can call `env.ASSETS.fetch(request)` for fall-through.

- [ ] **Step 3: Write the setup doc**

Create `docs/RSVP_SETUP.md`:

````markdown
# RSVP feature — one-time setup

These commands are run by the host (not by the implementation agent).
They cannot be checked in — they create cloud resources and store secrets.

## 1. Create the D1 database

```bash
wrangler d1 create melvin-rsvps
```

The output ends with a JSON block that contains a `database_id`. Paste that
UUID into `wrangler.jsonc`, replacing `REPLACE_AFTER_WRANGLER_D1_CREATE` in
the `d1_databases` block.

## 2. Apply the migration

Local (for `wrangler dev`):

```bash
wrangler d1 migrations apply melvin-rsvps --local
```

Production:

```bash
wrangler d1 migrations apply melvin-rsvps --remote
```

## 3. Set the admin token

Generate a long random token and store it as a Worker secret:

```bash
openssl rand -hex 32          # copy the output
wrangler secret put ADMIN_TOKEN
# paste the token at the prompt
```

You'll paste this same token into `admin.html` when you visit the admin
page for the first time. It's stored in your browser's `sessionStorage`
for the rest of that browsing session only.

## 4. Configure Cloudflare Turnstile (bot prevention)

1. Sign in to the Cloudflare dashboard and go to **Turnstile**:
   <https://dash.cloudflare.com/?to=/:account/turnstile>.
2. Click **Add site**. Set the hostnames to your production domain
   (e.g., `melvin.example.com`). Pick **Managed** mode.
3. Cloudflare gives you two values:
   - **Site key** (public — safe to commit) — paste it into
     `scripts/rsvp-config.js`, replacing the testing key.
   - **Secret key** (private) — set it as a Worker secret:
     ```bash
     wrangler secret put TURNSTILE_SECRET_KEY
     ```

For local development, `scripts/rsvp-config.js` and the Worker default to
Cloudflare's public testing keys (`1x00000000000000000000AA` site key and
`1x0000000000000000000000000000000AA` secret), which always pass. Production
must use real keys.

## 5. Inspecting RSVPs from the CLI

```bash
wrangler d1 execute melvin-rsvps --remote \
  --command "SELECT id, created_at, name, email, party_size, guest_names FROM rsvps ORDER BY created_at DESC"
```

To delete a row (e.g., a duplicate):

```bash
wrangler d1 execute melvin-rsvps --remote \
  --command "DELETE FROM rsvps WHERE id = 42"
```

## 6. Deploying

```bash
wrangler deploy
```
````

- [ ] **Step 4: Manual verification**

Run:

```bash
cat wrangler.jsonc
```

Expected: shows the new `main`, `assets.binding`, and `d1_databases` blocks.

Run:

```bash
ls migrations docs
```

Expected: `migrations/0001_create_rsvps.sql` exists; `docs/RSVP_SETUP.md` exists.

Do **not** run `wrangler d1 create` — that's a host-only step. The plan continues without an actual DB; `src/worker.js` will be testable once the host completes the setup.

- [ ] **Step 5: Commit**

```bash
git add migrations/0001_create_rsvps.sql wrangler.jsonc docs/RSVP_SETUP.md
git commit -m "Add D1 schema and wrangler binding for RSVPs"
```

---

## Task 2: Worker script — skeleton + static fall-through

**Files:**
- Create: `src/worker.js`

Build the Worker in two passes: first a skeleton that *only* falls through to static assets (so we can confirm the existing site still loads with `main` set), then layer on the API routes. This is TDD-shaped: each pass is verified before adding the next.

- [ ] **Step 1: Create `src/worker.js` with the skeleton**

Create `src/worker.js`:

```js
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/api/rsvp" && request.method === "POST") {
        return jsonResponse({ error: "Not implemented" }, 501);
      }

      if (pathname === "/api/rsvps" && request.method === "GET") {
        return jsonResponse({ error: "Not implemented" }, 501);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("worker_unhandled", err?.message ?? String(err));
      return jsonResponse({ error: "Server error" }, 500);
    }
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
```

Notes for the engineer:
- The default export shape `{ fetch(request, env, ctx) }` is the modern Cloudflare Workers handler signature.
- `env.ASSETS` is the binding we declared in `wrangler.jsonc` step 2 — calling `.fetch(request)` serves the matching static file from the project directory exactly as today.
- `URL` is a Web platform global available in Workers; no import needed.
- The 501 stubs are intentional — Task 3 fills in the POST, Task 4 fills in the GET. They prove routing reaches the right branch without a database yet.

- [ ] **Step 2: Manual verification — site still loads**

The engineer should not run `wrangler dev` directly (it requires the host's account). Instead, do a static syntax check:

```bash
node --check src/worker.js
```

Expected: no output (success). If you see a `SyntaxError`, fix and re-run.

- [ ] **Step 3: Commit**

```bash
git add src/worker.js
git commit -m "Add Worker entry skeleton with static fall-through"
```

---

## Task 3: Worker — `POST /api/rsvp` validation, Turnstile verification, and insert

**Files:**
- Modify: `src/worker.js`

We replace the 501 stub with a fully validating handler that writes one row to D1. Validation includes a server-side Turnstile token check; the request is rejected if the bot challenge fails.

- [ ] **Step 1: Add the validator, Turnstile verifier, and POST handler to `src/worker.js`**

Replace the entire contents of `src/worker.js` with:

```js
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
        return jsonResponse({ error: "Not implemented" }, 501);
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
  const secret = env.TURNSTILE_SECRET_KEY || TURNSTILE_TEST_SECRET;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
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
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
```

Why this shape:
- `validateRsvp` is a pure function returning `{value}` or `{error}`. Easy to reason about; easy to call from a future `GET /api/admin/preview` if we ever wanted one.
- Whitespace-only guest entries are silently dropped *before* the count check, matching the spec.
- Length checks happen *before* shape checks where it matters (e.g., name `trim()` then length).
- Logs use short stable keys (`rsvp_insert_failed`) — handy for filtering in `wrangler tail`.

- [ ] **Step 2: Manual syntax verification**

```bash
node --check src/worker.js
```

Expected: no output.

- [ ] **Step 3: Manual unit-style verification of `validateRsvp`**

Since there's no test runner, the engineer verifies by hand using `node`. Run:

```bash
node -e '
const NAME_MAX=80, EMAIL_MAX=120, GUEST_MAX=80, GUESTS_MAX=10;
const EMAIL_RE=/^\S+@\S+\.\S+$/;
function validateRsvp(body){if(!body||typeof body!=="object"||Array.isArray(body))return{error:"Body must be a JSON object"};const name=typeof body.name==="string"?body.name.trim():"";if(!name)return{error:"Please enter your name."};if(name.length>NAME_MAX)return{error:`Name is too long (max ${NAME_MAX}).`};const email=typeof body.email==="string"?body.email.trim():"";if(!email)return{error:"Please enter your email."};if(email.length>EMAIL_MAX)return{error:`Email is too long (max ${EMAIL_MAX}).`};if(!EMAIL_RE.test(email))return{error:"That email address doesn'\''t look right."};const rawGuests=Array.isArray(body.guests)?body.guests:[];const guests=[];for(const g of rawGuests){if(typeof g!=="string")continue;const t=g.trim();if(!t)continue;if(t.length>GUEST_MAX)return{error:`Each guest name must be under ${GUEST_MAX} characters.`};guests.push(t);}if(guests.length>GUESTS_MAX)return{error:`Please list at most ${GUESTS_MAX} additional guests.`};const turnstileToken=typeof body.turnstileToken==="string"?body.turnstileToken.trim():"";if(!turnstileToken)return{error:"Bot check failed. Please try again."};return{value:{name,email,guests,turnstileToken}};}
const cases=[
  [{name:"Yat",email:"yat@example.com",guests:["A","","  "],turnstileToken:"tok"}, "ok with 1 guest"],
  [{name:"",email:"a@b.co",turnstileToken:"tok"}, "missing name"],
  [{name:"Yat",email:"not-an-email",turnstileToken:"tok"}, "bad email"],
  [{name:"Yat",email:"a@b.co",guests:Array(11).fill("x"),turnstileToken:"tok"}, "too many guests"],
  [{name:"Yat",email:"a@b.co",guests:["x".repeat(81)],turnstileToken:"tok"}, "guest too long"],
  [{name:"Yat",email:"a@b.co"}, "missing turnstile token"],
];
for(const [input,label] of cases){console.log(label, "→", validateRsvp(input));}
'
```

Expected output (line-for-line, allowing for ordering of properties):

```
ok with 1 guest → { value: { name: 'Yat', email: 'yat@example.com', guests: [ 'A' ], turnstileToken: 'tok' } }
missing name → { error: 'Please enter your name.' }
bad email → { error: 'That email address doesn\'t look right.' }
too many guests → { error: 'Please list at most 10 additional guests.' }
guest too long → { error: 'Each guest name must be under 80 characters.' }
missing turnstile token → { error: 'Bot check failed. Please try again.' }
```

If any line doesn't match, fix the validator and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "Add POST /api/rsvp with validation, Turnstile, and D1 insert"
```

---

## Task 4: Worker — `GET /api/rsvps` with constant-time admin auth

**Files:**
- Modify: `src/worker.js`

Add the admin-only read endpoint. Auth is a SHA-256 constant-time comparison against the `ADMIN_TOKEN` Worker secret.

- [ ] **Step 1: Add the admin handler**

In `src/worker.js`, replace the existing 501 stub branch:

```js
      if (pathname === "/api/rsvps" && request.method === "GET") {
        return jsonResponse({ error: "Not implemented" }, 501);
      }
```

with:

```js
      if (pathname === "/api/rsvps" && request.method === "GET") {
        return await handleListRsvps(request, env);
      }
```

Then add the following two new functions at the bottom of the file (above `jsonResponse`):

```js
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
```

Notes:
- We hash both sides with SHA-256 first so the byte-comparison length is constant regardless of token length, eliminating a length-leak side channel.
- `env.ADMIN_TOKEN` will be `undefined` if the host hasn't set the secret yet — the early `!expected` check returns 401 cleanly in that case.
- We re-parse `guest_names` server-side instead of letting the client do it, so the API returns clean arrays.

- [ ] **Step 2: Syntax check**

```bash
node --check src/worker.js
```

Expected: no output.

- [ ] **Step 3: Manual verification of constant-time equality**

```bash
node -e '
async function constantTimeEquals(a,b){const enc=new TextEncoder();const[ha,hb]=await Promise.all([crypto.subtle.digest("SHA-256",enc.encode(a)),crypto.subtle.digest("SHA-256",enc.encode(b))]);const va=new Uint8Array(ha),vb=new Uint8Array(hb);if(va.length!==vb.length)return false;let d=0;for(let i=0;i<va.length;i++)d|=va[i]^vb[i];return d===0;}
(async()=>{console.log(await constantTimeEquals("abc","abc"));console.log(await constantTimeEquals("abc","abd"));console.log(await constantTimeEquals("","abc"));})();
'
```

Expected output:

```
true
false
false
```

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "Add GET /api/rsvps with constant-time admin token check"
```

---

## Task 5: `<rsvp-form>` custom element — structure and `editing` state

**Files:**
- Create: `scripts/rsvp-form.js`

Build the element in two tasks: this one establishes shadow DOM, theme tokens, the form layout, and the dynamic guest-row machinery. Task 6 adds submit/network/state-machine.

- [ ] **Step 1: Create `scripts/rsvp-form.js`**

Create the file with the following content:

```js
// <rsvp-form> — autonomous custom element for the memorial RSVP form.
// Theme via CSS custom properties on the host:
//   --rsvp-ink, --rsvp-ink-soft, --rsvp-accent, --rsvp-line, --rsvp-bg, --rsvp-serif
// Endpoint via the `endpoint` attribute (default: "/api/rsvp").

(function () {
  const NAME_MAX = 80;
  const EMAIL_MAX = 120;
  const GUEST_MAX = 80;
  const GUESTS_MAX = 10;

  const css = `
:host {
  --rsvp-ink: #f3ead7;
  --rsvp-ink-soft: #d8cdb4;
  --rsvp-accent: #c89968;
  --rsvp-line: rgba(200,153,104,0.3);
  --rsvp-bg: rgba(10,20,34,0.6);
  --rsvp-serif: "Cormorant Garamond", Georgia, serif;
  --rsvp-sans: "Inter", system-ui, sans-serif;
  display: block;
  color: var(--rsvp-ink);
  font-family: var(--rsvp-sans);
}
* { box-sizing: border-box; }

.wrap { padding: 28px 28px 24px; background: var(--rsvp-bg); }
.title {
  font-family: var(--rsvp-serif); font-weight: 500;
  font-size: 28px; line-height: 1.1; margin: 0 0 6px;
}
.lede {
  color: var(--rsvp-ink-soft); font-family: var(--rsvp-serif); font-style: italic;
  font-size: 16px; line-height: 1.4; margin: 0 0 22px;
}

label.fld { display: block; margin-bottom: 18px; }
label.fld > span {
  display: block; color: var(--rsvp-accent);
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  margin-bottom: 6px;
}
input.txt {
  width: 100%; background: transparent; border: 0;
  border-bottom: 1px solid var(--rsvp-line);
  color: var(--rsvp-ink); font-family: var(--rsvp-serif); font-size: 18px;
  padding: 6px 0 10px; outline: none;
}
input.txt:focus { border-bottom-color: var(--rsvp-accent); }
input.txt:disabled { opacity: 0.6; }

.guests { margin: 4px 0 22px; }
.guests > .label {
  display: block; color: var(--rsvp-accent);
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  margin-bottom: 8px;
}
.guest-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.guest-row input { flex: 1; }
.guest-row button.remove {
  background: transparent; border: 1px solid var(--rsvp-line);
  color: var(--rsvp-ink-soft); cursor: pointer;
  width: 32px; height: 32px; font-size: 18px; line-height: 1;
}
.guest-row button.remove:hover { color: var(--rsvp-accent); border-color: var(--rsvp-accent); }
.add {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--rsvp-line);
  color: var(--rsvp-ink-soft);
  padding: 8px 14px; font: inherit; font-size: 11px;
  letter-spacing: 0.2em; text-transform: uppercase;
  margin-top: 4px;
}
.add:hover { color: var(--rsvp-accent); border-color: var(--rsvp-accent); }
.add:disabled { opacity: 0.4; cursor: not-allowed; }

.turnstile { margin: 6px 0 14px; min-height: 65px; }

button.submit {
  width: 100%; background: var(--rsvp-accent); color: #0a1422;
  border: 0; padding: 14px 22px; cursor: pointer;
  font: inherit; font-size: 11px; letter-spacing: 0.3em;
  text-transform: uppercase; font-weight: 600;
  margin-top: 8px;
}
button.submit:hover:not(:disabled) { filter: brightness(1.06); }
button.submit:disabled { opacity: 0.65; cursor: not-allowed; }

.note { color: var(--rsvp-ink-soft); font-size: 12px; margin-top: 12px; text-align: center; }

.banner {
  border: 1px solid var(--rsvp-accent);
  color: var(--rsvp-ink); padding: 12px 14px; margin-bottom: 18px;
  font-size: 14px; line-height: 1.4;
}
.banner.error { border-color: #d99c8a; color: #f0c8bb; }

.done {
  text-align: center; padding: 16px 8px 6px;
}
.done h3 {
  font-family: var(--rsvp-serif); font-weight: 500;
  font-size: 26px; margin: 6px 0 8px;
}
.done p { color: var(--rsvp-ink-soft); margin: 0 0 16px; }
.done a {
  color: var(--rsvp-accent); cursor: pointer;
  font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  text-decoration: none; border-bottom: 1px solid var(--rsvp-line);
  padding-bottom: 2px;
}
.done a:hover { color: var(--rsvp-ink); }
`;

  class RsvpForm extends HTMLElement {
    constructor() {
      super();
      this._state = "editing";
      this._guests = [];
      this._error = "";
      this._turnstileToken = "";
      this._turnstileWidgetId = null;
      this._root = this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      this._render();
    }

    disconnectedCallback() {
      this._removeTurnstile();
    }

    reset() {
      this._state = "editing";
      this._guests = [];
      this._error = "";
      this._turnstileToken = "";
      this._render();
      const nameEl = this._root.querySelector('input[name="name"]');
      if (nameEl) nameEl.value = "";
      const emailEl = this._root.querySelector('input[name="email"]');
      if (emailEl) emailEl.value = "";
    }

    get _endpoint() {
      return this.getAttribute("endpoint") || "/api/rsvp";
    }

    get _siteKey() {
      // page is responsible for setting window.RSVP_TURNSTILE_SITE_KEY via scripts/rsvp-config.js
      return (window.RSVP_TURNSTILE_SITE_KEY || "").trim();
    }

    _render() {
      this._removeTurnstile();
      this._root.innerHTML = `<style>${css}</style><div class="wrap">${this._html()}</div>`;
      this._wireEvents();
      this._mountTurnstile();
    }

    _mountTurnstile() {
      if (this._state !== "editing" && this._state !== "error") return;
      const mount = this._root.querySelector("[data-turnstile-mount]");
      if (!mount) return;

      const sitekey = this._siteKey;
      if (!sitekey) {
        mount.textContent = "Bot check unavailable (site key not configured).";
        mount.style.color = "#d99c8a";
        mount.style.fontSize = "12px";
        return;
      }

      const tryRender = () => {
        if (!window.turnstile || typeof window.turnstile.render !== "function") return false;
        try {
          this._turnstileWidgetId = window.turnstile.render(mount, {
            sitekey,
            callback: (token) => { this._turnstileToken = token; },
            "error-callback": () => { this._turnstileToken = ""; },
            "expired-callback": () => { this._turnstileToken = ""; },
            theme: "dark",
          });
          return true;
        } catch (err) {
          console.error("turnstile render failed", err);
          return false;
        }
      };

      if (tryRender()) return;
      // The Turnstile script may not have finished loading yet; retry briefly.
      const start = Date.now();
      const tick = () => {
        if (tryRender()) return;
        if (Date.now() - start < 5000) setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    }

    _removeTurnstile() {
      if (this._turnstileWidgetId && window.turnstile && typeof window.turnstile.remove === "function") {
        try { window.turnstile.remove(this._turnstileWidgetId); } catch {}
      }
      this._turnstileWidgetId = null;
    }

    _html() {
      if (this._state === "done") {
        return `
          <div class="done" role="status">
            <h3>Thank you</h3>
            <p>We look forward to seeing you on May 30.</p>
            <a href="#" data-action="another">Submit another RSVP</a>
          </div>
        `;
      }

      const errorBanner =
        this._state === "error" && this._error
          ? `<div class="banner error" role="alert">${escapeHtml(this._error)}</div>`
          : "";

      const isSubmitting = this._state === "submitting";
      const submitLabel = isSubmitting ? "Sending…" : "Send RSVP";

      const guestRows = this._guests
        .map(
          (val, i) => `
        <div class="guest-row">
          <input class="txt" type="text" data-guest-idx="${i}"
                 maxlength="${GUEST_MAX}" autocomplete="off"
                 placeholder="Guest name"
                 value="${escapeAttr(val)}"
                 ${isSubmitting ? "disabled" : ""}>
          <button type="button" class="remove" data-remove-idx="${i}"
                  aria-label="Remove guest" ${isSubmitting ? "disabled" : ""}>×</button>
        </div>
      `
        )
        .join("");

      return `
        <h2 class="title">Kindly Reply</h2>
        <p class="lede">Let us know you'll be there so we can plan a place for you at lunch.</p>
        ${errorBanner}
        <form data-form novalidate>
          <label class="fld">
            <span>Your name</span>
            <input class="txt" type="text" name="name" required
                   maxlength="${NAME_MAX}" autocomplete="name"
                   ${isSubmitting ? "disabled" : ""}>
          </label>

          <label class="fld">
            <span>Email</span>
            <input class="txt" type="email" name="email" required
                   maxlength="${EMAIL_MAX}" autocomplete="email"
                   ${isSubmitting ? "disabled" : ""}>
          </label>

          <div class="guests">
            <span class="label">Guests you'll bring</span>
            ${guestRows}
            <button type="button" class="add" data-add
                    ${this._guests.length >= GUESTS_MAX || isSubmitting ? "disabled" : ""}>
              + Add guest
            </button>
          </div>

          <div class="turnstile" data-turnstile-mount></div>

          <button class="submit" type="submit"
                  ${isSubmitting ? "disabled" : ""}
                  ${isSubmitting ? 'aria-busy="true"' : ""}>${submitLabel}</button>
          <p class="note">No account needed. We'll only use your email if plans change.</p>
        </form>
      `;
    }

    _wireEvents() {
      const root = this._root;
      const form = root.querySelector("[data-form]");
      const addBtn = root.querySelector("[data-add]");
      const another = root.querySelector('[data-action="another"]');

      if (addBtn) {
        addBtn.addEventListener("click", () => {
          if (this._guests.length >= GUESTS_MAX) return;
          // capture current input values before re-render
          this._snapshotGuests();
          this._guests.push("");
          this._render();
          // focus the newly-added row
          const idx = this._guests.length - 1;
          const newInput = this._root.querySelector(`input[data-guest-idx="${idx}"]`);
          if (newInput) newInput.focus();
        });
      }

      root.querySelectorAll("[data-remove-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-remove-idx"));
          this._snapshotGuests();
          this._guests.splice(idx, 1);
          this._render();
        });
      });

      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          this._submit();
        });
      }

      if (another) {
        another.addEventListener("click", (e) => {
          e.preventDefault();
          this.reset();
        });
      }
    }

    _snapshotGuests() {
      this._root.querySelectorAll("[data-guest-idx]").forEach((inp) => {
        const idx = Number(inp.getAttribute("data-guest-idx"));
        if (Number.isInteger(idx) && idx >= 0 && idx < this._guests.length) {
          this._guests[idx] = inp.value;
        }
      });
    }

    _submit() {
      // implemented in Task 6
      console.warn("rsvp-form: submit not yet wired");
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  if (!customElements.get("rsvp-form")) {
    customElements.define("rsvp-form", RsvpForm);
  }
})();
```

Why this shape:
- The element re-renders the entire shadow root on every guest add/remove. Cheaper than tracking diffs and avoids a stale DOM. We snapshot input values into `_guests` before re-rendering so typed-but-not-blurred guest names survive.
- Submit logic is stubbed deliberately — kept out of this task to keep the diff small.
- `escapeHtml` / `escapeAttr` exist because we're building HTML strings; even though the values come from the user's own form, escaping is the right hygiene (and matches what `<lantern-wall>` does).
- The Turnstile widget is re-rendered on each shadow-DOM re-render (add/remove guest). For a small RSVP form (up to 10 add clicks) this is a known minor UX cost rather than a real problem; reducing it would mean partial-DOM updates that aren't worth the complexity.
- `window.RSVP_TURNSTILE_SITE_KEY` is read from a small global set by `scripts/rsvp-config.js` (created in Task 7). The element doesn't read the site key from an attribute, because the page is the right source-of-truth for "which Turnstile project this site belongs to."

- [ ] **Step 2: Syntax check**

```bash
node --check scripts/rsvp-form.js
```

Expected: no output.

- [ ] **Step 3: Manual visual verification (optional, recommended)**

The element won't render submitted-state behavior yet, but the form layout is testable in any browser. Create a quick standalone smoke file in the project root **temporarily** (so script paths resolve) and open it:

```bash
cat > rsvp-smoke.html <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><style>body{background:#0a1422;padding:40px;font-family:sans-serif;} rsvp-form{max-width:500px;display:block;margin:auto;}</style></head>
<body>
<rsvp-form id="t"></rsvp-form>
<script>window.RSVP_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";</script>
<script src="scripts/rsvp-form.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
</body></html>
```

Serve the project root with any static server (e.g., `python3 -m http.server 8000`) and visit `http://localhost:8000/rsvp-smoke.html`. Expected: form renders with name, email, "+ Add guest" button, and a Turnstile widget mounts after a moment. Clicking Add appends a guest row; `×` removes it. Submit logs `rsvp-form: submit not yet wired` to the console (Turnstile interaction is fine — submit isn't wired yet).

Delete the smoke file:

```bash
rm rsvp-smoke.html
```

- [ ] **Step 4: Commit**

```bash
git add scripts/rsvp-form.js
git commit -m "Add <rsvp-form> custom element shell (no submit yet)"
```

---

## Task 6: `<rsvp-form>` — submit, state machine, error handling

**Files:**
- Modify: `scripts/rsvp-form.js`

Replace the stubbed `_submit` with the full state machine: client-side validation, fetch, parse response, transition to `done` or `error`.

- [ ] **Step 1: Replace the `_submit` method**

In `scripts/rsvp-form.js`, find:

```js
    _submit() {
      // implemented in Task 6
      console.warn("rsvp-form: submit not yet wired");
    }
```

Replace it with:

```js
    async _submit() {
      this._snapshotGuests();
      const nameEl = this._root.querySelector('input[name="name"]');
      const emailEl = this._root.querySelector('input[name="email"]');
      const name = (nameEl?.value ?? "").trim();
      const email = (emailEl?.value ?? "").trim();
      const guests = this._guests.map((g) => g.trim()).filter(Boolean);
      const turnstileToken = this._turnstileToken;

      if (!name) return this._fail("Please enter your name.");
      if (!email) return this._fail("Please enter your email.");
      if (!/^\S+@\S+\.\S+$/.test(email)) return this._fail("That email address doesn't look right.");
      if (guests.length > GUESTS_MAX) return this._fail(`Please list at most ${GUESTS_MAX} additional guests.`);
      if (!turnstileToken) return this._fail("Please complete the bot check.");

      this._state = "submitting";
      this._error = "";
      this._render();

      let res;
      try {
        res = await fetch(this._endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, guests, turnstileToken }),
        });
      } catch {
        // re-fill the inputs on error
        this._restoreInputs(name, email);
        // Turnstile tokens are single-use; force a fresh widget for retry.
        this._turnstileToken = "";
        return this._fail("Couldn't reach the server. Please try again.");
      }

      if (res.ok) {
        this._state = "done";
        this._error = "";
        this._turnstileToken = "";
        this._render();
        this.dispatchEvent(new CustomEvent("rsvp-submitted", { bubbles: true, composed: true }));
        return;
      }

      let serverMsg = "";
      try {
        const body = await res.json();
        if (body && typeof body.error === "string") serverMsg = body.error;
      } catch {}
      this._restoreInputs(name, email);
      this._turnstileToken = "";
      if (res.status >= 500) {
        return this._fail(serverMsg || "Something went wrong on our end. Please try again in a moment.");
      }
      return this._fail(serverMsg || "Something looked off with that submission. Please check the fields.");
    }

    _restoreInputs(name, email) {
      // The next render is in editing state; pre-seed values so they survive the re-render.
      this._pendingName = name;
      this._pendingEmail = email;
    }

    _fail(message) {
      this._state = "error";
      this._error = message;
      this._render();
    }
```

- [ ] **Step 2: Make `_render` honor `_pendingName` / `_pendingEmail`**

Find this block in `_html()`:

```js
          <label class="fld">
            <span>Your name</span>
            <input class="txt" type="text" name="name" required
                   maxlength="${NAME_MAX}" autocomplete="name"
                   ${isSubmitting ? "disabled" : ""}>
          </label>

          <label class="fld">
            <span>Email</span>
            <input class="txt" type="email" name="email" required
                   maxlength="${EMAIL_MAX}" autocomplete="email"
                   ${isSubmitting ? "disabled" : ""}>
          </label>
```

Replace with:

```js
          <label class="fld">
            <span>Your name</span>
            <input class="txt" type="text" name="name" required
                   maxlength="${NAME_MAX}" autocomplete="name"
                   value="${escapeAttr(this._pendingName ?? "")}"
                   ${isSubmitting ? "disabled" : ""}>
          </label>

          <label class="fld">
            <span>Email</span>
            <input class="txt" type="email" name="email" required
                   maxlength="${EMAIL_MAX}" autocomplete="email"
                   value="${escapeAttr(this._pendingEmail ?? "")}"
                   ${isSubmitting ? "disabled" : ""}>
          </label>
```

Then find the existing `reset()` method:

```js
    reset() {
      this._state = "editing";
      this._guests = [];
      this._error = "";
      this._render();
      const nameEl = this._root.querySelector('input[name="name"]');
      if (nameEl) nameEl.value = "";
      const emailEl = this._root.querySelector('input[name="email"]');
      if (emailEl) emailEl.value = "";
    }
```

Replace with:

```js
    reset() {
      this._state = "editing";
      this._guests = [];
      this._error = "";
      this._pendingName = "";
      this._pendingEmail = "";
      this._render();
    }
```

- [ ] **Step 3: Snapshot inputs before transitions, too**

Find this in `_wireEvents()`:

```js
      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          this._submit();
        });
      }
```

Replace with:

```js
      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          // capture current input values into _pendingName/_pendingEmail so a failed
          // submit re-renders with the user's text intact
          const nameEl = root.querySelector('input[name="name"]');
          const emailEl = root.querySelector('input[name="email"]');
          this._pendingName = nameEl?.value ?? "";
          this._pendingEmail = emailEl?.value ?? "";
          this._submit();
        });
      }
```

- [ ] **Step 4: Syntax check**

```bash
node --check scripts/rsvp-form.js
```

Expected: no output.

- [ ] **Step 5: Manual offline smoke test**

Recreate the smoke file from Task 5 (same content). Serve the project root with `python3 -m http.server 8000` and visit `http://localhost:8000/rsvp-smoke.html`. Wait for the Turnstile widget to render and tick; then click "Send RSVP" with a real-looking name and email. There's no real backend at `/api/rsvp` on a static server, so `fetch` will return 404 (or the static index, depending on the server) — either way, the form should land in the `error` state with your name/email still filled in. Submitting with an empty name should short-circuit to "Please enter your name." with no network call.

Delete the smoke file when done.

- [ ] **Step 6: Commit**

```bash
git add scripts/rsvp-form.js
git commit -m "Wire <rsvp-form> submit + state machine"
```

---

## Task 7: Wire RSVP into `index.html`

**Files:**
- Modify: `index.html`

Add the script tag, the page-specific styles, the RSVP button on the Service card, the `<dialog>` wrapping the form, the open/close JS, and a footer link.

- [ ] **Step 1: Create `scripts/rsvp-config.js`**

This file declares the public Turnstile site key. Create `scripts/rsvp-config.js` with:

```js
// Turnstile site key. Public — safe to commit. Replace the testing key with
// the real production site key once you've created a Turnstile site at
// https://dash.cloudflare.com/?to=/:account/turnstile and run
// `wrangler secret put TURNSTILE_SECRET_KEY` for the matching secret.
//
// "1x00000000000000000000AA" is Cloudflare's "always passes (visible)"
// testing key — fine for local dev and CI, NEVER for production.
window.RSVP_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
```

- [ ] **Step 2: Load the scripts in `<head>`**

In `index.html`, find:

```html
<script src="scripts/lantern-wall.js"></script>
```

Add three sibling lines directly after it:

```html
<script src="scripts/lantern-wall.js"></script>
<script src="scripts/rsvp-config.js"></script>
<script src="scripts/rsvp-form.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
```

`render=explicit` tells Turnstile not to scan the page for `.cf-turnstile` elements (we render via `window.turnstile.render(...)` from inside the shadow DOM). `async defer` means the form's mount logic must wait/poll for `window.turnstile` to appear — which it already does (see Task 5's `_mountTurnstile` retry loop).

- [ ] **Step 3: Add page-specific styles**

In `index.html`'s `<style>` block, find the line that defines `.back-to-picker` near the bottom of the block (right before `</style>`):

```css
  .back-to-picker { background: rgba(10,20,34,0.85); border-color: var(--navy-line); color: var(--ivory-soft); }
```

Add immediately after it (still inside `</style>`):

```css
  .rsvp-cta { margin-top: 36px; }
  .rsvp-btn {
    display: inline-block;
    padding: 14px 32px;
    border: 1px solid var(--brass);
    background: transparent;
    color: var(--brass-light);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease;
  }
  .rsvp-btn:hover { background: var(--brass); color: var(--navy-deep); }

  .rsvp-dialog {
    border: 1px solid var(--brass);
    background: var(--navy);
    color: var(--ivory);
    padding: 0;
    width: min(520px, 92vw);
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 30px 80px rgba(0,0,0,0.5);
  }
  .rsvp-dialog::backdrop { background: rgba(10,20,34,0.78); backdrop-filter: blur(4px); }
  .rsvp-close {
    position: absolute; top: 10px; right: 12px;
    width: 32px; height: 32px;
    background: transparent; border: 1px solid transparent;
    color: var(--ivory-soft); cursor: pointer;
    font-size: 22px; line-height: 1;
  }
  .rsvp-close:hover { color: var(--brass-light); border-color: var(--brass); }
  .rsvp-dialog-inner { position: relative; }
```

- [ ] **Step 4: Add the RSVP button to the Service card**

Find this block in `index.html`:

```html
    <div class="service-grid">
      <div><small>Date & Time</small><b>May 30, 2026 @ 12:00 PM</b></div>
      <div><small>Place</small><b>1275 Harbor Bay Parkway</b></div>
    </div>
  </div>
</section>
```

Replace with:

```html
    <div class="service-grid">
      <div><small>Date & Time</small><b>May 30, 2026 @ 12:00 PM</b></div>
      <div><small>Place</small><b>1275 Harbor Bay Parkway</b></div>
    </div>
    <div class="rsvp-cta">
      <button type="button" class="rsvp-btn" data-rsvp-open>RSVP</button>
    </div>
  </div>
</section>

<dialog class="rsvp-dialog" id="rsvp-dialog" aria-labelledby="rsvp-dialog-title">
  <div class="rsvp-dialog-inner">
    <button type="button" class="rsvp-close" data-rsvp-close aria-label="Close">×</button>
    <rsvp-form id="memorial-rsvp" endpoint="/api/rsvp"
      style="--rsvp-ink: var(--ivory); --rsvp-ink-soft: var(--ivory-soft); --rsvp-accent: var(--brass); --rsvp-line: rgba(200,153,104,0.3); --rsvp-bg: transparent; --rsvp-serif: 'Cormorant Garamond', serif;"></rsvp-form>
  </div>
</dialog>
```

- [ ] **Step 5: Add the open/close script before `</body>`**

Find the closing `</footer>` line near the end of `index.html`:

```html
  <div class="foot-copy">In Honored Memory · Melvin's Family · MMXXVI</div>
</footer>

</body>
```

Replace with:

```html
  <div class="foot-copy">In Honored Memory · Melvin's Family · MMXXVI</div>
</footer>

<script>
  (function () {
    const dialog = document.getElementById("rsvp-dialog");
    const form = document.getElementById("memorial-rsvp");
    if (!dialog || !form) return;

    document.querySelectorAll("[data-rsvp-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      });
    });

    dialog.querySelectorAll("[data-rsvp-close]").forEach((btn) => {
      btn.addEventListener("click", () => dialog.close());
    });

    dialog.addEventListener("close", () => {
      if (form._state === "done") form.reset();
    });

    form.addEventListener("rsvp-submitted", () => {
      // keep the dialog open so the user sees the thank-you state
    });
  })();
</script>

</body>
```

- [ ] **Step 6: Add the RSVP link to the footer**

In `index.html`, find:

```html
  <div class="foot-links">
    <a href="#service">Service</a>
  </div>
```

Replace with:

```html
  <div class="foot-links">
    <a href="#service">Service</a>
    <a href="#" data-rsvp-open>RSVP</a>
  </div>
```

The `data-rsvp-open` attribute reuses the same handler as the Service-card button (the script in step 4 selects all `[data-rsvp-open]`).

- [ ] **Step 7: Manual verification**

Run:

```bash
grep -n "rsvp-btn\|rsvp-dialog\|<rsvp-form\|scripts/rsvp-form.js\|scripts/rsvp-config.js\|turnstile/v0/api.js\|data-rsvp-open" index.html
```

Expected: at least 10 matching lines covering the four script tags (lantern-wall, rsvp-config, rsvp-form, Turnstile), two CSS rules, the button, the dialog, the form, the close button, and the footer link.

Run:

```bash
python3 -c "import html.parser, sys; p=html.parser.HTMLParser(); p.feed(open('index.html').read()); print('ok')"
```

Expected: prints `ok`. (Quick smoke that the HTML parses; not a real validator but catches gross malformedness.)

- [ ] **Step 8: Commit**

```bash
git add scripts/rsvp-config.js index.html
git commit -m "Wire RSVP button + dialog + Turnstile into the Service card"
```

---

## Task 8: Admin page — `admin.html`

**Files:**
- Create: `admin.html`

Single static file. Visual language matches `login.html` (centered card → table layout when authenticated). Token gate is real: it round-trips through `/api/rsvps` and only renders the table on a 200.

- [ ] **Step 1: Create `admin.html`**

Create the file with:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSVPs · Melvin Lum</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --navy-deep: #0a1422; --navy: #0f1d31; --navy-line: #1f3251;
    --brass: #c89968; --brass-light: #e2c089;
    --ivory: #f3ead7; --ivory-soft: #d8cdb4; --muted: #8a8068;
  }
  *,*::before,*::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", system-ui, sans-serif;
    background: linear-gradient(180deg, var(--navy) 0%, var(--navy-deep) 100%);
    color: var(--ivory); min-height: 100vh; padding: 32px;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  a { color: var(--brass-light); }

  .gate { max-width: 420px; margin: 8vh auto 0; text-align: center; }
  .gate h1 {
    font-family: "Cormorant Garamond", serif; font-weight: 500;
    font-size: 32px; margin: 0 0 24px;
  }
  .gate p { color: var(--ivory-soft); font-size: 14px; margin: 0 0 24px; }
  .gate form { display: flex; flex-direction: column; gap: 14px; }
  .gate label {
    text-align: left; font-size: 10px; letter-spacing: 0.32em;
    text-transform: uppercase; color: var(--brass);
  }
  .gate input {
    background: transparent; border: 1px solid var(--navy-line);
    color: var(--ivory); font: inherit; font-size: 14px;
    padding: 12px 14px; outline: none;
  }
  .gate input:focus { border-color: var(--brass); }
  .gate button {
    background: var(--brass); color: var(--navy-deep); border: 0;
    padding: 12px 18px; font: inherit; font-size: 11px;
    letter-spacing: 0.3em; text-transform: uppercase; font-weight: 600; cursor: pointer;
  }
  .gate button:hover { background: var(--brass-light); }
  .gate .err {
    color: #d99c8a; font-size: 12px; letter-spacing: 0.18em;
    text-transform: uppercase; min-height: 16px; margin-top: 4px;
  }

  .panel { max-width: 1100px; margin: 0 auto; }
  .panel-head {
    display: flex; align-items: end; justify-content: space-between;
    border-bottom: 1px solid var(--navy-line); padding-bottom: 18px; margin-bottom: 22px;
    gap: 18px; flex-wrap: wrap;
  }
  .panel-head h1 {
    font-family: "Cormorant Garamond", serif; font-weight: 500;
    font-size: 28px; margin: 0;
  }
  .panel-head .stats { color: var(--ivory-soft); font-size: 13px; }
  .panel-head .stats b { color: var(--brass-light); font-weight: 500; }
  .panel-head button.export {
    background: transparent; color: var(--brass-light);
    border: 1px solid var(--brass); padding: 10px 16px;
    font: inherit; font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; cursor: pointer;
  }
  .panel-head button.export:hover { background: var(--brass); color: var(--navy-deep); }
  .panel-head button.signout {
    background: transparent; color: var(--ivory-soft);
    border: 1px solid var(--navy-line); padding: 10px 14px;
    font: inherit; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; cursor: pointer;
  }
  .panel-head button.signout:hover { color: var(--brass-light); border-color: var(--brass); }

  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 12px 10px;
    border-bottom: 1px solid var(--navy-line); vertical-align: top;
  }
  th {
    font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
    color: var(--brass); font-weight: 500;
  }
  td { font-size: 14px; color: var(--ivory); }
  td.email { color: var(--ivory-soft); font-size: 13px; }
  td.guests { color: var(--ivory-soft); font-size: 13px; }
  td.size { color: var(--brass-light); font-variant-numeric: tabular-nums; }
  td.when { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; font-style: italic; }

  .hidden { display: none !important; }
</style>
</head>
<body>

<section class="gate" id="gate" aria-labelledby="gate-title">
  <h1 id="gate-title">RSVP admin</h1>
  <p>Paste the admin token to view submissions.</p>
  <form id="gate-form" autocomplete="off">
    <label for="tok">Admin token</label>
    <input id="tok" type="password" autocomplete="off" autofocus required>
    <button type="submit">Unlock</button>
    <div class="err" id="err" role="alert"></div>
  </form>
</section>

<section class="panel hidden" id="panel" aria-labelledby="panel-title">
  <div class="panel-head">
    <h1 id="panel-title">RSVPs</h1>
    <div class="stats" id="stats"></div>
    <div>
      <button type="button" class="export" id="export">Export CSV</button>
      <button type="button" class="signout" id="signout">Sign out</button>
    </div>
  </div>
  <div id="table-wrap">
    <div class="empty" id="empty">Loading…</div>
  </div>
</section>

<script>
(function () {
  const TOKEN_KEY = "melvin-memorial::admin-token";
  const gate = document.getElementById("gate");
  const panel = document.getElementById("panel");
  const gateForm = document.getElementById("gate-form");
  const tokInput = document.getElementById("tok");
  const errEl = document.getElementById("err");
  const statsEl = document.getElementById("stats");
  const tableWrap = document.getElementById("table-wrap");
  const exportBtn = document.getElementById("export");
  const signOutBtn = document.getElementById("signout");

  let cached = null;

  async function load(token) {
    const res = await fetch("/api/rsvps", {
      headers: { Authorization: "Bearer " + token },
    });
    if (res.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error("server_" + res.status);
    return res.json();
  }

  function show(panelData) {
    cached = panelData;
    statsEl.innerHTML =
      "<b>" + panelData.total_parties + "</b> parties · " +
      "<b>" + panelData.total_attendees + "</b> attendees";

    tableWrap.innerHTML = "";

    if (!panelData.rsvps.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No RSVPs yet.";
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>When</th><th>Name</th><th>Email</th><th>Guests</th><th>Party</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const r of panelData.rsvps) {
      const tr = document.createElement("tr");

      const tdWhen = document.createElement("td");
      tdWhen.className = "when";
      tdWhen.textContent = formatWhen(r.created_at);
      tr.appendChild(tdWhen);

      const tdName = document.createElement("td");
      tdName.textContent = r.name;
      tr.appendChild(tdName);

      const tdEmail = document.createElement("td");
      tdEmail.className = "email";
      tdEmail.textContent = r.email;
      tr.appendChild(tdEmail);

      const tdGuests = document.createElement("td");
      tdGuests.className = "guests";
      tdGuests.textContent = (r.guest_names || []).join(", ");
      tr.appendChild(tdGuests);

      const tdSize = document.createElement("td");
      tdSize.className = "size";
      tdSize.textContent = String(r.party_size);
      tr.appendChild(tdSize);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  function formatWhen(s) {
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC
    const d = new Date(s.replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString();
  }

  function downloadCsv(panelData) {
    const maxGuests = panelData.rsvps.reduce(
      (m, r) => Math.max(m, (r.guest_names || []).length),
      0
    );
    const headers = ["created_at", "name", "email", "party_size"];
    for (let i = 1; i <= maxGuests; i++) headers.push("guest_" + i);
    const rows = [headers];
    for (const r of panelData.rsvps) {
      const row = [r.created_at, r.name, r.email, String(r.party_size)];
      for (let i = 0; i < maxGuests; i++) row.push((r.guest_names || [])[i] ?? "");
      rows.push(row);
    }
    const csv = rows
      .map((row) => row.map(csvEscape).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dt = new Date();
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    a.href = url;
    a.download = "rsvps-" + yyyy + "-" + mm + "-" + dd + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function showGate(message) {
    errEl.textContent = message ?? "";
    panel.classList.add("hidden");
    gate.classList.remove("hidden");
    tokInput.value = "";
    tokInput.focus();
  }

  function showPanel() {
    gate.classList.add("hidden");
    panel.classList.remove("hidden");
  }

  async function tryToken(token, isInitial) {
    try {
      const data = await load(token);
      sessionStorage.setItem(TOKEN_KEY, token);
      showPanel();
      show(data);
    } catch (err) {
      if (err.message === "unauthorized") {
        showGate(isInitial ? "" : "That token isn't right.");
      } else {
        showGate("Couldn't reach the server.");
      }
    }
  }

  gateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = tokInput.value.trim();
    if (!t) return;
    tryToken(t, false);
  });

  exportBtn.addEventListener("click", () => {
    if (cached) downloadCsv(cached);
  });

  signOutBtn.addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    cached = null;
    showGate();
  });

  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored) tryToken(stored, true);
})();
</script>

</body>
</html>
```

- [ ] **Step 2: Manual verification**

```bash
python3 -c "import html.parser, sys; p=html.parser.HTMLParser(); p.feed(open('admin.html').read()); print('ok')"
```

Expected: `ok`.

```bash
grep -c "innerHTML" admin.html
```

Expected: `2` (the `<thead>` row and the `statsEl` line — both with controlled-by-us content, no user input. All user-derived values use `textContent`.)

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Add token-gated admin page with RSVP list and CSV export"
```

---

## Task 9: End-to-end manual test plan + production smoke

**Files:** none (this task is purely verification; no code changes).

This task is the host-run integration test. Most steps require Cloudflare credentials; document each command precisely.

- [ ] **Step 1: Local boot**

```bash
wrangler d1 migrations apply melvin-rsvps --local
wrangler dev
```

Expected: dev server starts on `http://localhost:8787`. Visiting that URL redirects to `login.html` (existing site behavior). After entering the password, `index.html` loads with the new RSVP button on the Service card.

- [ ] **Step 2: Submit a happy-path RSVP**

In the browser, click RSVP → fill name "Test One", email "test@example.com", add 2 guests "Alice", "Bob", remove one of them, submit.

Expected: spinner briefly shows "Sending…", then the modal swaps to "Thank you" with a "Submit another RSVP" link.

Verify the row landed:

```bash
wrangler d1 execute melvin-rsvps --local \
  --command "SELECT id, name, email, guest_names, party_size FROM rsvps ORDER BY id DESC LIMIT 1"
```

Expected: a row with name `Test One`, `party_size = 2`, `guest_names = '["Alice"]'` (or `["Bob"]` depending on which you kept).

- [ ] **Step 3: Validation paths**

Use `curl` to bypass the form's own client-side check. While `wrangler dev` runs with no `TURNSTILE_SECRET_KEY` set, the Worker uses Cloudflare's "always passes" testing secret — so any non-empty string in `turnstileToken` succeeds. `.dev.vars` (created in Step 4) sets a real-looking dev token; either way the test secret accepts anything.

```bash
# missing name
curl -s -X POST http://localhost:8787/api/rsvp \
  -H "Content-Type: application/json" \
  -d '{"name":"","email":"a@b.co","guests":[],"turnstileToken":"x"}'
```

Expected: `{"error":"Please enter your name."}` with HTTP 400.

```bash
# bad email
curl -s -X POST http://localhost:8787/api/rsvp \
  -H "Content-Type: application/json" \
  -d '{"name":"X","email":"not-an-email","guests":[],"turnstileToken":"x"}'
```

Expected: `{"error":"That email address doesn't look right."}`.

```bash
# wrong content type
curl -s -X POST http://localhost:8787/api/rsvp \
  -H "Content-Type: text/plain" --data 'foo'
```

Expected: `{"error":"Expected application/json"}` with HTTP 415.

```bash
# too many guests
curl -s -X POST http://localhost:8787/api/rsvp \
  -H "Content-Type: application/json" \
  -d '{"name":"X","email":"a@b.co","guests":["a","b","c","d","e","f","g","h","i","j","k"],"turnstileToken":"x"}'
```

Expected: `{"error":"Please list at most 10 additional guests."}`.

```bash
# missing turnstile token
curl -s -X POST http://localhost:8787/api/rsvp \
  -H "Content-Type: application/json" \
  -d '{"name":"X","email":"a@b.co","guests":[]}'
```

Expected: `{"error":"Bot check failed. Please try again."}`.

```bash
# real bot rejection: temporarily set TURNSTILE_SECRET_KEY to "2x0000000000000000000000000000000AA" in .dev.vars (Cloudflare's always-fails secret), restart wrangler dev, retry a valid request.
# The Worker should respond with: {"error":"Bot check failed. Please try again."}
# Revert .dev.vars when done.
```

- [ ] **Step 4: Admin gate**

Pre-seed the admin token for local dev. Wrangler stores secrets per-environment; for local, set in `.dev.vars` (created in the project root):

```bash
cat > .dev.vars <<'EOF'
ADMIN_TOKEN=local-dev-token-123
# Cloudflare's "always passes" Turnstile secret. NEVER use in prod.
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
EOF
```

Add `.dev.vars` to `.gitignore`:

```bash
grep -q '^.dev.vars$' .gitignore 2>/dev/null || echo '.dev.vars' >> .gitignore
```

Restart `wrangler dev`. Then:

```bash
# wrong token
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong" \
  http://localhost:8787/api/rsvps
```

Expected: `401`.

```bash
# right token
curl -s -H "Authorization: Bearer local-dev-token-123" \
  http://localhost:8787/api/rsvps | head -c 200
```

Expected: JSON beginning with `{"rsvps":[...`.

In the browser, visit `http://localhost:8787/admin.html`. Expected: gate screen. Paste `local-dev-token-123` → table renders with the RSVP from step 2. Click "Export CSV" → file `rsvps-YYYY-MM-DD.csv` downloads with one data row plus header. Click "Sign out" → returns to the gate.

- [ ] **Step 5: Production smoke (host-run)**

After the host has completed the setup steps in `docs/RSVP_SETUP.md` and run `wrangler deploy`:

1. Visit the production URL, unlock with the memorial password, click RSVP, submit a real RSVP.
2. Visit `<production-url>/admin.html`, paste the production admin token, confirm the row appears.
3. Run:
   ```bash
   wrangler d1 execute melvin-rsvps --remote \
     --command "DELETE FROM rsvps WHERE email='test@example.com'"
   ```
   …to remove the smoke-test row.

- [ ] **Step 6: Commit (no-op task — nothing to commit)**

This task only adds verification; no source changes. Skip the commit step.

---

## Summary of what was built

When this plan completes, the repo has:

- A Cloudflare Worker that intercepts `/api/rsvp` and `/api/rsvps` and otherwise serves the existing static site unchanged.
- A D1 database `melvin-rsvps` with one table `rsvps`, populated by RSVP submissions.
- A `<rsvp-form>` autonomous custom element (shadow DOM, themed) handling validation, submission, and post-submit states, with an embedded Cloudflare Turnstile bot check.
- Server-side Turnstile verification: every accepted RSVP has a token validated against `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
- An RSVP button on the existing Service card that opens a native `<dialog>` containing the form, plus a footer link.
- A token-gated `admin.html` listing all RSVPs and exporting CSV.
- A setup doc (`docs/RSVP_SETUP.md`) covering the one-time D1 / Turnstile / secret / deploy commands the host must run.

No tests were added — the project has no test framework and this feature didn't justify introducing one. Verification is the manual checklist in Task 9.
