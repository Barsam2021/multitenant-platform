"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      setError("E-Mail oder Passwort falsch.");
    } else {
      router.push("/dashboard/projects");
      router.refresh();
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>
          Platform <span style={{ color: "var(--accent)" }}>Console</span>
        </h1>
        <label htmlFor="email">E-Mail</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="password">Passwort</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="error-box" style={{ marginTop: 14 }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Prüfe..." : "Anmelden"}
        </button>
      </form>
    </div>
  );
}
