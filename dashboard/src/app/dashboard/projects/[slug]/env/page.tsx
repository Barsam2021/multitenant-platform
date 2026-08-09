"use client";

import { useEffect, useState, use, useCallback } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Project {
  id: string;
  tenant_slug: string;
}

interface EnvVar {
  key: string;
}

interface ApiKeys {
  postgrestUrl: string;
  anonKey: string;
  serviceRoleKey: string;
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
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);
  const toast = useToast();

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

    fetch(`/api/tenants/${slug}/api-keys`)
      .then((r) => r.json())
      .then((d) => d && d.anonKey && setApiKeys(d))
      .catch(() => {});
  }, [slug, loadVars]);

  function copyToClipboard(label: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  async function handleBulkImport() {
    if (!project || !bulkText.trim()) return;
    setBulkStatus("Importiere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env/bulk`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envText: bulkText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBulkStatus(data.error || "Fehler beim Import");
        return;
      }
      setBulkStatus(
        `${data.imported} Variable${data.imported === 1 ? "" : "n"} importiert.` +
          (data.skipped?.length ? ` ${data.skipped.length} übersprungen (ungültiges Format).` : "")
      );
      setBulkText("");
      loadVars(project.id);
    } catch {
      setBulkStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBulkText(String(reader.result || ""));
    reader.readAsText(file);
    e.target.value = "";
  }

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
    const res = await fetch(`/api/projects/${project.id}/env`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      toast.success(`${key} gelöscht.`);
      loadVars(project.id);
    } else {
      toast.error("Löschen fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      {apiKeys && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
            marginBottom: 24,
            background: "var(--panel)",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Project API Keys</h2>
          {[
            { label: "POSTGREST_URL", value: apiKeys.postgrestUrl },
            { label: "SUPABASE_ANON_KEY", value: apiKeys.anonKey },
            { label: "SUPABASE_SERVICE_ROLE_KEY", value: apiKeys.serviceRoleKey },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 12px",
                marginBottom: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                gap: 8,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.label} = {row.value}
              </span>
              <button className="btn" onClick={() => copyToClipboard(row.label, row.value)}>
                {copied === row.label ? "Kopiert!" : "Copy"}
              </button>
            </div>
          ))}
          <div style={{ fontSize: 12, marginTop: 10, color: "var(--text-dim)" }}>
            ⚠️ Service Role Key umgeht sämtliche RLS-Policies — niemals im Frontend-Code der
            Kunden-App verwenden.
          </div>
        </div>
      )}

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
            <button className="btn btn-danger" onClick={() => setKeyToDelete(v.key)}>
              Löschen
            </button>
          </div>
        ))}
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          background: "var(--panel)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>.env importieren</h3>
          <button className="btn" onClick={() => setBulkOpen((v) => !v)}>
            {bulkOpen ? "Zuklappen" : "Öffnen"}
          </button>
        </div>
        {bulkOpen && (
          <div style={{ marginTop: 10 }}>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"KEY=value\nANOTHER_KEY=value2"}
              rows={8}
              style={{
                width: "100%",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                boxSizing: "border-box",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input type="file" accept=".env,text/plain" onChange={handleFileUpload} />
              <button className="btn btn-primary" onClick={handleBulkImport} disabled={!bulkText.trim()}>
                Importieren
              </button>
            </div>
            {bulkStatus && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{bulkStatus}</div>}
            <div style={{ fontSize: 11, marginTop: 6, color: "var(--text-faint)" }}>
              Bestehende Keys mit gleichem Namen werden überschrieben. Kommentare (#) und Leerzeilen werden ignoriert.
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSet} style={{ display: "flex", gap: 8 }}>
        <input placeholder="KEY" value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} />
        <input placeholder="value" value={envValue} onChange={(e) => setEnvValue(e.target.value)} style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit">Setzen</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
      <div style={{ fontSize: 12, marginTop: 16, color: "var(--text-faint)" }}>
        Automatisch injiziert (nicht hier gesetzt): MINIO_*, S3_BUCKET_NAME, GOTRUE_URL, JWT_SECRET,
        POSTGREST_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
      </div>

      <ConfirmDialog
        open={!!keyToDelete}
        onClose={() => setKeyToDelete(null)}
        onConfirm={() => keyToDelete && handleDelete(keyToDelete)}
        title={`${keyToDelete ?? ""} löschen`}
        description="Wirkt erst nach dem nächsten Redeploy."
        confirmLabel="Löschen"
      />
    </div>
  );
}
