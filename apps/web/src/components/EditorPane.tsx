// Compact source editor for the workspace right column. Swaps in for the
// node detail (Option C). "← zpět" returns to detail; ⤢ expands to fullscreen.
import { ChevronLeft, Eye, Loader2, Maximize2, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import type { FileEditor } from "../lib/use-file-editor";
import { isHtmlPath } from "../App";
import { isShowtimePath } from "../lib/showtime";
import HtmlPreview from "./HtmlPreview";
import { lazy, Suspense, type ReactNode } from "react";

// The two heaviest leaves in the app, and neither is on the startup path:
// CodeMirror is ~624 kB of the bundle (213 kB gzipped) and react-markdown +
// remark ~154 kB (45 kB), but nothing renders either until a file is actually
// open. Eagerly imported they were parsed by every window at launch.
const MarkdownEditor = lazy(() => import("./MarkdownEditor"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

export type EditorMode = "edit" | "preview";

// A Showtime deck has no source to edit here: the editor holds the preview
// the bundle carries, so the mode toggle and Save are not offered for it.
export function isPreviewOnly(relPath: string): boolean {
  return isShowtimePath(relPath);
}

export default function EditorPane({
  editor,
  relPath,
  mode,
  onModeChange,
  onClose,
  onExpand,
}: {
  editor: FileEditor;
  relPath: string;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  onClose: () => void;
  onExpand: () => void;
}) {
  const ed = editor;
  const filename = relPath.split("/").pop() ?? relPath;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex min-h-[42px] items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <Button variant="ghost" size="sm" onClick={onClose} title="Zpět na detail" className="text-muted-foreground">
          <ChevronLeft /> zpět
        </Button>
        <EditorFileName filename={filename} dirty={ed.dirty} />
        <EditorHeaderActions ed={ed} relPath={relPath} mode={mode} onModeChange={onModeChange}>
          <Button variant="ghost" size="icon-sm" onClick={onExpand} title="Na celé okno" className="text-muted-foreground">
            <Maximize2 />
          </Button>
        </EditorHeaderActions>
      </div>
      <EditorBody ed={ed} relPath={relPath} mode={mode} />
    </div>
  );
}

export function EditorFileName({ filename, dirty }: { filename: string; dirty: boolean }) {
  return (
    <span className="min-w-0 flex-1 truncate px-1 text-[13.5px] text-[var(--color-text)]">
      {filename}
      {dirty && <span className="ml-1 text-[var(--color-node-process)]">●</span>}
    </span>
  );
}

// The right-hand cluster of both editor headers (pane and fullscreen), in
// fixed slots so nothing shifts between the two: [Uložit] [Náhled | Editace]
// then whatever the shell appends (⤢ in the pane, ⤡ and × in fullscreen).
// Uložit is rendered only in edit mode and sits LEFT of the mode toggle, so
// its appearance never moves the toggle or the window controls.
export function EditorHeaderActions({
  ed,
  relPath,
  mode,
  onModeChange,
  children,
}: {
  ed: FileEditor;
  relPath: string;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  children?: ReactNode;
}) {
  const previewOnly = isPreviewOnly(relPath);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {!previewOnly && mode === "edit" && (
        <Button
          size="sm"
          onClick={() => ed.save()}
          disabled={ed.saving || !ed.dirty}
          title="Uložit (Cmd/Ctrl+S)"
        >
          <Save /> {ed.saving ? "Ukládám…" : "Uložit"}
        </Button>
      )}
      {!previewOnly && <ModeToggle mode={mode} onChange={onModeChange} />}
      {children}
    </span>
  );
}

// Shared body: loading / error / conflict banner / editor or preview. Reused by
// fullscreen. Mode state is LIFTED (App owns it next to editorFile): the pane
// and fullscreen mount separate EditorBody instances, so local state here used
// to reset Náhled back to Editace on every expand/collapse.
export function EditorBody({
  ed,
  relPath,
  mode,
  // Cap the content column width and center it. Only the fullscreen shell
  // sets this — on a 4K monitor an uncapped editor/preview stretches the
  // full window width (unreadable line lengths). The narrow right pane
  // leaves it off so it keeps using the whole column.
  capWidth = false,
}: {
  ed: FileEditor;
  relPath: string;
  mode: EditorMode;
  capWidth?: boolean;
}) {
  const previewOnly = isPreviewOnly(relPath);
  const effectiveMode: EditorMode = previewOnly ? "preview" : mode;
  const fullWidthPreview = isHtmlPath(relPath) || isShowtimePath(relPath);
  if (ed.status.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[var(--color-text-dim)]">
        <Loader2 size={13} className="animate-spin" />
        Načítám…
      </div>
    );
  }
  if (ed.status.kind === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--color-danger)]">
        {ed.status.message}
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Floating change/conflict banner: an overlay pinned to the top of
          the content, centered, so it stays in view (and in the user's
          eyeline) regardless of scroll position or window width — the old
          in-flow top strip was easy to miss on large monitors. */}
      {ed.conflict && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-[var(--color-danger-border,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_14%,var(--color-bg))] px-4 py-2 text-[12.5px] text-[var(--color-text)] shadow-lg">
            <span>Soubor se mezitím změnil na disku.</span>
            <Button variant="link" size="sm" onClick={ed.keepMine} className="h-auto p-0">
              Ponechat moje
            </Button>
            <Button variant="link" size="sm" onClick={ed.reloadTheirs} className="h-auto p-0">
              Načíst jejich
            </Button>
          </div>
        </div>
      )}
      {!ed.conflict && ed.externalChange && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-accent)_14%,var(--color-bg))] px-4 py-2 text-[12.5px] text-[var(--color-text)] shadow-lg">
            <span>Soubor se na disku změnil.</span>
            <Button variant="link" size="sm" onClick={ed.reloadTheirs} className="h-auto p-0">
              Načíst aktuální verzi
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Cap the column width in fullscreen for readable line length --
            EXCEPT the rendered HTML preview, which is a self-contained
            document that should use the full window width. */}
        <div
          className={`mx-auto h-full w-full${
            capWidth && !(fullWidthPreview && effectiveMode === "preview") ? " max-w-4xl" : ""
          }`}
        >
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-text-dim)]">
                Načítám…
              </div>
            }
          >
            {effectiveMode === "edit" ? (
              <MarkdownEditor value={ed.content} onChange={ed.onChange} onSave={(v) => ed.save(v)} />
            ) : isShowtimePath(relPath) ? (
              <HtmlPreview
                content={ed.content}
                localPath={ed.localPath}
                version={ed.version}
                kind="showtime"
                nodeId={ed.nodeId}
              />
            ) : isHtmlPath(relPath) ? (
              <HtmlPreview content={ed.content} localPath={ed.localPath} version={ed.version} />
            ) : (
              <MarkdownPreview value={ed.content} />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

// Segmented edit/preview switch: a shadcn ButtonGroup of two outline
// buttons, the active one filled via aria-pressed.
function ModeToggle({
  mode,
  onChange,
}: {
  mode: EditorMode;
  onChange: (m: EditorMode) => void;
}) {
  const pressed = "aria-pressed:bg-muted aria-pressed:text-foreground dark:aria-pressed:bg-muted";
  return (
    <ButtonGroup aria-label="Režim editoru">
      <Button
        variant="outline"
        size="sm"
        aria-pressed={mode === "preview"}
        onClick={() => onChange("preview")}
        title="Náhled"
        className={pressed}
      >
        <Eye /> Náhled
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={mode === "edit"}
        onClick={() => onChange("edit")}
        title="Editace"
        className={pressed}
      >
        <Pencil /> Editace
      </Button>
    </ButtonGroup>
  );
}
