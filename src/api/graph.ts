// GET /graph -- full graph payload (nodes + edges) for the frontend.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { loadGraph } from "../domain/queries/graph.js";
import { respondError , respondJson, type RequestIdentity} from "../http/middleware.js";
import { filterVisibleNodeIds } from "../auth/node-access.js";

export async function handleGraph(req: IncomingMessage, res: ServerResponse, identity?: RequestIdentity): Promise<void> {
  try {
    const db = getDb();
    const graph = await loadGraph(db);

    // Filter hidden nodes and their edges when identity is provided.
    if (identity !== undefined) {
      const allNodeIds = graph.nodes.map((n) => n.id);
      const visibleSet = await filterVisibleNodeIds(db, identity, allNodeIds);
      const filteredNodes = graph.nodes.filter((n) => visibleSet.has(n.id));
      const filteredEdges = graph.edges.filter(
        (e) => visibleSet.has(e.source_id) && visibleSet.has(e.target_id),
      );
      respondJson(res, 200, { nodes: filteredNodes, edges: filteredEdges });
      return;
    }

    respondJson(res, 200, graph);
  } catch (err) {
    respondError(res, `${req.method} /graph`, err);
  }
}
