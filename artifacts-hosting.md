# Artefakty v Portuni -- hosting, sprava a kontext

## Kontext

Pri reseni dvou separatnich otazek (kam davat HTML soubory / jak editovat markdown pres Git) se ukazalo, ze jde o jeden problem: **sprava a discovery internich artefaktu napric projekty v ramci ekosystemu Portuni**.

---

## Definice problemu

Tym Workflow.ooo/Tempo vytvari ruzne typy artefaktu:
- HTML soubory (reporty, vystupy z n8n, vystupy z Claude, debug vizualizace)
- Markdown dokumenty (procesni dokumentace, onboarding, metodiky)

Artefakty:
- Vznikaji na ruznych mistech (ruzne projekty, ruzne nastroje)
- Jsou **urcene pro interni sdileni** (tym, ne klienti)
- Nikdy nejsou "hotove" -- prubezne se vyviji
- Potrebuji **stabilni URL** pro sdileni
- Musi byt **napojene na Portuni** (kazdy artefakt = uzel s hranami k projektu, osobam, procesum)

---

## Navrzena infrastruktura

### Storage: GitHub repo `workflow-pages`

Jeden centralni repo jako storage backend pro vsechny artefakty.

```
workflow-pages/
|-- adamai/
|   |-- q1-report.html
|   +-- onboarding.md
|-- evoluce/
|   |-- scoring-debug.html
|   +-- metodika.md
|-- naturamed/
|   +-- analyza.html
+-- index.html   <-- auto-generovany prehled (GitHub Action)
```

**Proc GitHub:**
- Verzovani zdarma
- GitHub API umoznuje commit bez lokalniho gitu (dulezite pro n8n, Claude, projekty bez gitu)
- Branch protection + PR workflow pro AI agenty

### Hosting: Cloudflare Pages + custom domena

```
pages.workflow.ooo/adamai/q1-report
pages.workflow.ooo/evoluce/scoring-debug
pages.workflow.ooo/naturamed/analyza
```

- Automaticky deployment pri kazdem push do repo
- Stabilni URL (aktualizace souboru = stejna URL)
- Prakticky zdarma

### Publish workflow

```bash
# Shell funkce -- funguje odkudkoliv, i z projektu bez gitu
html-publish() {
  local file="$1"     # cesta k souboru
  local dest="$2"     # napr. "adamai/q1-report"

  gh api repos/workflowooo/workflow-pages/contents/"$dest".html \
    --method PUT \
    --field message="publish: $dest" \
    --field content="$(base64 < "$file")"
}
```

Pro n8n: GitHub node s primym commitem pres API.
Pro Claude Code: primy commit nebo gh CLI.

---

## Napojeni na Portuni

### Kazdy artefakt = uzel v knowledge graphu

```
Portuni node: artifact
|-- id: uuid
|-- type: artifact
|-- format: html | markdown
|-- url: pages.workflow.ooo/adamai/q1-report
|-- title: "ADAMAI Q1 Report"
|-- created_by: honza
|-- created_at: 2026-04-03
+-- edges:
    |-- -> projekt: ADAMAI
    |-- -> oblast: reporting
    |-- -> osoba: vendula
    +-- -> metodika: okr
```

### Publish akce = create/update Portuni node

Idealni workflow:

```
publish ./report.html "adamai/q1-report"
  1. commit do GitHub (storage)
  2. create_node v Portuni (meaning + discovery)
  3. vrati URL: pages.workflow.ooo/adamai/q1-report
```

Tohle vyzaduje bud:
- MCP tool `publish_artifact` v Portuni serveru
- nebo webhook z GitHub Actions -> Portuni API

---

## Markdown editor pro dokumentaci (Keystatic)

Z drivejsi konverzace byl jako nejlepsi fit identifikovan **Keystatic** (open-source, git-backed CMS).

### Co Keystatic resi

- WYSIWYG markdown editor s UI (Obsidian-like feel)
- Git je plne abstrahovany -- editorovi staci prohlizec
- Automaticke commity do GitHub repo
- Schema-driven frontmatter (formulare z TypeScript definice)
- Podpora PR workflow (vhodne pro AI agenty: vzdy branch, nikdy primy push do main)

### Integrace do stejneho repo

Keystatic muze editovat markdown soubory ve stejnem `workflow-pages` repozitari:

```
workflow-pages/
|-- adamai/
|   |-- q1-report.html     <-- publish pres gh API / n8n
|   +-- onboarding.md      <-- editovatelne pres Keystatic UI
```

Keystatic config definuje, ktere slozky a soubory jsou "content collections" -- muze byt omezeno jen na `.md` soubory.

### Deployment Keystatic admin UI

- Soucast Astro/Next.js aplikace (nebo standalone)
- Muze bezet na `admin.pages.workflow.ooo` nebo jako `/admin` route
- Auth pres GitHub OAuth nebo Cloudflare Access (pro interni pouziti)

### Limity Keystatic

- Nepodporuje Gitea (jen GitHub/GitLab)
- Role management je zakladni (GitHub Teams resi pristup na repo urovni)
- Pri stovkach souboru muze byt GitHub API listing pomalejsi -> TinaCMS jako alternativa (ma vlastni indexovaci vrstvu)

---

## Co zatim neni rozhodnuto

1. **Keystatic vs. jiny markdown editor** -- Keystatic je dobry fit, ale nebylo finalizovano
2. **Struktura Portuni nodu pro artefakt** -- konceptualne jasne, schema teprve vznika
3. **MCP tool pro publish** -- `publish_artifact` by mel byt soucasti Portuni MCP serveru
4. **Index stranka** -- GitHub Action generujici prehled vsech artefaktu (galerie s filtry)

---

## Dalsi kroky

- [ ] Definovat `artifact` jako node type v Portuni schema (vedle process, project, area, principle, methodology)
- [ ] Navrhnout MCP tool `publish_artifact` (commit + create node)
- [ ] Rozhodnout: Keystatic pro markdown editing ano/ne
- [ ] Vytvorit GitHub repo `workflow-pages` a napojit Cloudflare Pages
- [ ] GitHub Action pro generovani index stranky
- [ ] Shell funkce `html-publish` a `md-publish`
