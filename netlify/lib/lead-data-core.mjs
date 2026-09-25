import {
  LIMITS,
  validateCorePatch,
  validateImportRecords,
  validateLeadIdentifier,
  validateWorkflowPatch
} from "./lead-model.mjs";
import { validateCompartmentIdentifier } from "./compartment-model.mjs";

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders }
  });
}

function apiPath(pathname) {
  if (pathname.startsWith("/api/")) return pathname;
  const prefix = "/.netlify/functions/lead-data";
  if (!pathname.startsWith(prefix)) return pathname;
  const suffix = pathname.slice(prefix.length);
  if (!suffix) return "/api/leads";
  if (suffix === "/admin" || suffix.startsWith("/admin/")) return `/api${suffix}`;
  return `/api/leads${suffix}`;
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: json({ error: "Content-Type must be application/json." }, 415) };
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > LIMITS.importBytes) {
    return { ok: false, response: json({ error: "Request body is too large." }, 413) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > LIMITS.importBytes) {
    return { ok: false, response: json({ error: "Request body is too large." }, 413) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "Request body must be valid JSON." }, 400) };
  }
}

function clientKey(request) {
  return request.headers.get("x-nf-client-connection-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
}

function requireAdmin(request, auth) {
  return auth.isAuthorized(request) ? null : json({ error: "Admin authentication required." }, 401);
}

function methodNotAllowed(allow) {
  return json({ error: "Method not allowed." }, 405, { allow: allow.join(", ") });
}

export function createLeadHandler({
  repository,
  compartmentRepository,
  auth,
  loginLimiter,
  now = () => new Date().toISOString()
}) {
  async function ensureReady() {
    const defaultCompartment = await compartmentRepository.ensureExistingLeads();
    await repository.ensureInitialized({ defaultCompartmentId: defaultCompartment.id });
    return defaultCompartment;
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = apiPath(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-methods": "GET, PATCH, POST, PUT, DELETE, OPTIONS" }
      });
    }
    if (!["GET", "OPTIONS"].includes(request.method) && !sameOrigin(request)) {
      return json({ error: "Cross-origin requests are not allowed." }, 403);
    }

    try {
      if (path === "/api/leads") {
        if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
        await ensureReady();
        return json({ leads: await repository.list() });
      }

      if (path === "/api/compartments") {
        if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
        await ensureReady();
        const [compartments, leads] = await Promise.all([compartmentRepository.list(), repository.list()]);
        const counts = new Map();
        for (const lead of leads) counts.set(lead.compartmentId, (counts.get(lead.compartmentId) || 0) + 1);
        return json({ compartments: compartments.map(compartment => ({
          ...compartment,
          count: counts.get(compartment.id) || 0
        })) });
      }

      if (path === "/api/admin/session") {
        if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
        return json({ authenticated: auth.isAuthorized(request) });
      }

      if (path === "/api/admin/login") {
        if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
        if (!auth.configured) return json({ error: "Admin login is temporarily unavailable." }, 503);
        const limit = loginLimiter.check(clientKey(request));
        if (!limit.allowed) {
          return json({ error: "Too many login attempts. Please try again later." }, 429, {
            "retry-after": String(limit.retryAfterSeconds)
          });
        }
        const parsed = await readJson(request);
        if (!parsed.ok) return parsed.response;
        if (!parsed.value || typeof parsed.value !== "object" || typeof parsed.value.password !== "string" || !auth.authenticate(parsed.value.password)) {
          return json({ error: "Invalid admin credentials." }, 401);
        }
        return json({ authenticated: true }, 200, {
          "set-cookie": auth.issueCookie({ secure: url.protocol === "https:" })
        });
      }

      if (path === "/api/admin/logout") {
        if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
        return json({ authenticated: false }, 200, {
          "set-cookie": auth.clearCookie({ secure: url.protocol === "https:" })
        });
      }

      if (path === "/api/admin/export") {
        if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        await ensureReady();
        const contents = JSON.stringify(await repository.exportAll(), null, 2);
        return new Response(contents, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="telecaller-leads-${now().slice(0, 10)}.json"`
          }
        });
      }

      if (path === "/api/leads/import") {
        if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        const parsed = await readJson(request);
        if (!parsed.ok) return parsed.response;
        if (!parsed.value || typeof parsed.value !== "object" || typeof parsed.value.preview !== "boolean" || !("records" in parsed.value)) {
          return json({ error: "Import body must contain preview, compartmentId, and records." }, 400);
        }
        const compartmentId = validateCompartmentIdentifier(parsed.value.compartmentId);
        if (!compartmentId) return json({ error: "Import requires a valid destination compartment." }, 400);
        if (!parsed.value.preview && (typeof parsed.value.requestId !== "string" || !/^[A-Za-z0-9_-]{8,60}$/.test(parsed.value.requestId))) {
          return json({ error: "Confirmed imports require a valid request ID." }, 400);
        }
        await ensureReady();
        await compartmentRepository.assertWritable(compartmentId);
        const existing = await repository.listImportIndex();
        const submittedRecords = Array.isArray(parsed.value.records) ? parsed.value.records : [parsed.value.records];
        const replayIds = parsed.value.preview ? new Set() : new Set(submittedRecords.map(
          (_, index) => `import-${parsed.value.requestId}-${index}`
        ));
        const replaySnos = new Set();
        for (const [index, id] of [...replayIds].entries()) {
          if (existing.leadIds.has(id)) {
            const prior = await repository.get(id);
            if (prior) replaySnos.add(prior.sno);
            continue;
          }
          const record = submittedRecords[index];
          const sno = record?.sno ?? record?.["S.No."];
          if (!Number.isInteger(sno) || sno < 1 || !existing.snos.has(sno)) continue;
          const reservation = await repository.getSerialReservation(sno);
          if (reservation?.ownerId === id) replaySnos.add(sno);
        }
        const validated = validateImportRecords(parsed.value.records, {
          existingSnos: new Set([...existing.snos].filter(sno => !replaySnos.has(sno)))
        });
        const reserved = new Set(existing.snos);
        for (const record of validated.valid) if (record.sno !== undefined) reserved.add(record.sno);
        let nextSno = 1;
        const proposedRows = validated.validRows.map(({ index, data: record }) => {
          if (record.sno !== undefined) return { index, record };
          while (reserved.has(nextSno)) nextSno += 1;
          reserved.add(nextSno);
          return { index, record: { ...record, sno: nextSno } };
        });
        if (parsed.value.preview) {
          return json({
            valid: proposedRows.map(({ index, record }) => ({ index, ...record })),
            errors: validated.errors
          });
        }
        const result = validated.valid.length
          ? await repository.importMany(validated.valid, {
              requestId: parsed.value.requestId,
              sourceIndexes: validated.validRows.map(row => row.index),
              compartmentId
            })
          : { imported: [], errors: [] };
        const storageErrors = result.errors.map(error => ({
          ...error,
          index: proposedRows[error.index]?.index ?? error.index
        }));
        return json({ imported: result.imported, errors: [...validated.errors, ...storageErrors] });
      }

      const workflowMatch = /^\/api\/leads\/([^/]+)\/workflow$/.exec(path);
      if (workflowMatch) {
        if (request.method !== "PATCH") return methodNotAllowed(["PATCH", "OPTIONS"]);
        const id = validateLeadIdentifier(decodeURIComponent(workflowMatch[1]));
        if (!id) return json({ error: "Invalid lead ID." }, 400);
        const parsed = await readJson(request);
        if (!parsed.ok) return parsed.response;
        const validated = validateWorkflowPatch(parsed.value);
        if (!validated.ok) return json({ error: validated.error }, validated.status);
        await ensureReady();
        const record = await repository.patchWorkflow(id, validated.data);
        return record ? json({ lead: record }) : json({ error: "Lead not found." }, 404);
      }

      const leadMatch = /^\/api\/leads\/([^/]+)$/.exec(path);
      if (leadMatch) {
        const id = validateLeadIdentifier(decodeURIComponent(leadMatch[1]));
        if (!id) return json({ error: "Invalid lead ID." }, 400);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        await ensureReady();
        if (request.method === "PUT") {
          const parsed = await readJson(request);
          if (!parsed.ok) return parsed.response;
          const validated = validateCorePatch(parsed.value);
          if (!validated.ok) return json({ error: validated.error }, 400);
          const record = await repository.updateCore(id, validated.data);
          return record ? json({ lead: record }) : json({ error: "Lead not found." }, 404);
        }
        if (request.method === "DELETE") {
          const removed = await repository.remove(id);
          return removed ? json({ deleted: true, id }) : json({ error: "Lead not found." }, 404);
        }
        return methodNotAllowed(["PUT", "DELETE", "OPTIONS"]);
      }

      if (path === "/api/admin/compartments") {
        if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        const parsed = await readJson(request);
        if (!parsed.ok) return parsed.response;
        if (!parsed.value || typeof parsed.value !== "object" || Object.keys(parsed.value).length !== 1 || typeof parsed.value.name !== "string") {
          return json({ error: "Compartment creation requires a name." }, 400);
        }
        await ensureReady();
        return json({ compartment: await compartmentRepository.create(parsed.value.name) }, 201);
      }

      if (path === "/api/admin/leads/move") {
        if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        const parsed = await readJson(request);
        if (!parsed.ok) return parsed.response;
        const leadIds = parsed.value?.leadIds;
        const compartmentId = validateCompartmentIdentifier(parsed.value?.compartmentId);
        if (!Array.isArray(leadIds) || leadIds.length < 1 || leadIds.length > LIMITS.importRecords || leadIds.some(id => !validateLeadIdentifier(id)) || !compartmentId) {
          return json({ error: "Provide 1 to 1,000 valid lead IDs and one destination compartment." }, 400);
        }
        await ensureReady();
        await compartmentRepository.assertWritable(compartmentId);
        return json(await repository.moveMany(leadIds, compartmentId));
      }

      const compartmentExportMatch = /^\/api\/admin\/compartments\/([^/]+)\/export$/.exec(path);
      if (compartmentExportMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        const id = validateCompartmentIdentifier(decodeURIComponent(compartmentExportMatch[1]));
        if (!id) return json({ error: "Invalid compartment ID." }, 400);
        await ensureReady();
        const compartment = await compartmentRepository.get(id);
        if (!compartment) return json({ error: "Compartment not found." }, 404);
        const slug = compartment.name.toLocaleLowerCase("en-IN").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || id;
        return new Response(JSON.stringify(await repository.exportCompartment(id), null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${slug}-${now().slice(0, 10)}.json"`
          }
        });
      }

      const compartmentMatch = /^\/api\/admin\/compartments\/([^/]+)$/.exec(path);
      if (compartmentMatch) {
        const unauthorized = requireAdmin(request, auth);
        if (unauthorized) return unauthorized;
        const id = validateCompartmentIdentifier(decodeURIComponent(compartmentMatch[1]));
        if (!id) return json({ error: "Invalid compartment ID." }, 400);
        await ensureReady();
        if (request.method === "PUT") {
          const parsed = await readJson(request);
          if (!parsed.ok) return parsed.response;
          if (!parsed.value || typeof parsed.value !== "object" || Object.keys(parsed.value).length !== 1 || typeof parsed.value.name !== "string") {
            return json({ error: "Compartment rename requires a name." }, 400);
          }
          const compartment = await compartmentRepository.rename(id, parsed.value.name);
          return compartment ? json({ compartment }) : json({ error: "Compartment not found." }, 404);
        }
        if (request.method === "DELETE") {
          const parsed = await readJson(request);
          if (!parsed.ok) return parsed.response;
          const compartment = await compartmentRepository.get(id);
          if (!compartment) return json({ error: "Compartment not found." }, 404);
          if (!parsed.value || typeof parsed.value !== "object" || parsed.value.confirmation !== compartment.name) {
            return json({ error: "Type the exact compartment name to confirm deletion." }, 400);
          }
          const deleting = await compartmentRepository.beginDelete(id);
          if (!deleting) return json({ error: "Compartment not found." }, 404);
          const result = await repository.removeByCompartment(id);
          if (result.errors.length) {
            return json({ error: "Some leads could not be deleted. Retry to continue.", ...result }, 503);
          }
          await compartmentRepository.finishDelete(id);
          return json({ deleted: true, id, deletedLeads: result.deleted.length });
        }
        return methodNotAllowed(["PUT", "DELETE", "OPTIONS"]);
      }

      if (path.startsWith("/api/leads") || path.startsWith("/api/admin")) return json({ error: "Not found." }, 404);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error?.code === "NOT_FOUND") return json({ error: error.message }, 404);
      if (error?.code === "VALIDATION") return json({ error: error.message }, 400);
      if (error?.code === "CONFLICT") return json({ error: error.message }, 409);
      return json({ error: "Shared storage is temporarily unavailable." }, 500);
    }
  };
}
