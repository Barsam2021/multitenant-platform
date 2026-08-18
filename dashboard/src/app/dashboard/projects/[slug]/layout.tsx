"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { ProjectProvider } from "@/components/ProjectContext";

const TABS = [
  { href: "", label: "Übersicht" },
  { href: "/tables", label: "Tabellen" },
  { href: "/sql", label: "SQL" },
  { href: "/deployments", label: "Deployments" },
  { href: "/analytics", label: "Besucher" },
  { href: "/cms", label: "CMS" },
  { href: "/env", label: "Env-Vars" },
  { href: "/domains", label: "Domains" },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const base = `/dashboard/projects/${slug}`;

  return (
    <ProjectProvider slug={slug}>
      <div className="content">
        <div className="project-tabs">
          {TABS.map((t) => {
            const href = `${base}${t.href}`;
            const active = pathname === href;
            return (
              <Link
                key={t.href}
                href={href}
                className="project-tab"
                style={{
                  color: active ? "var(--text)" : "var(--text-dim)",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
        {children}
      </div>
    </ProjectProvider>
  );
}
