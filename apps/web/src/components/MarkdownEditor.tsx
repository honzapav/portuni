// Controlled CodeMirror 6 markdown SOURCE editor (no rendered preview).
// Cmd/Ctrl+S triggers onSave. Memoize extensions to avoid StrictMode churn.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSave?: (value: string) => void;
};

const basicSetup: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
};

// CodeMirror's own UI text (search panel, go-to-line, folding, screen-reader
// announcements) keyed by the English phrase CodeMirror asks for, covering the
// packages basicSetup pulls in (search, language, view, commands,
// autocomplete, lint).
function codeMirrorPhrases(t: TFunction<"common">): Record<string, string> {
  return {
    Find: t(($) => $.editor.codemirror.find),
    Replace: t(($) => $.editor.codemirror.replace_field),
    next: t(($) => $.editor.codemirror.next),
    previous: t(($) => $.editor.codemirror.previous),
    all: t(($) => $.editor.codemirror.all),
    "match case": t(($) => $.editor.codemirror.match_case),
    regexp: t(($) => $.editor.codemirror.regexp),
    "by word": t(($) => $.editor.codemirror.by_word),
    replace: t(($) => $.editor.codemirror.replace),
    "replace all": t(($) => $.editor.codemirror.replace_all),
    close: t(($) => $.editor.codemirror.close),
    "Go to line": t(($) => $.editor.codemirror.go_to_line),
    go: t(($) => $.editor.codemirror.go),
    "replaced $ matches": t(($) => $.editor.codemirror.replaced_matches),
    "replaced match on line $": t(($) => $.editor.codemirror.replaced_match_on_line),
    "current match": t(($) => $.editor.codemirror.current_match),
    "on line": t(($) => $.editor.codemirror.on_line),
    "Control character": t(($) => $.editor.codemirror.control_character),
    "Folded lines": t(($) => $.editor.codemirror.folded_lines),
    "Unfolded lines": t(($) => $.editor.codemirror.unfolded_lines),
    to: t(($) => $.editor.codemirror.to),
    "folded code": t(($) => $.editor.codemirror.folded_code),
    unfold: t(($) => $.editor.codemirror.unfold),
    "Fold line": t(($) => $.editor.codemirror.fold_line),
    "Unfold line": t(($) => $.editor.codemirror.unfold_line),
    "Selection deleted": t(($) => $.editor.codemirror.selection_deleted),
    Completions: t(($) => $.editor.codemirror.completions),
    Diagnostics: t(($) => $.editor.codemirror.diagnostics),
    "No diagnostics": t(($) => $.editor.codemirror.no_diagnostics),
  };
}

export default function MarkdownEditor({ value, onChange, onSave }: Props) {
  // t changes identity with the language, so the phrases are rebuilt and
  // the editor reconfigured when the language switches.
  const { t, i18n } = useTranslation("common");
  const phrases = useMemo(() => EditorState.phrases.of(codeMirrorPhrases(t)), [t, i18n.language]);
  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: (view) => {
              onSave?.(view.state.doc.toString());
              return true;
            },
          },
        ]),
      ),
    [onSave],
  );

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage }), EditorView.lineWrapping, saveKeymap, phrases],
    [saveKeymap, phrases],
  );

  return (
    <CodeMirror
      value={value}
      theme={oneDark}
      height="100%"
      style={{ height: "100%" }}
      extensions={extensions}
      basicSetup={basicSetup}
      onChange={onChange}
    />
  );
}
