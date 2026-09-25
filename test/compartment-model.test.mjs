import test from "node:test";
import assert from "node:assert/strict";

async function loadModel() {
  return import("../netlify/lib/compartment-model.mjs");
}

test("compartment names normalize and compare case-insensitively", async () => {
  const { normalizeCompartmentName } = await loadModel();
  assert.deepEqual(normalizeCompartmentName("  Jaipur Leads  "), {
    ok: true,
    name: "Jaipur Leads",
    key: "jaipur leads"
  });
  assert.equal(normalizeCompartmentName(" ").ok, false);
  assert.equal(normalizeCompartmentName("x".repeat(81)).ok, false);
});

test("compartment identifiers and stored records reject unsafe values", async () => {
  const { normalizeStoredCompartment, validateCompartmentIdentifier } = await loadModel();
  assert.equal(validateCompartmentIdentifier("existing-leads"), "existing-leads");
  assert.equal(validateCompartmentIdentifier("../private"), null);
  assert.deepEqual(normalizeStoredCompartment({
    id: "existing-leads",
    name: " Existing Leads ",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z"
  }), {
    id: "existing-leads",
    name: "Existing Leads",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z"
  });
  assert.equal(normalizeStoredCompartment({ id: "bad/id", name: "Bad" }), null);
});
