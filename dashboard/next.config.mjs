/** @type {import('next').NextConfig} */
const nextConfig = {
  // Läuft als eigener Container im traefik-net, dahinter Traefik/Cloudflare Tunnel.
  output: "standalone",

  // Phase 6: Security-Header. Dashboard ist Single-Admin, nicht öffentlich indexiert
  // (nur via Cloudflare Tunnel erreichbar) — Header trotzdem gesetzt als Defense-in-Depth
  // für den Fall eines Tunnel-Fehlkonfig oder eines künftigen Multi-Admin-Setups.
  // 'unsafe-inline' bei script-src ist nötig wegen des kleinen Theme-Init-Scripts in
  // app/layout.tsx (dangerouslySetInnerHTML) — Alternative wäre ein Nonce-Setup, für den
  // aktuellen Umfang (1 Admin, kein Fremd-Content) nicht verhältnismäßig.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
