import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("page loads a focused module and contains no embedded lead database", async () => {
  const html = await read("../public/index.html");
  assert.doesNotMatch(html, /const leads\s*=/);
  assert.equal((html.match(/\{"sno":/g) || []).length, 0);
  assert.match(html, /<script type="module" src="\.\/app\.mjs"><\/script>/);
  const app = await read("../public/app.mjs");
  assert.doesNotThrow(() => new Function(app.replace(/^import .*$/gm, "").replace(/^export /gm, "")));
});

test("viewer keeps shared status, lead list, Update, call, and WhatsApp controls", async () => {
  const html = await read("../public/index.html");
  const app = await read("../public/app.mjs");
  assert.match(html, /id="syncNotice"[^>]*role="status"/);
  assert.match(html, /id="leadList"/);
  assert.match(app, /class="update-btn"/);
  assert.match(app, />Update</);
  assert.match(app, /tel:/);
  assert.match(app, /wa\.me/);
});

test("viewer can combine area sorting with the existing search and status filter", async () => {
  const html = await read("../public/index.html");
  assert.match(html, /id="areaSort"/);
  assert.match(html, /value="area-asc"/);
  assert.match(html, /value="area-desc"/);
});

test("page keeps the navy, blue and white visual system with visible focus indicators", async () => {
  const html = await read("../public/index.html");
  assert.match(html, /name="theme-color"\s+content="#0b2f59"/i);
  assert.match(html, /--navy:\s*#0b2f59/i);
  assert.match(html, /--blue:\s*#1769e0/i);
  assert.match(html, /\.topbar\s*\{[^}]*background:\s*linear-gradient\(135deg,var\(--navy\),var\(--navy2\)\)/i);
  assert.match(html, /:focus-visible\s*\{[^}]*outline:\s*3px solid #76aaf1/i);
  assert.doesNotMatch(html, /Neobrutalist visual system|--hard-shadow|--paper:\s*#fff8e7/i);
});

test("compartments render as a folder sidebar with a folder header and status summary", async () => {
  const html = await read("../public/index.html");
  const app = await read("../public/app.mjs");
  assert.match(html, /<aside class="sidebar"/);
  assert.match(html, /id="compartmentNav" class="folder-list"/);
  for (const id of ["folderTitle", "folderActions", "folderImport", "folderDownload", "folderRename", "folderDelete", "statusStats", "renameDialog", "dropZone", "newFolderQuick"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /class="folder-item compartment-tab/);
  assert.match(app, /function renderFolderHero/);
  assert.match(app, /function renderStats/);
  assert.match(app, /status-pill/);
  assert.match(app, /addEventListener\("drop"/);
});
test("phone layout releases the header and stacks the folder sidebar above the leads", async () => {
  const html = await read("../public/index.html");
  assert.match(html, /@media\s*\(max-width:560px\)\s*\{[\s\S]*?\.topbar\s*\{\s*position:\s*static\s*\}/i);
  assert.match(html, /@media\s*\(max-width:900px\)\s*\{[\s\S]*?\.shell\s*\{\s*grid-template-columns:\s*1fr/i);
});
test("viewer loads server-owned leads and PATCHes changed workflow fields", async () => {
  const app = await read("../public/app.mjs");
  assert.match(app, /api\.listLeads\(\)/);
  assert.match(app, /api\.patchWorkflow\(baseLead\.id,\s*patch\)/);
  assert.match(app, /Retry loading leads/);
  assert.match(app, /Update failed — please try again/);
  assert.doesNotMatch(app, /telecaller_lead_/);
});

test("page explains why controls are inactive when the module cannot start", async () => {
  const html = await read("../public/index.html");
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
  assert.match(alertMessage, /Vercel/i);
  assert.match(notice.textContent, /directly|Vercel/i);
});

test("page provides accessible password-gated admin dialogs", async () => {
  const html = await read("../public/index.html");
  for (const id of ["adminLogin", "adminLogout", "importLeads", "downloadBackup", "loginDialog", "importDialog", "editDialog", "deleteDialog"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="adminPassword"[^>]*type="password"/);
  assert.match(html, /id="jsonFile"[^>]*accept="application\/json,\.json"/);
  assert.match(html, /class="[^"]*admin-only[^"]*"/);
  assert.doesNotMatch(html, /LEAD_ADMIN_PASSWORD|LEAD_SESSION_SECRET/);
});

test("app toggles admin mode and supports import, edit, delete, and backup", async () => {
  const app = await read("../public/app.mjs");
  assert.match(app, /dataset\.admin/);
  assert.match(app, /previewImport/);
  assert.match(app, /importLeads/);
  assert.match(app, /updateLead/);
  assert.match(app, /deleteLead/);
  assert.match(app, /downloadBackup/);
  assert.match(app, /class="admin-only edit-lead"/);
  assert.match(app, /class="admin-only delete-lead"/);
});

test("page exposes compartment navigation multi-select filters and bulk move controls", async () => {
  const html = await read("../public/index.html");
  const app = await read("../public/app.mjs");
  for (const id of [
    "compartmentNav", "filterToggle", "filterPanel", "cityFilters", "categoryFilters",
    "activeFilters", "manageCompartments", "importCompartment", "bulkMoveBar", "moveDestination"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /api\.listCompartments/);
  assert.match(app, /api\.moveLeads/);
  assert.match(app, /api\.downloadCompartment/);
  assert.match(app, /shiftKey/);
  assert.match(app, /buildLeadFacets/);
  assert.match(html, /body\s+\.bulk-move-bar\[hidden\]\s*\{\s*display:\s*none!important/i);
});

test("admin dialogs include compartment management destination binding and City editing", async () => {
  const html = await read("../public/index.html");
  for (const id of [
    "compartmentDialog", "newCompartmentName", "createCompartment", "compartmentRows",
    "deleteCompartmentDialog", "deleteCompartmentName", "deleteCompartmentCount",
    "downloadBeforeCompartmentDelete", "confirmCompartmentDelete", "editCity"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /for="importCompartment"/);
  assert.match(html, /for="editCity"/);
  assert.match(html, /aria-live="polite"/);
});

test("dynamic compartment and facet controls restore keyboard focus after rerender", async () => {
  const app = await read("../public/app.mjs");
  assert.match(app, /function restoreRenderedFocus/);
  assert.match(app, /focusTarget:\s*\{\s*kind:\s*"facet"/);
  assert.match(app, /render\(\{\s*kind:\s*"lead-selection"/);
});

test("WhatsApp template remains a browser-local preference", async () => {
  const app = await read("../public/app.mjs");
  assert.match(app, /telecaller_wa_template/);
});

test("Vercel serves public/, packages seed JSON, and routes every API path to one function", async () => {
  const config = JSON.parse(await read("../vercel.json"));
  assert.equal(config.outputDirectory, "public");
  assert.equal(config.framework, null);
  assert.equal(config.functions["api/lead-data.js"].includeFiles, "server/data/**");
  assert.ok(config.functions["api/lead-data.js"].maxDuration <= 60);
  assert.deepEqual(config.rewrites, [{ source: "/api/(.*)", destination: "/api/lead-data?__route=$1" }]);
  const pkg = JSON.parse(await read("../package.json"));
  assert.ok(pkg.dependencies.mongodb);
  assert.equal(pkg.dependencies["@netlify/blobs"], undefined);
});
test("deployment documentation covers Vercel, MongoDB Atlas, secrets, JSON, backup, and refresh", async () => {
  const envExample = await read("../.env.example");
  const gitignore = await read("../.gitignore");
  const readme = await read("../README.md");
  assert.match(envExample, /^MONGODB_URI=\s*$/m);
  assert.match(envExample, /^LEAD_ADMIN_PASSWORD=\s*$/m);
  assert.match(envExample, /^LEAD_SESSION_SECRET=\s*$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.vercel\/?$/m);
  for (const phrase of ["Vercel", "MongoDB Atlas", "M0", "MONGODB_URI", "LEAD_ADMIN_PASSWORD", "LEAD_SESSION_SECRET", "0.0.0.0/0", "Import Leads", "Download JSON Backup", "status, remarks, and follow-up", "refresh"]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(readme, /netlify\.toml|Netlify Blobs stores/i);
});