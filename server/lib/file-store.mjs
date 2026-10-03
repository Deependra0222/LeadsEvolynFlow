import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Local development store with the same interface as the MongoDB store. Without a
// file path it keeps everything in memory; with one it persists to a JSON file so
// local data survives restarts. Never used on Vercel, whose disk is temporary.

export async function createFileStore({ path = "", makeEtag = () => randomUUID() } = {}) {
  const entries = new Map();
  if (path) {
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      for (const [key, entry] of Object.entries(saved)) entries.set(key, entry);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  let writing = Promise.resolve();
  function persist() {
    if (!path) return Promise.resolve();
    const snapshot = JSON.stringify(Object.fromEntries(entries), null, 2);
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, path);
    });
    return writing;
  }

  const copy = value => (value === undefined || value === null ? null : JSON.parse(JSON.stringify(value)));
  const matching = prefix => [...entries.keys()].filter(key => key.startsWith(prefix)).sort();

  return {
    async get(key) {
      return entries.has(key) ? copy(entries.get(key).value) : null;
    },
    async getWithMetadata(key) {
      if (!entries.has(key)) return null;
      const entry = entries.get(key);
      return { data: copy(entry.value), etag: entry.etag, metadata: {} };
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfNew && entries.has(key)) return { modified: false };
      if (options.onlyIfMatch && entries.get(key)?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = makeEtag();
      entries.set(key, { value: copy(value), etag, updatedAt: new Date().toISOString() });
      await persist();
      return { modified: true, etag };
    },
    async delete(key) {
      if (entries.delete(key)) await persist();
    },
    async *list({ prefix = "" } = {}) {
      yield { blobs: matching(prefix).map(key => ({ key, etag: entries.get(key).etag })), directories: [] };
    },
    async listJSON(prefix = "") {
      return matching(prefix).map(key => ({ key, data: copy(entries.get(key).value) }));
    }
  };
}
