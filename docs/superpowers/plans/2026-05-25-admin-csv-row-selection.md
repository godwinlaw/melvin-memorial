# Admin CSV Row Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-row checkboxes and a master select-all to the RSVPs table in `admin.html`, and update the CSV export to filter to the selected rows when any are selected (preserving export-all behavior when none are selected).

**Architecture:** UI-only change in `admin.html`. New module-level `Set<number>` named `selectedRsvpIds` lives inside the existing IIFE. New helpers `updateMasterCheckbox()` and `updateExportButtonLabel()` keep the header checkbox tri-state and button label in sync. Row checkbox events use the same delegated-listener pattern already used for edit/remove buttons (`onRsvpRowAction`). Export filtering is a one-line filter inside `downloadRsvpCsv` — `maxGuests` is computed from the filtered subset so the CSV doesn't carry empty guest columns.

**Tech Stack:** Vanilla HTML/CSS/JS, no build step, no test framework. The project has no automated test harness for `admin.html`, so verification is manual via `wrangler dev`.

**Spec:** `docs/superpowers/specs/2026-05-25-admin-csv-row-selection-design.md`

---

## File Structure

Single file modified:

- `admin.html` — adds checkbox column to RSVPs table, master checkbox in header, dynamic export button label, selection state, filtered export. All changes localized inside the existing `<style>` block, the existing `renderRsvps` function, and the existing IIFE.

No new files. No new modules. No schema or Worker changes.

---

## Manual verification (used by every task)

Local dev launch (run once at the start of testing):

```bash
wrangler dev
```

This serves `admin.html` at `http://127.0.0.1:8787/admin.html`. Sign in with the `ADMIN_TOKEN` from `.dev.vars` (or the value in your local `wrangler dev` env). The RSVPs tab needs at least 3 RSVPs to verify selection meaningfully — if local D1 has none, insert seed rows:

```bash
wrangler d1 execute melvin-rsvps --local --command "INSERT INTO rsvps (name, email, party_size, guest_names) VALUES ('Test One', 't1@example.com', 1, '[]'), ('Test Two', 't2@example.com', 2, '[\"Plus One\"]'), ('Test Three', 't3@example.com', 1, '[]');"
```

After each task that changes runtime behavior, hard-refresh (`Cmd+Shift+R`) the admin page and re-validate.

---

### Task 1: Add CSS for the checkbox column

**Files:**

- Modify: `admin.html` (CSS block, near the `td.row-actions` rule around line 110)

- [ ] **Step 1: Add the new CSS rules**

Find the existing rule:

```css
  td.row-actions { white-space: nowrap; text-align: right; }
```

Add these rules immediately after it:

```css
  th.select-col, td.select-col {
    width: 36px; padding-left: 0; padding-right: 0; text-align: center;
  }
  th.select-col input[type="checkbox"],
  td.select-col input[type="checkbox"] {
    accent-color: var(--brass);
    width: 16px; height: 16px; margin: 0; cursor: pointer;
    vertical-align: middle;
  }
```

- [ ] **Step 2: Verify the page still loads**

Run: `wrangler dev` (if not already running) and load `http://127.0.0.1:8787/admin.html` in a browser. Sign in.

