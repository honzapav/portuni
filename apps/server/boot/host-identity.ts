// #578: the device's host id is a ULID in its data dir
// (domain/runner/hosts.ts). A device that ran under other ids before -- the
// hostname slug, before the id was stored -- takes those records back at
// boot, so a thread it ran is still its own after the machine is renamed.
// A personal workspace rewrites its own graph db; a sync agent asks the
// central server, which rewrites only this user's records. Both are
// idempotent and best-effort: a failure is logged and the next boot tries
// again.

import { getDb } from "../infra/db.js";
import { claimHostRecords } from "../domain/sessions.js";
import type { CentralClient } from "../domain/sync/central/client.js";
import type { DeviceIdentity } from "../domain/runner/hosts.js";

function hasPrevious(identity: DeviceIdentity | null): identity is DeviceIdentity {
  if (!identity) return false;
  return identity.previous_host_ids.some((id) => id !== identity.host_id);
}

export async function claimHostRecordsLocal(identity: DeviceIdentity | null): Promise<void> {
  if (!hasPrevious(identity)) return;
  try {
    const r = await claimHostRecords(getDb(), {
      hostId: identity.host_id,
      previousHostIds: identity.previous_host_ids,
    });
    if (r.sessions > 0 || r.runs > 0) {
      console.error(`[host] claimed ${r.sessions} session(s) and ${r.runs} run(s) under ${identity.host_id}`);
    }
  } catch (err) {
    console.error("[host] claiming previous host records failed:", err);
  }
}

export async function claimHostRecordsCentral(client: CentralClient, identity: DeviceIdentity | null): Promise<void> {
  if (!hasPrevious(identity)) return;
  try {
    const r = await client.claimHost({
      host_id: identity.host_id,
      previous_host_ids: identity.previous_host_ids,
    });
    if (r.sessions > 0 || r.runs > 0) {
      console.error(`[host] central claimed ${r.sessions} session(s) and ${r.runs} run(s) under ${identity.host_id}`);
    }
  } catch (err) {
    console.error("[host] claiming previous host records on the central server failed:", err);
  }
}
