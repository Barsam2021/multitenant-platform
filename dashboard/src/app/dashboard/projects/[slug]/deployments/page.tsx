"use client";

import { useEffect, useState, use, useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Deployment {
  id: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  container_name: string | null;
  image_tag: string | null;
  triggered_by: string;
  created_at: string;
  finished_at: string | null;
}

const ACTIVE_STATES = ["queued", "building", "healthchecking"];
const CANCELLABLE_STATES = ["queued", "building", "healthchecking"];

const STATUS_COLOR: Record<string, string> = {
  queued: "var(--text-dim)",
  building: "var(--accent)",
  healthchecking: "var(--accent)",
  deployed: "#2da44e",
  failed: "var(--danger)",
  rolled_back: "var(--text-dim)",
  cancelled: "var(--text-faint)",
};

function duration(start: string, end: string | null): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.max(0, Math.round((e - s) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// Nur fuer github.com-Repos - andere Provider (GitLab, Bitbucket, selbst-gehostet)
// haben andere Commit-URL-Schemata, das lohnt sich hier nicht zu raten.
function githubCommitUrl(repoUrl: string | null, sha: string | null): string | null {
  if (!repoUrl || !sha) return null;
  const m = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/commit/${sha}`;
}

function LogViewer({ slug, deployment }: { slug: string; deployment: Deployment }) {
  const [log, setLog] = useState("");
  const [loaded, setLoaded] = useState(false);
  const offsetRef = useRef(0);
  const isActive = ACTIVE_STATES.includes(deployment.status);

  const fetchDelta = useCallback(async () => {
    const res = await fetch(`/api/deployments/single/${deployment.id}?logOffset=${offsetRef.current}`);
    const data = await res.json();
    if (data.error) return;
    if (data.logDelta) {
      setLog((prev) => prev + data.logDelta);
    }
    offsetRef.current = data.logTotalLength ?? offsetRef.current;
    setLoaded(true);
  }, [deployment.id]);

  useEffect(() => {
    fetchDelta();
    if (!isActive) return;
    // P3-2: Tab im Hintergrund pollt nicht mehr mit.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchDelta();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchDelta, isActive]);

  return (
    <pre
      style={{
        marginTop: 8,
        maxHeight: 600,
        overflowY: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        background: "var(--bg)",
        padding: 8,
        borderRadius: 6,
        whiteSpace: "pre-wrap",
      }}
    >
      {loaded ? log || "(noch kein Log)" : "Lade…"}
    </pre>
  );
}

export default function DeploymentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { project, error: projectError } = useProject();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const toast = useToast();

  const loadDeployments = useCallback((projectId: string) => {
    fetch(`/api/deployments/${projectId}`)
      .then((r) => r.json())
      // P2-7: 401/403 kam vorher als leere Liste an, nicht als Fehlermeldung.
      .then((d) => (Array.isArray(d) ? setDeployments(d) : setError(d?.error || "Deployment-Historie konnte nicht geladen werden")))
      .catch(() => setError("Deployment-Historie konnte nicht geladen werden"));
  }, []);

  useEffect(() => {
    if (!project) return;
    loadDeployments(project.id);
    // P3-2: Tab im Hintergrund pollt nicht mehr mit.
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setDeployments((current) => {
        if (current.some((d) => ACTIVE_STATES.includes(d.status))) {
          loadDeployments(project.id);
        }
        return current;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [project, loadDeployments]);

  function toggleLogs(id: string) {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function downloadLog(d: Deployment) {
    const res = await fetch(`/api/deployments/single/${d.id}`);
    const data = await res.json();
    const blob = new Blob([data.build_log || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deploy-${d.id.slice(0, 8)}-${d.status}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    setError(null);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Deploy fehlgeschlagen");
        toast.error(data.error || "Deploy fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!project) return;
    setError(null);
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Rollback fehlgeschlagen");
        toast.error(data.error || "Rollback fehlgeschlagen");
        return;
      }
      toast.success("Rollback gestartet.");
      loadDeployments(project.id);
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  async function handleCancel(deploymentId: string) {
    if (!project) return;
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Abbruch fehlgeschlagen");
        return;
      }
      toast.success(data.status === "cancel_requested" ? "Abbruch angefordert." : "Deployment abgebrochen.");
      loadDeployments(project.id);
    } catch {
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">{error || projectError || "Lade…"}</div>;

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Deployments</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      {deployments.length === 0 && <div className="empty-state">Noch kein Deployment.</div>}
      {deployments.map((d) => {
        const logsOpen = openLogs.has(d.id);
        const commitUrl = githubCommitUrl(project.repo_url, d.commit_sha);
        // P2-4: nicht mehr "letztes in der Liste", sondern das tatsaechlich live
        // geschaltete Deployment - bei einem fehlgeschlagenen letzten Deploy war
        // der Rollback-Button vorher genau dann weg, wenn man ihn brauchte.
        const canRollback = d.status === "deployed" && d.id !== project.active_deployment_id;
        const canCancel = CANCELLABLE_STATES.includes(d.status);
        return (
          <div
            key={d.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[d.status] || "var(--text-dim)",
                  }}
                />
                <span className="pk-badge">{d.status}</span>
                {d.id === project.active_deployment_id && (
                  <span className="pk-badge" style={{ borderColor: "#2da44e", color: "#2da44e" }}>
                    aktiv
                  </span>
                )}
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      {d.commit_sha?.slice(0, 7)}
                    </a>
                  ) : (
                    d.commit_sha?.slice(0, 7) || "—"
                  )}
                  {d.commit_message && <> — {d.commit_message}</>} · {d.triggered_by} ·{" "}
                  {new Date(d.created_at).toLocaleString("de-DE")} ·{" "}
                  {duration(d.created_at, d.finished_at)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={() => toggleLogs(d.id)}>
                  {logsOpen ? "Logs verbergen" : "Logs anzeigen"}
                </button>
                <button className="btn" onClick={() => downloadLog(d)}>
                  Herunterladen
                </button>
                {canCancel && (
                  <button className="btn btn-danger" onClick={() => setCancelTarget(d.id)}>
                    Abbrechen
                  </button>
                )}
                {canRollback && (
                  <button className="btn" onClick={() => setRollbackTarget(d.id)}>
                    Rollback hierauf
                  </button>
                )}
              </div>
            </div>
            {logsOpen && <LogViewer slug={slug} deployment={d} />}
          </div>
        );
      })}

      <ConfirmDialog
        open={!!rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && handleRollback(rollbackTarget)}
        title="Zurückrollen"
        description="Der zuletzt aktive Container wird gegen dieses Deployment getauscht."
        confirmLabel="Zurückrollen"
      />

      <ConfirmDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && handleCancel(cancelTarget)}
        title="Deployment abbrechen"
        description="Der laufende Build/Healthcheck wird gestoppt, ein evtl. gestarteter Kandidat-Container entfernt. Bereits live geschaltete Deployments lassen sich nicht mehr abbrechen."
        confirmLabel="Abbrechen"
      />
    </div>
  );
}
