import Link from "next/link";

// P2-7: kein not-found.tsx vorhanden - eine falsche URL zeigte die generische
// Next.js-404-Seite statt einen Weg zurueck ins Dashboard.
export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 12,
        padding: 24,
        textAlign: "center",
        fontFamily: "-apple-system, sans-serif",
        background: "#0a0c10",
        color: "#e4e7eb",
      }}
    >
      <h1 style={{ fontSize: 18, margin: 0 }}>Seite nicht gefunden</h1>
      <p style={{ fontSize: 13, color: "#8a93a0", margin: 0 }}>
        Diese Adresse existiert nicht oder wurde verschoben.
      </p>
      <Link
        href="/dashboard/projects"
        style={{
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 6,
          border: "1px solid #232830",
          background: "#171b21",
          color: "#e4e7eb",
          textDecoration: "none",
        }}
      >
        Zurück zu Projekte
      </Link>
    </div>
  );
}
