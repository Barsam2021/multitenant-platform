"use client";

import { useState, use } from "react";

interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
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

  async function runQuery() {
    setRunning(true);
    setError(null);
    const res = await fetch(`/api/tenants/${slug}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    setRunning(false);
    if (data.error) {
      setError(data.error);
      setResult(null);
    } else {
      setResult(data);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  return (
    <div className="content">
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
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={runQuery} disabled={running}>
          {running ? "Läuft…" : "Ausführen"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>⌘/Strg + Enter</span>
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="data-table-wrap" style={{ marginTop: 16 }}>
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
      )}
    </div>
  );
}
