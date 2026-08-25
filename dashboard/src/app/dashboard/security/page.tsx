"use client";

import { useEffect, useState, useCallback } from "react";
import { useToast } from "@/components/Toast";

interface Component {
  id: string;
  scope: "platform" | "tenant" | "project";
  target: string;
  kind: string;
  name: string;
  version: string;
  pinned_version: string | null;
  project_slug: string | null;
  last_seen: string;
  drift: boolean;
}

const SCOPE_LABEL: Record<string, string> = {
  platform: "Plattform",
  tenant: "Tenant-Dienste",
  project: "Gehostete Projekte",
};

const SCOPE_HINT: Record<string, string> = {
  platform: "Container der Plattform selbst — Updates liegen beim Betreiber.",
  tenant: "Läuft je Mandant. Ein Update betrifft alle Tenants gleichzeitig.",
  project: "Aus dem Kundenrepo gebaut. Die Version ist der Commit, nicht ein Pin.",
};

export default function SecurityPage() {
  const [components, setComponents] = useState<Component[]>([]);
  const [driftCount, setDriftCount] = useState(0);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    fetch("/api/security/components")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setError(null);
        setComponents(d.components || []);
        setDriftCount(d.driftCount || 0);
        setLastSeen(d.lastSeen || null);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/security/inventory", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Inventar fehlgeschlagen"); return; }
      toast.success(`${data.count} Komponenten erfasst.`);
      load();
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setRefreshing(false);
    }
  }

  const scopes: Component["scope"][] = ["platform", "tenant", "project"];

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Versionen &amp; CVEs</h2>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Erfasse…" : "Inventar aktualisieren"}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ marginBottom: 18, fontSize: 13, color: "var(--text-dim)" }}>
        {components.length} Komponenten
        {lastSeen && <> · zuletzt gesehen {new Date(lastSeen).toLocaleString("de-DE")}</>}
        {driftCount > 0 && (
          <span style={{ color: "var(--danger)" }}>
            {" "}· {driftCount} Abweichung{driftCount === 1 ? "" : "en"} zur Repo-Vorgabe
          </span>
        )}
      </div>

      {/*
        Die CVE-Zähler folgen in Phase 2 (Trivy). Der Platz dafür ist hier
        bewusst schon benannt, damit die Seite nicht später umgebaut wird.
      */}
      <div
        style={{
          border: "1px dashed var(--border)", borderRadius: 8, padding: 12,
          marginBottom: 18, fontSize: 12, color: "var(--text-dim)",
        }}
      >
        Schwachstellen-Scan noch nicht aktiv. Sobald er läuft, stehen hier die
        Zähler je Schweregrad (kritisch / hoch / mittel / niedrig) — pro
        Komponente und für die gesamte Installation.
      </div>

      {components.length === 0 && !error && (
        <div className="empty-state">
          Noch kein Inventar erhoben. &bdquo;Inventar aktualisieren&ldquo; anklicken.
        </div>
      )}

      {scopes.map((scope) => {
        const rows = components.filter((c) => c.scope === scope);
        if (rows.length === 0) return null;
        return (
          <div key={scope} style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, margin: "0 0 2px" }}>{SCOPE_LABEL[scope]}</h3>
            <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 8 }}>
              {SCOPE_HINT[scope]}
            </div>
            {rows.map((c) => (
              <div
                key={c.id}
                style={{
                  border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px",
                  marginBottom: 6, background: "var(--panel)", display: "flex",
                  alignItems: "center", gap: 10, flexWrap: "wrap",
                }}
              >
                <span className="pk-badge">{c.name}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{c.version}</span>
                {c.drift && (
                  <span
                    style={{
                      fontSize: 11, color: "var(--danger)", border: "1px solid var(--danger)",
                      borderRadius: 4, padding: "1px 6px",
                    }}
                    title="Es läuft eine andere Version, als im Repo gepinnt ist"
                  >
                    gepinnt: {c.pinned_version}
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-faint)" }}>
                  {c.project_slug ? `${c.project_slug} · ` : ""}{c.target}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
