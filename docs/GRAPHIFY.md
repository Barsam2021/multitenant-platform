# Wissensgraph (graphify)

`graphify` liest dieses Repository — Code, SQL-Schemata, Konfiguration und die
Dokumentation — deterministisch per AST aus und schreibt daraus einen
Wissensgraphen nach `graphify-out/`. Wer eine Frage an das Projekt hat („was
haengt an `agentFetch()`", „wo wird ein Tenant angelegt"), bekommt einen
zugeschnittenen Teilgraphen statt einer Volltextsuche über 200 Dateien.

Der Nutzen liegt vor allem bei KI-Assistenten (Claude Code & Co.): sie
durchsuchen sonst Datei für Datei und verlieren dabei genau die Beziehungen,
die dieses Projekt ausmachen — welcher Dashboard-Endpunkt welchen Agent-Endpunkt
ruft, welche Tabelle an welchem Provisioning-Schritt haengt.

## Was im Repo liegt

| Pfad | Inhalt |
|---|---|
| `graphify-out/graph.json` | der Graph selbst: 1121 Knoten, 1960 Kanten, 124 Communities |
| `graphify-out/GRAPH_REPORT.md` | Uebersicht: Community-Hubs, God-Nodes, Einstiegsfragen |
| `graphify-out/.graphify_labels.json` | die per LLM vergebenen Community-Namen — mit im Repo, damit ein frischer Clone nicht neu benannt werden muss |
| `graphify-out/cache/semantic/` | inhaltsbasierter Cache der Dokumentations-Extraktion, erspart denselben LLM-Lauf |
| `.claude/settings.json` | SessionStart-Hook (installiert graphify nach) + PreToolUse-Hooks (erinnern den Assistenten an den Graphen) |
| `.claude/hooks/*.sh` | die Hook-Skripte; ohne installiertes graphify beenden sie sich still mit 0 |
| `CLAUDE.md` | der von `graphify claude install` verwaltete Abschnitt |

Nicht im Repo: `graph.html` (Visualisierung, ~1 MB, in Sekunden neu erzeugt),
`manifest.json` und `cache/ast/` (haengen an lokalen mtimes), `.graphify_root`
(absoluter Pfad) sowie die datierten Backup-Ordner. Siehe `.gitignore`.

## Einrichtung auf einem neuen Rechner

```bash
uv tool install "graphifyy[sql]"   # oder: pipx install "graphifyy[sql]"
graphify install                   # /graphify-Skill fuer Claude Code registrieren
```

Das `[sql]`-Extra ist hier nicht optional: ohne `tree_sitter_sql` fallen die 27
SQL-Dateien aus `core-postgres/` aus dem Graphen — also genau das Kernschema.

In Claude-Code-Web-Sessions passiert der erste Schritt automatisch, dafuer ist
der SessionStart-Hook da.

Damit `graph.json` bei parallelen Commits nicht kollidiert, registriert jeder
Clone einmalig den Union-Merge-Driver (`.gitattributes` verweist bereits
darauf):

```bash
graphify hook install    # Merge-Driver + Post-Commit-Rebuild
graphify hook status
```

## Taeglicher Gebrauch

```bash
graphify query "wie kommt ein Push zu einem laufenden Container?"
graphify path "deploy.ts" "traefikDynamic.ts"    # kuerzester Weg zwischen zwei Knoten
graphify explain "runDeployment()"               # Knoten + Nachbarschaft
graphify affected "agentFetch"                   # was bricht, wenn sich das aendert
graphify god-nodes --top 10                      # die am staerksten verdrahteten Stellen
```

Nach Code-Aenderungen:

```bash
graphify update .        # nur AST, kein LLM, wenige Sekunden
```

Nach groesseren Aenderungen an der Dokumentation lohnt der semantische Lauf.
Ohne `ANTHROPIC_API_KEY` laeuft er ueber die angemeldete Claude-CLI:

```bash
graphify extract . --backend claude-cli --no-viz
graphify label . --backend claude-cli    # Community-Namen auffrischen
```

`GRAPH_REPORT.md` nennt im Abschnitt „Graph Freshness" den Commit, aus dem der
Graph gebaut wurde — Abweichung zu `git rev-parse HEAD` heisst: veraltet.
