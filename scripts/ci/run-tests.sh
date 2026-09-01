#!/bin/bash
# Fuehrt `node --test` mit einem Prioritaets-Filter aus und schlaegt fehl, wenn
# der Filter NICHTS getroffen hat.
#
# Warum: `node --test --test-name-pattern '\[P0\]'` beendet sich mit 0, wenn kein
# einziger Test auf das Muster passt. Verrutscht die Namenskonvention, waere der
# blockierende P0-Schritt still gruen — also genau dann wirkungslos, wenn er
# gebraucht wird.
#
#   scripts/ci/run-tests.sh '\[P0\]' provisioning-agent/test/ scripts/ci/unit/
set -uo pipefail

PATTERN="${1:?Muster fehlt, z.B. '\\[P0\\]'}"
shift
[ "$#" -gt 0 ] || { echo "Kein Testverzeichnis angegeben." >&2; exit 2; }

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

node --test --test-name-pattern "$PATTERN" "$@" 2>&1 | tee "$OUT"
STATUS="${PIPESTATUS[0]}"

# Nicht getroffene Tests meldet node als "ok N - name # SKIP", also mit exit 0.
# Gezaehlt wird deshalb die Summenzeile, nicht die einzelnen ok-Zeilen.
PASSED="$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$OUT" | tail -1)"
FAILED="$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$OUT" | tail -1)"
RAN=$(( ${PASSED:-0} + ${FAILED:-0} ))
if [ "$RAN" -eq 0 ]; then
  echo "FEHLER: Muster '$PATTERN' hat in $* keinen einzigen Test getroffen." >&2
  echo "Entweder ist die Namenskonvention verrutscht oder das Verzeichnis ist leer." >&2
  exit 3
fi

echo "[run-tests] Muster '$PATTERN': $RAN Tests ausgefuehrt, exit=$STATUS"
exit "$STATUS"
