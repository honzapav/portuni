// The default test environment is a local workspace (#310): no remote ever
// resolves and no adapter can be reached. A suite that exercises the
// server-side remote paths (central's adapter-direct file content, the remote
// sweep, push/pull, adoption) opts in here. node:test runs every file in its
// own process, so the flag is set once at load and never needs unsetting.
export function useRemoteCapableEnv(): void {
  process.env.PORTUNI_AGENT_MODE = "1";
}
