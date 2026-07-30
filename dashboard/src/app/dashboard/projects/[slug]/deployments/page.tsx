"use client";

import { useEffect, useState, use, useCallback } from "react";

interface Deployment {
  id: string;
  commit_sha: string | null;
  status: string;
  container_name: string | null;
  image_tag: string | null;
  triggered_by: string;
  created_at: string;
  finished_at: string | null;
  build_log: string;
}

interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
}

const ACTIVE_STATES = ["queued", "building", "healthchecking"];

const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
};

function duration(start: string, end: string | null): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.max(0, Math.round((e - s) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function DeploymentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        if (!p) {
          setError("Kein Projekt verbunden — siehe Übersicht-Tab.");
          return;
        }
        setProject(p);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, [slug]);

  const loadDeployments = useCallback((projectId: string) => {
    fetch(`/api/deployments/${projectId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setDeployments(d))
      .catch(() => setError("Deployment-Historie konnte nicht geladen werden"));
  }, []);

  useEffect(() => {
    if (!project) return;
    loadDeployments(project.id);
    const interval = setInterval(() => {
      setDeployments((current) => {
        if (current.some((d) => ACTIVE_STATES.includes(d.status))) {
          loadDeployments(project.id);
        }
        return current;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [project, loadDeployments]);

  function toggleLogs(id: string) {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    setError(null);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Deploy fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!project) return;
    if (!confirm("Auf dieses Deployment zurückrollen?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Rollback fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">{error || "Lade…"}</div>;

  const latest = deployments[0];

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Deployments</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      {deployments.length === 0 && <div className="empty-state">Noch kein Deployment.</div>}
      {deployments.map((d) => {
        const logsOpen = openLogs.has(d.id);
        return (
          <div
            key={d.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[d.status] || "var(--text-dim)",
                  }}
                />
                <span className="pk-badge">{d.status}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {d.commit_sha?.slice(0, 7) || "—"} · {d.triggered_by} ·{" "}
                  {new Date(d.created_at).toLocaleString("de-DE")} ·{" "}
                  {duration(d.created_at, d.finished_at)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {d.build_log && (
                  <button className="btn" onClick={() => toggleLogs(d.id)}>
                    {logsOpen ? "Logs verbergen" : "Logs anzeigen"}
                  </button>
                )}
                {d.status === "deployed" && d.id !== latest?.id && (
                  <button className="btn" onClick={() => handleRollback(d.id)}>
                    Rollback hierauf
                  </button>
                )}
              </div>
            </div>
            {logsOpen && d.build_log && (
              <pre
                style={{
                  marginTop: 8,
                  maxHeight: 300,
                  overflowY: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  background: "var(--bg)",
                  padding: 8,
                  borderRadius: 6,
                  whiteSpace: "pre-wrap",
                }}
              >
                {d.build_log}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
