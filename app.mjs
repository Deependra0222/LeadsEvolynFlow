import { createApiClient, ApiError } from "./client-api.mjs";
import { logoutAdmin } from "./client-actions.mjs";
import { createImportReviewState, createLatestReadGuard, failImportPreview, parseImportText, readJsonFile } from "./client-import.mjs";
import { buildLeadFacets, createLeadState, createRangeSelection, filterAndSortLeads } from "./client-state.mjs";

window.__leadAppStarted = true;

const STATUS_OPTIONS = ["Not Called", "Called", "No Answer", "Follow-up", "Interested", "Not Interested"];
const DEFAULT_WA = "Hello, I’m contacting {name} regarding a business enquiry. Please let me know a convenient time to connect. Thank you.";
const PAGE_SIZE = 40;
const api = createApiClient();
const state = createLeadState();
const selection = createRangeSelection();
const importReview = createImportReviewState();
const fileReadGuard = createLatestReadGuard();

const els = Object.fromEntries([
  "leadList", "search", "statusFilter", "areaSort", "clearFilters", "loadMore", "visibleCount", "topCount",
  "waTemplate", "jumpTop", "toast", "syncNotice", "adminLogin", "adminLogout", "importLeads",
  "downloadBackup", "loginDialog", "loginForm", "adminPassword", "loginError", "importDialog",
  "jsonText", "jsonFile", "previewImport", "confirmImport", "importPreview", "importCompartment",
  "importNewCompartment", "createImportCompartment", "editDialog", "editForm", "editName", "editMobile",
  "editAddress", "editCity", "editCategory", "deleteDialog", "deleteLeadName", "confirmDelete",
  "compartmentNav", "filterToggle", "filterPanel", "cityFilters", "categoryFilters", "activeFilters",
  "manageCompartments", "compartmentDialog", "newCompartmentName", "createCompartment", "compartmentRows",
  "deleteCompartmentDialog", "deleteCompartmentLabel", "deleteCompartmentName", "confirmCompartmentDelete",
  "bulkMoveBar", "selectedCount", "moveDestination", "moveSelected", "clearSelection"
].map(id => [id, document.getElementById(id)]));

let renderLimit = PAGE_SIZE;
let filtered = [];
let compartments = [];
let activeCompartmentId = "";
let selectedCities = new Set();
let selectedCategories = new Set();
let activeEditId = "";
let activeDeleteId = "";
let activeDeleteCompartmentId = "";
let adminEnabled = false;

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function digitsOnly(value) { return String(value || "").replace(/\D/g, ""); }

