# Graph Report - multitenant-platform  (2026-08-21)

## Corpus Check
- 215 files · ~105,010 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1196 nodes · 2039 edges · 126 communities (86 shown, 40 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `68349817`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- agentFetch
- Tenant Query API Routes
- deploy.ts
- domains.ts
- CMS Collections & Users API
- index.ts
- Analytics Aggregation
- inventory.ts
- README.md
- CMS Auth & App Layout
- Platform Overview Dashboard
- CMS Database Role Management
- CMS Row Editing UI
- CMS Rows & Media API
- projects
- logAudit
- provisioning-agent service
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
- lib/cleanup.ts
- Tenant Database Provisioning
- stats.ts
- devDependencies
- env/page.tsx
- Provisioning Agent TS Config
- Versions- und CVE-Übersicht
- Projects List UI
- Redeploy Script
- cms/package.json
- devDependencies
- CMS Media & Row Forms
- git.ts
- Project Overview Page
- @types/react
- CMS Media Page
- useToast
- Setup Guide
- CMS Schema Tables
- crypto.ts
- Dashboard Layout Nav
- Backup Script
- routes/secrets.ts
- ProjectContext.tsx
- Smoke Test Script
- Restore Script
- 5. Umsetzung im Agent
- CMS ESLint Config
- scripts
- Dashboard ESLint Config
- Audit Log UI
- Restore Test Script
- 7. Phasen
- nixpacks.ts
- minio
- App Icon Route
- pg
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
1. `agentFetch()` - 88 edges
2. `useToast()` - 21 edges
3. `logAudit()` - 17 edges
4. `compilerOptions` - 16 edges
5. `getTenantBySlug()` - 16 edges
6. `compilerOptions` - 16 edges
7. `logAudit()` - 16 edges
8. `requireSession()` - 15 edges
9. `provisioning-agent service` - 15 edges
10. `getPool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `cms service`  [INFERRED]
  .github/workflows/ci.yml → cms/docker-compose.yml
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `CI Workflow` --references--> `dashboard service`  [INFERRED]
  .github/workflows/ci.yml → dashboard/docker-compose.yml
- `CI Workflow` --references--> `provisioning-agent service`  [INFERRED]
  .github/workflows/ci.yml → provisioning-agent/docker-compose.yml
- `cms service` --references--> `minio service`  [EXTRACTED]
  cms/docker-compose.yml → minio/docker-compose.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (126 total, 40 thin omitted)

### Community 0 - "agentFetch"
Cohesion: 0.05
Nodes (48): GET(), POST(), GET(), POST(), POST(), DELETE(), POST(), POST() (+40 more)

### Community 1 - "Tenant Query API Routes"
Cohesion: 0.10
Nodes (41): GET(), POST(), requestMeta(), DELETE(), GET(), POST(), GET(), DELETE() (+33 more)

### Community 2 - "deploy.ts"
Cohesion: 0.14
Nodes (18): reattachProjectNetworks(), detectBuildErrorHint(), truncateBuildLog(), activeDeployments, ActiveDeployState, adminClient(), cancelDeployment(), deployLocks (+10 more)

### Community 3 - "domains.ts"
Cohesion: 0.06
Nodes (54): buildInstructions(), cfFetch(), cfZoneId(), checkDns(), checkTls(), cloudflare, configuredProviders(), DnsCheckResult (+46 more)

### Community 4 - "CMS Collections & Users API"
Cohesion: 0.13
Nodes (31): DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET(), POST() (+23 more)

### Community 5 - "index.ts"
Cohesion: 0.11
Nodes (16): app, cleanupTenantResources(), execFileP, globalLimiter, sensitiveOpLimiter, webhookLimiter, alert(), lastSent (+8 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "inventory.ts"
Cohesion: 0.19
Nodes (14): adminClient(), classifyContainer(), collectInventory(), collectPinnedVersions(), collectRunningContainers(), Component, COMPOSE_SOURCES, execFileP (+6 more)

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

### Community 14 - "projects"
Cohesion: 0.12
Nodes (20): kunden, deployments, domains, github_connections, project_env_vars, projects, analytics_daily, analytics_ingest_state (+12 more)

### Community 15 - "logAudit"
Cohesion: 0.25
Nodes (7): ActorInfo, actorStorage, currentActor(), logAudit(), redact(), backupsRouter, execFileP

### Community 16 - "provisioning-agent service"
Cohesion: 0.12
Nodes (21): cloudflared service, GitHub webhook deploy routing, P0-1: Docker socket proxy network isolation, PgBouncer AUTH_QUERY against pgbouncer_auth, Per-project Docker network as runtime-only state, Rate limiting keyed on Cf-Connecting-Ip, pgbouncer service, dashboard service (+13 more)

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
Cohesion: 0.24
Nodes (13): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+5 more)

### Community 31 - "Tenant Database Provisioning"
Cohesion: 0.38
Nodes (10): execFileP, provisionTenantDatabase(), startTenantServices(), stopTenantServices(), tenantComposeExists(), tenantComposeFile(), tenantDir(), waitForGotrue() (+2 more)

### Community 32 - "stats.ts"
Cohesion: 0.19
Nodes (9): BUILDS_ROOT, directorySize(), DockerStatsLine, execFileP, parseMemUsage(), parseSize(), readBucketSizes(), readDockerStats() (+1 more)

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
Cohesion: 0.18
Nodes (11): 1. Ziel, 2. Was inventarisiert wird, 3. Werkzeug, 4. Datenmodell, 6. Dashboard, 8. Ergänzend, außerhalb dieses Plans, Ebene A — Plattform-Infrastruktur (Betreiber kann sofort handeln), Ebene B — Tenant-Dienste (Betreiber kann handeln, betrifft alle Tenants) (+3 more)

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

### Community 42 - "git.ts"
Cohesion: 0.29
Nodes (8): Project, checkoutRepo(), execFileP, gitEnv(), normalizeRepoUrl(), remoteMatches(), verifyGithubSignature(), webhooksRouter

### Community 43 - "Project Overview Page"
Cohesion: 0.20
Nodes (3): GithubRepo, ProjectOverviewPage(), Tenant

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "useToast"
Cohesion: 0.16
Nodes (10): Backup, BackupsPage(), formatBytes(), RestoreResultEntry, STATUS_COLOR, Component, SCOPE_HINT, SCOPE_LABEL (+2 more)

### Community 47 - "Setup Guide"
Cohesion: 0.22
Nodes (8): Architecture Overview, Contributing Guide, cms_config role (Migration 22), Migration 19: optional database, project_env_vars table, projects table, Operations Runbook, Setup Guide

### Community 48 - "CMS Schema Tables"
Cohesion: 0.43
Nodes (8): cms service, cms_audit table, cms_collections table, cms_fields table, cms_media table, cms_users table, Migration 21: CMS schema, CMS Implementation Plan

### Community 49 - "crypto.ts"
Cohesion: 0.40
Nodes (8): decrypt(), encrypt(), getKey(), adminClient(), buildEnvVars(), getProjectEnvVars(), getTenantSecrets(), TenantSecrets

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "Backup Script"
Cohesion: 0.81
Nodes (6): encrypt_and_upload(), fail(), log(), record_backup(), send_alert(), backup-script.sh script

### Community 52 - "routes/secrets.ts"
Cohesion: 0.28
Nodes (6): signTenantJwt(), TenantRoleKind, tenantRoleName(), execFileP, rotateLimiter, secretsRouter

### Community 53 - "ProjectContext.tsx"
Cohesion: 0.29
Nodes (5): TABS, Project, ProjectContext, ProjectContextValue, ProjectProvider()

### Community 54 - "Smoke Test Script"
Cohesion: 0.57
Nodes (6): agent(), cleanup(), fail(), log(), smoke-test.sh script, step()

### Community 55 - "Restore Script"
Cohesion: 0.73
Nodes (5): confirm(), die(), fetch(), log(), restore-script.sh script

### Community 56 - "5. Umsetzung im Agent"
Cohesion: 0.33
Nodes (6): 5. Umsetzung im Agent, Alarme, `provisioning-agent/src/lib/inventory.ts` (neu), `provisioning-agent/src/lib/securityScan.ts` (neu), `provisioning-agent/src/routes/security.ts` (neu), Zeitplan

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 58 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, lint, start

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

### Community 62 - "7. Phasen"
Cohesion: 0.40
Nodes (5): 7. Phasen, Phase 1 — Inventar ohne Scanner (ca. 1 Tag), Phase 2 — Scan und Zähler (ca. 1,5 Tage), Phase 3 — Täglich und laut (ca. ½ Tag), Phase 4 — Ausnahmen und Verlauf (ca. ½ Tag)

### Community 63 - "nixpacks.ts"
Cohesion: 0.80
Nodes (4): maskSecrets(), capBuildkitMemory(), execFileP, nixpacksBuild()

## Knowledge Gaps
- **351 isolated node(s):** `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script`, `__filename`, `__dirname` (+346 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **40 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useToast()` connect `useToast` to `env/page.tsx`, `Projects List UI`, `Project Overview Page`, `domains/page.tsx`, `CMS Admin Page`, `Deployments Management UI`, `Tenant Table Editor UI`, `SQL Query Editor UI`, `Dashboard Layout & Toasts`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `minio`, `pg`, `cms/package.json`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Why does `agentFetch()` connect `agentFetch` to `Tenant Query API Routes`, `CMS Collections & Users API`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script` to the rest of the system?**
  _351 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `agentFetch` be split into smaller, more focused modules?**
  _Cohesion score 0.05093632958801498 - nodes in this community are weakly interconnected._
- **Should `Tenant Query API Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.1003921568627451 - nodes in this community are weakly interconnected._
- **Should `deploy.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14130434782608695 - nodes in this community are weakly interconnected._