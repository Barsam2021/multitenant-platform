#!/bin/sh
# Wird von git via GIT_ASKPASS aufgerufen (siehe lib/git.ts). Bekommt den Prompt-Text
# als $1 ("Username for '...'" oder "Password for '...'"). PAT kommt über die
# Umgebungsvariable GIT_ASKPASS_TOKEN — NIE als argv-Argument oder in der Repo-URL,
# damit er nicht in `docker inspect`/`ps aux`/Node-Fehlermeldungen (execFile hängt bei
# Fehlern die vollen Argumente an error.message) auftaucht.
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$GIT_ASKPASS_TOKEN" ;;
esac
