export function parseImportText(text) {
  try {
    const value = JSON.parse(String(text));
    const records = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : null;
    if (!records || records.length === 0 || records.some(record => !record || typeof record !== "object" || Array.isArray(record))) {
      return { ok: false, error: "JSON must contain one lead object or a non-empty array of lead objects." };
    }
    return { ok: true, records };
  } catch {
    return { ok: false, error: "The pasted text is not valid JSON." };
  }
}

export async function readJsonFile(file, { maxBytes = 2_000_000 } = {}) {
  const validName = typeof file?.name === "string" && file.name.toLowerCase().endsWith(".json");
  const validType = !file?.type || file.type === "application/json";
  if (!validName || !validType) throw new Error("Choose a JSON file ending in .json.");
  if (file.size > maxBytes) throw new Error("The JSON file is too large.");
  return file.text();
}

export function createLatestReadGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    isCurrent(token) { return token === generation; },
    invalidate() { generation += 1; }
  };
}

export function failImportPreview(review, token, error) {
  if (!review.isCurrent(token)) return null;
  review.invalidate();
  return error?.message || "Preview failed. Please try again.";
}

export function createImportReviewState({ makeRequestId = () => crypto.randomUUID() } = {}) {
  let generation = 0;
  let pending = null;
  let reviewed = null;
  const copy = value => JSON.parse(JSON.stringify(value));

  return {
    begin(records) {
      generation += 1;
      pending = { token: generation, requestId: makeRequestId(), records: copy(records) };
      reviewed = null;
      return { token: pending.token, records: copy(pending.records) };
    },
    accept(token, result) {
      if (!pending || token !== generation || token !== pending.token) return false;
      reviewed = result.valid.length ? { requestId: pending.requestId, records: copy(pending.records) } : null;
      pending = null;
      return true;
    },
    isCurrent(token) {
      return Boolean(pending && token === generation && token === pending.token);
    },
    confirmPayload() {
      return reviewed ? copy(reviewed) : null;
    },
    complete(result) {
      if (result.errors.length) return false;
      generation += 1;
      pending = null;
      reviewed = null;
      return true;
    },
    invalidate() {
      generation += 1;
      pending = null;
      reviewed = null;
    }
  };
}
