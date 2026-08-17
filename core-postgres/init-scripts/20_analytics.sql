-- Besucher-Analytics pro Domain.
--
-- Quelle ist der Traefik-Accesslog (JSON), den der Provisioning Agent
-- inkrementell einliest (provisioning-agent/src/lib/analytics.ts). Bewusst KEIN
-- Tracking-Script im Kundencode: das haette in jede Kunden-App eingebaut werden
-- muessen, waere von Adblockern geblockt worden und haette die Plattform an das
-- Deployment-Verhalten der Kunden gekoppelt. Der Reverse Proxy sieht ohnehin
-- jeden Request.
--
-- Datenschutz: es wird KEINE IP und KEIN User-Agent gespeichert. Ein Besucher
-- ist ein salted Hash aus IP + User-Agent + Hostname, wobei das Salt TAEGLICH
-- rotiert (siehe lib/analytics.ts visitorHash()). Damit ist ein Besucher
-- innerhalb eines Tages wiedererkennbar, ueber Tage hinweg nicht — kein Cookie,
-- kein Consent-Banner noetig, aber auch keine tagesuebergreifende Person.
-- Konsequenz fuer die Auswertung: "Unique" ueber einen Zeitraum ist die Summe
-- der Tages-Uniques, wer an drei Tagen kommt zaehlt dreimal.
--
-- Vier Tabellen statt einer Rohdatentabelle, weil die Aggregate klein bleiben
-- muessen — eine Zeile pro Request waere bei 20 Kunden schnell im
-- zweistelligen Millionenbereich, und danach gefragt wird immer aggregiert.
--
-- Idempotent.
\connect admin_dashboard

-- Tagessumme pro Domain. Die einzige Tabelle mit langer Aufbewahrung (siehe
-- lib/cleanup.ts): unique_visitors wird bei jedem Ingest-Lauf aus
-- analytics_visitors nachgezogen, damit die Zahl erhalten bleibt, wenn die
-- Besucher-Hashes selbst laengst geloescht sind.
CREATE TABLE IF NOT EXISTS analytics_daily (
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hostname        TEXT NOT NULL,
    day             DATE NOT NULL,
    views           BIGINT NOT NULL DEFAULT 0,
    unique_visitors BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, hostname, day)
);

-- Aufrufe pro Pfad. Query-String wird vorher abgeschnitten (sonst ist jeder
-- UTM-Link ein eigener "Pfad"), Pfadlaenge ist gekappt.
CREATE TABLE IF NOT EXISTS analytics_page_views (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hostname   TEXT NOT NULL,
    day        DATE NOT NULL,
    path       TEXT NOT NULL,
    views      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, hostname, day, path)
);

-- Woher die Besucher kommen. Nur die Referrer-Herkunft (Schema + Host), nie der
-- volle Referrer-Pfad — der kann Suchbegriffe oder interne URLs enthalten.
CREATE TABLE IF NOT EXISTS analytics_referrers (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hostname   TEXT NOT NULL,
    day        DATE NOT NULL,
    referrer   TEXT NOT NULL,
    views      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, hostname, day, referrer)
);

-- Ein Datensatz pro (Tag, Domain, Besucher-Hash). COUNT(*) darauf ist die
-- Unique-Zahl. Kurze Aufbewahrung, das ist die mit Abstand groesste Tabelle.
CREATE TABLE IF NOT EXISTS analytics_visitors (
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hostname     TEXT NOT NULL,
    day          DATE NOT NULL,
    visitor_hash TEXT NOT NULL,
    PRIMARY KEY (project_id, hostname, day, visitor_hash)
);

-- Leseposition im Accesslog. Einzeiler-Tabelle (id='traefik-access-log'), damit
-- ein Agent-Neustart nicht die gesamte Datei erneut einliest (doppelte Views)
-- und nicht bei 0 anfaengt (fehlende Views).
CREATE TABLE IF NOT EXISTS analytics_ingest_state (
    id             TEXT PRIMARY KEY,
    file_offset    BIGINT NOT NULL DEFAULT 0,
    -- inode:groesse zum Zeitpunkt des letzten Laufs. Aendert sich der Inode
    -- (logrotate hat die Datei ersetzt) oder ist die Datei kleiner als der
    -- Offset (truncate), wird bei 0 weitergelesen statt ins Leere zu springen.
    file_signature TEXT,
    lines_ingested BIGINT NOT NULL DEFAULT 0,
    last_run_at    TIMESTAMPTZ,
    last_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_project_day
  ON analytics_daily (project_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_page_views_project_day
  ON analytics_page_views (project_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_referrers_project_day
  ON analytics_referrers (project_id, day DESC);
-- Fuer den Retention-Lauf: DELETE ... WHERE day < x geht sonst als Seq Scan
-- ueber die groesste Tabelle der Plattform.
CREATE INDEX IF NOT EXISTS idx_analytics_visitors_day
  ON analytics_visitors (day);
