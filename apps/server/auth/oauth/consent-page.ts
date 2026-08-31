// Server-rendered consent / error pages for the OAuth connector flow. No
// JS, no CSS framework -- plain HTML so it renders identically in the
// in-app browser Claude / claude.ai / Claude Code open for the redirect.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Authorization flow" step 4).

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="cs">
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

export function renderConsentPage(params: ConsentPageParams): string {
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
    ? `<div class="warning">Tato aplikace požaduje přihlášení pro lokální (loopback) adresu <strong>${escapeHtml(
        redirectHost,
      )}</strong> -- typicky jde o aplikaci běžící na tomto počítači.</div>`
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
  <p><span class="client">${escapeHtml(params.clientName)}</span> žádá o přístup k vašemu Portuni účtu.</p>
  <p class="url">${escapeHtml(params.clientId)}</p>
  <p>Po povolení bude aplikace přesměrována na:</p>
  <p class="url">${escapeHtml(params.redirectUri)}</p>
  ${loopbackWarning}
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="token" value="${escapeHtml(params.continuationToken)}">
    <div class="actions">
      <button type="submit" name="decision" value="deny">Odmítnout</button>
      <button type="submit" name="decision" value="allow">Povolit</button>
    </div>
  </form>
</div>`;

  return page("Portuni -- žádost o přístup", body);
}

export function renderOAuthErrorPage(message: string): string {
  const body = `<div class="card"><p>${escapeHtml(message)}</p></div>`;
  return page("Portuni -- chyba přihlášení", body);
}
