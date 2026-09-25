import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { createAdminAuth, createLoginLimiter } from "../lib/admin-session.mjs";
import { createLeadHandler } from "../lib/lead-data-core.mjs";
import { createLeadRepository } from "../lib/lead-repository.mjs";
import { createCompartmentRepository } from "../lib/compartment-repository.mjs";

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name] ?? "";
}

const seedLeads = JSON.parse(
  await readFile(new URL("../data/initial-leads.json", import.meta.url), "utf8")
);
const store = getStore({ name: "telecaller-leads", consistency: "strong" });
const compartmentRepository = createCompartmentRepository({ store, makeId: randomUUID });
const repository = createLeadRepository({ store, seedLeads, makeId: randomUUID, compartmentRepository });
const auth = createAdminAuth({
  password: env("LEAD_ADMIN_PASSWORD"),
  secret: env("LEAD_SESSION_SECRET")
});
const loginLimiter = createLoginLimiter();

export default createLeadHandler({ repository, compartmentRepository, auth, loginLimiter });
