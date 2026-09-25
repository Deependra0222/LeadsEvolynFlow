import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createLeadHandler } from "../netlify/lib/lead-data-core.mjs";

const NOW = "2026-09-24T06:00:00.000Z";
const lead = (overrides = {}) => ({
  id: "lead-a", sno: 1, name: "A", mobile: "01", address: "Agra", category: "Store",
  status: "Called", followup: "", remarks: "old", createdAt: NOW, updatedAt: NOW, ...overrides
});

function makeRepository(overrides = {}) {
  const records = new Map([["lead-a", lead()]]);
  const calls = { ensure: 0, patch: [], imports: [], importOptions: [], update: [], remove: [], export: 0 };
  return {
    calls,
    async ensureInitialized() { calls.ensure += 1; },
    async list() { return [...records.values()]; },
    async listImportIndex() {
      return {
        snos: new Set([...records.values()].map(record => record.sno)),
        leadIds: new Set(records.keys())
      };
    },
    async getSerialReservation() { return null; },
    async get(id) { return records.get(id) || null; },
    async patchWorkflow(id, patch) {
      calls.patch.push({ id, patch });
      const current = records.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: NOW };
      records.set(id, next);
      return next;
    },
    async importMany(items, options) {
      calls.imports.push(items);
      calls.importOptions.push(options);
      return {
        imported: items.map((item, index) => lead({ ...item, id: `new-${index}`, sno: item.sno ?? index + 2 })),
        errors: []
      };
    },
    async updateCore(id, core) {
      calls.update.push({ id, core });
      const current = records.get(id);
      if (!current) return null;
      const next = { ...current, ...core, updatedAt: NOW };
      records.set(id, next);
      return next;
    },
    async remove(id) { calls.remove.push(id); const current = records.get(id) || null; records.delete(id); return current; },
    async exportAll() { calls.export += 1; return [...records.values()]; },
    ...overrides
  };
}

function makeAuth(overrides = {}) {
  return {
    configured: true,
    authenticate: attempt => attempt === "correct",
    issueCookie: ({ secure }) => `lead_admin_session=ok; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`,
    clearCookie: () => "lead_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
    isAuthorized: request => (request.headers.get("cookie") || "").includes("lead_admin_session=ok"),
    ...overrides
  };
}

function makeHandler({ repository = makeRepository(), auth = makeAuth(), limiter } = {}) {
  const loginLimiter = limiter || { check: () => ({ allowed: true, retryAfterSeconds: 0 }) };
  return { handler: createLeadHandler({ repository, auth, loginLimiter, now: () => NOW }), repository };
}

