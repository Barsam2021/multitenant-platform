"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Tenant {
  id: string;
  slug: string;
  db_name: string;
}

export default function SqlTenantPickerPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => setTenants(d.tenants ?? []));
  }, []);

  return (
    <div className="content">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>SQL Editor — Datenbank wählen</h2>
      <div className="card-grid">
        {tenants?.map((t) => (
          <Link key={t.id} href={`/dashboard/sql/${t.slug}`} className="card">
            <div className="card-title">{t.slug}</div>
            <div className="card-sub">{t.db_name}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
