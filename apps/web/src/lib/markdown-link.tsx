// Shared `a` renderer for react-markdown/Streamdown `components`. Both
// libraries call this with `{ href, children }`; routing through
// externalLinkProps is what makes the link open via the Tauri native
// `open_external` command instead of the library's own `window.open`,
// which is a silent no-op in the desktop webview (see backend-url.ts).
// Unsafe/relative hrefs render as inert text.
import type { ReactNode } from "react";
import { externalLinkProps } from "./external-link";
import { safeHref } from "./safe-url";

export function markdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const safe = safeHref(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a {...externalLinkProps(safe)}>{children}</a>;
}