function normalizeIndiaNumber(value) {
  let digits = digitsOnly(value);
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return { tel: `+${digits}`, wa: digits };
  if (digits.length === 10) return { tel: `+91${digits}`, wa: `91${digits}` };
  return { tel: `+${digits}`, wa: digits };
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function setNotice(message, kind = "") {
  els.syncNotice.textContent = message;
  els.syncNotice.className = `sync-notice${kind ? ` ${kind}` : ""}`;
}

function setAdminMode(enabled) {
  adminEnabled = Boolean(enabled);
  document.body.dataset.admin = String(adminEnabled);
  els.adminLogin.hidden = adminEnabled;
  els.adminLogout.hidden = !adminEnabled;
  if (!adminEnabled) selection.clear();
  if (state.allLeads().length) render();
}

function adminFailure(error, fallback) {
  if (error instanceof ApiError && error.status === 401) {
    setAdminMode(false);
    toast("Admin session expired. Please log in again.");
  } else toast(error?.message || fallback);
}

function statusOptions(selected) {
  return STATUS_OPTIONS.map(status => `<option${status === selected ? " selected" : ""}>${status}</option>`).join("");
}

function compartmentName(id) {
  return compartments.find(item => item.id === id)?.name || "Unavailable compartment";
}

function renderCompartmentOptions(select, selected = "", includePlaceholder = false) {
  const options = compartments.map(item => `<option value="${esc(item.id)}"${item.id === selected ? " selected" : ""}>${esc(item.name)} (${item.count ?? 0})</option>`);
  select.innerHTML = `${includePlaceholder ? '<option value="">Choose a compartment</option>' : ""}${options.join("")}`;
}

function renderCompartmentNav() {
  const facets = buildLeadFacets(state.allLeads(), compartments);
  compartments = facets.compartments;
  els.compartmentNav.innerHTML = [
    `<button class="compartment-tab${activeCompartmentId ? "" : " active"}" type="button" data-compartment="">All Leads (${state.allLeads().length})</button>`,
    ...compartments.map(item => `<button class="compartment-tab${activeCompartmentId === item.id ? " active" : ""}" type="button" data-compartment="${esc(item.id)}">${esc(item.name)} (${item.count})</button>`)
  ].join("");
  renderCompartmentOptions(els.moveDestination, els.moveDestination.value);
  renderCompartmentOptions(els.importCompartment, els.importCompartment.value || activeCompartmentId, true);
}

function renderFacetGroup(container, facets, selected, facet) {
  container.innerHTML = facets.length ? facets.map(item => `<label class="facet-option">
    <input class="facet-checkbox" type="checkbox" data-facet="${facet}" value="${esc(item.value)}"${selected.has(item.value) ? " checked" : ""}>
    <span>${esc(item.value)} (${item.count})</span>
  </label>`).join("") : '<span class="helper">No values available</span>';
}

function renderFilters() {
  const facets = buildLeadFacets(state.allLeads(), compartments);
  renderFacetGroup(els.cityFilters, facets.cities, selectedCities, "city");
  renderFacetGroup(els.categoryFilters, facets.categories, selectedCategories, "category");
  const chips = [];
  if (activeCompartmentId) chips.push(`Compartment: ${compartmentName(activeCompartmentId)}`);
  for (const city of selectedCities) chips.push(`City: ${city}`);
  for (const category of selectedCategories) chips.push(`Category: ${category}`);
  els.activeFilters.innerHTML = chips.map(value => `<span class="filter-chip">${esc(value)}</span>`).join("");
}

function cardHtml(baseLead) {
  const lead = state.valuesFor(baseLead.id) || baseLead;
  const number = normalizeIndiaNumber(lead.mobile);
  const message = encodeURIComponent((els.waTemplate.value || DEFAULT_WA).replaceAll("{name}", lead.name));
  const selected = new Set(selection.ids()).has(String(lead.id));
  return `<article class="card" data-id="${esc(lead.id)}">
    <div class="card-head">
      <label class="card-select admin-only"><input class="lead-select" type="checkbox"${selected ? " checked" : ""}> Select lead</label>
      <div class="sno">LEAD #${esc(lead.sno)}</div>
      <h2 class="biz">${esc(lead.name)}</h2>
      <a class="phone" href="tel:${esc(number.tel)}">${esc(lead.mobile)}</a>
    </div>
    <div class="card-body">
      <div class="meta">
        <div class="meta-row"><div class="label">Compartment</div><div class="value"><span class="compartment-badge">${esc(compartmentName(lead.compartmentId))}</span></div></div>
        <div class="meta-row"><div class="label">City / Area</div><div class="value">${esc(lead.city || "Unknown")}</div></div>
        <div class="meta-row"><div class="label">Area/Address</div><div class="value">${esc(lead.address || "—")}</div></div>
        <div class="meta-row"><div class="label">Category</div><div class="value">${esc(lead.category || "—")}</div></div>
      </div>
      <div class="actions">
        <a class="action call" href="tel:${esc(number.tel)}">☎ Call</a>
        <a class="action wa" href="https://wa.me/${esc(number.wa)}?text=${message}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
      <div class="work-grid">
        <div class="field"><label>Call status</label><select class="status-input">${statusOptions(lead.status)}</select></div>
        <div class="field"><label>Follow-up</label><input class="followup-input" type="datetime-local" value="${esc(lead.followup)}"></div>
        <div class="field remarks-field"><label>Remarks</label><textarea class="remarks-input" maxlength="5000" placeholder="Add notes…">${esc(lead.remarks)}</textarea></div>
      </div>
      <button class="update-btn" type="button">Update</button>
      <div class="admin-actions admin-only">
        <button class="admin-only edit-lead" type="button">Edit Lead</button>
        <button class="admin-only delete-lead" type="button">Delete Lead</button>
      </div>
    </div>
  </article>`;
}

function renderBulkBar() {
  const count = selection.ids().length;
  els.selectedCount.textContent = `${count} selected`;
  els.bulkMoveBar.hidden = !adminEnabled || count === 0;
}

function render() {
  renderCompartmentNav();
  renderFilters();
  const visible = filtered.slice(0, renderLimit);
  els.topCount.textContent = `${state.allLeads().length} leads`;
  els.visibleCount.textContent = `Showing ${visible.length} of ${filtered.length}`;
  els.loadMore.hidden = visible.length >= filtered.length;
  renderBulkBar();
  if (!visible.length) {
    els.leadList.innerHTML = '<div class="empty">No leads match the current filters.</div>';
    return;
  }
  els.leadList.innerHTML = visible.map(cardHtml).join("");
  els.leadList.querySelectorAll(".card").forEach((article, index) => wireCard(article, visible[index], index));
}

function applyFilters({ resetLimit = true, clearSelection = false } = {}) {
  if (resetLimit) renderLimit = PAGE_SIZE;
  if (clearSelection) selection.clear();
  const leads = state.allLeads().map(baseLead => state.valuesFor(baseLead.id));
  filtered = filterAndSortLeads(leads, {
    query: els.search.value,
    status: els.statusFilter.value,
    compartmentId: activeCompartmentId,
    cities: selectedCities,
    categories: selectedCategories,
    sortMode: els.areaSort.value
  });
  render();
}

async function saveLead(baseLead, article) {
  const patch = state.changedWorkflow(baseLead.id);
  if (!Object.keys(patch).length) return toast("No changes to save");
  const button = article.querySelector(".update-btn");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const saved = await api.patchWorkflow(baseLead.id, patch);
    state.confirmSaved(saved);
    toast("Lead updated");
    applyFilters({ resetLimit: false });
  } catch {
    button.disabled = false;
    button.textContent = "Update";
    toast("Update failed — please try again");
  }
}

