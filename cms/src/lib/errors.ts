/**
 * Postgres-Fehler in etwas uebersetzen, mit dem ein Redakteur etwas anfangen
 * kann. Die Rohmeldung nennt Constraint- und Spaltennamen und klingt nach
 * kaputtem System, obwohl meist nur ein Feld doppelt oder leer ist.
 */
export function toUserMessage(err: Error & { code?: string; column?: string }): string {
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
