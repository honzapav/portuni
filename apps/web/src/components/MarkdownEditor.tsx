// Controlled CodeMirror 6 markdown SOURCE editor (no rendered preview).
// Cmd/Ctrl+S triggers onSave. Memoize extensions to avoid StrictMode churn.
import { useMemo } from "react";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

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

export default function MarkdownEditor({ value, onChange, onSave }: Props) {
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
    () => [markdown({ base: markdownLanguage }), EditorView.lineWrapping, saveKeymap],
    [saveKeymap],
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
