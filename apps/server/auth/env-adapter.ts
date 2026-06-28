// Dev/local adapter: identity from env, full admin. Preserves the
// pre-multi-user behavior (single trusted local user) and proves the
// IdentityAdapter interface has a second implementation from day one.

import type { AccessResolution, Identity, IdentityAdapter } from "./adapter.js";

export class EnvAdapter implements IdentityAdapter {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async verify(_credential: string): Promise<Identity> {
    const email = this.env.PORTUNI_USER_EMAIL ?? "solo@localhost";
    const name = this.env.PORTUNI_USER_NAME ?? "Solo User";
    return { email, name, sub: `env:${email}` };
  }

  async resolveAccess(_email: string): Promise<AccessResolution> {
    return { globalScope: "admin", groups: [] };
  }
}
