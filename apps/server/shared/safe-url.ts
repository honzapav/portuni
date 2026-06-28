// Allowlist of schemes that may safely appear in href / external_link fields.
// Anything else (javascript:, data:, file:, vbscript:, ...) is rejected to
// prevent stored-XSS-by-click via attribute injection in the UI.
const ALLOWED_EXTERNAL_LINK_SCHEMES = new Set([
  "http:",
  "https:",
  "mailto:",
]);

export function isSafeExternalLink(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_LINK_SCHEMES.has(parsed.protocol.toLowerCase());
}

export function sanitizeExternalLink(value: string | null | undefined): string | null {
  if (value == null) return null;
  return isSafeExternalLink(value) ? value.trim() : null;
}
