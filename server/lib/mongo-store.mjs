import { randomUUID } from "node:crypto";

// A small key/value store on top of one MongoDB collection. Each entry is one
// document: { _id: key, value: <JSON>, etag, updatedAt }. The repositories only
// rely on this interface, so the same code runs on MongoDB Atlas in production
// and on the local file store during development and tests.

const DUPLICATE_KEY = 11000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixFilter(prefix) {
  return prefix ? { _id: { $regex: `^${escapeRegex(prefix)}` } } : {};
}

function toJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createMongoStore({ collection, makeEtag = () => randomUUID(), now = () => new Date() }) {
  const resolveCollection = typeof collection === "function" ? collection : async () => collection;

  async function get(key) {
    const docs = await resolveCollection();
    const doc = await docs.findOne({ _id: key }, { projection: { value: 1 } });
    return doc ? doc.value ?? null : null;
  }

  async function getWithMetadata(key) {
    const docs = await resolveCollection();
    const doc = await docs.findOne({ _id: key }, { projection: { value: 1, etag: 1 } });
    return doc ? { data: doc.value ?? null, etag: doc.etag, metadata: {} } : null;
  }

  async function setJSON(key, value, options = {}) {
    const docs = await resolveCollection();
    const data = toJsonValue(value);
    const etag = makeEtag();
    const fields = { value: data, etag, updatedAt: now() };
    if (options.onlyIfNew) {
      try {
        await docs.insertOne({ _id: key, ...fields });
        return { modified: true, etag };
      } catch (error) {
        if (error?.code === DUPLICATE_KEY) return { modified: false };
        throw error;
      }
    }
    if (options.onlyIfMatch) {
      const result = await docs.updateOne({ _id: key, etag: options.onlyIfMatch }, { $set: fields });
      return result.matchedCount === 1 ? { modified: true, etag } : { modified: false };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await docs.replaceOne({ _id: key }, fields, { upsert: true });
        return { modified: true, etag };
      } catch (error) {
        // Two concurrent upserts of a new key can race on the unique _id index.
        if (error?.code !== DUPLICATE_KEY || attempt === 1) throw error;
      }
    }
    return { modified: false };
  }

  async function remove(key) {
    const docs = await resolveCollection();
    await docs.deleteOne({ _id: key });
  }

  async function* list({ prefix = "" } = {}) {
    const docs = await resolveCollection();
    const found = await docs.find(prefixFilter(prefix), { projection: { _id: 1, etag: 1 } }).toArray();
    yield { blobs: found.map(doc => ({ key: doc._id, etag: doc.etag })), directories: [] };
  }

  // Reads every entry under a prefix in one query instead of one read per key.
  async function listJSON(prefix = "") {
    const docs = await resolveCollection();
    const found = await docs.find(prefixFilter(prefix), { projection: { _id: 1, value: 1 } }).toArray();
    return found.map(doc => ({ key: doc._id, data: doc.value ?? null }));
  }

  return { get, getWithMetadata, setJSON, delete: remove, list, listJSON };
}
