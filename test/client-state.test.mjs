import test from "node:test";
import assert from "node:assert/strict";

async function loadClientState() {
  try {
    return await import("../client-state.mjs");
  } catch (error) {
    assert.fail(`Expected the client state module to load: ${error.code || error.message}`);
  }
}

const lead = {
  sno: 12,
  status: "Not Called",
  followup: "",
  remarks: ""
};

test("draft values survive repeated reads used by card rerenders", async () => {
  const { createLeadState } = await loadClientState();
  const state = createLeadState();
  state.replaceRecords({
    "12": { status: "Called", followup: "", remarks: "Confirmed" }
  });
  state.rememberDraft(12, {
    status: "Follow-up",
    followup: "2026-09-24T11:00",
    remarks: "Unsaved draft"
  });

  assert.deepEqual(state.valuesFor(lead), {
    status: "Follow-up",
    followup: "2026-09-24T11:00",
    remarks: "Unsaved draft"
  });
  assert.equal(state.valuesFor(lead).remarks, "Unsaved draft");
});

test("saving clears only the exact submitted draft", async () => {
  const { createLeadState } = await loadClientState();
  const state = createLeadState();
  const submitted = { status: "Called", followup: "", remarks: "Submitted" };
  const newerDraft = { status: "Called", followup: "", remarks: "Typed while saving" };

  state.rememberDraft(12, submitted);
  state.rememberDraft(12, newerDraft);
  const fullySaved = state.confirmSaved(12, submitted, {
    ...submitted,
    updatedAt: "2026-09-23T01:02:03.000Z"
  });

  assert.equal(fullySaved, false);
  assert.equal(state.valuesFor(lead).remarks, "Typed while saving");
});

test("saving clears a draft when its values match the submission", async () => {
  const { createLeadState } = await loadClientState();
  const state = createLeadState();
  const submitted = { status: "Interested", followup: "", remarks: "Confirmed" };

  state.rememberDraft(12, submitted);
  const fullySaved = state.confirmSaved(12, submitted, {
    ...submitted,
    updatedAt: "2026-09-23T01:02:03.000Z"
  });

  assert.equal(fullySaved, true);
  assert.equal(state.valuesFor(lead).remarks, "Confirmed");
});
