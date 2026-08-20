"use client";

import { useEffect, useState, useCallback } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Backup {
  id: string;
  db_name: string;
  filename: string;
  // BIGINT: node-postgres liefert das als String. Der Agent normalisiert es
  // zwar, aber der Typ bleibt tolerant — eine ungepatchte Agent-Version darf
  // die Seite nicht kaputtmachen.
  size_bytes: number | string;
  status:
    | "ok"
    | "dump_failed"
    | "upload_failed"
    | "encrypt_failed"
    | "restore_test_ok"
    | "restore_test_failed";
  created_at: string;
}

/** Eine Datei, wie sie tatsaechlich beim Storage-Anbieter liegt. */
interface RemoteFile {
  name: string;
  path: string;
  /** daily | weekly | monthly | "" */
  generation: string;
  size: number;
  modTime: string;
}

interface RestoreResultEntry {
  status: string;
  tableCount?: number | null;
  error?: string;
}

const STATUS_COLOR: Record<string, string> = {
  ok: "#2da44e",
  dump_failed: "var(--danger)",
  upload_failed: "var(--danger)",
  encrypt_failed: "var(--danger)",
  restore_test_ok: "#2da44e",
  restore_test_failed: "var(--danger)",
};

const STATUS_LABEL: Record<string, string> = {
  dump_failed: "Dump fehlgeschlagen",
  upload_failed: "Upload fehlgeschlagen",
  encrypt_failed: "Verschlüsselung fehlgeschlagen",
  restore_test_ok: "Restore-Test bestanden",
  restore_test_failed: "Restore-Test fehlgeschlagen",
};

/** Zeilen, die kein Backup beschreiben, sondern dessen Überprüfung. */
function isTestRow(status: string): boolean {
  return status === "restore_test_ok" || status === "restore_test_failed";
}

