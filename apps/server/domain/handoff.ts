// One-time handoff codes for "Otevřít v Showtime" (spec:
// docs/superpowers/specs/2026-09-02-showtime-handoff-design.md). The desktop
// mints a code bound to {bearer, node, user}; Showtime exchanges it over
// loopback for the bearer and the node's connection details. The bearer
// itself never travels in a URL, argv or on disk -- only this short-lived
// code does. One map per process, swept on every mint; a code is deleted
// the moment it is exchanged, so it is single-use by construction.

import { randomBytes } from "node:crypto";

export const HANDOFF_TTL_MS = 60_000;

export interface HandoffEntry {
  code: string;
  token: string;
  nodeId: string;
  userId: string;
  expiresAt: number;
}

const codes = new Map<string, HandoffEntry>();

function sweep(now: number): void {
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) codes.delete(code);
  }
}

export function mintHandoff(
  args: { token: string; nodeId: string; userId: string },
  now: number = Date.now(),
): { code: string; expiresIn: number } {
  sweep(now);
  const code = randomBytes(32).toString("base64url");
  codes.set(code, {
    code,
    token: args.token,
    nodeId: args.nodeId,
    userId: args.userId,
    expiresAt: now + HANDOFF_TTL_MS,
  });
  return { code, expiresIn: HANDOFF_TTL_MS / 1000 };
}

// Consumes the code: a hit is removed before it is returned, so a second
// exchange of the same code misses. Unknown and expired codes miss too.
export function exchangeHandoff(code: string, now: number = Date.now()): HandoffEntry | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  if (entry.expiresAt <= now) return null;
  return entry;
}

// Loopback peer check for the public exchange endpoint. Node reports IPv4
// peers on a dual-stack socket as ::ffff:127.0.0.1.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const v = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return v === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
}

export function resetHandoffsForTesting(): void {
  codes.clear();
}
