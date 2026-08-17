"use client";

import { useEffect, useState, use } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
  display_name: string | null;
  contact_email: string | null;
  notes: string | null;
  status: string;
  db_enabled: boolean;
  db_provisioned: boolean;
}

interface GithubRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, loading, reload: reloadProject } = useProject();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [previewHostname, setPreviewHostname] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [webhookNote, setWebhookNote] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [rotating, setRotating] = useState<"jwt" | "minio" | null>(null);
  const [rotateNote, setRotateNote] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<"jwt" | "minio" | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [customerForm, setCustomerForm] = useState({ displayName: "", contactEmail: "", notes: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbTarget, setDbTarget] = useState<boolean | null>(null);
  const toast = useToast();

  // Datenbank + Auth pro Kunde an-/abschalten (Migration 19). Aus ist der
  // Normalfall fuer reine Landingpages: spart zwei dauerhaft laufende Container.
  async function handleDatabaseToggle(enabled: boolean) {
    setDbBusy(true);
    try {
      const res = await fetch(`/api/tenants/${slug}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Umschalten fehlgeschlagen");
        return;
      }
      setTenant((prev) => (prev ? { ...prev, db_enabled: enabled, db_provisioned: prev.db_provisioned || enabled } : prev));
      toast.success(
        enabled
          ? "Datenbank aktiv — PostgREST und Auth laufen."
          : "Datenbank abgeschaltet — Container gestoppt, Daten bleiben erhalten."
      );
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDbBusy(false);
    }
  }

  useEffect(() => {
    if (project?.preview_hostname) setPreviewHostname(project.preview_hostname);
  }, [project]);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => {
        const t = d.tenants?.find((x: Tenant) => x.slug === slug);
        if (!t) setError("Projekt nicht gefunden");
        else {
          setTenant(t);
          setCustomerForm({
            displayName: t.display_name || "",
            contactEmail: t.contact_email || "",
            notes: t.notes || "",
          });
        }
      });
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setReposError(d.error);
          setManualEntry(true);
        } else if (Array.isArray(d.repos)) {
          setRepos(d.repos);
        }
      })
      .catch(() => {
        setReposError("Repo-Liste konnte nicht geladen werden.");
        setManualEntry(true);
      });
  }, [slug]);

  function handleRepoSelect(fullName: string) {
    const repo = repos?.find((r) => r.fullName === fullName);
    if (!repo) return;
    setRepoUrl(repo.cloneUrl);
    setDefaultBranch(repo.defaultBranch || "main");
  }

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
      reloadProject();
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
      if (!res.ok) toast.error(data.error || "Deploy fehlgeschlagen");
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRotate(secret: "jwt" | "minio") {
    setRotating(secret);
    setRotateNote(null);
    try {
      const res = await fetch(`/api/tenants/${slug}/rotate-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      const note = res.ok ? data.note || "Rotation abgeschlossen." : data.error || "Rotation fehlgeschlagen";
      setRotateNote(note);
      if (res.ok) toast.success(note); else toast.error(note);
    } catch {
      setRotateNote("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setRotating(null);
    }
  }

  async function handleSaveCustomer() {
    setSavingCustomer(true);
    try {
      const res = await fetch(`/api/tenants/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: customerForm.displayName,
          contactEmail: customerForm.contactEmail,
          notes: customerForm.notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Speichern fehlgeschlagen");
        return;
      }
      setTenant((prev) => (prev ? { ...prev, display_name: data.display_name, contact_email: data.contact_email, notes: data.notes } : prev));
      toast.success("Kundendaten gespeichert.");
      setEditingCustomer(false);
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setSavingCustomer(false);
    }
  }

  if (loading) return <div className="empty-state">Lade…</div>;
  if (error) return <div className="error-box">{error}</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{tenant?.display_name || slug}</h2>
      {tenant && (
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
          {slug} · {tenant.db_enabled ? tenant.db_name : "ohne Datenbank"} · Tarif {tenant.tariff}
          {tenant.status === "suspended" && (
            <span style={{ color: "#e0a340", marginLeft: 8 }}>gesperrt</span>
          )}
        </div>
      )}

      {tenant && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
            marginBottom: 20,
            background: "var(--panel)",
          }}
        >
          <div>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Datenbank &amp; Auth {tenant.db_enabled ? "aktiv" : "abgeschaltet"}
            </span>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4, maxWidth: 620 }}>
              {tenant.db_enabled
                ? "PostgREST und GoTrue laufen für diesen Kunden (zusammen ca. 200 MB RAM). Wer nur eine Landingpage betreibt, braucht das nicht."
                : tenant.db_provisioned
                  ? "Keine laufenden Container. Die Datenbank samt Inhalt ist noch da und ist beim Einschalten sofort wieder verfügbar."
                  : "Für diesen Kunden wurde nie eine Datenbank angelegt. Einschalten legt sie an (dauert ca. eine Minute)."}
            </div>
          </div>
          <button
            className={tenant.db_enabled ? "btn" : "btn btn-primary"}
            onClick={() => setDbTarget(!tenant.db_enabled)}
            disabled={dbBusy || tenant.status === "suspended"}
          >
            {dbBusy ? "Moment…" : tenant.db_enabled ? "Abschalten" : "Einschalten"}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={dbTarget !== null}
        onClose={() => setDbTarget(null)}
        onConfirm={() => dbTarget !== null && handleDatabaseToggle(dbTarget)}
        title={dbTarget ? "Datenbank einschalten" : "Datenbank abschalten"}
        description={
          dbTarget
            ? `Für "${slug}" werden PostgREST und GoTrue gestartet${tenant?.db_provisioned ? "" : " und die Datenbank neu angelegt"}.`
            : `Für "${slug}" werden PostgREST und GoTrue entfernt. Die Datenbank und alle Daten darin BLEIBEN erhalten und sind im Tabellen- und SQL-Editor weiter erreichbar — aber Apps, die die REST-API oder Auth nutzen, fallen aus.`
        }
        confirmLabel={dbTarget ? "Einschalten" : "Abschalten"}
      />

      {tenant && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
            marginBottom: 20,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Kundendaten</span>
            {!editingCustomer && (
              <button className="btn" onClick={() => setEditingCustomer(true)}>
                Bearbeiten
              </button>
            )}
          </div>

          {editingCustomer ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Anzeigename</label>
                <input
                  value={customerForm.displayName}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, displayName: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Kontakt-E-Mail</label>
                <input
                  type="email"
                  value={customerForm.contactEmail}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, contactEmail: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>Notiz</label>
                <textarea
                  rows={3}
                  value={customerForm.notes}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, notes: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={handleSaveCustomer} disabled={savingCustomer}>
                  {savingCustomer ? "Speichere…" : "Speichern"}
                </button>
                <button className="btn" onClick={() => setEditingCustomer(false)} disabled={savingCustomer}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              <span>{tenant.contact_email || "Keine Kontakt-E-Mail hinterlegt."}</span>
              {tenant.notes && <span style={{ whiteSpace: "pre-wrap" }}>{tenant.notes}</span>}
            </div>
          )}
        </div>
      )}

      {tenant && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
          <button className="btn" onClick={() => setRotateTarget("jwt")} disabled={rotating !== null}>
            {rotating === "jwt" ? "Rotiere…" : "JWT-Secret rotieren"}
          </button>
          <button className="btn" onClick={() => setRotateTarget("minio")} disabled={rotating !== null}>
            {rotating === "minio" ? "Rotiere…" : "MinIO-Secret rotieren"}
          </button>
          {rotateNote && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{rotateNote}</span>}
        </div>
      )}

      <ConfirmDialog
        open={!!rotateTarget}
        onClose={() => setRotateTarget(null)}
        onConfirm={() => rotateTarget && handleRotate(rotateTarget)}
        title={`${rotateTarget === "jwt" ? "JWT-Secret" : "MinIO-Secret"} rotieren`}
        description={`Für "${slug}". Bestehende Sessions/Zugriffe können ungültig werden.`}
        confirmLabel="Rotieren"
      />

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
          {!manualEntry && repos && repos.length > 0 && (
            <select
              value={repos.find((r) => r.cloneUrl === repoUrl)?.fullName || ""}
              onChange={(e) => handleRepoSelect(e.target.value)}
              style={{ minWidth: 320 }}
              required
            >
              <option value="" disabled>
                Repo auswählen…
              </option>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? " (privat)" : ""}
                </option>
              ))}
            </select>
          )}

          {!manualEntry && (!repos || repos.length === 0) && !reposError && (
            <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Lade Repos…</span>
          )}

          {manualEntry && (
            <input
              placeholder="Repo-URL (https://github.com/...)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              style={{ minWidth: 320 }}
              required
            />
          )}

          <input
            placeholder="Branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            style={{ width: 100 }}
          />
          <button className="btn btn-primary" type="submit" disabled={connecting || !repoUrl}>
            {connecting ? "Verbinde…" : "Projekt verbinden"}
          </button>
          {repos && repos.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setManualEntry((v) => !v);
                setRepoUrl("");
              }}
            >
              {manualEntry ? "Aus Liste wählen" : "URL manuell eintragen"}
            </button>
          )}
          {connectError && <span style={{ color: "var(--danger)" }}>{connectError}</span>}
          {reposError && (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{reposError}</span>
          )}
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
