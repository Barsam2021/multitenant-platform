import Link from "next/link";
import { listCollections } from "@/lib/configDb";

export default async function StartPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;
  const collections = await listCollections(tenantSlug);

  return (
    <div>
      <div className="page-head">
        <h1>Übersicht</h1>
      </div>

      {collections.length === 0 ? (
        <div className="empty-state">
          Für Sie sind noch keine Inhalte freigeschaltet.
          <br />
          Ihr Betreuer entscheidet, welche Bereiche hier erscheinen.
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Wählen Sie aus, was Sie bearbeiten möchten.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {collections.map((c) => (
              <Link key={c.id} href={`/${tenantSlug}/c/${c.id}`} className="panel" style={{ textDecoration: "none", color: "inherit" }}>
                <div style={{ fontWeight: 600 }}>{c.label}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {c.can_create ? "Anlegen und bearbeiten" : "Nur bearbeiten"}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
