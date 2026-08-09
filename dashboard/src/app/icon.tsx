import { ImageResponse } from "next/og";

// P2-7: Kein Favicon vorhanden - Next.js' Datei-Konvention generiert es hier
// zur Build-/Request-Zeit als SVG, kein Binaer-Asset noetig.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#6c8eef",
          color: "#fff",
          fontSize: 20,
          fontWeight: 700,
          borderRadius: 6,
        }}
      >
        U
      </div>
    ),
    { ...size }
  );
}
