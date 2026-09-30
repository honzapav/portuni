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
// central server.
//
// The id is the spec's Host id: a ULID minted at the device's first boot
// and stored in its data dir (`device.json`, next to content.db), so
// renaming the machine changes its label and nothing else (#578). The
// hostname is only the label. A device that ran under older ids (before
// #578 the id was the hostname slug) remembers them in `previous_host_ids`
// and claims their records at boot (boot/host-identity.ts).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { resolveRunnerDataDir } from "./data-dir.js";

export const DEVICE_IDENTITY_FILENAME = "device.json";

export interface DeviceIdentity {
  host_id: string;
  // Ids this device ran under before `host_id`; the first one is the
  // hostname slug at the moment the file was created.
  previous_host_ids: string[];
}

let machineNameSource: () => string = hostname;
let deviceIdentity: DeviceIdentity | null = null;

function machineName(): string {
  // "Honzas-MacBook-Pro.local" -> "Honzas-MacBook-Pro": the domain part
  // says nothing about which machine this is.
  return (machineNameSource() || "").split(".")[0]?.trim() ?? "";
}

function hostIdOverride(): string | null {
  return process.env.PORTUNI_HOST_ID?.trim() || null;
}

// The machine name slugified (`Honzas-MacBook-Pro.local` ->
// `honzas-macbook-pro`), `local` when the hostname is empty: the id every
// device had before #578, and still the id of a process that loaded no
// identity (the central server, tests).
function hostnameSlug(): string {
  const slug = machineName()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "local";
}

function parseIdentity(raw: string): DeviceIdentity | null {
  const parsed = JSON.parse(raw) as Partial<DeviceIdentity> | null;
  if (!parsed || typeof parsed.host_id !== "string" || parsed.host_id.trim() === "") return null;
  const previous = Array.isArray(parsed.previous_host_ids)
    ? parsed.previous_host_ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")
    : [];
  return { host_id: parsed.host_id, previous_host_ids: previous };
}

// Reads this device's identity from its data dir, minting it on the first
// boot. Called once at boot by a device (desktop sidecar in either
// workspace, the standalone server as a personal workspace); never by the
// central server. Returns null, and writes nothing, when PORTUNI_HOST_ID
// overrides the id: that device behaves exactly as before and nothing is
// claimed. A file that exists but cannot be read is left alone for a human
// to repair (a new id would orphan every record of the old one); the
// process then runs under the hostname slug.
export function loadDeviceIdentity(dataDir: string = resolveRunnerDataDir()): DeviceIdentity | null {
  deviceIdentity = null;
  if (hostIdOverride()) return null;
  const path = join(dataDir, DEVICE_IDENTITY_FILENAME);
  if (existsSync(path)) {
    let identity: DeviceIdentity | null = null;
    try {
      identity = parseIdentity(readFileSync(path, "utf8"));
    } catch {
      identity = null;
    }
    if (!identity) {
      console.error(`[host] ${path} is unreadable; running under the hostname id until it is repaired`);
      return null;
    }
    deviceIdentity = identity;
    return identity;
  }
  const identity: DeviceIdentity = { host_id: ulid(), previous_host_ids: [hostnameSlug()] };
  // Written to a temp file and renamed, so a crash never leaves half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  deviceIdentity = identity;
  return identity;
}

// Id of the host this process is. `PORTUNI_HOST_ID` overrides it for an
// operator who runs several agents on one machine (and for tests); then the
// device's stored id; then, in a process that loaded none, the hostname
// slug.
export function localHostId(): string {
  return hostIdOverride() ?? deviceIdentity?.host_id ?? hostnameSlug();
}

export function setMachineNameForTests(source: (() => string) | null): void {
  machineNameSource = source ?? hostname;
}

export function resetDeviceIdentityForTests(): void {
  deviceIdentity = null;
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
