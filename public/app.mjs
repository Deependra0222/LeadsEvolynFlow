import { createApiClient, ApiError } from "./client-api.mjs";
import { logoutAdmin } from "./client-actions.mjs";
import { createImportReviewState, createLatestReadGuard, failImportPreview, parseImportText, readJsonFile } from "./client-import.mjs";
import { buildLeadFacets, canSelectLeadForMove, createLeadState, createRangeSelection, filterAndSortLeads } from "./client-state.mjs";

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
  "deleteCompartmentDialog", "deleteCompartmentLabel", "deleteCompartmentCount", "deleteCompartmentName",
  "downloadBeforeCompartmentDelete", "confirmCompartmentDelete",
  "bulkMoveBar", "selectedCount", "moveDestination", "moveSelected", "clearSelection",
  "folderIcon", "folderCrumb", "folderTitle", "folderActions", "folderImport", "folderDownload", "folderRename",
  "folderDelete", "statusStats", "filterCount", "newFolderQuick", "renameDialog", "renameForm", "renameInput",
  "dropZone", "dropZoneText"
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
let activeRenameId = "";

const STATUS_CLASS = {
  "Not Called": "st-not-called", "Called": "st-called", "No Answer": "st-no-answer",
  "Follow-up": "st-follow-up", "Interested": "st-interested", "Not Interested": "st-not-interested"
};
const STATUS_COLOR = {
  "Not Called": "#98a2b3", "Called": "#1769e0", "No Answer": "#b54708",
  "Follow-up": "#6941c6", "Interested": "#179c52", "Not Interested": "#b42318"
};
const ICONS = {
  folder: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="#d99a1e" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.1l2 2.2h6.9A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path fill="#f5b83d" d="M3 9.2A2.2 2.2 0 0 1 5.2 7h13.6A2.2 2.2 0 0 1 21 9.2v8.3a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>`,
  folderOpen: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path fill="#d99a1e" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.1l2 2.2h6.9A2.5 2.5 0 0 1 21 8.7V10H3z"/><path fill="#f5b83d" d="M2.2 11.4A1.6 1.6 0 0 1 3.8 9.5h16.9a1.6 1.6 0 0 1 1.6 1.9l-1.2 6.6a2.5 2.5 0 0 1-2.5 2H5.4a2.5 2.5 0 0 1-2.5-2z"/></svg>`,
  stack: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#1769e0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>`,
  pin: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
  city: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V7l6-4v18M19 21V11l-8-4"/></svg>`,
  tag: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`,
  phone: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>`,
  whatsapp: `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3z"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`
};

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
  return compartments.find(item => item.id === id)?.name || "Unavailable folder";
}

function renderCompartmentOptions(select, selected = "", includePlaceholder = false) {
  const options = compartments.map(item => `<option value="${esc(item.id)}"${item.id === selected ? " selected" : ""}>${esc(item.name)} (${item.count ?? 0})</option>`);
  select.innerHTML = `${includePlaceholder ? '<option value="">Choose a folder</option>' : ""}${options.join("")}`;
}

function folderButton(id, name, count, icon) {
  const active = activeCompartmentId === id;
  return `<button class="folder-item compartment-tab${active ? " active" : ""}" type="button" data-compartment="${esc(id)}"${active ? ' aria-current="true"' : ""} title="${esc(name)}">
    ${icon}<span class="folder-name">${esc(name)}</span><span class="folder-count">${count}</span>
  </button>`;
}

