"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  created_at: string;
}

export default function DatabaseOverviewPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
  }, []);

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Datenbanken</h2>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!tenants && !error && <div className="empty-state">Lade Tenants…</div>}
      {tenants && tenants.length === 0 && (
        <div className="empty-state">
          Noch keine Tenants angelegt. Neue Tenants werden aktuell über den
          Provisioning Agent erstellt (§ Phase 1 der Web-UI-Spec).
        </div>
      )}

      <div className="card-grid">
        {tenants?.map((t) => (
          <Link key={t.id} href={`/dashboard/database/${t.slug}`} className="card">
            <div className="card-title">{t.slug}</div>
            <div className="card-sub">{t.db_name}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
              <span className="pk-badge">{t.tariff}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
