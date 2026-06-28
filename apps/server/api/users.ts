// GET /users -- list of registered users for the OwnerPicker dropdown.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { respondError , respondJson} from "../http/middleware.js";

export async function handleListUsers(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const rows = await getDb().execute(
      "SELECT id, email, name FROM users ORDER BY name",
    );
    respondJson(res, 200, rows.rows);
  } catch (err) {
    respondError(res, `${req.method} /users`, err);
  }
}
