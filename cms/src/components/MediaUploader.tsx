"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function MediaUploader({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function upload(files: FileList) {
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(`/api/${tenantSlug}/media`, { method: "POST", body });
        const data = await res.json();
        if (res.status === 401) {
          // Sitzung abgelaufen oder Konto entfernt: zurueck zur Anmeldung,
          // sonst probiert der Redakteur denselben Upload noch dreimal.
          router.push(`/${tenantSlug}/login`);
          return;
        }
        if (!res.ok) {
          setError(`${file.name}: ${data.error || "Upload fehlgeschlagen"}`);
          break;
        }
        setCopied(data.media.public_url);
      }
      router.refresh();
    } catch {
      setError("Upload fehlgeschlagen");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      {error && <div className="error-box">{error}</div>}
      {copied && !error && (
        <div className="success-box">
          Hochgeladen. Adresse zum Einfügen:
          <br />
          <code style={{ wordBreak: "break-all" }}>{copied}</code>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.length && upload(e.target.files)}
        />
        <button className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? "Lade hoch…" : "Dateien auswählen"}
        </button>
        <span className="muted">JPEG, PNG, WebP, AVIF, GIF oder PDF</span>
      </div>
    </div>
  );
}
