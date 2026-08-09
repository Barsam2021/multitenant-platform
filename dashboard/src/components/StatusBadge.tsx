"use client";

/**
 * Verallgemeinert das Status-Dot-Muster, das vorher pro Seite inline dupliziert war
 * (Domains, Projektliste). Farbe per Prop statt hartcodierter Hex-Werte je Seite.
 */
export function StatusBadge({
  label,
  color,
  title,
}: {
  label: string;
  color: "success" | "danger" | "warn" | "muted";
  title?: string;
}) {
  const dotColor: Record<typeof color, string> = {
    success: "var(--success)",
    danger: "var(--danger)",
    warn: "#e0a340",
    muted: "var(--text-faint)",
  } as const;

  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)" }}
    >
      <span
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dotColor[color],
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

/**
 * Ersetzt die ad-hoc `<div className="empty-state">Text</div>`-Stellen mit
 * optionaler Aktion (z.B. "+ Neues Projekt" direkt im Leerzustand).
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="empty-state"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "36px 16px" }}
    >
      <div style={{ fontSize: 14, color: "var(--text)" }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--text-faint)", textAlign: "center", maxWidth: 380 }}>{hint}</div>}
      {action}
    </div>
  );
}
