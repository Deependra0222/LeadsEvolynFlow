import test from "node:test";
import assert from "node:assert/strict";

async function loadCore() {
  try {
    return await import("../netlify/lib/lead-data-core.mjs");
  } catch (error) {
    assert.fail(`Expected the lead API module to load: ${error.code || error.message}`);
  }
}

async function makeHandler(overrides = {}) {
  const { createLeadHandler } = await loadCore();
  const saved = [];
  const handler = createLeadHandler({
    listRecords: async () => ({
      "12": {
        status: "Called",
        followup: "2026-09-23T10:30",
        remarks: "Existing note",
        updatedAt: "2026-09-23T00:00:00.000Z"
      }
    }),
    saveRecord: async (id, record) => saved.push({ id, record }),
    now: () => "2026-09-23T01:02:03.000Z",
    ...overrides
  });
  return { handler, saved };
}

const validBody = {
  status: "Called",
  followup: "2026-09-23T10:30",
  remarks: "Spoke to the owner"
};

test("GET returns all shared lead records without caching", async () => {
  const { handler } = await makeHandler();
  const response = await handler(new Request("https://site.test/api/leads"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    records: {
      "12": {
        status: "Called",
        followup: "2026-09-23T10:30",
        remarks: "Existing note",
        updatedAt: "2026-09-23T00:00:00.000Z"
      }
    }
  });
});

test("PUT validates and saves one lead", async () => {
  const { handler, saved } = await makeHandler();
  const response = await handler(new Request("https://site.test/api/leads/12", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody)
  }));

  assert.equal(response.status, 200);
  const expectedRecord = { ...validBody, updatedAt: "2026-09-23T01:02:03.000Z" };
  assert.deepEqual(await response.json(), { record: expectedRecord });
  assert.deepEqual(saved, [{ id: 12, record: expectedRecord }]);
});

test("PUT accepts the Netlify wildcard redirect path", async () => {
  const { handler, saved } = await makeHandler();
  const response = await handler(new Request("https://site.test/.netlify/functions/lead-data/12", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody)
  }));

  assert.equal(response.status, 200);
  assert.equal(saved[0].id, 12);
});

test("PUT rejects malformed and out-of-range lead IDs", async (t) => {
  for (const id of ["0", "723", "abc", "0x10", "1e2", "1.0", "%2012"]) {
    await t.test(id, async () => {
      const { handler, saved } = await makeHandler();
      const response = await handler(new Request(`https://site.test/api/leads/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody)
      }));

      assert.equal(response.status, 400);
      assert.deepEqual(saved, []);
    });
  }
});

test("PUT rejects invalid status, follow-up, and oversized remarks", async (t) => {
  const invalidBodies = [
    { ...validBody, status: "Unknown" },
    { ...validBody, followup: "tomorrow" },
    { ...validBody, followup: "2026-02-30T10:30" },
    { ...validBody, followup: "2026-01-01T24:00" },
    { ...validBody, followup: "2025-02-29T10:30" },
    { ...validBody, remarks: "x".repeat(5001) }
  ];

  for (const body of invalidBodies) {
    await t.test(JSON.stringify(body).slice(0, 60), async () => {
      const { handler, saved } = await makeHandler();
      const response = await handler(new Request("https://site.test/api/leads/12", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }));

      assert.equal(response.status, 400);
      assert.deepEqual(saved, []);
    });
  }
});

test("PUT accepts a valid leap-day follow-up", async () => {
  const { handler, saved } = await makeHandler();
  const leapDayBody = { ...validBody, followup: "2028-02-29T23:59" };
  const response = await handler(new Request("https://site.test/api/leads/12", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(leapDayBody)
  }));

  assert.equal(response.status, 200);
  assert.equal(saved[0].record.followup, "2028-02-29T23:59");
});

test("PUT rejects malformed JSON", async () => {
  const { handler, saved } = await makeHandler();
  const response = await handler(new Request("https://site.test/api/leads/12", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{not-json"
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(saved, []);
});

test("unsupported methods return 405 and an Allow header", async () => {
  const { handler } = await makeHandler();
  const response = await handler(new Request("https://site.test/api/leads", { method: "POST" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, PUT, OPTIONS");
});

test("OPTIONS returns a successful empty preflight response", async () => {
  const { handler } = await makeHandler();
  const response = await handler(new Request("https://site.test/api/leads", { method: "OPTIONS" }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, PUT, OPTIONS");
  assert.equal(await response.text(), "");
});

test("storage failures return a generic 500 response", async () => {
  const { handler } = await makeHandler({
    listRecords: async () => { throw new Error("secret storage detail"); }
  });
  const response = await handler(new Request("https://site.test/api/leads"));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Shared storage is temporarily unavailable."
  });
});

test("Blob adapter requests strong consistency", async () => {
  const { readFile } = await import("node:fs/promises");
  const adapter = await readFile(
    new URL("../netlify/functions/lead-data.mjs", import.meta.url),
    "utf8"
  );

  assert.match(
    adapter,
    /getStore\(\{\s*name:\s*"telecaller-leads",\s*consistency:\s*"strong"\s*\}\)/
  );
});

test("only the deployable handler is a top-level Netlify function", async () => {
  const { readdir } = await import("node:fs/promises");
  const functionFiles = (await readdir(
    new URL("../netlify/functions/", import.meta.url),
    { withFileTypes: true }
  ))
    .filter(entry => entry.isFile() && entry.name.endsWith(".mjs"))
    .map(entry => entry.name)
    .sort();

  assert.deepEqual(functionFiles, ["lead-data.mjs"]);
});
