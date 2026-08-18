"use client";

import { useRef, useState } from "react";

/**
 * Bild-/Dateifeld: hochladen oder eine Adresse eintragen.
 *
 * Gespeichert wird immer nur die URL — die Datei selbst liegt im
 * Objektspeicher. Damit bleibt das Feld eine ganz normale Textspalte in der
 * Kundentabelle, und die Website kann sie ohne CMS-Wissen ausgeben.
 */
export function MediaPicker({
  tenantSlug,
  value,
  onChange,
  imagesOnly,
  disabled,
}: {
  tenantSlug: string;
  value: string;
  onChange: (url: string) => void;
  imagesOnly: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/${tenantSlug}/media`, { method: "POST", body });
      const data = await res.json();
      if (!res.ok) {
        // Bei 401 nicht wegnavigieren: im Formular haengen ungespeicherte
        // Eingaben, die dabei verloren gingen. Der Hinweis reicht — die
        // Anmeldung laesst sich in einem zweiten Tab erneuern.
        setError(data.error || "Upload fehlgeschlagen");
        return;
      }
      onChange(data.media.public_url);
    } catch {
      setError("Upload fehlgeschlagen");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      {value && imagesOnly && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={value}
          alt=""
          style={{ maxHeight: 140, borderRadius: 8, border: "1px solid var(--border)", marginBottom: 8, display: "block" }}
        />
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Noch keine Datei"
          disabled={disabled}
          style={{ flex: "1 1 240px" }}
        />
        <input
          ref={inputRef}
          type="file"
          accept={imagesOnly ? "image/*" : "image/*,application/pdf"}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
        >
          {busy ? "Lade hoch…" : "Hochladen"}
        </button>
        {value && !disabled && (
          <button type="button" className="btn" onClick={() => onChange("")}>
            Entfernen
          </button>
        )}
      </div>
      {error && (
        <span className="help" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
