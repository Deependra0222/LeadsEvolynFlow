import test from "node:test";
import assert from "node:assert/strict";
import { createLeadRepository } from "../netlify/lib/lead-repository.mjs";

const NOW = "2026-09-24T05:00:00.000Z";
const baseLead = (overrides = {}) => ({
  id: "a", sno: 1, name: "A", mobile: "1", address: "", category: "",
  status: "Called", followup: "", remarks: "old",
  createdAt: NOW, updatedAt: NOW, ...overrides
});

function createBlobFake(initial = {}) {
  const values = new Map();
  const etags = new Map();
  let sequence = 0;
  const conflicts = new Map();
  for (const [key, value] of Object.entries(initial)) {
    values.set(key, structuredClone(value));
    etags.set(key, `e${++sequence}`);
  }
  return {
    values,
    conflictOnce(key, replacement) { conflicts.set(key, structuredClone(replacement)); },
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async getWithMetadata(key) {
      if (!values.has(key)) return null;
      return { data: structuredClone(values.get(key)), metadata: {}, etag: etags.get(key) };
    },
    async *list({ prefix }) {
      yield {
        blobs: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, etag: etags.get(key) })),
        directories: []
      };
    },
    async setJSON(key, value, options = {}) {
      if (conflicts.has(key) && options.onlyIfMatch) {
        values.set(key, conflicts.get(key));
        conflicts.delete(key);
        etags.set(key, `e${++sequence}`);
        return { modified: false };
      }
      if (options.onlyIfNew && values.has(key)) return { modified: false };
      if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) return { modified: false };
      values.set(key, structuredClone(value));
      etags.set(key, `e${++sequence}`);
      return { modified: true, etag: etags.get(key) };
    },
    async delete(key) { values.delete(key); etags.delete(key); }
  };
}

function makeRepo({ records = [baseLead()], seedLeads = [], ids = ["new-a", "new-b"], store } = {}) {
  const blob = store || createBlobFake(Object.fromEntries(records.map(record => [`lead/${record.id}`, record])));
  let idIndex = 0;
  return {
    blob,
    repo: createLeadRepository({ store: blob, seedLeads, now: () => NOW, makeId: () => ids[idIndex++] })
  };
}

test("list returns normalized records sorted by serial", async () => {
  const { repo } = makeRepo({ records: [baseLead({ id: "b", sno: 2 }), baseLead({ id: "a", sno: 1 })] });
  assert.deepEqual((await repo.list()).map(lead => lead.id), ["a", "b"]);
});

test("patchWorkflow merges into the latest record", async () => {
  const { repo } = makeRepo();
  const record = await repo.patchWorkflow("a", { remarks: "new" });
  assert.equal(record.status, "Called");
  assert.equal(record.remarks, "new");
  assert.equal(record.updatedAt, NOW);
});

test("patchWorkflow retries an ETag conflict and preserves the concurrent field", async () => {
  const { repo, blob } = makeRepo();
  blob.conflictOnce("lead/a", baseLead({ status: "Interested", remarks: "old" }));
  const record = await repo.patchWorkflow("a", { remarks: "new" });
  assert.equal(record.status, "Interested");
  assert.equal(record.remarks, "new");
});

test("importMany assigns serials and never overwrites a generated ID", async () => {
  const collision = baseLead({ id: "new-a", sno: 8 });
  const { repo } = makeRepo({ records: [baseLead(), collision], ids: ["new-a", "new-b"] });
  const result = await repo.importMany([{ name: "B", mobile: "02", address: "", category: "", status: "Not Called", followup: "", remarks: "" }]);
  assert.equal(result.imported[0].id, "new-b");
  assert.equal(result.imported[0].sno, 2);
  assert.deepEqual(result.errors, []);
});

test("importMany reports successful rows when a later write fails", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  let leadWrites = 0;
  store.setJSON = async (key, value, options) => {
    if (key.startsWith("lead/") && ++leadWrites === 2) throw new Error("temporary storage failure");
    return setJSON(key, value, options);
  };
  const { repo } = makeRepo({ records: [], ids: ["new-a", "new-b"], store });

  const result = await repo.importMany([
    { name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" },
    { name: "B", mobile: "02", address: "", category: "", status: "Not Called", followup: "", remarks: "" }
  ]);

  assert.deepEqual(result.imported.map(record => record.name), ["A"]);
  assert.deepEqual(result.errors, [{ index: 1, field: "$", error: "Could not store this lead." }]);
  assert.deepEqual((await repo.list()).map(record => record.name), ["A"]);
});

