const WORKFLOW_FIELDS = ["status", "followup", "remarks"];

export function matchesLead(lead, query, status) {
  const haystack = `${lead.sno} ${lead.name} ${lead.mobile} ${lead.address} ${lead.city || ""} ${lead.category}`.toLowerCase();
  return (!query || haystack.includes(query)) && (!status || lead.status === status);
}

function normalizedFacetValue(value) {
  const display = String(value || "").trim() || "Unknown";
  return { display, key: display.toLocaleLowerCase("en-IN") };
}

function normalizedSet(values) {
  return new Set([...(values || [])].map(value => normalizedFacetValue(value).key));
}

function leadOrder(left, right) {
  return left.sno - right.sno || String(left.id).localeCompare(String(right.id));
}

export function sortLeadsByArea(leads, mode) {
  const sorted = [...leads];
  if (mode !== "area-asc" && mode !== "area-desc") return sorted;
  const direction = mode === "area-desc" ? -1 : 1;
  return sorted.sort((left, right) => {
    const leftArea = String(left.address || "").trim();
    const rightArea = String(right.address || "").trim();
    if (!leftArea || !rightArea) {
      if (!leftArea && !rightArea) return leadOrder(left, right);
      return leftArea ? -1 : 1;
    }
    const areaOrder = leftArea.localeCompare(rightArea, undefined, { sensitivity: "base", numeric: true });
    return areaOrder ? areaOrder * direction : leadOrder(left, right);
  });
}

export function filterAndSortLeads(leads, {
  query = "",
  status = "",
  compartmentId = "",
  cities = new Set(),
  categories = new Set(),
  sortMode = ""
} = {}) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const cityKeys = normalizedSet(cities);
  const categoryKeys = normalizedSet(categories);
  return sortLeadsByArea(
    leads.filter(lead => matchesLead(lead, normalizedQuery, status) &&
      (!compartmentId || lead.compartmentId === compartmentId) &&
      (!cityKeys.size || cityKeys.has(normalizedFacetValue(lead.city).key)) &&
      (!categoryKeys.size || categoryKeys.has(normalizedFacetValue(lead.category).key))),
    sortMode
  );
}

function buildFacet(leads, field) {
  const values = new Map();
  for (const lead of leads) {
    const normalized = normalizedFacetValue(lead[field]);
    const current = values.get(normalized.key);
    if (current) current.count += 1;
    else values.set(normalized.key, { value: normalized.display, count: 1 });
  }
  return [...values.values()].sort((left, right) =>
    left.value.localeCompare(right.value, "en-IN", { sensitivity: "base", numeric: true })
  );
}

export function buildLeadFacets(leads, compartments = []) {
  const counts = new Map();
  for (const lead of leads) counts.set(lead.compartmentId, (counts.get(lead.compartmentId) || 0) + 1);
  return {
    cities: buildFacet(leads, "city"),
    categories: buildFacet(leads, "category"),
    compartments: compartments.map(compartment => ({
      ...compartment,
      count: counts.get(compartment.id) || 0
    }))
  };
}

export function createRangeSelection() {
  const selected = new Set();
  let anchorIndex = null;
  return {
    toggle(id, index, shiftKey, visibleIds) {
      const key = String(id);
      if (!shiftKey || anchorIndex === null || !Array.isArray(visibleIds)) {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        anchorIndex = index;
        return;
      }
      const desiredSelected = !selected.has(key);
      const start = Math.max(0, Math.min(anchorIndex, index));
      const end = Math.min(visibleIds.length - 1, Math.max(anchorIndex, index));
      for (let current = start; current <= end; current += 1) {
        const visibleId = String(visibleIds[current]);
        if (desiredSelected) selected.add(visibleId);
        else selected.delete(visibleId);
      }
    },
    ids() { return [...selected]; },
    clear() {
      selected.clear();
      anchorIndex = null;
    }
  };
}

export function createLeadState() {
  const confirmed = new Map();
  const drafts = new Map();

  function sortRecords(records) {
    return records.sort((left, right) => left.sno - right.sno || left.id.localeCompare(right.id));
  }

  return {
    replaceLeads(leads) {
      confirmed.clear();
      for (const lead of leads) confirmed.set(String(lead.id), { ...lead });
    },

    allLeads() {
      return sortRecords([...confirmed.values()].map(lead => ({ ...lead })));
    },

    valuesFor(id) {
      const key = String(id);
      const lead = confirmed.get(key);
      return lead ? { ...lead, ...(drafts.get(key) || {}) } : null;
    },

    rememberDraft(id, patch) {
      const key = String(id);
      const allowed = {};
      for (const field of WORKFLOW_FIELDS) if (field in patch) allowed[field] = patch[field];
      drafts.set(key, { ...(drafts.get(key) || {}), ...allowed });
    },

    rememberInput(id, field, value) {
      if (!WORKFLOW_FIELDS.includes(field)) return;
      const key = String(id);
      drafts.set(key, { ...(drafts.get(key) || {}), [field]: value });
    },

    changedWorkflow(id) {
      const key = String(id);
      const lead = confirmed.get(key);
      const draft = drafts.get(key) || {};
      if (!lead) return {};
      return Object.fromEntries(WORKFLOW_FIELDS.filter(field => field in draft && draft[field] !== lead[field]).map(field => [field, draft[field]]));
    },

    confirmSaved(record) {
      const key = String(record.id);
      confirmed.set(key, { ...record });
      const draft = drafts.get(key);
      if (!draft) return;
      const remaining = { ...draft };
      for (const field of WORKFLOW_FIELDS) {
        if (field in remaining && remaining[field] === record[field]) delete remaining[field];
      }
      if (Object.keys(remaining).length) drafts.set(key, remaining);
      else drafts.delete(key);
    },

    upsertLead(record) {
      confirmed.set(String(record.id), { ...record });
    },

    removeLead(id) {
      const key = String(id);
      confirmed.delete(key);
      drafts.delete(key);
    }
  };
}
