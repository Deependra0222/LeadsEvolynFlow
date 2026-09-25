import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient } from "../client-api.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

test("API client loads leads with same-origin credentials", async () => {
  const calls = [];
  const api = createApiClient(async (path, options) => {
    calls.push({ path, options });
    return jsonResponse({ leads: [{ id: "a" }] });
  });
  assert.deepEqual(await api.listLeads(), [{ id: "a" }]);
  assert.equal(calls[0].path, "/api/leads");
  assert.equal(calls[0].options.credentials, "same-origin");
});

test("API client encodes IDs and PATCHes only the supplied workflow fields", async () => {
  const calls = [];
  const api = createApiClient(async (path, options) => {
    calls.push({ path, options });
    return jsonResponse({ lead: { id: "a/b", remarks: "new" } });
  });
  await api.patchWorkflow("a/b", { remarks: "new" });
  assert.equal(calls[0].path, "/api/leads/a%2Fb/workflow");
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), { remarks: "new" });
});

test("API client exposes safe structured errors", async () => {
  const api = createApiClient(async () => jsonResponse({ error: "No access", errors: [{ index: 1 }] }, 401));
  await assert.rejects(api.deleteLead("a"), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "No access");
    assert.deepEqual(error.details, [{ index: 1 }]);
    return true;
  });
});

test("API client aborts a stalled import preview with a useful timeout error", async () => {
  const api = createApiClient(async (_path, options) => {
    if (!options.signal) throw new Error("missing abort signal");
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, { timeoutMs: 5 });

  await assert.rejects(api.previewImport([{ name: "A" }]), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 408);
    assert.match(error.message, /too long/i);
    return true;
  });
});

test("API client treats a timeout while reading JSON as a timeout rather than empty success", async () => {
  const api = createApiClient(async (_path, options) => ({
    ok: true,
    status: 200,
    json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })
  }), { timeoutMs: 5 });

  await assert.rejects(api.previewImport([{ name: "A" }]), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 408);
    return true;
  });
});

test("API client also times out a stalled backup download", async () => {
  const api = createApiClient(async (_path, options) => {
    if (!options.signal) throw new Error("missing abort signal");
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, { timeoutMs: 5 });

  await assert.rejects(api.downloadBackup(), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 408);
    return true;
  });
});

test("API client maps session, login, import, edit, and delete responses", async () => {
  const calls = [];
  const api = createApiClient(async (path, options) => {
    calls.push([path, options.method, options.body]);
    if (path.endsWith("session")) return jsonResponse({ authenticated: true });
    if (path.endsWith("login") || path.endsWith("logout")) return jsonResponse({ authenticated: path.endsWith("login") });
    if (path === "/api/leads/import") return jsonResponse(options.body.includes('"preview":true') ? { valid: [{ name: "A" }], errors: [] } : { imported: [{ id: "n" }], errors: [] });
    if (options.method === "PUT") return jsonResponse({ lead: { id: "a", name: "Updated" } });
    return jsonResponse({ deleted: true, id: "a" });
  });
  assert.equal(await api.session(), true);
  assert.equal(await api.login("pw"), true);
  assert.equal(await api.logout(), false);
  assert.equal((await api.previewImport([{ name: "A" }])).valid.length, 1);
  assert.equal((await api.importLeads([{ name: "A" }], "request_123")).imported[0].id, "n");
  assert.equal((await api.updateLead("a", { name: "Updated", mobile: "1", address: "", category: "" })).name, "Updated");
  assert.deepEqual(await api.deleteLead("a"), { deleted: true, id: "a" });
  const importCall = calls.find(([path, method, body]) => path === "/api/leads/import" && method === "POST" && body.includes('"preview":false'));
  assert.equal(JSON.parse(importCall[2]).requestId, "request_123");
  assert.ok(calls.length >= 7);
});
