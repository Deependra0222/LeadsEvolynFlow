# Lead Compartments and Multi-Select Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted admin-managed lead compartments, compartment-aware import/export/move/delete workflows, a separate City/Area field, and composable checkbox filters without weakening the existing viewer/admin permissions.

**Architecture:** Keep one Blob per lead and add small compartment metadata Blobs referenced through `compartmentId`. Extend the existing repository and handler with idempotent migration and conflict-safe bulk operations, then keep all display filtering client-side over the loaded normalized records.

**Tech Stack:** Browser-native HTML/CSS/ES modules, Node.js 20/22, Node test runner, Netlify Functions, Netlify Blobs 11.1.0.

**Spec:** `docs/superpowers/specs/2026-09-25-lead-compartments-filters-design.md`

## Global Constraints

- Every lead belongs to exactly one current compartment; no compartment history is stored.
- Compartment names are trimmed, non-empty, unique case-insensitively, and at most 80 characters.
- City/Area is trimmed and at most 120 characters; failed legacy detection becomes `Unknown`.
- Existing leads migrate to one renamable `Existing Leads` compartment without changing IDs, serials, workflow fields, or timestamps.
- One import request targets exactly one existing compartment; uploaded JSON cannot route individual rows.
- Viewers retain permission to update only status, follow-up date, and remarks.
- Compartment creation, rename, export, deletion, lead movement, and City/Area edits remain admin-only.
- Deleting a compartment permanently deletes contained leads only after exact-name confirmation; downloading first is optional.
- Use the existing dependency set and Netlify free-tier architecture; add no database or frontend framework.

## Review Focus

- A legacy address without a reliable city segment migrates to `Unknown` while every other lead field remains byte-for-byte equivalent.
- A retried confirmed import cannot change its destination compartment or duplicate previously stored rows.
- Concurrent creates or renames using names that differ only by case or surrounding spaces produce one success and one conflict.
- A viewer workflow save racing an admin bulk move preserves both the workflow change and the new compartment.
- A partially failed compartment deletion is retryable and rejects new imports or moves into the deleting compartment.

## File Structure

- Create `netlify/lib/compartment-model.mjs`: compartment identifier/name normalization and stored-record validation.
- Create `netlify/lib/compartment-repository.mjs`: compartment metadata, unique-name claims, deletion markers, and default-compartment creation.
- Modify `netlify/lib/lead-model.mjs`: City import alias, City/core validation, and required stored `city`/`compartmentId` fields.
- Modify `netlify/lib/lead-repository.mjs`: version-3 migration, compartment-aware imports, conflict-safe bulk movement, compartment export, and compartment deletion helpers.
- Modify `netlify/lib/lead-data-core.mjs`: public compartment reads and admin routes.
- Modify `netlify/functions/lead-data.mjs`: construct and inject the compartment repository.
- Modify `client-api.mjs`: compartment CRUD/export/move and destination-aware import calls.
- Modify `client-import.mjs`: keep the selected compartment attached to the immutable reviewed import payload.
- Modify `client-state.mjs`: filter facets, checkbox semantics, counts, and Shift-range selection.
- Modify `index.html` and `app.mjs`: compartment navigation, filter panel, management dialogs, bulk actions, City editing, and import destination selection.
- Modify focused files under `test/` for every contract and workflow.

---

### Task 1: Compartment and City Contracts

**Files:**
- Create: `netlify/lib/compartment-model.mjs`
- Modify: `netlify/lib/lead-model.mjs`
- Test: `test/compartment-model.test.mjs`
- Test: `test/lead-model.test.mjs`

**Interfaces:**
- Produces: `normalizeCompartmentName(value)`, `validateCompartmentIdentifier(value)`, `normalizeStoredCompartment(value)`, and `deriveCity(address)`.
- Extends: `validateImportRecords()` output with `city`; `validateCorePatch()` requires `name`, `mobile`, `address`, `city`, and `category`; `normalizeStoredLead()` requires a valid `compartmentId` and City/Area.

- [ ] **Step 1: Write failing model tests**

