-- CMS-Modul: Endkunden pflegen ihre Inhalte selbst.
--
-- Entwurf und Begruendungen stehen in docs/CMS-PLAN.md — hier nur das, was die
-- Datenbank davon wissen muss.
--
-- Alles liegt in admin_dashboard, NICHT in der Tenant-DB: die gehoert dem
-- Kunden und soll keine Plattform-Metadaten enthalten. Die Inhalte selbst
-- liegen weiterhin ausschliesslich in den Tabellen des Kunden — dieses Schema
-- beschreibt nur, welche davon im CMS auftauchen und wie sie dargestellt
-- werden.
--
-- Idempotent.
\connect admin_dashboard

-- Zugangsdaten der eingeschraenkten DB-Rolle cms_<slug>. Verschluesselt mit
-- CMS_ENCRYPTION_KEY, bewusst NICHT mit ENCRYPTION_MASTER_KEY: der CMS-Dienst
-- ist der einzige Teil der Plattform, den kundenfremde Personen direkt
-- benutzen. Er braucht dieses eine Passwort — und soll bei einer Kompromittierung
-- eben NICHT auch die MinIO- und JWT-Secrets aller Tenants entschluesseln
-- koennen.
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS cms_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE kunden ADD COLUMN IF NOT EXISTS cms_db_password_encrypted BYTEA;

-- Welche Tabelle eines Tenants ist eine CMS-Sammlung?
CREATE TABLE IF NOT EXISTS cms_collections (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug    TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    table_name     TEXT NOT NULL,
    label          TEXT NOT NULL,
    label_singular TEXT,
    sort_column    TEXT,
    sort_dir       TEXT NOT NULL DEFAULT 'desc' CHECK (sort_dir IN ('asc', 'desc')),
    can_create     BOOLEAN NOT NULL DEFAULT true,
    can_delete     BOOLEAN NOT NULL DEFAULT true,
    position       INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_slug, table_name)
);

-- Wie wird eine Spalte im Formular dargestellt?
--
-- field_type ist bewusst ohne CHECK-Constraint: neue Feldtypen kommen im
-- CMS-Dienst dazu, und eine Migration nur dafuer waere reine Reibung. Die
-- gueltigen Werte stehen in cms/src/lib/fieldTypes.ts, unbekannte Typen
-- rendert der Dienst als einfaches Textfeld.
CREATE TABLE IF NOT EXISTS cms_fields (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id UUID NOT NULL REFERENCES cms_collections(id) ON DELETE CASCADE,
    column_name   TEXT NOT NULL,
    label         TEXT NOT NULL,
    field_type    TEXT NOT NULL,
    help_text     TEXT,
    required      BOOLEAN NOT NULL DEFAULT false,
    visible_list  BOOLEAN NOT NULL DEFAULT true,
    visible_form  BOOLEAN NOT NULL DEFAULT true,
    readonly      BOOLEAN NOT NULL DEFAULT false,
    options       JSONB,
    position      INT NOT NULL DEFAULT 0,
    UNIQUE (collection_id, column_name)
);

-- Redakteure des Kunden. Bewusst NICHT GoTrue: GoTrue ist pro Tenant optional
-- (Migration 19) und kann abgeschaltet sein, waehrend das CMS laufen soll.
-- Ausserdem sind das Redakteure, keine App-Nutzer des Kunden — die beiden
-- Nutzerkreise zu vermischen waere ein Rechteproblem, kein Komfortgewinn.
CREATE TABLE IF NOT EXISTS cms_users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug    TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    display_name   TEXT,
    role           TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'admin')),
    disabled       BOOLEAN NOT NULL DEFAULT false,
    failed_logins  INT NOT NULL DEFAULT 0,
    locked_until   TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_slug, email)
);

-- Hochgeladene Dateien. Die Datei liegt im MinIO-Bucket des Tenants, hier steht
-- nur, wem sie gehoert und was sie ist.
CREATE TABLE IF NOT EXISTS cms_media (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug   TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    object_key    TEXT NOT NULL,
    public_url    TEXT NOT NULL,
    original_name TEXT,
    content_type  TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    width         INT,
    height        INT,
    uploaded_by   UUID REFERENCES cms_users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_slug, object_key)
);

-- Wer hat wann was geaendert. Getrennt von audit_logs (das ist das
-- Betreiber-Log), damit dem Kunden seine eigene Historie zeigbar ist, ohne ihm
-- Plattform-Interna zu zeigen.
CREATE TABLE IF NOT EXISTS cms_audit (
    id          BIGSERIAL PRIMARY KEY,
    tenant_slug TEXT NOT NULL,
    user_id     UUID,
    user_email  TEXT,
    action      TEXT NOT NULL,
    collection  TEXT,
    row_pk      TEXT,
    detail      JSONB,
    ip          TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cms_collections_tenant ON cms_collections (tenant_slug, position);
CREATE INDEX IF NOT EXISTS idx_cms_fields_collection ON cms_fields (collection_id, position);
CREATE INDEX IF NOT EXISTS idx_cms_users_tenant ON cms_users (tenant_slug);
CREATE INDEX IF NOT EXISTS idx_cms_media_tenant_created ON cms_media (tenant_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cms_audit_tenant_created ON cms_audit (tenant_slug, created_at DESC);
