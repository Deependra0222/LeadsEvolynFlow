import { getStore } from "@netlify/blobs";
import { createLeadHandler } from "../lib/lead-data-core.mjs";

const store = getStore({ name: "telecaller-leads", consistency: "strong" });
const KEY_PREFIX = "lead-";

async function listRecords() {
  const { blobs } = await store.list({ prefix: KEY_PREFIX });
  const entries = await Promise.all(blobs.map(async ({ key }) => {
    const record = await store.get(key, { type: "json" });
    return [key.slice(KEY_PREFIX.length), record];
  }));

  return Object.fromEntries(entries.filter(([, record]) => record !== null));
}

async function saveRecord(id, record) {
  await store.setJSON(`${KEY_PREFIX}${id}`, record);
}

export default createLeadHandler({ listRecords, saveRecord });
