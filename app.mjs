import { createApiClient, ApiError } from "./client-api.mjs";
import { logoutAdmin } from "./client-actions.mjs";
import { createImportReviewState, createLatestReadGuard, failImportPreview, parseImportText, readJsonFile } from "./client-import.mjs";
import { createLeadState, matchesLead } from "./client-state.mjs";

window.__leadAppStarted = true;

const STATUS_OPTIONS = ["Not Called", "Called", "No Answer", "Follow-up", "Interested", "Not Interested"];
const DEFAULT_WA = "Hello, I’m contacting {name} regarding a business enquiry. Please let me know a convenient time to connect. Thank you.";
const PAGE_SIZE = 40;
const api = createApiClient();
const state = createLeadState();

const els = Object.fromEntries([
  "leadList", "search", "statusFilter", "clearFilters", "loadMore", "visibleCount", "topCount",
  "waTemplate", "jumpTop", "toast", "syncNotice", "adminLogin", "adminLogout", "importLeads",
  "downloadBackup", "loginDialog", "loginForm", "adminPassword", "loginError", "importDialog",
  "jsonText", "jsonFile", "previewImport", "confirmImport", "importPreview", "editDialog", "editForm",
  "editName", "editMobile", "editAddress", "editCategory", "deleteDialog", "deleteLeadName", "confirmDelete"
].map(id => [id, document.getElementById(id)]));

let renderLimit = PAGE_SIZE;
let filtered = [];
const importReview = createImportReviewState();
const fileReadGuard = createLatestReadGuard();
let activeEditId = "";
let activeDeleteId = "";

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

function setAdminMode(enabled) {
  document.body.dataset.admin = String(Boolean(enabled));
  els.adminLogin.hidden = Boolean(enabled);
  els.adminLogout.hidden = !enabled;
}

function setNotice(message, kind = "") {
  els.syncNotice.textContent = message;
  els.syncNotice.className = `sync-notice${kind ? ` ${kind}` : ""}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function statusOptions(selected) {
  return STATUS_OPTIONS.map(status => `<option${status === selected ? " selected" : ""}>${status}</option>`).join("");
}

function cardHtml(baseLead) {
  const lead = state.valuesFor(baseLead.id) || baseLead;
  const number = normalizeIndiaNumber(lead.mobile);
  const message = encodeURIComponent((els.waTemplate.value || DEFAULT_WA).replaceAll("{name}", lead.name));
  return `<article class="card" data-id="${esc(lead.id)}">
    <div class="card-head">
      <div class="sno">LEAD #${esc(lead.sno)}</div>
      <h2 class="biz">${esc(lead.name)}</h2>
      <a class="phone" href="tel:${esc(number.tel)}">${esc(lead.mobile)}</a>
    </div>
    <div class="card-body">
      <div class="meta">
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

async function saveLead(baseLead, article) {
  const patch = state.changedWorkflow(baseLead.id);
  if (Object.keys(patch).length === 0) return toast("No changes to save");
  const button = article.querySelector(".update-btn");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const saved = await api.patchWorkflow(baseLead.id, patch);
    state.confirmSaved(saved);
    button.textContent = "Saved";
    button.classList.add("saved");
    toast("Lead updated");
    setTimeout(() => applyFilters(false), 450);
  } catch {
    button.disabled = false;
    button.textContent = "Update";
    toast("Update failed — please try again");
  }
}

function wireCard(article, baseLead) {
  for (const [selector, field] of [[".status-input", "status"], [".followup-input", "followup"], [".remarks-input", "remarks"]]) {
    const input = article.querySelector(selector);
    input.addEventListener("input", () => state.rememberInput(baseLead.id, field, input.value));
  }
  article.querySelector(".update-btn").addEventListener("click", () => saveLead(baseLead, article));
  article.querySelector(".edit-lead").addEventListener("click", () => openEdit(baseLead.id));
  article.querySelector(".delete-lead").addEventListener("click", () => openDelete(baseLead.id));
}

function render() {
  const visible = filtered.slice(0, renderLimit);
  els.topCount.textContent = `${state.allLeads().length} leads`;
  els.visibleCount.textContent = `Showing ${visible.length} of ${filtered.length}`;
  els.loadMore.hidden = visible.length >= filtered.length;
  if (!visible.length) {
    els.leadList.innerHTML = '<div class="empty">No leads match the current filters.</div>';
    return;
  }
  els.leadList.innerHTML = visible.map(cardHtml).join("");
  els.leadList.querySelectorAll(".card").forEach((article, index) => wireCard(article, visible[index]));
}

function applyFilters(resetLimit = true) {
  if (resetLimit) renderLimit = PAGE_SIZE;
  const query = els.search.value.trim().toLowerCase();
  const status = els.statusFilter.value;
  filtered = state.allLeads().filter(baseLead => {
    const lead = state.valuesFor(baseLead.id);
    return matchesLead(lead, query, status);
  });
  render();
}

async function loadLeads() {
  setNotice("Loading shared leads...");
  els.leadList.innerHTML = "";
  try {
    state.replaceLeads(await api.listLeads());
    setNotice("Shared lead data loaded", "success");
    applyFilters(true);
  } catch {
    setNotice("Could not load shared lead data.", "warning");
    els.leadList.innerHTML = '<div class="empty">Lead data could not be loaded.<br><button id="retryLeads" class="load-more" type="button">Retry loading leads</button></div>';
    els.loadMore.hidden = true;
    document.getElementById("retryLeads").addEventListener("click", loadLeads);
  }
}

function adminFailure(error, fallback) {
  if (error instanceof ApiError && error.status === 401) {
    setAdminMode(false);
    toast("Admin session expired. Please log in again.");
  } else toast(error.message || fallback);
}

