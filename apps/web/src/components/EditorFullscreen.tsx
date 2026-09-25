// Distraction-free, full-window editor overlay (Option A). Slim top bar.
// Rendered via a portal to document.body so the `fixed inset-0` overlay can
// never be clipped or contained by an ancestor's overflow/transform.
// The header mirrors EditorPane's: same right-hand cluster in the same
// slots, ⤡ where the pane has ⤢, and × appended after it — the only thing
// that leaves is "zpět" (collapsing returns to the pane, which has it).
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileEditor } from "../lib/use-file-editor";
import { EditorBody, EditorFileName, EditorHeaderActions, type EditorMode } from "./EditorPane";

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
  const { t } = useTranslation("common");
  const ed = editor;
  const filename = relPath.split("/").pop() ?? relPath;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
      <div className="flex min-h-[42px] items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <EditorFileName filename={filename} dirty={ed.dirty} />
        <EditorHeaderActions ed={ed} relPath={relPath} mode={mode} onModeChange={onModeChange}>
          <Button variant="ghost" size="icon-sm" onClick={onCollapse} title={t(($) => $.editor.collapse_title)} className="text-muted-foreground">
            <Minimize2 />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title={t(($) => $.editor.close_title)} className="text-muted-foreground">
            <X />
          </Button>
        </EditorHeaderActions>
      </div>
      <EditorBody ed={ed} relPath={relPath} mode={mode} capWidth />
    </div>,
    document.body,
  );
}
