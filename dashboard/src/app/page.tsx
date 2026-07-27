'use client';
import { useEffect, useState } from 'react';

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
  backups_enabled: boolean;
  created_at: string;
}

export default function Home() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [slug, setSlug] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = () => fetch('/api/tenants').then((r) => r.json()).then(setTenants);

  useEffect(() => { load(); }, []);

  const createTenant = async () => {
    setLoading(true);
    setError('');
    const res = await fetch('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: slug }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error); return; }
    setSlug('');
    load();
  };

  return (
    <main style={{ padding: 40, fontFamily: 'sans-serif', maxWidth: 700 }}>
      <h1>Tenant Dashboard</h1>

      <div style={{ display: 'flex', gap: 8, margin: '20px 0' }}>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="tenant-slug"
          style={{ padding: 8, flex: 1 }}
        />
        <button onClick={createTenant} disabled={loading || !slug} style={{ padding: '8px 16px' }}>
          {loading ? 'Provisioniere...' : 'Tenant anlegen'}
        </button>
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Slug</th><th>DB</th><th>Tarif</th><th>Backups</th><th>Erstellt</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.slug} style={{ borderBottom: '1px solid #eee' }}>
              <td>{t.slug}</td>
              <td>{t.db_name}</td>
              <td>{t.tariff}</td>
              <td>{t.backups_enabled ? 'an' : 'aus'}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
