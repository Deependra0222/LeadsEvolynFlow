import test from "node:test";
import assert from "node:assert/strict";
import { createCompartmentRepository } from "../netlify/lib/compartment-repository.mjs";

const NOW = "2026-09-25T00:00:00.000Z";

function createBlobFake(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const etags = new Map([...values.keys()].map((key, index) => [key, `e${index + 1}`]));
  let sequence = etags.size;
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async getWithMetadata(key) {
      if (!values.has(key)) return null;
      return { data: structuredClone(values.get(key)), metadata: {}, etag: etags.get(key) };
    },
    async *list({ prefix }) {
      yield { blobs: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), directories: [] };
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfNew && values.has(key)) return { modified: false };
      if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) return { modified: false };
      values.set(key, structuredClone(value));
      etags.set(key, `e${++sequence}`);
      return { modified: true, etag: etags.get(key) };
    },
    async delete(key) { values.delete(key); etags.delete(key); }
  };
}

function makeRepository(store = createBlobFake()) {
  let id = 0;
  return createCompartmentRepository({ store, now: () => NOW, makeId: () => `room-${++id}` });
}

test("existing leads compartment is stable and renamable", async () => {
  const repository = makeRepository();
  const first = await repository.ensureExistingLeads();
  const second = await repository.ensureExistingLeads();
  assert.equal(first.id, "existing-leads");
  assert.deepEqual(second, first);

  const renamed = await repository.rename(first.id, "Imported Archive");
  assert.equal(renamed.name, "Imported Archive");
  assert.equal((await repository.get(first.id)).id, "existing-leads");
});

test("concurrent normalized-name claims allow only one compartment", async () => {
  const repository = makeRepository();
  const [left, right] = await Promise.allSettled([
    repository.create(" Jaipur Leads "),
    repository.create("jaipur leads")
  ]);
  assert.equal([left, right].filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await repository.list()).length, 1);
});

test("deletion markers can be resumed and cleared", async () => {
  const repository = makeRepository();
  const compartment = await repository.create("Temporary");
  await repository.beginDelete(compartment.id);
  assert.equal(await repository.isDeleting(compartment.id), true);
  await repository.finishDelete(compartment.id);
  assert.equal(await repository.isDeleting(compartment.id), false);
  assert.equal(await repository.get(compartment.id), null);
});

test("a deleting compartment rejects new writes", async () => {
  const repository = makeRepository();
  const compartment = await repository.create("Temporary");
  await repository.assertWritable(compartment.id);
  await repository.beginDelete(compartment.id);
  await assert.rejects(() => repository.assertWritable(compartment.id), /deleting/i);
  await assert.rejects(() => repository.assertWritable("missing"), /not found/i);
});
