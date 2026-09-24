import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("page loads a focused module and contains no embedded lead database", async () => {
  const html = await read("../index.html");
  assert.doesNotMatch(html, /const leads\s*=/);
  assert.equal((html.match(/\{"sno":/g) || []).length, 0);
  assert.match(html, /<script type="module" src="\.\/app\.mjs"><\/script>/);
  const app = await read("../app.mjs");
  assert.doesNotThrow(() => new Function(app.replace(/^import .*$/gm, "").replace(/^export /gm, "")));
});

test("viewer keeps shared status, lead list, Update, call, and WhatsApp controls", async () => {
  const html = await read("../index.html");
  const app = await read("../app.mjs");
  assert.match(html, /id="syncNotice"[^>]*role="status"/);
  assert.match(html, /id="leadList"/);
  assert.match(app, /class="update-btn"/);
  assert.match(app, />Update</);
  assert.match(app, /tel:/);
  assert.match(app, /wa\.me/);
});

test("viewer loads server-owned leads and PATCHes changed workflow fields", async () => {
  const app = await read("../app.mjs");
  assert.match(app, /api\.listLeads\(\)/);
  assert.match(app, /api\.patchWorkflow\(baseLead\.id,\s*patch\)/);
  assert.match(app, /Retry loading leads/);
  assert.match(app, /Update failed — please try again/);
  assert.doesNotMatch(app, /telecaller_lead_/);
});

test("page explains why controls are inactive when the module cannot start", async () => {
  const html = await read("../index.html");
  const source = html.match(/<script id="startupGuard">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, "startup guard script is present");
  const notice = { textContent: "Loading shared updates...", className: "sync-notice" };
  const listeners = {};
  let timer;
  let alertMessage = "";
  const login = { addEventListener: (type, callback) => { listeners[type] = callback; } };
  const context = {
    window: { location: { protocol: "file:" } },
    document: { getElementById: id => id === "syncNotice" ? notice : login },
    setTimeout: callback => { timer = callback; },
    alert: message => { alertMessage = message; }
  };
  vm.runInNewContext(source, context);
  listeners.click();
  timer();
  assert.match(alertMessage, /Netlify/i);
  assert.match(notice.textContent, /directly|Netlify/i);
});

test("page provides accessible password-gated admin dialogs", async () => {
  const html = await read("../index.html");
  for (const id of ["adminLogin", "adminLogout", "importLeads", "downloadBackup", "loginDialog", "importDialog", "editDialog", "deleteDialog"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="adminPassword"[^>]*type="password"/);
  assert.match(html, /id="jsonFile"[^>]*accept="application\/json,\.json"/);
  assert.match(html, /class="[^"]*admin-only[^"]*"/);
  assert.doesNotMatch(html, /LEAD_ADMIN_PASSWORD|LEAD_SESSION_SECRET/);
});

test("app toggles admin mode and supports import, edit, delete, and backup", async () => {
  const app = await read("../app.mjs");
  assert.match(app, /dataset\.admin/);
  assert.match(app, /previewImport/);
  assert.match(app, /importLeads/);
  assert.match(app, /updateLead/);
  assert.match(app, /deleteLead/);
  assert.match(app, /downloadBackup/);
  assert.match(app, /class="admin-only edit-lead"/);
  assert.match(app, /class="admin-only delete-lead"/);
});

test("WhatsApp template remains a browser-local preference", async () => {
  const app = await read("../app.mjs");
  assert.match(app, /telecaller_wa_template/);
});

test("Netlify publishes the site, packages seed JSON, and routes both API groups", async () => {
  const config = await read("../netlify.toml");
  assert.match(config, /publish\s*=\s*"\."/);
  assert.match(config, /functions\s*=\s*"netlify\/functions"/);
  assert.match(config, /included_files\s*=\s*\["netlify\/data\/initial-leads\.json"\]/);
  assert.match(config, /from\s*=\s*"\/api\/admin\/\*"[\s\S]*?lead-data\/admin\/:splat/);
  assert.match(config, /from\s*=\s*"\/api\/leads\/\*"[\s\S]*?lead-data\/:splat/);
});

test("deployment documentation covers secrets, permissions, JSON, backup, and refresh", async () => {
  const envExample = await read("../.env.example");
  const gitignore = await read("../.gitignore");
  const readme = await read("../README.md");
  assert.match(envExample, /^LEAD_ADMIN_PASSWORD=\s*$/m);
  assert.match(envExample, /^LEAD_SESSION_SECRET=\s*$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.netlify\/?$/m);
  for (const phrase of ["LEAD_ADMIN_PASSWORD", "LEAD_SESSION_SECRET", "Import Leads", "Download JSON Backup", "status, remarks, and follow-up", "refresh", "randomBytes(48)"]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(readme, /No database provisioning, API keys, or environment variables are required/i);
});
