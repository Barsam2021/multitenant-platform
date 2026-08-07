\connect admin_dashboard

-- Phase 0: fehlende kunden-Spalten + Tabellen (projects, domains, deployments, project_env_vars, github_connections)
-- Idempotent, gegen admin_dashboard-DB auszuführen.

ALTER TABLE kunden ADD COLUMN IF NOT EXISTS tariff TEXT DEFAULT 'starter';
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS minio_access_key TEXT;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS minio_secret_key_encrypted BYTEA;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS resend_api_key_encrypted BYTEA;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS auth_public_enabled BOOLEAN DEFAULT false;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS postgrest_public_enabled BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
    tenant_id UUID REFERENCES kunden(id) ON DELETE SET NULL,
    repo_url TEXT,
    repo_provider TEXT CHECK (repo_provider IN ('github','gitlab','manual')),
    default_branch TEXT DEFAULT 'main',
    build_command TEXT,
    webhook_secret_encrypted BYTEA,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    hostname TEXT UNIQUE NOT NULL,
    kind TEXT CHECK (kind IN ('subdomain','custom')),
    dns_verified BOOLEAN DEFAULT false,
    tls_issued BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT,
    status TEXT CHECK (status IN ('queued','building','deployed','failed','rolled_back')),
    build_log TEXT,
    triggered_by TEXT CHECK (triggered_by IN ('webhook','manual','api')),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_encrypted BYTEA NOT NULL,
    UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS github_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_username TEXT NOT NULL,
    access_token_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);