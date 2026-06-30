// Distraction-free, full-window editor overlay (Option A). Slim top bar.
// Rendered via a portal to document.body so the `fixed inset-0` overlay can
// never be clipped or contained by an ancestor's overflow/transform.
import { createPortal } from "react-dom";
import { Minimize2, Save, X } from "lucide-react";
import type { FileEditor } from "../lib/use-file-editor";
import { EditorBody, type EditorMode } from "./EditorPane";

export default function EditorFullscreen({
  editor,
  relPath,
  mode,
  onModeChange,
  onCollapse,
  onClose,
}: {
  editor: FileEditor;
  relPath: string;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  onCollapse: () => void; // back to pane
  onClose: () => void; // close editor entirely
}) {
  const ed = editor;
  const filename = relPath.split("/").pop() ?? relPath;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <button
          onClick={onCollapse}
          title="Zmenšit do panelu"
          className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          <Minimize2 size={14} />
        </button>
        <span className="truncate text-[13.5px] text-[var(--color-text)]">
          {filename}
          {ed.dirty && <span className="ml-1 text-[var(--color-node-process)]">●</span>}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => ed.save()}
            disabled={ed.saving || !ed.dirty}
            title="Uložit (Cmd/Ctrl+S)"
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2.5 py-1 text-[12.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
          >
            <Save size={13} /> {ed.saving ? "Ukládám…" : "Uložit"}
          </button>
          <button
            onClick={onClose}
            title="Zavřít editor"
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>
        </span>
      </div>
      <EditorBody ed={ed} mode={mode} onModeChange={onModeChange} capWidth />
    </div>,
    document.body,
  );
}