function renderCompartmentNav() {
  const facets = buildLeadFacets(state.allLeads(), compartments);
  compartments = facets.compartments;
  els.compartmentNav.innerHTML = [
    folderButton("", "All Leads", state.allLeads().length, ICONS.stack(19)),
    '<div class="folder-divider" role="presentation"></div>',
    ...compartments.map(item => folderButton(item.id, item.name, item.count, activeCompartmentId === item.id ? ICONS.folderOpen() : ICONS.folder()))
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
  const chips = [
    ...[...selectedCities].map(value => ({ facet: "city", value, label: `City: ${value}` })),
    ...[...selectedCategories].map(value => ({ facet: "category", value, label: `Category: ${value}` }))
  ];
  els.activeFilters.innerHTML = chips.map(chip => `<button class="filter-chip" type="button" data-remove-facet="${chip.facet}" data-value="${esc(chip.value)}" aria-label="Remove filter ${esc(chip.label)}">${esc(chip.label)} ✕</button>`).join("");
  els.filterCount.textContent = String(chips.length);
  els.filterCount.hidden = chips.length === 0;
}

function renderFolderHero() {
  const compartment = compartments.find(item => item.id === activeCompartmentId);
  els.folderIcon.className = `hero-icon${compartment ? "" : " all"}`;
  els.folderIcon.innerHTML = compartment ? ICONS.folderOpen(30) : ICONS.stack(28);
  els.folderCrumb.textContent = compartment ? `Folder · ${compartment.count ?? 0} lead${compartment.count === 1 ? "" : "s"}` : `All folders · ${state.allLeads().length} leads`;
  els.folderTitle.textContent = compartment ? compartment.name : "All Leads";
  els.folderActions.hidden = !adminEnabled || !compartment;
}

function renderStats() {
  const scoped = state.allLeads()
    .map(lead => state.valuesFor(lead.id))
    .filter(lead => !activeCompartmentId || lead.compartmentId === activeCompartmentId);
  const counts = new Map(STATUS_OPTIONS.map(status => [status, 0]));
  for (const lead of scoped) counts.set(lead.status, (counts.get(lead.status) || 0) + 1);
  const current = els.statusFilter.value;
  els.statusStats.innerHTML = [
    `<button class="stat${current ? "" : " active"}" type="button" data-status=""><span class="dot" style="background:#0b2f59"></span>All <strong>${scoped.length}</strong></button>`,
    ...STATUS_OPTIONS.map(status => `<button class="stat${current === status ? " active" : ""}" type="button" data-status="${esc(status)}"><span class="dot" style="background:${STATUS_COLOR[status]}"></span>${esc(status)} <strong>${counts.get(status)}</strong></button>`)
  ].join("");
}

function cardHtml(baseLead) {
  const lead = state.valuesFor(baseLead.id) || baseLead;
  const number = normalizeIndiaNumber(lead.mobile);
  const message = encodeURIComponent((els.waTemplate.value || DEFAULT_WA).replaceAll("{name}", lead.name));
  const selected = new Set(selection.ids()).has(String(lead.id));
  const selectionControl = canSelectLeadForMove(activeCompartmentId, lead)
    ? `<label class="card-select admin-only"><input class="lead-select" type="checkbox"${selected ? " checked" : ""}> Select lead</label>`
    : "";
  const confirmedStatus = state.confirmedFor(lead.id)?.status || lead.status;
  return `<article class="card${selected ? " selected" : ""}" data-id="${esc(lead.id)}">
    <div class="card-head">
      ${selectionControl}
      <div class="card-top">
        <span class="sno">LEAD #${esc(lead.sno)}</span>
        <span class="status-pill ${STATUS_CLASS[confirmedStatus] || ""}">${esc(confirmedStatus)}</span>
      </div>
      <h2 class="biz">${esc(lead.name)}</h2>
      <a class="phone" href="tel:${esc(number.tel)}">${ICONS.phone}${esc(lead.mobile)}</a>
    </div>
    <div class="card-body">
      <div class="meta">
        <div class="meta-row" title="Folder">${ICONS.folder(16)}<div class="value"><span class="compartment-badge">${esc(compartmentName(lead.compartmentId))}</span></div></div>
        <div class="meta-row" title="City / Area">${ICONS.city}<div class="value">${esc(lead.city || "Unknown")}</div></div>
        <div class="meta-row" title="Area/Address">${ICONS.pin}<div class="value">${lead.address ? esc(lead.address) : '<span class="muted">No address</span>'}</div></div>
        <div class="meta-row" title="Category">${ICONS.tag}<div class="value">${lead.category ? esc(lead.category) : '<span class="muted">No category</span>'}</div></div>
      </div>
      <div class="actions">
        <a class="action call" href="tel:${esc(number.tel)}">${ICONS.phone} Call</a>
        <a class="action wa" href="https://wa.me/${esc(number.wa)}?text=${message}" target="_blank" rel="noopener">${ICONS.whatsapp} WhatsApp</a>
      </div>
      <div class="work-grid">
        <div class="field"><label>Call status</label><select class="status-input">${statusOptions(lead.status)}</select></div>
        <div class="field"><label>Follow-up</label><input class="followup-input" type="datetime-local" value="${esc(lead.followup)}"></div>
        <div class="field remarks-field"><label>Remarks</label><textarea class="remarks-input" maxlength="5000" placeholder="Add notes…">${esc(lead.remarks)}</textarea></div>
      </div>
      <div class="card-foot">
        <button class="update-btn" type="button">Update</button>
        <div class="admin-actions admin-only">
          <button class="admin-only edit-lead" type="button">${ICONS.edit} Edit Lead</button>
          <button class="admin-only delete-lead" type="button">${ICONS.trash} Delete Lead</button>
        </div>
      </div>
    </div>
  </article>`;
}

function renderBulkBar() {
  const count = selection.ids().length;
  els.selectedCount.textContent = `${count} selected`;
  els.bulkMoveBar.hidden = !adminEnabled || count === 0;
}

function restoreRenderedFocus(focusTarget) {
  if (!focusTarget) return;
  let target = null;
  if (focusTarget.kind === "facet") {
    target = [...els.filterPanel.querySelectorAll(".facet-checkbox")].find(input =>
      input.dataset.facet === focusTarget.facet && input.value === focusTarget.value
    );
  } else if (focusTarget.kind === "lead-selection") {
    const card = [...els.leadList.querySelectorAll(".card")].find(item => item.dataset.id === focusTarget.id);
    target = card?.querySelector(".lead-select");
  } else if (focusTarget.kind === "status") {
    target = [...els.statusStats.querySelectorAll("[data-status]")].find(button => button.dataset.status === focusTarget.status);
  } else if (focusTarget.kind === "compartment") {
    target = [...els.compartmentNav.querySelectorAll("[data-compartment]")].find(button =>
      button.dataset.compartment === focusTarget.id
    );
  }
  target?.focus();
}

function render(focusTarget = null) {
  renderCompartmentNav();
  renderFolderHero();
  renderStats();
  renderFilters();
  const visible = filtered.slice(0, renderLimit);
  els.topCount.textContent = `${state.allLeads().length} leads`;
  els.visibleCount.textContent = `Showing ${visible.length} of ${filtered.length}`;
  els.loadMore.hidden = visible.length >= filtered.length;
  renderBulkBar();
  if (!visible.length) {
    els.leadList.innerHTML = `<div class="empty">${ICONS.folder(40)}<strong>No leads here</strong>${state.allLeads().length ? "No leads match the current folder and filters." : "Import leads to get started."}</div>`;
    restoreRenderedFocus(focusTarget);
    return;
  }
  els.leadList.innerHTML = visible.map(cardHtml).join("");
  els.leadList.querySelectorAll(".card").forEach((article, index) => wireCard(article, visible[index], index));
  restoreRenderedFocus(focusTarget);
}

function applyFilters({ resetLimit = true, clearSelection = false, focusTarget = null } = {}) {
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
  render(focusTarget);
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
  const selectLead = article.querySelector(".lead-select");
  if (selectLead) selectLead.addEventListener("click", event => {
      selection.toggle(baseLead.id, visibleIndex, event.shiftKey, filtered.map(item => item.id));
      render({ kind: "lead-selection", id: String(baseLead.id) });
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
  els.dropZoneText.innerHTML = "<b>Upload a JSON file</b> — click or drag it here";
  renderCompartmentOptions(els.importCompartment, activeCompartmentId, true);
  els.importPreview.textContent = "Choose a destination, paste JSON or choose a file, then preview it.";
  els.confirmImport.disabled = true;
  els.importDialog.showModal();
}

function renderCompartmentRows() {
  els.compartmentRows.innerHTML = compartments.map(item => `<div class="compartment-row" data-id="${esc(item.id)}">
    ${ICONS.folder(24)}
    <input class="compartment-name-input" value="${esc(item.name)}" maxlength="80" aria-label="Compartment name">
    <button class="mini-btn rename-compartment" type="button">Rename</button>
    <button class="mini-btn export-compartment" type="button">Download (${item.count ?? 0})</button>
    <button class="mini-btn danger delete-compartment" type="button">Delete</button>
  </div>`).join("");
}

async function createCompartmentFrom(value, onCreated) {
  const name = value.trim();
  if (!name) return toast("Enter a folder name");
  try {
    const created = await api.createCompartment(name);
    await refreshCompartments();
    onCreated?.(created);
    toast("Folder created");
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
  if (window.matchMedia("(max-width:900px)").matches) els.folderTitle.scrollIntoView({ block: "nearest" });
  applyFilters({ clearSelection: true, focusTarget: { kind: "compartment", id: activeCompartmentId } });
});
els.statusStats.addEventListener("click", event => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  els.statusFilter.value = button.dataset.status;
  applyFilters({ clearSelection: true, focusTarget: { kind: "status", status: button.dataset.status } });
});
els.activeFilters.addEventListener("click", event => {
  const chip = event.target.closest("[data-remove-facet]");
  if (!chip) return;
  (chip.dataset.removeFacet === "city" ? selectedCities : selectedCategories).delete(chip.dataset.value);
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
  applyFilters({
    clearSelection: true,
    focusTarget: { kind: "facet", facet: event.target.dataset.facet, value: event.target.value }
  });
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
async function loadImportFile(file) {
  if (!file) return;
  importReview.invalidate();
  els.confirmImport.disabled = true;
  const token = fileReadGuard.begin();
  try {
    const text = await readJsonFile(file, { maxBytes: 2_000_000 });
    if (fileReadGuard.isCurrent(token)) {
      els.jsonText.value = text;
      els.dropZoneText.innerHTML = `<b>${esc(file.name)}</b> loaded — select Preview JSON`;
    }
  } catch (error) { if (fileReadGuard.isCurrent(token)) toast(error.message); }
}
els.jsonFile.addEventListener("change", () => loadImportFile(els.jsonFile.files[0]));
for (const type of ["dragenter", "dragover"]) {
  els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.dropZone.addEventListener(type, () => els.dropZone.classList.remove("dragging"));
}
els.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  loadImportFile(event.dataTransfer?.files?.[0]);
});
els.previewImport.addEventListener("click", async () => {
  const compartmentId = els.importCompartment.value;
  if (!compartmentId) return toast("Choose a destination folder");
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

els.manageCompartments.addEventListener("click", openManageFolders);
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
      toast("Folder renamed");
    } catch (error) { adminFailure(error, "Rename failed"); }
  } else if (event.target.classList.contains("export-compartment")) {
    await downloadCompartment(id);
  } else if (event.target.classList.contains("delete-compartment")) {
    openCompartmentDelete(id);
  }
});

