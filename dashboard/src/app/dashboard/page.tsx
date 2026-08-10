"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Overview {
  summary: {
    tenantCount: number;
    projectCount: number;
    projectsRunning: number;
    projectsFailedLastDeploy: number;
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

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
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

export default function PlatformOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
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
    } catch {
      setCleanupNote("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCleaning(false);
    }
  }

  useEffect(() => {
    load();
    // P3-2: auch hier nur bei sichtbarem Tab weiterpollen.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (error) return <div className="content"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="content"><div className="empty-state">Lade Übersicht…</div></div>;

  const { summary, projects } = data;

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
        </div>
        <div className="card">
          <div className="card-sub">Laufende Container</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{summary.projectsRunning}</div>
        </div>
        <div className="card">
          <div className="card-sub">Letzter Deploy fehlgeschlagen</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: summary.projectsFailedLastDeploy > 0 ? "var(--danger)" : undefined }}>
            {summary.projectsFailedLastDeploy}
          </div>
        </div>
      </div>

      {disk && (
        <div
          style={{
            border: `1px solid ${disk.usedPercent >= 80 ? "var(--danger)" : "var(--border)"}`,
            borderRadius: 8,
            padding: 14,
            marginBottom: 24,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Plattenbelegung (/opt)
              {disk.usedPercent >= 80 && (
                <span style={{ color: "var(--danger)", marginLeft: 8 }}>
                  ⚠ {disk.usedPercent}% belegt — Build-Snapshots/Docker-Images aufräumen
                </span>
              )}
            </span>
            <button className="btn" onClick={handleCleanupNow} disabled={cleaning}>
              {cleaning ? "Räume auf…" : "Jetzt aufräumen"}
            </button>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "var(--panel-raised)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, disk.usedPercent)}%`,
                background: disk.usedPercent >= 80 ? "var(--danger)" : disk.usedPercent >= 60 ? "#e0a340" : "#2da44e",
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
            {formatBytes(disk.usedBytes)} von {formatBytes(disk.totalBytes)} belegt ({disk.usedPercent}%) ·{" "}
            {formatBytes(disk.availableBytes)} frei
          </div>
          {cleanupNote && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>{cleanupNote}</div>}
        </div>
      )}

      {projects.length === 0 && <div className="empty-state">Noch keine Projekte angelegt.</div>}

      {projects.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 10px" }}>Projekt</th>
                <th style={{ padding: "8px 10px" }}>Status</th>
                <th style={{ padding: "8px 10px" }}>CPU</th>
                <th style={{ padding: "8px 10px" }}>RAM</th>
                <th style={{ padding: "8px 10px" }}>Letzter Deploy</th>
                <th style={{ padding: "8px 10px" }}>Domains</th>
                <th style={{ padding: "8px 10px" }}>DB-Verbindungen</th>
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
                  <td style={{ padding: "8px 10px" }}>{p.cpuPerc ?? "–"}</td>
                  <td style={{ padding: "8px 10px" }}>{p.memPerc ?? p.memUsage ?? "–"}</td>
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
                        in Uptime Kuma öffnen
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
