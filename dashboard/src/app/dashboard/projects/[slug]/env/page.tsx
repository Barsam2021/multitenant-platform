"use client";

import { useEffect, useState, use } from "react";

interface Project {
  id: string;
  tenant_slug: string;
}

export default function EnvVarsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
      });
  }, [slug]);

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    if (!/^[A-Z0-9_]+$/.test(envKey)) {
      setStatus("Key: nur A-Z, 0-9, _ erlaubt");
      return;
    }
    setStatus("Speichere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: envValue }),
      });
      const data = await res.json();
      setStatus(res.ok ? "Gespeichert." : data.error || "Fehler");
      if (res.ok) {
        setEnvKey("");
        setEnvValue("");
      }
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Environment Variables</h2>
      <form onSubmit={handleSet} style={{ display: "flex", gap: 8 }}>
        <input placeholder="KEY" value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} />
        <input placeholder="value" value={envValue} onChange={(e) => setEnvValue(e.target.value)} style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit">Setzen</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
      <div style={{ fontSize: 12, marginTop: 16, color: "var(--text-faint)" }}>
        Automatisch injiziert (nicht hier gesetzt): MINIO_*, S3_BUCKET_NAME, GOTRUE_URL, JWT_SECRET.
      </div>
    </div>
  );
}
