"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";

interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  status: string;
  notes: string | null;
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
  const [displayName, setDisplayName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [tariff, setTariff] = useState("starter");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Tenant | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ tenant: Tenant; next: string } | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const toast = useToast();

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

  const filteredTenants = useMemo(() => {
    if (!tenants) return null;
    const q = search.trim().toLowerCase();
    if (!q) return tenants;
    // P2-6: Suche ueber Name UND Slug - bei fuenfzig Kunden ist der Slug allein
    // nicht mehr die zuverlaessigste Art, jemanden wiederzufinden.
    return tenants.filter(
      (t) => t.slug.toLowerCase().includes(q) || (t.display_name || "").toLowerCase().includes(q)
    );
  }, [tenants, search]);

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
        body: JSON.stringify({
          tenantSlug: slug,
          tariff,
          displayName: displayName.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Provisioning fehlgeschlagen");
        return;
      }
      setSlug("");
      setDisplayName("");
      setContactEmail("");
      setShowForm(false);
      load();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(s: string) {
    setDeletingSlug(s);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/tenants/${s}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error || "Löschen fehlgeschlagen");
        toast.error(data.error || "Löschen fehlgeschlagen");
        return;
      }
      toast.success(`"${s}" wurde entfernt.`);
      load();
    } catch {
      setDeleteError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeletingSlug(null);
    }
  }

  async function handleStatusChange(t: Tenant, next: string) {
    setStatusBusy(t.slug);
    try {
      const res = await fetch(`/api/tenants/${t.slug}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Status-Änderung fehlgeschlagen");
        return;
      }
      if (data.warnings?.length) {
        toast.error(`Mit Warnungen: ${data.warnings.join("; ")}`);
      } else {
        toast.success(next === "suspended" ? `"${t.slug}" gesperrt.` : `"${t.slug}" reaktiviert.`);
      }
      load();
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setStatusBusy(null);
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
            flexWrap: "wrap",
          }}
        >
          <input
            placeholder="slug (z.B. gutshof)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
          />
          <input
            placeholder="Anzeigename (optional, sonst Slug)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="email"
            placeholder="Kontakt-E-Mail (optional)"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
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

      {tenants && tenants.length > 0 && (
        <input
          placeholder="Suche nach Name oder Slug…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 14, maxWidth: 320 }}
        />
      )}

      {error && <div className="error-box">{error}</div>}
      {deleteError && <div className="error-box" style={{ marginBottom: 12 }}>{deleteError}</div>}
      {!tenants && !error && <div className="empty-state">Lade Projekte…</div>}
      {tenants && tenants.length === 0 && (
        <EmptyState
          title="Noch keine Projekte angelegt."
          hint="Ein Projekt legt eine eigene Datenbank, Auth-Instanz und einen MinIO-Bucket an."
          action={
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>
              + Neues Projekt
            </button>
          }
        />
      )}
      {filteredTenants && tenants && tenants.length > 0 && filteredTenants.length === 0 && (
        <div className="empty-state">Keine Treffer für &quot;{search}&quot;.</div>
      )}

      <div className="card-grid">
        {filteredTenants?.map((t) => {
          const project = projects.find((p) => p.tenant_slug === t.slug);
          const suspended = t.status === "suspended";
          return (
            <div key={t.id} className="card" style={{ position: "relative", opacity: suspended ? 0.7 : 1 }}>
              <Link href={`/dashboard/projects/${t.slug}`}>
                <div className="card-title">{t.display_name || t.slug}</div>
                {t.display_name && t.display_name !== t.slug && (
                  <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{t.slug}</div>
                )}
                <div className="card-sub">
                  {project ? project.repo_url || "Repo nicht gesetzt" : "Kein Projekt verbunden"}
                </div>
                {t.contact_email && (
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{t.contact_email}</div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="pk-badge">{t.tariff}</span>
                  <StatusBadge
                    label={suspended ? "gesperrt" : "aktiv"}
                    color={suspended ? "warn" : "success"}
                  />
                  {project?.active_container && !suspended && (
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "#2da44e",
                        }}
                      />
                      <span className="pk-badge">live</span>
                    </span>
                  )}
                </div>
              </Link>
              <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
                <button
                  className="btn"
                  style={{ fontSize: 12 }}
                  onClick={(e) => {
                    e.preventDefault();
                    setStatusTarget({ tenant: t, next: suspended ? "active" : "suspended" });
                  }}
                  disabled={statusBusy === t.slug}
                >
                  {statusBusy === t.slug ? "…" : suspended ? "Reaktivieren" : "Sperren"}
                </button>
                <button
                  className="btn"
                  style={{ color: "var(--danger)" }}
                  onClick={(e) => {
                    e.preventDefault();
                    setConfirmTarget(t);
                  }}
                  disabled={deletingSlug === t.slug}
                >
                  {deletingSlug === t.slug ? "…" : "Löschen"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && handleDelete(confirmTarget.slug)}
        title={`Projekt "${confirmTarget?.slug ?? ""}" löschen`}
        description="Dieser Vorgang ist nicht rückgängig zu machen."
        level="destructive"
        confirmText={confirmTarget?.slug}
        confirmLabel="Endgültig löschen"
        resources={[
          `Datenbank kunde_${confirmTarget?.slug ?? ""}`,
          "Alle Docker-Container (App, Auth, API)",
          "MinIO-Bucket und IAM-Policy",
          "Traefik-Router aller verbundenen Domains",
          "Projekt- und Deployment-Einträge",
        ]}
      />

      <ConfirmDialog
        open={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        onConfirm={() => statusTarget && handleStatusChange(statusTarget.tenant, statusTarget.next)}
        title={statusTarget?.next === "suspended" ? "Kunde sperren" : "Kunde reaktivieren"}
        description={
          statusTarget?.next === "suspended"
            ? "Container werden gestoppt und die Traefik-Router entfernt. Datenbank, Secrets und alle Einstellungen bleiben erhalten — jederzeit reaktivierbar."
            : "Container werden wieder gestartet und die Domains erneut geroutet."
        }
        confirmLabel={statusTarget?.next === "suspended" ? "Sperren" : "Reaktivieren"}
      />
    </div>
  );
}
