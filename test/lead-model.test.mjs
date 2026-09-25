import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadModel() {
  return import("../netlify/lib/lead-model.mjs");
}

test("lead contract exposes the exact statuses and limits", async () => {
  const { STATUS_OPTIONS, LIMITS } = await loadModel();
  assert.deepEqual(STATUS_OPTIONS, [
    "Not Called", "Called", "No Answer", "Follow-up", "Interested", "Not Interested"
  ]);
  assert.deepEqual(LIMITS, {
    importBytes: 2_000_000,
    importRecords: 1_000,
    name: 300,
    mobile: 50,
    address: 500,
    city: 120,
    category: 120,
    remarks: 5_000
  });
});

test("local date-time validation handles real calendar dates", async () => {
  const { isValidLocalDateTime } = await loadModel();
  assert.equal(isValidLocalDateTime(""), true);
  assert.equal(isValidLocalDateTime("2028-02-29T23:59"), true);
  assert.equal(isValidLocalDateTime("2025-02-29T10:00"), false);
  assert.equal(isValidLocalDateTime("2026-02-30T10:00"), false);
  assert.equal(isValidLocalDateTime("2026-01-01T24:00"), false);
  assert.equal(isValidLocalDateTime("tomorrow"), false);
});

test("internal lead identifiers are path safe", async () => {
  const { validateLeadIdentifier } = await loadModel();
  assert.equal(validateLeadIdentifier("seed-722"), "seed-722");
  assert.equal(validateLeadIdentifier("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  for (const value of ["", "../secret", "a/b", "white space", "x".repeat(81), null]) {
    assert.equal(validateLeadIdentifier(value), null);
  }
});

test("legacy city derivation is deterministic and safe", async () => {
  const { deriveCity } = await loadModel();
  assert.equal(deriveCity("60, Dashrath Path, Jaipur, RJ"), "Jaipur");
  assert.equal(deriveCity("Jaipur, Rajasthan 302021"), "Jaipur");
  assert.equal(deriveCity("Private Address"), "Unknown");
});

test("workflow patches are partial but cannot contain core fields", async () => {
  const { validateWorkflowPatch } = await loadModel();
  assert.deepEqual(validateWorkflowPatch({ remarks: "Called back" }), {
    ok: true,
    data: { remarks: "Called back" }
  });
  assert.deepEqual(validateWorkflowPatch({ name: "Changed" }), {
    ok: false,
    status: 403,
    error: "Workflow updates cannot change core lead details."
  });
  assert.equal(validateWorkflowPatch({}).ok, false);
  assert.equal(validateWorkflowPatch({ status: "Unknown" }).ok, false);
  assert.equal(validateWorkflowPatch({ followup: "2026-02-30T10:00" }).ok, false);
  assert.equal(validateWorkflowPatch({ remarks: "x".repeat(5_001) }).ok, false);
});

test("core edits require exactly the five bounded fields including City", async () => {
  const { validateCorePatch } = await loadModel();
  assert.deepEqual(validateCorePatch({
    name: "  Shop  ", mobile: " 0987 ", address: "  Agra ", city: " Agra ", category: " Store "
  }), {
    ok: true,
    data: { name: "Shop", mobile: "0987", address: "Agra", city: "Agra", category: "Store" }
  });
  assert.equal(validateCorePatch({ name: "Shop", mobile: "1", address: "", city: "Agra", category: "", status: "Called" }).ok, false);
  assert.equal(validateCorePatch({ name: " ", mobile: "1", address: "", city: "Agra", category: "" }).ok, false);
  assert.equal(validateCorePatch({ name: "Shop", mobile: " ", address: "", city: "Agra", category: "" }).ok, false);
  assert.equal(validateCorePatch({ name: "Shop", mobile: "1", address: "", city: "", category: "" }).ok, false);
});

test("imports accept City while stored leads require city and compartment", async () => {
  const { normalizeStoredLead, validateImportRecords } = await loadModel();
  const imported = validateImportRecords({
    name: "A",
    mobile: "1",
    address: "Jaipur, RJ",
    City: " Jaipur "
  });
  assert.equal(imported.valid[0].city, "Jaipur");

  const completeLead = {
    id: "seed-1",
    sno: 1,
    name: "A",
    mobile: "01",
    address: "Jaipur, RJ",
    city: "Jaipur",
    category: "",
    status: "Called",
    followup: "",
    remarks: "ok",
    compartmentId: "existing-leads",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z"
  };
  assert.equal(normalizeStoredLead({ ...completeLead, city: "" }), null);
  assert.equal(normalizeStoredLead({ ...completeLead, compartmentId: "../bad" }), null);
  assert.deepEqual(normalizeStoredLead(completeLead), completeLead);
});

test("imports apply defaults and reject unknown fields", async () => {
  const { validateImportRecords } = await loadModel();
  const result = validateImportRecords({ name: " Shop ", mobile: " 0123 " });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.valid, [{
    name: "Shop", mobile: "0123", address: "", city: "Unknown", category: "",
    status: "Not Called", followup: "", remarks: ""
  }]);
  const unknown = validateImportRecords({ name: "Shop", mobile: "1", project: "Nope" });
  assert.equal(unknown.valid.length, 0);
  assert.equal(unknown.errors[0].field, "project");
});

