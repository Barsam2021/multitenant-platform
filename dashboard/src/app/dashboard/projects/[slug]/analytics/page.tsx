"use client";

import { useCallback, useEffect, useState, use } from "react";
import { useProject } from "@/components/ProjectContext";

interface SeriesPoint {
  day: string;
  views: number;
  uniqueVisitors: number;
}

interface AnalyticsData {
  days: number;
  host: string | null;
  totals: { views: number; uniqueVisitors: number };
  series: SeriesPoint[];
  topPaths: { path: string; views: number }[];
  topReferrers: { referrer: string; views: number }[];
  hosts: { hostname: string; views: number; uniqueVisitors: number }[];
  ingest: { lastRunAt: string | null; lastError: string | null; linesIngested: number } | null;
}

const RANGES = [
  { days: 7, label: "7 Tage" },
  { days: 30, label: "30 Tage" },
  { days: 90, label: "90 Tage" },
];

function formatNumber(n: number): string {
  return n.toLocaleString("de-DE");
}

function formatDay(day: string): string {
  const [, month, dayOfMonth] = day.split("-");
  return `${dayOfMonth}.${month}.`;
}

/**
 * Tagesverlauf als Balken. Bewusst eine einzige Serie (Aufrufe): zwei
 * Messreihen in einem Diagramm brauchen eine Legende und lenken von der
 * eigentlichen Frage ab — "waren gestern mehr Leute da als vorgestern".
 * Die Unique-Zahl steht als eigene Kennzahl oben und im Tooltip.
 */
