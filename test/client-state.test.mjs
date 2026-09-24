import test from "node:test";
import assert from "node:assert/strict";
import { createLeadState, matchesLead } from "../client-state.mjs";

const lead = (overrides = {}) => ({
  id: "a", sno: 1, name: "A", mobile: "1", address: "", category: "",
  status: "Called", followup: "", remarks: "old", ...overrides
});

test("draft values survive rerenders and changedWorkflow emits only differences", () => {
  const state = createLeadState();
  state.replaceLeads([lead()]);
  state.rememberDraft("a", { remarks: "new" });
  assert.equal(state.valuesFor("a").remarks, "new");
  assert.equal(state.valuesFor("a").status, "Called");
  assert.deepEqual(state.changedWorkflow("a"), { remarks: "new" });
});

test("confirmSaved clears confirmed fields but keeps newer edits", () => {
  const state = createLeadState();
  state.replaceLeads([lead()]);
  state.rememberDraft("a", { remarks: "submitted" });
  state.rememberDraft("a", { remarks: "typed later", followup: "2026-09-25T10:00" });
  state.confirmSaved({ ...lead(), remarks: "submitted" });
  assert.equal(state.valuesFor("a").remarks, "typed later");
  assert.equal(state.valuesFor("a").followup, "2026-09-25T10:00");
});

test("confirmSaved clears a matching draft", () => {
  const state = createLeadState();
  state.replaceLeads([lead()]);
  state.rememberDraft("a", { status: "Interested" });
  state.confirmSaved({ ...lead(), status: "Interested" });
  assert.deepEqual(state.changedWorkflow("a"), {});
  assert.equal(state.valuesFor("a").status, "Interested");
});

test("editing one input accepts concurrent server values for untouched fields", () => {
  const state = createLeadState();
  state.replaceLeads([lead()]);
  state.rememberInput("a", "remarks", "submitted");

  state.confirmSaved({ ...lead(), status: "Interested", remarks: "submitted" });

  assert.equal(state.valuesFor("a").status, "Interested");
  assert.deepEqual(state.changedWorkflow("a"), {});
});

test("upsertLead and removeLead maintain sorted full records", () => {
  const state = createLeadState();
  state.replaceLeads([lead({ id: "b", sno: 2 })]);
  state.upsertLead(lead({ id: "a", sno: 1 }));
  assert.deepEqual(state.allLeads().map(item => item.id), ["a", "b"]);
  state.removeLead("a");
  assert.deepEqual(state.allLeads().map(item => item.id), ["b"]);
});

test("lead filtering searches serial numbers and respects status", () => {
  const record = lead({ sno: 42, name: "Example" });
  assert.equal(matchesLead(record, "42", ""), true);
  assert.equal(matchesLead(record, "example", "Called"), true);
  assert.equal(matchesLead(record, "42", "Interested"), false);
});