function wireCard(article, baseLead, visibleIndex) {
  for (const [selector, field] of [[".status-input", "status"], [".followup-input", "followup"], [".remarks-input", "remarks"]]) {
    const input = article.querySelector(selector);
    input.addEventListener("input", () => state.rememberInput(baseLead.id, field, input.value));
  }
  article.querySelector(".update-btn").addEventListener("click", () => saveLead(baseLead, article));
  article.querySelector(".edit-lead").addEventListener("click", () => openEdit(baseLead.id));
  article.querySelector(".delete-lead").addEventListener("click", () => openDelete(baseLead.id));
  article.querySelector(".lead-select").addEventListener("click", event => {
    selection.toggle(baseLead.id, visibleIndex, event.shiftKey, filtered.map(item => item.id));
    render();
  });
}

async function loadAll() {
  setNotice("Loading shared leads...");
  try {
    const [leads, loadedCompartments] = await Promise.all([api.listLeads(), api.listCompartments()]);
    state.replaceLeads(leads);
    compartments = loadedCompartments;
    if (activeCompartmentId && !compartments.some(item => item.id === activeCompartmentId)) activeCompartmentId = "";
    setNotice("Shared lead data loaded", "success");
    applyFilters({ clearSelection: true });
  } catch {
    setNotice("Could not load shared lead data.", "warning");
    els.leadList.innerHTML = '<div class="empty">Lead data could not be loaded.<br><button id="retryLeads" class="load-more" type="button">Retry loading leads</button></div>';
    els.loadMore.hidden = true;
    document.getElementById("retryLeads").addEventListener("click", loadAll);
  }
}

async function refreshCompartments() {
  compartments = await api.listCompartments();
  render();
}

function openEdit(id) {
  const lead = state.valuesFor(id);
  activeEditId = id;
  els.editName.value = lead.name;
  els.editMobile.value = lead.mobile;
  els.editAddress.value = lead.address;
  els.editCity.value = lead.city;
  els.editCategory.value = lead.category;
  els.editDialog.showModal();
}

