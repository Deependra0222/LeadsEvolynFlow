import { readFile } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { attachDatabasePool } from "@vercel/functions";
import { createAdminAuth, createLoginLimiter } from "./lib/admin-session.mjs";
import { createLeadHandler } from "./lib/lead-data-core.mjs";
import { createLeadRepository } from "./lib/lead-repository.mjs";
import { createCompartmentRepository } from "./lib/compartment-repository.mjs";
import { createMongoStore } from "./lib/mongo-store.mjs";
import { createFileStore } from "./lib/file-store.mjs";

const SEED_URL = new URL("./data/initial-leads.json", import.meta.url);
const DEFAULT_DB = "leadsevolynflow";
const DEFAULT_COLLECTION = "lead_store";

// Vercel's MongoDB Atlas integration can add a custom prefix to the variable it
// creates (for example STORAGE_MONGODB_URI), so accept any *_MONGODB_URI as well.
export function resolveMongoUri(env) {
  if (env.MONGODB_URI) return env.MONGODB_URI;
  const prefixed = Object.keys(env).filter(name => name.endsWith("_MONGODB_URI") && env[name]).sort();
  return prefixed.length ? env[prefixed[0]] : "";
}

function json(body, status) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// LEAD_SESSION_SECRET is optional. Without it, the cookie signing key is derived
// from the admin password and the database URI, so changing the password also
// signs every admin out.
export function resolveSessionSecret(env) {
  if (env.LEAD_SESSION_SECRET) return env.LEAD_SESSION_SECRET;
  if (!env.LEAD_ADMIN_PASSWORD) return "";
  return createHmac("sha256", `lead-session:${resolveMongoUri(env) || "local"}`)
    .update(env.LEAD_ADMIN_PASSWORD)
    .digest("base64url");
}

export function connectMongoCollection({ uri, dbName = DEFAULT_DB, collectionName = DEFAULT_COLLECTION }) {
  let connecting = null;
  return function collection() {
    connecting ??= (async () => {
      const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000, appName: "leadsevolynflow" });
      attachDatabasePool(client);
      await client.connect();
      return client.db(dbName).collection(collectionName);
    })().catch(error => {
      connecting = null;
      throw error;
    });
    return connecting;
  };
}

async function createStore(env) {
  const uri = resolveMongoUri(env);
  if (uri) {
    return {
      label: "mongodb",
      store: createMongoStore({
        collection: connectMongoCollection({
          uri,
          dbName: env.MONGODB_DB || DEFAULT_DB,
          collectionName: env.MONGODB_COLLECTION || DEFAULT_COLLECTION
        })
      })
    };
  }
  // On Vercel the filesystem is temporary, so refuse to start without a database
  // instead of silently losing every imported lead.
  if (env.VERCEL) return null;
  return { label: "local-file", store: await createFileStore({ path: env.LOCAL_STORE_PATH || ".data/local-store.json" }) };
}

export async function createServerHandler({ env = process.env, store: providedStore } = {}) {
  const selected = providedStore ? { label: "custom", store: providedStore } : await createStore(env);
  if (!selected) {
    return async function missingDatabase() {
      return json({ error: "Database is not configured. Add MONGODB_URI (or connect MongoDB Atlas under Storage) in Vercel → Settings → Environment Variables, then redeploy." }, 503);
    };
  }
  const seedLeads = String(env.SEED_INITIAL_LEADS ?? "true").toLowerCase() === "false"
    ? []
    : JSON.parse(await readFile(SEED_URL, "utf8"));
  const { store } = selected;
  const compartmentRepository = createCompartmentRepository({ store, makeId: randomUUID });
  const repository = createLeadRepository({ store, seedLeads, makeId: randomUUID, compartmentRepository });
  const auth = createAdminAuth({
    password: env.LEAD_ADMIN_PASSWORD || "",
    secret: resolveSessionSecret(env)
  });
  return createLeadHandler({
    repository,
    compartmentRepository,
    auth,
    loginLimiter: createLoginLimiter(),
    storageLabel: selected.label
  });
}
