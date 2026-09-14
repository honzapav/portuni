// Shared data-dir resolution for runner-batch device-local state: the
// provider instances registry (runners.json) and run pid files both live
// under this directory. PORTUNI_DATA_DIR when set (the desktop sidecar
// always sets it); the standalone server has none, so it falls back to
// process.cwd() -- same rule TURSO_URL's file:./portuni.db default uses.
export function resolveRunnerDataDir(): string {
  const explicit = process.env.PORTUNI_DATA_DIR;
  return explicit && explicit.trim() !== "" ? explicit : process.cwd();
}
