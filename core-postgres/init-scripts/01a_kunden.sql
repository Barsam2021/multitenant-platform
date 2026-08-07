-- P0-1: Basistabelle kunden. Muss vor 02_admin_schema.sql laufen, das sie nur
-- noch per ALTER erweitert.
--
-- Die Spalten hier sind bewusst das Minimum aus dem Original-Setup; alles was
-- spaeter dazukam (tariff, minio_*, anon_jwt, ...) bleibt in 02 und 09, damit
-- bestehende Installationen dieselbe Migrationskette durchlaufen.
\connect admin_dashboard

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS kunden (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
    db_name TEXT NOT NULL,
    gotrue_jwt_secret TEXT,
    authenticator_password TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
