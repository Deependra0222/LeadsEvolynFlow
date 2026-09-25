import test from "node:test";
import assert from "node:assert/strict";
import { createLeadRepository } from "../netlify/lib/lead-repository.mjs";

const NOW = "2026-09-24T05:00:00.000Z";
const baseLead = (overrides = {}) => ({
  id: "a", sno: 1, name: "A", mobile: "1", address: "", city: "Unknown", category: "",
  status: "Called", followup: "", remarks: "old",
  compartmentId: "existing-leads", createdAt: NOW, updatedAt: NOW, ...overrides
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

function makeRepo({ records = [baseLead()], seedLeads = [], ids = ["new-a", "new-b"], store, repositoryOptions = {} } = {}) {
  const blob = store || createBlobFake(Object.fromEntries(records.map(record => [`lead/${record.id}`, record])));
  let idIndex = 0;
  return {
    blob,
    repo: createLeadRepository({ store: blob, seedLeads, now: () => NOW, makeId: () => ids[idIndex++], ...repositoryOptions })
  };
}

test("list returns normalized records sorted by serial", async () => {
  const { repo } = makeRepo({ records: [baseLead({ id: "b", sno: 2 }), baseLead({ id: "a", sno: 1 })] });
  assert.deepEqual((await repo.list()).map(lead => lead.id), ["a", "b"]);
});

test("list reads lead blobs concurrently without exceeding its limit", async () => {
  const records = [1, 2, 3, 4].map(sno => baseLead({ id: `lead-${sno}`, sno }));
  const store = createBlobFake(Object.fromEntries(records.map(record => [`lead/${record.id}`, record])));
  const get = store.get.bind(store);
  let active = 0;
  let maximum = 0;
  store.get = async (...args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    try { return await get(...args); }
    finally { active -= 1; }
  };
  const { repo } = makeRepo({ records: [], store, repositoryOptions: { readConcurrency: 2 } });

  assert.deepEqual((await repo.list()).map(record => record.sno), [1, 2, 3, 4]);
  assert.equal(maximum, 2);
});

test("import index derives serials from keys without downloading lead blobs", async () => {
  const store = createBlobFake({
    "lead/seed-1": baseLead({ id: "seed-1", sno: 1 }),
    "serial/9": { claimedAt: NOW }
  });
  store.get = async () => { throw new Error("lead contents must not be downloaded"); };
  const { repo } = makeRepo({ records: [], store });

  const index = await repo.listImportIndex();

  assert.deepEqual([...index.snos].sort((a, b) => a - b), [1, 9]);
  assert.deepEqual([...index.leadIds], ["seed-1"]);
});

test("a stale reservation cannot hide an unreserved non-seed lead from the import index", async () => {
  const store = createBlobFake({
    "lead/orphan": baseLead({ id: "orphan", sno: 7 }),
    "serial/99": { claimedAt: NOW }
  });
  const { repo } = makeRepo({ records: [], store });

  const index = await repo.listImportIndex();

  assert.deepEqual([...index.snos].sort((a, b) => a - b), [7, 99]);
});

test("an import ID without its reservation is still included in the import index", async () => {
  const store = createBlobFake({
    "lead/import-request_123-0": baseLead({ id: "import-request_123-0", sno: 7 })
  });
  const { repo } = makeRepo({ records: [], store });

  const index = await repo.listImportIndex();

  assert.deepEqual([...index.snos], [7]);
});

test("list retries a transient Blob read failure", async () => {
  const store = createBlobFake({ "lead/a": baseLead() });
  const get = store.get.bind(store);
  let attempts = 0;
  store.get = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary Blob failure");
    return get(...args);
  };
  const { repo } = makeRepo({ records: [], store });

  assert.deepEqual((await repo.list()).map(record => record.id), ["a"]);
  assert.equal(attempts, 2);
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

test("an uncertain committed lead write keeps its serial reservation when recovery reads fail", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  const get = store.get.bind(store);
  let interrupted = false;
  let failedRecoveryReads = 0;
  store.setJSON = async (key, value, options) => {
    const result = await setJSON(key, value, options);
    if (!interrupted && key.startsWith("lead/")) {
      interrupted = true;
      throw new Error("response was lost after commit");
    }
    return result;
  };
  store.get = async (key, options) => {
    if (key.startsWith("lead/import-") && failedRecoveryReads < 3) {
      failedRecoveryReads += 1;
      throw new Error("temporary recovery read failure");
    }
    return get(key, options);
  };
  const { repo } = makeRepo({ records: [], store });
  const row = { name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" };

  const result = await repo.importMany([row], { requestId: "request_uncertain", sourceIndexes: [0] });

  assert.equal(result.errors.length, 1);
  assert.notEqual(await store.get("serial/1"), null);
});

test("a conclusively uncommitted lead write retains its owned serial for a safe retry", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  let failLeadOnce = true;
  store.setJSON = async (key, value, options) => {
    if (failLeadOnce && key.startsWith("lead/")) {
      failLeadOnce = false;
      throw new Error("lead write failed before commit");
    }
    return setJSON(key, value, options);
  };
  const { repo } = makeRepo({ records: [], store });
  const row = { sno: 7, name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" };

  const first = await repo.importMany([row], { requestId: "request_release", sourceIndexes: [0] });
  const reservationAfterFailure = await store.get("serial/7");
  const retry = await repo.importMany([row], { requestId: "request_release", sourceIndexes: [0] });

  assert.equal(first.errors.length, 1);
  assert.equal(reservationAfterFailure.ownerId, "import-request_release-0");
  assert.equal(retry.imported[0].sno, 7);
});

test("an uncertain uncommitted explicit import can reclaim its owned reservation", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  const get = store.get.bind(store);
  let failLeadOnce = true;
  let failedRecoveryReads = 0;
  store.setJSON = async (key, value, options) => {
    if (failLeadOnce && key.startsWith("lead/")) {
      failLeadOnce = false;
      throw new Error("lead write outcome is unknown");
    }
    return setJSON(key, value, options);
  };
  store.get = async (key, options) => {
    if (key.startsWith("lead/import-") && failedRecoveryReads < 3) {
      failedRecoveryReads += 1;
      throw new Error("recovery read unavailable");
    }
    return get(key, options);
  };
  const { repo } = makeRepo({ records: [], store });
  const row = { sno: 7, name: "A", mobile: "01", address: "", category: "", status: "Not Called", followup: "", remarks: "" };

  const first = await repo.importMany([row], { requestId: "request_reclaim", sourceIndexes: [0] });
  const retry = await repo.importMany([row], { requestId: "request_reclaim", sourceIndexes: [0] });

  assert.equal(first.errors.length, 1);
  assert.equal(retry.imported[0].sno, 7);
  assert.deepEqual(retry.errors, []);
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

test("seed initialization writes missing records concurrently without exceeding its limit", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  let active = 0;
  let maximum = 0;
  store.setJSON = async (key, value, options) => {
    if (!key.startsWith("lead/")) return setJSON(key, value, options);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    try { return await setJSON(key, value, options); }
    finally { active -= 1; }
  };
  const seedLeads = [1, 2, 3, 4].map(sno => ({
    sno, name: `Seed ${sno}`, mobile: String(sno), address: "", category: "",
    status: "Not Called", followup: "", remarks: ""
  }));
  const { repo } = makeRepo({
    records: [], seedLeads, store,
    repositoryOptions: { migrationConcurrency: 2 }
  });

  await repo.ensureInitialized();

  assert.equal(maximum, 2);
  assert.deepEqual((await repo.list()).map(lead => lead.sno), [1, 2, 3, 4]);
  assert.notEqual(await store.get("system/initialized-v2"), null);
});

test("simultaneous seed initializers converge on one complete data set", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  store.setJSON = async (key, value, options) => {
    if (key.startsWith("lead/")) await new Promise(resolve => setTimeout(resolve, 5));
    return setJSON(key, value, options);
  };
  const seedLeads = [1, 2, 3, 4].map(sno => ({
    sno, name: `Seed ${sno}`, mobile: String(sno), address: "", category: "",
    status: "Not Called", followup: "", remarks: ""
  }));
  const first = makeRepo({ records: [], seedLeads, store, repositoryOptions: { migrationConcurrency: 2 } }).repo;
  const second = makeRepo({ records: [], seedLeads, store, repositoryOptions: { migrationConcurrency: 2 } }).repo;

  await Promise.all([first.ensureInitialized(), second.ensureInitialized()]);

  assert.deepEqual((await first.list()).map(lead => lead.sno), [1, 2, 3, 4]);
  assert.notEqual(await store.get("system/initialized-v2"), null);
});

test("failed seed initialization leaves no marker and a retry completes missing records", async () => {
  const store = createBlobFake({});
  const setJSON = store.setJSON.bind(store);
  let failOnce = true;
  store.setJSON = async (key, value, options) => {
    if (key === "lead/seed-2" && failOnce) {
      failOnce = false;
      throw new Error("temporary write failure");
    }
    return setJSON(key, value, options);
  };
  const seedLeads = [1, 2, 3, 4].map(sno => ({
    sno, name: `Seed ${sno}`, mobile: String(sno), address: "", category: "",
    status: "Not Called", followup: "", remarks: ""
  }));
  const { repo } = makeRepo({
    records: [], seedLeads, store,
    repositoryOptions: { migrationConcurrency: 2 }
  });

  await assert.rejects(repo.ensureInitialized(), /temporary write failure/);
  assert.equal(await store.get("system/initialized-v2"), null);

  await repo.ensureInitialized();

  assert.deepEqual((await repo.list()).map(lead => lead.sno), [1, 2, 3, 4]);
  assert.notEqual(await store.get("system/initialized-v2"), null);
});

test("version-3 migration preserves workflow data and assigns derived city and compartment", async () => {
  const store = createBlobFake({
    "system/initialized-v2": { version: 2, initializedAt: NOW },
    "lead/seed-1": {
      id: "seed-1", sno: 1, name: "Legacy", mobile: "1",
      address: "12 Main Road, Agra, UP", category: "Store",
      status: "Interested", followup: "", remarks: "legacy note",
      createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z"
    }
  });
  const { repo } = makeRepo({ records: [], store });

  await repo.ensureInitialized({ defaultCompartmentId: "existing-leads" });

  const migrated = await repo.get("seed-1");
  assert.equal(migrated.compartmentId, "existing-leads");
  assert.equal(migrated.city, "Agra");
  assert.equal(migrated.remarks, "legacy note");
  assert.equal(migrated.updatedAt, "2026-09-23T00:00:00.000Z");
  assert.notEqual(await store.get("system/initialized-v3"), null);
});

test("ambiguous legacy address becomes Unknown without changing existing data", async () => {
  const before = {
    id: "a", sno: 7, name: "Private", mobile: "7", address: "Private Address", category: "",
    status: "Called", followup: "", remarks: "keep me",
    createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z"
  };
  const store = createBlobFake({
    "system/initialized-v2": { version: 2, initializedAt: NOW },
    "lead/a": before
  });
  const { repo } = makeRepo({ records: [], store });

  await repo.ensureInitialized({ defaultCompartmentId: "existing-leads" });

  const after = await repo.get("a");
  assert.equal(after.city, "Unknown");
  assert.equal(after.compartmentId, "existing-leads");
  assert.deepEqual(
    Object.fromEntries(Object.entries(after).filter(([key]) => !["city", "compartmentId"].includes(key))),
    before
  );
});

test("import replay cannot silently change its destination compartment", async () => {
  const store = createBlobFake({});
  const { repo } = makeRepo({ records: [], store });
  const rows = [{ name: "A", mobile: "01", address: "Jaipur, RJ", category: "", status: "Not Called", followup: "", remarks: "" }];
  const first = await repo.importMany(rows, {
    requestId: "request_room",
    sourceIndexes: [0],
    compartmentId: "room-a"
  });
  const retry = await repo.importMany(rows, {
    requestId: "request_room",
    sourceIndexes: [0],
    compartmentId: "room-b"
  });

  assert.equal(first.imported[0].compartmentId, "room-a");
  assert.equal(retry.imported.length, 0);
  assert.match(retry.errors[0].error, /different lead data/i);
});