```js
test("compartment names normalize and compare case-insensitively", () => {
  assert.deepEqual(normalizeCompartmentName("  Jaipur Leads  "), {
    ok: true, name: "Jaipur Leads", key: "jaipur leads"
  });
  assert.equal(normalizeCompartmentName(" ").ok, false);
  assert.equal(normalizeCompartmentName("x".repeat(81)).ok, false);
});

test("legacy city derivation is deterministic and safe", () => {
  assert.equal(deriveCity("60, Dashrath Path, Jaipur, RJ"), "Jaipur");
  assert.equal(deriveCity("Jaipur, Rajasthan 302021"), "Jaipur");
  assert.equal(deriveCity("Private Address"), "Unknown");
});

test("imports accept City while stored leads require city and compartment", () => {
  const imported = validateImportRecords({ name: "A", mobile: "1", address: "Jaipur, RJ", City: "Jaipur" });
  assert.equal(imported.valid[0].city, "Jaipur");
  assert.equal(normalizeStoredLead({ ...completeLead, city: "", compartmentId: "existing-leads" }), null);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test test/compartment-model.test.mjs test/lead-model.test.mjs`

Expected: failure because the compartment module, City alias, and required stored fields do not exist.

- [ ] **Step 3: Implement the contracts**

```js
export function normalizeCompartmentName(value) {
  if (typeof value !== "string") return { ok: false, error: "Compartment name must be text." };
  const name = value.trim();
  if (!name || name.length > 80) return { ok: false, error: "Compartment name must be 1 to 80 characters." };
  return { ok: true, name, key: name.toLocaleLowerCase("en-IN") };
}

export function deriveCity(address) {
  const parts = String(address || "").split(",").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return "Unknown";
  const state = /^(?:RJ|UP|MP|DL|HR|PB|MH|GJ|Rajasthan|Uttar Pradesh|Madhya Pradesh|Delhi|Haryana|Punjab|Maharashtra|Gujarat)(?:\s+\d{6})?$/i;
  if (state.test(parts.at(-1))) parts.pop();
  return parts.at(-1)?.slice(0, 120) || "Unknown";
}
```

Add `city`/`City` import aliases, the 120-character City limit, `compartmentId` validation, and complete stored normalization.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/compartment-model.test.mjs test/lead-model.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: existing fixtures that construct stored leads fail until updated with `city` and `compartmentId`; update only fixture defaults, then rerun to zero failures.

- [ ] **Step 5: Commit**

```bash
git add netlify/lib/compartment-model.mjs netlify/lib/lead-model.mjs test/compartment-model.test.mjs test/lead-model.test.mjs test/*.test.mjs
git commit -m "feat: add compartment and city contracts"
```

### Task 2: Compartment Persistence and Version-3 Migration

**Files:**
- Create: `netlify/lib/compartment-repository.mjs`
- Modify: `netlify/lib/lead-repository.mjs`
- Modify: `netlify/functions/lead-data.mjs`
- Test: `test/compartment-repository.test.mjs`
- Test: `test/lead-repository.test.mjs`

**Interfaces:**
- Produces: `createCompartmentRepository({ store, now, makeId })` with `ensureExistingLeads()`, `list()`, `get(id)`, `create(name)`, `rename(id, name)`, `beginDelete(id)`, `finishDelete(id)`, and `isDeleting(id)`.
- Extends: `repository.ensureInitialized({ defaultCompartmentId })` and `repository.importMany(records, { requestId, sourceIndexes, compartmentId })`.

- [ ] **Step 1: Write failing persistence and migration tests**

```js
test("concurrent normalized-name claims allow only one compartment", async () => {
  const [left, right] = await Promise.allSettled([
    repo.create(" Jaipur Leads "), repo.create("jaipur leads")
  ]);
  assert.equal([left, right].filter(result => result.status === "fulfilled").length, 1);
});

test("version-3 migration preserves lead data and assigns defaults", async () => {
  await repo.ensureInitialized({ defaultCompartmentId: "existing-leads" });
  const migrated = await repo.get("seed-1");
  assert.equal(migrated.compartmentId, "existing-leads");
  assert.equal(migrated.city, "Agra");
  assert.equal(migrated.remarks, "legacy note");
});

test("ambiguous legacy address becomes Unknown without data loss", async () => {
  const before = legacyLead({ address: "Private Address" });
  blob.seed("lead/a", before);
  await repo.ensureInitialized({ defaultCompartmentId: "existing-leads" });
  const after = await repo.get("a");
  assert.equal(after.city, "Unknown");
  assert.deepEqual({ ...after, city: undefined, compartmentId: undefined, updatedAt: undefined }, {
    ...before, city: undefined, compartmentId: undefined, updatedAt: undefined
  });
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/compartment-repository.test.mjs test/lead-repository.test.mjs`

