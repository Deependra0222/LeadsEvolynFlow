import { createHash } from "node:crypto";
import {
  normalizeCompartmentName,
  normalizeStoredCompartment,
  validateCompartmentIdentifier
} from "./compartment-model.mjs";

const COMPARTMENT_PREFIX = "compartment/";
const NAME_PREFIX = "compartment-name/";
const DELETE_PREFIX = "compartment-delete/";
const EXISTING_ID = "existing-leads";
const EXISTING_NAME = "Existing Leads";

function conflict(message) {
  const error = new Error(message);
  error.code = "CONFLICT";
  return error;
}

function nameClaimKey(normalizedKey) {
  return `${NAME_PREFIX}${createHash("sha256").update(normalizedKey).digest("hex")}`;
}

export function createCompartmentRepository({
  store,
  now = () => new Date().toISOString(),
  makeId = () => crypto.randomUUID()
}) {
  async function get(id) {
    if (!validateCompartmentIdentifier(id)) return null;
    return normalizeStoredCompartment(await store.get(`${COMPARTMENT_PREFIX}${id}`, { type: "json" }));
  }

  async function list() {
    const keys = [];
    for await (const page of store.list({ prefix: COMPARTMENT_PREFIX, paginate: true })) {
      for (const blob of page.blobs) keys.push(blob.key);
    }
    const records = (await Promise.all(keys.map(key => store.get(key, { type: "json" }))))
      .map(normalizeStoredCompartment)
      .filter(Boolean);
    return records.sort((left, right) => left.name.localeCompare(right.name, "en-IN", { sensitivity: "base" }));
  }

  async function claimName(normalized, compartmentId) {
    const key = nameClaimKey(normalized.key);
    const result = await store.setJSON(key, { compartmentId, name: normalized.name, claimedAt: now() }, { onlyIfNew: true });
    if (result.modified) return { key, created: true };
    const existing = await store.get(key, { type: "json" });
    if (existing?.compartmentId === compartmentId) return { key, created: false };
    throw conflict("A compartment with this name already exists.");
  }

  async function ensureExistingLeads() {
    const existing = await get(EXISTING_ID);
    if (existing) return existing;
    const normalized = normalizeCompartmentName(EXISTING_NAME);
    await claimName(normalized, EXISTING_ID);
    const timestamp = now();
    const record = { id: EXISTING_ID, name: normalized.name, createdAt: timestamp, updatedAt: timestamp };
    const write = await store.setJSON(`${COMPARTMENT_PREFIX}${EXISTING_ID}`, record, { onlyIfNew: true });
    if (write.modified) return record;
    const concurrent = await get(EXISTING_ID);
    if (concurrent) return concurrent;
    throw conflict("Could not create the Existing Leads compartment.");
  }

  async function create(name) {
    const normalized = normalizeCompartmentName(name);
    if (!normalized.ok) throw Object.assign(new Error(normalized.error), { code: "VALIDATION" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = validateCompartmentIdentifier(makeId());
      if (!id) throw new Error("Could not allocate a valid compartment identifier.");
      const claim = await claimName(normalized, id);
      const timestamp = now();
      const record = { id, name: normalized.name, createdAt: timestamp, updatedAt: timestamp };
      const write = await store.setJSON(`${COMPARTMENT_PREFIX}${id}`, record, { onlyIfNew: true });
      if (write.modified) return record;
      if (claim.created) await store.delete(claim.key);
    }
    throw conflict("Could not allocate a unique compartment identifier.");
  }

  async function rename(id, name) {
    if (!validateCompartmentIdentifier(id)) return null;
    const normalized = normalizeCompartmentName(name);
    if (!normalized.ok) throw Object.assign(new Error(normalized.error), { code: "VALIDATION" });
    const key = `${COMPARTMENT_PREFIX}${id}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.getWithMetadata(key, { type: "json" });
      if (!current) return null;
      const record = normalizeStoredCompartment(current.data);
      if (!record) throw new Error("The stored compartment is invalid.");
      const previous = normalizeCompartmentName(record.name);
      const sameClaim = previous.key === normalized.key;
      const claim = sameClaim ? { key: nameClaimKey(previous.key), created: false } : await claimName(normalized, id);
      const next = { ...record, name: normalized.name, updatedAt: now() };
      const write = await store.setJSON(key, next, { onlyIfMatch: current.etag });
      if (write.modified) {
        if (!sameClaim) await store.delete(nameClaimKey(previous.key));
        return next;
      }
      if (!sameClaim && claim.created) await store.delete(claim.key);
    }
    throw conflict("The compartment changed while it was being renamed.");
  }

  async function beginDelete(id) {
    const compartment = await get(id);
    if (!compartment) return null;
    await store.setJSON(`${DELETE_PREFIX}${id}`, { compartmentId: id, startedAt: now() }, { onlyIfNew: true });
    return compartment;
  }

  async function isDeleting(id) {
    if (!validateCompartmentIdentifier(id)) return false;
    return Boolean(await store.get(`${DELETE_PREFIX}${id}`, { type: "json" }));
  }

  async function assertWritable(id) {
    const compartment = await get(id);
    if (!compartment) {
      const error = new Error("Compartment not found.");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (await isDeleting(id)) {
      const error = new Error("This compartment is currently deleting.");
      error.code = "CONFLICT";
      throw error;
    }
    return compartment;
  }

  async function finishDelete(id) {
    const compartment = await get(id);
    if (compartment) {
      const normalized = normalizeCompartmentName(compartment.name);
      await store.delete(`${COMPARTMENT_PREFIX}${id}`);
      if (normalized.ok) await store.delete(nameClaimKey(normalized.key));
    }
    await store.delete(`${DELETE_PREFIX}${id}`);
  }

  return { ensureExistingLeads, list, get, create, rename, beginDelete, finishDelete, isDeleting, assertWritable };
}
