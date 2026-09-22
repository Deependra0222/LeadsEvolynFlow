function valuesOnly(value) {
  return {
    status: value.status,
    followup: value.followup,
    remarks: value.remarks
  };
}

function sameValues(left, right) {
  return left.status === right.status &&
    left.followup === right.followup &&
    left.remarks === right.remarks;
}

export function createLeadState() {
  const confirmed = new Map();
  const drafts = new Map();

  return {
    replaceRecords(records) {
      confirmed.clear();
      Object.entries(records).forEach(([id, record]) => confirmed.set(id, record));
    },

    valuesFor(lead) {
      const id = String(lead.sno);
      return drafts.get(id) || confirmed.get(id) || valuesOnly(lead);
    },

    rememberDraft(id, values) {
      drafts.set(String(id), valuesOnly(values));
    },

    confirmSaved(id, submitted, record) {
      const key = String(id);
      confirmed.set(key, record);
      const currentDraft = drafts.get(key);
      if (currentDraft && sameValues(currentDraft, submitted)) {
        drafts.delete(key);
      }
      return !drafts.has(key);
    }
  };
}
