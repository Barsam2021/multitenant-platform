# Graph Report - multitenant-platform  (2026-08-20)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1121 nodes · 1960 edges · 124 communities (86 shown, 38 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.63)
- Token cost: 140,273 input · 5,863 output

## Graph Freshness
- Built from commit: `c68a7240`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Admin Backup & Audit Routes
- Tenant Query API Routes
- Deployment Secrets & Crypto
- DNS & Cloudflare Integration
- CMS Collections & Users API
- Provisioning Agent Core
- Analytics Aggregation
- GitHub & Monitoring Integration
- Platform Tech Stack
- CMS Auth & App Layout
- Platform Overview Dashboard
- CMS Database Role Management
- CMS Row Editing UI
- CMS Rows & Media API
- Core Database Schema
- Audit Logging & Actor Context
- Infrastructure Services Architecture
- Analytics Dashboard UI
- Domain Management UI
- CMS Login & Session
- CMS Admin Page
- Deployments Management UI
- Dashboard Dependencies
- TypeScript Compiler Config
- Tenant Table Editor UI
- TypeScript Compiler Config
- Media Upload Storage
- SQL Query Editor UI
- Dashboard Layout & Toasts
- Provisioning Agent Dependencies
- Cleanup & Retention Jobs
- Tenant Database Provisioning
- Docker Stats Monitoring
- Auth Dependencies
- Environment Variables UI
- Provisioning Agent TS Config
- TypeScript Type Dependencies
- Projects List UI
- Redeploy Script
- CMS Package Config
- ESLint Dependencies
- CMS Media & Row Forms
- Dashboard Package Config
- Project Overview Page
- Dev Type Dependencies
- CMS Media Page
- Backups Management UI
- Project Documentation Guides
- CMS Schema Tables
- Next.js Type Includes
- Dashboard Layout Nav
- Backup Script
- TypeScript Lib Config
- Provisioning Agent Package Config
- Smoke Test Script
- Restore Script
- Graphify Project Docs
- CMS ESLint Config
- TS Config Excludes
- Dashboard ESLint Config
- Audit Log UI
- Restore Test Script
- Pg-Format Package
- Node Type Definitions
- Pg Type Definitions
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
4. `getTenantBySlug()` - 16 edges
5. `compilerOptions` - 16 edges
6. `compilerOptions` - 16 edges
7. `logAudit()` - 15 edges
8. `requireSession()` - 15 edges
9. `provisioning-agent service` - 15 edges
10. `getPool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `cms service`  [INFERRED]
  .github/workflows/ci.yml → cms/docker-compose.yml
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `traefik service` --conceptually_related_to--> `Per-project Docker network as runtime-only state`  [INFERRED]
  traefik/docker-compose.yml → ARCHITECTURE.md
- `include` --extends--> `next-env.d.ts`  [EXTRACTED]
  dashboard/tsconfig.json → cms/tsconfig.json
- `include` --extends--> `.next/types/**/*.ts`  [EXTRACTED]
  dashboard/tsconfig.json → cms/tsconfig.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (124 total, 38 thin omitted)

### Community 0 - "Admin Backup & Audit Routes"
Cohesion: 0.05
Nodes (46): GET(), POST(), GET(), POST(), POST(), DELETE(), POST(), POST() (+38 more)

### Community 1 - "Tenant Query API Routes"
Cohesion: 0.10
Nodes (41): GET(), POST(), requestMeta(), DELETE(), GET(), POST(), GET(), DELETE() (+33 more)

### Community 2 - "Deployment Secrets & Crypto"
Cohesion: 0.09
Nodes (36): detectBuildErrorHint(), truncateBuildLog(), decrypt(), encrypt(), getKey(), maskSecrets(), activeDeployments, ActiveDeployState (+28 more)

### Community 3 - "DNS & Cloudflare Integration"
Cohesion: 0.08
Nodes (39): buildInstructions(), cfFetch(), cfZoneId(), checkDns(), checkTls(), cloudflare, configuredProviders(), DnsCheckResult (+31 more)

### Community 4 - "CMS Collections & Users API"
Cohesion: 0.13
Nodes (31): DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET(), POST() (+23 more)

### Community 5 - "Provisioning Agent Core"
Cohesion: 0.09
Nodes (18): app, cleanupTenantResources(), execFileP, globalLimiter, reattachProjectNetworks(), sensitiveOpLimiter, webhookLimiter, alert() (+10 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "GitHub & Monitoring Integration"
Cohesion: 0.17
Nodes (17): BUILDS_ROOT, deleteGithubWebhook(), githubHeaders(), parseGithubRepo(), webhookUrlFor(), createHttpMonitor(), deleteMonitor(), isConfigured() (+9 more)

### Community 8 - "Platform Tech Stack"
Cohesion: 0.09
Nodes (22): age (Verschlüsselung), Cloudflare (DNS-01, Zero Trust), Cloudflare Tunnel, CMS Session-Gültigkeitsprüfung, docker-socket-proxy, GoTrue, NextAuth v5, Next.js 15 (Dashboard/CMS) (+14 more)

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

### Community 17 - "Analytics Dashboard UI"
Cohesion: 0.15
Nodes (14): AnalyticsData, AnalyticsPage(), formatDay(), formatNumber(), RANGES, RankedList(), SeriesPoint, ViewsChart() (+6 more)

### Community 18 - "Domain Management UI"
Cohesion: 0.15
Nodes (9): AddDomainResult, Domain, DomainsPage(), Instruction, relTime(), STATUS_META, ConfirmDialogProps, CopyValue() (+1 more)

### Community 19 - "CMS Login & Session"
Cohesion: 0.21
Nodes (11): POST(), LoginPage(), LoginForm(), getSessionUser(), clearStaleCookie(), CmsSession, createSession(), destroySession() (+3 more)

### Community 20 - "CMS Admin Page"
Cohesion: 0.12
Nodes (6): CmsAdminPage(), CmsUser, Collection, Field, FIELD_TYPES, TableCandidate

### Community 21 - "Deployments Management UI"
Cohesion: 0.14
Nodes (8): ACTIVE_STATES, CANCELLABLE_STATES, Deployment, DeploymentsPage(), duration(), githubCommitUrl(), STATUS_COLOR, WebhookStatus

### Community 22 - "Dashboard Dependencies"
Cohesion: 0.13
Nodes (15): dependencies, jose, minio, next, pg, react, sanitize-html, sharp (+7 more)

### Community 23 - "TypeScript Compiler Config"
Cohesion: 0.13
Nodes (15): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, module, moduleResolution (+7 more)

### Community 24 - "Tenant Table Editor UI"
Cohesion: 0.21
Nodes (10): ColumnInfo, displayValue(), InputKind, inputKindFor(), Row, TableEditorPage(), saveEdit(), startEdit() (+2 more)

### Community 25 - "TypeScript Compiler Config"
Cohesion: 0.13
Nodes (15): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, module, moduleResolution (+7 more)

### Community 26 - "Media Upload Storage"
Cohesion: 0.21
Nodes (12): ALLOWED, bucketFor(), getClient(), MAX_FILE_BYTES, MAX_TENANT_BYTES, MAX_UPLOAD_BYTES, PORT, PUBLIC_BASE (+4 more)

### Community 27 - "SQL Query Editor UI"
Cohesion: 0.26
Nodes (10): historyKey(), loadHistory(), pushHistory(), QueryResult, SavedQuery, SqlEditorPage(), handleExportCsv(), handleKeyDown() (+2 more)

### Community 28 - "Dashboard Layout & Toasts"
Cohesion: 0.18
Nodes (9): metadata, Providers(), COLORS, ICONS, ToastApi, ToastContext, ToastItem, ToastKind (+1 more)

### Community 29 - "Provisioning Agent Dependencies"
Cohesion: 0.15
Nodes (13): express-rate-limit, jsonwebtoken, dependencies, express, express-rate-limit, jsonwebtoken, pg, psl (+5 more)

### Community 30 - "Cleanup & Retention Jobs"
Cohesion: 0.28
Nodes (12): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+4 more)

### Community 31 - "Tenant Database Provisioning"
Cohesion: 0.38
Nodes (10): execFileP, provisionTenantDatabase(), startTenantServices(), stopTenantServices(), tenantComposeExists(), tenantComposeFile(), tenantDir(), waitForGotrue() (+2 more)

### Community 32 - "Docker Stats Monitoring"
Cohesion: 0.21
Nodes (8): directorySize(), DockerStatsLine, execFileP, parseMemUsage(), parseSize(), readBucketSizes(), readDockerStats(), statsRouter

### Community 33 - "Auth Dependencies"
Cohesion: 0.13
Nodes (15): bcryptjs, react-dom, bcryptjs, react-dom, dependencies, bcryptjs, next, next-auth (+7 more)

### Community 34 - "Environment Variables UI"
Cohesion: 0.17
Nodes (4): ApiKeys, EnvVar, EnvVarsPage(), ConfirmDialog()

### Community 35 - "Provisioning Agent TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, skipLibCheck, strict (+3 more)

### Community 36 - "TypeScript Type Dependencies"
Cohesion: 0.18
Nodes (11): typescript, typescript, typescript, devDependencies, @types/express, @types/jsonwebtoken, @types/psl, typescript (+3 more)

### Community 37 - "Projects List UI"
Cohesion: 0.27
Nodes (9): Project, ProjectsPage(), handleCreate(), handleDelete(), handleStatusChange(), load(), Tenant, EmptyState() (+1 more)

### Community 38 - "Redeploy Script"
Cohesion: 0.47
Nodes (10): add_env(), compose(), die(), info(), ok(), psql_admin(), say(), redeploy.sh script (+2 more)

### Community 39 - "CMS Package Config"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, start, type (+1 more)

### Community 40 - "ESLint Dependencies"
Cohesion: 0.20
Nodes (10): devDependencies, eslint, eslint-config-next, @types/react-dom, @types/sanitize-html, eslint-config-next, @types/react-dom, eslint-config-next (+2 more)

### Community 41 - "CMS Media & Row Forms"
Cohesion: 0.24
Nodes (4): MediaPicker(), FormField, RowForm(), toInputValue()

### Community 42 - "Dashboard Package Config"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, start, type (+1 more)

### Community 43 - "Project Overview Page"
Cohesion: 0.20
Nodes (3): GithubRepo, ProjectOverviewPage(), Tenant

### Community 44 - "Dev Type Dependencies"
Cohesion: 0.22
Nodes (9): @types/bcryptjs, @types/react, eslint, @types/bcryptjs, @types/react, devDependencies, eslint, @types/bcryptjs (+1 more)

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "Backups Management UI"
Cohesion: 0.28
Nodes (6): Backup, BackupsPage(), formatBytes(), RestoreResultEntry, STATUS_COLOR, useToast()

### Community 47 - "Project Documentation Guides"
Cohesion: 0.25
Nodes (8): Architecture Overview, Contributing Guide, cms_config role (Migration 22), Migration 19: optional database, project_env_vars table, projects table, Operations Runbook, Setup Guide

### Community 48 - "CMS Schema Tables"
Cohesion: 0.43
Nodes (8): cms service, cms_audit table, cms_collections table, cms_fields table, cms_media table, cms_users table, Migration 21: CMS schema, CMS Implementation Plan

### Community 49 - "Next.js Type Includes"
Cohesion: 0.29
Nodes (8): include, next-env.d.ts, .next/types/**/*.ts, **/*.ts, **/*.tsx, include, **/*.ts, **/*.tsx

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "Backup Script"
Cohesion: 0.81
Nodes (6): encrypt_and_upload(), fail(), log(), record_backup(), send_alert(), backup-script.sh script

### Community 52 - "TypeScript Lib Config"
Cohesion: 0.29
Nodes (7): lib, dom, dom.iterable, esnext, lib, dom, esnext

### Community 53 - "Provisioning Agent Package Config"
Cohesion: 0.29
Nodes (6): name, scripts, build, start, type, version

### Community 54 - "Smoke Test Script"
Cohesion: 0.57
Nodes (6): agent(), cleanup(), fail(), log(), smoke-test.sh script, step()

### Community 55 - "Restore Script"
Cohesion: 0.73
Nodes (5): confirm(), die(), fetch(), log(), restore-script.sh script

### Community 56 - "Graphify Project Docs"
Cohesion: 0.50
Nodes (3): CLAUDE.md — Project Instructions, .claude/hooks/*.sh, graphify CLI Tool

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 58 - "TS Config Excludes"
Cohesion: 0.40
Nodes (3): exclude, node_modules, exclude

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

### Community 62 - "Pg-Format Package"
Cohesion: 0.50
Nodes (4): pg-format, pg-format, pg-format, pg-format

### Community 63 - "Node Type Definitions"
Cohesion: 0.50
Nodes (4): @types/node, @types/node, @types/node, @types/node

### Community 64 - "Pg Type Definitions"
Cohesion: 0.50
Nodes (4): @types/pg, @types/pg, @types/pg, @types/pg

## Knowledge Gaps
- **291 isolated node(s):** `SavedQuery`, `Tenant`, `ColumnInfo`, `GetRowsOptions`, `RunSqlResult` (+286 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **38 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Dashboard Dependencies` to `Auth Dependencies`, `Pg-Format Package`, `CMS Package Config`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `useToast()` connect `Backups Management UI` to `Environment Variables UI`, `Projects List UI`, `Project Overview Page`, `Domain Management UI`, `CMS Admin Page`, `Deployments Management UI`, `Tenant Table Editor UI`, `SQL Query Editor UI`, `Dashboard Layout & Toasts`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **What connects `SavedQuery`, `Tenant`, `ColumnInfo` to the rest of the system?**
  _291 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Admin Backup & Audit Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.05307797537619699 - nodes in this community are weakly interconnected._
- **Should `Tenant Query API Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.1003921568627451 - nodes in this community are weakly interconnected._
- **Should `Deployment Secrets & Crypto` be split into smaller, more focused modules?**
  _Cohesion score 0.08687943262411348 - nodes in this community are weakly interconnected._
- **Should `DNS & Cloudflare Integration` be split into smaller, more focused modules?**
  _Cohesion score 0.08181818181818182 - nodes in this community are weakly interconnected._