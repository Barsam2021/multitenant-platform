# Betrieb — diagnostizieren, prüfen, reparieren

Dieses Dokument sammelt die Befehle und Zusammenhänge, die im laufenden Betrieb
tatsächlich gebraucht werden. Es ist bewusst nach **Symptom** sortiert, nicht nach
Komponente: im Ernstfall weiß man, was kaputt aussieht, nicht, wo es herkommt.

Alle Befehle laufen auf dem Server, im Repo-Verzeichnis (`/opt/multitenant-platform`).

---

## Einen neuen Stand ausrollen

```bash
./scripts/redeploy.sh <branch>        # ziehen, migrieren, bauen, neu starten
./scripts/redeploy.sh --status        # nur nachsehen, nichts anfassen
./scripts/redeploy.sh --all <branch>  # zusätzlich Traefik/Postgres/MinIO hart neu starten
```

`--all` braucht man nur, wenn sich die **Kommandozeile** eines Infrastruktur-Containers
geändert hat (z. B. ein neues Traefik-Flag). Es kostet einige Sekunden Downtime für
alle Kundenseiten und trennt jede Datenbankverbindung — im Zweifel ohne.

Das Skript bricht ab, wenn das Arbeitsverzeichnis lokale Änderungen hat. Das ist
Absicht: ein Hotfix, der direkt auf dem Server gemacht wurde, soll nicht
stillschweigend verschwinden. Erst ansehen, sichern, dann entscheiden:

```bash
git diff > /root/vps-lokale-aenderungen-$(date +%Y%m%d-%H%M).patch
git --no-pager diff
```

---

## Symptom: Alle Kundenseiten antworten mit 504

Traefik kennt den Router, erreicht den Container aber nicht.

**Häufigste Ursache:** Traefik, der Agent oder MinIO wurden hart neu erstellt
(`--force-recreate`). Diese drei hängen in den Projektnetzen `app-<slug>-net`, und
diese Verbindungen sind reiner Laufzeit-Zustand des Docker-Daemons — sie stehen in
keiner `docker-compose.yml` und überleben ein Neuerstellen nicht.

Der Agent stellt sie bei jedem Start selbst wieder her (`reattachProjectNetworks`).
Wenn es schneller gehen muss:

```bash
for net in $(docker network ls --format '{{.Name}}' | grep '^app-.*-net$'); do
  docker network connect "$net" global-traefik 2>/dev/null
  docker network connect "$net" provisioning-agent 2>/dev/null
  docker network connect "$net" core-minio 2>/dev/null
done
```

Prüfen, wer in einem Netz hängt:

```bash
docker network inspect app-test-net --format '{{range .Containers}}{{.Name}} {{end}}'
```

---

## Symptom: Eine Seite zeigt Inhalte nicht an, die im CMS stehen

Die Kette ist: CMS → Postgres → PostgREST → Kunden-App → Browser-Cache. Von hinten
aufzurollen ist Zeitverschwendung; die Kette hat vier Stellen, an denen sie reißen
kann, und jede hat einen eigenen Test.

**1. Steht die Zeile in der Datenbank?**

```bash
docker exec -i core-postgres psql -U postgres -d kunde_<slug> \
  -c "SELECT * FROM <tabelle> ORDER BY 1 DESC LIMIT 3;"
```

**2. Darf die API sie sehen?** Kundenseiten lesen als Rolle `anon_<slug>`, und die
unterliegt RLS. Zwei getrennte Fragen — Rechte und Policy:

```bash
docker exec -i core-postgres psql -U postgres -d kunde_<slug> -c \
"SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name='<tabelle>';"

docker exec -i core-postgres psql -U postgres -d kunde_<slug> -c \
"SELECT policyname, roles, cmd, qual FROM pg_policies WHERE tablename='<tabelle>';"
```

Typischer Fund: die Policy erlaubt öffentlich nur `published = true`, und der neue
Eintrag steht auf `false`. Ebenso typisch, wenn ein Schema aus einem anderen Projekt
übernommen wurde: die GRANTs stehen auf den Rollen des **falschen** Mandanten
(`anon_s` in der Datenbank von `test`) und sind damit wertlos — Zugang zur Datenbank
hat nur `authenticator_<slug>`.

**3. Liefert PostgREST sie aus?**

```bash
ANON=$(docker exec -i core-postgres psql -U postgres -tAq -d admin_dashboard \
  -c "SELECT anon_jwt FROM kunden WHERE slug='<slug>';")
docker exec provisioning-agent curl -s -m 5 \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "http://api-<slug>:3000/<tabelle>?select=*&limit=3"
```

