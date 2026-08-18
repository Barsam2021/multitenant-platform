/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  // Anders als das Dashboard ist dieser Dienst OEFFENTLICH erreichbar — er ist
  // die einzige Oberflaeche der Plattform, die kundenfremde Personen direkt
  // benutzen. Die Header sind hier also keine Defense-in-Depth, sondern die
  // erste Verteidigungslinie.
  //
  // img-src erlaubt zusaetzlich https:, weil hochgeladene Bilder aus dem
  // MinIO-Bucket unter einer anderen Domain ausgeliefert werden
  // (MEDIA_PUBLIC_BASE_URL). script-src bleibt ohne 'unsafe-eval'; inline ist
  // fuer das Theme-Init-Snippet noetig, wie im Dashboard.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