function openDelete(id) {
  activeDeleteId = id;
  els.deleteLeadName.textContent = state.valuesFor(id).name;
  els.deleteDialog.showModal();
}

function renderImportPreview(result, compartmentId = els.importCompartment.value) {
  const validRows = result.valid.map(lead => `<tr><td>${lead.index + 1}</td><td>${esc(lead.sno)}</td><td>${esc(lead.name)}</td><td>${esc(lead.city)}</td><td>Ready</td></tr>`);
  const invalidRows = result.errors.map(error => `<tr><td>${error.index + 1}</td><td>—</td><td colspan="2">${esc(error.field)}</td><td class="error-text">${esc(error.error)}</td></tr>`);
  els.importPreview.innerHTML = `<p class="destination-note">Destination: ${esc(compartmentName(compartmentId))}</p><p>${result.valid.length} valid, ${result.errors.length} issue(s)</p><div class="table-wrap"><table><thead><tr><th>Row</th><th>S.No</th><th>Name</th><th>City</th><th>Result</th></tr></thead><tbody>${[...validRows, ...invalidRows].join("")}</tbody></table></div>`;
  els.confirmImport.disabled = result.valid.length === 0;
}

function openImport() {
  importReview.invalidate();
  fileReadGuard.invalidate();
  els.jsonText.value = "";
  els.jsonFile.value = "";
  els.importNewCompartment.value = "";
  renderCompartmentOptions(els.importCompartment, activeCompartmentId, true);
  els.importPreview.textContent = "Choose a destination, paste JSON or choose a file, then preview it.";
  els.confirmImport.disabled = true;
  els.importDialog.showModal();
}

function renderCompartmentRows() {
  els.compartmentRows.innerHTML = compartments.map(item => `<div class="compartment-row" data-id="${esc(item.id)}">
    <input class="compartment-name-input" value="${esc(item.name)}" maxlength="80" aria-label="Compartment name">
    <button class="mini-btn rename-compartment" type="button">Rename</button>
    <button class="mini-btn export-compartment" type="button">Download (${item.count ?? 0})</button>
    <button class="mini-btn danger delete-compartment" type="button">Delete</button>
  </div>`).join("");
}

async function createCompartmentFrom(value, onCreated) {
  const name = value.trim();
  if (!name) return toast("Enter a compartment name");
  try {
    const created = await api.createCompartment(name);
    await refreshCompartments();
    onCreated?.(created);
    toast("Compartment created");
  } catch (error) { adminFailure(error, "Could not create compartment"); }
}

async function downloadCompartment(id) {
  try {
    const { blob, filename } = await api.downloadCompartment(id);
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  } catch (error) { adminFailure(error, "Download failed"); }
}

els.adminLogin.addEventListener("click", () => {
  els.loginError.textContent = "";
  els.loginDialog.showModal();
  els.adminPassword.focus();
});
els.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  els.loginError.textContent = "";
  try {
    await api.login(els.adminPassword.value);
    setAdminMode(true);
    els.loginDialog.close();
    toast("Admin mode enabled");
  } catch (error) { els.loginError.textContent = error.message; }
  finally { els.adminPassword.value = ""; }
});
els.adminLogout.addEventListener("click", async () => {
  try { await logoutAdmin({ api, setAdminMode, notify: toast }); }
  catch { /* the helper keeps admin mode active and shows a retry message */ }
});

els.compartmentNav.addEventListener("click", event => {
  const button = event.target.closest("[data-compartment]");
  if (!button) return;
  activeCompartmentId = button.dataset.compartment;
  applyFilters({ clearSelection: true });
});
els.filterToggle.addEventListener("click", () => {
  const open = els.filterPanel.classList.toggle("open");
  els.filterToggle.setAttribute("aria-expanded", String(open));
});
els.filterPanel.addEventListener("change", event => {
  if (!event.target.classList.contains("facet-checkbox")) return;
  const target = event.target.dataset.facet === "city" ? selectedCities : selectedCategories;
  if (event.target.checked) target.add(event.target.value);
  else target.delete(event.target.value);
  applyFilters({ clearSelection: true });
});