Expected: failure because compartment storage and version-3 migration are absent.

- [ ] **Step 3: Implement metadata, unique-name claims, and migration**

Use keys `compartment/<id>`, `compartment-name/<sha256-normalized-name>`, `compartment-delete/<id>`, and `system/initialized-v3`. Claim names with `onlyIfNew`; rename claims the new name before updating metadata and releases the old claim only after success.

Refactor initialization into ordered phases:

```js
async function ensureInitialized({ defaultCompartmentId }) {
  await ensureSeedRecords({ defaultCompartmentId });
  if (await readBlob("system/initialized-v3")) return;
  await migrateStoredLeads(defaultCompartmentId);
  await store.setJSON("system/initialized-v3", { version: 3, initializedAt: now() });
}
```

Migration reads each Blob with metadata and uses conditional writes so concurrent workflow changes cause a reread/retry rather than an overwrite.

- [ ] **Step 4: Make imports destination-aware and replay-safe**

Add `compartmentId` and derived City before record creation. Extend `matchesImport()` to include `city` and `compartmentId` so retrying a request with a different destination returns a conflict instead of silently relocating prior rows.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/compartment-repository.test.mjs test/lead-repository.test.mjs`

Run: `npm test`

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add netlify/lib/compartment-repository.mjs netlify/lib/lead-repository.mjs netlify/functions/lead-data.mjs test/compartment-repository.test.mjs test/lead-repository.test.mjs
git commit -m "feat: persist compartments and migrate leads"
```

### Task 3: Bulk Move, Compartment Export, and Deletion

**Files:**
- Modify: `netlify/lib/lead-repository.mjs`
- Modify: `netlify/lib/compartment-repository.mjs`
- Test: `test/lead-repository.test.mjs`
- Test: `test/compartment-repository.test.mjs`

**Interfaces:**
- Produces: `moveMany(ids, compartmentId) -> { moved, unchanged, errors }`, `exportCompartment(id) -> import rows`, and `removeByCompartment(id) -> { deleted, errors }`.
- Consumes: compartment deletion markers from Task 2.

- [ ] **Step 1: Write failing bulk-operation tests**

```js
test("bulk move preserves a concurrent viewer workflow update", async () => {
  blob.conflictOnce("lead/a", completeLead({ status: "Interested" }));
  const result = await repo.moveMany(["a"], "new-room");
  assert.equal(result.moved[0].compartmentId, "new-room");
  assert.equal(result.moved[0].status, "Interested");
});

test("compartment export is import-ready and omits internal identity", async () => {
  const rows = await repo.exportCompartment("room-a");
  assert.deepEqual(Object.keys(rows[0]), [
    "Institute/Business Name", "Mobile Number", "Area/Address", "City", "Category",
    "Call Status", "Next Follow-up", "Remarks"
  ]);
});

test("failed deletion resumes and a deleting compartment rejects writes", async () => {
  await compartments.beginDelete("room-a");
  await assert.rejects(() => compartments.assertWritable("room-a"), /deleting/i);
  const retry = await leads.removeByCompartment("room-a");
  assert.equal(retry.errors.length, 0);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/lead-repository.test.mjs test/compartment-repository.test.mjs`

- [ ] **Step 3: Implement conflict-safe move and bounded deletion**

Reuse `updateWithRetry()` for each moved ID and the existing concurrency helper for batch work. Return row-specific errors without rolling back successful records. A lead already in the destination is returned in `unchanged`.

Deletion order is fixed: write deletion marker, reject new destination writes, remove matching leads and serial reservations, remove compartment metadata/name claim, then remove the marker. Every step is safe to repeat.

- [ ] **Step 4: Implement import-ready export mapping**

Map stored records to the exact display aliases in the test, preserving workflow fields and omitting serial numbers, IDs, timestamps, and compartment metadata.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/lead-repository.test.mjs test/compartment-repository.test.mjs`

Run: `npm test`

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add netlify/lib/lead-repository.mjs netlify/lib/compartment-repository.mjs test/lead-repository.test.mjs test/compartment-repository.test.mjs
git commit -m "feat: move export and delete compartments"
```

