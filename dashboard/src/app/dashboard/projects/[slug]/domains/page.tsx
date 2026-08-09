"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Modal, CopyValue } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useProject } from "@/components/ProjectContext";

interface Instruction {
  type: "A" | "CNAME";
  name: string;
  value: string;
  ttl: number;
  note?: string;
}

interface Domain {
  id: string;
  hostname: string;
  kind: string;
  status: string;
  dns_verified: boolean;
  tls_issued: boolean;
  last_check_at: string | null;
  last_error: string | null;
  verification_method: string | null;
  is_primary: boolean;
  created_at: string;
  instructions: Instruction[];
}

const STATUS_META: Record<string, { label: string; color: string; dot: string }> = {
  live:        { label: "Live",                  color: "var(--success, #16a34a)", dot: "#16a34a" },
  tls_pending: { label: "Zertifikat wird ausgestellt", color: "#ca8a04",           dot: "#ca8a04" },
  dns_ok:      { label: "DNS OK",                color: "#ca8a04",                 dot: "#ca8a04" },
  pending_dns: { label: "Warte auf DNS",         color: "var(--text-muted)",       dot: "#9ca3af" },
  failed:      { label: "Fehlgeschlagen",        color: "var(--danger, #dc2626)",  dot: "#dc2626" },
};

function relTime(iso: string | null): string {
  if (!iso) return "noch nie geprüft";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "gerade eben";
  if (m < 60) return `vor ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} h`;
  return `vor ${Math.floor(h / 24)} Tagen`;
}

function InstructionTable({ instructions }: { instructions: Instruction[] }) {
  if (!instructions?.length) return null;
  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "6px 8px 6px 0", fontWeight: 500 }}>Typ</th>
            <th style={{ padding: "6px 8px", fontWeight: 500 }}>Name</th>
            <th style={{ padding: "6px 8px", fontWeight: 500 }}>Wert</th>
            <th style={{ padding: "6px 0 6px 8px", fontWeight: 500 }}>TTL</th>
          </tr>
        </thead>
        <tbody>
          {instructions.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 8px 8px 0" }}><strong>{r.type}</strong></td>
              <td style={{ padding: "8px" }}><CopyValue value={r.name} /></td>
              <td style={{ padding: "8px" }}><CopyValue value={r.value} /></td>
              <td style={{ padding: "8px 0 8px 8px", color: "var(--text-muted)" }}>{r.ttl}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {instructions.some((r) => r.note) && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
          {instructions.filter((r) => r.note).map((r, i) => (
            <li key={i} style={{ marginBottom: 3 }}><strong>{r.type}:</strong> {r.note}</li>
          ))}
        </ul>
      )}
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, marginBottom: 0 }}>
        Es genügt <strong>einer</strong> dieser Einträge. Nach dem Speichern beim Registrar
        kann die Verbreitung wenige Minuten bis 24 Stunden dauern.
      </p>
    </div>
  );
}

