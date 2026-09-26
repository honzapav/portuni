// Server-rendered consent / error pages for the OAuth connector flow. No
// JS, no CSS framework -- plain HTML so it renders identically in the
// in-app browser Claude / claude.ai / Claude Code open for the redirect.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Authorization flow" step 4).
//
// #539: every text comes from the `server` (and, for an error, `errors`)
// namespace in the page's language -- the account's when the user is known,
// else Accept-Language, else English (resolvePageLocale). Interpolated values
// are HTML-escaped by the server's i18next instance (shared/i18n/server.ts);
// the few tags inside a sentence live in the catalog.

import type { TFunction } from "i18next";
import { DEFAULT_LOCALE, firstSupportedLocale, type Locale } from "../../shared/i18n/config.js";
import { getFixedT } from "../../shared/i18n/server.js";
import type { ErrorParams } from "../../shared/error-codes.js";

// The languages of an Accept-Language header, most preferred first: the
// q-values ordered descending (stable, so equal weights keep header order),
// `q=0` dropped.
function acceptLanguageTags(header: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  return raw
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((e) => e.tag.length > 0 && e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((e) => e.tag);
}

// The page's language: the account's setting when the user is known, then
// the browser's Accept-Language, then English.
export function resolvePageLocale(input: {
  accountLocale?: Locale | null;
  acceptLanguage?: string | string[] | null;
}): Locale {
  return input.accountLocale ?? firstSupportedLocale(acceptLanguageTags(input.acceptLanguage)) ?? DEFAULT_LOCALE;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(locale: Locale, title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.5rem; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; vertical-align: middle; margin-right: 0.75rem; }
  .who { display: flex; align-items: center; margin-bottom: 1rem; }
  .client { font-weight: 600; }
  .url { color: #666; font-size: 0.85rem; word-break: break-all; }
  .warning { background: #fff8e1; border: 1px solid #f0c14b; border-radius: 8px; padding: 0.75rem 1rem; margin: 1rem 0; font-size: 0.9rem; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid #ccc; font-size: 1rem; cursor: pointer; }
  button[name="decision"][value="allow"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface ConsentPageParams {
  email: string;
  name: string;
  avatarUrl: string | null;
  clientName: string;
  clientId: string;
  redirectUri: string;
  isLoopback: boolean;
  continuationToken: string;
}

export function renderConsentPage(params: ConsentPageParams, locale: Locale = DEFAULT_LOCALE): string {
  const t = getFixedT(locale, "server");
  const redirectHost = (() => {
    try {
      return new URL(params.redirectUri).host;
    } catch {
      return params.redirectUri;
    }
  })();

  const avatar = params.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(params.avatarUrl)}" alt="">`
    : "";

  const loopbackWarning = params.isLoopback
    ? `<div class="warning">${t(($) => $.oauth.consent.loopback_warning, { host: redirectHost })}</div>`
    : "";

  const body = `
<div class="card">
  <div class="who">
    ${avatar}
    <div>
      <div>${escapeHtml(params.name)}</div>
      <div class="url">${escapeHtml(params.email)}</div>
    </div>
  </div>
  <p>${t(($) => $.oauth.consent.requests_access, { clientName: params.clientName })}</p>
  <p class="url">${escapeHtml(params.clientId)}</p>
  <p>${escapeHtml(t(($) => $.oauth.consent.redirect_notice))}</p>
  <p class="url">${escapeHtml(params.redirectUri)}</p>
  ${loopbackWarning}
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="token" value="${escapeHtml(params.continuationToken)}">
    <div class="actions">
      <button type="submit" name="decision" value="deny">${escapeHtml(t(($) => $.oauth.consent.deny))}</button>
      <button type="submit" name="decision" value="allow">${escapeHtml(t(($) => $.oauth.consent.allow))}</button>
    </div>
  </form>
</div>`;

  return page(locale, t(($) => $.oauth.consent.title), body);
}

// The OAuth error codes a sign-in page can show, each mapped to its message
// in the `errors` namespace (never a key built from the code at runtime).
export type OAuthPageErrorCode =
  | "OAUTH_MISSING_PARAMETER"
  | "OAUTH_PKCE_S256_ONLY"
  | "OAUTH_CLIENT_UNVERIFIED"
  | "OAUTH_REDIRECT_URI_UNREGISTERED"
  | "OAUTH_INVALID_RESOURCE"
  | "OAUTH_SESSION_EXPIRED"
  | "OAUTH_GOOGLE_LOGIN_FAILED";

const OAUTH_PAGE_MESSAGES: Record<OAuthPageErrorCode, (t: TFunction<"errors">, params: ErrorParams) => string> = {
  OAUTH_MISSING_PARAMETER: (t) => t(($) => $.OAUTH_MISSING_PARAMETER, { ns: "errors" }),
  OAUTH_PKCE_S256_ONLY: (t) => t(($) => $.OAUTH_PKCE_S256_ONLY, { ns: "errors" }),
  OAUTH_CLIENT_UNVERIFIED: (t, p) => t(($) => $.OAUTH_CLIENT_UNVERIFIED, { ns: "errors", reason: String(p.reason ?? "") }),
  OAUTH_REDIRECT_URI_UNREGISTERED: (t) => t(($) => $.OAUTH_REDIRECT_URI_UNREGISTERED, { ns: "errors" }),
  OAUTH_INVALID_RESOURCE: (t) => t(($) => $.OAUTH_INVALID_RESOURCE, { ns: "errors" }),
  OAUTH_SESSION_EXPIRED: (t) => t(($) => $.OAUTH_SESSION_EXPIRED, { ns: "errors" }),
  OAUTH_GOOGLE_LOGIN_FAILED: (t) => t(($) => $.OAUTH_GOOGLE_LOGIN_FAILED, { ns: "errors" }),
};

// The sign-in error page (#531, #539): the error's message from the catalog
// in the page's language, with its code on the card so a report can quote
// it. The English `message` stays in the server log only.
export function renderOAuthErrorPage(
  error: {
    code: OAuthPageErrorCode;
    params?: ErrorParams;
  },
  locale: Locale = DEFAULT_LOCALE,
): string {
  const t = getFixedT(locale, "server");
  const text = OAUTH_PAGE_MESSAGES[error.code](getFixedT(locale, "errors"), error.params ?? {});
  const body =
    `<div class="card" data-error-code="${escapeHtml(error.code)}">` +
    `<p>${text}</p>` +
    `<p class="url"><code>${escapeHtml(error.code)}</code></p></div>`;
  return page(locale, t(($) => $.oauth.error.title), body);
}
