"use client";

import { useEffect, useState, useCallback } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Backup {
  id: string;
  db_name: string;
  filename: string;
  size_bytes: number;
  status: "ok" | "dump_failed" | "upload_failed";
  created_at: string;
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
};

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
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
                <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  {b.filename}
                </span>
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  {formatBytes(b.size_bytes)} · {new Date(b.created_at).toLocaleString("de-DE")}
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
