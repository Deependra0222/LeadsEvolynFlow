import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexPath = new URL("../index.html", import.meta.url);

async function readIndex() {
  return readFile(indexPath, "utf8");
}

test("page preserves all embedded leads and compiles its browser script", async () => {
  const html = await readIndex();
  assert.equal((html.match(/\{"sno":/g) || []).length, 722);

  const scripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "expected an inline browser script");
  const compilableScript = scripts.at(-1)[1].replace(
    /^\s*import\s*\{\s*createLeadState\s*\}\s*from\s*["']\.\/client-state\.mjs["'];?\s*/,
    ""
  );
  assert.doesNotThrow(() => new Function(compilableScript));
});

test("page includes a shared-data status region and Update control", async () => {
  const html = await readIndex();
  assert.match(html, /id="syncNotice"[^>]*role="status"/);
  assert.match(html, /class="update-btn"/);
  assert.match(html, /\.update-btn/);
});

test("page loads shared values and renders embedded leads on load failure", async () => {
  const html = await readIndex();
  assert.match(html, /fetch\(["']\/api\/leads["']/);
  assert.match(html, /Could not load shared updates\. Showing the original lead list\./);
  assert.match(html, /finally\s*\{[\s\S]*?applyFilters\(true\)/);
});

test("page saves a single lead only through the Update button", async () => {
  const html = await readIndex();
  assert.match(html, /fetch\(`\/api\/leads\/\$\{lead\.sno\}`/);
  assert.match(html, /method:\s*["']PUT["']/);
  assert.match(html, /Saving…/);
  assert.match(html, /Update failed — please try again/);
  assert.doesNotMatch(html, /function writeSaved\(/);
  assert.doesNotMatch(html, /telecaller_lead_/);
  assert.doesNotMatch(html, /statusEl\.addEventListener\(["']change["']/);

  const okCheck = html.indexOf("if (!response.ok)");
  const confirmedMutation = html.indexOf("confirmSaved", okCheck);
  assert.ok(okCheck >= 0, "expected a failed-response check");
  assert.ok(confirmedMutation > okCheck, "shared data must change only after response.ok is checked");
});

test("page records field drafts before rerenders", async () => {
  const html = await readIndex();
  assert.match(html, /import\s*\{\s*createLeadState\s*\}\s*from\s*["']\.\/client-state\.mjs["']/);
  assert.match(html, /rememberDraft\(lead\.sno/);
  assert.match(html, /addEventListener\(["']input["']/);
});

test("WhatsApp template remains a browser-local preference", async () => {
  const html = await readIndex();
  assert.match(html, /telecaller_wa_template/);
});

test("Netlify publishes the site and preserves lead IDs in API redirects", async () => {
  let config;
  try {
    config = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  } catch (error) {
    assert.fail(`Expected netlify.toml to exist: ${error.code || error.message}`);
  }

  assert.match(config, /publish\s*=\s*"\."/);
  assert.match(config, /functions\s*=\s*"netlify\/functions"/);
  assert.match(config, /from\s*=\s*"\/api\/leads"[\s\S]*?to\s*=\s*"\/\.netlify\/functions\/lead-data"[\s\S]*?status\s*=\s*200/);
  assert.match(config, /from\s*=\s*"\/api\/leads\/\*"[\s\S]*?to\s*=\s*"\/\.netlify\/functions\/lead-data\/:splat"[\s\S]*?status\s*=\s*200/);
});
