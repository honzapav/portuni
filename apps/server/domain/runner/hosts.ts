// The host a task runs on: the machine whose sidecar owns the mirrors, the
// runner logins and the runner processes
// (docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md).
//
// The `hosts` registry of that spec -- a central table with a label, a
// heartbeat and capabilities -- does not exist yet, so there is exactly one
// host any process can name: itself. That is enough for every runtime we
// have today, because the runtime always runs on the device: in a personal
// workspace the host is this machine, and in a team workspace the sync
// agent stamps its own id onto the run it starts before recording it on the
// central server. Reading a run back on the central server therefore gives
// the id of the device that ran it, and no label (central holds no registry
// to look one up in) -- the surfaces fall back to the id, which is why the
// id is the machine name rather than an opaque ULID.

import { hostname } from "node:os";

function machineName(): string {
  // "Honzas-MacBook-Pro.local" -> "Honzas-MacBook-Pro": the domain part
  // says nothing about which machine this is.
  return (hostname() || "").split(".")[0]?.trim() ?? "";
}

// Stable, human-readable id of the host this process is. `PORTUNI_HOST_ID`
// overrides it for an operator who runs several agents on one machine (and
// for tests).
export function localHostId(): string {
  const override = process.env.PORTUNI_HOST_ID?.trim();
  if (override) return override;
  const slug = machineName()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "local";
}

// Display name of this host. `PORTUNI_HOST_LABEL` overrides it; otherwise
// the machine name as the OS reports it, case intact.
export function localHostLabel(): string | null {
  const override = process.env.PORTUNI_HOST_LABEL?.trim();
  if (override) return override;
  return machineName() || null;
}

// The display label for a host id, or null when nothing here can name it.
// Until the registry lands, "nothing here can name it" means "some other
// machine": a teammate's device seen from the central server, or this
// device's own record read back somewhere else.
export function resolveHostLabel(hostId: string | null): string | null {
  if (!hostId) return null;
  if (hostId !== localHostId()) return null;
  const label = localHostLabel();
  return label && label !== hostId ? label : null;
}

// #458: what GET /sessions/:id/events says when this device has no
// transcript for a thread the record says ran elsewhere -- the label the
// chat shows ("Transkript je na zařízení X"), which is the host's display
// name when this process can name it and the host id otherwise, exactly
// what the web's hostDisplayName falls back to. null means "say nothing":
// either there ARE events here, or the thread's host is this device (a
// thread that simply has no events yet).
export function transcriptHostLabel(hostId: string | null, eventCount: number): string | null {
  if (eventCount > 0) return null;
  if (!hostId || hostId === localHostId()) return null;
  return resolveHostLabel(hostId) ?? hostId;
}
