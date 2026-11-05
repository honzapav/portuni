// GET /changes?since=<cursor>&wait=<s>: the change feed
// (infra/change-feed.ts) as the sync agent and a personal workspace's
// window read it -- the node and file changes since a cursor, holding the
// request up to `wait` seconds for the next one. Only nodes the caller can
// see are named; an unknown cursor answers `reset`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { changesSince, waitForChanges } from "../infra/change-feed.js";
import { filterVisibleNodeIds } from "../auth/node-access.js";
import { respondApiError, respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import type { ChangesResponse } from "../shared/api-types.js";

const CHANGES_MAX_WAIT_S = 25;

export async function handleGetChanges(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  url: URL,
): Promise<void> {
  try {
    const since = url.searchParams.get("since");
    const waitParam = url.searchParams.get("wait");
    const wait = waitParam === null ? 0 : Number(waitParam);
    if (!Number.isFinite(wait) || wait < 0 || wait > CHANGES_MAX_WAIT_S) {
      respondApiError(res, 400, "INVALID_REQUEST", `wait: 0 to ${CHANGES_MAX_WAIT_S} seconds`);
      return;
    }
    let r = changesSince(since);
    if (!r.reset && r.changes.length === 0 && wait > 0) {
      await waitForChanges(since, wait * 1000);
      r = changesSince(since);
    }
    const ids = [...new Set(r.changes.map((c) => c.node_id))];
    const visible = ids.length > 0 ? await filterVisibleNodeIds(getDb(), identity, ids) : new Set<string>();
    const payload: ChangesResponse = {
      cursor: r.cursor,
      reset: r.reset,
      changes: r.changes
        .filter((c) => visible.has(c.node_id))
        .map((c) => ({ node_id: c.node_id, kind: c.kind, seq: c.seq })),
    };
    respondJson(res, 200, payload);
  } catch (err) {
    respondError(res, `${req.method} /changes`, err);
  }
}
