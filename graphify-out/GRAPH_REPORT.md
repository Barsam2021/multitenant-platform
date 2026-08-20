# Graph Report - multitenant-platform  (2026-08-20)

## Corpus Check
- 210 files · ~103,948 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1187 nodes · 2006 edges · 124 communities (83 shown, 41 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `68349817`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- agentFetch
- adminDb.ts
- deploy.ts
- DNS & Cloudflare Integration
- cmsDb.ts
- index.ts
- Analytics Aggregation
- GitHub & Monitoring Integration
- README.md
- CMS Auth & App Layout
- Platform Overview Dashboard
- CMS Database Role Management
- CMS Row Editing UI
- CMS Rows & Media API
- Core Database Schema
- Audit Logging & Actor Context
- Infrastructure Services Architecture
- analytics/page.tsx
- domains/page.tsx
- CMS Login & Session
- CMS Admin Page
- Deployments Management UI
- dependencies
- compilerOptions
- Tenant Table Editor UI
- compilerOptions
- Media Upload Storage
- SQL Query Editor UI
- Dashboard Layout & Toasts
- dependencies
- Cleanup & Retention Jobs
- Tenant Database Provisioning
- Docker Stats Monitoring
- devDependencies
- env/page.tsx
- Provisioning Agent TS Config
- Versions- und CVE-Übersicht
- Projects List UI
- Redeploy Script
- cms/package.json
- devDependencies
- CMS Media & Row Forms
- 3. Lücken
- Project Overview Page
- @types/react
- CMS Media Page
- Backups Management UI
- Operations Runbook
- CMS Schema Tables
- ProjectContext.tsx
- Dashboard Layout Nav
- Backup Script
- Backup- und Restore-Plan
- scripts
- Smoke Test Script
- Restore Script
- 5. Maßnahmen in Reihenfolge
- CMS ESLint Config
- next
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
- Traefik Rate Limiting
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

## God Nodes (most connected - your core abstractions)
1. `agentFetch()` - 84 edges
2. `useToast()` - 19 edges
3. `logAudit()` - 17 edges
4. `compilerOptions` - 16 edges
5. `getTenantBySlug()` - 16 edges
6. `compilerOptions` - 16 edges
7. `requireSession()` - 15 edges
8. `logAudit()` - 15 edges
9. `provisioning-agent service` - 15 edges
10. `getPool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `cms service`  [INFERRED]
  .github/workflows/ci.yml → cms/docker-compose.yml
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `traefik service` --conceptually_related_to--> `Per-project Docker network as runtime-only state`  [INFERRED]
  traefik/docker-compose.yml → ARCHITECTURE.md
- `CI Workflow` --references--> `dashboard service`  [INFERRED]
  .github/workflows/ci.yml → dashboard/docker-compose.yml
- `CI Workflow` --references--> `provisioning-agent service`  [INFERRED]
  .github/workflows/ci.yml → provisioning-agent/docker-compose.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (124 total, 41 thin omitted)

### Community 0 - "agentFetch"
Cohesion: 0.05
Nodes (46): GET(), POST(), GET(), POST(), POST(), DELETE(), POST(), POST() (+38 more)

### Community 1 - "adminDb.ts"
Cohesion: 0.10
Nodes (38): GET(), POST(), requestMeta(), DELETE(), GET(), POST(), GET(), DELETE() (+30 more)

### Community 2 - "deploy.ts"
Cohesion: 0.08
Nodes (37): reattachProjectNetworks(), detectBuildErrorHint(), truncateBuildLog(), decrypt(), encrypt(), getKey(), maskSecrets(), activeDeployments (+29 more)

### Community 3 - "DNS & Cloudflare Integration"
Cohesion: 0.08
Nodes (39): buildInstructions(), cfFetch(), cfZoneId(), checkDns(), checkTls(), cloudflare, configuredProviders(), DnsCheckResult (+31 more)

### Community 4 - "cmsDb.ts"
Cohesion: 0.12
Nodes (34): DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET(), POST() (+26 more)

### Community 5 - "index.ts"
Cohesion: 0.10
Nodes (17): app, cleanupTenantResources(), execFileP, globalLimiter, sensitiveOpLimiter, webhookLimiter, alert(), lastSent (+9 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "GitHub & Monitoring Integration"
Cohesion: 0.17
Nodes (17): BUILDS_ROOT, deleteGithubWebhook(), githubHeaders(), parseGithubRepo(), webhookUrlFor(), createHttpMonitor(), deleteMonitor(), isConfigured() (+9 more)

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

### Community 15 - "Audit Logging & Actor Context"
Cohesion: 0.14
Nodes (13): ActorInfo, actorStorage, currentActor(), logAudit(), redact(), signTenantJwt(), TenantRoleKind, tenantRoleName() (+5 more)

### Community 16 - "Infrastructure Services Architecture"
Cohesion: 0.13
Nodes (19): cloudflared service, GitHub webhook deploy routing, P0-1: Docker socket proxy network isolation, PgBouncer AUTH_QUERY against pgbouncer_auth, Per-project Docker network as runtime-only state, pgbouncer service, dashboard service, kunden table (+11 more)

### Community 17 - "analytics/page.tsx"
Cohesion: 0.27
Nodes (9): AnalyticsData, AnalyticsPage(), formatDay(), formatNumber(), RANGES, RankedList(), SeriesPoint, ViewsChart() (+1 more)

### Community 18 - "domains/page.tsx"
Cohesion: 0.13
Nodes (10): AddDomainResult, Domain, DomainsPage(), Instruction, relTime(), STATUS_META, ConfirmDialog(), ConfirmDialogProps (+2 more)

### Community 19 - "CMS Login & Session"
Cohesion: 0.21
Nodes (11): POST(), LoginPage(), LoginForm(), getSessionUser(), clearStaleCookie(), CmsSession, createSession(), destroySession() (+3 more)

### Community 20 - "CMS Admin Page"
Cohesion: 0.12
Nodes (6): CmsAdminPage(), CmsUser, Collection, Field, FIELD_TYPES, TableCandidate

### Community 21 - "Deployments Management UI"
Cohesion: 0.14
Nodes (8): ACTIVE_STATES, CANCELLABLE_STATES, Deployment, DeploymentsPage(), duration(), githubCommitUrl(), STATUS_COLOR, WebhookStatus

### Community 22 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, bcryptjs, jose, minio, pg-format, react, react-dom, sanitize-html (+9 more)

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

### Community 30 - "Cleanup & Retention Jobs"
Cohesion: 0.28
Nodes (12): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+4 more)

### Community 31 - "Tenant Database Provisioning"
Cohesion: 0.38
Nodes (10): execFileP, provisionTenantDatabase(), startTenantServices(), stopTenantServices(), tenantComposeExists(), tenantComposeFile(), tenantDir(), waitForGotrue() (+2 more)

### Community 32 - "Docker Stats Monitoring"
Cohesion: 0.21
Nodes (8): directorySize(), DockerStatsLine, execFileP, parseMemUsage(), parseSize(), readBucketSizes(), readDockerStats(), statsRouter

### Community 33 - "devDependencies"
Cohesion: 0.05
Nodes (41): dependencies, bcryptjs, next, next-auth, pg, pg-format, react, react-dom (+33 more)

### Community 34 - "env/page.tsx"
Cohesion: 0.22
Nodes (3): ApiKeys, EnvVar, EnvVarsPage()

### Community 35 - "Provisioning Agent TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, skipLibCheck, strict (+3 more)

### Community 36 - "Versions- und CVE-Übersicht"
Cohesion: 0.09
Nodes (22): 1. Ziel, 2. Was inventarisiert wird, 3. Werkzeug, 4. Datenmodell, 5. Umsetzung im Agent, 6. Dashboard, 7. Phasen, 8. Ergänzend, außerhalb dieses Plans (+14 more)

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

### Community 42 - "3. Lücken"
Cohesion: 0.22
Nodes (9): 3. Lücken, B-1 — Der Schlüssel liegt im brennenden Haus  (Schwere: kritisch), B-2 — Restore-Test aus dem Dashboard lehnt alle DB-Dumps ab  (Schwere: hoch), B-3 — `encrypt_failed` verletzt den CHECK-Constraint  (Schwere: mittel), B-4 — Kein Alarm, wenn das Backup gar nicht erst läuft  (Schwere: hoch), B-5 — Restore ist nur ein Kommandozeilen-Vorgang  (Schwere: mittel), B-6 — Kein automatischer Restore-Test  (Schwere: mittel), B-7 — Aufbewahrung ohne Generationen  (Schwere: mittel) (+1 more)

### Community 43 - "Project Overview Page"
Cohesion: 0.20
Nodes (3): GithubRepo, ProjectOverviewPage(), Tenant

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "Backups Management UI"
Cohesion: 0.28
Nodes (6): Backup, BackupsPage(), formatBytes(), RestoreResultEntry, STATUS_COLOR, useToast()

### Community 47 - "Operations Runbook"
Cohesion: 0.22
Nodes (8): Architecture Overview, Contributing Guide, cms_config role (Migration 22), Migration 19: optional database, project_env_vars table, projects table, Operations Runbook, Setup Guide

### Community 48 - "CMS Schema Tables"
Cohesion: 0.43
Nodes (8): cms service, cms_audit table, cms_collections table, cms_fields table, cms_media table, cms_users table, Migration 21: CMS schema, CMS Implementation Plan

### Community 49 - "ProjectContext.tsx"
Cohesion: 0.29
Nodes (5): TABS, Project, ProjectContext, ProjectContextValue, ProjectProvider()

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "Backup Script"
Cohesion: 0.81
Nodes (6): encrypt_and_upload(), fail(), log(), record_backup(), send_alert(), backup-script.sh script

### Community 52 - "Backup- und Restore-Plan"
Cohesion: 0.25
Nodes (8): 1. Kurzfassung, 2.1 Was läuft, 2.2 Kennzahlen heute, 2. Ist-Zustand, 4. Zielbild, 6. Betrieb: der Ernstfall in sechs Schritten, 7. Bewusst nicht im Plan, Backup- und Restore-Plan

### Community 53 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, lint, start

### Community 54 - "Smoke Test Script"
Cohesion: 0.57
Nodes (6): agent(), cleanup(), fail(), log(), smoke-test.sh script, step()

### Community 55 - "Restore Script"
Cohesion: 0.73
Nodes (5): confirm(), die(), fetch(), log(), restore-script.sh script

### Community 56 - "5. Maßnahmen in Reihenfolge"
Cohesion: 0.40
Nodes (5): 5. Maßnahmen in Reihenfolge, Phase 1 — Die zwei echten Fehler (ca. ½ Tag), Phase 2 — Nicht mehr blind sein (ca. 1 Tag), Phase 3 — Der Test, der von allein läuft (ca. 1 Tag), Phase 4 — Generationen (ca. ½ Tag)

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

## Knowledge Gaps
- **361 isolated node(s):** `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script`, `__filename`, `__dirname` (+356 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useToast()` connect `Backups Management UI` to `env/page.tsx`, `Projects List UI`, `Project Overview Page`, `domains/page.tsx`, `CMS Admin Page`, `Deployments Management UI`, `Tenant Table Editor UI`, `SQL Query Editor UI`, `Dashboard Layout & Toasts`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `next`, `pg`, `cms/package.json`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script` to the rest of the system?**
  _361 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `agentFetch` be split into smaller, more focused modules?**
  _Cohesion score 0.05292702485966319 - nodes in this community are weakly interconnected._
- **Should `adminDb.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10453283996299723 - nodes in this community are weakly interconnected._
- **Should `deploy.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08418367346938775 - nodes in this community are weakly interconnected._
- **Should `DNS & Cloudflare Integration` be split into smaller, more focused modules?**
  _Cohesion score 0.08181818181818182 - nodes in this community are weakly interconnected._