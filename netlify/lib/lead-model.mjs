export const STATUS_OPTIONS = [
  "Not Called",
  "Called",
  "No Answer",
  "Follow-up",
  "Interested",
  "Not Interested"
];

export const LIMITS = Object.freeze({
  importBytes: 2_000_000,
  importRecords: 1_000,
  name: 300,
  mobile: 50,
  address: 500,
  category: 120,
  remarks: 5_000
});

const IMPORT_FIELDS = new Set([
  "sno", "name", "mobile", "address", "category", "status", "followup", "remarks"
]);
const IMPORT_FIELD_ALIASES = new Map([
  ["S.No.", "sno"],
  ["Institute/Business Name", "name"],
  ["Mobile Number", "mobile"],
  ["Area/Address", "address"],
  ["Category", "category"],
  ["Call Status", "status"],
  ["Next Follow-up", "followup"],
  ["Remarks", "remarks"]
]);
const WORKFLOW_FIELDS = new Set(["status", "followup", "remarks"]);
const CORE_FIELDS = ["name", "mobile", "address", "category"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidLocalDateTime(value) {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export function validateLeadIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

export function validateWorkflowPatch(value) {
  if (!isObject(value)) return { ok: false, status: 400, error: "Request body must be an object." };
  const keys = Object.keys(value);
  if (keys.length === 0) return { ok: false, status: 400, error: "At least one workflow field is required." };
  if (keys.some(key => !WORKFLOW_FIELDS.has(key))) {
    return { ok: false, status: 403, error: "Workflow updates cannot change core lead details." };
  }
  const data = {};
  if ("status" in value) {
    if (!STATUS_OPTIONS.includes(value.status)) return { ok: false, status: 400, error: "Invalid call status." };
    data.status = value.status;
  }
  if ("followup" in value) {
    if (!isValidLocalDateTime(value.followup)) return { ok: false, status: 400, error: "Invalid follow-up date." };
    data.followup = value.followup;
  }
  if ("remarks" in value) {
    if (typeof value.remarks !== "string" || value.remarks.length > LIMITS.remarks) {
      return { ok: false, status: 400, error: "Remarks must be 5,000 characters or fewer." };
    }
    data.remarks = value.remarks;
  }
  return { ok: true, data };
}

export function validateCorePatch(value) {
  if (!isObject(value)) return { ok: false, error: "Request body must be an object." };
  const keys = Object.keys(value);
  if (keys.length !== CORE_FIELDS.length || keys.some(key => !CORE_FIELDS.includes(key))) {
    return { ok: false, error: "Core edits must contain only name, mobile, address, and category." };
  }
  const data = {};
  for (const key of CORE_FIELDS) {
    if (typeof value[key] !== "string") return { ok: false, error: `${key} must be text.` };
    data[key] = value[key].trim();
  }
  if (!data.name) return { ok: false, error: "Name is required." };
  if (!data.mobile) return { ok: false, error: "Mobile is required." };
  for (const [key, max] of [["name", LIMITS.name], ["mobile", LIMITS.mobile], ["address", LIMITS.address], ["category", LIMITS.category]]) {
    if (data[key].length > max) return { ok: false, error: `${key} is too long.` };
  }
  return { ok: true, data };
}

function validateImportRow(value, index, seen) {
  const errors = [];
  if (!isObject(value)) return { errors: [{ index, field: "$", error: "Each lead must be an object." }] };
  const normalized = {};
  const sourceFields = new Map();
  for (const [key, fieldValue] of Object.entries(value)) {
    const canonical = IMPORT_FIELD_ALIASES.get(key) ?? key;
    if (!IMPORT_FIELDS.has(canonical)) {
      errors.push({ index, field: key, error: `Unknown field: ${key}.` });
      continue;
    }
    if (Object.hasOwn(normalized, canonical)) {
      if (normalized[canonical] !== fieldValue) {
        const previous = sourceFields.get(canonical);
        const alias = previous === canonical ? key : previous;
        errors.push({ index, field: canonical, error: `Conflicting fields: ${canonical} and ${alias}.` });
      }
      continue;
    }
    normalized[canonical] = fieldValue;
    sourceFields.set(canonical, key);
  }
  const data = {
    name: typeof normalized.name === "string" ? normalized.name.trim() : "",
    mobile: typeof normalized.mobile === "string" ? normalized.mobile.trim() : "",
    address: typeof normalized.address === "string" ? normalized.address.trim() : "",
    category: typeof normalized.category === "string" ? normalized.category.trim() : "",
    status: normalized.status === undefined ? "Not Called" : normalized.status,
    followup: normalized.followup === undefined ? "" : normalized.followup,
    remarks: normalized.remarks === undefined ? "" : normalized.remarks
  };
  for (const key of ["name", "mobile", "address", "category"]) {
    if (normalized[key] !== undefined && typeof normalized[key] !== "string") {
      errors.push({ index, field: key, error: `${key} must be text.` });
    }
  }
  if (normalized.name === undefined || (typeof normalized.name === "string" && !data.name)) {
    errors.push({ index, field: "name", error: "Name is required." });
  }
  if (normalized.mobile === undefined || (typeof normalized.mobile === "string" && !data.mobile)) {
    errors.push({ index, field: "mobile", error: "Mobile is required." });
  }
  for (const [key, max] of [["name", LIMITS.name], ["mobile", LIMITS.mobile], ["address", LIMITS.address], ["category", LIMITS.category]]) {
    if (data[key].length > max) errors.push({ index, field: key, error: `${key} is too long.` });
  }
  if (!STATUS_OPTIONS.includes(data.status)) errors.push({ index, field: "status", error: "Invalid call status." });
  if (!isValidLocalDateTime(data.followup)) errors.push({ index, field: "followup", error: "Invalid follow-up date." });
  if (typeof data.remarks !== "string" || data.remarks.length > LIMITS.remarks) {
    errors.push({ index, field: "remarks", error: "Remarks must be 5,000 characters or fewer." });
  }
  if (normalized.sno !== undefined) {
    if (!Number.isInteger(normalized.sno) || normalized.sno < 1) {
      errors.push({ index, field: "sno", error: "Serial number must be a positive integer." });
    } else if (seen.has(normalized.sno)) {
      errors.push({ index, field: "sno", error: `Serial number ${normalized.sno} already exists.` });
    } else {
      data.sno = normalized.sno;
      seen.add(normalized.sno);
    }
  }
  return { data, errors };
}

export function validateImportRecords(value, { existingSnos = new Set() } = {}) {
  const records = Array.isArray(value) ? value : isObject(value) ? [value] : null;
  if (!records) return { valid: [], validRows: [], errors: [{ index: -1, field: "$", error: "JSON must be a lead object or an array of lead objects." }] };
  if (records.length === 0) return { valid: [], validRows: [], errors: [{ index: -1, field: "$", error: "Provide at least one lead." }] };
  if (records.length > LIMITS.importRecords) return { valid: [], validRows: [], errors: [{ index: -1, field: "$", error: "Imports are limited to 1,000 leads." }] };
  const seen = new Set(existingSnos);
  const valid = [];
  const validRows = [];
  const errors = [];
  records.forEach((record, index) => {
    const result = validateImportRow(record, index, seen);
    if (result.errors.length) errors.push(...result.errors);
    else {
      valid.push(result.data);
      validRows.push({ index, data: result.data });
    }
  });
  return { valid, validRows, errors };
}

export function normalizeStoredLead(value) {
  if (!isObject(value) || validateLeadIdentifier(value.id) === null || !Number.isInteger(value.sno) || value.sno < 1) return null;
  const imported = validateImportRecords({
    sno: value.sno,
    name: value.name,
    mobile: value.mobile,
    address: value.address,
    category: value.category,
    status: value.status,
    followup: value.followup,
    remarks: value.remarks
  });
  if (imported.errors.length || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  return { id: value.id, ...imported.valid[0], createdAt: value.createdAt, updatedAt: value.updatedAt };
}