function openEdit(id) {
  const lead = state.valuesFor(id);
  activeEditId = id;
  els.editName.value = lead.name;
  els.editMobile.value = lead.mobile;
  els.editAddress.value = lead.address;
  els.editCategory.value = lead.category;
  els.editDialog.showModal();
}

function openDelete(id) {
  activeDeleteId = id;
  els.deleteLeadName.textContent = state.valuesFor(id).name;
  els.deleteDialog.showModal();
}

function renderImportPreview(result) {
  const validRows = result.valid.map(lead => `<tr><td>${lead.index + 1}</td><td>${esc(lead.sno)}</td><td>${esc(lead.name)}</td><td>${esc(lead.mobile)}</td><td>Ready</td></tr>`);
  const invalidRows = result.errors.map(error => `<tr><td>${error.index + 1}</td><td>—</td><td colspan="2">${esc(error.field)}</td><td class="error-text">${esc(error.error)}</td></tr>`);
  els.importPreview.innerHTML = `<p>${result.valid.length} valid, ${result.errors.length} issue(s)</p><div class="table-wrap"><table><thead><tr><th>Row</th><th>S.No</th><th>Name</th><th>Mobile</th><th>Result</th></tr></thead><tbody>${[...validRows, ...invalidRows].join("")}</tbody></table></div>`;
  els.confirmImport.disabled = result.valid.length === 0;
}

els.adminLogin.addEventListener("click", () => { els.loginError.textContent = ""; els.loginDialog.showModal(); els.adminPassword.focus(); });
els.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  els.loginError.textContent = "";
  try {
    await api.login(els.adminPassword.value);
    setAdminMode(true);
    els.loginDialog.close();
    toast("Admin mode enabled");
  } catch (error) {
    els.loginError.textContent = error.message;
  } finally {
    els.adminPassword.value = "";
  }
});
els.adminLogout.addEventListener("click", async () => {
  try { await logoutAdmin({ api, setAdminMode, notify: toast }); }
  catch { /* logoutAdmin keeps admin mode active and shows the retry message */ }
});
els.importLeads.addEventListener("click", () => {
  importReview.invalidate();
  fileReadGuard.invalidate();
  els.jsonText.value = "";
  els.jsonFile.value = "";
  els.importPreview.textContent = "Paste JSON or choose a file, then preview it.";
  els.confirmImport.disabled = true;
  els.importDialog.showModal();
});
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
  } catch (error) {
    if (fileReadGuard.isCurrent(token)) toast(error.message);
  }
});
els.previewImport.addEventListener("click", async () => {
  const parsed = parseImportText(els.jsonText.value);
  if (!parsed.ok) { importReview.invalidate(); els.importPreview.textContent = parsed.error; els.confirmImport.disabled = true; return; }
  const attempt = importReview.begin(parsed.records);
  els.confirmImport.disabled = true;
  els.importPreview.textContent = "Checking JSON...";
  try {
    const result = await api.previewImport(attempt.records);
    if (importReview.accept(attempt.token, result)) renderImportPreview(result);
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
    const result = await api.importLeads(reviewed.records, reviewed.requestId);
    const complete = importReview.complete(result);
    result.imported.forEach(record => state.upsertLead(record));
    applyFilters(true);
    if (complete) {
      toast(`Imported ${result.imported.length} lead(s)`);
      els.importDialog.close();
    }
    else {
      renderImportPreview({ valid: [], errors: result.errors });
      els.confirmImport.disabled = false;
      toast(`Imported ${result.imported.length}; ${result.errors.length} row(s) can be retried`);
    }
  } catch (error) {
    adminFailure(error, "Import failed");
    els.confirmImport.disabled = !importReview.confirmPayload();
  }
});
els.editForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const record = await api.updateLead(activeEditId, {
      name: els.editName.value, mobile: els.editMobile.value,
      address: els.editAddress.value, category: els.editCategory.value
    });
    state.upsertLead(record);
    els.editDialog.close();
    applyFilters(false);
    toast("Lead details updated");
  } catch (error) { adminFailure(error, "Edit failed"); }
});
els.confirmDelete.addEventListener("click", async () => {
  els.confirmDelete.disabled = true;
  try {
    await api.deleteLead(activeDeleteId);
    state.removeLead(activeDeleteId);
    els.deleteDialog.close();
    applyFilters(false);
    toast("Lead deleted");
  } catch (error) { adminFailure(error, "Delete failed"); }
  finally { els.confirmDelete.disabled = false; }
});
els.downloadBackup.addEventListener("click", async () => {
  try {
    const { blob, filename } = await api.downloadBackup();
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), { href: url, download: filename });
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) { adminFailure(error, "Backup failed"); }
});

const savedTemplate = localStorage.getItem("telecaller_wa_template");
els.waTemplate.value = savedTemplate || DEFAULT_WA;
els.waTemplate.addEventListener("change", () => { localStorage.setItem("telecaller_wa_template", els.waTemplate.value); toast("WhatsApp message saved"); applyFilters(false); });
els.search.addEventListener("input", () => applyFilters(true));
els.statusFilter.addEventListener("change", () => applyFilters(true));
els.clearFilters.addEventListener("click", () => { els.search.value = ""; els.statusFilter.value = ""; applyFilters(true); });
els.loadMore.addEventListener("click", () => { renderLimit += PAGE_SIZE; render(); });
els.jumpTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
window.addEventListener("scroll", () => { els.jumpTop.style.display = window.scrollY > 500 ? "block" : "none"; }, { passive: true });
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));

async function initialize() {
  setAdminMode(false);
  const [, authenticated] = await Promise.all([loadLeads(), api.session().catch(() => false)]);
  setAdminMode(authenticated);
}

initialize();
