-- P1-2: Projekt-Lebenszyklus — Bearbeiten und Löschen sind bisher eine Einbahnstraße.
--
-- Damit DELETE /projects/:id den GitHub-Webhook sauber deregistrieren kann, muss die
-- Webhook-ID aus der GitHub-API-Antwort beim Anlegen gespeichert werden. Bisher wurde
-- sie nur einmalig zurückgegeben und nirgends persistiert.
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_webhook_id INTEGER;
