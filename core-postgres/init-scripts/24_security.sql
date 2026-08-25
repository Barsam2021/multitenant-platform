\connect admin_dashboard

-- Versionsinventar + Schwachstellen (docs/CVE-PLAN.md).
--
-- Nummer 24 und nicht 23: 23 ist auf dem Backup-Branch fuer
-- 23_backups_status.sql vergeben. Beide sind fachlich unabhaengig, die
-- Reihenfolge beim Anwenden spielt daher keine Rolle.

-- Was laeuft: eine Zeile je Komponente und Version.
CREATE TABLE IF NOT EXISTS components (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope          TEXT NOT NULL CHECK (scope IN ('platform','tenant','project')),
    project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
    target         TEXT NOT NULL,      -- Container- bzw. Image-Referenz
    kind           TEXT NOT NULL CHECK (kind IN ('image','npm','deb','apk','other')),
    name           TEXT NOT NULL,
    version        TEXT NOT NULL,
    -- Aus den Compose-Dateien im Repo. Weicht der Wert von `version` ab, laeuft
    -- etwas anderes als gepinnt ist — genau das soll sichtbar werden.
    pinned_version TEXT,
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scope, target, kind, name, version)
);
CREATE INDEX IF NOT EXISTS idx_components_scope ON components (scope, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_components_project ON components (project_id);

-- Ein Scanlauf.
CREATE TABLE IF NOT EXISTS security_scans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    scanner       TEXT NOT NULL DEFAULT 'trivy',
    -- Alter der Schwachstellen-Datenbank. Ein Scan mit veralteter DB meldet
    -- "0 kritisch" und sieht dabei aus wie eine gute Nachricht.
    scanner_db_at TIMESTAMPTZ,
    targets_total INT NOT NULL DEFAULT 0,
    targets_ok    INT NOT NULL DEFAULT 0,
    status        TEXT CHECK (status IN ('running','ok','partial','failed')),
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_scans_started ON security_scans (started_at DESC);

-- Ein Fund. Gehoert zum Lauf, nicht zur Komponente: so verschwindet ein CVE
-- von allein, wenn es im naechsten Lauf nicht mehr auftaucht, und man sieht am
-- Verlauf, wann das passiert ist. Ein handgepflegtes status-Feld waere nach
-- vier Wochen falsch.
CREATE TABLE IF NOT EXISTS vulnerabilities (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id           UUID NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
    scope             TEXT NOT NULL CHECK (scope IN ('platform','tenant','project')),
    project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
    target            TEXT NOT NULL,
    pkg_name          TEXT NOT NULL,
    installed_version TEXT NOT NULL,
    fixed_version     TEXT,            -- NULL = es gibt noch keinen Fix
    cve_id            TEXT NOT NULL,
    severity          TEXT NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','UNKNOWN')),
    cvss_score        NUMERIC(3,1),
    title             TEXT,
    url               TEXT
);
CREATE INDEX IF NOT EXISTS idx_vuln_scan ON vulnerabilities (scan_id);
CREATE INDEX IF NOT EXISTS idx_vuln_severity ON vulnerabilities (scan_id, severity);
CREATE INDEX IF NOT EXISTS idx_vuln_project ON vulnerabilities (project_id);

-- Bewusst hingenommene Funde. Mit Ablaufdatum: ein "ignorieren" ohne Verfall
-- ist auf Dauer ein blinder Fleck, den niemand mehr prueft.
CREATE TABLE IF NOT EXISTS vulnerability_ignores (
    cve_id     TEXT NOT NULL,
    target     TEXT NOT NULL,
    pkg_name   TEXT NOT NULL,
    reason     TEXT NOT NULL,
    until      TIMESTAMPTZ,            -- NULL = dauerhaft
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cve_id, target, pkg_name)
);
