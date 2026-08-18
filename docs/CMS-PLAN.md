# CMS-Modul — Umsetzungsplan

Status: **Phasen 1–3 gebaut und im Betrieb** (siehe `cms/`, Migrationen 21/22,
Dashboard-Tab „CMS"). Phase 4 und 5 stehen offen, ebenso die Entscheidungen in
§ 9 — die Umsetzung hat dort vorläufige Antworten gewählt, die in § 8 notiert
sind.

Dieses Dokument bleibt der Entwurf: es erklärt, warum das Modul so geschnitten
ist, nicht wie der Code im Detail aussieht.

## 1. Das Problem

Ein Kunde bekommt heute eine Datenbank, eine REST-API und ein Deployment — aber
keinen Weg, seine eigenen Inhalte zu pflegen. Legt der Betreiber eine Tabelle
`blogbeitraege` an, kann nur **er selbst** über den Tabellen-Editor im
Admin-Dashboard Zeilen einfügen. Der Kunde müsste dafür Zugang zur
Betreiber-Konsole bekommen, also zu allen anderen Kunden gleich mit. Das ist
keine Option.

Gebraucht wird: **der Endkunde meldet sich an einer eigenen Oberfläche an und
pflegt genau die Inhalte seiner eigenen Seite** — Blogbeiträge schreiben, Bilder
hochladen, Öffnungszeiten ändern, Teammitglieder pflegen.

Die Schwierigkeit ist, dass jedes Kundenprojekt anders aussieht. Ein festes
CMS-Schema („Posts, Seiten, Kategorien") passt auf ein Drittel der Projekte und
steht bei den übrigen im Weg. Deshalb: **das CMS wird aus dem Datenbankschema des
Kunden erzeugt**, nicht umgekehrt.

## 2. Grundidee: schemagetrieben, aber nicht geraten

Zwei Extreme, beide falsch:

* **Vollautomatisch** — alle Tabellen der Tenant-DB anzeigen, Formulare aus den
  Spaltentypen ableiten. Ergebnis: der Kunde sieht `auth.users`,
  `schema_migrations` und eine Spalte `id uuid` mit Eingabefeld.
* **Handgeschrieben pro Kunde** — jedes Projekt bekommt sein eigenes CMS.
  Skaliert nicht über fünf Kunden hinaus.

Der Weg dazwischen: der **Betreiber** entscheidet einmalig pro Projekt, welche
Tabellen im CMS auftauchen und wie ihre Felder heißen und aussehen. Die
Vorbelegung dieser Konfiguration kommt automatisch aus dem Postgres-Schema, sie
ist danach aber ein bearbeitbarer Datensatz und nicht mehr an das Schema
gekoppelt.

Das heißt konkret: „Tabelle `blogbeitraege` ins CMS aufnehmen" ist ein Klick im
Admin-Dashboard, der eine Sammlung („Collection") mit vorbelegten Feldern anlegt.
Danach lässt sich beschriften (`titel` → „Überschrift"), umsortieren, ausblenden
(`id`, `created_at`), und ein Feldtyp lässt sich hochstufen (`text` →
`Rich-Text`, `text` → `Bild`).

## 3. Architektur

### 3.1 Wo das CMS läuft

**Ein einziger zentraler CMS-Dienst für alle Tenants**, nicht ein Container pro
Kunde.

Begründung: die Plattform läuft auf einer 8-GB-VPS, und genau dort liegt der
Grund, warum die Datenbank pro Tenant überhaupt abschaltbar geworden ist
(Migration 19). Ein weiterer Dauer-Container pro Kunde wäre eine Verdopplung des
Problems, das gerade gelöst wurde. Ein zentraler Node-Prozess bedient alle
Kunden mit ein paar hundert MB.

```
cms.<PLATFORM_DOMAIN>/<tenant-slug>/...     ein Dienst, Mandant aus der URL + Session
```

Der Dienst kommt als eigenes Verzeichnis `cms/` (Next.js, gleiche Bauweise wie
`dashboard/`) und hängt in `traefik-net`, mit einem Traefik-Router auf
`cms.<PLATFORM_DOMAIN>`.

**Ausdrücklich nicht** Teil des Admin-Dashboards: das Dashboard verbindet sich
als `postgres`-Superuser mit jeder Tenant-DB und hat einen SQL-Editor, der
beliebiges SQL ausführt. Diesen Prozess für Endkunden erreichbar zu machen, wäre
die schlechteste denkbare Entscheidung der ganzen Plattform. Getrennter Dienst,
getrennte DB-Rolle, getrennte Session — auch wenn dadurch etwas Code doppelt
existiert.

### 3.2 Datenbankzugriff

Der CMS-Dienst verbindet sich **nicht** als Superuser, sondern pro Tenant mit
einer eigenen, eingeschränkten Rolle:

```sql
CREATE ROLE cms_<slug> LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE kunde_<slug> TO cms_<slug>;
GRANT USAGE ON SCHEMA public TO cms_<slug>;
-- Rechte NUR auf die Tabellen, die als Collection freigegeben wurden:
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blogbeitraege TO cms_<slug>;
```

Die `GRANT`s werden beim Freigeben einer Collection gesetzt und beim Entziehen
wieder zurückgenommen. Damit ist die Freigabe nicht nur eine UI-Entscheidung,
sondern auf Datenbankebene erzwungen: selbst ein Fehler in der Anwendungslogik
kann keine Tabelle erreichen, die nie freigegeben wurde. Kein Zugriff auf
`auth.*` (dort liegen die GoTrue-Nutzer des Kunden).

Passwort verschlüsselt in `kunden.cms_db_password_encrypted` (gleiche
`lib/crypto.ts`-Mechanik wie die MinIO-Secrets).

### 3.3 Abhängigkeit zur optionalen Datenbank

Das CMS setzt eine **provisionierte Datenbank** voraus (`kunden.db_provisioned`).
Es braucht aber **keine laufenden Container**: der CMS-Dienst spricht direkt über
PgBouncer mit Postgres, PostgREST und GoTrue sind unbeteiligt. Ein Kunde mit
`db_enabled = false` kann also trotzdem ein CMS haben — was ein sinnvoller
Normalfall ist: Inhalte pflegen, statische Seite bauen, keine Laufzeit-API.

Ein Kunde ohne Datenbank (`db_provisioned = false`) kann kein CMS bekommen; die
UI muss beim Aktivieren anbieten, die Datenbank gleich mit anzulegen.

## 4. Datenmodell

Alles in `admin_dashboard` (Betreiber-Seite), **nicht** in der Tenant-DB — die
Tenant-DB gehört dem Kunden und soll keine Plattform-Metadaten enthalten.

```sql
-- Welche Tabelle eines Tenants ist eine CMS-Sammlung?
CREATE TABLE cms_collections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug  TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    table_name   TEXT NOT NULL,          -- public.<table_name> in kunde_<slug>
    label        TEXT NOT NULL,          -- "Blogbeiträge"
    label_singular TEXT,                 -- "Blogbeitrag"
    sort_column  TEXT,                   -- Standardsortierung der Liste
    sort_dir     TEXT DEFAULT 'desc' CHECK (sort_dir IN ('asc','desc')),
    can_create   BOOLEAN NOT NULL DEFAULT true,
    can_delete   BOOLEAN NOT NULL DEFAULT true,
    position     INT NOT NULL DEFAULT 0, -- Reihenfolge im CMS-Menü
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_slug, table_name)
);

-- Wie wird eine Spalte im Formular dargestellt?
CREATE TABLE cms_fields (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id UUID NOT NULL REFERENCES cms_collections(id) ON DELETE CASCADE,
    column_name   TEXT NOT NULL,
    label         TEXT NOT NULL,
    field_type    TEXT NOT NULL,   -- siehe § 5
    help_text     TEXT,
    required      BOOLEAN NOT NULL DEFAULT false,
    visible_list  BOOLEAN NOT NULL DEFAULT true,   -- Spalte in der Übersicht
    visible_form  BOOLEAN NOT NULL DEFAULT true,   -- Feld im Formular
    readonly      BOOLEAN NOT NULL DEFAULT false,  -- id, created_at
    options       JSONB,           -- Auswahlwerte, Bildgrößen, max. Länge …
    position      INT NOT NULL DEFAULT 0,
    UNIQUE (collection_id, column_name)
);

-- Login der Endkunden. Bewusst NICHT GoTrue: GoTrue ist pro Tenant optional
-- (Migration 19) und kann abgeschaltet sein, während das CMS laufen soll.
-- Ausserdem sind das Redakteure des Betreibers, keine App-Nutzer des Kunden.
CREATE TABLE cms_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug   TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,          -- bcrypt, wie im Dashboard
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor','admin')),
    last_login_at TIMESTAMPTZ,
    disabled      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_slug, email)
);

-- Hochgeladene Dateien. Die Datei liegt in MinIO, hier steht nur, wem sie
-- gehört und wie sie heißt.
CREATE TABLE cms_media (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_slug  TEXT NOT NULL REFERENCES kunden(slug) ON DELETE CASCADE,
    object_key   TEXT NOT NULL,           -- public/2026/03/foto-a1b2c3.webp
    original_name TEXT,
    content_type TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    width        INT,
    height       INT,
    uploaded_by  UUID REFERENCES cms_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (tenant_slug, object_key)
);

-- Wer hat wann was geändert. Getrennt von audit_logs (das ist das
-- Betreiber-Log), damit man dem Kunden seine eigene Historie zeigen kann.
CREATE TABLE cms_audit (
    id           BIGSERIAL PRIMARY KEY,
    tenant_slug  TEXT NOT NULL,
    user_id      UUID,
    action       TEXT NOT NULL,           -- row.create | row.update | row.delete | media.upload
    collection   TEXT,
    row_pk       TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);
```

## 5. Feldtypen und ihre Ableitung

Beim Anlegen einer Collection wird `information_schema.columns` gelesen (dieselbe
Query wie `dashboard/src/lib/tenantDb.ts` `getTableColumns()`) und pro Spalte ein
Vorschlag erzeugt:

| Postgres-Typ | Vorbelegter Feldtyp | Bemerkung |
|---|---|---|
| `text`, `varchar` ≤ 200 | `text` | einzeiliges Feld |
| `text` ohne Längenbegrenzung | `textarea` | auf `richtext` hochstufbar |
| `integer`, `bigint`, `numeric` | `number` | |
| `boolean` | `toggle` | |
| `date` | `date` | |
| `timestamptz`, `timestamp` | `datetime` | |
| `jsonb` | `json` | Rohtextfeld mit Validierung |
| `uuid` (Primärschlüssel) | `readonly` | im Formular ausgeblendet |
| `uuid` mit Fremdschlüssel | `relation` | Auswahlliste aus der Zieltabelle |
| `text` mit Check-Constraint `IN (…)` | `select` | Werte aus dem Constraint |
| `USER-DEFINED` (enum) | `select` | Werte aus `pg_enum` |

Zusätzliche Typen, die **nicht** automatisch erkannt werden, sondern bewusst
gesetzt werden:

* `image` — speichert die öffentliche URL in einer `text`-Spalte, Upload siehe §6
* `gallery` — mehrere Bilder, `jsonb`-Spalte mit Array von URLs
* `file` — beliebiger Dateianhang (PDF etc.)
* `richtext` — HTML aus einem Editor, serverseitig bereinigt (§ 7)
* `slug` — aus einem anderen Feld erzeugt, auf Eindeutigkeit geprüft

Namensheuristik nur als **Vorschlag beim Anlegen**, nie als automatische
Umschaltung: Spalten, die auf `_url`, `_bild`, `_image` enden, werden als
`image` vorgeschlagen.

## 6. Bilder und Dateien

Jeder Tenant hat bereits einen MinIO-Bucket (`kunde-<slug>-storage`) samt
eigenem IAM-User — das ist heute schon so, wird aber von nichts benutzt.

**Upload:** Browser → CMS-Dienst → MinIO. Bewusst nicht per presigned URL direkt
vom Browser: der Dienst muss Dateityp, Größe und Bildinhalt prüfen, bevor
irgendetwas im Bucket landet, und er muss die Datei ohnehin anfassen, um
Vorschaugrößen zu erzeugen.

Verarbeitung beim Upload:
1. MIME-Typ **aus dem Dateiinhalt** bestimmen, nicht aus dem `Content-Type` des
   Browsers.
2. Zulassungsliste: `image/jpeg`, `image/png`, `image/webp`, `image/avif`,
   `application/pdf`. **Kein SVG** — SVG ist ein XSS-Vektor, sobald es unter der
   Kundendomain ausgeliefert wird.
3. Größenlimit pro Datei und Gesamtkontingent pro Tenant (Tarif-abhängig,
   analog zu den bestehenden `*_MEM`-Limits).
4. Bilder neu kodieren (`sharp`): entfernt EXIF-Daten inklusive GPS-Koordinaten
   und macht manipulierte Dateien unschädlich. Ausgabe als WebP plus
   Vorschaugrößen (z. B. 400/800/1600 px Breite).
5. Objektschlüssel: `public/<jahr>/<monat>/<slugifizierter-name>-<random>.webp`.
   Zufallsanteil verhindert, dass zwei Uploads gleichen Namens sich überschreiben.

**Ausliefern:** MinIO ist heute von außen nicht erreichbar (nur im
`traefik-net`), Bilder in einer Kundenseite müssen aber öffentlich sein. Nötig
ist ein Traefik-Router auf den MinIO-Container:

```
media.<PLATFORM_DOMAIN>/kunde-<slug>-storage/public/...
```

mit einer anonymen Download-Policy **nur für das Präfix `public/`** (`mc anonymous
set download localminio/kunde-<slug>-storage/public`). Alles außerhalb von
`public/` bleibt unerreichbar. Ein späterer Ausbau kann pro Kunde eine eigene
Mediendomain bekommen; für den Anfang reicht der gemeinsame Host.

## 7. Sicherheit

Das CMS ist der erste Teil der Plattform, den **kunden-fremde Personen** direkt
benutzen. Entsprechend:

* **Keine freien Queries.** Tabellen- und Spaltennamen kommen ausschließlich aus
  `cms_collections`/`cms_fields`, werden gegen `information_schema` geprüft und
  über `pg-format` `%I` eingesetzt (CONTRIBUTING.md § Code-Style). Werte immer
  parametrisiert.
* **Rechte doppelt.** Anwendungsseitig über die Collection-Konfiguration,
  datenbankseitig über die `GRANT`s der `cms_<slug>`-Rolle (§ 3.2).
* **Mandantentrennung an genau einer Stelle.** Der Tenant kommt aus der Session,
  nie aus URL oder Request-Body. Eine geteilte Hilfsfunktion lädt Collection +
  Tenant zusammen und wirft, wenn die Collection nicht zum Session-Tenant
  gehört.
* **Rich-Text serverseitig bereinigen** (Zulassungsliste an Tags/Attributen,
  kein `<script>`, keine `on*`-Attribute, keine `javascript:`-URLs). Der Kunde
  schreibt Inhalte, die auf seiner eigenen Domain landen — dort ist gespeichertes
  XSS ein echtes Problem, kein theoretisches.
* **Rate-Limiting** auf Login und Upload, wie im Provisioning Agent bereits
  vorhanden (`express-rate-limit`-Muster).
* **Login:** bcrypt, Session-Cookie `httpOnly`/`secure`/`sameSite=lax`,
  Sperre nach zu vielen Fehlversuchen, Passwort-Reset per E-Mail über den bereits
  konfigurierten Resend-Zugang.
* **Audit:** jede schreibende Aktion in `cms_audit`, sichtbar für den Betreiber
  im Admin-Dashboard.

## 8. Umsetzung in Phasen

Jede Phase ist für sich benutzbar — kein „erst nach Phase 4 sieht der Kunde
etwas".

Stand der Umsetzung, mit den Abweichungen vom Entwurf:

| Phase | Stand | Abweichung |
|---|---|---|
| 1 Fundament | gebaut | Migration 21 legt zusätzlich `cms_audit.detail`/`ip` und den Fehlversuchszähler an; Migration 22 die Rolle `cms_config` (im Entwurf nicht vorgesehen, siehe unten) |
| 2 Listen & Formulare | gebaut | zusätzlich `json`-Felder und Suche über alle Listenspalten |
| 3 Medien | gebaut | Upload, Neukodierung, Medienübersicht; Löschen von Dateien fehlt noch |
| — Härtung | nachgezogen | Sitzung wird bei jedem Aufruf gegen `cms_users` geprüft; Bremsen für Login, Upload und Schreibvorgänge; Pixel- und Bildanzahl-Grenzen beim Dekodieren; Postgres-Fehler werden übersetzt statt durchgereicht |
| 4 Komfort | offen | `richtext` ist als bereinigtes Textfeld da, aber ohne Editor; `relation`, `gallery`, Entwurfsstatus fehlen |
| 5 Automatik | offen | „Seite neu veröffentlichen" gibt es noch nicht |

Was der Betrieb dem Entwurf hinzugefügt hat — der Vollständigkeit halber notiert,
weil es sich nicht aus dem Entwurf ableiten ließ:

* **Eine Sitzung ist nur so gültig wie ihr Konto.** Der Entwurf ging von einem
  signierten Cookie mit Laufzeit aus. In der Praxis wird ein Zugang gelöscht und
  neu angelegt, während der Browser des Redakteurs weiterläuft. Da `cms_media`
  die einzige Schreiboperation mit Fremdschlüssel auf `cms_users` ist, fiel das
  ausschließlich beim Bild-Upload auf — lesen und Inhalte speichern lief weiter.
  Die Sitzung wird deshalb bei jedem Aufruf gegen die Datenbank geprüft.
* **Die Größe einer Datei sagt nichts über ihren Speicherbedarf.** Die
  10-MB-Grenze des Entwurfs begrenzt den Upload, nicht das dekodierte Bild.
  Dazu kommen jetzt Grenzen für Pixelzahl und, bei Animationen, für die Anzahl
  der Einzelbilder.

Zwei Entscheidungen, die der Entwurf offengelassen hatte und die die Umsetzung
getroffen hat:

* **Eine zweite Rolle für die Konfiguration.** Der Entwurf sprach nur von
  `cms_<slug>` für die Inhalte. Der Dienst muss aber auch `cms_collections`,
  `cms_users` usw. lesen — und dafür den Superuser zu nehmen hätte den ganzen
  Aufwand mit den eingeschränkten Rollen entwertet. Deshalb `cms_config`, mit
  Rechten auf genau die cms_*-Tabellen und **einzeln aufgezählte Spalten** von
  `kunden` (die Secret-Spalten sind ausdrücklich nicht dabei).
* **`cms.<domain>/<slug>` statt eigener Subdomain pro Kunde** (§ 9.2): ein
  Zertifikat, ein Router, ein Container. Eine eigene Subdomain pro Kunde bleibt
  nachrüstbar, ohne dass sich am Dienst etwas ändert.

**Phase 1 — Fundament (Betreiber-Seite)**
Migration mit den fünf Tabellen aus § 4. Im Admin-Dashboard ein neuer Tab „CMS"
pro Projekt: Tabellen der Tenant-DB auflisten, als Collection freigeben, Felder
bearbeiten, CMS-Benutzer anlegen. Noch keine Kundenoberfläche.
*Ergebnis: die Konfiguration existiert und ist pflegbar.*

**Phase 2 — CMS-Dienst mit Listen und Formularen**
Neues Verzeichnis `cms/`, Login, Menü aus den Collections, Listenansicht mit
Sortierung/Suche/Blättern, Formular zum Anlegen und Bearbeiten, Löschen mit
Rückfrage. Feldtypen: `text`, `textarea`, `number`, `toggle`, `date`,
`datetime`, `select`, `readonly`.
*Ergebnis: der Kunde kann Textinhalte selbst pflegen. Das ist der eigentliche
Kern.*

**Phase 3 — Medien**
Upload-Endpunkt mit Prüfung und Neukodierung, Medienübersicht, Feldtypen `image`
und `file`, öffentlicher Ausliefer-Router (§ 6).
*Ergebnis: Bilder hochladen und einbinden.*

**Phase 4 — Komfort**
`richtext` mit Bereinigung, `relation` (Auswahl aus Fremdschlüsseltabelle),
`slug`, `gallery`, Entwurf/Veröffentlicht-Status (setzt eine `boolean`- oder
`text`-Spalte in der Kundentabelle voraus), Vorschau-Link, eigene Historie für
den Kunden.

**Phase 5 — Automatik**
Wenn eine CMS-Änderung ein neues Deployment auslösen soll (statische Seiten):
Knopf „Seite neu veröffentlichen", der denselben Deployment-Endpunkt aufruft,
den auch der GitHub-Webhook nutzt — mit Sperre, damit fünf Textänderungen nicht
fünf Builds starten.

## 9. Offene Entscheidungen

Diese Punkte sollten vor Phase 2 entschieden werden, weil sie die Umsetzung
verändern:

1. **Ein Login pro Kunde oder pro Person?** Der Entwurf oben erlaubt mehrere
   Benutzer pro Tenant. Falls das nie gebraucht wird, spart ein einziger
   Zugang pro Kunde die halbe Benutzerverwaltung.
2. **Eigene Domain fürs CMS?** `cms.<PLATFORM_DOMAIN>/<slug>` ist einfacher;
   `<slug>-cms.<PLATFORM_DOMAIN>` wirkt für den Kunden mehr nach „seiner"
   Oberfläche und erlaubt später ein eigenes Logo pro Kunde.
3. **Wie kommen die Inhalte auf die Seite?** Bei serverseitig gerenderten Apps
   sofort (die App liest die DB). Bei statisch gebauten Seiten braucht es
   Phase 5. Das hängt an den konkreten Kundenprojekten.
4. **Mehrsprachigkeit** — bewusst nicht im Entwurf. Falls absehbar gebraucht,
   sollte sie früh mitgedacht werden (Spalten-Suffixe vs. Übersetzungstabelle),
   weil sie sich schlecht nachrüsten lässt.

## 10. Nicht-Ziele

* Kein Seitenbaukasten mit Drag & Drop. Das Layout gehört in den Code des
  Projekts, das CMS pflegt Inhalte.
* Kein Ersatz für den Tabellen-Editor im Admin-Dashboard. Der bleibt das
  Betreiberwerkzeug mit vollem Zugriff.
* Kein eigenes Rechte-System pro Feld. Zwei Rollen (`editor`, `admin`) reichen
  für Projekte dieser Größe; alles Feinere kostet mehr Pflege, als es einbringt.
