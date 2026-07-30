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

// Projekt-ID wird aktuell aus der Deployment-Liste nicht mitgeliefert (Agent kennt
// nur project_id in deployments), daher holen wir sie einmalig über /api/projects.
interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
}

const ACTIVE_STATES = ["queued", "building", "healthchecking"];

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envStatus, setEnvStatus] = useState<string | null>(null);
  const [domainHost, setDomainHost] = useState("");
  const [domainStatus, setDomainStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.slug === slug) : null;
        if (!p) {
          setError("Projekt nicht gefunden");
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
    // Poll alle 3s, solange ein Deployment aktiv ist — Live-Build-Log via Doc 11 § 4 Option A.
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

  async function handleSetEnv(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    if (!/^[A-Z0-9_]+$/.test(envKey)) {
      setEnvStatus("Key: nur A-Z, 0-9, _ erlaubt");
      return;
    }
    setEnvStatus("Speichere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: envValue }),
      });
      const data = await res.json();
      setEnvStatus(res.ok ? "Gespeichert." : data.error || "Fehler");
      if (res.ok) {
        setEnvKey("");
        setEnvValue("");
      }
    } catch {
      setEnvStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleAddDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setDomainStatus("Registriere…");
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, hostname: domainHost }),
      });
      const data = await res.json();
      setDomainStatus(res.ok ? data.instructions || "DNS-Polling gestartet." : data.error || "Fehler");
      if (res.ok) setDomainHost("");
    } catch {
      setDomainStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (error) return <div className="content"><div className="error-box">{error}</div></div>;
  if (!project) return <div className="content"><div className="empty-state">Lade Projekt…</div></div>;

  const latest = deployments[0];

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{project.slug}</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Deployments</h3>
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
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Environment Variables</h3>
        <form onSubmit={handleSetEnv} style={{ display: "flex", gap: 8 }}>
          <input placeholder="KEY" value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} />
          <input placeholder="value" value={envValue} onChange={(e) => setEnvValue(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit">Setzen</button>
        </form>
        {envStatus && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{envStatus}</div>}
      </section>

      <section>
        <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Custom Domain</h3>
        <form onSubmit={handleAddDomain} style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="www.kunde-domain.at"
            value={domainHost}
            onChange={(e) => setDomainHost(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" type="submit">Registrieren</button>
        </form>
        {domainStatus && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{domainStatus}</div>}
      </section>
    </div>
  );
}
