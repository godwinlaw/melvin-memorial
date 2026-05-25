# Admin CSV Row Selection — Design

## Summary

Add the ability to select specific RSVP rows in the admin panel and export only those rows to CSV. When no rows are selected, the existing "export everything" behavior is preserved, so the change is purely additive — admins gain a way to narrow the export without losing the one-click "all RSVPs" path.

This is a UI-only change scoped to `admin.html`. No Worker, schema, or API changes.

## Motivation

`admin.html` currently exports every RSVP in `rsvpData.rsvps` as a single CSV. The admin sometimes wants a subset — e.g. only the latest few entries, or only specific parties for a side count — and has to either edit the file post-export or filter rows in a spreadsheet. Adding row selection to the existing table is the smallest change that solves this.

## Scope

In scope:

- Checkbox column on the **RSVPs** table.
- Master "select all" checkbox in the table header (tri-state).
- Export button label that reflects current selection count.
- Export logic that filters by selection when non-empty.

Out of scope:

- Lantern tab selection / export (the Lanterns tab has no CSV export today).
- Shift-click / cmd-click range selection.
- Persisting selection across page reloads or sign-out cycles.
- Server-side filtering — selection is purely client-side over data already loaded.
- New export formats (JSON, XLSX).

## UI

### Layout

The RSVPs table gains a new first column for selection:

```
┌─────┬────────┬──────┬─────────┬────────┬────────┬─────────┐
│ ☐   │ WHEN   │ NAME │ EMAIL   │ GUESTS │ PARTY  │         │
├─────┼────────┼──────┼─────────┼────────┼────────┼─────────┤
│ ☑   │ 5/24…  │ Joe  │ j@x.co  │ —      │ 1      │ Edit Rm │
│ ☐   │ 5/23…  │ Ana  │ a@y.co  │ Sam    │ 2      │ Edit Rm │
│ ☑   │ 5/22…  │ Pat  │ p@z.co  │ —      │ 1      │ Edit Rm │
└─────┴────────┴──────┴─────────┴────────┴────────┴─────────┘

[ Export 2 selected ]   [ Sign out ]
```

The checkbox column is narrow (fixed ~36px) so it doesn't crowd the data columns.

### Header checkbox (master)

Three visual states:

| Selection state         | Master checkbox    |
| ----------------------- | ------------------ |
| 0 rows checked          | unchecked          |
| 1..N-1 rows checked     | indeterminate      |
| All N rows checked      | checked            |

Clicking the master toggles between "all" and "none":

- If currently checked or indeterminate → uncheck all.
- If currently unchecked → check all.

### Export button

The button (`#export`) is shown whenever the RSVPs tab is active and `rsvpData` is loaded — same as today. Only the **label** changes based on selection size:

| Selection size | Label                  |
| -------------- | ---------------------- |
| 0              | `Export CSV`           |
| 1              | `Export 1 selected`    |
| N (N ≥ 2)      | `Export N selected`    |

When 0 rows are selected, clicking exports everything (current behavior). When ≥1 are selected, only the selected subset is exported.

### Styling notes

- Checkboxes use `accent-color: var(--brass)` so they pick up the panel theme without bespoke styling.
- The new `<th>` and `<td>` cells inherit existing `padding`/`border-bottom` from the table rules; no extra CSS for borders is needed.
- The checkbox column header has no text label — only the master checkbox.

## State management

A single new module-level variable inside the existing IIFE:

```js
let selectedRsvpIds = new Set();   // Set<number>
```

### Lifecycle rules

