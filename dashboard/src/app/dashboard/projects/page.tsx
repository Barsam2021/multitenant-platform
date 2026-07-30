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

interface Project {
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  active_container: string | null;
}

export default function ProjectsPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [tariff, setTariff] = useState("starter");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  function load() {
    setTenants(null);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setProjects(d))
      .catch(() => {});
  }

  useEffect(() => {
    load();
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
      load();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(s: string) {
    if (!confirm(`Projekt "${s}" wirklich löschen? DB, Container, App und Bucket werden entfernt.`)) return;
    setDeletingSlug(s);
    try {
      const res = await fetch(`/api/tenants/${s}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Löschen fehlgeschlagen");
        return;
      }
      load();
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeletingSlug(null);
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Projekte</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Abbrechen" : "+ Neues Projekt"}
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
      {!tenants && !error && <div className="empty-state">Lade Projekte…</div>}
      {tenants && tenants.length === 0 && (
        <div className="empty-state">Noch keine Projekte angelegt.</div>
      )}

      <div className="card-grid">
        {tenants?.map((t) => {
          const project = projects.find((p) => p.tenant_slug === t.slug);
          return (
            <div key={t.id} className="card" style={{ position: "relative" }}>
              <Link href={`/dashboard/projects/${t.slug}`}>
                <div className="card-title">{t.slug}</div>
                <div className="card-sub">
                  {project ? project.repo_url || "Repo nicht gesetzt" : "Kein Projekt verbunden"}
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                  <span className="pk-badge">{t.tariff}</span>
                  {project?.active_container && <span className="pk-badge">live</span>}
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
          );
        })}
      </div>
    </div>
  );
}
