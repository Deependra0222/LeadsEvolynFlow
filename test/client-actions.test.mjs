import test from "node:test";
import assert from "node:assert/strict";
import { logoutAdmin } from "../client-actions.mjs";

test("logout reports success only after the server clears the session", async () => {
  const events = [];
  await logoutAdmin({
    api: { logout: async () => ({ authenticated: false }) },
    setAdminMode: enabled => events.push(["mode", enabled]),
    notify: message => events.push(["notice", message])
  });
  assert.deepEqual(events, [["mode", false], ["notice", "Logged out"]]);
});

test("failed logout keeps admin mode and asks the user to retry", async () => {
  const events = [];
  await assert.rejects(logoutAdmin({
    api: { logout: async () => { throw new Error("offline"); } },
    setAdminMode: enabled => events.push(["mode", enabled]),
    notify: message => events.push(["notice", message])
  }), /offline/);
  assert.deepEqual(events, [["notice", "Logout failed — please try again"]]);
});
