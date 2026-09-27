// The `params` of an error body (`{ error, code, params }`), kept to its
// string/number values. Pure and dependency-free, so the server's central
// client and the web's error parsers share one copy.

import type { ErrorParams } from "./error-codes.js";

export function readErrorParams(value: unknown): ErrorParams {
  const out: ErrorParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}
