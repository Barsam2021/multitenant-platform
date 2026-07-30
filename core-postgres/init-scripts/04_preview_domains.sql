-- Automatische Preview-Domain pro Projekt: <slug>-<random>.<PREVIEW_DOMAIN_SUFFIX>
-- statt app.<slug>.vps.meine-domain.com — flacher, ein Wildcard-Level, kein
-- zusätzlicher Zertifikats-Overhead (Let's Encrypt/Cloudflare-Certs sind ohnehin
-- kostenlos, auch pro Subdomain einzeln — dieser Wechsel ist rein strukturell).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_hostname TEXT UNIQUE;
