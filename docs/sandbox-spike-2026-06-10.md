# Spike: Seatbelt sandbox jako univerzální disková scope brána

Datum: 2026-06-10. Výsledek: **průchozí** — všechny rozhodovací otázky
dopadly kladně. Krok 4 (generování profilu ze scope při `pty_spawn`,
wrapper `portuni run`) může stavět na tomto profilu.

## Kontext

Per-harness enforcement (Claude hooks, Codex `writable_roots`,
`.cursor/rules`) se rozjíždí a v auto modech nic nevynucuje. Jediná
vrstva společná všem agentům je OS: agenta spouští Portuni (`pty_spawn`),
takže ho může obalit kernelovým sandboxem s allowlistem vygenerovaným ze
scope (home mirror RW, depth-1 sousedé RO, zbytek PORTUNI_ROOT deny).

## Ověřený profil

```scheme
(version 1)
(allow default)
(deny file-read* file-write* (subpath "<PORTUNI_ROOT>"))
(allow file-read-metadata (subpath "<PORTUNI_ROOT>"))
(allow file-read* file-write* (subpath "<HOME_MIRROR>"))
(allow file-read* (subpath "<NEIGHBOR_MIRROR>"))   ; jeden řádek na souseda
```

Pozdější pravidla vyhrávají nad dřívějšími. `allow default` nechává
zbytek systému (binárky, ~/.claude, keychain, síť) bez omezení — chráníme
specificky znalostní graf, nestavíme obecný jail.

## Zjištění

1. **Sémantika sedí přesně.** Home RW funguje, soused RO funguje (write
   → EPERM), cizí mirror read → EPERM, výpis PORTUNI_ROOT → EPERM.
2. **`claude` (2.1.170) i `codex` (0.137.0) pod profilem normálně běží**
   (`sandbox-exec -f profil zsh -lc 'claude --version'`).
3. **Past: symlinkované cesty.** Seatbelt matchuje reálné cesty —
   `/tmp/...` v profilu nikdy nematchne (je to symlink na
   `/private/tmp`). Generátor profilu musí cesty prohnat realpath.
4. **Past: git discovery.** `git init/status` statuje rodičovské
   adresáře; plný deny na PORTUNI_ROOT ho rozbije s „Invalid path …
   Operation not permitted". Řeší `(allow file-read-metadata (subpath
   root))` — stat/traverse projde, obsah ne. Vedlejší efekt: stat známé
   cesty cizího mirroru prozradí existenci a velikost souboru, ne obsah.
   Přijatelné (názvy nodes nejsou tajemství, obsah ano).
5. `sandbox-exec` je formálně deprecated, ale plně funkční — staví na
   něm i Claude Code vlastní sandbox a Anthropic `sandbox-runtime`
   (Seatbelt na macOS, bubblewrap na Linuxu), který je kandidát pro
   krok 4 místo ručních profilů.

## Otevřené pro krok 4

- Expanze za běhu: hranice profilu je statická → server materializuje
  soubory expandované node do read-only staging uvnitř home mirroru
  (`<mirror>/.portuni-scope/<node>/`).
- Allowlist systémových cest doladit podle reálného provozu (cache,
  toolchainy) — s `allow default` by třecích ploch mělo být minimum.
- `portuni run <agent>` wrapper pro terminály spuštěné mimo appku.
