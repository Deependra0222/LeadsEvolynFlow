import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "lead_admin_session";
const SESSION_SECONDS = 86_400;

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function tokenFromRequest(request) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return "";
}

function attributes({ secure, maxAge }) {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function createAdminAuth({
  password = "",
  secret = "",
  nowSeconds = () => Math.floor(Date.now() / 1000)
} = {}) {
  const configured = typeof password === "string" && password.length > 0 && typeof secret === "string" && secret.length >= 32;

  function authenticate(attempt) {
    return configured && typeof attempt === "string" && safeEqual(attempt, password);
  }

  function issueCookie({ secure }) {
    if (!configured) throw new Error("Admin authentication is not configured.");
    const payload = Buffer.from(JSON.stringify({ exp: nowSeconds() + SESSION_SECONDS }), "utf8").toString("base64url");
    const token = `${payload}.${sign(payload, secret)}`;
    return `${COOKIE_NAME}=${token}; ${attributes({ secure, maxAge: SESSION_SECONDS })}`;
  }

  function clearCookie({ secure }) {
    return `${COOKIE_NAME}=; ${attributes({ secure, maxAge: 0 })}`;
  }

  function isAuthorized(request) {
    if (!configured) return false;
    try {
      const token = tokenFromRequest(request);
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
      const expected = sign(parts[0], secret);
      if (!safeEqual(parts[1], expected)) return false;
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      if (Object.keys(payload).length !== 1 || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
      return payload.exp >= nowSeconds();
    } catch {
      return false;
    }
  }

  return { configured, authenticate, issueCookie, clearCookie, isAuthorized };
}

export function createLoginLimiter({
  limit = 5,
  windowMs = 15 * 60 * 1_000,
  nowMs = () => Date.now(),
  maxKeys = 1_000
} = {}) {
  const attempts = new Map();
  return {
    check(key) {
      const now = nowMs();
      const recent = (attempts.get(key) || []).filter(timestamp => now - timestamp < windowMs);
      if (recent.length >= limit) {
        attempts.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1_000)) };
      }
      if (!attempts.has(key) && attempts.size >= maxKeys) {
        attempts.delete(attempts.keys().next().value);
      }
      recent.push(now);
      attempts.set(key, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    size() { return attempts.size; }
  };
}