function request(path, method = "GET", body, options = {}) {
  const headers = new Headers(options.headers || {});
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.origin !== false && method !== "GET") headers.set("origin", options.origin || "https://site.test");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`https://site.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("GET initializes and returns complete leads without caching", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { leads: [lead()] });
  assert.equal(repository.calls.ensure, 1);
});

test("PATCH sends only changed workflow fields", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads/lead-a/workflow", "PATCH", { remarks: "new" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).lead.remarks, "new");
  assert.deepEqual(repository.calls.patch, [{ id: "lead-a", patch: { remarks: "new" } }]);
});

test("public core-field changes are forbidden", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads/lead-a/workflow", "PATCH", { name: "Hijack" }));
  assert.equal(response.status, 403);
  assert.deepEqual(repository.calls.patch, []);
});

test("public workflow route validates identifiers, JSON, type, body size, and missing leads", async (t) => {
  const cases = [
    ["bad id", request("/api/leads/..%2Fsecret/workflow", "PATCH", { remarks: "x" }), 400],
    ["malformed JSON", request("/api/leads/lead-a/workflow", "PATCH", "{bad"), 400],
    ["wrong type", request("/api/leads/lead-a/workflow", "PATCH", "x", { headers: { "content-type": "text/plain" } }), 415],
    ["oversized header", request("/api/leads/lead-a/workflow", "PATCH", { remarks: "x" }, { headers: { "content-length": "2000001" } }), 413],
    ["missing lead", request("/api/leads/missing/workflow", "PATCH", { remarks: "x" }), 404]
  ];
  for (const [name, input, status] of cases) await t.test(name, async () => assert.equal((await makeHandler().handler(input)).status, status));
});

test("foreign origins are rejected for mutations", async () => {
  const { handler } = makeHandler();
  assert.equal((await handler(request("/api/leads/lead-a/workflow", "PATCH", { remarks: "x" }, { origin: "https://evil.test" }))).status, 403);
});

test("admin login, session, and logout manage the signed cookie", async () => {
  const { handler } = makeHandler();
  const login = await handler(request("/api/admin/login", "POST", { password: "correct" }));
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /lead_admin_session=ok/);
  assert.deepEqual(await login.json(), { authenticated: true });
  assert.deepEqual(await (await handler(request("/api/admin/session", "GET", undefined, { cookie: "lead_admin_session=ok" }))).json(), { authenticated: true });
  const logout = await handler(request("/api/admin/logout", "POST", {}, { cookie: "lead_admin_session=ok" }));
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});

test("bad login is generic, missing configuration is unavailable, and throttling returns retry time", async () => {
  const bad = await makeHandler().handler(request("/api/admin/login", "POST", { password: "wrong" }));
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: "Invalid admin credentials." });
  const unconfigured = makeHandler({ auth: makeAuth({ configured: false }) });
  assert.equal((await unconfigured.handler(request("/api/admin/login", "POST", { password: "x" }))).status, 503);
  const limited = makeHandler({ limiter: { check: () => ({ allowed: false, retryAfterSeconds: 123 }) } });
  const response = await limited.handler(request("/api/admin/login", "POST", { password: "x" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "123");
});

test("privileged routes reject missing and tampered sessions without writes", async (t) => {
  for (const cookie of [undefined, "lead_admin_session=tampered"]) {
    await t.test(cookie || "missing", async () => {
      const { handler, repository } = makeHandler();
      const response = await handler(request("/api/leads/lead-a", "DELETE", undefined, { cookie }));
      assert.equal(response.status, 401);
      assert.deepEqual(repository.calls.remove, []);
    });
  }
});

test("admin import preview reports valid rows and errors without writing", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads/import", "POST", {
    preview: true,
    records: [{ name: "Good", mobile: "2" }, { name: "", mobile: "3" }]
  }, { cookie: "lead_admin_session=ok" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.valid.length, 1);
  assert.equal(body.valid[0].index, 0);
  assert.equal(body.valid[0].sno, 2);
  assert.equal(body.errors[0].index, 1);
  assert.deepEqual(repository.calls.imports, []);
});

test("admin import preview uses the lightweight serial index instead of loading every lead", async () => {
  const repository = makeRepository({
    async list() { throw new Error("full lead list must not be loaded for import preview"); },
    async listImportIndex() {
      return { snos: new Set([1]), leadIds: new Set(["lead-a"]) };
    }
  });
  const { handler } = makeHandler({ repository });

  const response = await handler(request("/api/leads/import", "POST", {
    preview: true,
    records: [{ name: "Good", mobile: "2" }]
  }, { cookie: "lead_admin_session=ok" }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).valid[0].sno, 2);
});

test("admin import writes only validated records", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads/import", "POST", {
    preview: false,
    requestId: "request_123",
    records: [{ name: "Good", mobile: "2" }, { name: "", mobile: "3" }]
  }, { cookie: "lead_admin_session=ok" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.imported.length, 1);
  assert.equal(body.errors.length, 1);
  assert.equal(repository.calls.imports[0].length, 1);
  assert.equal(repository.calls.imports[0][0].sno, undefined);
  assert.deepEqual(repository.calls.importOptions[0], { requestId: "request_123", sourceIndexes: [0] });
});

test("admin import rejects unsafe request identifiers", async () => {
  const { handler, repository } = makeHandler();
  const response = await handler(request("/api/leads/import", "POST", {
    preview: false,
    requestId: "../unsafe",
    records: [{ name: "Good", mobile: "2" }]
  }, { cookie: "lead_admin_session=ok" }));
  assert.equal(response.status, 400);
  assert.deepEqual(repository.calls.imports, []);
});

test("confirmed import retries can replay their previously stored explicit serial", async () => {
  const prior = lead({
    id: "import-request_123-0",
    sno: 9,
    name: "Previously stored",
    mobile: "9",
    address: "",
    category: ""
  });
  const repository = makeRepository({
    async listImportIndex() { return { snos: new Set([prior.sno]), leadIds: new Set([prior.id]) }; },
    async get(id) { return id === prior.id ? prior : null; },
    async importMany() { return { imported: [prior], errors: [] }; }
  });
  const { handler } = makeHandler({ repository });
  const response = await handler(request("/api/leads/import", "POST", {
    preview: false,
    requestId: "request_123",
    records: [{ sno: 9, name: "Previously stored", mobile: "9", address: "", category: "" }]
  }, { cookie: "lead_admin_session=ok" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: [prior], errors: [] });
});

test("confirmed import retry accepts an explicit serial reservation owned by the same request", async () => {
  const stored = lead({ id: "import-request_owned-0", sno: 9, name: "Owned", mobile: "9" });
  const repository = makeRepository({
    async listImportIndex() { return { snos: new Set([1, 9]), leadIds: new Set(["lead-a"]) }; },
    async getSerialReservation(sno) {
      return sno === 9 ? { claimedAt: NOW, ownerId: "import-request_owned-0" } : null;
    },
    async importMany() { return { imported: [stored], errors: [] }; }
  });
  const { handler } = makeHandler({ repository });

  const response = await handler(request("/api/leads/import", "POST", {
    preview: false,
    requestId: "request_owned",
    records: [{ sno: 9, name: "Owned", mobile: "9" }]
  }, { cookie: "lead_admin_session=ok" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: [stored], errors: [] });
});

test("admin import returns stored rows and maps storage failures to original input rows", async () => {
  const repository = makeRepository({
    async importMany(items) {
      return {
        imported: [lead({ ...items[0], id: "new-0" })],
        errors: [{ index: 1, field: "sno", error: "Could not store this lead." }]
      };
    }
  });
  const { handler } = makeHandler({ repository });
  const response = await handler(request("/api/leads/import", "POST", {
    preview: false,
    requestId: "request_partial_123",
    records: [
      { name: "", mobile: "bad" },
      { name: "Stored", mobile: "2" },
      { name: "Failed", mobile: "3" }
    ]
  }, { cookie: "lead_admin_session=ok" }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.imported.map(record => record.name), ["Stored"]);
  assert.deepEqual(body.errors.map(error => error.index), [0, 2]);
});

test("admin can edit core details and delete a lead", async () => {
  const { handler, repository } = makeHandler();
  const edit = await handler(request("/api/leads/lead-a", "PUT", {
    name: "Updated", mobile: "02", address: "Lucknow", category: "Retail"
  }, { cookie: "lead_admin_session=ok" }));
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).lead.name, "Updated");
  const deletion = await handler(request("/api/leads/lead-a", "DELETE", undefined, { cookie: "lead_admin_session=ok" }));
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted: true, id: "lead-a" });
  assert.deepEqual(repository.calls.remove, ["lead-a"]);
});

test("admin export downloads complete JSON", async () => {
  const { handler } = makeHandler();
  const response = await handler(request("/api/admin/export", "GET", undefined, { cookie: "lead_admin_session=ok" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment; filename="telecaller-leads-2026-09-24.json"/);
  assert.equal((await response.json()).length, 1);
});

test("unsupported methods, OPTIONS, and storage failures are safe", async () => {
  const { handler } = makeHandler();
  const method = await handler(request("/api/leads", "POST", {}));
  assert.equal(method.status, 405);
  assert.match(method.headers.get("allow"), /GET/);
  assert.equal((await handler(request("/api/leads", "OPTIONS", undefined, { origin: false }))).status, 204);
  const broken = makeHandler({ repository: makeRepository({ list: async () => { throw new Error("secret detail"); } }) });
  const response = await broken.handler(request("/api/leads"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Shared storage is temporarily unavailable." });
});

test("deployable adapter uses strong Blob consistency and one function", async () => {
  const adapter = await readFile(new URL("../netlify/functions/lead-data.mjs", import.meta.url), "utf8");
  assert.match(adapter, /getStore\(\{\s*name:\s*"telecaller-leads",\s*consistency:\s*"strong"\s*\}\)/);
  assert.match(adapter, /LEAD_ADMIN_PASSWORD/);
  assert.match(adapter, /LEAD_SESSION_SECRET/);
  const functionFiles = (await readdir(new URL("../netlify/functions/", import.meta.url), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".mjs")).map(entry => entry.name);
  assert.deepEqual(functionFiles, ["lead-data.mjs"]);
});
