export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function createApiClient(fetchImpl = fetch, { timeoutMs = 30_000 } = {}) {
  async function withTimeout(operation) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("Request took too long. Please try again.", 408);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requestJson(path, { method = "GET", body } = {}) {
    return withTimeout(async signal => {
      const options = { method, credentials: "same-origin", signal, headers: { accept: "application/json" } };
      if (body !== undefined) {
        options.headers["content-type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const response = await fetchImpl(path, options);
      let payload = {};
      try { payload = await response.json(); }
      catch (error) {
        if (signal.aborted) throw error;
        payload = {};
      }
      if (!response.ok) throw new ApiError(payload.error || "Request failed.", response.status, payload.errors);
      return payload;
    });
  }

  async function download(path, fallbackName, failureMessage) {
    return withTimeout(async signal => {
      const response = await fetchImpl(path, { method: "GET", credentials: "same-origin", signal, headers: { accept: "application/json" } });
      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); }
        catch (error) {
          if (signal.aborted) throw error;
          payload = {};
        }
        throw new ApiError(payload.error || failureMessage, response.status);
      }
      const disposition = response.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || fallbackName;
      return { blob: await response.blob(), filename };
    });
  }

  return {
    async listLeads() { return (await requestJson("/api/leads")).leads; },
    async listCompartments() { return (await requestJson("/api/compartments")).compartments; },
    async patchWorkflow(id, patch) { return (await requestJson(`/api/leads/${encodeURIComponent(id)}/workflow`, { method: "PATCH", body: patch })).lead; },
    async session() { return (await requestJson("/api/admin/session")).authenticated; },
    async login(password) { return (await requestJson("/api/admin/login", { method: "POST", body: { password } })).authenticated; },
    async logout() { return (await requestJson("/api/admin/logout", { method: "POST", body: {} })).authenticated; },
    async previewImport(records, compartmentId) { return requestJson("/api/leads/import", { method: "POST", body: { preview: true, compartmentId, records } }); },
    async importLeads(records, requestId, compartmentId) { return requestJson("/api/leads/import", { method: "POST", body: { preview: false, requestId, compartmentId, records } }); },
    async createCompartment(name) { return (await requestJson("/api/admin/compartments", { method: "POST", body: { name } })).compartment; },
    async renameCompartment(id, name) { return (await requestJson(`/api/admin/compartments/${encodeURIComponent(id)}`, { method: "PUT", body: { name } })).compartment; },
    async deleteCompartment(id, confirmation) { return requestJson(`/api/admin/compartments/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmation } }); },
    async moveLeads(leadIds, compartmentId) { return requestJson("/api/admin/leads/move", { method: "POST", body: { leadIds, compartmentId } }); },
    async downloadCompartment(id) { return download(`/api/admin/compartments/${encodeURIComponent(id)}/export`, "compartment-leads.json", "Compartment download failed."); },
    async updateLead(id, core) { return (await requestJson(`/api/leads/${encodeURIComponent(id)}`, { method: "PUT", body: core })).lead; },
    async deleteLead(id) { return requestJson(`/api/leads/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async downloadBackup() {
      return download("/api/admin/export", "telecaller-leads.json", "Backup download failed.");
    }
  };
}
