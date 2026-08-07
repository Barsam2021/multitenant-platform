"use client";

import { useEffect, useRef } from "react";

/**
 * Erste Overlay-Komponente des Dashboards. Vorher lief jede Rueckmeldung ueber
 * alert()/confirm() oder lose Textknoten, die beim naechsten Reload verschwanden.
 *
 * Fokus-Falle, ESC und Backdrop-Klick sind bewusst enthalten: der Dialog wird auch
 * fuer destruktive Bestaetigungen genutzt, da darf Tastaturbedienung nicht fehlen.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 620,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose ist im Aufrufer meist ein Inline-Arrow und damit bei jedem Render neu.
  // Ueber ein Ref gehalten, damit der Effect nicht bei jedem Tastendruck neu laeuft
  // und den Fokus aus dem Eingabefeld reisst.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Erst das Eingabefeld, sonst der erste Button. Ein kombinierter Selektor
    // wuerde in Dokumentreihenfolge den Schliessen-Knopf im Header treffen.
    setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("input, textarea, select")
        ?? ref.current?.querySelector<HTMLElement>("button");
      el?.focus();
    }, 50);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "5vh 16px", overflowY: "auto",
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 12, width: "100%", maxWidth: width,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: "1px solid var(--border)",
        }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} aria-label="Schliessen" style={{
            background: "none", border: "none", color: "var(--text-muted)",
            fontSize: 22, cursor: "pointer", lineHeight: 1, padding: "0 4px",
          }}>×</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

/** Wert mit Kopieren-Knopf. Wird in der DNS-Anleitung pro Zelle gebraucht. */
export function CopyValue({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code style={{
        fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
        fontSize: 13, wordBreak: "break-all",
      }}>{value}</code>
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        title="Kopieren"
        style={{
          background: "none", border: "1px solid var(--border)", borderRadius: 4,
          color: "var(--text-muted)", cursor: "pointer", fontSize: 11,
          padding: "1px 5px", flexShrink: 0,
        }}
      >kopieren</button>
    </span>
  );
}
