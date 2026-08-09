"use client";

import { useEffect, useState, use, useCallback } from "react";
import { useToast } from "@/components/Toast";

interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

interface SavedQuery {
  id: string;
  name: string;
  sql_text: string;
  created_at: string;
}

const HISTORY_LIMIT = 20;

function historyKey(slug: string) {
  return `sql-history:${slug}`;
}

function loadHistory(slug: string): string[] {
  try {
    const raw = localStorage.getItem(historyKey(slug));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushHistory(slug: string, sql: string) {
  try {
    const current = loadHistory(slug).filter((s) => s !== sql);
    const next = [sql, ...current].slice(0, HISTORY_LIMIT);
    localStorage.setItem(historyKey(slug), JSON.stringify(next));
  } catch {
    // localStorage kann in seltenen Faellen (Privacy-Mode, voll) fehlschlagen -
    // Historie ist ein Komfortfeature, kein Grund die Query abzubrechen.
  }
}

function toCsv(fields: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.map(esc).join(",")];
  for (const row of rows) {
    lines.push(fields.map((f) => esc(row[f])).join(","));
  }
  return lines.join("\n");
}

export default function SqlEditorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [sql, setSql] = useState("SELECT * FROM \n");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [sidebarTab, setSidebarTab] = useState<"saved" | "history">("saved");
  const toast = useToast();

  useEffect(() => {
    setHistory(loadHistory(slug));
  }, [slug]);

  const loadSaved = useCallback(() => {
    fetch(`/api/tenants/${slug}/saved-queries`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d.queries) && setSavedQueries(d.queries))
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  async function runQuery() {
    setRunning(true);
    setError(null);
    const res = await fetch(`/api/tenants/${slug}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, readOnly }),
    });
    const data = await res.json();
    setRunning(false);
    if (data.error) {
      setError(data.error);
      setResult(null);
    } else {
      setResult(data);
      pushHistory(slug, sql);
      setHistory(loadHistory(slug));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  async function handleSaveQuery() {
    if (!saveName.trim()) return;
    const res = await fetch(`/api/tenants/${slug}/saved-queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: saveName.trim(), sql }),
    });
    if (res.ok) {
      toast.success("Query gespeichert.");
      setShowSaveForm(false);
      setSaveName("");
      loadSaved();
    } else {
      toast.error("Speichern fehlgeschlagen.");
    }
  }

  async function handleDeleteSaved(id: string) {
    const res = await fetch(`/api/tenants/${slug}/saved-queries/${id}`, { method: "DELETE" });
    if (res.ok) {
      loadSaved();
    } else {
      toast.error("Löschen fehlgeschlagen.");
    }
  }

  function handleExportCsv() {
    if (!result) return;
    const csv = toCsv(result.fields, result.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}-query-result.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="content" style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>SQL Editor</h2>
          <span className="conn-chip">
            <span className="dot" />
            kunde_{slug}@core-postgres
          </span>
        </div>

        <textarea
          className="sql-editor"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={runQuery} disabled={running}>
            {running ? "Läuft…" : "Ausführen"}
          </button>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>⌘/Strg + Enter</span>

          <label
            title="Blockiert INSERT/UPDATE/DELETE/DDL für diese Ausführung (SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY)"
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}
          >
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Nur lesen
          </label>

          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setShowSaveForm((v) => !v)}>
            Query speichern
          </button>
          {result && (
            <button className="btn" onClick={handleExportCsv}>
              CSV-Export
            </button>
          )}
        </div>

        {showSaveForm && (
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <input
              placeholder="Name der Query"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              style={{ flex: 1 }}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleSaveQuery}>
              Speichern
            </button>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {result && (
          <>
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 14 }}>
              <span>{result.rowCount} Zeile{result.rowCount === 1 ? "" : "n"}</span>
              <span>{result.durationMs} ms</span>
              {result.truncated && (
                <span style={{ color: "#e0a340" }}>Ergebnis gekürzt auf {result.rows.length} Zeilen</span>
              )}
            </div>
            <div className="data-table-wrap" style={{ marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {result.fields.map((f) => (
                      <th key={f}>{f}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.fields.map((f) => (
                        <td key={f}>{String(row[f] ?? "∅")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rows.length === 0 && (
                <div className="empty-state">Query erfolgreich, keine Zeilen zurückgegeben.</div>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ width: 260, flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
          <button
            className="btn"
            style={{ flex: 1, background: sidebarTab === "saved" ? "var(--accent-dim)" : undefined }}
            onClick={() => setSidebarTab("saved")}
          >
            Gespeichert
          </button>
          <button
            className="btn"
            style={{ flex: 1, background: sidebarTab === "history" ? "var(--accent-dim)" : undefined }}
            onClick={() => setSidebarTab("history")}
          >
            Historie
          </button>
        </div>

        {sidebarTab === "saved" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {savedQueries.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Noch keine gespeicherten Queries.</div>
            )}
            {savedQueries.map((q) => (
              <div
                key={q.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontSize: 12,
                }}
              >
                <div
                  style={{ cursor: "pointer", fontWeight: 600, marginBottom: 2 }}
                  onClick={() => setSql(q.sql_text)}
                  title={q.sql_text}
                >
                  {q.name}
                </div>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: "1px 6px", color: "var(--danger)" }}
                  onClick={() => handleDeleteSaved(q.id)}
                >
                  löschen
                </button>
              </div>
            ))}
          </div>
        )}

        {sidebarTab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {history.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Noch keine Historie in diesem Browser.</div>
            )}
            {history.map((h, i) => (
              <div
                key={i}
                onClick={() => setSql(h)}
                title={h}
                style={{
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-dim)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {h}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
