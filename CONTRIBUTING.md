# Contributing

Dieses Repository ist ein **Portfolio-/Showcase-Projekt** (siehe
[README.md](./README.md) und [LICENSE](./LICENSE)). Es gibt aktuell **keinen
offenen Contribution-Prozess** — Pull Requests von Dritten werden nicht aktiv
geprüft oder gemerged, da der Code „All Rights Reserved" ist und keine
Weiterverbreitung/Bearbeitung durch Dritte lizenziert ist.

Trotzdem, falls du als Entwickler den Code liest, forkst (zum reinen Ansehen)
oder Fehler findest:

## Fehler melden

Ein GitHub Issue mit kurzer Beschreibung reicht — es besteht keine Zusage auf
Bearbeitung, aber Hinweise (insbesondere sicherheitsrelevante) sind willkommen.
Für sicherheitsrelevante Findings siehe den Abschnitt „Security" unten.

## Code-Style (zur Referenz)

- **TypeScript strict**, keine `any`-Typen ohne guten Grund
- **Next.js App Router**-Konventionen (Server Components wo möglich,
  `route.ts`-Handler für API-Routen)
- SQL-Identifier (Tabellen-/Spaltennamen) **immer** über `pg-format` (`%I`)
  einsetzen, nie String-Konkatenation — siehe `dashboard/src/lib/tenantDb.ts`
  und `provisioning-agent/src/lib/*` als Referenz
- Secrets/Env-Vars: nie hartkodieren, immer über `process.env`, sinnvolle
  Fallback-Defaults nur für nicht-sensible Werte (siehe Findings zu
  hartkodierten Domain-Fallbacks — das ist ein bekanntes Gegenbeispiel, kein
  Vorbild)
- Commit-Messages: `feat(bereich): kurzbeschreibung` / `fix(bereich): ...` /
  `docs: ...` / `chore: ...`

## Security

Wenn du eine Sicherheitslücke findest, bitte **kein öffentliches Issue**
öffnen, sondern den Repo-Owner direkt kontaktieren (Kontaktinfo siehe
GitHub-Profil). Bekannte, bereits dokumentierte offene Punkte stehen in
[SETUP.md](./SETUP.md) unter „Bekannte offene Punkte" und im README unter
„Sicherheitsdesign" — diese müssen nicht separat gemeldet werden.
