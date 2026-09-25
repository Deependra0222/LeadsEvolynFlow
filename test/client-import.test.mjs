import test from "node:test";
import assert from "node:assert/strict";
import { createImportReviewState, createLatestReadGuard, parseImportText, readJsonFile } from "../client-import.mjs";
import * as importTools from "../client-import.mjs";

test("parseImportText accepts one object or a non-empty array", () => {
  assert.deepEqual(parseImportText(' { "name": "A" } ').records, [{ name: "A" }]);
  assert.deepEqual(parseImportText('[{"name":"A"},{"name":"B"}]').records.length, 2);
});

test("parseImportText reports malformed and unsupported roots", () => {
  assert.equal(parseImportText("{bad").ok, false);
  assert.equal(parseImportText("42").ok, false);
  assert.equal(parseImportText("[]").ok, false);
});

test("readJsonFile enforces type and byte limits", async () => {
  const valid = { name: "leads.json", type: "application/json", size: 10, text: async () => "[]" };
  assert.equal(await readJsonFile(valid, { maxBytes: 10 }), "[]");
  await assert.rejects(readJsonFile({ ...valid, name: "leads.txt" }, { maxBytes: 10 }), /JSON file/);
  await assert.rejects(readJsonFile({ ...valid, size: 11 }, { maxBytes: 10 }), /too large/);
});

test("import confirmation uses only the immutable payload from the latest accepted preview", () => {
  const ids = ["request_first", "request_second"];
  const review = createImportReviewState({ makeRequestId: () => ids.shift() });
  const firstSource = [{ name: "First" }];
  const first = review.begin(firstSource, "room-first");
  firstSource[0].name = "Changed after request";
  const second = review.begin([{ name: "Second" }], "room-second");

  assert.equal(review.accept(first.token, { valid: [{ index: 0 }] }), false);
  assert.equal(review.confirmPayload(), null);
  assert.equal(review.accept(second.token, { valid: [{ index: 0 }] }), true);
  assert.deepEqual(review.confirmPayload(), {
    requestId: "request_second",
    records: [{ name: "Second" }],
    compartmentId: "room-second"
  });
  assert.deepEqual(review.confirmPayload(), {
    requestId: "request_second",
    records: [{ name: "Second" }],
    compartmentId: "room-second"
  });

  review.invalidate();
  assert.equal(review.confirmPayload(), null);
});

test("a partial import keeps its reviewed request available for a safe retry", () => {
  const review = createImportReviewState({ makeRequestId: () => "request_retry" });
  const preview = review.begin([{ name: "A" }, { name: "B" }], "room-a");
  review.accept(preview.token, { valid: [{ index: 0 }, { index: 1 }] });

  assert.equal(review.complete({ errors: [{ index: 1, field: "$" }] }), false);
  assert.deepEqual(review.confirmPayload(), {
    requestId: "request_retry",
    records: [{ name: "A" }, { name: "B" }],
    compartmentId: "room-a"
  });
  assert.equal(review.complete({ errors: [] }), true);
  assert.equal(review.confirmPayload(), null);
});

test("a current preview failure clears the pending review and returns a visible message", () => {
  const review = createImportReviewState({ makeRequestId: () => "request_timeout" });
  const attempt = review.begin([{ name: "A" }], "room-a");

  assert.equal(typeof importTools.failImportPreview, "function");
  assert.equal(importTools.failImportPreview(review, attempt.token, new Error("Request took too long. Please try again.")), "Request took too long. Please try again.");
  assert.equal(review.isCurrent(attempt.token), false);
  assert.equal(importTools.failImportPreview(review, attempt.token, new Error("stale")), null);
});

test("latest read guard rejects older file results and manual-input races", () => {
  const guard = createLatestReadGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(second), false);
});
