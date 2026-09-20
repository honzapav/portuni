// Boot sweep for portuni_read_file's spill area (#406, replacing the
// projection sweep #346 removed).
//
// A spilled file belongs to one live MCP transport and is removed when that
// transport closes (domain/read-node-file.ts's disposeReadFileSpill, called
// from mcp/transport.ts and mcp/agent-transport.ts). No transport survives a
// restart, so anything still under the spill root at boot is orphaned by
// definition -- a crash, a kill -9, or a quit that never ran the onclose
// handlers.
//
// Wired at every boot entry point that serves MCP: index.ts, desktop.ts's
// non-agent branch and desktop.ts's agentMain (agent mode spills too --
// readNodeFileOrPath downloads via CentralClient.getFileRaw there).
// Best-effort: a sweep failure must never block boot.

import { readFileSpillRoot, sweepReadFileSpillRoot } from "../domain/read-node-file.js";

export async function sweepReadFileSpillOnBoot(): Promise<void> {
  try {
    await sweepReadFileSpillRoot();
  } catch (err) {
    console.error(`[boot] read-file spill sweep failed (${readFileSpillRoot()}):`, err);
  }
}
