// Short CLI identifier (#272) derived from the MCP handshake's own
// `initialize` clientInfo.name, not a custom header -- Codex and Vibe have
// no per-mirror config mechanism that can relay a header at all (see
// CLAUDE.md's scope-disk-projection gotcha for the same limitation on
// X-Portuni-Spawn-Id), but every MCP client sends clientInfo as part of the
// protocol's own handshake.

// Normalizes a raw clientInfo.name into the short, stable label the UI
// displays (DetailPane's Relace list) -- substring match rather than an
// exact one, since a CLI's self-reported name can carry extra words
// ("claude-code", "Claude Code", "codex-cli", ...). An unrecognized name is
// kept verbatim rather than discarded, so a future/unknown client still
// shows something more useful than "cli neznámé".
export function normalizeCliName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("vibe")) return "vibe";
  return name;
}

// Peeks the already-parsed JSON-RPC body for an `initialize` request's
// clientInfo.name, the same technique agent-transport.ts's
// extractDownstreamCapabilities uses -- reading the body directly instead
// of waiting on the SDK's own post-handshake state, which is not
// necessarily populated yet at the point transport.ts's onsessioninitialized
// fires (that callback runs while the initialize REQUEST is still being
// processed, not after the client's follow-up initialized notification).
export function extractClientNameFromInitializeBody(body: unknown): string | null {
  const msg = Array.isArray(body) ? body[0] : body;
  if (msg === null || typeof msg !== "object" || (msg as { method?: unknown }).method !== "initialize") {
    return null;
  }
  const params = (msg as { params?: { clientInfo?: { name?: unknown } } }).params;
  const name = params?.clientInfo?.name;
  return typeof name === "string" && name.trim() !== "" ? normalizeCliName(name.trim()) : null;
}