function formatBytes(bytes: number | string | null | undefined): string {
  // Number() statt Verlass auf den Typ: kam der Wert als String an, war
  // "!bytes" false und der Vergleich "val >= 1024" ein Textvergleich —
  // die Groesse stand dann als "1.0 B" oder gar nicht in der Liste.
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = n;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupRunning, setBackupRunning] = useState(false);
  const [restoreTestRunning, setRestoreTestRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoreResult, setRestoreResult] = useState<Record<string, RestoreResultEntry>>({});
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteFile[] | null>(null);
  const [remoteBudget, setRemoteBudget] = useState<number>(0);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    fetch("/api/backups")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        setBackups(d.backups || []);
        setBackupRunning(!!d.backupRunning);
        setRestoreTestRunning(!!d.restoreTestRunning);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, []);

  // Der Bestand beim Storage-Anbieter wird getrennt geladen und getrennt
  // behandelt: er kostet einen rclone-Aufruf und darf, wenn der Anbieter
  // klemmt, nicht die ganze Seite als kaputt erscheinen lassen.
  const loadRemote = useCallback(() => {
    fetch("/api/backups/remote")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setRemoteError(d.error);
          setRemote(null);
          return;
        }
        setRemoteError(null);
        setRemote(d.files || []);
        setRemoteBudget(Number(d.budgetBytes) || 0);
      })
      .catch(() => setRemoteError("Object Storage nicht erreichbar"));
  }, []);

  useEffect(() => {
    loadRemote();
  }, [loadRemote]);

  useEffect(() => {
    load();
    // P3-2: vorher pollte diese Seite alle 5s IMMER, unabhaengig davon, ob
    // ueberhaupt etwas lief - allein ein offen gelassener Backups-Tab hat so
    // 180 der 300 Requests/15min des globalen Agent-Limits verbraucht. Jetzt
    // nur solange ein Backup oder Restore-Test tatsaechlich laeuft, und auch
    // dann nur bei sichtbarem Tab.
    if (!backupRunning && !restoreTestRunning) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 5000);
    return () => clearInterval(interval);
  }, [load, backupRunning, restoreTestRunning]);

  async function handleRunBackup() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/backups/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Backup konnte nicht gestartet werden");
        return;
      }
      load();
    } catch {
      setError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setStarting(false);
    }
  }

  async function handleRestoreTest(filename: string) {
    setRestoreResult((prev) => ({ ...prev, [filename]: { status: "running" } }));
    try {
      const res = await fetch("/api/backups/restore-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRestoreResult((prev) => ({
          ...prev,
          [filename]: { status: "failed", error: data.error || "Restore-Test fehlgeschlagen" },
        }));
        toast.error(data.error || "Restore-Test fehlgeschlagen");
        return;
      }
      setRestoreResult((prev) => ({
        ...prev,
        [filename]: { status: "ok", tableCount: data.tableCount },
      }));
      toast.success(`Restore-Test ok (${data.tableCount ?? "?"} Tabellen).`);
    } catch {
      setRestoreResult((prev) => ({
        ...prev,
        [filename]: { status: "failed", error: "Verbindung zum Provisioning Agent fehlgeschlagen" },
      }));
      toast.error("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Backups</h2>
        <button
          className="btn btn-primary"
          onClick={handleRunBackup}
          disabled={starting || backupRunning}
        >
          {backupRunning ? "Backup läuft…" : starting ? "Starte…" : "Backup jetzt starten"}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {restoreTestRunning && (
        <div style={{ marginBottom: 12, color: "var(--text-dim)", fontSize: 13 }}>
          Ein Restore-Test läuft gerade im Hintergrund…
        </div>
      )}

      {/*
        Bestand beim Storage-Anbieter. Die Liste darunter zeigt, was der Server
        glaubt, gesichert zu haben — nach einem Serververlust ist diese Tabelle
        selbst weg. Im Ernstfall zählt allein, was hier steht.
      */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 12,
          marginBottom: 18,
          background: "var(--panel)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <strong style={{ fontSize: 13 }}>Im Object Storage</strong>
          <button className="btn" onClick={loadRemote} style={{ fontSize: 12 }}>
            Neu laden
          </button>
        </div>
        {remoteError && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
            Bestand nicht abrufbar: {remoteError}
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
              Solange das so bleibt, ist unbekannt, ob die Sicherungen überhaupt beim
              Anbieter ankommen. Prüfen: RCLONE_REMOTE_PATH und backups/rclone.conf.
            </div>
          </div>
        )}
        {!remoteError && remote === null && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>Wird geladen…</div>
        )}
        {!remoteError && remote !== null && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>
            {remote.length === 0 ? (
              <span style={{ color: "var(--danger)" }}>
                Keine Datei beim Anbieter. Es existiert derzeit keine verwertbare Off-Site-Sicherung.
              </span>
            ) : (
              <>
                <span>
                  {remote.length} Dateien · {formatBytes(remote.reduce((sum, f) => sum + f.size, 0))} ·
                  neueste {new Date(remote[0].modTime).toLocaleString("de-DE")}
                </span>
                {remoteBudget > 0 &&
                  (() => {
                    // Auslastung des Speicherbudgets. Ab 90 % wird es rot: bei
                    // einem Gratiskontingent ist das die Grenze, ab der die
                    // naechste Sicherung Geld kostet oder scheitert.
                    const used = remote.reduce((sum, f) => sum + f.size, 0);
                    const pct = Math.min(100, Math.round((used / remoteBudget) * 100));
                    const color = pct >= 90 ? "var(--danger)" : pct >= 75 ? "#bf8700" : "#2da44e";
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 3,
                            background: "var(--border)",
                            overflow: "hidden",
                          }}
                        >
                          <div style={{ width: `${pct}%`, height: "100%", background: color }} />
                        </div>
                        <div style={{ marginTop: 4, color }}>
                          {pct}% von {formatBytes(remoteBudget)} belegt
                        </div>
                      </div>
                    );
                  })()}
                <div style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {["daily", "weekly", "monthly", ""].map((gen) => {
                    const files = remote.filter((f) => f.generation === gen);
                    if (files.length === 0) return null;
                    return (
                      <span key={gen || "root"} className="pk-badge">
                        {gen || "ohne Generation"}: {files.length}
                      </span>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {backups.length === 0 && !error && (
        <div className="empty-state">Noch kein Backup gelaufen.</div>
      )}

      {backups.map((b) => {
        const result = restoreResult[b.filename];
        return (
          <div
            key={b.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: "var(--panel)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLOR[b.status] || "var(--text-dim)",
                  }}
                />
                <span className="pk-badge">{b.db_name}</span>
                {STATUS_LABEL[b.status] && (
                  <span
                    style={{
                      fontSize: 11,
                      color: STATUS_COLOR[b.status],
                      border: `1px solid ${STATUS_COLOR[b.status]}`,
                      borderRadius: 4,
                      padding: "1px 6px",
                    }}
                  >
                    {STATUS_LABEL[b.status]}
                  </span>
                )}
                <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  {b.filename}
                </span>
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  {/* Testzeilen beschreiben ein Ereignis, keine Datei — eine
                      Groesse waere dort irrefuehrend. */}
                  {isTestRow(b.status) ? "" : `${formatBytes(b.size_bytes)} · `}
                  {new Date(b.created_at).toLocaleString("de-DE")}
                </span>
              </div>
              {b.status === "ok" && (
                <button
                  className="btn"
                  onClick={() => setRestoreTarget(b.filename)}
                  disabled={result?.status === "running" || restoreTestRunning}
                >
                  {result?.status === "running" ? "Läuft…" : "Restore-Test"}
                </button>
              )}
            </div>
            {result && result.status === "ok" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#2da44e" }}>
                ✓ Restore-Test erfolgreich — {result.tableCount} Tabellen wiederhergestellt und geprüft, Test-DB wieder entfernt.
              </div>
            )}
            {result && result.status === "failed" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
                ✗ Restore-Test fehlgeschlagen: {result.error}
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => restoreTarget && handleRestoreTest(restoreTarget)}
        title="Restore-Test starten"
        description={`Legt eine temporäre Test-DB aus "${restoreTarget ?? ""}" an und räumt sie danach wieder ab.`}
        confirmLabel="Test starten"
      />
    </div>
  );
}
