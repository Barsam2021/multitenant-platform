"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export function SidebarNav({
  tenantSlug,
  tenantName,
  userLabel,
  collections,
}: {
  tenantSlug: string;
  tenantName: string;
  userLabel: string;
  collections: { id: string; label: string }[];
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch(`/api/${tenantSlug}/logout`, { method: "POST" });
    router.refresh();
    router.push(`/${tenantSlug}/login`);
  }

  const items = [
    { href: `/${tenantSlug}`, label: "Start", exact: true },
    ...collections.map((c) => ({ href: `/${tenantSlug}/c/${c.id}`, label: c.label, exact: false })),
    { href: `/${tenantSlug}/medien`, label: "Bilder & Dateien", exact: false },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        {tenantName}
        <span>Redaktion</span>
      </div>
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
            {item.label}
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}>
        {userLabel}
      </div>
      <button className="btn" onClick={logout} style={{ justifyContent: "center" }}>
        Abmelden
      </button>
    </aside>
  );
}
