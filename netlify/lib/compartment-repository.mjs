import { createHash } from "node:crypto";
import {
  normalizeCompartmentName,
  normalizeStoredCompartment,
  validateCompartmentIdentifier
} from "./compartment-model.mjs";

const COMPARTMENT_PREFIX = "compartment/";
const NAME_PREFIX = "compartment-name/";
const DELETE_PREFIX = "compartment-delete/";
const WRITE_PREFIX = "compartment-write/";
const WRITE_LEASE_MS = 10 * 60 * 1000;
const NAME_CLAIM_PENDING_MS = 10 * 60 * 1000;
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
  makeId = () => crypto.randomUUID(),
  makeClaimId = () => crypto.randomUUID(),
  makeLeaseId = () => crypto.randomUUID()
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
    const claimedAt = now();
    const claim = {
      compartmentId,
      name: normalized.name,
      claimId: makeClaimId(),
      state: "pending",
      claimedAt,
      expiresAt: new Date(Date.parse(claimedAt) + NAME_CLAIM_PENDING_MS).toISOString()
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await store.setJSON(key, claim, { onlyIfNew: true });
      if (result.modified) return { key, claimId: claim.claimId, created: true };
      const current = await store.getWithMetadata(key, { type: "json" });
      if (!current) continue;
      const existing = current.data;
      if (existing?.compartmentId === compartmentId) {
        return { key, claimId: existing.claimId || "", created: false };
      }
      const owner = await get(existing?.compartmentId);
      const ownerName = owner ? normalizeCompartmentName(owner.name) : null;
      if (ownerName?.ok && ownerName.key === normalized.key) {
        throw conflict("A compartment with this name already exists.");
      }
      const expiresAt = Date.parse(existing?.expiresAt);
      if (existing?.state === "pending" && (!Number.isFinite(expiresAt) || expiresAt > Date.parse(now()))) {
        throw conflict("A compartment with this name already exists.");
      }
      const replaced = await store.setJSON(key, claim, { onlyIfMatch: current.etag });
      if (replaced.modified) return { key, claimId: claim.claimId, created: true };
    }
    throw conflict("The compartment name changed concurrently. Please retry.");
  }

  async function commitNameClaim(claim, compartmentId) {
    if (!claim?.key) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.getWithMetadata(claim.key, { type: "json" });
      if (!current || current.data?.compartmentId !== compartmentId) return;
      if (current.data.state === "committed") return;
      if (claim.claimId && current.data.claimId && current.data.claimId !== claim.claimId) return;
      const write = await store.setJSON(claim.key, {
        ...current.data,
        state: "committed",
        committedAt: now()
      }, { onlyIfMatch: current.etag });
      if (write.modified) return;
    }
  }

  async function ensureExistingLeads() {
    const existing = await get(EXISTING_ID);
    if (existing) return existing;
    const normalized = normalizeCompartmentName(EXISTING_NAME);
    const claim = await claimName(normalized, EXISTING_ID);
    const timestamp = now();
    const record = { id: EXISTING_ID, name: normalized.name, createdAt: timestamp, updatedAt: timestamp };
    const write = await store.setJSON(`${COMPARTMENT_PREFIX}${EXISTING_ID}`, record, { onlyIfNew: true });
    if (write.modified) {
      await commitNameClaim(claim, EXISTING_ID);
      return record;
    }
    const concurrent = await get(EXISTING_ID);
    if (concurrent) {
      await commitNameClaim(claim, EXISTING_ID);
      return concurrent;
    }
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
      if (write.modified) {
        await commitNameClaim(claim, id);
        return record;
      }
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
      const claim = await claimName(normalized, id);
      if (sameClaim) {
        await commitNameClaim(claim, id);
        return record;
      }
      const next = { ...record, name: normalized.name, updatedAt: now() };
      const write = await store.setJSON(key, next, { onlyIfMatch: current.etag });
      if (write.modified) {
        await commitNameClaim(claim, id);
        return next;
      }
    }
    throw conflict("The compartment changed while it was being renamed.");
  }

  async function beginDelete(id) {
    const compartment = await get(id);
    if (!compartment) return null;
    const normalized = normalizeCompartmentName(compartment.name);
    await store.setJSON(`${DELETE_PREFIX}${id}`, {
      compartmentId: id,
      name: compartment.name,
      claimKey: normalized.ok ? nameClaimKey(normalized.key) : "",
      startedAt: now()
    }, { onlyIfNew: true });
    return compartment;
  }

  async function getDeletion(id) {
    if (!validateCompartmentIdentifier(id)) return null;
    const record = await store.get(`${DELETE_PREFIX}${id}`, { type: "json" });
    return record && record.compartmentId === id && typeof record.name === "string" ? record : null;
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

  async function acquireWriteLease(id) {
    await assertWritable(id);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const leaseId = validateCompartmentIdentifier(makeLeaseId());
      if (!leaseId) throw new Error("Could not allocate a valid write lease.");
      const key = `${WRITE_PREFIX}${id}/${leaseId}`;
      const startedAt = now();
      const expiresAt = new Date(Date.parse(startedAt) + WRITE_LEASE_MS).toISOString();
      const write = await store.setJSON(key, { compartmentId: id, leaseId, startedAt, expiresAt }, { onlyIfNew: true });
      if (!write.modified) continue;
      try {
        await assertWritable(id);
        return { key, compartmentId: id, leaseId };
      } catch (error) {
        await store.delete(key);
        throw error;
      }
    }
    throw conflict("Could not reserve this compartment for lead changes.");
  }

  async function releaseWriteLease(lease) {
    if (lease?.key) await store.delete(lease.key);
  }

  async function assertDeleteReady(id) {
    const prefix = `${WRITE_PREFIX}${id}/`;
    const currentTime = Date.parse(now());
    const active = [];
    for await (const page of store.list({ prefix, paginate: true })) {
      for (const blob of page.blobs) {
        const lease = await store.get(blob.key, { type: "json" });
        if (!lease) continue;
        if (Date.parse(lease.expiresAt) <= currentTime) await store.delete(blob.key);
        else active.push(blob.key);
      }
    }
    if (active.length) throw conflict("This compartment still has active lead changes. Retry deletion shortly.");
  }

  async function finishDelete(id) {
    const compartment = await get(id);
    if (compartment) {
      await store.delete(`${COMPARTMENT_PREFIX}${id}`);
    }
    await store.delete(`${DELETE_PREFIX}${id}`);
  }

  return {
    ensureExistingLeads,
    list,
    get,
    create,
    rename,
    beginDelete,
    getDeletion,
    finishDelete,
    isDeleting,
    assertWritable,
    acquireWriteLease,
    releaseWriteLease,
    assertDeleteReady
  };
}
