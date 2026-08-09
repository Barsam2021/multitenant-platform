"use client";

import { useEffect, useState, use, useCallback, useRef } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

type Row = Record<string, unknown>;
type InputKind = "boolean" | "number" | "date" | "datetime" | "json" | "text";

const PAGE_SIZE = 50;
const NULL_DISPLAY = "∅ NULL";

function inputKindFor(dataType: string): InputKind {
  const t = dataType.toLowerCase();
  if (t === "boolean") return "boolean";
  if (["integer", "bigint", "smallint", "numeric", "real", "double precision", "decimal"].includes(t)) {
    return "number";
  }
  if (t === "date") return "date";
  if (t.startsWith("timestamp")) return "datetime";
  if (t === "json" || t === "jsonb") return "json";
  return "text";
}

// pg liefert timestamp(tz)-Spalten als ISO-String; <input type="datetime-local">
// erwartet "YYYY-MM-DDTHH:mm" in Browser-Lokalzeit ohne Sekunden/Zeitzone.
function toDatetimeLocal(value: unknown): string {
  if (value == null) return "";
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toDateInput(value: unknown): string {
  if (value == null) return "";
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function displayValue(value: unknown, kind: InputKind): string {
  if (value === null || value === undefined) return NULL_DISPLAY;
  if (kind === "json") return typeof value === "string" ? value : JSON.stringify(value);
  if (kind === "datetime") return toDatetimeLocal(value).replace("T", " ");
  if (kind === "date") return toDateInput(value);
  if (kind === "boolean") return String(value);
  return String(value);
}

export default function TableEditorPage({
  params,
}: {
  params: Promise<{ slug: string; table: string }>;
}) {
  const { slug, table } = use(params);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasPrimaryKey, setHasPrimaryKey] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filterInputs, setFilterInputs] = useState<Record<string, string>>({});
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editIsNull, setEditIsNull] = useState(false);
  const [editJsonError, setEditJsonError] = useState<string | null>(null);
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Row>({});
  const [rowToDelete, setRowToDelete] = useState<Row | null>(null);
  const toast = useToast();
  const filterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "__ctid" ist der Sentinel-Identifier fuer Tabellen ohne echten PK (P2-2).
  const realPk = columns.find((c) => c.isPrimaryKey)?.name;
  const pkColumn = realPk ?? (hasPrimaryKey ? undefined : "__ctid");

  const load = useCallback(() => {
    setLoading(true);
    const q = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (sortCol) {
      q.set("orderBy", sortCol);
      q.set("orderDir", sortDir);
    }
    if (Object.keys(filters).length > 0) {
      q.set("filters", JSON.stringify(filters));
    }
    fetch(`/api/tenants/${slug}/tables/${table}/rows?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
        } else {
          setRows(d.rows);
          setColumns(d.columns);
          setTotalCount(d.totalCount ?? 0);
          setHasPrimaryKey(d.hasPrimaryKey ?? true);
          setError(null);
        }
      })
      .catch(() => setError("Verbindung fehlgeschlagen"))
      .finally(() => setLoading(false));
  }, [slug, table, page, sortCol, sortDir, filters]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleSort(col: string) {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
    }
    setPage(0);
  }

  function onFilterChange(col: string, value: string) {
    setFilterInputs((prev) => ({ ...prev, [col]: value }));
    if (filterDebounce.current) clearTimeout(filterDebounce.current);
    filterDebounce.current = setTimeout(() => {
      setPage(0);
      setFilters((prev) => {
        const next = { ...prev };
        if (value) next[col] = value;
        else delete next[col];
        return next;
      });
    }, 400);
  }

  function startEdit(ri: number, col: ColumnInfo) {
    const value = rows[ri][col.name];
    setEditingCell({ row: ri, col: col.name });
    setEditJsonError(null);
    if (value === null || value === undefined) {
      setEditIsNull(true);
      setEditValue("");
      return;
    }
    setEditIsNull(false);
    const kind = inputKindFor(col.dataType);
    if (kind === "datetime") setEditValue(toDatetimeLocal(value));
    else if (kind === "date") setEditValue(toDateInput(value));
    else if (kind === "json") setEditValue(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    else setEditValue(String(value));
  }

  async function saveEdit(rowIndex: number, col: ColumnInfo) {
    if (!pkColumn) {
      setError("Tabelle hat keinen Primary Key — Inline-Edit nicht möglich.");
      setEditingCell(null);
      return;
    }
    const kind = inputKindFor(col.dataType);
    let payloadValue: unknown = null;

    if (!editIsNull) {
      if (kind === "number") {
        const n = Number(editValue);
        payloadValue = Number.isFinite(n) ? n : editValue;
      } else if (kind === "boolean") {
        payloadValue = editValue === "true";
      } else if (kind === "json") {
        try {
          payloadValue = editValue.trim() === "" ? null : JSON.parse(editValue);
        } catch {
          setEditJsonError("Ungültiges JSON — nicht gespeichert.");
          return;
        }
      } else if (kind === "datetime" || kind === "date") {
        const d = new Date(editValue);
        payloadValue = isNaN(d.getTime()) ? editValue : d.toISOString();
      } else {
        payloadValue = editValue;
      }
    }

    const row = rows[rowIndex];
    const pkValue = pkColumn === "__ctid" ? row.__ctid : row[pkColumn];
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pkColumn, pkValue, values: { [col.name]: payloadValue } }),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
      toast.error(data.error);
    } else {
      setError(null);
      load();
    }
    setEditingCell(null);
    setEditJsonError(null);
  }

  async function handleDelete(row: Row) {
    if (!pkColumn) return;
    const pkValue = pkColumn === "__ctid" ? row.__ctid : row[pkColumn];
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pkColumn, pkValue }),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
      toast.error(data.error);
    } else {
      toast.success("Zeile gelöscht.");
      load();
    }
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
      toast.error(data.error);
    } else {
      setError(null);
      setShowNewRow(false);
      setNewRowValues({});
      toast.success("Zeile angelegt.");
      load();
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const displayColumns = columns; // "__ctid" wird nicht als eigene Spalte gerendert

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            <Link href={`/dashboard/projects/${slug}/tables`}>{slug}</Link> /
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

      {!hasPrimaryKey && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 12,
            border: "1px solid #e0a340",
            background: "rgba(224,163,64,0.08)",
            color: "#c8862a",
          }}
        >
          Diese Tabelle hat keinen Primary Key. Bearbeiten/Löschen nutzt die physische
          Zeilenposition (ctid) — kann sich nach VACUUM oder anderen Updates verschieben.
          Zwischen Laden und Speichern sollte deshalb möglichst wenig Zeit liegen.
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      {showNewRow && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {columns.map((c) => {
              const kind = inputKindFor(c.dataType);
              return (
                <div key={c.name}>
                  <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.name}</label>
                  {kind === "boolean" ? (
                    <select
                      defaultValue=""
                      onChange={(e) =>
                        setNewRowValues((v) => ({
                          ...v,
                          [c.name]: e.target.value === "" ? undefined : e.target.value === "true",
                        }))
                      }
                    >
                      <option value="">{c.isNullable ? "NULL" : "wählen…"}</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : kind === "json" ? (
                    <textarea
                      rows={2}
                      placeholder={c.columnDefault ?? (c.isNullable ? "NULL" : "{}")}
                      onChange={(e) => setNewRowValues((v) => ({ ...v, [c.name]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type={kind === "number" ? "number" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : "text"}
                      placeholder={c.columnDefault ?? (c.isNullable ? "NULL" : "")}
                      onChange={(e) => setNewRowValues((v) => ({ ...v, [c.name]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })}
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
              {displayColumns.map((c) => (
                <th key={c.name} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(c.name)}>
                  {c.name}
                  {c.isPrimaryKey && <span className="pk-badge">PK</span>}
                  {sortCol === c.name && <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "↑" : "↓"}</span>}
                </th>
              ))}
              <th></th>
            </tr>
            <tr>
              {displayColumns.map((c) => (
                <th key={`filter-${c.name}`} style={{ padding: "4px 6px" }}>
                  <input
                    value={filterInputs[c.name] ?? ""}
                    onChange={(e) => onFilterChange(c.name, e.target.value)}
                    placeholder="Filter…"
                    style={{ width: "100%", fontSize: 11, padding: "3px 6px" }}
                  />
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {displayColumns.map((c) => {
                  const isEditing = editingCell?.row === ri && editingCell.col === c.name;
                  const kind = inputKindFor(c.dataType);
                  return (
                    <td
                      key={c.name}
                      className={isEditing ? "editing" : ""}
                      onDoubleClick={() => startEdit(ri, c)}
                    >
                      {isEditing ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            {kind === "boolean" ? (
                              <select
                                autoFocus
                                value={editIsNull ? "" : editValue}
                                onChange={(e) => {
                                  setEditIsNull(e.target.value === "");
                                  setEditValue(e.target.value);
                                }}
                              >
                                {c.isNullable && <option value="">NULL</option>}
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : kind === "json" ? (
                              <textarea
                                autoFocus
                                rows={3}
                                disabled={editIsNull}
                                value={editIsNull ? "" : editValue}
                                onChange={(e) => {
                                  setEditIsNull(false);
                                  setEditValue(e.target.value);
                                  setEditJsonError(null);
                                }}
                                style={{ width: 220, fontFamily: "var(--font-mono)", fontSize: 12 }}
                              />
                            ) : (
                              <input
                                autoFocus
                                type={kind === "number" ? "number" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : "text"}
                                disabled={editIsNull}
                                value={editIsNull ? "" : editValue}
                                placeholder={editIsNull ? "NULL" : ""}
                                onChange={(e) => {
                                  setEditIsNull(false);
                                  setEditValue(e.target.value);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveEdit(ri, c);
                                  if (e.key === "Escape") setEditingCell(null);
                                }}
                              />
                            )}
                            {c.isNullable && (
                              <button
                                type="button"
                                className="btn"
                                title="Auf NULL setzen"
                                style={{ fontSize: 10, padding: "2px 6px" }}
                                onClick={() => {
                                  setEditIsNull(true);
                                  setEditValue("");
                                }}
                              >
                                NULL
                              </button>
                            )}
                          </div>
                          {editJsonError && <span style={{ fontSize: 11, color: "var(--danger)" }}>{editJsonError}</span>}
                          <div style={{ display: "flex", gap: 4 }}>
                            <button className="btn btn-primary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => saveEdit(ri, c)}>
                              ✓
                            </button>
                            <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setEditingCell(null)}>
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: row[c.name] == null ? "var(--text-faint)" : undefined, fontStyle: row[c.name] == null ? "italic" : undefined }}>
                          {displayValue(row[c.name], kind)}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td>
                  <button className="btn btn-danger" onClick={() => setRowToDelete(row)}>
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty-state">Keine Zeilen.</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Zurück
        </button>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Seite {page + 1} von {totalPages} · {totalCount} Zeilen
        </span>
        <button className="btn" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Weiter →
        </button>
      </div>

      <ConfirmDialog
        open={!!rowToDelete}
        onClose={() => setRowToDelete(null)}
        onConfirm={() => rowToDelete && handleDelete(rowToDelete)}
        title="Zeile löschen"
        description={
          pkColumn && rowToDelete
            ? `${pkColumn === "__ctid" ? "Zeile (ctid)" : pkColumn} = ${String(
                pkColumn === "__ctid" ? rowToDelete.__ctid : rowToDelete[pkColumn]
              )}`
            : "Diese Zeile wirklich löschen?"
        }
        confirmLabel="Löschen"
      />
    </div>
  );
}