### Task 4: HTTP and Browser API Contracts

**Files:**
- Modify: `netlify/lib/lead-data-core.mjs`
- Modify: `netlify/functions/lead-data.mjs`
- Modify: `client-api.mjs`
- Modify: `client-import.mjs`
- Test: `test/lead-data.test.mjs`
- Test: `test/client-api.test.mjs`
- Test: `test/client-import.test.mjs`

**Interfaces:**
- Public: `GET /api/compartments`.
- Admin: create/rename/export/delete compartment and `POST /api/admin/leads/move`.
- Import: `previewImport(records, compartmentId)` and `importLeads(records, requestId, compartmentId)`.

- [ ] **Step 1: Write failing route and client tests**

```js
test("public compartment list is readable but mutations require admin", async () => {
  assert.equal((await handler(request("/api/compartments"))).status, 200);
  assert.equal((await handler(request("/api/admin/compartments", "POST", { name: "A" }))).status, 401);
});

test("import requires one writable destination compartment", async () => {
  const response = await adminHandler(request("/api/leads/import", "POST", {
    preview: true, compartmentId: "missing", records: [{ name: "A", mobile: "1" }]
  }));
  assert.equal(response.status, 404);
});

test("review payload binds records to the accepted destination", () => {
  const attempt = review.begin([{ name: "A" }], "room-a");
  review.accept(attempt.token, { valid: [{ index: 0 }], errors: [] });
  assert.equal(review.confirmPayload().compartmentId, "room-a");
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/lead-data.test.mjs test/client-api.test.mjs test/client-import.test.mjs`

- [ ] **Step 3: Implement handler routes and validations**

Require admin plus same-origin checks for every mutation. Validate path IDs, exact delete confirmation, bounded `leadIds`, destination existence, and deletion state. Return structured per-lead move errors and attachment headers for compartment export.

- [ ] **Step 4: Implement client methods with existing timeout behavior**

```js
async listCompartments() { return (await requestJson("/api/compartments")).compartments; },
async createCompartment(name) { return (await requestJson("/api/admin/compartments", { method: "POST", body: { name } })).compartment; },
async moveLeads(leadIds, compartmentId) { return requestJson("/api/admin/leads/move", { method: "POST", body: { leadIds, compartmentId } }); }
```

Use the existing `withTimeout()` wrapper for export downloads and all JSON calls.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/lead-data.test.mjs test/client-api.test.mjs test/client-import.test.mjs`

Run: `npm test`

Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add netlify/lib/lead-data-core.mjs netlify/functions/lead-data.mjs client-api.mjs client-import.mjs test/lead-data.test.mjs test/client-api.test.mjs test/client-import.test.mjs
git commit -m "feat: expose compartment administration APIs"
```

### Task 5: Client Filtering and Shift-Range Selection

**Files:**
- Modify: `client-state.mjs`
- Test: `test/client-state.test.mjs`

**Interfaces:**
- Produces: `buildLeadFacets(leads, compartments)`, `filterAndSortLeads(leads, filters)`, and `createRangeSelection()`.
- Filter shape: `{ query, status, compartmentId, cities: Set<string>, categories: Set<string>, sortMode }`.

- [ ] **Step 1: Write failing state tests**

```js
test("city/category use OR within a facet and AND across facets", () => {
  const result = filterAndSortLeads(records, {
    cities: new Set(["Jaipur", "Agra"]),
    categories: new Set(["Real estate"])
  });
  assert.deepEqual(result.map(lead => lead.id), ["jaipur-real-estate", "agra-real-estate"]);
});

test("Shift selection includes the continuous visible range", () => {
  const selection = createRangeSelection();
  selection.toggle("b", 1, false, ["a", "b", "c", "d"]);
  selection.toggle("d", 3, true, ["a", "b", "c", "d"]);
  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/client-state.test.mjs`

- [ ] **Step 3: Implement facet counts, composed filtering, and selection**

