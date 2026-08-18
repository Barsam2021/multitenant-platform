/**
 * Postgres-Fehler in etwas uebersetzen, mit dem ein Redakteur etwas anfangen
 * kann. Die Rohmeldung nennt Constraint- und Spaltennamen und klingt nach
 * kaputtem System, obwohl meist nur ein Feld doppelt oder leer ist.
 */
export function toUserMessage(err: Error & { code?: string; column?: string; detail?: string; table?: string }): string {
  // Immer zuerst vollstaendig ins Server-Log. Die Meldung, die der Redakteur
  // sieht, ist bewusst allgemein — fuer die Fehlersuche braucht der Betreiber
  // aber Code, Tabelle und Detail, sonst steht er vor "fehlen die Rechte" und
  // weiss nicht, ob es an einem GRANT, an RLS oder an einer Sequenz liegt.
  if (err.code) {
    console.error(
      `[cms] Postgres-Fehler ${err.code}` +
      (err.table ? ` (Tabelle ${err.table})` : "") +
      `: ${err.message}` +
      (err.detail ? ` — ${err.detail}` : "")
    );
  }

  // 42501 hat zwei sehr verschiedene Ursachen, die sich nur am Text
  // unterscheiden lassen: fehlendes GRANT oder eine Row-Level-Security-Policy.
  if (err.code === "42501" && /row-level security/i.test(err.message)) {
    return (
      "Dieser Eintrag wird von einer Sicherheitsregel der Datenbank abgelehnt. " +
      "Bitte den Betreuer informieren — die Redaktionsrolle braucht BYPASSRLS."
    );
  }

  switch (err.code) {
    case "23505":
      return "Diesen Wert gibt es schon — bitte einen anderen wählen (z. B. beim URL-Kürzel).";
    case "23502":
      return `Das Feld "${err.column || "ein Pflichtfeld"}" darf nicht leer bleiben.`;
    case "23503":
      return "Der verknüpfte Eintrag existiert nicht (mehr).";
    case "22P02":
      return "Ein Wert hat das falsche Format.";
    case "42501":
      // Kommt vor, wenn eine Sammlung im Dashboard entfernt und die Rechte
      // entzogen wurden, die Seite beim Redakteur aber noch offen ist.
      return "Für diesen Bereich fehlen die Rechte. Bitte den Betreuer informieren.";
    case "22001":
      return "Ein Text ist länger, als das Feld erlaubt.";
    case "28P01":
      return "Die Datenbankverbindung wurde neu eingerichtet. Bitte die Seite neu laden.";
    default:
      return err.message;
  }
}
