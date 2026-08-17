"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenantSlug}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Anmeldung fehlgeschlagen");
        return;
      }
      // refresh() vor push(): die Zielseite ist eine Server-Komponente und
      // wuerde sonst aus dem Cache ohne Sitzung gerendert.
      router.refresh();
      router.push(`/${tenantSlug}`);
    } catch {
      setError("Verbindung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="error-box">{error}</div>}
      <label className="field">
        <span className="label">E-Mail</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          autoFocus
        />
      </label>
      <label className="field">
        <span className="label">Passwort</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
        {busy ? "Anmelden…" : "Anmelden"}
      </button>
    </form>
  );
}
