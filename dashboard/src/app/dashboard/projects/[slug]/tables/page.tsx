"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";

interface TableInfo {
  name: string;
  rowEstimate: number;
}

export default function TenantTablesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tenants/${slug}/tables`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTables(d.tables)))
      .catch(() => setError("Verbindung zur Tenant-DB fehlgeschlagen"));
  }, [slug]);

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Tabellen</h2>
        <span className="conn-chip">
          <span className="dot" />
          kunde_{slug}@core-postgres
        </span>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!tables && !error && <div className="empty-state">Verbinde…</div>}
      {tables && tables.length === 0 && (
        <div className="empty-state">Kein öffentliches Schema mit Tabellen gefunden.</div>
      )}

      <div className="card-grid">
        {tables?.map((t) => (
          <Link
            key={t.name}
            href={`/dashboard/projects/${slug}/tables/${t.name}`}
            className="card"
          >
            <div className="card-title">{t.name}</div>
            <div className="card-sub">~{t.rowEstimate.toLocaleString("de-DE")} Zeilen</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
