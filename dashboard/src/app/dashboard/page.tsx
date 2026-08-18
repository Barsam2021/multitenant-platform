"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Overview {
  summary: {
    tenantCount: number;
    projectCount: number;
    projectsRunning: number;
    projectsFailedLastDeploy: number;
    views30d: number;
    uniqueVisitors30d: number;
    memory: {
      hostTotalBytes: number | null;
      hostUsedBytes: number | null;
      hostAvailableBytes: number | null;
      containerUsedBytes: number;
      committedBytes: number;
      containerCount: number;
    };
  };
  projects: ProjectStat[];
}

interface ProjectStat {
  id: string;
  slug: string;
  tenantSlug: string;
  tariff: string;
  activeContainer: string | null;
  cpuPerc: string | null;
  memUsage: string | null;
  memPerc: string | null;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  memFreeBytes: number | null;
  views30d: number;
  uniqueVisitors30d: number;
  lastDeployment: { status: string; finishedAt: string | null; createdAt: string } | null;
  domains: Record<string, number>;
  dbConnections: number;
  kumaMonitorId: number | null;
  kumaUrl: string | null;
}

interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

interface StorageBreakdown {
  disk: DiskUsage | null;
  tenants: {
    slug: string;
    projects: string[];
    databaseBytes: number | null;
    storageBytes: number | null;
    buildBytes: number;
    totalBytes: number;
  }[];
  totals: { databaseBytes: number; storageBytes: number; buildBytes: number };
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "–";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("de-DE");
}

// Gleiche Konvention wie projects/[slug]/deployments/page.tsx.
const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
  cancelled: "var(--text-dim)",
};

