# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A memorial site for Captain Melvin Lum, deployed as a Cloudflare Worker (`wrangler.jsonc`, `src/worker.js`). `index.html` is the memorial itself, served at `/`; it checks a `sessionStorage` unlock flag at the top of `<head>` and `location.replace`s to `login.html` if the flag is missing. `login.html` is the password gate; on success it sets the flag and redirects to `index.html` (`/`). The Worker also exposes `/api/rsvp` (POST, public + Turnstile), `/api/rsvps` (GET, admin), `/api/lanterns` (GET public; POST gated by post password; DELETE :id admin), `/api/book-claims` (POST, public + Turnstile; GET admin; DELETE :id admin), and `/media/:key` (GET public, R2-backed).

There is no client build step. Static assets are served via the Worker's `ASSETS` binding; the Worker code itself is plain ES module that wrangler ships as-is. Local dev: `wrangler dev` (apply migrations first with `wrangler d1 migrations apply melvin-rsvps --local`).

### Three independent secrets

- **Site-unlock password** — SHA-256 hash baked into `login.html`. Cosmetic; anyone reading JS can bypass.
- **`POST_PASSWORD`** (Worker secret) — required to submit a lantern. Cached client-side in `sessionStorage` under `lantern-wall::post-password`. Constant-time-compared in the Worker.
- **`ADMIN_TOKEN`** (Worker secret) — Bearer token for `/admin`, used by both `/api/rsvps` and `DELETE /api/lanterns/:id`. Cached client-side under `melvin-memorial::admin-token`.

To rotate any of them, see `docs/RSVP_SETUP.md`.

## Layout

```
index.html  the memorial, served at / — page-specific styles inline, content sections, custom-element instances
login.html  password gate — redirects to / on unlock
admin.html  token-gated panel for RSVPs, Lanterns, and Book Claims; tabs share the same Bearer token
src/worker.js   Cloudflare Worker — API routes + ASSETS fallback
migrations/     D1 SQL migrations (rsvps + lanterns)
styles/shared.css  cross-section primitives (.block, .section-head, .gal-grid, .vid-grid, .tl-rail, .notify-form)
scripts/        custom elements + rsvp config, no framework, no module system (loaded as plain <script>)
```

`shared.css` borders use `currentColor` so each section inherits the page theme via the parent's `color` — don't hard-code border colors there.

## Custom elements

Both are defined as autonomous custom elements with shadow DOM, registered on script load. Both are themable via CSS custom properties on the host element (see element source for the full token list).

### `<image-slot>` — `scripts/image-slot.js`

Drag-and-drop image placeholder. **Persistence model is non-obvious and load-bearing:**

- Reads filled-image data from `.image-slots.state.json` (sidecar at the project root) via `fetch()`.
- Writes through `window.omelette.writeFile`, a host bridge that only allowlists `*.state.json` basenames at the project root.
- **Outside the omelette runtime the slot is read-only** — drag/drop is silently inert. There is no error path for this; treat it as expected.
- The HTML page must live at the same directory as the sidecar (host bridge constraint).
- Every slot needs a unique `id` — that's the persistence key. Without it, drops do not survive reload.
- Accepted formats: PNG, JPEG, WebP, AVIF. SVG and GIF are deliberately rejected (script risk + animated-GIF re-encode loses frames).
- `fit="cover"` (default) enables a double-click reframe mode; `contain`/`fill` are static.

### `<lantern-wall>` — `scripts/lantern-wall.js`

Server-backed message wall (text + up to 4 photos) with a focus view. Reads from `GET /api/lanterns`, posts to `POST /api/lanterns` (multipart, `media` field repeated per photo) with the `X-Post-Password` header — the password gate is the only check; there is no Turnstile on this endpoint. Photos go to R2 (8MB cap each, image MIME types only); the Worker serves them back at `/media/<key>` with long cache headers. Seed messages live in `migrations/0003_seed_lanterns.sql`, not in the JS.

Photos are normalized into a `lantern_media` junction table (`lantern_id`, `position`, `media_key`, `media_type`) — `migrations/0004_lantern_media.sql` creates it and backfills any existing single photo at position 0. The legacy `lanterns.media_key` / `media_type` columns are deprecated: readers ignore them, the Worker no longer writes to them, and the delete handler still cleans up any straggler key it finds there as defense in depth. Wall thumbnails show the first photo with a `+N` badge when more exist; the focus modal renders a carousel (prev/next buttons, dot tabs, ←/→ keyboard) when there are multiple.

### `<rsvp-form>` — `scripts/rsvp-form.js`

Autonomous custom element for the RSVP dialog. Renders a Turnstile widget in light DOM via a slot — the host page in `index.html` calls `setTurnstileToken` / `clearTurnstileToken` on the element since the widget can't run inside shadow DOM. POSTs JSON to `/api/rsvp`. Site key in `scripts/rsvp-config.js`; secret + DB in Worker env.

## When editing

- Adding a new image slot: give it a fresh `id`, size it via the parent CSS (slot inherits container width/height), and remember it will only be fillable inside the omelette runtime.
- Adding a new section: follow the `<section class="block …">` + `.section-head` (`.section-num` + `.section-meta`) pattern already used in `index.html`; theme tokens come from the page-level `:root` block at the top of the file.
- Page-specific styling lives inline in `index.html`; only put rules in `styles/shared.css` if they are reusable primitives.
- The "Books" gift section lives in both `index.html` (section 04, between Livestream and Lanterns) and `preview.html`. The book id → title/author/synopsis table is **duplicated three times**: server-side in `src/worker.js` (`BOOKS` constant; only title + author there) and client-side in each of `index.html` and `preview.html`'s books `<script>`. If a title, author, or synopsis changes, update all three. Submissions go through `POST /api/book-claims` and are gated by Cloudflare Turnstile (same `TURNSTILE_SECRET_KEY` as the RSVP form; both pages already load `scripts/rsvp-config.js` and the v0 challenges script). Admins manage submissions under the Books tab in `admin.html`.
