# Lead Compartments and Multi-Select Filters Design

Date: 2026-09-25
Status: Approved in conversation, pending written review

## Context

The Telecallers Lead site currently stores each lead independently in Netlify Blobs. Anyone with the site link can view leads and update status, follow-up date, and remarks. Password-authenticated admins can import, edit, delete, and export lead data.

The next version must organize leads into admin-managed compartments while preserving the existing per-lead storage and permissions. Viewers also need checkbox filters generated from the cities and categories present in the data.

## Goals

- Give every lead exactly one current compartment.
- Allow admins to create and rename compartments.
- Require every imported batch to target one existing or newly created compartment.
- Allow admins to select a continuous range with click followed by Shift-click and move the selected leads together.
- Allow admins to export one compartment as import-ready JSON.
- Allow admins to delete a compartment and every lead inside it after an explicit warning and confirmation.
- Add a separate City/Area field that supports reliable filtering.
- Provide multi-select City/Area and Category filters that combine with search, status, compartment, and area sorting.
- Show the lead's current compartment anywhere the lead appears, including status-filtered views.
- Preserve viewer workflow updates, admin authentication, imports, backups, and the approved responsive neobrutalist visual language.

## Non-goals

- A lead cannot belong to multiple compartments.
- Call-status changes do not move a lead between compartments.
- The system will not retain or display original-compartment history. Only the current compartment is shown.
- An import batch cannot be split across compartments.
- Deleting a compartment will not automatically move its leads elsewhere.
- This version does not add category or date sorting.

## Data Model

### Compartment

Compartment metadata is stored separately from leads under `compartment/<id>`.

```json
{
  "id": "generated-path-safe-id",
  "name": "Jaipur Real Estate",
  "createdAt": "2026-09-25T00:00:00.000Z",
  "updatedAt": "2026-09-25T00:00:00.000Z"
}
```

Rules:

- IDs are immutable and path-safe.
- Names are trimmed, limited to 80 characters, non-empty, and unique case-insensitively.
- Renaming changes one compartment record; lead records continue referring to the same ID.

### Lead additions

Every normalized lead gains two required stored fields. City/Area is trimmed and limited to 120 characters.

```json
{
  "city": "Jaipur",
  "compartmentId": "generated-path-safe-id"
}
```

The compartment is the lead's current location. Moving a lead updates `compartmentId`; it does not record historical compartments. City/Area is editable by an admin and is independent of the full Area/Address string.

## Existing-Data Migration

Migration is idempotent and runs before lead data is served after deployment.

1. Create a stable, renamable compartment named `Existing Leads` if it does not exist.
2. For every lead without `compartmentId`, assign the Existing Leads compartment.
3. For every lead without `city`, derive a best-effort value from Area/Address:
   - split comma-separated address segments;
   - ignore a trailing state abbreviation or state-plus-postcode segment;
   - use the final remaining city-like segment;
   - use `Unknown` when no reliable segment exists.
4. Preserve all existing IDs, serial numbers, workflow values, timestamps, and core lead details.
5. Write a versioned migration marker only after every lead is normalized. A partial failure is safe to retry.

Admins can correct migrated City/Area values through Edit Lead.

## Filtering and Navigation

The browser derives filter choices from the complete loaded lead set.

- A compartment switcher shows `All Leads` and each compartment with its lead count.
- City/Area and Category filters show unique non-empty values with checkboxes and counts.
- No checked values means no restriction for that filter.
- Multiple checked values within one filter use OR semantics.
- Different filters use AND semantics.
- Search, call status, compartment, City/Area, Category, and area sorting all compose in one deterministic client-side operation.
- Empty or unknown values appear under `Unknown` where appropriate.
- Changing the compartment or filters resets pagination and clears the current bulk selection to prevent accidental moves of hidden leads.
- Filter choices and counts refresh after imports, edits, moves, and deletions.

## Viewer Experience

Viewer permissions remain unchanged.

- View all compartments and leads.
- Search and apply status, compartment, City/Area, Category, and area-sort controls.
- See the current compartment on every lead card, including results filtered to Follow-up, Called, or another status.
- Update only status, follow-up date, and remarks.
- No viewer can create, rename, move, export, or delete compartments.

## Admin Experience

### Manage Compartments

An admin-only management dialog lists compartment names and counts and provides:

- Create compartment.
- Rename compartment.
- Download compartment JSON.
- Delete compartment.

Compartment deletion displays the current lead count, offers a Download JSON action, and requires the admin to type the exact compartment name. Downloading is optional. Confirmed deletion permanently deletes the compartment and every lead currently inside it.

### Import

The import dialog requires a destination compartment before preview or confirmation.

