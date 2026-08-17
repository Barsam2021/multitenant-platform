"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MediaPicker } from "./MediaPicker";

export interface FormField {
  id: string;
  column_name: string;
  label: string;
  field_type: string;
  help_text: string | null;
  required: boolean;
  readonly: boolean;
  options: { choices?: string[]; maxLength?: number } | null;
}

/**
 * Datenbankwert -> Formularwert.
 *
 * Der Sonderfall ist datetime: ein <input type="datetime-local"> akzeptiert
 * ausschliesslich "YYYY-MM-DDTHH:MM" in LOKALER Zeit. Ein ISO-String mit
 * Zeitzone laesst das Feld leer erscheinen — die haeufigste Art, ein Datum beim
 * Speichern versehentlich zu loeschen.
 */
function toInputValue(value: unknown, fieldType: string): string {
  if (value === null || value === undefined) return "";
  if (fieldType === "datetime") {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (fieldType === "date") return String(value).slice(0, 10);
  if (fieldType === "json") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return String(value);
}

export function RowForm({
  tenantSlug,
  collectionId,
  collectionLabel,
  fields,
  row,
  pk,
  canDelete,
}: {
  tenantSlug: string;
  collectionId: string;
  collectionLabel: string;
  fields: FormField[];
  row: Record<string, unknown> | null;
  pk: string | null;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of fields) {
      const raw = row?.[field.column_name];
      initial[field.column_name] =
        field.field_type === "toggle" ? raw === true : toInputValue(raw, field.field_type);
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set(name: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = pk
        ? `/api/${tenantSlug}/collections/${collectionId}/rows/${encodeURIComponent(pk)}`
        : `/api/${tenantSlug}/collections/${collectionId}/rows`;
      const res = await fetch(url, {
        method: pk ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Speichern fehlgeschlagen");
        return;
      }
      router.push(`/${tenantSlug}/c/${collectionId}`);
      router.refresh();
    } catch {
      setError("Verbindung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!pk) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/${tenantSlug}/collections/${collectionId}/rows/${encodeURIComponent(pk)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Löschen fehlgeschlagen");
        return;
      }
      router.push(`/${tenantSlug}/c/${collectionId}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      {error && <div className="error-box">{error}</div>}

      <div className="panel" style={{ marginBottom: 20 }}>
        {fields.map((field) => {
          const value = values[field.column_name];
          const labelNode = (
            <span className="label">
              {field.label}
              {field.required && <span className="required-mark">*</span>}
            </span>
          );

          if (field.field_type === "toggle") {
            return (
              <label className="field" key={field.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => set(field.column_name, e.target.checked)}
                  disabled={field.readonly}
                />
                {labelNode}
              </label>
            );
          }

          return (
            <label className="field" key={field.id}>
              {labelNode}

              {field.field_type === "textarea" || field.field_type === "json" ? (
                <textarea
                  rows={field.field_type === "json" ? 6 : 5}
                  value={String(value ?? "")}
                  onChange={(e) => set(field.column_name, e.target.value)}
                  disabled={field.readonly}
                  required={field.required}
                />
              ) : field.field_type === "richtext" ? (
                <textarea
                  rows={12}
                  value={String(value ?? "")}
                  onChange={(e) => set(field.column_name, e.target.value)}
                  disabled={field.readonly}
                  required={field.required}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
                />
              ) : field.field_type === "select" && field.options?.choices?.length ? (
                <select
                  value={String(value ?? "")}
                  onChange={(e) => set(field.column_name, e.target.value)}
                  disabled={field.readonly}
                  required={field.required}
                >
                  <option value="">— bitte wählen —</option>
                  {field.options.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : field.field_type === "image" || field.field_type === "file" ? (
                <MediaPicker
                  tenantSlug={tenantSlug}
                  value={String(value ?? "")}
                  imagesOnly={field.field_type === "image"}
                  onChange={(url) => set(field.column_name, url)}
                  disabled={field.readonly}
                />
              ) : (
                <input
                  type={
                    field.field_type === "number"
                      ? "number"
                      : field.field_type === "date"
                        ? "date"
                        : field.field_type === "datetime"
                          ? "datetime-local"
                          : "text"
                  }
                  step={field.field_type === "number" ? "any" : undefined}
                  value={String(value ?? "")}
                  onChange={(e) => set(field.column_name, e.target.value)}
                  disabled={field.readonly}
                  required={field.required}
                  maxLength={field.options?.maxLength}
                />
              )}

              {field.help_text && <span className="help">{field.help_text}</span>}
              {field.field_type === "richtext" && !field.help_text && (
                <span className="help">
                  Einfache HTML-Formatierung ist erlaubt (Absätze, Fett, Kursiv, Listen, Links, Bilder). Alles andere
                  wird beim Speichern entfernt.
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Speichere…" : "Speichern"}
        </button>
        <button className="btn" type="button" onClick={() => router.push(`/${tenantSlug}/c/${collectionId}`)}>
          Abbrechen
        </button>
        {pk && canDelete && (
          <>
            <div style={{ flex: 1 }} />
            {confirmDelete ? (
              <>
                <span className="muted">Wirklich löschen? Das lässt sich nicht rückgängig machen.</span>
                <button className="btn btn-danger" type="button" onClick={remove} disabled={busy}>
                  Ja, löschen
                </button>
                <button className="btn" type="button" onClick={() => setConfirmDelete(false)}>
                  Nein
                </button>
              </>
            ) : (
              <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}>
                Löschen
              </button>
            )}
          </>
        )}
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        Eintrag in <strong>{collectionLabel}</strong>. Änderungen sind nach dem Speichern sofort auf der Website
        sichtbar.
      </p>
    </form>
  );
}
