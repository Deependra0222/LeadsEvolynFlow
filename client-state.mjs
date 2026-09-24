const WORKFLOW_FIELDS = ["status", "followup", "remarks"];

export function matchesLead(lead, query, status) {
  const haystack = `${lead.sno} ${lead.name} ${lead.mobile} ${lead.address} ${lead.category}`.toLowerCase();
  return (!query || haystack.includes(query)) && (!status || lead.status === status);
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
