import { redirect } from "next/navigation";
import { getTenant } from "@/lib/configDb";
import { requireSession } from "@/lib/session";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantSlug } = await params;

  const tenant = await getTenant(tenantSlug);
  // Absichtlich dieselbe Antwort fuer "Kunde existiert nicht" und "CMS ist
  // nicht aktiv": sonst laesst sich ueber die Login-Seite herausfinden, welche
  // Kunden es auf der Plattform gibt.
  if (!tenant || !tenant.cms_enabled) {
    return (
      <div className="login-wrap">
        <div className="panel login-card">
          <h1 style={{ fontSize: 18, marginTop: 0 }}>Nicht verfügbar</h1>
          <p className="muted">
            Für diese Adresse ist keine Redaktion eingerichtet. Bitte prüfen Sie den Link oder wenden Sie sich an
            Ihren Betreuer.
          </p>
        </div>
      </div>
    );
  }

  // requireSession und nicht readSession: eine Sitzung, deren Konto es nicht
  // mehr gibt, wuerde hier nach innen leiten, waehrend das Layout sofort wieder
  // hierher zurueckleitet — eine Endlosschleife im Browser.
  const session = await requireSession(tenantSlug);
  if (session) redirect(`/${tenantSlug}`);

  return (
    <div className="login-wrap">
      <div className="panel login-card">
        <h1 style={{ fontSize: 18, marginTop: 0 }}>{tenant.display_name || tenantSlug}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Anmelden, um Inhalte zu bearbeiten.
        </p>
        <LoginForm tenantSlug={tenantSlug} />
      </div>
    </div>
  );
}