test("imports accept the website's human-readable JSON field labels", async () => {
  const { validateImportRecords } = await loadModel();
  const result = validateImportRecords({
    "S.No.": 23,
    "Institute/Business Name": "  Example Institute  ",
    "Mobile Number": " 09876543210 ",
    "Area/Address": "  Agra  ",
    "Category": "  Institute  ",
    "Call Status": "Follow-up",
    "Next Follow-up": "2026-10-01T10:30",
    "Remarks": "Call next week"
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.valid, [{
    sno: 23,
    name: "Example Institute",
    mobile: "09876543210",
    address: "Agra",
    city: "Unknown",
    category: "Institute",
    status: "Follow-up",
    followup: "2026-10-01T10:30",
    remarks: "Call next week"
  }]);
});

test("imports allow mixed canonical and display labels but reject conflicting duplicates", async () => {
  const { validateImportRecords } = await loadModel();
  const accepted = validateImportRecords({
    name: "Same Name",
    "Institute/Business Name": "Same Name",
    "Mobile Number": "0123",
    category: "Store",
    "Remarks": "Mixed labels"
  });
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.valid[0].name, "Same Name");
  assert.equal(accepted.valid[0].mobile, "0123");

  const rejected = validateImportRecords({
    name: "Canonical Name",
    "Institute/Business Name": "Different Display Name",
    mobile: "0123"
  });
  assert.equal(rejected.valid.length, 0);
  assert.deepEqual(rejected.errors, [{
    index: 0,
    field: "name",
    error: "Conflicting fields: name and Institute/Business Name."
  }]);
});

test("imports reject provided core fields with the wrong JSON type", async () => {
  const { validateImportRecords } = await loadModel();
  const result = validateImportRecords({
    name: "Shop",
    mobile: 9876543210,
    address: { city: "Agra" },
    category: 7
  });
  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.errors.map(error => error.field), ["mobile", "address", "category"]);
  assert.match(result.errors[0].error, /text/i);
});

test("imports reject duplicate stored and batch serial numbers by row", async () => {
  const { validateImportRecords } = await loadModel();
  const result = validateImportRecords([
    { sno: 7, name: "Stored collision", mobile: "1" },
    { sno: 9, name: "First", mobile: "2" },
    { sno: 9, name: "Second", mobile: "3" }
  ], { existingSnos: new Set([7]) });
  assert.equal(result.valid.length, 1);
  assert.deepEqual(result.errors.map(error => error.index), [0, 2]);
});

test("imports preserve original row indexes for valid preview rows", async () => {
  const { validateImportRecords } = await loadModel();
  const result = validateImportRecords([
    { name: "", mobile: "1" },
    { name: "Valid second row", mobile: "2" }
  ]);
  assert.equal(result.validRows[0].index, 1);
  assert.equal(result.validRows[0].data.name, "Valid second row");
});

test("imports enforce record and field limits", async () => {
  const { validateImportRecords } = await loadModel();
  assert.match(validateImportRecords([]).errors[0].error, /at least one/i);
  assert.match(validateImportRecords(Array.from({ length: 1_001 }, (_, i) => ({ name: `N${i}`, mobile: "1" }))).errors[0].error, /1,000/);
  assert.equal(validateImportRecords({ name: "x".repeat(301), mobile: "1" }).valid.length, 0);
  assert.equal(validateImportRecords({ name: "Name", mobile: "x".repeat(51) }).valid.length, 0);
  assert.equal(validateImportRecords({ name: "Name", mobile: "1", address: "x".repeat(501) }).valid.length, 0);
  assert.equal(validateImportRecords({ name: "Name", mobile: "1", City: "x".repeat(121) }).valid.length, 0);
  assert.equal(validateImportRecords({ name: "Name", mobile: "1", category: "x".repeat(121) }).valid.length, 0);
});

test("stored leads normalize complete records", async () => {
  const { normalizeStoredLead } = await loadModel();
  const normalized = normalizeStoredLead({
    id: "seed-1", sno: 1, name: "A", mobile: "01", address: "", category: "",
    status: "Called", followup: "", remarks: "ok",
    city: "Unknown", compartmentId: "existing-leads",
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z"
  });
  assert.equal(normalized.id, "seed-1");
  assert.equal(normalized.mobile, "01");
  assert.equal(normalizeStoredLead({ id: "../bad" }), null);
});

test("seed JSON contains the 722 original leads", async () => {
  const seed = JSON.parse(await readFile(new URL("../netlify/data/initial-leads.json", import.meta.url), "utf8"));
  assert.equal(seed.length, 722);
  assert.deepEqual(seed.map(item => item.sno), Array.from({ length: 722 }, (_, i) => i + 1));
});
