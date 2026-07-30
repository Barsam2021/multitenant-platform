"use client";

import { useEffect, useState, use, useCallback } from "react";

interface Project {
  id: string;
  tenant_slug: string;
}

interface EnvVar {
  key: string;
}

export default function EnvVarsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const loadVars = useCallback((projectId: string) => {
    fetch(`/api/projects/${projectId}/env`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setVars(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
        if (p) loadVars(p.id);
      });
  }, [slug, loadVars]);

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
        loadVars(project.id);
      }
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleDelete(key: string) {
    if (!project) return;
    if (!confirm(`${key} wirklich löschen?`)) return;
    const res = await fetch(`/api/projects/${project.id}/env`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) loadVars(project.id);
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Environment Variables</h2>

      <div style={{ marginBottom: 20 }}>
        {vars.length === 0 && <div className="empty-state">Keine Env-Vars gesetzt.</div>}
        {vars.map((v) => (
          <div
            key={v.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 6,
              background: "var(--panel)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            <span>{v.key} = ••••••••</span>
            <button className="btn btn-danger" onClick={() => handleDelete(v.key)}>
              Löschen
            </button>
          </div>
        ))}
      </div>

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
