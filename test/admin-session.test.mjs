import test from "node:test";
import assert from "node:assert/strict";
import { createAdminAuth, createLoginLimiter } from "../netlify/lib/admin-session.mjs";

const PASSWORD = "correct horse battery staple";
const SECRET = "s".repeat(48);

function requestWithCookie(value) {
  return new Request("https://site.test/api/admin/session", {
    headers: { cookie: `other=x; lead_admin_session=${value}; theme=dark` }
  });
}

test("authentication requires valid configuration and exact password", () => {
  const auth = createAdminAuth({ password: PASSWORD, secret: SECRET, nowSeconds: () => 2_000 });
  assert.equal(auth.configured, true);
  assert.equal(auth.authenticate(PASSWORD), true);
  assert.equal(auth.authenticate("wrong"), false);
  assert.equal(createAdminAuth({ password: "", secret: SECRET }).configured, false);
  assert.equal(createAdminAuth({ password: PASSWORD, secret: "short" }).configured, false);
});

test("issued cookies are signed, HttpOnly, strict, and valid for 24 hours", () => {
  const auth = createAdminAuth({ password: PASSWORD, secret: SECRET, nowSeconds: () => 2_000 });
  const header = auth.issueCookie({ secure: true });
  assert.match(header, /^lead_admin_session=[^;]+;/);
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=86400/);
  assert.match(header, /Secure/);
  const token = header.match(/^lead_admin_session=([^;]+)/)[1];
  assert.equal(auth.isAuthorized(requestWithCookie(token)), true);
});

test("local development cookies omit Secure and logout clears the cookie", () => {
  const auth = createAdminAuth({ password: PASSWORD, secret: SECRET });
  assert.doesNotMatch(auth.issueCookie({ secure: false }), /; Secure/);
  const clear = auth.clearCookie({ secure: false });
  assert.match(clear, /^lead_admin_session=;/);
  assert.match(clear, /Max-Age=0/);
  assert.match(clear, /HttpOnly/);
});

test("tampered and expired cookies are unauthorized", () => {
  const auth = createAdminAuth({ password: PASSWORD, secret: SECRET, nowSeconds: () => 2_000 });
  const token = auth.issueCookie({ secure: true }).match(/^lead_admin_session=([^;]+)/)[1];
  assert.equal(auth.isAuthorized(requestWithCookie(`${token}x`)), false);
  assert.equal(auth.isAuthorized(requestWithCookie("not.a.valid.token")), false);
  const later = createAdminAuth({ password: PASSWORD, secret: SECRET, nowSeconds: () => 2_000 + 86_401 });
  assert.equal(later.isAuthorized(requestWithCookie(token)), false);
});

test("cookies signed with another secret are unauthorized", () => {
  const first = createAdminAuth({ password: PASSWORD, secret: SECRET, nowSeconds: () => 2_000 });
  const token = first.issueCookie({ secure: true }).match(/^lead_admin_session=([^;]+)/)[1];
  const rotated = createAdminAuth({ password: PASSWORD, secret: "z".repeat(48), nowSeconds: () => 2_000 });
  assert.equal(rotated.isAuthorized(requestWithCookie(token)), false);
});

test("login limiter permits five attempts then supplies retry time", () => {
  let now = 1_000;
  const limiter = createLoginLimiter({ limit: 5, windowMs: 900_000, nowMs: () => now });
  for (let index = 0; index < 5; index += 1) assert.equal(limiter.check("ip").allowed, true);
  assert.deepEqual(limiter.check("ip"), { allowed: false, retryAfterSeconds: 900 });
  now += 900_001;
  assert.equal(limiter.check("ip").allowed, true);
});

test("login limiter isolates clients and bounds stored keys", () => {
  const limiter = createLoginLimiter({ limit: 1, windowMs: 900_000, nowMs: () => 1_000, maxKeys: 2 });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true);
  assert.equal(limiter.check("c").allowed, true);
  assert.equal(limiter.size(), 2);
});
