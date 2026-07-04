// GET /graph -- full graph payload (nodes + edges) for the frontend.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { loadGraph } from "../domain/queries/graph.js";
import { respondError , respondJson, type RequestIdentity} from "../http/middleware.js";
import { visibilityWithRestriction } from "../auth/node-access.js";

export async function handleGraph(req: IncomingMessage, res: ServerResponse, identity?: RequestIdentity): Promise<void> {
  try {
    const db = getDb();
    const graph = await loadGraph(db);

    // Filter hidden nodes and their edges when identity is provided. One
    // combined pass computes both the visibility decision and the
    // `restricted` flag per node -- each distinct chain is resolved exactly
    // once, whether the caller is an admin or a group member (see
    // visibilityWithRestriction for why the previous two-pass filter+flag
    // combo doubled Turso round trips for members).
    if (identity !== undefined) {
      const allNodeIds = graph.nodes.map((n) => n.id);
      const visibility = await visibilityWithRestriction(db, identity, allNodeIds);
      const filteredNodes = graph.nodes.filter((n) => visibility.get(n.id)?.visible);
      const visibleIds = new Set(filteredNodes.map((n) => n.id));
      const filteredEdges = graph.edges.filter(
        (e) => visibleIds.has(e.source_id) && visibleIds.has(e.target_id),
      );
      respondJson(res, 200, {
        nodes: filteredNodes.map((n) =>
          visibility.get(n.id)?.restricted ? { ...n, restricted: true as const } : n,
        ),
        edges: filteredEdges,
      });
      return;
    }

    respondJson(res, 200, graph);
  } catch (err) {
    respondError(res, `${req.method} /graph`, err);
  }
}