Antwortet es mit `PGRST205 Could not find the table in the schema cache`, kennt
PostgREST die Tabelle nicht. Es liest das Schema beim Start und zeigt nur, worauf
die verbindende Rolle Rechte hat. Der Agent stößt den Reload nach jeder Änderung
selbst an; von Hand:

```bash
docker kill -s SIGUSR1 api-<slug>
```

`NOTIFY pgrst, 'reload schema'` funktioniert hier **nicht** — PostgREST verbindet
über PgBouncer im Transaction-Mode, und LISTEN/NOTIFY überlebt Transaction-Pooling
nicht.

**4. Zeigt die App den Stand von damals?** Statisch gerenderte Seiten (Next.js ohne
`revalidate`) werden beim Build erzeugt und danach nie wieder. Da der Build **nicht**
im Projektnetz läuft, erreicht er die API nicht — im schlechtesten Fall wird eine
leere Seite eingebacken und bleibt leer, obwohl zur Laufzeit alles erreichbar ist.
Das erklärt Inhalte, die „kurz da waren und wieder weg sind": je nachdem, ob der
jeweilige Build die Datenbank sah.

Test von innen, am Cache vorbei:

```bash
docker exec app-<slug> node -e "
const u=process.env.NEXT_PUBLIC_SUPABASE_URL, k=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
fetch(u+'/<tabelle>?select=id',{headers:{apikey:k,Authorization:'Bearer '+k}})
  .then(r=>r.text()).then(t=>console.log('API:',t)).catch(e=>console.log('FEHLER:',e.message));
"
```

Kommen hier Daten und die Seite bleibt leer, liegt es an der Kunden-App: sie braucht
`export const revalidate = <sekunden>` auf den datengetriebenen Seiten oder einen
Revalidate-Hook.

---

## Symptom: Umgebungsvariable geändert, Container hat den alten Wert

Env-Variablen werden beim **Deploy** in den Container geschrieben, nicht zur Laufzeit
nachgeladen. Nach einer Änderung im Dashboard muss das Projekt neu deployt werden.

Was der laufende Container wirklich hat:

```bash
docker exec app-<slug> printenv NEXT_PUBLIC_SUPABASE_URL
```

Was in der Datenbank steht (Werte sind AES-256-GCM-verschlüsselt):

```bash
docker exec -i core-postgres psql -U postgres -tAq -d admin_dashboard -c \
"SELECT e.key || ' ' || encode(e.value_encrypted,'hex')
 FROM project_env_vars e JOIN projects p ON p.id=e.project_id
 WHERE p.slug='<slug>';" > /tmp/envhex

docker exec -i provisioning-agent node -e '
const c=require("crypto"),fs=require("fs");
const key=Buffer.from(process.env.ENCRYPTION_MASTER_KEY,"hex");
for (const line of fs.readFileSync(0,"utf8").trim().split("\n")) {
  const [k,hex]=line.split(" ");
  const b=Buffer.from(hex,"hex");
  const d=c.createDecipheriv("aes-256-gcm",key,b.subarray(0,12));
  d.setAuthTag(b.subarray(12,28));
  console.log(k,"=",Buffer.concat([d.update(b.subarray(28)),d.final()]).toString("utf8"));
}' < /tmp/envhex
```

Achtung bei `NEXT_PUBLIC_*`: Next.js schreibt diese Werte beim **Build** fest ins
Bundle. Ein geänderter Wert braucht dort einen echten Rebuild, ein Neustart genügt
nicht. Gegenprobe:

```bash
docker exec app-<slug> sh -c "grep -rl 'alter-wert' /app/.next | head"
```

---

## Symptom: Bild-Upload im CMS schlägt fehl

Die Fehlermeldung ist inzwischen verständlich formuliert; der volle Postgres-Fehler
steht im Server-Log:

```bash
docker logs --tail 50 cms
```

Häufigster Fall war eine Sitzung, deren Konto nicht mehr existiert — das CMS prüft
das jetzt bei jedem Aufruf und schickt zur Neuanmeldung. Wer die Konten sehen will:

```bash
docker exec -i core-postgres psql -U postgres -d admin_dashboard -c \
"SELECT tenant_slug, email, disabled, last_login_at FROM cms_users ORDER BY created_at;"
```

---

## Rate-Limits prüfen

