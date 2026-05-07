import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { AGENT_PRESETS, DEFAULT_AGENT_COMMAND } from "../lib/settings";
import McpServerSection from "./McpServerSection";
import SettingsActorsPanel from "./SettingsPage.actors";

type Props = {
  agentCommand: string;
  onAgentCommandChange: (value: string) => void;
};

type SubTab = "general" | "actors";

export default function SettingsPage({
  agentCommand,
  onAgentCommandChange,
}: Props) {
  const [tab, setTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("settingsTab") === "actors" ? "actors" : "general";
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "general") url.searchParams.delete("settingsTab");
    else url.searchParams.set("settingsTab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  const [draft, setDraft] = useState(agentCommand);

  useEffect(() => {
    setDraft(agentCommand);
  }, [agentCommand]);

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
    <div className="scroll-thin h-full w-full overflow-y-auto bg-[var(--color-bg)]">
      <div className="mx-auto flex max-w-[840px] flex-col gap-8 px-8 py-8">
        <header>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
            Nastavení
          </h1>
          <p className="mt-1 text-[13px] text-[var(--color-text-dim)]">
            Změny se ukládají automaticky.
          </p>
          <div className="mt-3 flex w-max gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            <button
              onClick={() => setTab("general")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "general"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Obecné
            </button>
            <button
              onClick={() => setTab("actors")}
              className={`rounded px-3 py-1 text-[13px] transition-colors ${
                tab === "actors"
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              Aktéři
            </button>
          </div>
        </header>

        {tab === "actors" && <SettingsActorsPanel />}

        {tab === "general" && (
          <>
            <McpServerSection />

            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
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
                            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
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
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[14px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
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
                <pre className="scroll-thin max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {preview}
                </pre>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
