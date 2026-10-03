import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMongoStore } from "../server/lib/mongo-store.mjs";
import { createFileStore } from "../server/lib/file-store.mjs";
import { createServerHandler, resolveSessionSecret } from "../server/app.mjs";

// Mirrors the subset of the MongoDB driver's Collection API that the store uses,
// including the duplicate-key error code and left-anchored _id regex filters.
function createFakeCollection() {
  const docs = new Map();
  const clone = value => structuredClone(value);
  const matches = (doc, filter) => Object.entries(filter).every(([field, condition]) => {
    if (condition && typeof condition === "object" && "$regex" in condition) {
      return new RegExp(condition.$regex).test(doc[field]);
    }
    return doc[field] === condition;
  });
  const project = (doc, projection) => projection
    ? Object.fromEntries(Object.entries(doc).filter(([field]) => field === "_id" || projection[field]))
    : doc;
  return {
    docs,
    async findOne(filter, options = {}) {
      const doc = [...docs.values()].find(item => matches(item, filter));
      return doc ? clone(project(doc, options.projection)) : null;
    },
    find(filter, options = {}) {
      return { toArray: async () => [...docs.values()].filter(item => matches(item, filter)).map(item => clone(project(item, options.projection))) };
    },
    async insertOne(doc) {
      if (docs.has(doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      docs.set(doc._id, clone(doc));
      return { acknowledged: true };
    },
    async updateOne(filter, update) {
      const doc = [...docs.values()].find(item => matches(item, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      docs.set(doc._id, { ...doc, ...clone(update.$set) });
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async replaceOne(filter, replacement, options = {}) {
      const doc = [...docs.values()].find(item => matches(item, filter));
      if (!doc && !options.upsert) return { matchedCount: 0 };
      const id = doc?._id ?? filter._id;
      docs.set(id, { _id: id, ...clone(replacement) });
      return { matchedCount: doc ? 1 : 0, upsertedCount: doc ? 0 : 1 };
    },
    async deleteOne(filter) {
      const doc = [...docs.values()].find(item => matches(item, filter));
      if (doc) docs.delete(doc._id);
      return { deletedCount: doc ? 1 : 0 };
    }
  };
}

const factories = {
  mongo: async () => {
    const collection = createFakeCollection();
    return createMongoStore({ collection: async () => collection });
  },
  file: async () => createFileStore()
};

for (const [name, makeStore] of Object.entries(factories)) {
  test(`${name} store supports conditional writes like the repositories expect`, async () => {
    const store = await makeStore();
    assert.equal(await store.get("lead/a"), null);
    assert.equal(await store.getWithMetadata("lead/a"), null);
    const created = await store.setJSON("lead/a", { name: "A", skip: undefined }, { onlyIfNew: true });
    assert.equal(created.modified, true);
    assert.deepEqual(await store.get("lead/a"), { name: "A" });
    assert.equal((await store.setJSON("lead/a", { name: "B" }, { onlyIfNew: true })).modified, false);
    const current = await store.getWithMetadata("lead/a");
    assert.equal(current.etag, created.etag);
    assert.equal((await store.setJSON("lead/a", { name: "C" }, { onlyIfMatch: "stale" })).modified, false);
    const updated = await store.setJSON("lead/a", { name: "C" }, { onlyIfMatch: current.etag });
    assert.equal(updated.modified, true);
    assert.notEqual(updated.etag, current.etag);
    assert.equal((await store.setJSON("system/marker", { version: 3 })).modified, true);
    assert.equal((await store.setJSON("system/marker", { version: 4 })).modified, true);
    assert.deepEqual(await store.get("system/marker"), { version: 4 });
    await store.delete("system/marker");
    await store.delete("missing");
    assert.equal(await store.get("system/marker"), null);
  });

  test(`${name} store lists keys and values by literal prefix`, async () => {
    const store = await makeStore();
    await store.setJSON("lead/1", { n: 1 });
    await store.setJSON("lead/2", { n: 2 });
    await store.setJSON("lead-legacy", { n: 3 });
    await store.setJSON("leadXother", { n: 4 });
    const keys = [];
    for await (const page of store.list({ prefix: "lead/", paginate: true })) for (const blob of page.blobs) keys.push(blob.key);
    assert.deepEqual(keys.sort(), ["lead/1", "lead/2"]);
    assert.deepEqual((await store.listJSON("lead/")).map(entry => entry.data.n).sort(), [1, 2]);
    assert.equal((await store.listJSON("lead.")).length, 0);
  });
}

test("file store persists to disk across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lead-store-"));
  try {
    const path = join(dir, "nested", "store.json");
    const first = await createFileStore({ path });
    await first.setJSON("lead/a", { name: "Saved" });
    const second = await createFileStore({ path });
    assert.deepEqual(await second.get("lead/a"), { name: "Saved" });
    assert.match(await readFile(path, "utf8"), /"Saved"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session secret is optional and derived from the admin password", () => {
  assert.equal(resolveSessionSecret({ LEAD_SESSION_SECRET: "explicit" }), "explicit");
  assert.equal(resolveSessionSecret({}), "");
  const derived = resolveSessionSecret({ LEAD_ADMIN_PASSWORD: "pw", MONGODB_URI: "mongodb+srv://x" });
  assert.ok(derived.length >= 32);
  assert.notEqual(derived, resolveSessionSecret({ LEAD_ADMIN_PASSWORD: "other", MONGODB_URI: "mongodb+srv://x" }));
});

test("Vercel deployment without MONGODB_URI fails loudly instead of losing data", async () => {
  const handle = await createServerHandler({ env: { VERCEL: "1", LEAD_ADMIN_PASSWORD: "pw" } });
  const response = await handle(new Request("https://site.test/api/leads"));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /MONGODB_URI/);
});

test("full flow on the MongoDB store: seed, login, folder, import, move, delete", async () => {
  const collection = createFakeCollection();
  const store = createMongoStore({ collection: async () => collection });
  const handle = await createServerHandler({ env: { LEAD_ADMIN_PASSWORD: "secret-pass" }, store });
  const call = async (path, method = "GET", body, cookie = "") => {
    const headers = { origin: "https://site.test" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    const response = await handle(new Request(`https://site.test/api/lead-data?__route=${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }));
    return { response, body: await response.json() };
  };

  const health = await call("health");
  assert.equal(health.body.ok, true);
  const seeded = await call("leads");
  assert.equal(seeded.body.leads.length, 722);

  assert.equal((await call("admin/login", "POST", { password: "wrong" })).response.status, 401);
  const login = await call("admin/login", "POST", { password: "secret-pass" });
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("admin/session", "GET", undefined, cookie)).body.authenticated, true);

  const folder = await call("admin/compartments", "POST", { name: "Jaipur Hotels" }, cookie);
  assert.equal(folder.response.status, 201);
  const folderId = folder.body.compartment.id;
  const rows = [
    { "Institute/Business Name": "Hotel One", "Mobile Number": "9876543210", "City": "Jaipur", "Category": "Hotel" },
    { name: "Hotel Two", mobile: "9876543211", address: "MI Road, Jaipur" }
  ];
  const preview = await call("leads/import", "POST", { preview: true, compartmentId: folderId, records: rows }, cookie);
  assert.equal(preview.body.valid.length, 2);
  const imported = await call("leads/import", "POST", { preview: false, requestId: "request_flow_1", compartmentId: folderId, records: rows }, cookie);
  assert.equal(imported.body.imported.length, 2);
  assert.deepEqual(imported.body.imported.map(lead => lead.sno), [723, 724]);

  const compartments = await call("compartments");
  assert.equal(compartments.body.compartments.find(item => item.id === folderId).count, 2);

  const update = await call(`leads/${imported.body.imported[0].id}/workflow`, "PATCH", { status: "Interested", remarks: "Call back" });
  assert.equal(update.body.lead.status, "Interested");

  const moved = await call("admin/leads/move", "POST", { leadIds: [imported.body.imported[1].id], compartmentId: "existing-leads" }, cookie);
  assert.equal(moved.body.moved.length, 1);

  const exported = await handle(new Request(`https://site.test/api/admin/compartments/${folderId}/export`, { headers: { cookie } }));
  const exportedRows = await exported.json();
  assert.deepEqual(exportedRows.map(row => [row["Institute/Business Name"], row["Call Status"]]), [["Hotel One", "Interested"]]);

  const removed = await call(`admin/compartments/${folderId}`, "DELETE", { confirmation: "Jaipur Hotels" }, cookie);
  assert.equal(removed.body.deletedLeads, 1);
  const after = await call("leads");
  assert.equal(after.body.leads.length, 723);
  assert.ok([...collection.docs.keys()].every(key => !key.startsWith(`compartment/${folderId}`)));
});
