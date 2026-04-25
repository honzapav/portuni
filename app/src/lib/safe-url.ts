// Mirror of src/safe-url.ts for the frontend bundle. Kept in sync manually
// (the backend uses Node's URL, the frontend uses the built-in URL — same
// semantics). Both must allow only the same scheme allowlist.
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

export function safeHref(value: string | null | undefined): string | null {
  if (value == null) return null;
  return isSafeExternalLink(value) ? value.trim() : null;
}
