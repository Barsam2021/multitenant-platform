"use client";

import { useCallback, useEffect, useState } from "react";

interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

const PAGE_SIZE = 50;

function toCsv(logs: AuditLog[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["created_at,actor,action,target,ip_address,user_agent,meta"];
  for (const l of logs) {
    lines.push(
      [l.created_at, l.actor, l.action, l.target ?? "", l.ip_address ?? "", l.user_agent ?? "", JSON.stringify(l.meta ?? {})]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    setLogs(null);
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (actionFilter) q.set("action", actionFilter);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    fetch(`/api/audit-logs?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        setLogs(d.logs || []);
        setTotalCount(d.totalCount ?? 0);
        setActions(d.actions || []);
        setError(null);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, [page, actionFilter, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleExport() {
    setExporting(true);
    try {
      const q = new URLSearchParams({ limit: "500", offset: "0" });
      if (actionFilter) q.set("action", actionFilter);
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const res = await fetch(`/api/audit-logs?${q.toString()}`);
      const data = await res.json();
      const csv = toCsv(data.logs || []);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-log.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Audit-Log</h2>
        <button className="btn" onClick={handleExport} disabled={exporting}>
          {exporting ? "…" : "CSV-Export (max. 500)"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={actionFilter}
          onChange={(e) => {
            setPage(0);
            setActionFilter(e.target.value);
          }}
        >
          <option value="">Alle Aktionen</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          von
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPage(0);
              setFrom(e.target.value);
            }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
          bis
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPage(0);
              setTo(e.target.value);
            }}
          />
        </label>
        {(actionFilter || from || to) && (
          <button
            className="btn"
            onClick={() => {
              setActionFilter("");
              setFrom("");
              setTo("");
              setPage(0);
            }}
          >
            Filter zurücksetzen
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {!logs && !error && <div className="empty-state">Lade…</div>}
      {logs && logs.length === 0 && <div className="empty-state">Keine Einträge für diesen Filter.</div>}
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
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <span>
              <span className="pk-badge">{l.action}</span>{" "}
              <span style={{ color: "var(--text-dim)" }}>{l.actor}</span>{" "}
              {l.target && <span style={{ color: "var(--text-dim)" }}>· {l.target}</span>}
            </span>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {l.ip_address && <span style={{ marginRight: 8 }}>{l.ip_address}</span>}
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

      {logs && logs.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Zurück
          </button>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Seite {page + 1} von {totalPages} · {totalCount} Einträge
          </span>
          <button className="btn" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Weiter →
          </button>
        </div>
      )}
    </div>
  );
}