Keep sorting non-mutating. Normalize comparisons case-insensitively while retaining display spelling. `clear()` resets anchor and IDs. The UI calls `clear()` whenever filters or active compartment change.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/client-state.test.mjs`

Run: `npm test`

Expected: zero failures.

- [ ] **Step 5: Commit**

```bash
git add client-state.mjs test/client-state.test.mjs
git commit -m "feat: filter and select compartment leads"
```

### Task 6: Responsive Viewer and Admin UI

**Files:**
- Modify: `index.html`
- Modify: `app.mjs`
- Test: `test/index-html.test.mjs`

**Interfaces:**
- Consumes all Tasks 1-5 client APIs and state helpers.
- Produces user-visible compartment navigation, filter checkboxes, import destination selection, management dialog, lead selection, and bulk move bar.

- [ ] **Step 1: Write failing DOM-contract tests**

```js
for (const id of [
  "compartmentNav", "filterToggle", "cityFilters", "categoryFilters",
  "manageCompartments", "importCompartment", "bulkMoveBar", "moveDestination"
]) assert.match(html, new RegExp(`id="${id}"`));

assert.match(app, /api\.moveLeads/);
assert.match(app, /api\.downloadCompartment/);
assert.match(app, /shiftKey/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/index-html.test.mjs`

- [ ] **Step 3: Implement viewer navigation and filter panel**

Render compartment buttons with counts, checkbox lists with counts, active-filter chips, and Clear all. Show the current compartment badge in every card. Keep phone filters in a collapsible, non-sticky panel and preserve the accessible high-contrast focus treatment.

- [ ] **Step 4: Implement admin management and import destination**

Add create/rename/export/delete controls, exact-name delete confirmation, destination selection before import preview, and inline compartment creation. Invalidate an accepted import preview if the destination changes.

- [ ] **Step 5: Implement lead selection and bulk movement**

Render admin-only checkboxes, pass `event.shiftKey` and the current filtered ID order to `createRangeSelection()`, show selected count, and refresh compartment counts after move. Report partial failures without clearing failed IDs from selection.

- [ ] **Step 6: Add City/Area editing and integrate the pending neobrutalist UI**

Extend Edit Lead with City/Area. Consolidate superseded CSS rules rather than leaving a second override stylesheet. Preserve all current dialogs, call/WhatsApp actions, workflow inputs, admin visibility rules, and phone layout.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/index-html.test.mjs test/client-state.test.mjs test/client-api.test.mjs`

Run: `npm test`

Expected: zero failures.

- [ ] **Step 8: Browser QA**

Serve the app against controlled sample API data and verify desktop plus 320×568 and 390×844 viewports: no horizontal overflow, filters compose, Shift range selects correctly, dialogs fit, focus rings remain visible, and the console has no warnings/errors.

- [ ] **Step 9: Commit**

```bash
git add index.html app.mjs test/index-html.test.mjs
git commit -m "feat: add compartment and filter workflows"
```

### Task 7: Documentation, Review, and Deployment

**Files:**
- Modify: `README.md`
- Verify: all production and test files from Tasks 1-6

**Interfaces:**
- Produces an operator-facing explanation of compartments, import format, export/re-import, destructive deletion, and migration.

- [ ] **Step 1: Update deployment and usage documentation**

Document `City` in JSON, one-compartment-per-batch imports, Existing Leads migration, Shift-selection movement, compartment export, exact-name deletion, and viewer/admin permissions.

- [ ] **Step 2: Run fresh verification**

Run: `npm test`

Expected: every test passes with zero failures.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Request whole-branch code review**

Provide the reviewer the spec, this plan, base commit, current commit, and explicit focus on migration data preservation, destructive deletion retry safety, authorization, concurrent move/update behavior, and mobile accessibility. Fix every Critical and Important finding, then rerun Step 2.

- [ ] **Step 4: Commit documentation and review fixes**

```bash
git add README.md
git commit -m "docs: explain compartment workflows"
```

- [ ] **Step 5: Push and verify Netlify deployment**

Push `main` to `origin`, wait for Netlify to serve the pushed commit, and confirm public static assets contain the compartment UI. Verify live public reads and viewer filters without mutating data.

- [ ] **Step 6: Authenticated production smoke test**

Without requesting or exposing the password, ask the user to verify one disposable-compartment lifecycle: create, import one test lead, Shift-move it, download JSON, and delete the disposable compartment. If the user is already authenticated and explicitly requests browser execution, perform only the authorized steps and reconfirm immediately before permanent deletion.