function openCompartmentDelete(id) {
  const compartment = compartments.find(item => item.id === id);
  if (!compartment) return;
  activeDeleteCompartmentId = id;
  els.deleteCompartmentLabel.textContent = compartment.name;
  els.deleteCompartmentCount.textContent = `${compartment.count ?? 0} lead${compartment.count === 1 ? "" : "s"}`;
  els.deleteCompartmentName.value = "";
  els.deleteCompartmentDialog.showModal();
}

function openManageFolders() {
  renderCompartmentRows();
  els.newCompartmentName.value = "";
  els.compartmentDialog.showModal();
  els.newCompartmentName.focus();
}

els.folderImport.addEventListener("click", openImport);
els.folderDownload.addEventListener("click", () => { if (activeCompartmentId) downloadCompartment(activeCompartmentId); });
els.folderDelete.addEventListener("click", () => openCompartmentDelete(activeCompartmentId));
els.folderRename.addEventListener("click", () => {
  const compartment = compartments.find(item => item.id === activeCompartmentId);
  if (!compartment) return;
  activeRenameId = compartment.id;
  els.renameInput.value = compartment.name;
  els.renameDialog.showModal();
  els.renameInput.select();
});
els.renameForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await api.renameCompartment(activeRenameId, els.renameInput.value);
    await refreshCompartments();
    els.renameDialog.close();
    toast("Folder renamed");
  } catch (error) { adminFailure(error, "Rename failed"); }
});
els.newFolderQuick.addEventListener("click", openManageFolders);
els.downloadBeforeCompartmentDelete.addEventListener("click", () => {
  if (activeDeleteCompartmentId) downloadCompartment(activeDeleteCompartmentId);
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
    toast("Folder and its leads deleted");
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
