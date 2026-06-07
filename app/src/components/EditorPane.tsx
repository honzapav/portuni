// Compact source editor for the workspace right column. Swaps in for the
// node detail (Option C). "← zpět" returns to detail; ⤢ expands to fullscreen.
import { ChevronLeft, Maximize2, Save } from "lucide-react";
import type { FileEditor } from "../lib/use-file-editor";
import MarkdownEditor from "./MarkdownEditor";

export default function EditorPane({
  editor,
  relPath,
  onClose,
  onExpand,
}: {
  editor: FileEditor;
  relPath: string;
  onClose: () => void;
  onExpand: () => void;
}) {
  const ed = editor;
  const filename = relPath.split("/").pop() ?? relPath;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <button
          onClick={onClose}
          title="Zpět na detail"
          className="flex items-center gap-1 text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={14} /> zpět
        </button>
        <span className="ml-1 truncate text-[13px] text-[var(--color-text)]">
          {filename}
          {ed.dirty && <span className="ml-1 text-[var(--color-node-process)]">●</span>}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => ed.save()}
            disabled={ed.saving || !ed.dirty}
            title="Uložit (Cmd/Ctrl+S)"
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
          >
            <Save size={12} /> {ed.saving ? "Ukládám…" : "Uložit"}
          </button>
          <button
            onClick={onExpand}
            title="Na celé okno"
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <Maximize2 size={13} />
          </button>
        </span>
      </div>
      <EditorBody ed={ed} />
    </div>
  );
}

// Shared body: loading / error / conflict banner / editor. Reused by fullscreen.
export function EditorBody({ ed }: { ed: FileEditor }) {
  if (ed.status.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]">
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
      {ed.conflict && (
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 text-[12.5px] text-[var(--color-text)]">
          <span>Soubor se mezitím změnil na disku.</span>
          <button onClick={ed.keepMine} className="underline hover:no-underline">
            Ponechat moje
          </button>
          <button onClick={ed.reloadTheirs} className="underline hover:no-underline">
            Načíst jejich
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <MarkdownEditor value={ed.content} onChange={ed.onChange} onSave={(v) => ed.save(v)} />
      </div>
    </div>
  );
}
