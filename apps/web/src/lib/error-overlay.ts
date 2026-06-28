// Last-resort visible error surface for the desktop webview.
//
// Release Tauri builds ship without devtools (see src-tauri/Cargo.toml),
// so an uncaught error normally just white-screens the app with no way to
// read what happened. This module renders any uncaught error / unhandled
// rejection into a fixed overlay appended directly to <body> — OUTSIDE the
// React root — so it survives a React unmount and stays readable. It is
// the diagnostic counterpart to ErrorBoundary (which only catches
// render-phase throws; async throws in event listeners / rAF land here).
//
// Errors are also mirrored to console.error and, when running under Tauri,
// to the Rust log via the existing log plumbing is not available from JS,
// so the on-screen overlay is the primary channel.

let installed = false;
let overlayEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;
  const el = document.createElement("div");
  el.setAttribute("data-portuni-error-overlay", "");
  Object.assign(el.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: "rgba(10, 11, 15, 0.97)",
    color: "#ffb4b4",
    font: "12.5px/1.5 ui-monospace, Menlo, monospace",
    padding: "24px",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as Partial<CSSStyleDeclaration>);

  const header = document.createElement("div");
  header.textContent =
    "Portuni narazil na chybu (tento panel nahrazuje bílou obrazovku). Zkopíruj text níže.";
  Object.assign(header.style, {
    color: "#ffe08a",
    marginBottom: "12px",
    fontWeight: "600",
  } as Partial<CSSStyleDeclaration>);

  const dismiss = document.createElement("button");
  dismiss.textContent = "Skrýt";
  Object.assign(dismiss.style, {
    marginLeft: "12px",
    padding: "2px 10px",
    border: "1px solid #555",
    borderRadius: "4px",
    background: "transparent",
    color: "#ddd",
    cursor: "pointer",
  } as Partial<CSSStyleDeclaration>);
  dismiss.onclick = () => {
    el.style.display = "none";
  };
  header.appendChild(dismiss);

  const list = document.createElement("div");
  listEl = list;

  el.appendChild(header);
  el.appendChild(list);
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

export function reportError(label: string, err: unknown, extra?: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(`[portuni:${label}]`, err, extra ?? "");
  } catch {
    // console may be unavailable — ignore
  }
  try {
    const el = ensureOverlay();
    el.style.display = "block";
    const entry = document.createElement("div");
    Object.assign(entry.style, {
      borderTop: "1px solid #333",
      paddingTop: "10px",
      marginTop: "10px",
    } as Partial<CSSStyleDeclaration>);
    const message =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
        : String(err);
    entry.textContent = `[${label}] ${message}${extra ? `\n${extra}` : ""}`;
    listEl?.appendChild(entry);
  } catch {
    // DOM may be in a bad state — the console.error above is the fallback
  }
}

// Installs global handlers. Idempotent. Call once, as early as possible.
export function installGlobalErrorOverlay(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    reportError("window.onerror", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError("unhandledrejection", e.reason);
  });
}
