/** @type {import('next').NextConfig} */
const nextConfig = {
  // Läuft als eigener Container im traefik-net, dahinter Traefik/Cloudflare Tunnel.
  output: "standalone",
};

export default nextConfig;
