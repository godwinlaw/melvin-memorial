# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A static memorial site for Captain Melvin Lum. `index.html` is the memorial itself, served at `/`; it checks a `sessionStorage` unlock flag at the top of `<head>` and `location.replace`s to `login.html` if the flag is missing. `login.html` is the password gate; on success it sets the flag and redirects to `index.html` (`/`). There is no build step, no package manager, no tests — serve the directory with any static server (`python3 -m http.server`, `npx serve`, etc.).

The gate is **cosmetic, not access control**: the password's SHA-256 lives in `login.html`, but anyone who reads the JS can bypass the check (e.g., set the unlock flag in DevTools). For real protection, use hosting-layer auth (Cloudflare Access, basic auth, etc.). To rotate the password, replace the `PASSWORD_HASH` constant in `login.html` with the new SHA-256 hex (`printf '%s' 'newpassword' | shasum -a 256`).

## Layout

```
index.html  the memorial, served at / — page-specific styles inline, content sections, custom-element instances
login.html  password gate — redirects to / on unlock
styles/shared.css  cross-section primitives (.block, .section-head, .gal-grid, .vid-grid, .tl-rail, .notify-form)
scripts/           two custom elements, no framework, no module system (loaded as plain <script>)
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

Persistent message wall (text + photo/video) with a focus view. Storage is **`localStorage`**, keyed `lantern-wall::<id-or-pathname>` — entirely separate from the image-slot sidecar mechanism. Ships with seed messages embedded in the source.

## When editing

- Adding a new image slot: give it a fresh `id`, size it via the parent CSS (slot inherits container width/height), and remember it will only be fillable inside the omelette runtime.
- Adding a new section: follow the `<section class="block …">` + `.section-head` (`.section-num` + `.section-meta`) pattern already used in `index.html`; theme tokens come from the page-level `:root` block at the top of the file.
- Page-specific styling lives inline in `index.html`; only put rules in `styles/shared.css` if they are reusable primitives.
