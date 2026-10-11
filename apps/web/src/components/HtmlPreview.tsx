// Rendered HTML preview (read-only) in a sandboxed iframe. Scripts + external
// resources are allowed, but the frame runs with NO allow-same-origin, so it
// sits in an opaque origin and cannot reach our DOM, cookies, token or API.
//
// Web (Vite): there is no app CSP, so srcDoc executes scripts directly.
// Desktop (Tauri): the strict app CSP is inherited by srcdoc/blob frames and
// would block scripts, so we load the file over the portuni-html:// custom
// protocol (its own origin + permissive CSP, served by Rust from disk).
//
// Two kinds of file land here: an .html file, shown as it is, and a .showtime
// deck bundle, shown through the preview.html Showtime packs into it -- the
// server hands that entry over as `content`, and the protocol handler unzips
// it from the bundle at `localPath`. A bundle opens in Showtime, not a browser,
// and the handoff carries the node with it (`openInShowtime`).
import { displayError } from "../errors";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri, openPathExternal } from "../lib/backend-url";
import { protocolUrl } from "../lib/html-preview-url";
import { copyText } from "../lib/clipboard";
import { openInShowtime, showtimeInstalled } from "../lib/showtime";
import { Button } from "@/components/ui/button";

export type HtmlPreviewKind = "html" | "showtime";

export default function HtmlPreview({
  content,
  localPath,
  version = null,
  kind = "html",
  nodeId = null,
}: {
  content: string;
  localPath: string | null;
  // Version of `content` as loaded (sha256 from the file API). Changes on
  // every reload; the desktop iframe URL is keyed on it.
  version?: string | null;
  kind?: HtmlPreviewKind;
  // The node the file belongs to; a Showtime deck is handed over with it.
  nodeId?: string | null;
}) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  const [canOpenInShowtime, setCanOpenInShowtime] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const useProtocol = isTauri() && localPath !== null;

  useEffect(() => {
    if (kind !== "showtime") return;
    let cancelled = false;
    void showtimeInstalled().then((ok) => {
      if (!cancelled) setCanOpenInShowtime(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function copyPath() {
    if (!localPath) return;
    try {
      await copyText(localPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject without a user gesture / permission; ignore.
    }
  }

  // A failed handoff renders inline in the bar and nothing opens.
  async function openExternal() {
    if (!localPath) return;
    setOpenError(null);
    try {
      if (kind === "showtime") {
        if (!nodeId) {
          setOpenError(t(($) => $.editor.html_preview.deck_without_node));
          return;
        }
        await openInShowtime(nodeId, localPath);
      } else {
        await openPathExternal(localPath);
      }
    } catch (e) {
      setOpenError(displayError(e));
    }
  }

  const openButton =
    kind === "showtime"
      ? canOpenInShowtime && {
          label: t(($) => $.editor.html_preview.open_in_showtime),
          title: t(($) => $.editor.html_preview.open_in_showtime_title),
        }
      : isTauri() && {
          label: t(($) => $.editor.html_preview.open_in_browser),
          title: t(($) => $.editor.html_preview.open_in_browser),
        };

  return (
    <div className="flex h-full flex-col">
      {localPath && (
        <div className="flex items-center justify-end gap-1 border-b border-[var(--color-border)] px-2 py-1">
          {openError && (
            <span
              role="alert"
              title={openError}
              className="mr-auto truncate text-[11.5px] text-[var(--color-danger)]"
            >
              {openError}
            </span>
          )}
          <Button variant="ghost" size="xs" onClick={copyPath} title={t(($) => $.editor.html_preview.copy_path_title)} className="text-muted-foreground">
            {copied ? t(($) => $.editor.html_preview.copied) : t(($) => $.editor.html_preview.copy_path)}
          </Button>
          {openButton && (
            <Button variant="ghost" size="xs" onClick={() => void openExternal()} title={openButton.title} className="text-muted-foreground">
              {openButton.label}
            </Button>
          )}
        </div>
      )}
      <iframe
        title={
          kind === "showtime"
            ? t(($) => $.editor.html_preview.frame_title_showtime)
            : t(($) => $.editor.html_preview.frame_title_html)
        }
        sandbox="allow-scripts"
        {...(useProtocol
          ? { src: protocolUrl(localPath as string, version) }
          : { srcDoc: content })}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
