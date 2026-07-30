"use client";

import { useEffect, useState, use, useCallback } from "react";

interface Project {
  id: string;
  tenant_slug: string;
  preview_hostname: string | null;
}

interface Domain {
  id: string;
  hostname: string;
  kind: "subdomain" | "custom";
  dns_verified: boolean;
  tls_issued: boolean;
  created_at: string;
}

export default function DomainsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const loadDomains = useCallback((projectId: string) => {
    fetch(`/api/domains?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setDomains(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
        if (p) loadDomains(p.id);
      });
  }, [slug, loadDomains]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setStatus("Registriere…");
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, hostname: host }),
      });
      const data = await res.json();
      setStatus(res.ok ? data.instructions || "DNS-Polling gestartet." : data.error || "Fehler");
      if (res.ok) {
        setHost("");
        loadDomains(project.id);
      }
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleDelete(id: string) {
    if (!project) return;
    if (!confirm("Domain wirklich entfernen?")) return;
    const res = await fetch(`/api/domains/${id}`, { method: "DELETE" });
    if (res.ok) loadDomains(project.id);
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Domains</h2>

      <div style={{ marginBottom: 20 }}>
        {domains.length === 0 && <div className="empty-state">Noch keine Domain.</div>}
        {domains.map((d) => (
          <div
            key={d.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div>
              <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {d.hostname}
              </a>
              <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-faint)" }}>
                {d.kind === "subdomain" ? "Preview" : "Custom"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="pk-badge">{d.dns_verified ? "DNS OK" : "DNS ausstehend"}</span>
              <span className="pk-badge">{d.tls_issued ? "TLS OK" : "TLS ausstehend"}</span>
              {d.kind === "custom" && (
                <button className="btn btn-danger" onClick={() => handleDelete(d.id)}>
                  Entfernen
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Eigene Domain hinzufügen</h3>
      <form onSubmit={handleAdd} style={{ display: "flex", gap: 8 }}>
        <input
          placeholder="www.kunde-domain.at"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary" type="submit">Registrieren</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
    </div>
  );
}