- Admin may select an existing compartment or create one inline.
- The server, not the JSON file, applies the selected `compartmentId` to every valid row.
- Import JSON may include `city` or the display alias `City`.
- If City is omitted, the server applies the same best-effort derivation used by migration.
- Compartment fields inside uploaded JSON are not accepted as routing instructions, preventing one batch from being split accidentally.
- Preview displays the selected destination and City/Area alongside validation results.

### Bulk selection and moving

- Admin mode adds a selection checkbox to each rendered lead card.
- Clicking one checkbox establishes the selection anchor.
- Shift-clicking a later checkbox selects the continuous range between the anchor and that lead in the current filtered ordering.
- A sticky bulk-action bar displays the selected count and a Move to Compartment action.
- If a selected lead is already in the destination compartment, it is reported as unchanged while the other selected leads move normally.
- The server validates every lead ID and the destination compartment, then updates leads with conflict-safe writes that preserve concurrent viewer workflow changes.
- Partial storage failures are reported per lead and successful moves remain successful.

## Compartment Export

`Download Compartment JSON` produces an import-ready JSON array rather than a full database backup.

- Include lead name, mobile, Area/Address, City, Category, Call Status, Next Follow-up, and Remarks.
- Omit internal IDs, `compartmentId`, timestamps, and serial numbers so the file can be imported into another compartment without collisions.
- Use a filename derived safely from the compartment name and export date.
- The existing full admin backup remains unchanged and preserves all internal data needed for recovery.

## API Surface

Public read:

- `GET /api/compartments` returns active compartment metadata and counts.
- `GET /api/leads` continues returning normalized leads, now including `city` and `compartmentId`.

Admin-only mutations:

- `POST /api/admin/compartments` creates a compartment.
- `PUT /api/admin/compartments/:id` renames a compartment.
- `GET /api/admin/compartments/:id/export` downloads import-ready JSON.
- `DELETE /api/admin/compartments/:id` verifies the confirmation value and deletes the compartment and contained leads.
- `POST /api/admin/leads/move` accepts validated `leadIds` and one destination `compartmentId`.
- `POST /api/leads/import` requires a valid destination `compartmentId` for both preview and confirmed import.
- Admin core-lead edits accept City/Area in addition to the existing four core fields.

All mutations keep same-origin checks, admin-session checks, JSON/body limits, path-safe identifiers, and generic error responses already used by the application.

## Storage Consistency and Failure Handling

- Compartment names are checked case-insensitively immediately before creation or rename.
- Import and move operations reject missing or deleting destination compartments.
- Lead moves use the repository's conflict-aware update approach so concurrent remarks or status changes are not overwritten.
- Compartment deletion is idempotent. A deletion marker prevents new imports or moves into that compartment while its leads are removed with bounded concurrency. Retrying resumes cleanup safely.
- If compartment metadata is temporarily unavailable, viewers receive a visible retry state rather than misleading empty filters.
- Unknown compartment IDs render as `Unavailable compartment` and are surfaced to admins for correction.

## UI and Accessibility

- Extend the approved neobrutalist system with thick borders, hard shadows, high-contrast focus indicators, and responsive controls.
- On small screens, filter groups open in a compact panel rather than occupying a permanently sticky header.
- Checkbox filters use native inputs, visible labels, counts, keyboard navigation, and a Clear all action.
- Bulk selection exposes selected state and action feedback to assistive technologies.
- Destructive compartment deletion uses a dedicated dialog and cannot be triggered by a single accidental click.

## Testing Strategy

Implementation follows test-driven development.

- Model tests: compartment and City validation, aliases, migration defaults, stored-lead normalization.
- Repository tests: compartment CRUD, case-insensitive uniqueness, conflict-safe moves, export shape, deletion retry behavior, and migration idempotency.
- Handler tests: public reads, admin authorization, same-origin enforcement, import destination validation, bulk move responses, export headers, and destructive confirmation.
- Client-state tests: multi-select OR/AND semantics, composition with search/status/compartment/sort, counts, pagination reset, and Shift-range selection.
- Client/API tests: all new route mappings and structured failure handling.
- Browser QA: desktop and phone layouts, keyboard focus, admin dialogs, filter interaction, import-to-compartment, bulk moving, export, and deletion warning.
- Full regression suite must pass before commit and again before deployment.

## Rollout and Verification

1. Deploy the schema, migration, API, and client changes together so older incomplete lead shapes never reach the new client.
2. Confirm the migration creates Existing Leads and preserves the live lead count and workflow values.
3. Verify public filtering and viewer workflow updates against production.
4. Verify authenticated compartment creation, one-batch import, Shift-range move, compartment export, and deletion using a small disposable compartment.
5. Confirm the final production commit and static assets served by Netlify.
