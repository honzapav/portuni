# Portuni glossary

The fixed English term for every product concept, and the Czech term the UI
already uses. A catalog entry (`locales/en/*.json`, `locales/cs/*.json`) uses
these terms and nothing else; a new concept is added here before its first
key. Spec: `docs/superpowers/specs/2026-09-25-localization-design.md`.

Casing: English UI labels use sentence case ("Hand off", "Close thread"),
never Title Case. Czech keeps its own casing and „…“ quotes.

## Workspaces and modes

| Czech (UI today) | English | Notes |
|---|---|---|
| workspace | workspace | Never "space" or "project". |
| osobní workspace | personal workspace | `data_mode: "local"`. |
| týmový workspace | team workspace | `data_mode: "central"`. |
| centrální server | central server | The process at `api.portuni.com`. |
| synchronizační agent | sync agent | The device's sidecar in a team workspace. |
| zařízení | device | |
| účet | account | Settings → Account. |
| přihlášení / přihlásit se | sign-in / sign in | Not "log in". |

## Graph (POPP)

| Czech | English | Notes |
|---|---|---|
| uzel | node | |
| organizace | organization | US spelling throughout. |
| projekt | project | |
| proces | process | |
| oblast | area | |
| princip | principle | |
| vztah / hrana | relation | "edge" only in developer text. |
| graf | graph | |
| aktér | actor | |
| osoba | person | |
| pozice | position | |
| automatizace | automation | |
| scope | scope | |

## Files and sync

| Czech | English | Notes |
|---|---|---|
| mirror | mirror | The node's local folder. Never "clone" or "copy". |
| soubor | file | |
| složka | folder | Not "directory". |
| vzdálené úložiště / remote | remote | |
| synchronizace / synchronizovat | sync | Noun and verb. |
| konflikt | conflict | |
| uložit na remote (`portuni_store`) | store | |
| stáhnout (pull) | pull | |
| nahrát (push) | push | |
| vyžaduje opravu | needs repair | `repair_needed`. |

## Work and threads

| Czech | English | Notes |
|---|---|---|
| Práce | Work | The task surface. |
| Přehled | Overview | |
| úkol / úloha | task | |
| vlákno | thread | A session as the user sees it. |
| session | session | Developer and agent text only; the UI says thread. |
| CLI relace | CLI session | A session opened by hand in a terminal (not a thread); the one place the UI says session. |
| runner | runner | The agent CLI that drives a thread (Claude Code, Codex, ...). |
| běh | run | One runner process on a thread. |
| zpráva | message | |
| otázka | question | A question card from the agent. |
| Předat | Hand off | Writes the handoff file. |
| předání / handoff | handoff | The file Předat writes. |
| Navázat na handoff | Continue from handoff | |
| Pokračovat v nové session | Continue in a new thread | |
| Pozastavit / pozastavené | Suspend / suspended | A suspended thread resumes on the next message. |
| Uzavřít / uzavřené | Close / closed | Only Close and the archive sweep reach `closed`. |
| Uzavřít vlákno | Close thread | |
| Přerušit | Interrupt | Cancels the current turn only. |
| tah | turn | One prompt and the agent's answer to it within a run. |
| model | model | |
| úsilí (effort) | effort | |
| kontext | context | The context window. |
| koncept | draft | An unsent message. |

## Records, access and runners

| Czech | English | Notes |
|---|---|---|
| odpovědnost | responsibility | |
| zdroj dat | data source | |
| nástroj | tool | |
| událost | event | |
| stav životního cyklu | lifecycle state | |
| zdraví (projektu) | health | |
| přístup / sdílení | access / sharing | |
| žádost o přístup | access request | |
| oprávnění | permission | |
| správce | admin | A user with the `admin` scope tier; plural "admins". |
| poskytovatel | provider | The service behind a runner (Anthropic for Claude Code). |
| instance (poskytovatele) | instance | A runner's provider instance. |
| konektor | connector | An MCP server the runner can reach. |
| token | token | |
| připojená aplikace | connected app | An OAuth grant. |
| přepis | transcript | A thread's conversation on the device. |
