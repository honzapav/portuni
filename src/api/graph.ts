// GET /graph -- full graph payload (nodes + edges) for the frontend.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { loadGraph } from "../domain/queries/graph.js";
import { respondError , respondJson} from "../http/middleware.js";

export async function handleGraph(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const graph = await loadGraph(getDb());
    respondJson(res, 200, graph);
  } catch (err) {
    respondError(res, `${req.method} /graph`, err);
  }
}
