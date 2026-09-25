import { validateCompartmentIdentifier } from "./compartment-model.mjs";
import { deriveCity, normalizeStoredLead, validateImportRecords, validateWorkflowPatch } from "./lead-model.mjs";

const LEAD_PREFIX = "lead/";
const SERIAL_PREFIX = "serial/";
const IMPORT_REQUEST_PREFIX = "import-request/";
const V2_MARKER_KEY = "system/initialized-v2";
const V3_MARKER_KEY = "system/initialized-v3";

async function mapWithConcurrency(items, limit, operation) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

async function collectWithConcurrency(items, limit, operation) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await operation(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function retryRead(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 50));
    }
  }
  throw lastError;
}

export class RepositoryConflictError extends Error {
  constructor(message = "The lead changed while it was being saved.") {
    super(message);
    this.name = "RepositoryConflictError";
    this.code = "CONFLICT";
  }
}

export function createLeadRepository({
  store,
  seedLeads = [],
  now = () => new Date().toISOString(),
  makeId = () => crypto.randomUUID(),
  compartmentRepository = null,
  readConcurrency = 32,
  migrationConcurrency = 16
}) {
  const readLimit = Number.isInteger(readConcurrency) && readConcurrency > 0 ? readConcurrency : 32;
  const migrationLimit = Number.isInteger(migrationConcurrency) && migrationConcurrency > 0 ? migrationConcurrency : 16;

  async function listKeys(prefix) {
    return retryRead(async () => {
      const keys = [];
      for await (const page of store.list({ prefix, paginate: true })) {
        for (const { key } of page.blobs) keys.push(key);
      }
      return keys;
    });
  }

  function readBlob(key, options = { type: "json" }) {
    return retryRead(() => store.get(key, options));
  }

  async function list() {
    const keys = await listKeys(LEAD_PREFIX);
    const records = (await mapWithConcurrency(keys, readLimit, async key =>
      normalizeStoredLead(await readBlob(key))
    )).filter(Boolean);
    return records.sort((left, right) => left.sno - right.sno || left.id.localeCompare(right.id));
  }

  async function listImportIndex() {
    const [leadKeys, serialKeys] = await Promise.all([
      listKeys(LEAD_PREFIX),
      listKeys(SERIAL_PREFIX)
    ]);
    const leadIds = new Set(leadKeys.map(key => key.slice(LEAD_PREFIX.length)));
    const snos = new Set();
    const nonSeedIds = [];
    for (const id of leadIds) {
      const match = /^seed-(\d+)$/.exec(id);
      if (match && Number(match[1]) > 0) snos.add(Number(match[1]));
      else nonSeedIds.push(id);
    }
    for (const key of serialKeys) {
      const match = /^serial\/(\d+)$/.exec(key);
      if (match && Number(match[1]) > 0) snos.add(Number(match[1]));
    }
    if (nonSeedIds.length) {
      const legacyRecords = await mapWithConcurrency(nonSeedIds, readLimit, id => get(id));
      for (const record of legacyRecords) if (record) snos.add(record.sno);
    }
    return { snos, leadIds };
  }

  async function get(id) {
    return normalizeStoredLead(await readBlob(`${LEAD_PREFIX}${id}`));
  }

  async function getSerialReservation(sno) {
    const reservation = await readBlob(`${SERIAL_PREFIX}${sno}`);
    return reservation && typeof reservation === "object" ? reservation : null;
  }

  async function updateWithRetry(id, merge) {
    const key = `${LEAD_PREFIX}${id}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await retryRead(() => store.getWithMetadata(key, { type: "json" }));
      if (!current) return null;
      const normalized = normalizeStoredLead(current.data);
      if (!normalized) return null;
      const merged = merge(normalized);
      if (merged === normalized) return normalized;
      const next = normalizeStoredLead({ ...merged, id, updatedAt: now() });
      if (!next) throw new Error("The stored lead is invalid.");
      const write = await store.setJSON(key, next, { onlyIfMatch: current.etag });
      if (write.modified) return next;
    }
    throw new RepositoryConflictError();
  }

  async function patchWorkflow(id, patch) {
    return updateWithRetry(id, current => ({ ...current, ...patch }));
  }

  async function updateCore(id, core) {
    return updateWithRetry(id, current => ({ ...current, ...core }));
  }

  async function acquireMembershipLeases(compartmentIds) {
    if (!compartmentRepository) return [];
    const ids = [...new Set(compartmentIds)].sort();
    const leases = [];
    try {
      for (const id of ids) {
        if (typeof compartmentRepository.acquireWriteLease === "function") {
          leases.push(await compartmentRepository.acquireWriteLease(id));
        } else {
          await compartmentRepository.assertWritable(id);
        }
      }
      return leases;
    } catch (error) {
      await releaseMembershipLeases(leases);
      throw error;
    }
  }

  async function releaseMembershipLeases(leases) {
    if (!compartmentRepository || typeof compartmentRepository.releaseWriteLease !== "function") return;
    for (const lease of [...leases].reverse()) {
      try { await compartmentRepository.releaseWriteLease(lease); }
      catch { /* expiration lets deletion recover from an abandoned lease */ }
    }
  }

  async function createRecord(record) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = makeId();
      const candidate = normalizeStoredLead({ ...record, id });
      if (!candidate) throw new Error("The new lead is invalid.");
      const result = await store.setJSON(`${LEAD_PREFIX}${id}`, candidate, { onlyIfNew: true });
      if (result.modified) return candidate;
    }
    throw new RepositoryConflictError("Could not allocate a unique lead identifier.");
  }

  function matchesImport(record, input) {
    return ["name", "mobile", "address", "city", "category", "compartmentId"].every(field => record[field] === input[field]) &&
      (input.sno === undefined || record.sno === input.sno);
  }

  async function bindImportRequest(requestId, compartmentId) {
    if (!requestId) return;
    const key = `${IMPORT_REQUEST_PREFIX}${requestId}`;
    const binding = { requestId, compartmentId, boundAt: now() };
    try {
      const write = await store.setJSON(key, binding, { onlyIfNew: true });
      if (write.modified) return;
    } catch (error) {
      const recovered = await readBlob(key);
      if (!recovered) throw error;
    }
    const existing = await readBlob(key);
    if (existing?.requestId !== requestId || existing?.compartmentId !== compartmentId) {
      throw new RepositoryConflictError("This import request is already bound to another compartment.");
    }
  }

  async function importMany(records, { requestId = "", sourceIndexes = [], compartmentId = "existing-leads" } = {}) {
    if (!validateCompartmentIdentifier(compartmentId)) {
      return { imported: [], errors: records.map((_, index) => ({ index, field: "compartmentId", error: "Invalid destination compartment." })) };
    }
    const leases = await acquireMembershipLeases([compartmentId]);
    try {
      await bindImportRequest(requestId, compartmentId);
    const destinationRecords = records.map(input => ({
      ...input,
      city: typeof input.city === "string" && input.city.trim() ? input.city.trim() : deriveCity(input.address),
      compartmentId
    }));
    const importIndex = await listImportIndex();
    const used = new Set(importIndex.snos);
    const unavailableForAuto = new Set([
      ...used,
      ...destinationRecords.filter(record => record.sno !== undefined).map(record => record.sno)
    ]);
    let nextSno = 1;
    const imported = [];
    const errors = [];
    for (const [index, input] of destinationRecords.entries()) {
      const preferredId = requestId ? `import-${requestId}-${sourceIndexes[index] ?? index}` : "";
      let sno = input.sno;
      let reservationKey = "";
      let ownsReservation = false;
      let releaseReservationOnFailure = false;
      let commitUncertain = false;
      try {
        if (preferredId) {
          const prior = importIndex.leadIds.has(preferredId) ? await get(preferredId) : null;
          if (prior) {
            if (!matchesImport(prior, input)) throw new RepositoryConflictError("This import request was already used for different lead data.");
            imported.push(prior);
            used.add(prior.sno);
            continue;
          }
        }
        if (sno === undefined) {
          while (true) {
            while (unavailableForAuto.has(nextSno)) nextSno += 1;
            sno = nextSno;
            reservationKey = `${SERIAL_PREFIX}${sno}`;
            const reservation = await store.setJSON(reservationKey, { claimedAt: now(), ownerId: preferredId }, { onlyIfNew: true });
            if (reservation.modified) {
              ownsReservation = true;
              releaseReservationOnFailure = !preferredId;
              break;
            }
            unavailableForAuto.add(sno);
            nextSno += 1;
          }
        } else {
          reservationKey = `${SERIAL_PREFIX}${sno}`;
          const existingReservation = preferredId && used.has(sno) ? await getSerialReservation(sno) : null;
          if (existingReservation?.ownerId === preferredId) {
            ownsReservation = true;
          } else {
            if (used.has(sno)) throw new RepositoryConflictError(`Serial number ${sno} already exists.`);
            const reservation = await store.setJSON(reservationKey, { claimedAt: now(), ownerId: preferredId }, { onlyIfNew: true });
            if (!reservation.modified) throw new RepositoryConflictError(`Serial number ${sno} already exists.`);
            ownsReservation = true;
            releaseReservationOnFailure = !preferredId;
          }
        }
        const timestamp = now();
        const record = { ...input, sno, createdAt: timestamp, updatedAt: timestamp };
        if (!preferredId) {
          commitUncertain = true;
          const created = await createRecord(record);
          commitUncertain = false;
          imported.push(created);
          used.add(sno);
          unavailableForAuto.add(sno);
          continue;
        }
        const candidate = normalizeStoredLead({ ...record, id: preferredId });
        if (!candidate) throw new Error("The new lead is invalid.");
        commitUncertain = true;
        const write = await store.setJSON(`${LEAD_PREFIX}${preferredId}`, candidate, { onlyIfNew: true });
        commitUncertain = false;
        if (write.modified) {
          importIndex.leadIds.add(preferredId);
          imported.push(candidate);
          used.add(sno);
          unavailableForAuto.add(sno);
          continue;
        }
        const prior = await get(preferredId);
        if (!prior || !matchesImport(prior, input)) {
          throw new RepositoryConflictError("This import request was already used for different lead data.");
        }
        if (prior.sno !== sno && ownsReservation) {
          await store.delete(reservationKey);
          ownsReservation = false;
        }
        imported.push(prior);
        used.add(prior.sno);
        unavailableForAuto.add(prior.sno);
      } catch (error) {
        if (preferredId) {
          try {
            const committed = await get(preferredId);
            commitUncertain = false;
            if (committed && matchesImport(committed, input)) {
              if (committed.sno !== sno && ownsReservation) {
                await store.delete(reservationKey);
                ownsReservation = false;
              }
              imported.push(committed);
              used.add(committed.sno);
              unavailableForAuto.add(committed.sno);
              continue;
            }
          } catch { /* report the original write failure when recovery cannot be verified */ }
        }
        if (releaseReservationOnFailure && !commitUncertain) {
          try { await store.delete(reservationKey); } catch { /* a stale reservation is safer than a duplicate serial */ }
        }
        errors.push({
          index,
          field: error?.code === "CONFLICT" ? "sno" : "$",
          error: error?.code === "CONFLICT" ? error.message : "Could not store this lead."
        });
      }
    }
    return { imported, errors };
    } finally {
      await releaseMembershipLeases(leases);
    }
  }

  async function remove(id) {
    const record = await get(id);
    if (!record) return null;
    await store.delete(`${LEAD_PREFIX}${id}`);
    try { await store.delete(`${SERIAL_PREFIX}${record.sno}`); } catch { /* serial gaps are safer than duplicates */ }
    return record;
  }

  async function moveMany(ids, compartmentId) {
    if (!validateCompartmentIdentifier(compartmentId)) throw new Error("Invalid destination compartment.");
    const uniqueIds = [...new Set(ids)];
    const results = await collectWithConcurrency(uniqueIds, migrationLimit, async id => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await get(id);
        if (!current) return { id, missing: true };
        if (current.compartmentId === compartmentId) return { record: current, unchanged: true };
        const sourceCompartmentId = current.compartmentId;
        const leases = await acquireMembershipLeases([sourceCompartmentId, compartmentId]);
        let sourceChanged = false;
        try {
          const record = await updateWithRetry(id, latest => {
            if (latest.compartmentId !== sourceCompartmentId) {
              sourceChanged = true;
              throw new RepositoryConflictError("The lead moved concurrently.");
            }
            return { ...latest, compartmentId };
          });
          if (!record) return { id, missing: true };
          return { record, unchanged: false };
        } catch (error) {
          if (!sourceChanged) throw error;
        } finally {
          await releaseMembershipLeases(leases);
        }
      }
      throw new RepositoryConflictError("The lead kept moving between compartments.");
    });
    const moved = [];
    const unchanged = [];
    const errors = [];
    results.forEach((result, index) => {
      const id = uniqueIds[index];
      if (!result.ok) {
        errors.push({ id, error: result.error?.code === "CONFLICT" ? result.error.message : "Could not move this lead." });
      } else if (result.value.missing) {
        errors.push({ id, error: "Lead not found." });
      } else if (result.value.unchanged) {
        unchanged.push(result.value.record);
      } else {
        moved.push(result.value.record);
      }
    });
    return { moved, unchanged, errors };
  }

  async function exportCompartment(compartmentId) {
    if (!validateCompartmentIdentifier(compartmentId)) throw new Error("Invalid compartment identifier.");
    return (await list())
      .filter(record => record.compartmentId === compartmentId)
      .map(record => ({
        "Institute/Business Name": record.name,
        "Mobile Number": record.mobile,
        "Area/Address": record.address,
        "City": record.city,
        "Category": record.category,
        "Call Status": record.status,
        "Next Follow-up": record.followup,
        "Remarks": record.remarks
      }));
  }

  async function removeByCompartment(compartmentId) {
    if (!validateCompartmentIdentifier(compartmentId)) throw new Error("Invalid compartment identifier.");
    const records = (await list()).filter(record => record.compartmentId === compartmentId);
    const results = await collectWithConcurrency(records, migrationLimit, async record => {
      const current = await get(record.id);
      if (!current || current.compartmentId !== compartmentId) return null;
      return remove(record.id);
    });
    const deleted = [];
    const errors = [];
    results.forEach((result, index) => {
      const record = records[index];
      if (result.ok && result.value) deleted.push(result.value);
      else if (!result.ok) errors.push({ id: record.id, error: "Could not delete this lead." });
    });
    return { deleted, errors };
  }

  async function ensureSeedRecords(defaultCompartmentId) {
    if (await readBlob(V2_MARKER_KEY)) return;
    const existingKeys = await listKeys(LEAD_PREFIX);
    const existingRaw = await mapWithConcurrency(existingKeys, readLimit, key => readBlob(key));
    const occupied = new Set(existingRaw.map(record => record?.sno).filter(sno => Number.isInteger(sno) && sno > 0));
    const missing = [];
    for (const seed of seedLeads) {
      if (occupied.has(seed.sno)) continue;
      const validation = validateImportRecords(seed, { existingSnos: occupied });
      if (validation.errors.length) throw new Error(`Invalid seed lead ${seed.sno}.`);
      occupied.add(seed.sno);
      missing.push({ seed, validated: validation.valid[0] });
    }
    await mapWithConcurrency(missing, migrationLimit, async ({ seed, validated }) => {
      const legacy = await readBlob(`lead-${seed.sno}`);
      const workflowCandidate = {
        status: legacy?.status ?? seed.status ?? "Not Called",
        followup: legacy?.followup ?? seed.followup ?? "",
        remarks: legacy?.remarks ?? seed.remarks ?? ""
      };
      const workflow = validateWorkflowPatch(workflowCandidate);
      const timestamp = now();
      const record = normalizeStoredLead({
        ...validated,
        ...(workflow.ok ? workflow.data : {}),
        id: `seed-${seed.sno}`,
        compartmentId: defaultCompartmentId,
        createdAt: timestamp,
        updatedAt: typeof legacy?.updatedAt === "string" ? legacy.updatedAt : timestamp
      });
      if (!record) throw new Error(`Could not normalize seed lead ${seed.sno}.`);
      const key = `${LEAD_PREFIX}${record.id}`;
      const write = await store.setJSON(key, record, { onlyIfNew: true });
      if (write.modified) return;
      const concurrent = normalizeStoredLead(await readBlob(key));
      if (!concurrent || concurrent.sno !== seed.sno) throw new Error(`Could not initialize seed lead ${seed.sno}.`);
    });
    await store.setJSON(V2_MARKER_KEY, { version: 2, initializedAt: now() });
  }

  async function migrateStoredLead(key, defaultCompartmentId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await retryRead(() => store.getWithMetadata(key, { type: "json" }));
      if (!current) return;
      if (normalizeStoredLead(current.data)) return;
      const raw = current.data;
      const validation = validateImportRecords({
        sno: raw?.sno,
        name: raw?.name,
        mobile: raw?.mobile,
        address: raw?.address,
        city: typeof raw?.city === "string" && raw.city.trim() ? raw.city : deriveCity(raw?.address),
        category: raw?.category,
        status: raw?.status,
        followup: raw?.followup,
        remarks: raw?.remarks
      });
      const compartmentId = validateCompartmentIdentifier(raw?.compartmentId) || defaultCompartmentId;
      const migrated = validation.errors.length ? null : normalizeStoredLead({
        id: raw.id,
        ...validation.valid[0],
        compartmentId,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt
      });
      if (!migrated) throw new Error(`Could not migrate stored lead ${raw?.id || key}.`);
      const write = await store.setJSON(key, migrated, { onlyIfMatch: current.etag });
      if (write.modified) return;
    }
    throw new RepositoryConflictError("A lead kept changing during migration.");
  }

  async function ensureInitialized({ defaultCompartmentId = "existing-leads" } = {}) {
    if (!validateCompartmentIdentifier(defaultCompartmentId)) throw new Error("Invalid default compartment identifier.");
    await ensureSeedRecords(defaultCompartmentId);
    if (await readBlob(V3_MARKER_KEY)) return;
    const keys = await listKeys(LEAD_PREFIX);
    await mapWithConcurrency(keys, migrationLimit, key => migrateStoredLead(key, defaultCompartmentId));
    await store.setJSON(V3_MARKER_KEY, { version: 3, initializedAt: now() });
  }

  async function isInitialized() {
    return Boolean(await readBlob(V3_MARKER_KEY));
  }

  return {
    isInitialized,
    ensureInitialized,
    list,
    listImportIndex,
    get,
    getSerialReservation,
    patchWorkflow,
    importMany,
    moveMany,
    exportCompartment,
    removeByCompartment,
    updateCore,
    remove,
    exportAll: list
  };
}