const DOMAIN_STATUS_LABEL: Record<string, string> = {
  live: "live",
  tls_pending: "TLS ausstehend",
  dns_ok: "DNS ok",
  pending_dns: "DNS ausstehend",
  failed: "fehlgeschlagen",
  unknown: "unbekannt",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "–";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function barColor(percent: number): string {
  return percent >= 80 ? "var(--danger)" : percent >= 60 ? "#e0a340" : "#2da44e";
}

/** Balken mit absoluten Zahlen daneben — der Prozentwert allein sagt nicht, wovon. */
function UsageBar({ usedBytes, totalBytes }: { usedBytes: number; totalBytes: number }) {
  const percent = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
  return (
    <div style={{ height: 8, borderRadius: 4, background: "var(--panel-raised)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${percent}%`, background: barColor(percent) }} />
    </div>
  );
}

export default function PlatformOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);

  function load() {
    fetch("/api/stats/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
    // P3-6: eigener, leichtgewichtiger Request statt Teil von /stats/overview -
    // df blockiert diesen sonst mit.
    fetch("/api/stats/disk")
      .then((r) => r.json())
      .then((d) => !d.error && setDisk(d))
      .catch(() => {});
  }

  // Getrennt vom 30s-Poll: du ueber die Build-Verzeichnisse und mc du ueber die
  // Buckets dauern spuerbar laenger, und die Zahlen aendern sich nur bei einem
  // Deploy oder einem Upload — alle 30 Sekunden waere reine Last.
  function loadStorage() {
    fetch("/api/stats/storage")
      .then((r) => r.json())
      .then((d) => !d.error && setStorage(d))
      .catch(() => {});
  }

  async function handleCleanupNow() {
    setCleaning(true);
    setCleanupNote(null);
    try {
      const res = await fetch("/api/cleanup/run", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        setCleanupNote(d.error || "Aufräumen fehlgeschlagen");
        return;
      }
      setCleanupNote(
        `${d.snapshots?.removed?.length ?? 0} Build-Snapshots, ${d.images?.removed?.length ?? 0} Docker-Images entfernt (${formatBytes(d.snapshots?.freedBytes ?? 0)} freigegeben).`
      );
      load();
      loadStorage();
    } catch {
      setCleanupNote("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    load();
    loadStorage();
    // P3-2: auch hier nur bei sichtbarem Tab weiterpollen.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    const storageInterval = setInterval(() => {
      if (document.visibilityState === "visible") loadStorage();
    }, 300_000);
    return () => {
      clearInterval(interval);
      clearInterval(storageInterval);
    };
  }, []);

  if (error) return <div className="content"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="content"><div className="empty-state">Lade Übersicht…</div></div>;

  const { summary, projects } = data;
  const mem = summary.memory;
  const effectiveDisk = storage?.disk ?? disk;

  // Projekte mit den meisten Aufrufen zuerst — die Frage "wer erzeugt die Last"
  // beantwortet eine nach Anlagedatum sortierte Liste nicht.
  const byViews = [...projects].filter((p) => p.views30d > 0).sort((a, b) => b.views30d - a.views30d);

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Plattform-Übersicht</h2>
      </div>

      <div className="card-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-sub">Kunden</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.tenantCount}</div>
        </div>
        <div className="card">
          <div className="card-sub">Projekte</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectCount}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{summary.projectsRunning} mit laufendem Container</div>
        </div>
        <div className="card">
          <div className="card-sub">Aufrufe (30 Tage)</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{formatNumber(summary.views30d)}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatNumber(summary.uniqueVisitors30d)} eindeutige Besucher
          </div>
        </div>
        <div className="card">
          <div className="card-sub">Letzter Deploy fehlgeschlagen</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: summary.projectsFailedLastDeploy > 0 ? "var(--danger)" : undefined }}>
            {summary.projectsFailedLastDeploy}
          </div>
        </div>
      </div>

      {/* Arbeitsspeicher: belegt, reserviert, frei — in Zahlen, nicht in Prozent
          von etwas Ungenanntem. */}
      {mem.hostTotalBytes !== null && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 16, background: "var(--panel)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Arbeitsspeicher</div>
          <UsageBar usedBytes={mem.hostUsedBytes ?? 0} totalBytes={mem.hostTotalBytes} />
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            <span>
              Gesamt <strong style={{ color: "var(--text)" }}>{formatBytes(mem.hostTotalBytes)}</strong>
            </span>
            <span>
              Belegt <strong style={{ color: "var(--text)" }}>{formatBytes(mem.hostUsedBytes)}</strong>
            </span>
            <span>
              Frei <strong style={{ color: "var(--text)" }}>{formatBytes(mem.hostAvailableBytes)}</strong>
            </span>
            <span>
              Davon in {mem.containerCount} Containern{" "}
              <strong style={{ color: "var(--text)" }}>{formatBytes(mem.containerUsedBytes)}</strong>
            </span>
            <span title="Summe der mem_limits aller Container — so viel ist zugesagt, unabhängig davon, was gerade benutzt wird.">
              Zugesagt <strong style={{ color: "var(--text)" }}>{formatBytes(mem.committedBytes)}</strong>
              {mem.committedBytes > mem.hostTotalBytes && (
                <span style={{ color: "var(--danger)" }}> · überbucht</span>
              )}
            </span>
          </div>
        </div>
      )}

      {effectiveDisk && (
        <div
          style={{
            border: `1px solid ${effectiveDisk.usedPercent >= 80 ? "var(--danger)" : "var(--border)"}`,
            borderRadius: 8,
            padding: 14,
            marginBottom: 24,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Plattenbelegung (/opt)
              {effectiveDisk.usedPercent >= 80 && (
                <span style={{ color: "var(--danger)", marginLeft: 8 }}>
                  ⚠ Build-Snapshots/Docker-Images aufräumen
                </span>
              )}
            </span>
            <button className="btn" onClick={handleCleanupNow} disabled={cleaning}>
              {cleaning ? "Räume auf…" : "Jetzt aufräumen"}
            </button>
          </div>
          <UsageBar usedBytes={effectiveDisk.usedBytes} totalBytes={effectiveDisk.totalBytes} />
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            <span>
              Gesamt <strong style={{ color: "var(--text)" }}>{formatBytes(effectiveDisk.totalBytes)}</strong>
            </span>
            <span>
              Belegt <strong style={{ color: "var(--text)" }}>{formatBytes(effectiveDisk.usedBytes)}</strong>
            </span>
            <span>
              Frei <strong style={{ color: "var(--text)" }}>{formatBytes(effectiveDisk.availableBytes)}</strong>
            </span>
            {storage && (
              <>
                <span>
                  Datenbanken <strong style={{ color: "var(--text)" }}>{formatBytes(storage.totals.databaseBytes)}</strong>
                </span>
                <span>
                  Dateien <strong style={{ color: "var(--text)" }}>{formatBytes(storage.totals.storageBytes)}</strong>
                </span>
                <span>
                  Builds <strong style={{ color: "var(--text)" }}>{formatBytes(storage.totals.buildBytes)}</strong>
                </span>
              </>
            )}
          </div>
          {cleanupNote && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>{cleanupNote}</div>}
        </div>
      )}

      {/* Wer belegt wie viel Platte — aufgeschluesselt, weil "4 GB" ohne die
          Aufteilung keine Entscheidung erlaubt. */}
      {storage && storage.tenants.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Speicherplatz je Kunde</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "8px 10px" }}>Kunde</th>
                  <th style={{ padding: "8px 10px" }}>Datenbank</th>
                  <th style={{ padding: "8px 10px" }}>Dateien</th>
                  <th style={{ padding: "8px 10px" }}>Build-Snapshots</th>
                  <th style={{ padding: "8px 10px" }}>Gesamt</th>
                </tr>
              </thead>
              <tbody>
                {storage.tenants.map((t) => (
                  <tr key={t.slug} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 10px" }}>
                      <Link href={`/dashboard/projects/${t.slug}`} style={{ color: "var(--accent)" }}>
                        {t.slug}
                      </Link>
                      {t.projects.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t.projects.join(", ")}</div>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px" }}>{formatBytes(t.databaseBytes)}</td>
                    <td style={{ padding: "8px 10px" }}>{formatBytes(t.storageBytes)}</td>
                    <td style={{ padding: "8px 10px" }}>{formatBytes(t.buildBytes)}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{formatBytes(t.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {byViews.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Meiste Aufrufe (30 Tage)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "8px 10px" }}>Projekt</th>
                  <th style={{ padding: "8px 10px" }}>Aufrufe</th>
                  <th style={{ padding: "8px 10px" }}>Eindeutige Besucher</th>
                  <th style={{ padding: "8px 10px" }}>Anteil</th>
                </tr>
              </thead>
              <tbody>
                {byViews.slice(0, 10).map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 10px" }}>
                      <Link href={`/dashboard/projects/${p.tenantSlug}/analytics`} style={{ color: "var(--accent)" }}>
                        {p.slug}
                      </Link>
                    </td>
                    <td style={{ padding: "8px 10px" }}>{formatNumber(p.views30d)}</td>
                    <td style={{ padding: "8px 10px" }}>{formatNumber(p.uniqueVisitors30d)}</td>
                    <td style={{ padding: "8px 10px", color: "var(--text-dim)" }}>
                      {summary.views30d > 0 ? `${Math.round((p.views30d / summary.views30d) * 100)} %` : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {projects.length === 0 && <div className="empty-state">Noch keine Projekte angelegt.</div>}

      {projects.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Projekte</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 10px" }}>Projekt</th>
                <th style={{ padding: "8px 10px" }}>Status</th>
                <th style={{ padding: "8px 10px" }}>CPU</th>
                <th style={{ padding: "8px 10px" }}>RAM belegt</th>
                <th style={{ padding: "8px 10px" }}>RAM zugesagt</th>
                <th style={{ padding: "8px 10px" }}>RAM ungenutzt</th>
                <th style={{ padding: "8px 10px" }}>Aufrufe 30T</th>
                <th style={{ padding: "8px 10px" }}>Letzter Deploy</th>
                <th style={{ padding: "8px 10px" }}>Domains</th>
                <th style={{ padding: "8px 10px" }}>DB-Verb.</th>
                <th style={{ padding: "8px 10px" }}>Monitoring</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 10px" }}>
                    <Link href={`/dashboard/projects/${p.tenantSlug}`} style={{ color: "var(--accent)" }}>
                      {p.slug}
                    </Link>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.tariff}</div>
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.activeContainer ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#2da44e" }} />
                        live
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Container</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.cpuPercent !== null ? `${p.cpuPercent} %` : "–"}</td>
                  <td style={{ padding: "8px 10px" }}>{formatBytes(p.memUsedBytes)}</td>
                  <td style={{ padding: "8px 10px" }}>{formatBytes(p.memLimitBytes)}</td>
                  <td style={{ padding: "8px 10px", color: "var(--text-dim)" }}>{formatBytes(p.memFreeBytes)}</td>
                  <td style={{ padding: "8px 10px" }}>{formatNumber(p.views30d)}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.lastDeployment ? (
                      <span>
                        <span style={{ color: STATUS_COLOR[p.lastDeployment.status] || "var(--text-dim)" }}>
                          {p.lastDeployment.status}
                        </span>
                        <span style={{ color: "var(--text-dim)" }}> · vor {timeAgo(p.lastDeployment.finishedAt || p.lastDeployment.createdAt)}</span>
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>noch nie</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {Object.entries(p.domains).length === 0 && <span style={{ color: "var(--text-dim)" }}>–</span>}
                    {Object.entries(p.domains).map(([status, n]) => (
                      <span key={status} className="pk-badge" style={{ marginRight: 4 }}>
                        {n}× {DOMAIN_STATUS_LABEL[status] || status}
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.dbConnections}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.kumaUrl ? (
                      <a href={p.kumaUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                        Uptime Kuma
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>kein Monitor</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
