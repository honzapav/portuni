// REST surface for Nastaveni -> Synchronizace. Thin: parse/validate,
// delegate to domain/sync/remote-service, map typed errors to JSON.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBody, respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import { getDb } from "../infra/db.js";
import {
  connectDrive, disconnectDrive, driveStatus, listDriveTargets, setDriveTarget, testDrive,
} from "../domain/sync/remote-service.js";

export async function routeSyncDrive(
  req: IncomingMessage, res: ServerResponse, url: URL, identity: RequestIdentity,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";
  if (!pathname.startsWith("/sync/drive/")) return false;
  const db = getDb();
  try {
    if (pathname === "/sync/drive/connect" && method === "POST") {
      const b = (await parseBody(req)) as Record<string, unknown> | undefined;
      const fields = ["refresh_token", "client_id", "client_secret", "account_email"] as const;
      if (!b || fields.some((f) => typeof b[f] !== "string" || (b[f] as string).length === 0)) {
        respondJson(res, 400, { error: "connect requires refresh_token, client_id, client_secret, account_email" });
        return true;
      }
      respondJson(res, 200, await connectDrive(db, {
        userId: identity.userId,
        refresh_token: b.refresh_token as string,
        client_id: b.client_id as string,
        client_secret: b.client_secret as string,
        account_email: b.account_email as string,
      }));
      return true;
    }
    if (pathname === "/sync/drive/targets" && method === "GET") {
      const drives = await listDriveTargets();
      if (drives === null) { respondJson(res, 409, { error: "not_connected" }); return true; }
      respondJson(res, 200, { shared_drives: drives });
      return true;
    }
    if (pathname === "/sync/drive/target" && method === "POST") {
      const b = (await parseBody(req)) as { shared_drive_id?: string; my_drive?: boolean } | undefined;
      const hasDrive = typeof b?.shared_drive_id === "string" && b.shared_drive_id.length > 0;
      if (!b || hasDrive === Boolean(b.my_drive)) {
        respondJson(res, 400, { error: "target requires exactly one of shared_drive_id | my_drive" });
        return true;
      }
      respondJson(res, 200, await setDriveTarget(db, { userId: identity.userId, ...b }));
      return true;
    }
    if (pathname === "/sync/drive/status" && method === "GET") {
      respondJson(res, 200, await driveStatus(db));
      return true;
    }
    if (pathname === "/sync/drive/test" && method === "POST") {
      respondJson(res, 200, await testDrive(db));
      return true;
    }
    if (pathname === "/sync/drive/disconnect" && method === "POST") {
      await disconnectDrive(db);
      respondJson(res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (err) {
    respondError(res, `${method} ${pathname}`, err);
    return true;
  }
}
