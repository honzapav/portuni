import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveGlobalScope,
  scopeAtLeast,
  groupRoleConfigFromEnv,
} from "../apps/server/auth/roles.js";

test("scopeAtLeast respects ordering read < write < manage < admin", () => {
  assert.equal(scopeAtLeast("admin", "read"), true);
  assert.equal(scopeAtLeast("write", "manage"), false);
  assert.equal(scopeAtLeast("manage", "manage"), true);
  assert.equal(scopeAtLeast("read", "write"), false);
});

test("resolveGlobalScope picks highest matching group, defaults to read", () => {
  const cfg = {
    admin: ["portuni-admins@example.com"],
    manage: ["portuni-managers@example.com"],
    write: ["portuni-team@example.com"],
  };
  assert.equal(resolveGlobalScope([], cfg), "read");
  assert.equal(resolveGlobalScope(["portuni-team@example.com"], cfg), "write");
  assert.equal(
    resolveGlobalScope(
      ["portuni-team@example.com", "portuni-managers@example.com"],
      cfg,
    ),
    "manage",
  );
  assert.equal(
    resolveGlobalScope(["PORTUNI-ADMINS@EXAMPLE.COM"], cfg),
    "admin",
    "matching is case-insensitive",
  );
});

test("groupRoleConfigFromEnv parses comma lists and trims", () => {
  const cfg = groupRoleConfigFromEnv({
    PORTUNI_GROUPS_ADMIN: "a@x.com, b@x.com",
    PORTUNI_GROUPS_MANAGE: "",
    PORTUNI_GROUPS_WRITE: "team@x.com",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.admin, ["a@x.com", "b@x.com"]);
  assert.deepEqual(cfg.manage, []);
  assert.deepEqual(cfg.write, ["team@x.com"]);
});
