// Env-key rules for the provider instances registry (runners.json), shared
// by the server (domain/runner/instances.ts, the enforcement point) and the
// web form (apps/web/src/lib/runners.ts, an immediate echo of the same
// rule). Ports apps/desktop/src/workspace.rs's is_secret_shaped_env_key: a
// value the registry would store in plaintext must never look like a
// secret -- those belong in the OS keychain.

export function isSecretShapedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.endsWith("_TOKEN") || upper.endsWith("_KEY") || upper.endsWith("_SECRET") || upper.includes("PASSWORD");
}

export function isPortuniEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith("PORTUNI_");
}
