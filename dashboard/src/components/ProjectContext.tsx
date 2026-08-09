"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  default_branch: string;
  active_container: string | null;
  active_deployment_id: string | null;
  preview_hostname: string;
  app_port: number;
  health_path: string;
}

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/**
 * P2-7: Vorher lud jede Unterseite (Uebersicht, Domains, Env-Vars, Deployments)
 * unabhaengig voneinander /api/projects und filterte clientseitig nach
 * tenant_slug - vier Requests bei vier Tab-Wechseln fuer dieselben Daten.
 * Jetzt einmal hier im Layout laden, ueber Context an alle Tabs verteilen.
 */
export function ProjectProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => {
        if (!Array.isArray(list)) {
          setError(list?.error || "Projekte konnten nicht geladen werden");
          setProject(null);
          return;
        }
        const p = list.find((x: Project) => x.tenant_slug === slug);
        setProject(p || null);
        setError(null);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ProjectContext.Provider value={{ project, loading, error, reload: load }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject() muss innerhalb von <ProjectProvider> aufgerufen werden");
  }
  return ctx;
}