function ViewsChart({ series }: { series: SeriesPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((p) => p.views));
  const point = hovered !== null ? series[hovered] : null;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Aufrufe pro Tag</span>
        <span style={{ fontSize: 12, color: "var(--text-dim)", minHeight: 16 }}>
          {point
            ? `${new Date(point.day).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })} · ${formatNumber(point.views)} Aufrufe · ${formatNumber(point.uniqueVisitors)} Besucher`
            : `Spitzenwert ${formatNumber(max)}`}
        </span>
      </div>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 140 }}
        onMouseLeave={() => setHovered(null)}
      >
        {series.map((p, i) => (
          <div
            key={p.day}
            onMouseEnter={() => setHovered(i)}
            title={`${p.day}: ${formatNumber(p.views)} Aufrufe, ${formatNumber(p.uniqueVisitors)} Besucher`}
            style={{
              flex: 1,
              height: "100%",
              display: "flex",
              alignItems: "flex-end",
              cursor: "default",
            }}
          >
            <div
              style={{
                width: "100%",
                // Immer sichtbare Grundlinie: ein Tag mit 0 Aufrufen soll als
                // leerer Tag lesbar sein, nicht als fehlender Balken.
                height: `${Math.max(2, (p.views / max) * 100)}%`,
                background: hovered === i ? "var(--text)" : "var(--accent)",
                opacity: p.views === 0 ? 0.25 : 1,
                borderRadius: "4px 4px 0 0",
                transition: "background 120ms",
              }}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 11,
          color: "var(--text-faint)",
          borderTop: "1px solid var(--border)",
          paddingTop: 4,
        }}
      >
        <span>{series.length > 0 && formatDay(series[0].day)}</span>
        <span>{series.length > 0 && formatDay(series[series.length - 1].day)}</span>
      </div>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        flex: "1 1 200px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        background: "var(--panel)",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function RankedList({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: { label: string; views: number }[];
  emptyLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <div style={{ flex: "1 1 320px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{emptyLabel}</div>}
      {rows.map((r) => (
        <div key={r.label} style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, gap: 12 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{formatNumber(r.views)}</span>
          </div>
          <div style={{ height: 4, background: "var(--border)", borderRadius: 2, marginTop: 3 }}>
            <div style={{ height: "100%", width: `${(r.views / max) * 100}%`, background: "var(--accent)", borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage({ params }: { params: Promise<{ slug: string }> }) {
  use(params);
  const { project, error: projectError } = useProject();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [days, setDays] = useState(30);
  const [host, setHost] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (projectId: string) => {
      setLoading(true);
      const query = new URLSearchParams({ days: String(days) });
      if (host) query.set("host", host);
      fetch(`/api/projects/${projectId}/analytics?${query.toString()}`)
        .then((r) => r.json())
        .then((d) => (d?.error ? setError(d.error) : (setData(d), setError(null))))
        .catch(() => setError("Statistik konnte nicht geladen werden"))
        .finally(() => setLoading(false));
    },
    [days, host]
  );

  useEffect(() => {
    if (!project) return;
    load(project.id);
  }, [project, load]);

  if (!project) return <div className="empty-state">{projectError || "Kein Projekt verbunden."}</div>;

  const hasData = !!data && data.totals.views > 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Besucher</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data && data.hosts.length > 1 && (
            <select value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">Alle Domains</option>
              {data.hosts.map((h) => (
                <option key={h.hostname} value={h.hostname}>
                  {h.hostname}
                </option>
              ))}
            </select>
          )}
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={days === r.days ? "btn btn-primary" : "btn"}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <StatTile label="Aufrufe" value={formatNumber(data.totals.views)} hint={`Letzte ${days} Tage`} />
            <StatTile
              label="Besucher"
              value={formatNumber(data.totals.uniqueVisitors)}
              // Ohne diesen Hinweis wird die Zahl zwangslaeufig falsch gelesen.
              // Die Zaehlung ist cookiefrei und der Besucher-Hash wechselt
              // taeglich (siehe lib/analytics.ts) — ueber einen Zeitraum werden
              // also Tageswerte summiert.
              hint="Summe der Tageswerte, cookiefrei gezählt"
            />
            <StatTile
              label="Aufrufe je Besucher"
              value={
                data.totals.uniqueVisitors > 0
                  ? (data.totals.views / data.totals.uniqueVisitors).toFixed(1)
                  : "—"
              }
            />
          </div>

          <ViewsChart series={data.series} />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <RankedList
              title="Meistbesuchte Seiten"
              rows={data.topPaths.map((p) => ({ label: p.path, views: p.views }))}
              emptyLabel="Noch keine Seitenaufrufe erfasst."
            />
            <RankedList
              title="Herkunft"
              rows={data.topReferrers.map((r) => ({ label: r.referrer, views: r.views }))}
              emptyLabel="Alle Besucher kamen direkt (kein Verweis von anderen Seiten)."
            />
          </div>

          {data.hosts.length > 0 && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", padding: 14, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Domains</div>
              {data.hosts.map((h) => (
                <div key={h.hostname} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                  <span>{h.hostname}</span>
                  <span style={{ color: "var(--text-dim)" }}>
                    {formatNumber(h.views)} Aufrufe · {formatNumber(h.uniqueVisitors)} Besucher
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Eine leere Statistik hat zwei sehr verschiedene Ursachen — ohne
              diesen Block sieht beides gleich aus. */}
          {!hasData && !loading && (
            <div className="empty-state">
              {data.ingest?.lastError
                ? `Auswertung gestört: ${data.ingest.lastError}`
                : data.ingest?.lastRunAt
                  ? "Noch keine Besuche in diesem Zeitraum erfasst."
                  : "Es wurde noch nie ein Traefik-Accesslog eingelesen. Läuft Traefik mit --accesslog (siehe traefik/docker-compose.yml)?"}
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
            Gezählt werden Seitenaufrufe am Reverse Proxy — ohne Cookies, ohne gespeicherte IP-Adressen.
            Assets (Bilder, JS, CSS), bekannte Bots und die eigene Uptime-Überwachung sind ausgenommen.
            {data.ingest?.lastRunAt && (
              <> Zuletzt eingelesen: {new Date(data.ingest.lastRunAt).toLocaleString("de-DE")}.</>
            )}
          </div>
        </>
      )}
    </div>
  );
}
