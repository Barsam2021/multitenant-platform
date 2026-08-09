"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  msg: string;
}

interface ToastApi {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const COLORS: Record<ToastKind, string> = {
  success: "var(--success)",
  error: "var(--danger)",
  info: "var(--accent)",
};

const ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
};

/**
 * Ersetzt alert()/lose Textknoten. War vorher pro Seite einzeln nachgebaut
 * (z.B. domains/page.tsx eigener notify()-State) — jetzt einmal global, damit
 * jede Seite dieselbe Komponente statt einer eigenen Kopie bekommt.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, kind, msg }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, kind === "error" ? 7000 : 4500);
  }, []);

  const api: ToastApi = {
    success: (msg) => push("success", msg),
    error: (msg) => push("error", msg),
    info: (msg) => push("info", msg),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 2000,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxWidth: 360,
        }}
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{
              background: "var(--panel)",
              border: `1px solid ${COLORS[t.kind]}`,
              borderRadius: 8,
              padding: "10px 14px",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              fontSize: 13,
              boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
              animation: "toast-in 0.15s ease-out",
            }}
          >
            <span style={{ color: COLORS[t.kind], fontWeight: 700, flexShrink: 0 }}>
              {ICONS[t.kind]}
            </span>
            <span style={{ color: "var(--text)", lineHeight: 1.4 }}>{t.msg}</span>
            <button
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
              aria-label="Schliessen"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                marginLeft: "auto",
                padding: 0,
                fontSize: 14,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fällt auf console zurück statt zu crashen, falls ein Aufrufer außerhalb
    // des Providers landet (z.B. während Refactoring einer Seite).
    return {
      success: (m) => console.log("[toast:success]", m),
      error: (m) => console.error("[toast:error]", m),
      info: (m) => console.log("[toast:info]", m),
    };
  }
  return ctx;
}
