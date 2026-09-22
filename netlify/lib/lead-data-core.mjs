export const STATUS_OPTIONS = [
  "Not Called",
  "Called",
  "No Answer",
  "Follow-up",
  "Interested",
  "Not Interested"
];

export const MAX_LEAD_ID = 722;
export const MAX_REMARKS_LENGTH = 5000;

export function validateLeadId(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 && id <= MAX_LEAD_ID ? id : null;
}

function isValidLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return year >= 1 &&
    month >= 1 && month <= 12 &&
    day >= 1 && day <= daysPerMonth[month - 1] &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59;
}

export function validatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Request body must be an object." };
  }

  const { status, followup, remarks } = value;

  if (!STATUS_OPTIONS.includes(status)) {
    return { ok: false, error: "Invalid call status." };
  }

  const validFollowup = typeof followup === "string" && (
    followup === "" || isValidLocalDateTime(followup)
  );
  if (!validFollowup) {
    return { ok: false, error: "Invalid follow-up date." };
  }

  if (typeof remarks !== "string" || remarks.length > MAX_REMARKS_LENGTH) {
    return { ok: false, error: "Remarks must be 5,000 characters or fewer." };
  }

  return { ok: true, data: { status, followup, remarks } };
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function isLeadPath(pathname) {
  return pathname === "/api/leads" ||
    pathname.endsWith("/lead-data") ||
    pathname.includes("/api/leads/") ||
    pathname.includes("/lead-data/");
}

export function createLeadHandler({
  listRecords,
  saveRecord,
  now = () => new Date().toISOString()
}) {
  return async function handle(request) {
    const { pathname } = new URL(request.url);
    const isCollection = pathname === "/api/leads" || pathname.endsWith("/lead-data");
    const rawId = pathname.split("/").filter(Boolean).at(-1);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, PUT, OPTIONS"
        }
      });
    }

    try {
      if (request.method === "GET" && isCollection) {
        return json({ records: await listRecords() });
      }

      if (request.method === "PUT") {
        const id = validateLeadId(rawId);
        if (id === null) {
          return json({ error: "Invalid lead ID." }, 400);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Request body must be valid JSON." }, 400);
        }

        const result = validatePayload(body);
        if (!result.ok) {
          return json({ error: result.error }, 400);
        }

        const record = {
          ...result.data,
          updatedAt: now()
        };
        await saveRecord(id, record);
        return json({ record });
      }

      if (isLeadPath(pathname)) {
        return json(
          { error: "Method not allowed." },
          405,
          { allow: "GET, PUT, OPTIONS" }
        );
      }

      return json({ error: "Not found." }, 404);
    } catch {
      return json({ error: "Shared storage is temporarily unavailable." }, 500);
    }
  };
}
