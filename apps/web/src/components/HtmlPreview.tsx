// Rendered HTML preview (read-only) in a sandboxed iframe. Scripts + external
// resources are allowed, but the frame runs with NO allow-same-origin, so it
// sits in an opaque origin and cannot reach our DOM, cookies, token or API.
//
// Web (Vite): there is no app CSP, so srcDoc executes scripts directly.
// Desktop (Tauri): the strict app CSP is inherited by srcdoc/blob frames and
// would block scripts, so we load the file over the portuni-html:// custom
// protocol (its own origin + permissive CSP, served by Rust from disk).
import { useState } from "react";
import { isTauri, openPathExternal } from "../lib/backend-url";

// Build the protocol URL for the desktop webview. The absolute path is
// percent-encoded as the URL path; the Rust handler decodes + scope-checks it.
function protocolUrl(absPath: string): string {
  return `portuni-html://localhost/${encodeURIComponent(absPath)}`;
}

export default function HtmlPreview({
  content,
  localPath,
}: {
  content: string;
  localPath: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const useProtocol = isTauri() && localPath !== null;

  async function copyPath() {
    if (!localPath) return;
    try {
      await navigator.clipboard.writeText(localPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject without a user gesture / permission; ignore.
    }
  }

  return (
    <div className="flex h-full flex-col">
      {localPath && (
        <div className="flex justify-end border-b border-[var(--color-border)] px-2 py-1">
          <button
            onClick={copyPath}
            title="Kopírovat cestu k souboru"
            className="rounded px-2 py-0.5 text-[11.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            {copied ? "Zkopírováno" : "Kopírovat cestu"}
          </button>
          {isTauri() && (
            <button
              onClick={() => localPath && void openPathExternal(localPath)}
              title="Otevřít v prohlížeči"
              className="rounded px-2 py-0.5 text-[11.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            >
              Otevřít v prohlížeči
            </button>
          )}
        </div>
      )}
      <iframe
        title="HTML náhled"
        sandbox="allow-scripts"
        {...(useProtocol
          ? { src: protocolUrl(localPath as string) }
          : { srcDoc: content })}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