export default function DomainsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { project, loading: projectLoading } = useProject();

  const [domains, setDomains] = useState<Domain[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const toastApi = useToast();

  // Dialog-Zustand
  const [modalOpen, setModalOpen] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<any>(null);

  const notify = (msg: string, kind: "ok" | "err" = "ok") => {
    if (kind === "ok") toastApi.success(msg);
    else toastApi.error(msg);
  };

  const loadDomains = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/domains?projectId=${projectId}`);
    const data = await res.json();
    setDomains(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    if (project) loadDomains(project.id);
  }, [project, loadDomains]);

  // Polling nur solange etwas offen ist — und nur bei sichtbarem Tab (P3-2).
  useEffect(() => {
    if (!project) return;
    const pending = domains.some((d) => d.status !== "live" && d.status !== "failed");
    if (!pending) return;
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") loadDomains(project.id);
    }, 15000);
    return () => clearInterval(iv);
  }, [project, domains, loadDomains]);

  async function handleAdd() {
    if (!project || !newHost.trim()) return;
    setAdding(true);
    setAddResult(null);
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, hostname: newHost.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddResult({ error: data.error || "Fehler beim Anlegen." });
      } else {
        setAddResult(data);
        await loadDomains(project.id);
      }
    } catch (err) {
      setAddResult({ error: (err as Error).message });
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domainId: string) {
    setVerifying(domainId);
    try {
      const res = await fetch(`/api/domains/${domainId}/verify`, { method: "POST" });
      const data = await res.json();
      if (project) await loadDomains(project.id);
      if (data.status === "live") notify("Domain ist live.", "ok");
      else if (data.status === "tls_pending") notify("DNS stimmt. Zertifikat wird ausgestellt — in ~60 Sekunden erneut prüfen.", "ok");
      else notify(data.error || "Noch nicht verifiziert.", "err");
    } catch (err) {
      notify((err as Error).message, "err");
    } finally {
      setVerifying(null);
    }
  }

  async function handleSetPrimary(d: Domain) {
    const res = await fetch(`/api/domains/${d.id}/primary`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      notify(`${d.hostname} ist jetzt Primärdomain. Alle anderen leiten per 301 dorthin um.`, "ok");
      if (project) await loadDomains(project.id);
    } else {
      notify(data.error || "Fehlgeschlagen.", "err");
    }
  }

  async function handleDelete(d: Domain) {
    const res = await fetch(`/api/domains/${d.id}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      notify(`${d.hostname} entfernt.`, "ok");
      if (project) await loadDomains(project.id);
    } else {
      notify(data.error || "Löschen fehlgeschlagen.", "err");
    }
  }

  if (projectLoading) return <p style={{ color: "var(--text-muted)" }}>Lade…</p>;
  if (!project) return <p style={{ color: "var(--text-muted)" }}>Kein Projekt für diesen Tenant.</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Domains</h2>
        <button className="btn btn-primary" onClick={() => { setNewHost(""); setAddResult(null); setModalOpen(true); }}>
          Domain hinzufügen
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {domains.map((d) => {
          const meta = STATUS_META[d.status] || STATUS_META.pending_dns;
          const isOpen = expanded === d.id;
          return (
            <div key={d.id} style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)" }}>
              <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.dot, flexShrink: 0 }} />
                    <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer"
                       style={{ fontWeight: 500, wordBreak: "break-all", color: "inherit" }}>
                      {d.hostname}
                    </a>
                    {d.is_primary && (
                      <span style={{ fontSize: 11, color: "#16a34a", border: "1px solid #16a34a",
                                     borderRadius: 4, padding: "1px 5px" }}>
                        Primär
                      </span>
                    )}
                    {d.kind === "subdomain" && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
                        Preview
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: meta.color, marginTop: 4 }}>
                    {meta.label}
                    {d.verification_method && <span style={{ color: "var(--text-muted)" }}> · via {d.verification_method}</span>}
                    {d.kind === "custom" && <span style={{ color: "var(--text-muted)" }}> · {relTime(d.last_check_at)}</span>}
                    {d.kind === "custom" && !d.is_primary && domains.some((x) => x.is_primary) && (
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}· leitet weiter auf {domains.find((x) => x.is_primary)?.hostname}
                      </span>
                    )}
                  </div>
                  {d.last_error && d.status !== "live" && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
                      {d.last_error}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {d.kind === "custom" && (
                    <>
                      <button className="btn" onClick={() => setExpanded(isOpen ? null : d.id)}>
                        {isOpen ? "Konfiguration ausblenden" : "DNS-Konfiguration"}
                      </button>
                      <button className="btn" onClick={() => handleVerify(d.id)} disabled={verifying === d.id}>
                        {verifying === d.id ? "Prüfe…" : "Erneut prüfen"}
                      </button>
                      {!d.is_primary && (d.status === "live" || d.status === "tls_pending") && (
                        <button className="btn" onClick={() => handleSetPrimary(d)}>Als Primär</button>
                      )}
                      <button className="btn btn-danger" onClick={() => setDeleteTarget(d)}>Entfernen</button>
                    </>
                  )}
                </div>
              </div>

              {isOpen && (
                <div style={{ borderTop: "1px solid var(--border)", padding: "14px 16px", background: "var(--bg-subtle, rgba(0,0,0,0.02))" }}>
                  <InstructionTable instructions={d.instructions} />
                </div>
              )}
            </div>
          );
        })}
        {domains.length === 0 && (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Noch keine Domains.</p>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Domain hinzufügen">
        {!addResult && (
          <>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
              Hostname eintragen, den der Kunde nutzen soll. Die nötigen DNS-Einträge
              zeigen wir im nächsten Schritt — und dauerhaft in der Domain-Liste.
            </p>
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="kunde.at oder www.kunde.at"
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: 14, marginBottom: 14,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setModalOpen(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !newHost.trim()}>
                {adding ? "Lege an…" : "Hinzufügen"}
              </button>
            </div>
          </>
        )}

        {addResult?.error && (
          <>
            <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #dc2626",
                          background: "rgba(220,38,38,0.08)", color: "#dc2626", fontSize: 13, marginBottom: 14 }}>
              {addResult.error}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setAddResult(null)}>Zurück</button>
            </div>
          </>
        )}

        {addResult && !addResult.error && (
          <>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              <strong>{addResult.hostname}</strong> ist angelegt.
            </p>

            {addResult.autoDns?.ok ? (
              <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #16a34a",
                            background: "rgba(22,163,74,0.08)", color: "#16a34a", fontSize: 13, marginBottom: 14 }}>
                DNS-Eintrag automatisch über {addResult.autoDns.provider} gesetzt.
                Die Prüfung läuft im Hintergrund.
              </div>
            ) : (
              <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)",
                            fontSize: 13, marginBottom: 14, color: "var(--text-muted)" }}>
                Kein automatischer Eintrag möglich — bitte beim Registrar setzen:
              </div>
            )}

            <InstructionTable instructions={addResult.instructions || []} />

            {(() => {
              const h: string = addResult.hostname || "";
              // kunde.at und www.kunde.at gehoeren zusammen — Kunden erwarten, dass
              // beide funktionieren. Wir schlagen die Gegenvariante direkt vor.
              const partner = h.startsWith("www.") ? h.slice(4) : `www.${h}`;
              const exists = domains.some((d) => d.hostname === partner);
              if (exists || h.split(".").length > 3) return null;
              return (
                <div style={{ marginTop: 16, padding: "10px 14px", borderRadius: 8,
                              border: "1px solid var(--border)", fontSize: 13 }}>
                  <strong>{partner}</strong> gleich mitanlegen? Eine der beiden wird
                  Primärdomain, die andere leitet per 301 dorthin um.
                  <div style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => { setNewHost(partner); setAddResult(null); }}>
                      {partner} hinzufügen
                    </button>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="btn" onClick={() => setModalOpen(false)}>Schließen</button>
              <button className="btn btn-primary"
                      onClick={async () => { await handleVerify(addResult.domainId); setModalOpen(false); }}>
                Eintrag gesetzt — jetzt prüfen
              </button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        title={`${deleteTarget?.hostname ?? ""} entfernen`}
        description="Der Traefik-Router wird gelöscht, die Domain ist danach nicht mehr erreichbar."
        confirmLabel="Entfernen"
      />
    </div>
  );
}
