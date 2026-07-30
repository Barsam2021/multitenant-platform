"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";

const TABS = [
  { href: "", label: "Übersicht" },
  { href: "/tables", label: "Tabellen" },
  { href: "/sql", label: "SQL" },
  { href: "/deployments", label: "Deployments" },
  { href: "/env", label: "Env-Vars" },
  { href: "/domains", label: "Domains" },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const base = `/dashboard/projects/${slug}`;

  return (
    <div className="content">
      <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid var(--border)" }}>
        {TABS.map((t) => {
          const href = `${base}${t.href}`;
          const active = pathname === href;
          return (
            <Link
              key={t.href}
              href={href}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                color: active ? "var(--text)" : "var(--text-dim)",
                borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