test("concurrent imports reserve different automatic serial numbers", async () => {
  const store = createBlobFake({});
  const first = makeRepo({ records: [], ids: ["new-a"], store }).repo;
  const second = makeRepo({ records: [], ids: ["new-b"], store }).repo;

  const [left, right] = await Promise.all([
    first.importMany([{ name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" }]),
    second.importMany([{ name: "B", mobile: "02", address: "", category: "", status: "Not Called", followup: "", remarks: "" }])
  ]);

  assert.deepEqual([...left.imported, ...right.imported].map(record => record.sno).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(left.errors, []);
  assert.deepEqual(right.errors, []);
});

test("a rejected explicit serial import cannot remove another import's reservation", async () => {
  const store = createBlobFake({});
  const first = makeRepo({ records: [], ids: ["new-a"], store }).repo;
  const second = makeRepo({ records: [], ids: ["new-b"], store }).repo;
  const row = name => ({ sno: 9, name, mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" });

  const results = await Promise.all([first.importMany([row("A")]), second.importMany([row("B")])]);

  assert.equal(results.reduce((sum, result) => sum + result.imported.length, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.errors.length, 0), 1);
  assert.notEqual(await store.get("serial/9"), null);
});

test("retrying one import request returns the prior record without duplicating it", async () => {
  const store = createBlobFake({});
  const { repo } = makeRepo({ records: [], store });
  const records = [{ name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" }];

  const first = await repo.importMany(records, { requestId: "request_123", sourceIndexes: [4] });
  const retry = await repo.importMany(records, { requestId: "request_123", sourceIndexes: [4] });

  assert.equal(first.imported[0].id, retry.imported[0].id);
  assert.equal((await repo.list()).length, 1);
});

test("an import recovers when the lead write commits before the storage call throws", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  let interrupted = false;
  store.setJSON = async (key, value, options) => {
    const result = await setJSON(key, value, options);
    if (!interrupted && key.startsWith("lead/")) {
      interrupted = true;
      throw new Error("response was lost after commit");
    }
    return result;
  };
  const { repo } = makeRepo({ records: [], store });
  const row = { name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" };

  const result = await repo.importMany([row], { requestId: "request_ambiguous", sourceIndexes: [0] });

  assert.equal(result.imported.length, 1);
  assert.deepEqual(result.errors, []);
  assert.equal((await repo.list()).length, 1);
});

test("automatic serials skip values explicitly supplied later in the same batch", async () => {
  const { repo } = makeRepo({ records: [], ids: ["new-a", "new-b"] });
  const result = await repo.importMany([
    { name: "Automatic", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" },
    { sno: 1, name: "Explicit", mobile: "02", address: "", category: "", status: "Not Called", followup: "", remarks: "" }
  ]);
  assert.deepEqual(result.imported.map(record => [record.name, record.sno]), [["Automatic", 2], ["Explicit", 1]]);
  assert.deepEqual(result.errors, []);
});

test("updateCore preserves workflow fields", async () => {
  const { repo } = makeRepo();
  const record = await repo.updateCore("a", { name: "Updated", mobile: "01", address: "Agra", category: "Store" });
  assert.equal(record.name, "Updated");
  assert.equal(record.status, "Called");
  assert.equal(record.remarks, "old");
});

test("remove deletes one record and exportAll returns the rest", async () => {
  const { repo } = makeRepo({ records: [baseLead(), baseLead({ id: "b", sno: 2 })] });
  assert.equal((await repo.remove("a")).id, "a");
  assert.equal(await repo.get("a"), null);
  assert.deepEqual((await repo.exportAll()).map(lead => lead.id), ["b"]);
});

test("a completed migration marker prevents deleted seeds from returning", async () => {
  const seedLeads = [{ sno: 1, name: "Seed", mobile: "1", address: "", category: "", status: "Not Called", followup: "", remarks: "" }];
  const { repo } = makeRepo({ records: [], seedLeads });
  await repo.ensureInitialized();
  const first = (await repo.list())[0];
  await repo.remove(first.id);
  await repo.ensureInitialized();
  assert.equal((await repo.list()).length, 0);
});

test("initialization carries legacy workflow values into full records", async () => {
  const store = createBlobFake({
    "lead-1": { status: "Interested", followup: "", remarks: "Legacy note", updatedAt: "2026-09-23T00:00:00.000Z" }
  });
  const seedLeads = [{ sno: 1, name: "Seed", mobile: "1", address: "", category: "", status: "Not Called", followup: "", remarks: "" }];
  const { repo } = makeRepo({ records: [], seedLeads, store });
  await repo.ensureInitialized();
  const migrated = (await repo.list())[0];
  assert.equal(migrated.id, "seed-1");
  assert.equal(migrated.status, "Interested");
  assert.equal(migrated.remarks, "Legacy note");
  assert.equal(migrated.updatedAt, "2026-09-23T00:00:00.000Z");
});

test("partial seed initialization retries missing records before writing the marker", async () => {
  const store = createBlobFake({ "lead/seed-1": baseLead({ id: "seed-1", sno: 1 }) });
  const seedLeads = [
    { sno: 1, name: "A", mobile: "1", address: "", category: "", status: "Not Called", followup: "", remarks: "" },
    { sno: 2, name: "B", mobile: "2", address: "", category: "", status: "Not Called", followup: "", remarks: "" }
  ];
  const { repo } = makeRepo({ records: [], seedLeads, store });
  await repo.ensureInitialized();
  assert.deepEqual((await repo.list()).map(lead => lead.sno), [1, 2]);
  assert.notEqual(await store.get("system/initialized-v2"), null);
});
