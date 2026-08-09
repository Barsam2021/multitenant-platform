"use client";

import { useState } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => unknown;
  title: string;
  /** Kurzer Fliesstext, was passiert. */
  description?: string;
  /** Betroffene Ressourcen, werden als Liste dargestellt (P2-1: "was wird geloescht"). */
  resources?: string[];
  /**
   * "destructive" verlangt exaktes Eintippen von confirmText, bevor der Button
   * aktiv wird. Fuer alles, was Daten unwiderruflich entfernt (Tenant, Domain).
   * "default" ist ein normaler Ja/Nein-Dialog fuer weniger riskante Aktionen
   * (Zeile loeschen, Rollback, Rotation) — Enter im Dialog bestaetigt direkt.
   */
  level?: "default" | "destructive";
  /** Bei level="destructive": Text, der exakt eingetippt werden muss (z.B. der Slug). */
  confirmText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  resources,
  level = "default",
  confirmText,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const isDestructive = level === "destructive";
  const locked = isDestructive && !!confirmText && typed !== confirmText;

  async function handleConfirm() {
    if (locked || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setTyped("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setTyped("");
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title={title} width={480}>
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && !locked && !isDestructive) {
            e.preventDefault();
            handleConfirm();
          }
        }}
      >
        {description && (
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {description}
          </p>
        )}

        {resources && resources.length > 0 && (
          <div
            style={{
              background: "var(--panel-raised)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)", marginBottom: 6 }}>
              Wird entfernt
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
              {resources.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {isDestructive && confirmText && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
              Zum Bestätigen <code style={{ color: "var(--danger)" }}>{confirmText}</code> eingeben:
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !locked) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder={confirmText}
              style={{ width: "100%" }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={handleClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className="btn"
            onClick={handleConfirm}
            disabled={locked || busy}
            style={{
              background: isDestructive ? "var(--danger)" : "var(--accent)",
              color: "#fff",
              border: "none",
              opacity: locked || busy ? 0.5 : 1,
              cursor: locked || busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
