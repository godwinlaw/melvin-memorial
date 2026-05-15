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
      this._pendingName = "";
      this._pendingEmail = "";
      this._root = this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      this._render();
    }

    reset() {
      this._state = "editing";
      this._guests = [];
      this._error = "";
      this._turnstileToken = "";
      this._pendingName = "";
      this._pendingEmail = "";
      this._render();
      this.dispatchEvent(new CustomEvent("rsvp-reset", { bubbles: true, composed: true }));
    }

    // Turnstile is mounted in light DOM by the page (its widget script can't
    // safely run inside shadow DOM). The page calls these to relay the token.
    setTurnstileToken(token) {
      this._turnstileToken = String(token || "");
    }

    clearTurnstileToken() {
      this._turnstileToken = "";
    }

    get isDone() {
      return this._state === "done";
    }

    get _endpoint() {
      return this.getAttribute("endpoint") || "/api/rsvp";
    }

    _render() {
      this._root.innerHTML = `<style>${css}</style><div class="wrap">${this._html()}</div>`;
      this._wireEvents();
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

          <div class="guests">
            <span class="label">Guests you'll bring</span>
            ${guestRows}
            <button type="button" class="add" data-add
                    ${this._guests.length >= GUESTS_MAX || isSubmitting ? "disabled" : ""}>
              + Add guest
            </button>
          </div>

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
          this._snapshotInputs();
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
          this._snapshotInputs();
          this._guests.splice(idx, 1);
          this._render();
        });
      });

      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          this._snapshotInputs();
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

    _snapshotInputs() {
      this._snapshotGuests();
      const nameEl = this._root.querySelector('input[name="name"]');
      const emailEl = this._root.querySelector('input[name="email"]');
      if (nameEl) this._pendingName = nameEl.value;
      if (emailEl) this._pendingEmail = emailEl.value;
    }

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
