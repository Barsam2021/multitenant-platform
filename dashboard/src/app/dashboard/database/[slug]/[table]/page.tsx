"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";

interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

type Row = Record<string, unknown>;

const PAGE_SIZE = 50;

export default function TableEditorPage({
  params,
}: {
  params: Promise<{ slug: string; table: string }>;
}) {
  const { slug, table } = use(params);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Row>({});

  const pkColumn = columns.find((c) => c.isPrimaryKey)?.name;

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/tenants/${slug}/tables/${table}/rows?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
        } else {
          setRows(d.rows);
          setColumns(d.columns);
          setError(null);
        }
      })
      .catch(() => setError("Verbindung fehlgeschlagen"))
      .finally(() => setLoading(false));
  }, [slug, table, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveEdit(rowIndex: number, col: string) {
    const row = rows[rowIndex];
    if (!pkColumn) {
      setError("Tabelle hat keinen Primary Key — Inline-Edit nicht möglich.");
      setEditingCell(null);
      return;
    }
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pkColumn,
        pkValue: row[pkColumn],
        values: { [col]: editValue },
      }),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
    } else {
      setError(null);
      load();
    }
    setEditingCell(null);
  }

  async function handleDelete(row: Row) {
    if (!pkColumn) return;
    if (!confirm("Diese Zeile wirklich löschen?")) return;
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pkColumn, pkValue: row[pkColumn] }),
    });
    const data = await res.json();
    if (data.error) setError(data.error);
    else load();
  }

  async function handleInsert() {
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newRowValues),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
    } else {
      setError(null);
      setShowNewRow(false);
      setNewRowValues({});
      load();
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            <Link href={`/dashboard/database/${slug}`}>{slug}</Link> /
          </div>
          <h2 style={{ margin: 0, fontSize: 16 }}>{table}</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={load}>
            Aktualisieren
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewRow((v) => !v)}>
            + Zeile
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {showNewRow && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {columns.map((c) => (
              <div key={c.name}>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.name}</label>
                <input
                  placeholder={c.columnDefault ?? (c.isNullable ? "NULL" : "")}
                  onChange={(e) =>
                    setNewRowValues((v) => ({ ...v, [c.name]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleInsert}>
            Speichern
          </button>
        </div>
      )}

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name}>
                  {c.name}
                  {c.isPrimaryKey && <span className="pk-badge">PK</span>}
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {columns.map((c) => {
                  const isEditing = editingCell?.row === ri && editingCell.col === c.name;
                  return (
                    <td
                      key={c.name}
                      className={isEditing ? "editing" : ""}
                      onDoubleClick={() => {
                        setEditingCell({ row: ri, col: c.name });
                        setEditValue(String(row[c.name] ?? ""));
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => saveEdit(ri, c.name)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(ri, c.name);
                            if (e.key === "Escape") setEditingCell(null);
                          }}
                        />
                      ) : (
                        String(row[c.name] ?? "∅")
                      )}
                    </td>
                  );
                })}
                <td>
                  <button className="btn btn-danger" onClick={() => handleDelete(row)}>
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty-state">Keine Zeilen.</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Zurück
        </button>
        <button className="btn" disabled={rows.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
          Weiter →
        </button>
      </div>
    </div>
  );
}
