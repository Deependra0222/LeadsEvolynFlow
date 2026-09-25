import { normalizeStoredLead, validateImportRecords, validateWorkflowPatch } from "./lead-model.mjs";

const LEAD_PREFIX = "lead/";
const SERIAL_PREFIX = "serial/";
const MARKER_KEY = "system/initialized-v2";

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
  readConcurrency = 32,
  migrationConcurrency = 16
}) {
  const readLimit = Number.isInteger(readConcurrency) && readConcurrency > 0 ? readConcurrency : 32;
  const migrationLimit = Number.isInteger(migrationConcurrency) && migrationConcurrency > 0 ? migrationConcurrency : 16;

  async function list() {
    const keys = [];
    for await (const page of store.list({ prefix: LEAD_PREFIX, paginate: true })) {
      for (const { key } of page.blobs) keys.push(key);
    }
    const records = (await mapWithConcurrency(keys, readLimit, async key =>
      normalizeStoredLead(await store.get(key, { type: "json" }))
    )).filter(Boolean);
    return records.sort((left, right) => left.sno - right.sno || left.id.localeCompare(right.id));
  }

  async function get(id) {
    return normalizeStoredLead(await store.get(`${LEAD_PREFIX}${id}`, { type: "json" }));
  }

  async function updateWithRetry(id, merge) {
    const key = `${LEAD_PREFIX}${id}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.getWithMetadata(key, { type: "json" });
      if (!current) return null;
      const normalized = normalizeStoredLead(current.data);
      if (!normalized) return null;
      const next = normalizeStoredLead({ ...merge(normalized), id, updatedAt: now() });
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
    return ["name", "mobile", "address", "category"].every(field => record[field] === input[field]) &&
      (input.sno === undefined || record.sno === input.sno);
  }

  async function importMany(records, { requestId = "", sourceIndexes = [] } = {}) {
    const existing = await list();
    const used = new Set(existing.map(record => record.sno));
    const unavailableForAuto = new Set([
      ...used,
      ...records.filter(record => record.sno !== undefined).map(record => record.sno)
    ]);
    let nextSno = 1;
    const imported = [];
    const errors = [];
    for (const [index, input] of records.entries()) {
      const preferredId = requestId ? `import-${requestId}-${sourceIndexes[index] ?? index}` : "";
      let sno = input.sno;
      let reservationKey = "";
      let ownsReservation = false;
      try {
        if (preferredId) {
          const prior = await get(preferredId);
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
            const reservation = await store.setJSON(reservationKey, { claimedAt: now() }, { onlyIfNew: true });
            if (reservation.modified) {
              ownsReservation = true;
              break;
            }
            unavailableForAuto.add(sno);
            nextSno += 1;
          }
        } else {
          if (used.has(sno)) throw new RepositoryConflictError(`Serial number ${sno} already exists.`);
          reservationKey = `${SERIAL_PREFIX}${sno}`;
          const reservation = await store.setJSON(reservationKey, { claimedAt: now() }, { onlyIfNew: true });
          if (!reservation.modified) throw new RepositoryConflictError(`Serial number ${sno} already exists.`);
          ownsReservation = true;
        }
        const timestamp = now();
        const record = { ...input, sno, createdAt: timestamp, updatedAt: timestamp };
        if (!preferredId) {
          imported.push(await createRecord(record));
          used.add(sno);
          unavailableForAuto.add(sno);
          continue;
        }
        const candidate = normalizeStoredLead({ ...record, id: preferredId });
        if (!candidate) throw new Error("The new lead is invalid.");
        const write = await store.setJSON(`${LEAD_PREFIX}${preferredId}`, candidate, { onlyIfNew: true });
        if (write.modified) {
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
        if (ownsReservation) {
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
  }

  async function remove(id) {
    const record = await get(id);
    if (!record) return null;
    await store.delete(`${LEAD_PREFIX}${id}`);
    try { await store.delete(`${SERIAL_PREFIX}${record.sno}`); } catch { /* serial gaps are safer than duplicates */ }
    return record;
  }

  async function ensureInitialized() {
    if (await store.get(MARKER_KEY, { type: "json" })) return;
    const existing = await list();
    const occupied = new Set(existing.map(record => record.sno));
    const missing = [];
    for (const seed of seedLeads) {
      if (occupied.has(seed.sno)) continue;
      const validation = validateImportRecords(seed, { existingSnos: occupied });
      if (validation.errors.length) throw new Error(`Invalid seed lead ${seed.sno}.`);
      occupied.add(seed.sno);
      missing.push({ seed, validated: validation.valid[0] });
    }
    await mapWithConcurrency(missing, migrationLimit, async ({ seed, validated }) => {
      const legacy = await store.get(`lead-${seed.sno}`, { type: "json" });
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
        createdAt: timestamp,
        updatedAt: typeof legacy?.updatedAt === "string" ? legacy.updatedAt : timestamp
      });
      if (!record) throw new Error(`Could not normalize seed lead ${seed.sno}.`);
      const key = `${LEAD_PREFIX}${record.id}`;
      const write = await store.setJSON(key, record, { onlyIfNew: true });
      if (write.modified) return;
      const concurrent = normalizeStoredLead(await store.get(key, { type: "json" }));
      if (!concurrent || concurrent.sno !== seed.sno) throw new Error(`Could not initialize seed lead ${seed.sno}.`);
    });
    await store.setJSON(MARKER_KEY, { version: 2, initializedAt: now() });
  }

  return {
    ensureInitialized,
    list,
    get,
    patchWorkflow,
    importMany,
    updateCore,
    remove,
    exportAll: list
  };
}
