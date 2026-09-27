// #521: the client-side token variable name has two implementations --
// clientTokenEnvVar() here and workspace::token_env_var in the desktop
// shell. Both read apps/server/shared/token-env-var-cases.json; the Rust
// half is `token_env_var_matches_shared_fixture` under cargo test.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clientTokenEnvVar } from "../apps/server/infra/auth-config.js";

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "apps/server/shared/token-env-var-cases.json"), "utf8"),
) as { cases: { ws_id: string; env_var: string }[] };

describe("clientTokenEnvVar parity with the desktop's token_env_var", () => {
  const saved = process.env.PORTUNI_WORKSPACE_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORTUNI_WORKSPACE_ID;
    else process.env.PORTUNI_WORKSPACE_ID = saved;
  });

  it("maps every fixture workspace id to the same variable name", () => {
    assert.ok(fixture.cases.length > 0);
    for (const c of fixture.cases) {
      process.env.PORTUNI_WORKSPACE_ID = c.ws_id;
      assert.equal(clientTokenEnvVar(), c.env_var, `ws_id ${c.ws_id}`);
    }
  });
});
