# RSVP Feature — Design

**Date:** 2026-05-14
**Branch:** `worktree-rsvp-feature`
**Status:** Approved (brainstorming complete; ready for implementation plan)

## Goal

Let memorial-site visitors RSVP to the May 30, 2026 service through a form on the existing memorial page. Submissions land in a database the host can read, with each entry recording the primary guest's name and email plus the names of any additional people they're bringing. The host can view and export the list through a password-gated admin page.

## Scope

In:
- A modal RSVP form on `index.html` opened from the Service section.
- A Cloudflare Worker route that accepts submissions and writes them to a D1 database.
- A separate admin page (`admin.html`) that lists submissions and exports CSV.
- Token-based auth on the admin read endpoint, enforced server-side.

Out:
- Confirmation or notification emails (deferred — modal-only confirmation for now).
- Editing or deleting RSVPs through any UI (append-only model; CLI for any cleanup).
- Rate limiting (deferred until we see actual abuse).
- A "regrets / not attending" signal (form is opt-in).
- Test harness (project has none and this feature doesn't justify introducing one).

---

## Architecture

```
Browser                                              Cloudflare
─────────                                            ───────────
index.html                                           Worker (src/worker.js)
  Service card → "RSVP" button                       ├─ POST /api/rsvp     → insert into D1
   └─ <dialog> contains <rsvp-form id="…">           ├─ GET  /api/rsvps    → JSON, requires admin token
                                                     └─ * (anything else)  → ASSETS.fetch (static)
admin.html
  Token gate → fetch /api/rsvps → render table       D1 database: melvin-rsvps
   └─ "Export CSV" button                              └─ table: rsvps
```

Three new pieces:

1. **`src/worker.js`** — new Worker entry script. Owns `/api/*` routes and falls through to `env.ASSETS.fetch(request)` for everything else. `wrangler.jsonc` gains `main: "src/worker.js"` and a `d1_databases` binding.
2. **D1 database `melvin-rsvps`** — bound as `env.DB`. Schema in a checked-in migration.
3. **`<rsvp-form>` custom element** — `scripts/rsvp-form.js`. Autonomous element with shadow DOM and CSS-custom-property theming, matching the `<lantern-wall>` pattern already in the repo.

The `<dialog>` wrapping is page-level (in `index.html`), not part of the custom element — `<dialog>` works best as a top-level element that owns page modality.

---

## Data model

Single D1 table. Each row is one party.

```sql
CREATE TABLE rsvps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  guest_names   TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  party_size    INTEGER NOT NULL,                -- 1 + len(guest_names), denormalized for SUM
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent    TEXT,
  ip_country    TEXT                             -- from CF-IPCountry header
);

CREATE INDEX idx_rsvps_created_at ON rsvps(created_at DESC);
```

Decisions:

- **`guest_names` as a JSON string** rather than a child table. Additional guests have no independent identity (no email, no follow-up); they're labels on a roster, so a join would buy nothing. SQLite `json_each` can still expand them if needed.
- **`party_size` denormalized** so total headcount is `SELECT SUM(party_size) FROM rsvps`. Computed by the Worker on insert; never trust the client.
- **Append-only.** No update or delete API. Duplicate submissions create duplicate rows; the host triages duplicates manually.
- **No `is_attending` flag.** Form is opt-in only; non-attendees simply don't submit.
- **`ip_country`** is the only network-derived field stored — useful only to spot a flood from somewhere unexpected during spam triage.

Migration path: `migrations/0001_create_rsvps.sql`, applied via `wrangler d1 migrations apply melvin-rsvps`.

---

## `<rsvp-form>` custom element

`scripts/rsvp-form.js`. Autonomous custom element registered on script load. Shadow DOM. Themable via CSS custom properties on the host.

### Host-page markup

```html
<rsvp-form id="memorial-rsvp"
  endpoint="/api/rsvp"
  style="--rsvp-ink: #f3ead7; --rsvp-accent: #c89968; --rsvp-line: rgba(200,153,104,0.3); --rsvp-bg: rgba(10,20,34,0.6); --rsvp-serif: 'Cormorant Garamond', serif;">
</rsvp-form>
```

### Internal states

Exactly one rendered at a time inside the shadow root:

1. **`editing`** — the form. Fields:
   - **Your name** — required, text, `maxlength=80`, `autocomplete="name"`.
   - **Email** — required, `type="email"`, `maxlength=120`, `autocomplete="email"`.
   - **Guests you'll bring** — list of rows; each row is a name input plus a "Remove" button. An "Add guest" button appends an empty row. Starts with zero rows. Hard cap at 10 rows.
   - **Submit button** ("Send RSVP").
2. **`submitting`** — fields disabled, button shows "Sending…", `aria-busy="true"`. Prevents double-submit.
3. **`done`** — replaces the form with "Thank you — we look forward to seeing you" and a small "Submit another" link to reset to `editing`.
4. **`error`** — inline error above the form; form remains filled for retry.

### Client-side validation (UX only — server is authoritative)

- `name` and `email` non-empty after trim.
- `email` matches `/^\S+@\S+\.\S+$/`.
- Guest rows: empty rows are silently dropped before send (an unused empty row doesn't count as a person).

### Network call

```js
fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name, email, guests })
})
```

Any non-2xx → `error` state. If the response body parses as JSON with an `error` field, that text is shown verbatim.

### Accessibility

- Real `<label for>` pairs (no placeholder-as-label).
- Each "Remove" button has `aria-label="Remove guest"`.
- `done` and `error` panels announce via `role="status"` / `role="alert"`.
- Submit button uses `aria-busy` while submitting.

### Persistence

None inside the element. Reloading the page resets the form. Submitted data lives only in D1.

### Public API

- Method `reset()` — returns the element to `editing` state with empty fields. Called by the dialog wiring on close-after-submit.

---

## Worker endpoints (`src/worker.js`)

Default export is `{ fetch(request, env, ctx) }`. Routes branch on `URL(request.url).pathname`. Anything not matched falls through to `env.ASSETS.fetch(request)`.

### `POST /api/rsvp` — public

Accepts JSON `{ name: string, email: string, guests: string[] }`.

- Reject if `Content-Type` isn't `application/json` → 415.
- Parse body inside `try/catch` → 400 `{"error":"Invalid JSON"}` on failure.
- Server-side validation:
  - `name`: trimmed length 1–80
  - `email`: trimmed length 1–120, matches `/^\S+@\S+\.\S+$/`
  - `guests`: array, length 0–10 *after* filtering whitespace-only entries; each kept entry trimmed length 1–80
- Compute `party_size = 1 + guests.length` after filtering.
- Insert via prepared statement:
  ```js
  env.DB.prepare(
    "INSERT INTO rsvps (name, email, guest_names, party_size, user_agent, ip_country) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(
    name,
    email,
    JSON.stringify(guests),
    party_size,
    (request.headers.get("user-agent") ?? "").slice(0, 200) || null,
    request.headers.get("cf-ipcountry") ?? null
  ).run()
  ```
- 200 `{"ok": true}` on success.

CORS: not configured. The form is same-origin; no `Access-Control-Allow-Origin` header is set, which keeps cross-site form spam out.

### `GET /api/rsvps` — admin only

- Require `Authorization: Bearer <token>`. Compare against `env.ADMIN_TOKEN` using a constant-time check (SHA-256 both sides via `crypto.subtle`, then byte-compare). Mismatch or missing header → 401 `{"error":"Unauthorized"}`.
- `SELECT id, name, email, guest_names, party_size, created_at FROM rsvps ORDER BY created_at DESC`.
- Return JSON `{ rsvps: [...], total_parties: N, total_attendees: SUM(party_size) }`.

### Static fall-through

```js
return env.ASSETS.fetch(request);
```

`index.html`, `login.html`, `gallery.html`, scripts, and other assets continue to be served by Cloudflare's static-assets binding exactly as today.

---

## Admin page (`admin.html`)

A new top-level static file. Same brass-on-navy aesthetic as `login.html`, oriented around a data table.

- **Auth flow:** if `sessionStorage["melvin-memorial::admin-token"]` is missing, render a small password prompt screen. On submit, call `GET /api/rsvps` with `Authorization: Bearer <input>`. If 200, cache the token in `sessionStorage` and render the table. If 401, show "Wrong token, try again." This is a real gate — the Worker enforces it server-side.
- **Token provisioning:** the host sets the secret once via `wrangler secret put ADMIN_TOKEN` and pastes it into the page on first visit. Token is a long random string, generated by the host (e.g., `openssl rand -hex 32`).
- **Table columns:** `When · Name · Email · Guests · Party size`. Newest first. Guest names rendered as a comma-separated list per row.
- **Header strip:** total parties (count) and total attendees (sum of `party_size`).
- **CSV export:** generated client-side from the JSON already in hand. Filename `rsvps-YYYY-MM-DD.csv`. Columns: `created_at,name,email,party_size,guest_1,guest_2,…` flattened up to the dataset's max guest count.
- **No edit / delete UI.** Append-only model. Cleanup is a `wrangler d1 execute` moment.
- **Not linked from anywhere.** No nav link in `index.html`, no footer entry. Reach it by typing `/admin.html`. Reduces discoverability for casual visitors.

---

## `index.html` integration

Inside the existing `.service-card`, after the `.service-grid` block and before its closing `</div>`:

```html
<button type="button" class="rsvp-btn" data-rsvp-open>RSVP</button>

<dialog class="rsvp-dialog" id="rsvp-dialog">
  <button type="button" class="rsvp-close" data-rsvp-close aria-label="Close">×</button>
  <rsvp-form id="memorial-rsvp" endpoint="/api/rsvp" style="…theme tokens…"></rsvp-form>
</dialog>
```

- **Button styling** matches the existing brass-bordered language (same border + letterspacing as `.gal-cta a`), centered below the date/place grid.
- **Dialog** uses native `<dialog>`. Open via `dialog.showModal()`, close via `dialog.close()`, `×` button, or Escape (free with `<dialog>`). Backdrop styled via `::backdrop`.
- **Open/close wiring** is a small inline `<script>` at the bottom of `index.html` (~10 lines). Not worth a custom element of its own.
- **Reset on close:** if the form is in `done` state when the dialog closes, call its `reset()` method so the next open is fresh.
- **Mobile:** dialog `max-width: ~520px`, `max-height: 90vh`, internal scroll inside the form's shadow root. Reset the dialog's default browser margins.

### Footer

Add an "RSVP" anchor to `.foot-links` (alongside "Service") so the in-page link is reachable from the bottom of the page too.

### Page styles

The few `.rsvp-btn`, `.rsvp-dialog`, `.rsvp-close` rules live inline in `index.html`'s `<style>` block — they're page-specific chrome, not reusable primitives, so per the project convention they don't go in `styles/shared.css`.

---

## `wrangler.jsonc` delta

```jsonc
{
  ...,
  "main": "src/worker.js",
  "d1_databases": [
    { "binding": "DB", "database_name": "melvin-rsvps", "database_id": "<filled-in-by-wrangler>" }
  ]
}
```

`ADMIN_TOKEN` is set via `wrangler secret put ADMIN_TOKEN` and is *not* checked into source.

---

## Error handling

### Form

Every failure puts the user in a recoverable state, never a blank page:

- Network failure (`fetch` rejects) → `error` state: "Couldn't reach the server. Please try again."
- 4xx with JSON `{error}` → that message verbatim.
- 4xx without JSON → "Something looked off with that submission. Please check the fields."
- 5xx → "Something went wrong on our end. Please try again in a moment."
- Submit button is disabled while `submitting`, so a double click can't double-submit.

### Worker

Top-level `try/catch` in the `fetch` handler. Every code path returns a JSON response with the right status; never a thrown 500 from an unhandled exception. Caught exceptions log via `console.error` (visible through `wrangler tail`) with the *kind* of failure only — not the request body.

D1 failures (constraint violations, transient errors) are caught, logged, and surfaced as 500 to the form. The form's retry path is the recovery.

---

## Security

- **Server-side validation is authoritative.** Client validation is a UX nicety only.
- **Parameterized SQL** via `prepare(...).bind(...)`. No string concatenation.
- **No echoed PII.** The thank-you state in the modal doesn't render the submitted email back; there is no stored-XSS surface for an unauthenticated viewer.
- **Admin page renders names/emails as `textContent`**, never `innerHTML`. A malicious `<script>` in a name field renders as literal text.
- **Admin token** is a Worker secret. Compared in constant time. Cached in admin-side `sessionStorage` only after a successful 200. Never appears in URLs or in the Worker logs.
- **No PII in logs.**
- **Rate limiting** is intentionally absent. Field length caps + 10-guest cap + admin-only read are the current defenses; revisit if abuse appears.

---

## Testing

The project has no test framework today. We are not adding one for this feature — it would be the first test infra in the repo and is a much larger commitment than this work warrants. Manual test plan, executed during implementation:

1. **Local Worker boot** — `wrangler dev` with a local D1 binding (`wrangler d1 migrations apply melvin-rsvps --local`). Confirm `index.html` still loads, `POST /api/rsvp` returns 200, row appears in `wrangler d1 execute melvin-rsvps --local --command "SELECT * FROM rsvps"`.
2. **Validation paths** — empty name, empty email, malformed email, 11 guests, 200-char name → each returns 400 with a sensible message.
3. **Form happy path in a browser** — open dialog, fill in, add 2 guests, remove 1, submit → see thank-you state; close & reopen → fresh form.
4. **Network-failure UX** — kill `wrangler dev` mid-submit; form shows error state; restart; retry succeeds.
5. **Admin page** — wrong token → 401; right token → table renders correctly; CSV export downloads a well-formed file.
6. **Production smoke** — after deploy, hit `/api/rsvp` from the live page once, confirm row in remote D1, then delete the test row.

---

## Files added / changed

**Added:**
- `src/worker.js`
- `scripts/rsvp-form.js`
- `admin.html`
- `migrations/0001_create_rsvps.sql`

**Changed:**
- `index.html` — RSVP button, dialog, `<rsvp-form>` instance, open/close wiring, footer link, page-specific styles.
- `wrangler.jsonc` — `main` entry, `d1_databases` binding.

**Out-of-source setup steps (one-time):**
- `wrangler d1 create melvin-rsvps` → paste `database_id` into `wrangler.jsonc`.
- `wrangler d1 migrations apply melvin-rsvps` (and `--local` for local dev).
- `wrangler secret put ADMIN_TOKEN` (paste a long random string).
