"use client";

import { useEffect, useState } from "react";

interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/audit-logs")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setLogs(d) : setError(d.error || "Fehler")))
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, []);

  return (
    <div className="content">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Audit-Log</h2>
      {error && <div className="error-box">{error}</div>}
      {!logs && !error && <div className="empty-state">Lade…</div>}
      {logs && logs.length === 0 && <div className="empty-state">Noch keine Einträge.</div>}
      {logs?.map((l) => (
        <div
          key={l.id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 6,
            background: "var(--panel)",
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>
              <span className="pk-badge">{l.action}</span>{" "}
              {l.target && <span style={{ color: "var(--text-dim)" }}>{l.target}</span>}
            </span>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {new Date(l.created_at).toLocaleString("de-DE")}
            </span>
          </div>
          {l.meta && Object.keys(l.meta).length > 0 && (
            <pre
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
              }}
            >
              {JSON.stringify(l.meta)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
