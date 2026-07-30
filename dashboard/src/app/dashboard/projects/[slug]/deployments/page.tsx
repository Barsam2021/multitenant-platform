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

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Deploy fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!project) return;
    if (!confirm("Auf dieses Deployment zurückrollen?")) return;
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Rollback fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (error) return <div className="error-box">{error}</div>;
  if (!project) return <div className="empty-state">Lade…</div>;

  const latest = deployments[0];

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Deployments</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      {deployments.length === 0 && <div className="empty-state">Noch kein Deployment.</div>}
      {deployments.map((d) => (
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
            <div>
              <span className="pk-badge">{d.status}</span>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                {d.commit_sha?.slice(0, 7) || "—"} · {d.triggered_by} ·{" "}
                {new Date(d.created_at).toLocaleString("de-DE")}
              </span>
            </div>
            {d.status === "deployed" && d.id !== latest?.id && (
              <button className="btn" onClick={() => handleRollback(d.id)}>
                Rollback hierauf
              </button>
            )}
          </div>
          {ACTIVE_STATES.includes(d.status) && d.build_log && (
            <pre
              style={{
                marginTop: 8,
                maxHeight: 200,
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
      ))}
    </div>
  );
}