Wichtig beim Testen: **sequenzielles `curl` ist zu langsam.** Jeder Aufruf macht
einen TLS-Handshake; 200 Anfragen hintereinander bleiben unter 50/s und lösen nichts
aus. Parallel testen, und immer mit `-m` (Timeout), sonst hängt der Test an einem
kaputten Backend fest:

```bash
seq 1 600 | xargs -P 100 -I{} curl -s -m 5 -o /dev/null -w "%{http_code}\n" \
  https://<host>/ | sort | uniq -c
```

Erwartungswert ausrechnen statt schätzen: bei `average: 20`, `burst: 40` und einem
Durchlauf von 5 Sekunden kommen rund `40 + 20×5 = 140` Anfragen durch, der Rest wird
`429`. Weicht das stark ab, greift die Bremse nicht — und der wahrscheinlichste Grund
ist, dass sie an der falschen Quelle hängt (siehe unten).

Der Login des CMS lässt sich dagegen auch sequenziell testen (10 pro Minute):

```bash
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://cms.<domain>/api/<slug>/login -H 'Content-Type: application/json' \
  -d '{"email":"x@x.de","password":"falsch"}'; done | sort | uniq -c
```

### Warum die Quell-IP hier nicht die Quell-IP ist

Steht Cloudflare vor der Plattform, ist Traefiks TCP-Gegenstelle immer eine
Cloudflare-Edge-IP (`188.114.96.x`, `172.67.x`, `104.16.x`, …). Ein Limit „pro IP"
verteilt sich dann auf Dutzende Edges und greift praktisch nie. Deshalb schlüsseln
die Middlewares auf den Header `Cf-Connecting-Ip`, und die Besucherstatistik nimmt
denselben Header aus dem Accesslog.

Prüfen, was Traefik tatsächlich sieht:

```bash
dig +short <host>
docker logs --since 2m global-traefik 2>&1 | grep -o '"ClientAddr":"[^"]*"' | sort -u | head
```

---

## Traefik: Router und Middlewares

Die dynamische Konfiguration liegt unter `traefik/dynamic/` und ist **nicht**
versioniert — sie wird erzeugt:

| Datei | Erzeugt von |
|---|---|
| `aa-rate-limit.yml` | `scripts/write-ratelimit.sh` (vor dem Traefik-Start) und der Agent bei jedem Start |
| `media.yml` | `scripts/redeploy.sh --init-cms` |
| `custom-<projekt>-<host>.yml` | Agent beim Anlegen/Prüfen einer Custom-Domain |
| `tenant-postgrest-<slug>.yml`, `tenant-auth-<slug>.yml` | Agent beim Freischalten der öffentlichen API |

Der Agent schreibt die Router bei jedem Start neu, nicht nur wenn eine Datei fehlt:
eine vorhandene Datei mit veraltetem Inhalt sieht man ihr sonst nicht an.

Fehlt einem Router eine Middleware, die er referenziert, **verwirft Traefik den
Router komplett** — die Seite ist dann offline, nicht ungebremst. Deshalb hängen die
Bremsen an den einzelnen Routern und nicht am Entrypoint: der Fehlerfall ist so
„keine Bremse" statt „alles tot".

```bash
grep -L middlewares traefik/dynamic/*.yml          # Router ohne Bremse
docker logs --tail 50 global-traefik 2>&1 | grep -i "does not exist"
```

Vorschau-Domains bekommen ihre Middleware über Docker-Labels, also erst beim
nächsten Deploy des Projekts:

```bash
docker inspect app-<slug> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -i middleware
```

---

## Ressourcen: wer verbraucht was

Die Übersichtsseite des Dashboards beantwortet das grafisch. Auf der Kommandozeile:

```bash
# Zugesagte Limits je Container
docker ps -q | xargs docker inspect \
  --format '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' \
  | sed 's|^/||' \
  | awk '{printf "%-28s %10s MB  %6.2f CPU\n", $1, ($2==0?"kein Limit":$2/1048576), $3/1e9}' \
  | sort -k2 -h

# Tatsächliche Belegung
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
```

`0` heißt kein Limit — der Container darf sich den ganzen Host nehmen. Die Summe
aller Limits darf über dem vorhandenen RAM liegen; das ist eine Obergrenze, keine
Reservierung.

Verwaiste Container (laufen, gehören zu keinem Projekt mehr) zeigt das Dashboard mit
Aufräum-Knopf. Zum Gegenprüfen:

```bash
docker exec -i core-postgres psql -U postgres -tAq -d admin_dashboard -c "SELECT slug FROM projects;"
docker ps --format '{{.Names}}' | grep '^app-'
```

---

## Migrationen

