# Graph Report - multitenant-platform  (2026-08-20)

## Corpus Check
- 215 files · ~114,663 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1254 nodes · 2118 edges · 126 communities (85 shown, 41 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ccd45a0d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- agentFetch
- cmsDb.ts
- deploy.ts
- domains.ts
- Backup testen — der Abnahmeplan
- index.ts
- Analytics Aggregation
- projects.ts
- README.md
- CMS Auth & App Layout
- Platform Overview Dashboard
- CMS Database Role Management
- CMS Row Editing UI
- CMS Rows & Media API
- Core Database Schema
- routes/secrets.ts
- provisioning-agent service
- analytics/page.tsx
- domains/page.tsx
- CMS Login & Session
- CmsAdminPage
- Deployments Management UI
- dependencies
- compilerOptions
- Tenant Table Editor UI
- compilerOptions
- Media Upload Storage
- SQL Query Editor UI
- Dashboard Layout & Toasts
- dependencies
- lib/cleanup.ts
- backupHealth.ts
- Docker Stats Monitoring
- devDependencies
- tenants.ts
- Provisioning Agent TS Config
- Versions- und CVE-Übersicht
- Projects List UI
- Redeploy Script
- cms/package.json
- devDependencies
- CMS Media & Row Forms
- 3. Die gefundenen Lücken
- ProjectContext.tsx
- @types/react
- CMS Media Page
- useToast
- Operations Runbook
- logAudit
- ConfirmDialog
- Dashboard Layout Nav
- backup-script.sh
- Backup einrichten — Schritt für Schritt
- scripts
- Smoke Test Script
- restore-script.sh
- minio
- CMS ESLint Config
- 5. Umsetzung im Agent
- Dashboard ESLint Config
- Audit Log UI
- Restore Test Script
- pg
- App Icon Route
- CMS Root Layout
- PgBouncer Auth Schema
- Tenant Tables List UI
- App Login Page
- Bootstrap Script
- Graphify Guard Script
- Graphify Session Hook
- CMS Next Config
- CMS Next Env Types
- CMS Pg-Format Types
- Postgres Memory Tuning
- 2. Was inventarisiert wird
- Backups Schema
- Audit Logs Schema
- Saved Queries Schema
- Revoke Public Connect Script
- Dashboard Next Config
- Dashboard Next Env Types
- Dashboard Pg-Format Types
- Git Askpass Script
- Pg-Format Type Declaration
- Migration Script
- Postgres OOM Protection
- Write Rate Limit Script
- Cloudflared Compose Config
- CMS Compose Config
- Postgres Compose Config
- Dashboard Compose Setup
- API Route Handlers
- Analytics Aggregation Tables
- Domains Table
- MinIO Storage Compose
- Uptime Monitoring Compose
- Provisioning Agent Compose
- Tenant Compose Template
- Traefik Proxy Compose
- 7. Phasen

## God Nodes (most connected - your core abstractions)
1. `agentFetch()` - 86 edges
2. `useToast()` - 19 edges
3. `logAudit()` - 18 edges
4. `logAudit()` - 17 edges
5. `compilerOptions` - 16 edges
6. `getTenantBySlug()` - 16 edges
7. `compilerOptions` - 16 edges
8. `requireSession()` - 15 edges
9. `provisioning-agent service` - 15 edges
10. `getPool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `Setup Guide` --references--> `cms_config role (Migration 22)`  [EXTRACTED]
  SETUP.md → docs/CMS-PLAN.md
- `Setup Guide` --references--> `Migration 19: optional database`  [EXTRACTED]
  SETUP.md → ARCHITECTURE.md
- `Contributing Guide` --references--> `Setup Guide`  [EXTRACTED]
  CONTRIBUTING.md → SETUP.md
- `Setup Guide` --references--> `Operations Runbook`  [EXTRACTED]
  SETUP.md → docs/OPERATIONS.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (126 total, 41 thin omitted)

### Community 0 - "agentFetch"
Cohesion: 0.05
Nodes (45): GET(), GET(), POST(), GET(), POST(), POST(), DELETE(), POST() (+37 more)

### Community 1 - "cmsDb.ts"
Cohesion: 0.06
Nodes (74): GET(), DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET() (+66 more)

### Community 2 - "deploy.ts"
Cohesion: 0.09
Nodes (36): detectBuildErrorHint(), truncateBuildLog(), decrypt(), encrypt(), getKey(), maskSecrets(), activeDeployments, ActiveDeployState (+28 more)

### Community 3 - "domains.ts"
Cohesion: 0.08
Nodes (39): buildInstructions(), cfFetch(), cfZoneId(), checkDns(), checkTls(), cloudflare, configuredProviders(), DnsCheckResult (+31 more)

### Community 4 - "Backup testen — der Abnahmeplan"
Cohesion: 0.15
Nodes (13): Backup testen — der Abnahmeplan, Bevor du anfängst, Rücksetz-Checkliste, Test 1 — Landet überhaupt etwas beim Anbieter?, Test 2 — Ist die Sicherung lesbar, nicht nur vorhanden?, Test 3 — Lässt sich das DR-Bundle entschlüsseln?, Test 4 — Hält die Speichergrenze, wenn nichts mehr passt?, Test 5 — Räumt es auf, statt über die Grenze zu gehen? (+5 more)

### Community 5 - "index.ts"
Cohesion: 0.11
Nodes (15): app, cleanupTenantResources(), execFileP, globalLimiter, reattachProjectNetworks(), sensitiveOpLimiter, webhookLimiter, AnyFn (+7 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "projects.ts"
Cohesion: 0.18
Nodes (16): deleteGithubWebhook(), githubHeaders(), parseGithubRepo(), webhookUrlFor(), createHttpMonitor(), deleteMonitor(), isConfigured(), withKumaSocket() (+8 more)

### Community 8 - "README.md"
Cohesion: 0.09
Nodes (25): age (Verschlüsselung), CLAUDE.md — Project Instructions, .claude/hooks/*.sh, Cloudflare (DNS-01, Zero Trust), Cloudflare Tunnel, CMS Session-Gültigkeitsprüfung, docker-socket-proxy, graphify CLI Tool (+17 more)

### Community 9 - "CMS Auth & App Layout"
Cohesion: 0.17
Nodes (17): clientIp(), POST(), AppLayout(), StartPage(), SidebarNav(), CmsUserRow, Collection, Field (+9 more)

### Community 10 - "Platform Overview Dashboard"
Cohesion: 0.13
Nodes (22): barColor(), DiskUsage, DOMAIN_STATUS_LABEL, formatBytes(), formatNumber(), MemoryConsumer, OrphanContainer, Overview (+14 more)

### Community 11 - "CMS Database Role Management"
Cohesion: 0.22
Nodes (20): assertRealTable(), cmsKey(), cmsRoleName(), describeTenantTable(), dropCmsRole(), encryptForCms(), ensureCmsRole(), execFileP (+12 more)

### Community 12 - "CMS Row Editing UI"
Cohesion: 0.20
Nodes (17): CollectionPage(), preview(), EditRowPage(), decryptCmsPassword(), coerce(), deleteRow(), getRow(), insertRow() (+9 more)

### Community 13 - "CMS Rows & Media API"
Cohesion: 0.23
Nodes (15): DELETE(), PATCH(), POST(), POST(), NewRowPage(), getCollectionWithFields(), insertMedia(), logCmsAudit() (+7 more)

### Community 14 - "Core Database Schema"
Cohesion: 0.15
Nodes (16): kunden, deployments, domains, github_connections, project_env_vars, projects, analytics_daily, analytics_ingest_state (+8 more)

### Community 15 - "routes/secrets.ts"
Cohesion: 0.28
Nodes (6): signTenantJwt(), TenantRoleKind, tenantRoleName(), execFileP, rotateLimiter, secretsRouter

### Community 16 - "provisioning-agent service"
Cohesion: 0.08
Nodes (34): Architecture Overview, cloudflared service, cms service, GitHub webhook deploy routing, P0-1: Docker socket proxy network isolation, PgBouncer AUTH_QUERY against pgbouncer_auth, Per-project Docker network as runtime-only state, Rate limiting keyed on Cf-Connecting-Ip (+26 more)

### Community 17 - "analytics/page.tsx"
Cohesion: 0.29
Nodes (8): AnalyticsData, AnalyticsPage(), formatDay(), formatNumber(), RANGES, RankedList(), SeriesPoint, ViewsChart()

### Community 18 - "domains/page.tsx"
Cohesion: 0.15
Nodes (9): AddDomainResult, Domain, DomainsPage(), Instruction, relTime(), STATUS_META, ConfirmDialogProps, CopyValue() (+1 more)

### Community 19 - "CMS Login & Session"
Cohesion: 0.21
Nodes (11): POST(), LoginPage(), LoginForm(), getSessionUser(), clearStaleCookie(), CmsSession, createSession(), destroySession() (+3 more)

### Community 21 - "Deployments Management UI"
Cohesion: 0.14
Nodes (8): ACTIVE_STATES, CANCELLABLE_STATES, Deployment, DeploymentsPage(), duration(), githubCommitUrl(), STATUS_COLOR, WebhookStatus

### Community 22 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, bcryptjs, jose, next, pg-format, react, react-dom, sanitize-html (+9 more)

### Community 23 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 24 - "Tenant Table Editor UI"
Cohesion: 0.21
Nodes (10): ColumnInfo, displayValue(), InputKind, inputKindFor(), Row, TableEditorPage(), saveEdit(), startEdit() (+2 more)

### Community 25 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 26 - "Media Upload Storage"
Cohesion: 0.21
Nodes (12): ALLOWED, bucketFor(), getClient(), MAX_FILE_BYTES, MAX_TENANT_BYTES, MAX_UPLOAD_BYTES, PORT, PUBLIC_BASE (+4 more)

### Community 27 - "SQL Query Editor UI"
Cohesion: 0.26
Nodes (10): historyKey(), loadHistory(), pushHistory(), QueryResult, SavedQuery, SqlEditorPage(), handleExportCsv(), handleKeyDown() (+2 more)

### Community 28 - "Dashboard Layout & Toasts"
Cohesion: 0.18
Nodes (9): metadata, Providers(), COLORS, ICONS, ToastApi, ToastContext, ToastItem, ToastKind (+1 more)

### Community 29 - "dependencies"
Cohesion: 0.06
Nodes (34): express-rate-limit, jsonwebtoken, dependencies, express, express-rate-limit, jsonwebtoken, pg, pg-format (+26 more)

### Community 30 - "lib/cleanup.ts"
Cohesion: 0.22
Nodes (14): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+6 more)

### Community 31 - "backupHealth.ts"
Cohesion: 0.12
Nodes (23): alert(), lastSent, adminClient(), BackupFreshness, checkBackupFreshness(), checkDisasterRecoveryReadiness(), DR_BUNDLE_MAX_AGE_DAYS, execFileP (+15 more)

### Community 32 - "Docker Stats Monitoring"
Cohesion: 0.21
Nodes (8): directorySize(), DockerStatsLine, execFileP, parseMemUsage(), parseSize(), readBucketSizes(), readDockerStats(), statsRouter

### Community 33 - "devDependencies"
Cohesion: 0.05
Nodes (41): dependencies, bcryptjs, next, next-auth, pg, pg-format, react, react-dom (+33 more)

### Community 34 - "tenants.ts"
Cohesion: 0.38
Nodes (10): execFileP, provisionTenantDatabase(), startTenantServices(), stopTenantServices(), tenantComposeExists(), tenantComposeFile(), tenantDir(), waitForGotrue() (+2 more)

### Community 35 - "Provisioning Agent TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, skipLibCheck, strict (+3 more)

### Community 36 - "Versions- und CVE-Übersicht"
Cohesion: 0.33
Nodes (6): 1. Ziel, 3. Werkzeug, 4. Datenmodell, 6. Dashboard, 8. Ergänzend, außerhalb dieses Plans, Versions- und CVE-Übersicht

### Community 37 - "Projects List UI"
Cohesion: 0.27
Nodes (9): Project, ProjectsPage(), handleCreate(), handleDelete(), handleStatusChange(), load(), Tenant, EmptyState() (+1 more)

### Community 38 - "Redeploy Script"
Cohesion: 0.47
Nodes (10): add_env(), compose(), die(), info(), ok(), psql_admin(), say(), redeploy.sh script (+2 more)

### Community 39 - "cms/package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 40 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, eslint, eslint-config-next, @types/bcryptjs, @types/node, @types/pg, @types/react-dom, @types/sanitize-html (+9 more)

### Community 41 - "CMS Media & Row Forms"
Cohesion: 0.24
Nodes (4): MediaPicker(), FormField, RowForm(), toInputValue()

### Community 42 - "3. Die gefundenen Lücken"
Cohesion: 0.07
Nodes (28): 1. Kurzfassung, 2.1 Was schon lief, 2.2 Kennzahlen davor, 2. Ausgangszustand (vor dieser Arbeit), 3. Die gefundenen Lücken, 4. Zielbild, 5. Was umgesetzt wurde, 5a. Prüfstand (+20 more)

### Community 43 - "ProjectContext.tsx"
Cohesion: 0.08
Nodes (12): ApiKeys, EnvVar, EnvVarsPage(), TABS, GithubRepo, ProjectOverviewPage(), Tenant, Project (+4 more)

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "useToast"
Cohesion: 0.21
Nodes (9): Backup, BackupsPage(), formatBytes(), isTestRow(), RemoteFile, RestoreResultEntry, STATUS_COLOR, STATUS_LABEL (+1 more)

### Community 47 - "Operations Runbook"
Cohesion: 0.33
Nodes (3): project_env_vars table, projects table, Operations Runbook

### Community 48 - "logAudit"
Cohesion: 0.43
Nodes (5): ActorInfo, actorStorage, currentActor(), logAudit(), redact()

### Community 49 - "ConfirmDialog"
Cohesion: 0.22
Nodes (6): CmsUser, Collection, Field, FIELD_TYPES, TableCandidate, ConfirmDialog()

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "backup-script.sh"
Cohesion: 0.44
Nodes (12): delete_oldest_run(), fail(), flush_uploads(), keep_staged_locally(), log(), preflight_budget(), prune_generation(), record_backup() (+4 more)

### Community 52 - "Backup einrichten — Schritt für Schritt"
Cohesion: 0.17
Nodes (12): Ab jetzt läuft es allein, Backup einrichten — Schritt für Schritt, Bleibt das im Gratiskontingent?, Schritt 1 — Speicherplatz beim Anbieter anlegen (im Browser), Schritt 2 — Code und Werkzeuge auf den Server holen, Schritt 3 — Server mit dem Speicher verbinden, Schritt 4 — Verschlüsselungsschlüssel erzeugen, Schritt 5 — Konfiguration eintragen (+4 more)

### Community 53 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, lint, start

### Community 54 - "Smoke Test Script"
Cohesion: 0.57
Nodes (6): agent(), cleanup(), fail(), log(), smoke-test.sh script, step()

### Community 55 - "restore-script.sh"
Cohesion: 0.57
Nodes (5): confirm(), die(), fetch(), log(), restore-script.sh script

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 58 - "5. Umsetzung im Agent"
Cohesion: 0.33
Nodes (6): 5. Umsetzung im Agent, Alarme, `provisioning-agent/src/lib/inventory.ts` (neu), `provisioning-agent/src/lib/securityScan.ts` (neu), `provisioning-agent/src/routes/security.ts` (neu), Zeitplan

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

### Community 79 - "2. Was inventarisiert wird"
Cohesion: 0.40
Nodes (5): 2. Was inventarisiert wird, Ebene A — Plattform-Infrastruktur (Betreiber kann sofort handeln), Ebene B — Tenant-Dienste (Betreiber kann handeln, betrifft alle Tenants), Ebene C — Gehostete Kundenprojekte (Kunde muss handeln, Betreiber informiert), Zwei Wahrheiten, absichtlich beide

### Community 125 - "7. Phasen"
Cohesion: 0.40
Nodes (5): 7. Phasen, Phase 1 — Inventar ohne Scanner (ca. 1 Tag), Phase 2 — Scan und Zähler (ca. 1,5 Tage), Phase 3 — Täglich und laut (ca. ½ Tag), Phase 4 — Ausnahmen und Verlauf (ca. ½ Tag)

## Knowledge Gaps
- **399 isolated node(s):** `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script`, `__filename`, `__dirname` (+394 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Operations Runbook` connect `Operations Runbook` to `provisioning-agent service`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `minio`, `pg`, `cms/package.json`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `minio` connect `minio` to `README.md`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script` to the rest of the system?**
  _399 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `agentFetch` be split into smaller, more focused modules?**
  _Cohesion score 0.05362517099863201 - nodes in this community are weakly interconnected._
- **Should `cmsDb.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05714285714285714 - nodes in this community are weakly interconnected._
- **Should `deploy.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08687943262411348 - nodes in this community are weakly interconnected._