els.importLeads.addEventListener("click", openImport);
els.importCompartment.addEventListener("change", () => {
  importReview.invalidate();
  els.confirmImport.disabled = true;
  els.importPreview.textContent = "Destination changed. Preview the JSON again.";
});
els.createImportCompartment.addEventListener("click", () => createCompartmentFrom(els.importNewCompartment.value, created => {
  renderCompartmentOptions(els.importCompartment, created.id, true);
  els.importNewCompartment.value = "";
  importReview.invalidate();
}));
els.jsonText.addEventListener("input", () => {
  importReview.invalidate();
  fileReadGuard.invalidate();
  els.confirmImport.disabled = true;
});
els.jsonFile.addEventListener("change", async () => {
  importReview.invalidate();
  els.confirmImport.disabled = true;
  const token = fileReadGuard.begin();
  try {
    const text = await readJsonFile(els.jsonFile.files[0], { maxBytes: 2_000_000 });
    if (fileReadGuard.isCurrent(token)) els.jsonText.value = text;
  } catch (error) { if (fileReadGuard.isCurrent(token)) toast(error.message); }
});
els.previewImport.addEventListener("click", async () => {
  const compartmentId = els.importCompartment.value;
  if (!compartmentId) return toast("Choose a destination compartment");
  const parsed = parseImportText(els.jsonText.value);
  if (!parsed.ok) {
    importReview.invalidate();
    els.importPreview.textContent = parsed.error;
    els.confirmImport.disabled = true;
    return;
  }
  const attempt = importReview.begin(parsed.records, compartmentId);
  els.confirmImport.disabled = true;
  els.importPreview.textContent = "Checking JSON...";
  try {
    const result = await api.previewImport(attempt.records, attempt.compartmentId);
    if (importReview.accept(attempt.token, result)) renderImportPreview(result, attempt.compartmentId);
  } catch (error) {
    const message = failImportPreview(importReview, attempt.token, error);
    if (message) {
      els.importPreview.textContent = message;
      adminFailure(error, "Preview failed");
    }
  }
});
els.confirmImport.addEventListener("click", async () => {
  const reviewed = importReview.confirmPayload();
  if (!reviewed) return;
  els.confirmImport.disabled = true;
  try {
    const result = await api.importLeads(reviewed.records, reviewed.requestId, reviewed.compartmentId);
    const complete = importReview.complete(result);
    result.imported.forEach(record => state.upsertLead(record));
    await refreshCompartments();
    applyFilters();
    if (complete) {
      toast(`Imported ${result.imported.length} lead(s)`);
      els.importDialog.close();
    } else {
      renderImportPreview({ valid: [], errors: result.errors }, reviewed.compartmentId);
      els.confirmImport.disabled = false;
      toast(`Imported ${result.imported.length}; ${result.errors.length} row(s) can be retried`);
    }
  } catch (error) {
    adminFailure(error, "Import failed");
    els.confirmImport.disabled = !importReview.confirmPayload();
  }
});

els.manageCompartments.addEventListener("click", () => {
  renderCompartmentRows();
  els.newCompartmentName.value = "";
  els.compartmentDialog.showModal();
});
els.createCompartment.addEventListener("click", () => createCompartmentFrom(els.newCompartmentName.value, () => {
  els.newCompartmentName.value = "";
  renderCompartmentRows();
}));
els.compartmentRows.addEventListener("click", async event => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  if (event.target.classList.contains("rename-compartment")) {
    try {
      await api.renameCompartment(id, row.querySelector(".compartment-name-input").value);
      await refreshCompartments();
      renderCompartmentRows();
      toast("Compartment renamed");
    } catch (error) { adminFailure(error, "Rename failed"); }
  } else if (event.target.classList.contains("export-compartment")) {
    await downloadCompartment(id);
  } else if (event.target.classList.contains("delete-compartment")) {
    activeDeleteCompartmentId = id;
    const compartment = compartments.find(item => item.id === id);
    els.deleteCompartmentLabel.textContent = compartment.name;
    els.deleteCompartmentName.value = "";
    els.deleteCompartmentDialog.showModal();
  }
});
els.confirmCompartmentDelete.addEventListener("click", async () => {
  const compartment = compartments.find(item => item.id === activeDeleteCompartmentId);
  if (!compartment || els.deleteCompartmentName.value !== compartment.name) return toast("Type the exact compartment name");
  els.confirmCompartmentDelete.disabled = true;
  try {
    await api.deleteCompartment(compartment.id, els.deleteCompartmentName.value);
    if (activeCompartmentId === compartment.id) activeCompartmentId = "";
    els.deleteCompartmentDialog.close();
    els.compartmentDialog.close();
    await loadAll();
    toast("Compartment and its leads deleted");
  } catch (error) { adminFailure(error, "Deletion failed; retry to continue"); }
  finally { els.confirmCompartmentDelete.disabled = false; }
});