```bash
./scripts/migrate.sh                              # fehlende einspielen
docker exec -i core-postgres psql -U postgres -tAq -d postgres \
  -c "SELECT count(*) FROM public.schema_migrations;"
ls core-postgres/init-scripts/*.sql | wc -l
```

Die beiden Zahlen müssen übereinstimmen. Die `init-scripts` laufen **nicht**
automatisch — Postgres führt sie nur bei einem leeren Datenverzeichnis aus, in einer
laufenden Installation macht das `migrate.sh`.

---

## Backups

```bash
./backups/backup-script.sh                      # von Hand auslösen
./backups/restore-script.sh list                # was liegt im Object Storage
./backups/restore-test-script.sh <datei.age>    # in eine Wegwerf-Datenbank zurückspielen
./backups/restore-script.sh db <datei.age>      # ECHTER Restore, überschreibt Daten
```

Ein Backup, das nie zurückgespielt wurde, ist kein Backup. Der Restore-Test läuft
deshalb automatisch: der Agent nimmt wöchentlich die Datenbank, die am längsten
nicht geprüft wurde, und schreibt das Ergebnis als eigene Zeile in die
`backups`-Tabelle (`restore_test_ok` / `restore_test_failed`). Im Dashboard steht
es unter „Backups" zwischen den Sicherungen, chronologisch an der richtigen Stelle.

Für die Aufbewahrung beim Anbieter gibt es zwei Modelle, umgeschaltet über
`BACKUP_RETENTION_MODE`:

- **`generations`** (Standard) — `daily/` (7 Tage), `weekly/` sonntags
  (28 Tage), `monthly/` am Monatsersten (180 Tage). Lange Rückschau, wächst
  mit der Zeit. Für bezahlten Speicher.
- **`count`** — die letzten `BACKUP_KEEP_RUNS` Läufe, hart gedeckelt durch
  `BACKUP_MAX_TOTAL_BYTES`. Für ein festes Gratiskontingent. Der Lauf wird
  erst vollständig lokal erzeugt und gemessen, dann wird aufgeräumt, dann
  hochgeladen — die Grenze wird deshalb auch während des Uploads nie
  überschritten. Gelöscht wird immer ein vollständiger Lauf, nie eine einzelne
  Datei. Passt der neue Lauf nicht einmal allein ins Budget, bleibt der
  Bestand unangetastet und es gibt einen Alarm.

Beim Restore genügt in beiden Fällen der reine Dateiname; das Skript sucht ihn
in allen Ordnern.

Der Agent überwacht das Ganze täglich und alarmiert per Mail, wenn

- seit über 36 h kein erfolgreiches Backup gelaufen ist (auch dann, wenn der Cron
  gar nicht erst startet — vorher war Stille von Erfolg nicht zu unterscheiden),
- einzelne Datenbanken kein frisches Backup haben, während der Rest durchläuft,
- die age-Identity fehlt oder die DR-Bundle-Bestätigung veraltet ist,
- ein automatischer Restore-Test fehlschlägt.

Der Bestand beim Anbieter steht im Dashboard über der Liste; er kommt direkt aus
`rclone` und nicht aus der `backups`-Tabelle. Das ist Absicht: nach einem
Serververlust ist die Tabelle selbst weg, und dann zählt nur, was beim Anbieter
liegt.

Der wichtigste Satz zum Thema steht in [SETUP.md](../SETUP.md): ohne Off-Site-Kopie
des age-Keys **und** der `.env` sind die Dateien im Object Storage unlesbare Bytes.
Beide liegen sonst ausschließlich auf dem Server, gegen dessen Verlust gesichert wird.

Noch gar nichts eingerichtet? Schritt-für-Schritt von null bis zur ersten
geprüften Off-Site-Sicherung: [BACKUP-EINRICHTEN.md](BACKUP-EINRICHTEN.md).
Abnahme in neun Tests — inklusive der Kniffe, mit denen sich die
zeitgesteuerten Alarme sofort auslösen lassen:
[BACKUP-TESTPLAN.md](BACKUP-TESTPLAN.md).

Wie dieser Stand zustande kam, welche Fehler dabei gefunden wurden und was
bewusst offen blieb: [BACKUP-PLAN.md](BACKUP-PLAN.md).

---

## Versionen & CVEs

Noch nicht umgesetzt. Der Entwurf für die Versionsübersicht aller Plattform-Container
und gehosteten Projekte samt täglichem Schwachstellen-Scan steht in
[CVE-PLAN.md](CVE-PLAN.md).
