"use client";

// P2-7: kein error.tsx vorhanden - ein Rendering-Fehler zeigte bisher die
// generische Next.js-Fehlerseite ohne jeden Bezug zur Plattform.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
      <h1 style={{ fontSize: 18, margin: 0 }}>Etwas ist schiefgelaufen</h1>
      <p style={{ fontSize: 13, color: "#8a93a0", maxWidth: 480, margin: 0 }}>
        {error.message || "Unbekannter Fehler."}
        {error.digest && ` (${error.digest})`}
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 6,
          border: "1px solid #232830",
          background: "#171b21",
          color: "#e4e7eb",
          cursor: "pointer",
        }}
      >
        Erneut versuchen
      </button>
    </div>
  );
}