Expected: Admin panel renders normally. RSVPs table looks unchanged (no new column yet — CSS classes aren't applied to anything yet).

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Add CSS for RSVP row-selection checkbox column"
```

---

### Task 2: Add `selectedRsvpIds` state

**Files:**

- Modify: `admin.html` (the IIFE, near the existing state declarations around line 286)

- [ ] **Step 1: Add the state declaration**

Find this block in the IIFE:

```js
  let token = "";
  let activeTab = "rsvps";
  let rsvpData = null;
  let lanternData = null;
  let editingId = null;
```

Replace it with:

```js
  let token = "";
  let activeTab = "rsvps";
  let rsvpData = null;
  let lanternData = null;
  let editingId = null;
  let selectedRsvpIds = new Set();
```

- [ ] **Step 2: Verify the page still loads**

Hard-refresh `http://127.0.0.1:8787/admin.html`. Open browser devtools console.

Expected: No JS errors. Admin panel works exactly as before.

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Add selectedRsvpIds state for RSVP row selection"
```

---

### Task 3: Add the checkbox column to the RSVPs table header and rows

**Files:**

- Modify: `admin.html` (the `renderRsvps` function around lines 337–388)

- [ ] **Step 1: Update the header row to include the master checkbox cell**

Find this block in `renderRsvps`:

```js
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["When", "Name", "Email", "Guests", "Party", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
```

Replace with:

```js
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    const thSelect = document.createElement("th");
    thSelect.className = "select-col";
    const masterCb = document.createElement("input");
    masterCb.type = "checkbox";
    masterCb.id = "rsvp-select-all";
    masterCb.setAttribute("aria-label", "Select all RSVPs");
    thSelect.appendChild(masterCb);
    headRow.appendChild(thSelect);

    for (const label of ["When", "Name", "Email", "Guests", "Party", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
```

- [ ] **Step 2: Update the row loop to include the row checkbox cell**

Find this block in `renderRsvps`:

```js
    for (const r of rsvps) {
      const tr = document.createElement("tr");
      tr.dataset.id = String(r.id);
      tr.appendChild(td("when", formatWhen(r.created_at)));
      tr.appendChild(td("", r.name));
      tr.appendChild(td("email", r.email));
      tr.appendChild(td("guests", (r.guest_names || []).join(", ")));
      tr.appendChild(td("size", String(r.party_size)));
```

Replace with:

```js
    for (const r of rsvps) {
      const tr = document.createElement("tr");
      tr.dataset.id = String(r.id);

      const tdSelect = document.createElement("td");
      tdSelect.className = "select-col";
      const rowCb = document.createElement("input");
      rowCb.type = "checkbox";
      rowCb.dataset.action = "select";
      rowCb.setAttribute("aria-label", "Select RSVP from " + r.name);
      rowCb.checked = selectedRsvpIds.has(Number(r.id));
      tdSelect.appendChild(rowCb);
      tr.appendChild(tdSelect);

      tr.appendChild(td("when", formatWhen(r.created_at)));
      tr.appendChild(td("", r.name));
      tr.appendChild(td("email", r.email));
      tr.appendChild(td("guests", (r.guest_names || []).join(", ")));
      tr.appendChild(td("size", String(r.party_size)));
```

- [ ] **Step 3: Verify the new column renders**

Hard-refresh `http://127.0.0.1:8787/admin.html`. Sign in.

Expected:
- A new narrow leftmost column appears in the RSVPs table.
- Header has a single empty checkbox; each row has its own empty checkbox.
- Clicking checkboxes toggles their visual state but does nothing else yet (no wiring in this task).
- Existing edit/remove buttons still work.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "Render checkbox column in RSVPs admin table"
```

---

### Task 4: Add `updateMasterCheckbox` and `updateExportButtonLabel` helpers

**Files:**

- Modify: `admin.html` (the IIFE, near `renderRsvps` around line 337)

- [ ] **Step 1: Add the two helpers above `renderRsvps`**

Find:

```js
  function renderRsvps() {
```

Insert directly before it:

```js
  function updateMasterCheckbox() {
    const master = document.getElementById("rsvp-select-all");
    if (!master) return;
    const total = Array.isArray(rsvpData?.rsvps) ? rsvpData.rsvps.length : 0;
    const sel = selectedRsvpIds.size;
    if (sel === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else if (sel === total) {
      master.checked = true;
      master.indeterminate = false;
    } else {
      master.checked = false;
      master.indeterminate = true;
    }
  }

  function updateExportButtonLabel() {
    const sel = selectedRsvpIds.size;
    exportBtn.textContent = sel > 0 ? "Export " + sel + " selected" : "Export CSV";
  }

```

- [ ] **Step 2: Call both helpers at the end of `renderRsvps`**

Find the end of `renderRsvps`:

```js
    table.appendChild(tbody);
    tbody.addEventListener("click", onRsvpRowAction);
    wraps.rsvps.appendChild(table);
  }
```

Replace with:

```js
    table.appendChild(tbody);
    tbody.addEventListener("click", onRsvpRowAction);
    wraps.rsvps.appendChild(table);
    updateMasterCheckbox();
    updateExportButtonLabel();
  }
```

- [ ] **Step 3: Verify no regressions**

Hard-refresh `http://127.0.0.1:8787/admin.html`. Sign in.

Expected:
- RSVPs table renders normally.
- The Export button still reads "Export CSV" (because `selectedRsvpIds` is empty).
- No JS errors in devtools console.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "Add master checkbox and export label sync helpers"
```

---

### Task 5: Wire row checkbox toggles into the selection set

**Files:**

- Modify: `admin.html` (the `onRsvpRowAction` function around lines 405–414)

- [ ] **Step 1: Extend `onRsvpRowAction` to handle the `select` action**

Find:

```js
  function onRsvpRowAction(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr[data-id]");
    if (!tr) return;
    const id = Number(tr.dataset.id);
    if (!Number.isFinite(id)) return;
    if (btn.dataset.action === "delete") deleteRsvp(id);
    else if (btn.dataset.action === "edit") openEditRsvp(id);
  }
```

Replace with:

```js
  function onRsvpRowAction(e) {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.dataset.action === "select") {
      const tr = target.closest("tr[data-id]");
      if (!tr) return;
      const id = Number(tr.dataset.id);
      if (!Number.isFinite(id)) return;
      if (target.checked) selectedRsvpIds.add(id);
      else selectedRsvpIds.delete(id);
      updateMasterCheckbox();
      updateExportButtonLabel();
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr[data-id]");
    if (!tr) return;
    const id = Number(tr.dataset.id);
    if (!Number.isFinite(id)) return;
    if (btn.dataset.action === "delete") deleteRsvp(id);
    else if (btn.dataset.action === "edit") openEditRsvp(id);
  }
```

Note: the existing listener is attached with `tbody.addEventListener("click", onRsvpRowAction)` — checkbox `click` events fire after the `checked` value flips, so reading `target.checked` here gives the post-toggle state. This avoids needing a separate `change` listener.

- [ ] **Step 2: Verify row checkbox behavior**

Hard-refresh. Sign in.

- Click a row checkbox → it stays checked, Export button label updates to "Export 1 selected", master checkbox shows indeterminate.
- Click another → label reads "Export 2 selected".
- Uncheck one → label reads "Export 1 selected".
- Uncheck the last → label reverts to "Export CSV", master shows unchecked.
- Select every row → master shows fully checked.

Edit and Remove buttons still work as before.

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Wire row checkboxes into RSVP selection set"
```

---

### Task 6: Wire the master checkbox to select-all / clear

**Files:**

- Modify: `admin.html` (the `renderRsvps` function — attach the listener after creating `masterCb`)

- [ ] **Step 1: Attach a `change` listener to the master checkbox**

Find this block in `renderRsvps`:

```js
    const thSelect = document.createElement("th");
    thSelect.className = "select-col";
    const masterCb = document.createElement("input");
    masterCb.type = "checkbox";
    masterCb.id = "rsvp-select-all";
    masterCb.setAttribute("aria-label", "Select all RSVPs");
    thSelect.appendChild(masterCb);
    headRow.appendChild(thSelect);
```

Replace with:

```js
    const thSelect = document.createElement("th");
    thSelect.className = "select-col";
    const masterCb = document.createElement("input");
    masterCb.type = "checkbox";
    masterCb.id = "rsvp-select-all";
    masterCb.setAttribute("aria-label", "Select all RSVPs");
    masterCb.addEventListener("change", onMasterCheckboxChange);
    thSelect.appendChild(masterCb);
    headRow.appendChild(thSelect);
```

- [ ] **Step 2: Add the `onMasterCheckboxChange` handler**

Add this function directly before `updateMasterCheckbox` (which you added in Task 4):

```js
  function onMasterCheckboxChange(e) {
    const rsvps = Array.isArray(rsvpData?.rsvps) ? rsvpData.rsvps : [];
    if (e.target.checked) {
      selectedRsvpIds = new Set(rsvps.map((r) => Number(r.id)));
    } else {
      selectedRsvpIds.clear();
    }
    const rowCheckboxes = wraps.rsvps.querySelectorAll(
      'input[type="checkbox"][data-action="select"]'
    );
    rowCheckboxes.forEach((cb) => {
      const tr = cb.closest("tr[data-id]");
      if (!tr) return;
      const id = Number(tr.dataset.id);
      cb.checked = selectedRsvpIds.has(id);
    });
    updateMasterCheckbox();
    updateExportButtonLabel();
  }
```

Note: When the master is currently `indeterminate`, clicking it produces a `change` event with `e.target.checked === false` in browsers — i.e. indeterminate-then-click goes to unchecked. This matches the spec ("If currently checked or indeterminate → uncheck all").

- [ ] **Step 3: Verify master checkbox behavior**

Hard-refresh. Sign in.

- Click master (currently unchecked) → all row checkboxes become checked, label reads "Export N selected".
- Click master again → all uncheck, label reverts to "Export CSV".
- Check all manually, then uncheck one → master goes from checked to indeterminate.
- Click indeterminate master → all uncheck.
- Master checkbox is unchecked → click it → all rows check.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "Wire master checkbox to bulk select/clear RSVPs"
```

---

### Task 7: Filter the CSV export by selection

**Files:**

- Modify: `admin.html` (`downloadRsvpCsv` around lines 614–642)

- [ ] **Step 1: Update `downloadRsvpCsv` to filter by selection**

Find:

```js
  function downloadRsvpCsv() {
    const rsvps = Array.isArray(rsvpData?.rsvps) ? rsvpData.rsvps : [];
    const maxGuests = rsvps.reduce(
      (m, r) => Math.max(m, (r.guest_names || []).length),
      0
    );
    const headers = ["created_at", "name", "email", "party_size"];
    for (let i = 1; i <= maxGuests; i++) headers.push("guest_" + i);
    const rows = [headers];
    for (const r of rsvps) {
      const row = [r.created_at, r.name, r.email, String(r.party_size)];
      for (let i = 0; i < maxGuests; i++) row.push((r.guest_names || [])[i] ?? "");
      rows.push(row);
    }
```

Replace with:

```js
  function downloadRsvpCsv() {
    const all = Array.isArray(rsvpData?.rsvps) ? rsvpData.rsvps : [];
    const subset = selectedRsvpIds.size
      ? all.filter((r) => selectedRsvpIds.has(Number(r.id)))
      : all;
    const maxGuests = subset.reduce(
      (m, r) => Math.max(m, (r.guest_names || []).length),
      0
    );
    const headers = ["created_at", "name", "email", "party_size"];
    for (let i = 1; i <= maxGuests; i++) headers.push("guest_" + i);
    const rows = [headers];
    for (const r of subset) {
      const row = [r.created_at, r.name, r.email, String(r.party_size)];
      for (let i = 0; i < maxGuests; i++) row.push((r.guest_names || [])[i] ?? "");
      rows.push(row);
    }
```

(The remainder of the function — building the Blob and triggering the download — is unchanged.)

- [ ] **Step 2: Verify export filtering**

Hard-refresh. Sign in.

- With nothing selected: click Export CSV → file contains all RSVPs (same as before).
- Select 2 rows where neither has guests: click "Export 2 selected" → file contains only those 2 rows; headers are `created_at,name,email,party_size` (no `guest_1` etc.).
- Select 1 row that has 2 guests + 1 row with 0 guests: file headers include `guest_1, guest_2`; the no-guest row has empty values in those columns; the larger party fills them.
- Select all rows → file matches the unfiltered export.

Open each downloaded CSV in a text editor (or `cat path/to/rsvps-*.csv`) to confirm.

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Filter RSVP CSV export to selected rows when non-empty"
```

---

### Task 8: Drop deleted ids from selection

**Files:**

- Modify: `admin.html` (`deleteRsvp` around lines 416–442)

- [ ] **Step 1: Remove the deleted id from `selectedRsvpIds`**

Find:

```js
    rsvpData.rsvps.splice(idx, 1);
    recomputeRsvpTotals();
    renderRsvps();
    if (activeTab === "rsvps") updateStats();
  }
```

Replace with:

```js
    rsvpData.rsvps.splice(idx, 1);
    selectedRsvpIds.delete(id);
    recomputeRsvpTotals();
    renderRsvps();
    if (activeTab === "rsvps") updateStats();
  }
```

- [ ] **Step 2: Verify deletion drops from selection**

Hard-refresh. Sign in.

- Select 3 rows. Label reads "Export 3 selected".
- Click Remove on one of the selected rows; confirm.
- Label updates to "Export 2 selected"; master checkbox reflects 2-of-(N-1) selection.
- Select all rows; click Remove on one. Master should now show indeterminate (selection size = total − 1, total = remaining).

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "Drop deleted RSVP id from selection set"
```

---

### Task 9: Clear selection on tab switch and sign out

**Files:**

- Modify: `admin.html` (`activateTab` around lines 664–681 and the sign-out listener around lines 712–720)

- [ ] **Step 1: Clear selection when switching away from RSVPs**

Find:

```js
  function activateTab(tab) {
    activeTab = tab;
    tabBtns.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    Object.entries(views).forEach(([k, el]) => {
      el.classList.toggle("active", k === tab);
    });
    updateStats();
```

Replace with:

```js
  function activateTab(tab) {
    if (activeTab !== tab && tab !== "rsvps" && selectedRsvpIds.size) {
      selectedRsvpIds.clear();
      if (rsvpData) renderRsvps();
    }
    activeTab = tab;
    tabBtns.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    Object.entries(views).forEach(([k, el]) => {
      el.classList.toggle("active", k === tab);
    });
    updateStats();
```

The clear runs *before* `activeTab` flips, so we know the user is leaving the RSVPs tab. `renderRsvps()` resets the row checkboxes (it reads from the now-empty Set) and the helpers reset the master checkbox + button label.

- [ ] **Step 2: Clear selection on sign out**

Find:

```js
  signOutBtn.addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    token = "";
    rsvpData = null;
    lanternData = null;
    editingId = null;
    if (editDlg.open) editDlg.close();
    showGate();
  });
```

Replace with:

```js
  signOutBtn.addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    token = "";
    rsvpData = null;
    lanternData = null;
    editingId = null;
    selectedRsvpIds.clear();
    if (editDlg.open) editDlg.close();
    showGate();
  });
```

- [ ] **Step 3: Verify lifecycle**

Hard-refresh. Sign in.

- On RSVPs tab, select 2 rows; label reads "Export 2 selected".
- Switch to Lanterns tab. Switch back to RSVPs.
- Expected: rows are unchecked; master is unchecked; label reads "Export CSV".
- Select rows again; click Sign out. Sign back in.
- Expected: no rows selected; label reads "Export CSV".

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "Clear RSVP selection on tab switch and sign out"
```

---

### Task 10: Final end-to-end manual verification

**Files:** none modified.

- [ ] **Step 1: Walk through every spec scenario in one session**

Hard-refresh. Sign in. With at least 3 seeded RSVPs (ideally one with 0 guests, one with 2+ guests, and one with 1 guest):

1. No selection → click Export → file has all rows. ✓
2. Select 2 rows → button reads "Export 2 selected" → click → file has only those 2 rows; `maxGuests` matches. ✓
3. Click master → all check; button reads "Export N selected"; master fully checked. ✓
4. Uncheck one row → master shows indeterminate. ✓
5. Click indeterminate master → all uncheck; label reverts to "Export CSV". ✓
6. Select 3 rows; click Edit on one; change name; save → row stays checked; label still "Export 3 selected"; CSV reflects new name. ✓
7. Select 3 rows; click Remove on one; confirm → label updates to "Export 2 selected". ✓
8. Switch to Lanterns and back → selection cleared. ✓
9. Sign out, sign in → no selection. ✓
10. Empty state (no RSVPs) → empty message renders; no JS errors. ✓

If any of these fail, fix the regression in the relevant earlier task and re-run from step 1.

- [ ] **Step 2: Confirm no console errors during the walkthrough**

Open devtools console during the entire walkthrough above. Expected: zero errors, zero warnings introduced by these changes.

- [ ] **Step 3: No commit needed unless fixes were made**

If a fix was made, commit it scoped to the original task's intent. Otherwise this task closes the plan with no commit.
