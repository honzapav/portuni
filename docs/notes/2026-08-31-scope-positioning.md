# Scope enforcement — konkurenční pozice

Podklad pro marketing. Shrnuje, kde stojí deterministické omezování kontextu
agenta (scope enforcement) vůči zbytku trhu a proč je to neobsazený prostor.

## Co řeší ostatní

| Vrstva | Kdo | Co dělá | Vztah k Portuni |
|---|---|---|---|
| Permissions-aware retrieval | Glean, enterprise search | Filtruje výsledky při dotazu podle ACL zdrojových systémů — uživatel nenajde, co nesmí otevřít | Vyřešený problém; Portuni permissions vrstva dělá totéž. Task-context ale Glean nemá: asistent čte cokoli, co smí uživatel |
| Schvalování akcí (HITL) | Claude Code permissions (deny/ask/allow + sandbox), LangGraph interrupts, MCP elicitation | Potvrzování nástrojů a zápisů člověkem; pravidla nad nástroji a cestami | Strukturálně blízko (sandbox ≈ mirror rw/ro, ask ≈ elicitace). Nikdo nedělá pravidla nad významem — uzly a vztahy grafu |
| Capability-based data flow | CaMeL (DeepMind, 2025) | Deterministický interpret vynucuje politiky nad daty; model klasifikaci nedrží, nemůže ji obejít | Stejný princip jako server-přidělovaný flag expanzí. Uznávaný směr, rok po publikaci bez reálné implementace |
| Least-privilege pro agenty | Okta, FINOS AIR framework | Scoped credentials per task | Stejná filozofie, ale na úrovni přihlašování, ne kontextu |
| Grafy v agentních systémech | Zep/Graphiti, GraphRAG | Graf k *sestavení* kontextu (retrieval podgrafu jako heuristika) | Portuni graf používá obráceně: k *ohraničení* kontextu (dosažitelnost po hranách jako pravidlo). Bez prior artu |

## Proč to nikdo neřeší

1. **Skoro nikdo nemá graf.** Vynucování kontextu podle topologie vztahů
   předpokládá kurátorovaný graf organizace. Typický podnik má data v silech
   bez strojově čitelných vztahů; aktivitní grafy (Glean) jsou moc šumové na
   autorizační hranici.
2. **Mainstream sází na lepší model.** Odpověď průmyslu na špatný kontext je
   lepší retrieval ranking a delší context window — statistika, ne
   determinismus.
3. **Selhání kvality jsou tichá.** Tiše špatný výstup kvůli špatně přičtenému
   kontextu se nedohledá na příčinu, svede se na model. Žádné incidenty,
   žádný tlak, žádná produktová kategorie. Prompt injection má dema a
   rozpočty; „agent si přečetl loňský ceník" nemá nic.
4. **Friction prohrává na trhu.** Elicitace a odmítnutí kazí demo; vendoři
   soutěží v „agent to prostě udělá". Náklad teď za neměřitelný přínos potom.
5. **„Co patří k úkolu" je sémantická otázka.** Bez lidmi udržované struktury
   není proti čemu vynucovat. RAG to obchází pravděpodobnostně; CaMeL
   ukazuje, že deterministická cesta je známá, a stejně ji nikdo neshipnul.

## Pozice Portuni

- Permissions-aware retrieval je vyřešený, schvalování akcí polovyřešené,
  **deterministický task-context je neobsazený prostor** — vstupní podmínka
  (kurátorovaný graf) je drahá a motivace (kvalita výstupu) neviditelná.
- Portuni tu podmínku splňuje mimochodem: POPP graf existuje jako zdroj
  pravdy o organizaci a scope enforcement je na něm téměř zadarmo.
- Motivace Portuni je kvalita (agent se nechytí špatného kontextu), zatímco
  celá literatura motivuje bezpečnostně. Bezpečnost z toho padá jako
  vedlejší efekt — argument funguje oběma směry.

## Zdroje

- CaMeL: arXiv 2503.18813; NeuralTrust „Ten Months After CaMeL, Where Are
  the Secure AI Agents?"
- Glean: docs.glean.com/security (document-level permission enforcement)
- MCP elicitation: modelcontextprotocol.io/specification (client/elicitation)
- Okta „How to implement least privilege for AI agents"; FINOS AIR
  mitigation MI-18
