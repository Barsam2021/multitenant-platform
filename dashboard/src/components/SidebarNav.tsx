"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const NAV_ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/dashboard", label: "Übersicht", exact: true },
  { href: "/dashboard/projects", label: "Projekte" },
  { href: "/dashboard/backups", label: "Backups" },
  { href: "/dashboard/audit", label: "Audit-Log" },
];

/**
 * P2-7: zwei Defekte auf einmal behoben.
 * 1) .nav-link.active existierte in globals.css, wurde aber nie gesetzt - Sidebar
 *    hatte nie einen erkennbaren aktiven Zustand.
 * 2) Der Mobile-Drawer nutzte ein reines CSS-Checkbox-Muster ohne Reset - nach
 *    einem Tap auf einen Link blieb das Menü auf kleinen Screens offen.
 * Beides braucht usePathname(), also eine Client-Komponente statt des bisherigen
 * Server-Component-Layouts. footer (ThemeToggle/Abmelden) bleibt server-seitig
 * und wird als children durchgereicht.
 */
export function SidebarNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const toggleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (toggleRef.current) toggleRef.current.checked = false;
  }, [pathname]);

  return (
    <>
      <input ref={toggleRef} type="checkbox" id="nav-toggle" className="nav-toggle" />
      <label htmlFor="nav-toggle" className="hamburger-btn" aria-label="Menü öffnen">
        ☰
      </label>
      <label htmlFor="nav-toggle" className="nav-overlay" aria-hidden="true"></label>
      <aside className="sidebar">
        <div className="sidebar-brand">
          UP2 <span>Console</span>
        </div>
        {NAV_ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
              {item.label}
            </Link>
          );
        })}
        <div style={{ flex: 1 }} />
        {children}
      </aside>
    </>
  );
}
