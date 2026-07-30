#!/bin/bash
set -e
cd /opt/multitenant-platform
mkdir -p "dashboard/src/lib"
cat > "dashboard/src/lib/agent.ts" << 'PHASE2_EOF'
const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/provision-tenant"
cat > "dashboard/src/app/api/provision-tenant/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { status, body: result } = await agentFetch("/tenants", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json(result, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]"
cat > "dashboard/src/app/api/tenants/[slug]/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { status, body } = await agentFetch(`/tenants/${slug}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/projects"
cat > "dashboard/src/app/api/projects/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/projects");
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/projects/[id]/env"
cat > "dashboard/src/app/api/projects/[id]/env/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/projects/${id}/env`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/deployments"
cat > "dashboard/src/app/api/deployments/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/deployments", {
    method: "POST",
    body: JSON.stringify({ ...payload, triggeredBy: "manual" }),
  });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/deployments/[id]"
cat > "dashboard/src/app/api/deployments/[id]/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/deployments/${id}`);
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/deployments/[id]/rollback"
cat > "dashboard/src/app/api/deployments/[id]/rollback/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/deployments/${id}/rollback`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/domains"
cat > "dashboard/src/app/api/domains/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/domains", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/api/domains/[id]"
cat > "dashboard/src/app/api/domains/[id]/route.ts" << 'PHASE2_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/domains/${id}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}
PHASE2_EOF
mkdir -p "dashboard/src/app/dashboard/database"
cat > "dashboard/src/app/dashboard/database/page.tsx" << 'PHASE2_EOF'
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  created_at: string;
}

export default function DatabaseOverviewPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [tariff, setTariff] = useState("starter");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  function loadTenants() {
    setTenants(null);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
  }

  useEffect(() => {
    loadTenants();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setFormError("Slug: nur a-z, 0-9, - erlaubt");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const res = await fetch("/api/provision-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantSlug: slug, tenantName: slug, tariff }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Provisioning fehlgeschlagen");
        return;
      }
      setSlug("");
      setShowForm(false);
      loadTenants();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(s: string) {
    if (!confirm(`Tenant "${s}" wirklich löschen? DB, Container und Bucket werden entfernt.`)) return;
    setDeletingSlug(s);
    try {
      const res = await fetch(`/api/tenants/${s}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Löschen fehlgeschlagen");
        return;
      }
      loadTenants();
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeletingSlug(null);
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Datenbanken</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Abbrechen" : "+ Tenant erstellen"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 18,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          <input
            placeholder="slug (z.B. gutshof)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
          />
          <select value={tariff} onChange={(e) => setTariff(e.target.value)}>
            <option value="starter">Starter</option>
            <option value="business">Business</option>
            <option value="premium">Premium</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? "Provisioniere… (~10-15s)" : "Anlegen"}
          </button>
          {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
        </form>
      )}

      {error && <div className="error-box">{error}</div>}
      {!tenants && !error && <div className="empty-state">Lade Tenants…</div>}
      {tenants && tenants.length === 0 && (
        <div className="empty-state">Noch keine Tenants angelegt.</div>
      )}

      <div className="card-grid">
        {tenants?.map((t) => (
          <div key={t.id} className="card" style={{ position: "relative" }}>
            <Link href={`/dashboard/database/${t.slug}`}>
              <div className="card-title">{t.slug}</div>
              <div className="card-sub">{t.db_name}</div>
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                <span className="pk-badge">{t.tariff}</span>
              </div>
            </Link>
            <button
              className="btn"
              style={{ position: "absolute", top: 10, right: 10, color: "var(--danger)" }}
              onClick={(e) => {
                e.preventDefault();
                handleDelete(t.slug);
              }}
              disabled={deletingSlug === t.slug}
            >
              {deletingSlug === t.slug ? "…" : "Löschen"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
PHASE2_EOF
mkdir -p "dashboard/src/app/dashboard/hosting"
cat > "dashboard/src/app/dashboard/hosting/page.tsx" << 'PHASE2_EOF'
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Project {
  id: string;
  tenant_slug: string;
  slug: string;
  repo_url: string;
  default_branch: string;
  active_container: string | null;
  created_at: string;
  tariff: string;
}

interface Tenant {
  slug: string;
}

export default function HostingPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [tenantSlug, setTenantSlug] = useState("");
  const [slug, setSlug] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");

  function loadProjects() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setProjects(d) : setError(d.error || "Fehler")))
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }

  useEffect(() => {
    loadProjects();
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => d.tenants && setTenants(d.tenants));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setFormError("Slug: nur a-z, 0-9, - erlaubt");
      return;
    }
    if (!tenantSlug) {
      setFormError("Tenant (Backend) auswählen — Projekte brauchen aktuell einen bestehenden Tenant");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantSlug, slug, repoUrl, defaultBranch, repoProvider: "github" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Projekt-Erstellung fehlgeschlagen");
        return;
      }
      setSlug("");
      setRepoUrl("");
      setShowForm(false);
      loadProjects();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Hosting</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Abbrechen" : "+ Neues Projekt"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
            marginBottom: 18,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          <select value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} required>
            <option value="">Tenant (Backend) wählen…</option>
            {tenants.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.slug}
              </option>
            ))}
          </select>
          <input
            placeholder="Projekt-Slug (z.B. gutshof-web)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
          />
          <input
            placeholder="Repo-URL (https://github.com/...)"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            style={{ minWidth: 280 }}
            required
          />
          <input
            placeholder="Branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            style={{ width: 90 }}
          />
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? "Anlegen…" : "Anlegen"}
          </button>
          {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
        </form>
      )}

      {error && <div className="error-box">{error}</div>}
      {!projects && !error && <div className="empty-state">Lade Projekte…</div>}
      {projects && projects.length === 0 && (
        <div className="empty-state">Noch keine Projekte angelegt.</div>
      )}

      <div className="card-grid">
        {projects?.map((p) => (
          <Link key={p.id} href={`/dashboard/hosting/${p.slug}`} className="card">
            <div className="card-title">{p.slug}</div>
            <div className="card-sub">{p.repo_url}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
              <span className="pk-badge">{p.tariff}</span>
              <span className="pk-badge">{p.default_branch}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
PHASE2_EOF
mkdir -p "dashboard/src/app/dashboard/hosting/[slug]"
cat > "dashboard/src/app/dashboard/hosting/[slug]/page.tsx" << 'PHASE2_EOF'
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
PHASE2_EOF
echo Alle Dateien geschrieben.
