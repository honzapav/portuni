import { useEffect, useRef, useState } from "react";
import { X, Check } from "lucide-react";
import { AGENT_PRESETS, DEFAULT_AGENT_COMMAND } from "../lib/settings";

type Props = {
  agentCommand: string;
  onAgentCommandChange: (value: string) => void;
  onClose: () => void;
};

export default function SettingsPanel({
  agentCommand,
  onAgentCommandChange,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(agentCommand);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(agentCommand);
  }, [agentCommand]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const commit = (value: string) => {
    const next = value.trim() || DEFAULT_AGENT_COMMAND;
    setDraft(next);
    onAgentCommandChange(next);
  };

  const matchingPreset = AGENT_PRESETS.find((p) => p.command === draft);

  const previewPath = "/Users/ty/workspaces/portuni/tvuj-projekt";
  const samplePrompt = [
    "Pracuješ na Portuni uzlu **Tvůj Projekt** (typ: project, id: `node_abc123`).",
    "",
    "Než cokoli uděláš, zavolej `portuni_get_node({ node_id: \"node_abc123\" })` pro obnovení stavu. Kontext níže je snapshot zachycený při generování promptu a může být zastaralý.",
    "",
    "---",
    "",
    "## Snapshot",
    "",
    "**Stav:** active",
    "**Lokální mirror:** `" + previewPath + "`",
    "",
    "### Propojení",
    "- **belongs_to**",
    "    -> Acme Corp _(organization, `node_org01`)_",
    "",
    "### Nedávné události",
    "- `[note]` 2026-04-21 -- Spuštěna implementace.",
    "",
    "---",
    "",
    "Až pochopíš stav, zeptej se mě, co bys měl dělat dál, nebo navrhni rozumný další krok na základě událostí výše.",
  ].join("\n");
  const escapedPrompt = `'${samplePrompt.replace(/'/g, "'\\''")}'`;
  const invocation = draft.includes("{prompt}")
    ? draft.replaceAll("{prompt}", escapedPrompt)
    : `${draft} ${escapedPrompt}`;
  const preview = `cd '${previewPath}' && ${invocation}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        className="flex max-h-[86vh] w-full max-w-[780px] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            Nastavení
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <X size={13} />
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-5">
          <div className="mb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            Příkaz agenta
          </div>
          <p className="mb-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Když zkopíruješ příkaz pro spuštění agenta z uzlu, Portuni ho prefixuje
            přechodem <code className="font-mono">cd</code> do lokální složky uzlu
            a spustí tenhle příkaz. Použij{" "}
            <code className="font-mono text-[var(--color-accent)]">
              {"{prompt}"}
            </code>{" "}
            tam, kde má být vygenerovaný prompt. Když placeholder vynecháš, prompt
            se připojí jako poslední argument.
          </p>

          <div className="mb-4 space-y-1.5">
            <div className="text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
              Předvolby
            </div>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_PRESETS.map((p) => {
                const active = matchingPreset?.id === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => commit(p.command)}
                    title={p.hint}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13.5px] transition-colors ${
                      active
                        ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 text-[var(--color-accent)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    {active && <Check size={11} />}
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="mb-1 block text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
            Šablona příkazu
          </label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit((e.target as HTMLInputElement).value);
              }
            }}
            spellCheck={false}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[14px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
            placeholder={DEFAULT_AGENT_COMMAND}
          />

          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[12.5px] font-medium uppercase tracking-wider text-[var(--color-text-dim)]">
                Náhled
              </div>
              <div className="text-[12px] text-[var(--color-text-dim)]">
                Vzorový uzel – skutečný prompt vznikne z vybraného uzlu.
              </div>
            </div>
            <pre className="scroll-thin max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              {preview}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