els.moveSelected.addEventListener("click", async () => {
  const leadIds = selection.ids();
  const compartmentId = els.moveDestination.value;
  if (!leadIds.length || !compartmentId) return;
  els.moveSelected.disabled = true;
  try {
    const result = await api.moveLeads(leadIds, compartmentId);
    [...result.moved, ...result.unchanged].forEach(record => state.upsertLead(record));
    const failed = new Set(result.errors.map(error => String(error.id)));
    selection.clear();
    applyFilters();
    const visibleIds = filtered.map(item => String(item.id));
    for (const id of failed) {
      const index = visibleIds.indexOf(id);
      if (index >= 0) selection.toggle(id, index, false, visibleIds);
    }
    render();
    toast(result.errors.length ? `${result.moved.length} moved; ${result.errors.length} failed` : `${result.moved.length} lead(s) moved`);
  } catch (error) { adminFailure(error, "Move failed"); }
  finally { els.moveSelected.disabled = false; }
});
els.clearSelection.addEventListener("click", () => { selection.clear(); render(); });

els.editForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const record = await api.updateLead(activeEditId, {
      name: els.editName.value,
      mobile: els.editMobile.value,
      address: els.editAddress.value,
      city: els.editCity.value,
      category: els.editCategory.value
    });
    state.upsertLead(record);
    els.editDialog.close();
    applyFilters({ resetLimit: false });
    toast("Lead details updated");
  } catch (error) { adminFailure(error, "Edit failed"); }
});
els.confirmDelete.addEventListener("click", async () => {
  els.confirmDelete.disabled = true;
  try {
    await api.deleteLead(activeDeleteId);
    state.removeLead(activeDeleteId);
    els.deleteDialog.close();
    applyFilters({ resetLimit: false });
    toast("Lead deleted");
  } catch (error) { adminFailure(error, "Delete failed"); }
  finally { els.confirmDelete.disabled = false; }
});
els.downloadBackup.addEventListener("click", async () => {
  try {
    const { blob, filename } = await api.downloadBackup();
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  } catch (error) { adminFailure(error, "Backup failed"); }
});

const savedTemplate = localStorage.getItem("telecaller_wa_template");
els.waTemplate.value = savedTemplate || DEFAULT_WA;
els.waTemplate.addEventListener("change", () => {
  localStorage.setItem("telecaller_wa_template", els.waTemplate.value);
  toast("WhatsApp message saved");
  applyFilters({ resetLimit: false });
});
els.search.addEventListener("input", () => applyFilters({ clearSelection: true }));
els.statusFilter.addEventListener("change", () => applyFilters({ clearSelection: true }));
els.areaSort.addEventListener("change", () => applyFilters({ clearSelection: true }));
els.clearFilters.addEventListener("click", () => {
  els.search.value = "";
  els.statusFilter.value = "";
  els.areaSort.value = "";
  activeCompartmentId = "";
  selectedCities = new Set();
  selectedCategories = new Set();
  applyFilters({ clearSelection: true });
});
els.loadMore.addEventListener("click", () => { renderLimit += PAGE_SIZE; render(); });
els.jumpTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
window.addEventListener("scroll", () => { els.jumpTop.style.display = window.scrollY > 500 ? "block" : "none"; }, { passive: true });
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));

async function initialize() {
  setAdminMode(false);
  const [, authenticated] = await Promise.all([loadAll(), api.session().catch(() => false)]);
  setAdminMode(authenticated);
}

initialize();
