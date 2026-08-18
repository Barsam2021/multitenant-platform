import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Redaktion",
  description: "Inhalte pflegen",
  // Dieser Dienst gehoert nicht in Suchmaschinen — er ist die Rueckseite der
  // Kundenseite, nicht die Seite selbst.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        {/* Dunkelmodus folgt der Systemeinstellung. Bewusst ohne Umschalter:
            ein Redakteur soll Inhalte pflegen, nicht Einstellungen suchen. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.setAttribute('data-theme','dark')}}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
