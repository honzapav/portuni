// Shared logic behind the `a` renderer used in react-markdown/Streamdown
// `components`. Routing through externalLinkProps is what makes the link
// open via the Tauri native `open_external` command instead of the
// library's own `window.open`, which is a silent no-op in the desktop
// webview (see backend-url.ts). Unsafe/relative hrefs render as inert text.
//
// Deliberately NOT exported as a standalone `Components["a"]`-typed
// component: react-markdown and Streamdown each expect their own concrete
// (near-identical but distinct) anchor prop type, and only relies on
// contextual typing when the arrow function is written inline in the
// `components` object literal at each call site -- a hoisted function with
// its own explicit parameter type fails that structural check in CI
// ("not assignable to type 'Components'"). Keep the inline wrapper at each
// site; only the body (this function) is shared.
import type { ReactNode } from "react";
import { externalLinkProps } from "./external-link";
import { safeHref } from "./safe-url";

export function renderMarkdownLink(href: string | undefined, children: ReactNode) {
  const safe = safeHref(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a {...externalLinkProps(safe)}>{children}</a>;
}
