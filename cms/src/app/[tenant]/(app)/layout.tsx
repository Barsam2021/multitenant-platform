import { redirect } from "next/navigation";
import { listCollections, getTenant } from "@/lib/configDb";
import { requireSession } from "@/lib/session";
import { SidebarNav } from "@/components/SidebarNav";

/**
 * Rahmen fuer alles, was eine Anmeldung voraussetzt.
 *
 * Die Pruefung steht hier und nicht in jeder Seite: eine vergessene Pruefung in
 * einer einzelnen Seite waere ein offenes Scheunentor, und Next rendert diesen
 * Layout garantiert vor jeder Seite darunter. Die schreibenden Endpunkte
 * pruefen trotzdem nochmal selbst — ein Layout schuetzt keine API-Route.
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: tenantSlug } = await params;
  const session = await requireSession(tenantSlug);
  if (!session) redirect(`/${tenantSlug}/login`);

  const [tenant, collections] = await Promise.all([getTenant(tenantSlug), listCollections(tenantSlug)]);
  if (!tenant?.cms_enabled) redirect(`/${tenantSlug}/login`);

  return (
    <div className="shell">
      <SidebarNav
        tenantSlug={tenantSlug}
        tenantName={tenant.display_name || tenantSlug}
        userLabel={session.displayName || session.email}
        collections={collections.map((c) => ({ id: c.id, label: c.label }))}
      />
      <main className="main">{children}</main>
    </div>
  );
}
