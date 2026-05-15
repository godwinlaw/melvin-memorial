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