| Event                                | Effect on `selectedRsvpIds`                                  |
| ------------------------------------ | ------------------------------------------------------------ |
| Initial load / token validation      | Empty Set                                                    |
| Row checkbox toggled on              | `add(id)`                                                    |
| Row checkbox toggled off             | `delete(id)`                                                 |
| Master checkbox: check all           | Replace Set with all current row ids                         |
| Master checkbox: uncheck all         | `clear()`                                                    |
| Edit RSVP succeeds                   | No change (id unchanged → still selected if it was)          |
| Delete RSVP succeeds                 | `delete(id)` (id is gone, can't be in selection)             |
| Tab switched away from RSVPs         | `clear()`                                                    |
| Tab switched back to RSVPs           | Already cleared; renders unchecked                           |
| Sign out                             | `clear()` (alongside other state resets)                     |
| Full reload of `rsvpData` (token re-auth) | `clear()`                                              |

The Set holds numeric ids (matching `r.id`), consistent with the rest of the file's id handling (`Number(r.id)`).

### Re-render behavior

`renderRsvps()` rebuilds the table from scratch on every change. After rebuilding rows, it re-applies checked state by reading from `selectedRsvpIds`. The master checkbox state is derived from `selectedRsvpIds.size` vs `rsvpData.rsvps.length` and set after rows are rendered.

A small helper, `updateMasterCheckbox()`, encapsulates the tri-state logic and is called both after `renderRsvps()` and after any row checkbox toggle.

A small helper, `updateExportButtonLabel()`, sets the button text from `selectedRsvpIds.size`. Called from the same places as `updateMasterCheckbox()`.

## Export logic

`downloadRsvpCsv()` is updated to filter by selection when non-empty:

```js
function downloadRsvpCsv() {
  const all = Array.isArray(rsvpData?.rsvps) ? rsvpData.rsvps : [];
  const subset = selectedRsvpIds.size
    ? all.filter((r) => selectedRsvpIds.has(Number(r.id)))
    : all;
  // ... rest unchanged, but uses `subset` instead of `rsvps` ...
}
```

`maxGuests` is computed from `subset`, not `all` — so a CSV containing only single-person RSVPs has only `created_at, name, email, party_size` columns, not empty `guest_1..guest_N` columns from larger parties that weren't selected.

Filename is unchanged (`rsvps-YYYY-MM-DD.csv`). The content reflects what was selected; encoding "selected" into the filename adds clutter without value.

## Event wiring

New event listeners (added inside the existing IIFE):

1. **Row checkboxes** — delegated on `tbody` (same pattern as the existing edit/delete delegation in `onRsvpRowAction`). On `change`:
   - Read the row's id from `tr.dataset.id`.
   - Add or remove from `selectedRsvpIds`.
   - Call `updateMasterCheckbox()` and `updateExportButtonLabel()`.
2. **Master checkbox** — direct listener on the header checkbox element:
   - On `change`, branch on `event.target.checked`:
     - `true` → fill `selectedRsvpIds` with every current row id.
     - `false` → `selectedRsvpIds.clear()`.
   - Re-apply checked state to all row checkboxes (without rebuilding the whole table).
   - Update the export button label.

The existing `exportBtn` click listener is unchanged — it still calls `downloadRsvpCsv()`. The new filtering happens inside that function.

## Edge cases

- **Empty selection + click Export** → exports all rows (preserved current behavior).
- **All rows selected, then delete one** → deleted id is removed from the Set; the master checkbox becomes indeterminate (since `size < rsvps.length`).
- **Edit a selected row** → row stays selected (id unchanged); CSV export reflects updated name/email/guests.
- **No rsvps at all** → table doesn't render; the empty-state message shows; no master checkbox to worry about.
- **Select rows on RSVPs tab, switch to Lanterns, switch back** → selection is cleared. Switching tabs is treated as starting fresh; the alternative (preserving across tab switches) adds state for negligible benefit.

## Accessibility

- Each row checkbox has `aria-label="Select RSVP from <name>"` for screen-reader context (the visible name is in the next cell, but the label keeps the checkbox understandable in isolation).
- The master checkbox has `aria-label="Select all RSVPs"`.
- Tri-state is implemented via the standard `checkbox.indeterminate` DOM property (not an ARIA attribute) — this is the natively supported approach and is announced by screen readers.
- Tab order: master checkbox first, then column headers, then row checkboxes interleaved with row content (natural DOM order).

## Testing

Manual verification (the project has no automated test suite for `admin.html`):

1. Load admin panel with several RSVPs.
2. Click Export with nothing selected → CSV contains all rows. ✓
3. Select 2 specific rows → button reads "Export 2 selected" → click → CSV contains only those 2 rows, with `maxGuests` matching that subset.
4. Click master checkbox → all rows check, button reads "Export N selected", master shows checked.
5. Uncheck one row → master shows indeterminate.
6. Click master again → all uncheck, button reverts to "Export CSV".
7. Select 3 rows, edit one → row stays checked, label still "Export 3 selected".
8. Select 3 rows, delete one → label updates to "Export 2 selected", master shows indeterminate.
9. Select rows, switch to Lanterns tab, switch back → all rows uncheck, button reverts to "Export CSV".
10. Sign out, sign back in → no rows selected.

## Out-of-scope deferrals

If future need arises, the following extensions are straightforward:

- **Shift-click range selection**: track a `lastClickedRsvpId`; on shift-click compute the slice of ids between the two and bulk-add to the Set.
- **Lantern selection/export**: the same pattern (Set of selected ids, master checkbox, export filter) lifts cleanly to the Lanterns table; the missing piece today is the export function itself.
- **Persist selection across reload**: store `Array.from(selectedRsvpIds)` in `sessionStorage` keyed by the existing `TOKEN_KEY` namespace.

None of these are needed now and adding them speculatively would just add code paths to maintain.
