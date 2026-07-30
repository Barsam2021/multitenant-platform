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
