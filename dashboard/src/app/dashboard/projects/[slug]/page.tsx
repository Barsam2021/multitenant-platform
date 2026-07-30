"use client";

import { useEffect, useState, use } from "react";

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
}

interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  default_branch: string;
  active_container: string | null;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [previewHostname, setPreviewHostname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [webhookNote, setWebhookNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => {
        const t = d.tenants?.find((x: Tenant) => x.slug === slug);
        if (!t) setError("Projekt nicht gefunden");
        else setTenant(t);
      });
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => {
        const p = Array.isArray(list) ? list.find((x: Project) => x.tenant_slug === slug) : null;
        setProject(p || null);
        setPreviewHostname(p?.preview_hostname || null);
        setLoading(false);
      });
  }, [slug]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: slug,
          slug,
          repoUrl,
          defaultBranch,
          repoProvider: "github",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || "Verbinden fehlgeschlagen");
        return;
      }
      setProject(data.project);
      setPreviewHostname(data.previewHostname || null);
      setWebhookNote(
        data.githubWebhook?.registered
          ? "GitHub-Webhook automatisch registriert — Push auf den Branch löst künftig einen Deploy aus."
          : `Webhook nicht automatisch registriert (${data.githubWebhook?.reason || "unbekannt"}). Manuell nachtragen: ${data.webhookUrl}`
      );
    } catch {
      setConnectError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setConnecting(false);
    }
  }

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
      if (!res.ok) alert(data.error || "Deploy fehlgeschlagen");
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  if (loading) return <div className="empty-state">Lade…</div>;
  if (error) return <div className="error-box">{error}</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{slug}</h2>
      {tenant && (
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 20 }}>
          {tenant.db_name} · Tarif {tenant.tariff}
        </div>
      )}

      {!project && (
        <form
          onSubmit={handleConnect}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          <input
            placeholder="Repo-URL (https://github.com/...)"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            style={{ minWidth: 320 }}
            required
          />
          <input
            placeholder="Branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            style={{ width: 100 }}
          />
          <button className="btn btn-primary" type="submit" disabled={connecting}>
            {connecting ? "Verbinde…" : "Projekt verbinden"}
          </button>
          {connectError && <span style={{ color: "var(--danger)" }}>{connectError}</span>}
        </form>
      )}

      {project && (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
              {deploying ? "Löse aus…" : "Deploy"}
            </button>
            {project.active_container && <span className="pk-badge">live: {project.active_container}</span>}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            Repo: {project.repo_url} ({project.default_branch})
          </div>
          {previewHostname && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Preview:{" "}
              <a href={`https://${previewHostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {previewHostname}
              </a>
            </div>
          )}
          {webhookNote && (
            <div style={{ fontSize: 12, marginTop: 10, color: "var(--text-dim)" }}>{webhookNote}</div>
          )}
        </div>
      )}
    </div>
  );
}
