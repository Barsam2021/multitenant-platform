-- P1-4: Env-Vars wirken erst nach Redeploy — die UI sagte das bisher nicht.
--
-- Wer eine Env-Var setzt/ändert/löscht, sieht sofort danach eine App, die den
-- alten Wert noch nutzt (der Container läuft ja weiter) — ohne Hinweis, dass ein
-- Deploy nötig ist. env_dirty wird bei jeder Env-Änderung gesetzt und beim
-- nächsten erfolgreichen Deploy (das die neuen Env-Vars in den Container backt)
-- wieder zurückgesetzt — siehe lib/deploy.ts runDeployment().
--
-- Idempotent.
\connect admin_dashboard

ALTER TABLE projects ADD COLUMN IF NOT EXISTS env_dirty BOOLEAN DEFAULT false;
