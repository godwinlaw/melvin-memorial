// Turnstile site key. Public — safe to commit. Replace the testing key with
// the real production site key once you've created a Turnstile site at
// https://dash.cloudflare.com/?to=/:account/turnstile and run
// `wrangler secret put TURNSTILE_SECRET_KEY` for the matching secret.
//
// "1x00000000000000000000AA" is Cloudflare's "always passes (visible)"
// testing key — fine for local dev and CI, NEVER for production.
window.RSVP_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
