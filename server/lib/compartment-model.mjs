const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function normalizeCompartmentName(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "Compartment name must be text." };
  }
  const name = value.trim();
  if (!name || name.length > 80) {
    return { ok: false, error: "Compartment name must be 1 to 80 characters." };
  }
  return { ok: true, name, key: name.toLocaleLowerCase("en-IN") };
}

export function validateCompartmentIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

export function normalizeStoredCompartment(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = validateCompartmentIdentifier(value.id);
  const normalizedName = normalizeCompartmentName(value.name);
  if (!id || !normalizedName.ok || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return null;
  }
  return {
    id,
    name: normalizedName.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}
