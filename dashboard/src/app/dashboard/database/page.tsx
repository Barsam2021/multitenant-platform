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
