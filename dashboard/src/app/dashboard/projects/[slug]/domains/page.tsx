"use client";

import { useEffect, useState, use } from "react";

interface Project {
  id: string;
  tenant_slug: string;
  preview_hostname: string | null;
}

export default function DomainsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
      });
  }, [slug]);

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
      if (res.ok) setHost("");
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Domains</h2>

      {project.preview_hostname && (
        <div style={{ fontSize: 13, marginBottom: 20 }}>
          Automatische Preview-Domain (kostenlos, sofort aktiv):{" "}
          <a href={`https://${project.preview_hostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {project.preview_hostname}
          </a>
        </div>
      )}

      <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Eigene Domain (später Go-Live)</h3>
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
