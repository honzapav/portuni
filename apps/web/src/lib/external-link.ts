// Props for an <a> that leaves the app (data source / tool link on a node,
// the remote folder link, links in rendered markdown).
//
// Browser build: a native anchor with target="_blank", so the page is not
// replaced and cmd-click / middle-click keep working. No JS involved.
//
// Tauri webview: exactly one opener must run, and there are two candidates.
// tauri-plugin-shell injects an init script (init-iife.js) that listens for
// clicks on the document body and, for any <a target="_blank"> with an
// http/https/mailto/tel href, invokes `plugin:shell|open` -- it never checks
// `defaultPrevented`, so a React onClick that already opened the URL through
// the native `open_external` command does not stop it. That is how a click on
// a node's source link opened the browser twice. The plugin script keys on
// the literal `_blank` target, so in Tauri the anchor gets no target at all
// and the click is routed only through openExternal, which logs every attempt
// to sidecar.log and enforces the scheme allowlist.
import type { MouseEvent } from "react";
import { isTauri, openExternal } from "./backend-url";

export type ExternalLinkProps = {
  href: string;
  rel: string;
  target?: "_blank";
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
};

type ClickHandler = (e: MouseEvent<HTMLAnchorElement>) => void;

// `onClick` lets a caller run its own logic (e.g. stopPropagation for a link
// nested in a clickable row) before the opener; it runs in both builds.
export function externalLinkProps(
  url: string,
  opts: { onClick?: ClickHandler } = {},
): ExternalLinkProps {
  const { onClick } = opts;
  if (isTauri()) {
    return {
      href: url,
      rel: "noopener noreferrer",
      onClick: (e) => {
        onClick?.(e);
        e.preventDefault();
        void openExternal(url);
      },
    };
  }
  return {
    href: url,
    rel: "noopener noreferrer",
    target: "_blank",
    ...(onClick ? { onClick } : {}),
  };
}
