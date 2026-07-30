#!/bin/bash
set -e
cd /opt/multitenant-platform

# --- Alte Routen entfernen ---
rm -rf dashboard/src/app/dashboard/database dashboard/src/app/dashboard/hosting dashboard/src/app/dashboard/sql

mkdir -p "dashboard/src/components"
cat > "dashboard/src/components/ThemeToggle.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as "dark" | "light" | null) || "dark";
    setTheme(stored);
    document.documentElement.setAttribute("data-theme", stored);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  return (
    <button className="theme-toggle" onClick={toggle} type="button">
      {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
PC_EOF
mkdir -p "dashboard/src"
cat > "dashboard/src/middleware.ts" << 'PC_EOF'
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/dashboard/:path*", "/api/tenants/:path*"],
};
PC_EOF
mkdir -p "dashboard/src/app"
cat > "dashboard/src/app/globals.css" << 'PC_EOF'
:root {
  --bg: #0a0c10;
  --panel: #12151a;
  --panel-raised: #171b21;
  --border: #232830;
  --text: #e4e7eb;
  --text-dim: #8a93a0;
  --text-faint: #545c68;
  --accent: #6c8eef;
  --accent-dim: #2a3a66;
  --danger: #e5484d;
  --success: #3fb88a;
  --font-ui: -apple-system, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
}

:root[data-theme="light"] {
  --bg: #f5f6f8;
  --panel: #ffffff;
  --panel-raised: #f0f1f4;
  --border: #dfe2e7;
  --text: #1a1d22;
  --text-dim: #5a6270;
  --text-faint: #9aa1ac;
  --accent: #3f5fc9;
  --accent-dim: #dce3fb;
  --danger: #d1373c;
  --success: #2f9970;
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel-raised);
  color: var(--text-dim);
  font-size: 12px;
}

.theme-toggle:hover {
  border-color: var(--accent);
  color: var(--text);
}

* {
  box-sizing: border-box;
}

html,
body {
  padding: 0;
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
}

a {
  color: inherit;
  text-decoration: none;
}

button {
  font-family: inherit;
  cursor: pointer;
}

input,
textarea,
select {
  font-family: inherit;
  color: var(--text);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
}

input:focus,
textarea:focus,
select:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel-raised);
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
}

.btn:hover {
  border-color: var(--accent);
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0a0c10;
  font-weight: 600;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-danger {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}

/* --- App Shell --- */
.shell {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100vh;
}

.sidebar {
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-brand {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.02em;
  padding: 4px 8px 16px;
  color: var(--text);
}

.sidebar-brand span {
  color: var(--accent);
}

.nav-link {
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 500;
}

.nav-link:hover {
  background: var(--panel-raised);
  color: var(--text);
}

.nav-link.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.main {
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

/* Connection-Chip: zeigt die echte DB-Connection, kein generisches Dropdown-Label */
.conn-chip {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.conn-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}

.content {
  padding: 20px;
  flex: 1;
}

/* --- Cards / Grid --- */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}

.card:hover {
  border-color: var(--accent);
}

.card-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 4px;
}

.card-sub {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-faint);
}

/* --- Table Editor --- */
.data-table-wrap {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: auto;
  background: var(--panel);
}

table.data-table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--font-mono);
  font-size: 12.5px;
}

table.data-table th {
  position: sticky;
  top: 0;
  background: var(--panel-raised);
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

table.data-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}

table.data-table tr:hover td {
  background: var(--panel-raised);
}

table.data-table td.editing {
  padding: 0;
}

table.data-table td.editing input {
  width: 100%;
  border: none;
  border-radius: 0;
  background: var(--accent-dim);
}

.pk-badge {
  font-size: 9px;
  color: var(--accent);
  border: 1px solid var(--accent-dim);
  border-radius: 3px;
  padding: 1px 4px;
  margin-left: 6px;
}

/* --- SQL Editor --- */
.sql-editor {
  width: 100%;
  min-height: 160px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}

.error-box {
  background: rgba(229, 72, 77, 0.1);
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: 8px;
  padding: 10px 14px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  margin-top: 12px;
}

.empty-state {
  color: var(--text-faint);
  font-size: 13px;
  padding: 40px 0;
  text-align: center;
}

/* --- Login --- */
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-card {
  width: 320px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px;
}

.login-card h1 {
  font-size: 16px;
  margin: 0 0 20px;
}

.login-card label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin: 12px 0 4px;
}

.login-card input {
  width: 100%;
}

.login-card button {
  width: 100%;
  margin-top: 20px;
  justify-content: center;
}
PC_EOF
mkdir -p "dashboard/src/app/api/projects"
cat > "dashboard/src/app/api/projects/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { status, body } = await agentFetch("/projects");
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/projects/[id]/env"
cat > "dashboard/src/app/api/projects/[id]/env/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/projects/${id}/env`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/auth/[...nextauth]"
cat > "dashboard/src/app/api/auth/[...nextauth]/route.ts" << 'PC_EOF'
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
PC_EOF
mkdir -p "dashboard/src/app/api/domains"
cat > "dashboard/src/app/api/domains/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/domains", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/domains/[id]"
cat > "dashboard/src/app/api/domains/[id]/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/domains/${id}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/provision-tenant"
cat > "dashboard/src/app/api/provision-tenant/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { status, body: result } = await agentFetch("/tenants", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json(result, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]/tables"
cat > "dashboard/src/app/api/tenants/[slug]/tables/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { listTables } from "@/lib/tenantDb";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }
  try {
    const tables = await listTables(tenant.db_name);
    return NextResponse.json({ tables });
  } catch (err) {
    console.error("Failed to list tables:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows/edit"
cat > "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows/edit/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { updateRow, deleteRow } from "@/lib/tenantDb";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue, values } = await req.json();
  if (!pkColumn || pkValue === undefined || !values) {
    return NextResponse.json({ error: "pkColumn, pkValue, values required" }, { status: 400 });
  }

  try {
    const row = await updateRow(tenant.db_name, table, pkColumn, pkValue, values);
    return NextResponse.json({ row });
  } catch (err) {
    console.error("Failed to update row:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { pkColumn, pkValue } = await req.json();
  if (!pkColumn || pkValue === undefined) {
    return NextResponse.json({ error: "pkColumn, pkValue required" }, { status: 400 });
  }

  try {
    await deleteRow(tenant.db_name, table, pkColumn, pkValue);
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("Failed to delete row:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows"
cat > "dashboard/src/app/api/tenants/[slug]/tables/[table]/rows/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { getRows, insertRow } from "@/lib/tenantDb";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  try {
    const { rows, columns } = await getRows(tenant.db_name, table, limit, offset);
    return NextResponse.json({ rows, columns });
  } catch (err) {
    console.error("Failed to fetch rows:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; table: string }> }
) {
  const { slug, table } = await params;
  if (!TABLE_NAME_RE.test(table)) {
    return NextResponse.json({ error: "invalid table name" }, { status: 400 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const values = await req.json();
  try {
    const row = await insertRow(tenant.db_name, table, values);
    return NextResponse.json({ row }, { status: 201 });
  } catch (err) {
    console.error("Failed to insert row:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]"
cat > "dashboard/src/app/api/tenants/[slug]/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { slug } = await params;
  const { status, body } = await agentFetch(`/tenants/${slug}`, { method: "DELETE" });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants/[slug]/query"
cat > "dashboard/src/app/api/tenants/[slug]/query/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { getTenantBySlug } from "@/lib/adminDb";
import { runSql } from "@/lib/tenantDb";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { sql } = await req.json();
  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "sql required" }, { status: 400 });
  }

  try {
    const result = await runSql(tenant.db_name, sql);
    return NextResponse.json({
      rows: result.rows,
      fields: result.fields?.map((f) => f.name) ?? [],
      rowCount: result.rowCount,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
PC_EOF
mkdir -p "dashboard/src/app/api/tenants"
cat > "dashboard/src/app/api/tenants/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { listTenants } from "@/lib/adminDb";

export async function GET() {
  try {
    const tenants = await listTenants();
    return NextResponse.json({ tenants });
  } catch (err) {
    console.error("Failed to list tenants:", (err as Error).message);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
PC_EOF
mkdir -p "dashboard/src/app/api/deployments"
cat > "dashboard/src/app/api/deployments/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await req.json();
  const { status, body } = await agentFetch("/deployments", {
    method: "POST",
    body: JSON.stringify({ ...payload, triggeredBy: "manual" }),
  });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/deployments/[id]/rollback"
cat > "dashboard/src/app/api/deployments/[id]/rollback/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const payload = await req.json();
  const { status, body } = await agentFetch(`/deployments/${id}/rollback`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app/api/deployments/[id]"
cat > "dashboard/src/app/api/deployments/[id]/route.ts" << 'PC_EOF'
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { agentFetch } from "@/lib/agent";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { status, body } = await agentFetch(`/deployments/${id}`);
  return NextResponse.json(body, { status });
}
PC_EOF
mkdir -p "dashboard/src/app"
cat > "dashboard/src/app/page.tsx" << 'PC_EOF'
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();
  redirect(session ? "/dashboard/projects" : "/login");
}
PC_EOF
mkdir -p "dashboard/src/app"
cat > "dashboard/src/app/providers.tsx" << 'PC_EOF'
"use client";
import { SessionProvider } from "next-auth/react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
PC_EOF
mkdir -p "dashboard/src/app/login"
cat > "dashboard/src/app/login/page.tsx" << 'PC_EOF'
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
PC_EOF
mkdir -p "dashboard/src/app"
cat > "dashboard/src/app/layout.tsx" << 'PC_EOF'
import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Platform Console",
  description: "Multi-Tenant Datenbank- und Hosting-Konsole",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.setAttribute('data-theme',localStorage.getItem('theme')||'dark')}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/sql"
cat > "dashboard/src/app/dashboard/projects/[slug]/sql/page.tsx" << 'PC_EOF'
"use client";

import { useState, use } from "react";

interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
}

export default function SqlEditorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [sql, setSql] = useState("SELECT * FROM \n");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function runQuery() {
    setRunning(true);
    setError(null);
    const res = await fetch(`/api/tenants/${slug}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    setRunning(false);
    if (data.error) {
      setError(data.error);
      setResult(null);
    } else {
      setResult(data);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>SQL Editor</h2>
        <span className="conn-chip">
          <span className="dot" />
          kunde_{slug}@core-postgres
        </span>
      </div>

      <textarea
        className="sql-editor"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={runQuery} disabled={running}>
          {running ? "Läuft…" : "Ausführen"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>⌘/Strg + Enter</span>
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="data-table-wrap" style={{ marginTop: 16 }}>
          <table className="data-table">
            <thead>
              <tr>
                {result.fields.map((f) => (
                  <th key={f}>{f}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.fields.map((f) => (
                    <td key={f}>{String(row[f] ?? "∅")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length === 0 && (
            <div className="empty-state">Query erfolgreich, keine Zeilen zurückgegeben.</div>
          )}
        </div>
      )}
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/tables"
cat > "dashboard/src/app/dashboard/projects/[slug]/tables/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";

interface TableInfo {
  name: string;
  rowEstimate: number;
}

export default function TenantTablesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tenants/${slug}/tables`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTables(d.tables)))
      .catch(() => setError("Verbindung zur Tenant-DB fehlgeschlagen"));
  }, [slug]);

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Tabellen</h2>
        <span className="conn-chip">
          <span className="dot" />
          kunde_{slug}@core-postgres
        </span>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!tables && !error && <div className="empty-state">Verbinde…</div>}
      {tables && tables.length === 0 && (
        <div className="empty-state">Kein öffentliches Schema mit Tabellen gefunden.</div>
      )}

      <div className="card-grid">
        {tables?.map((t) => (
          <Link
            key={t.name}
            href={`/dashboard/projects/${slug}/tables/${t.name}`}
            className="card"
          >
            <div className="card-title">{t.name}</div>
            <div className="card-sub">~{t.rowEstimate.toLocaleString("de-DE")} Zeilen</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/tables/[table]"
cat > "dashboard/src/app/dashboard/projects/[slug]/tables/[table]/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";

interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

type Row = Record<string, unknown>;

const PAGE_SIZE = 50;

export default function TableEditorPage({
  params,
}: {
  params: Promise<{ slug: string; table: string }>;
}) {
  const { slug, table } = use(params);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Row>({});

  const pkColumn = columns.find((c) => c.isPrimaryKey)?.name;

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/tenants/${slug}/tables/${table}/rows?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
        } else {
          setRows(d.rows);
          setColumns(d.columns);
          setError(null);
        }
      })
      .catch(() => setError("Verbindung fehlgeschlagen"))
      .finally(() => setLoading(false));
  }, [slug, table, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveEdit(rowIndex: number, col: string) {
    const row = rows[rowIndex];
    if (!pkColumn) {
      setError("Tabelle hat keinen Primary Key — Inline-Edit nicht möglich.");
      setEditingCell(null);
      return;
    }
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pkColumn,
        pkValue: row[pkColumn],
        values: { [col]: editValue },
      }),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
    } else {
      setError(null);
      load();
    }
    setEditingCell(null);
  }

  async function handleDelete(row: Row) {
    if (!pkColumn) return;
    if (!confirm("Diese Zeile wirklich löschen?")) return;
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows/edit`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pkColumn, pkValue: row[pkColumn] }),
    });
    const data = await res.json();
    if (data.error) setError(data.error);
    else load();
  }

  async function handleInsert() {
    const res = await fetch(`/api/tenants/${slug}/tables/${table}/rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newRowValues),
    });
    const data = await res.json();
    if (data.error) {
      setError(data.error);
    } else {
      setError(null);
      setShowNewRow(false);
      setNewRowValues({});
      load();
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            <Link href={`/dashboard/projects/${slug}/tables`}>{slug}</Link> /
          </div>
          <h2 style={{ margin: 0, fontSize: 16 }}>{table}</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={load}>
            Aktualisieren
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewRow((v) => !v)}>
            + Zeile
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {showNewRow && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {columns.map((c) => (
              <div key={c.name}>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.name}</label>
                <input
                  placeholder={c.columnDefault ?? (c.isNullable ? "NULL" : "")}
                  onChange={(e) =>
                    setNewRowValues((v) => ({ ...v, [c.name]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleInsert}>
            Speichern
          </button>
        </div>
      )}

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name}>
                  {c.name}
                  {c.isPrimaryKey && <span className="pk-badge">PK</span>}
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {columns.map((c) => {
                  const isEditing = editingCell?.row === ri && editingCell.col === c.name;
                  return (
                    <td
                      key={c.name}
                      className={isEditing ? "editing" : ""}
                      onDoubleClick={() => {
                        setEditingCell({ row: ri, col: c.name });
                        setEditValue(String(row[c.name] ?? ""));
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => saveEdit(ri, c.name)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(ri, c.name);
                            if (e.key === "Escape") setEditingCell(null);
                          }}
                        />
                      ) : (
                        String(row[c.name] ?? "∅")
                      )}
                    </td>
                  );
                })}
                <td>
                  <button className="btn btn-danger" onClick={() => handleDelete(row)}>
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty-state">Keine Zeilen.</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Zurück
        </button>
        <button className="btn" disabled={rows.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
          Weiter →
        </button>
      </div>
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]"
cat > "dashboard/src/app/dashboard/projects/[slug]/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use } from "react";

interface Tenant {
  slug: string;
  db_name: string;
  tariff: string;
}

interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  default_branch: string;
  active_container: string | null;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [previewHostname, setPreviewHostname] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [webhookNote, setWebhookNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => {
        const t = d.tenants?.find((x: Tenant) => x.slug === slug);
        if (!t) setError("Projekt nicht gefunden");
        else setTenant(t);
      });
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list) => {
        const p = Array.isArray(list) ? list.find((x: Project) => x.tenant_slug === slug) : null;
        setProject(p || null);
        setPreviewHostname(p?.preview_hostname || null);
        setLoading(false);
      });
  }, [slug]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: slug,
          slug,
          repoUrl,
          defaultBranch,
          repoProvider: "github",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || "Verbinden fehlgeschlagen");
        return;
      }
      setProject(data.project);
      setPreviewHostname(data.previewHostname || null);
      setWebhookNote(
        data.githubWebhook?.registered
          ? "GitHub-Webhook automatisch registriert — Push auf den Branch löst künftig einen Deploy aus."
          : `Webhook nicht automatisch registriert (${data.githubWebhook?.reason || "unbekannt"}). Manuell nachtragen: ${data.webhookUrl}`
      );
    } catch {
      setConnectError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) alert(data.error || "Deploy fehlgeschlagen");
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  if (loading) return <div className="empty-state">Lade…</div>;
  if (error) return <div className="error-box">{error}</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{slug}</h2>
      {tenant && (
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 20 }}>
          {tenant.db_name} · Tarif {tenant.tariff}
        </div>
      )}

      {!project && (
        <form
          onSubmit={handleConnect}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          <input
            placeholder="Repo-URL (https://github.com/...)"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            style={{ minWidth: 320 }}
            required
          />
          <input
            placeholder="Branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            style={{ width: 100 }}
          />
          <button className="btn btn-primary" type="submit" disabled={connecting}>
            {connecting ? "Verbinde…" : "Projekt verbinden"}
          </button>
          {connectError && <span style={{ color: "var(--danger)" }}>{connectError}</span>}
        </form>
      )}

      {project && (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
            <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
              {deploying ? "Löse aus…" : "Deploy"}
            </button>
            {project.active_container && <span className="pk-badge">live: {project.active_container}</span>}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            Repo: {project.repo_url} ({project.default_branch})
          </div>
          {previewHostname && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Preview:{" "}
              <a href={`https://${previewHostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {previewHostname}
              </a>
            </div>
          )}
          {webhookNote && (
            <div style={{ fontSize: 12, marginTop: 10, color: "var(--text-dim)" }}>{webhookNote}</div>
          )}
        </div>
      )}
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/domains"
cat > "dashboard/src/app/dashboard/projects/[slug]/domains/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use } from "react";

interface Project {
  id: string;
  tenant_slug: string;
  preview_hostname: string | null;
}

export default function DomainsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
      });
  }, [slug]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setStatus("Registriere…");
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, hostname: host }),
      });
      const data = await res.json();
      setStatus(res.ok ? data.instructions || "DNS-Polling gestartet." : data.error || "Fehler");
      if (res.ok) setHost("");
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Domains</h2>

      {project.preview_hostname && (
        <div style={{ fontSize: 13, marginBottom: 20 }}>
          Automatische Preview-Domain (kostenlos, sofort aktiv):{" "}
          <a href={`https://${project.preview_hostname}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {project.preview_hostname}
          </a>
        </div>
      )}

      <h3 style={{ fontSize: 13, color: "var(--text-dim)" }}>Eigene Domain (später Go-Live)</h3>
      <form onSubmit={handleAdd} style={{ display: "flex", gap: 8 }}>
        <input
          placeholder="www.kunde-domain.at"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary" type="submit">Registrieren</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/env"
cat > "dashboard/src/app/dashboard/projects/[slug]/env/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use } from "react";

interface Project {
  id: string;
  tenant_slug: string;
}

export default function EnvVarsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        setProject(p || null);
      });
  }, [slug]);

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    if (!/^[A-Z0-9_]+$/.test(envKey)) {
      setStatus("Key: nur A-Z, 0-9, _ erlaubt");
      return;
    }
    setStatus("Speichere…");
    try {
      const res = await fetch(`/api/projects/${project.id}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: envValue }),
      });
      const data = await res.json();
      setStatus(res.ok ? "Gespeichert." : data.error || "Fehler");
      if (res.ok) {
        setEnvKey("");
        setEnvValue("");
      }
    } catch {
      setStatus("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (!project) return <div className="empty-state">Kein Projekt verbunden — siehe Übersicht-Tab.</div>;

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Environment Variables</h2>
      <form onSubmit={handleSet} style={{ display: "flex", gap: 8 }}>
        <input placeholder="KEY" value={envKey} onChange={(e) => setEnvKey(e.target.value.toUpperCase())} />
        <input placeholder="value" value={envValue} onChange={(e) => setEnvValue(e.target.value)} style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit">Setzen</button>
      </form>
      {status && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>{status}</div>}
      <div style={{ fontSize: 12, marginTop: 16, color: "var(--text-faint)" }}>
        Automatisch injiziert (nicht hier gesetzt): MINIO_*, S3_BUCKET_NAME, GOTRUE_URL, JWT_SECRET.
      </div>
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]"
cat > "dashboard/src/app/dashboard/projects/[slug]/layout.tsx" << 'PC_EOF'
"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";

const TABS = [
  { href: "", label: "Übersicht" },
  { href: "/tables", label: "Tabellen" },
  { href: "/sql", label: "SQL" },
  { href: "/deployments", label: "Deployments" },
  { href: "/env", label: "Env-Vars" },
  { href: "/domains", label: "Domains" },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const base = `/dashboard/projects/${slug}`;

  return (
    <div className="content">
      <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid var(--border)" }}>
        {TABS.map((t) => {
          const href = `${base}${t.href}`;
          const active = pathname === href;
          return (
            <Link
              key={t.href}
              href={href}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                color: active ? "var(--text)" : "var(--text-dim)",
                borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects/[slug]/deployments"
cat > "dashboard/src/app/dashboard/projects/[slug]/deployments/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState, use, useCallback } from "react";

interface Deployment {
  id: string;
  commit_sha: string | null;
  status: string;
  container_name: string | null;
  image_tag: string | null;
  triggered_by: string;
  created_at: string;
  finished_at: string | null;
  build_log: string;
}

interface Project {
  id: string;
  slug: string;
  tenant_slug: string;
}

const ACTIVE_STATES = ["queued", "building", "healthchecking"];

export default function DeploymentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((list: Project[]) => {
        const p = Array.isArray(list) ? list.find((x) => x.tenant_slug === slug) : null;
        if (!p) {
          setError("Kein Projekt verbunden — siehe Übersicht-Tab.");
          return;
        }
        setProject(p);
      })
      .catch(() => setError("Verbindung zum Provisioning Agent fehlgeschlagen"));
  }, [slug]);

  const loadDeployments = useCallback((projectId: string) => {
    fetch(`/api/deployments/${projectId}`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setDeployments(d))
      .catch(() => setError("Deployment-Historie konnte nicht geladen werden"));
  }, []);

  useEffect(() => {
    if (!project) return;
    loadDeployments(project.id);
    const interval = setInterval(() => {
      setDeployments((current) => {
        if (current.some((d) => ACTIVE_STATES.includes(d.status))) {
          loadDeployments(project.id);
        }
        return current;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [project, loadDeployments]);

  async function handleDeploy() {
    if (!project) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Deploy fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeploying(false);
    }
  }

  async function handleRollback(deploymentId: string) {
    if (!project) return;
    if (!confirm("Auf dieses Deployment zurückrollen?")) return;
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Rollback fehlgeschlagen");
        return;
      }
      loadDeployments(project.id);
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    }
  }

  if (error) return <div className="error-box">{error}</div>;
  if (!project) return <div className="empty-state">Lade…</div>;

  const latest = deployments[0];

  return (
    <div>
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Deployments</h2>
        <button className="btn btn-primary" onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Löse aus…" : "Deploy"}
        </button>
      </div>

      {deployments.length === 0 && <div className="empty-state">Noch kein Deployment.</div>}
      {deployments.map((d) => (
        <div
          key={d.id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 8,
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span className="pk-badge">{d.status}</span>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                {d.commit_sha?.slice(0, 7) || "—"} · {d.triggered_by} ·{" "}
                {new Date(d.created_at).toLocaleString("de-DE")}
              </span>
            </div>
            {d.status === "deployed" && d.id !== latest?.id && (
              <button className="btn" onClick={() => handleRollback(d.id)}>
                Rollback hierauf
              </button>
            )}
          </div>
          {ACTIVE_STATES.includes(d.status) && d.build_log && (
            <pre
              style={{
                marginTop: 8,
                maxHeight: 200,
                overflowY: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                background: "var(--bg)",
                padding: 8,
                borderRadius: 6,
                whiteSpace: "pre-wrap",
              }}
            >
              {d.build_log}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard/projects"
cat > "dashboard/src/app/dashboard/projects/page.tsx" << 'PC_EOF'
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  created_at: string;
}

interface Project {
  slug: string;
  tenant_slug: string;
  repo_url: string | null;
  active_container: string | null;
}

export default function ProjectsPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [tariff, setTariff] = useState("starter");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  function load() {
    setTenants(null);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTenants(d.tenants)))
      .catch(() => setError("Verbindung zum Dashboard fehlgeschlagen"));
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setProjects(d))
      .catch(() => {});
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setFormError("Slug: nur a-z, 0-9, - erlaubt");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const res = await fetch("/api/provision-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantSlug: slug, tenantName: slug, tariff }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Provisioning fehlgeschlagen");
        return;
      }
      setSlug("");
      setShowForm(false);
      load();
    } catch {
      setFormError("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(s: string) {
    if (!confirm(`Projekt "${s}" wirklich löschen? DB, Container, App und Bucket werden entfernt.`)) return;
    setDeletingSlug(s);
    try {
      const res = await fetch(`/api/tenants/${s}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Löschen fehlgeschlagen");
        return;
      }
      load();
    } catch {
      alert("Verbindung zum Provisioning Agent fehlgeschlagen");
    } finally {
      setDeletingSlug(null);
    }
  }

  return (
    <div className="content">
      <div className="topbar" style={{ padding: 0, border: "none", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Projekte</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Abbrechen" : "+ Neues Projekt"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 18,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
          }}
        >
          <input
            placeholder="slug (z.B. gutshof)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
          />
          <select value={tariff} onChange={(e) => setTariff(e.target.value)}>
            <option value="starter">Starter</option>
            <option value="business">Business</option>
            <option value="premium">Premium</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? "Provisioniere… (~10-15s)" : "Anlegen"}
          </button>
          {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
        </form>
      )}

      {error && <div className="error-box">{error}</div>}
      {!tenants && !error && <div className="empty-state">Lade Projekte…</div>}
      {tenants && tenants.length === 0 && (
        <div className="empty-state">Noch keine Projekte angelegt.</div>
      )}

      <div className="card-grid">
        {tenants?.map((t) => {
          const project = projects.find((p) => p.tenant_slug === t.slug);
          return (
            <div key={t.id} className="card" style={{ position: "relative" }}>
              <Link href={`/dashboard/projects/${t.slug}`}>
                <div className="card-title">{t.slug}</div>
                <div className="card-sub">
                  {project ? project.repo_url || "Repo nicht gesetzt" : "Kein Projekt verbunden"}
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                  <span className="pk-badge">{t.tariff}</span>
                  {project?.active_container && <span className="pk-badge">live</span>}
                </div>
              </Link>
              <button
                className="btn"
                style={{ position: "absolute", top: 10, right: 10, color: "var(--danger)" }}
                onClick={(e) => {
                  e.preventDefault();
                  handleDelete(t.slug);
                }}
                disabled={deletingSlug === t.slug}
              >
                {deletingSlug === t.slug ? "…" : "Löschen"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src/app/dashboard"
cat > "dashboard/src/app/dashboard/layout.tsx" << 'PC_EOF'
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          UP2 <span>Console</span>
        </div>
        <Link href="/dashboard/projects" className="nav-link">
          Projekte
        </Link>
        <div style={{ flex: 1 }} />
        <ThemeToggle />
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="nav-link" style={{ width: "100%", textAlign: "left" }}>
            Abmelden
          </button>
        </form>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
PC_EOF
mkdir -p "dashboard/src"
cat > "dashboard/src/auth.ts" << 'PC_EOF'
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-Mail", type: "email" },
        password: { label: "Passwort", type: "password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const adminEmail = process.env.ADMIN_EMAIL;
        const adminHash = process.env.ADMIN_PASSWORD_HASH;
        if (!adminEmail || !adminHash) return null;

        if (email.toLowerCase() !== adminEmail.toLowerCase()) return null;
        const valid = await bcrypt.compare(password, adminHash);
        if (!valid) return null;

        return { id: "admin", email: adminEmail, name: "Admin" };
      },
    }),
  ],
});
PC_EOF
mkdir -p "dashboard/src"
cat > "dashboard/src/auth.config.ts" << 'PC_EOF'
import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized: ({ auth }) => !!auth,
  },
} satisfies NextAuthConfig;
PC_EOF
mkdir -p "dashboard/src/lib"
cat > "dashboard/src/lib/pg-format.d.ts" << 'PC_EOF'
declare module "pg-format";
PC_EOF
mkdir -p "dashboard/src/lib"
cat > "dashboard/src/lib/adminDb.ts" << 'PC_EOF'
import { Pool } from "pg";

// Verbindung zur admin_dashboard-DB. Läuft über pgbouncer, wie in
// 10_env_reference.md § 2 (DATABASE_URL) vorgesehen.
let adminPool: Pool | null = null;

function getAdminPool(): Pool {
  if (!adminPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL fehlt (siehe 10_env_reference.md § 2)");
    }
    adminPool = new Pool({ connectionString, max: 5 });
  }
  return adminPool;
}

export interface Tenant {
  id: string;
  slug: string;
  db_name: string;
  tariff: string;
  created_at: string;
}

export async function listTenants(): Promise<Tenant[]> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, created_at FROM kunden ORDER BY created_at DESC"
  );
  return rows;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Tenant>(
    "SELECT id, slug, db_name, tariff, created_at FROM kunden WHERE slug = $1",
    [slug]
  );
  return rows[0] ?? null;
}
PC_EOF
mkdir -p "dashboard/src/lib"
cat > "dashboard/src/lib/agent.ts" << 'PC_EOF'
const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;

export async function agentFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Secret": AGENT_SECRET,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
PC_EOF
mkdir -p "dashboard/src/lib"
cat > "dashboard/src/lib/tenantDb.ts" << 'PC_EOF'
import { Pool, QueryResult } from "pg";
import format from "pg-format";

const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || "pgbouncer";

// Ein Pool pro Tenant-DB, wiederverwendet über Requests hinweg (Next.js-Server-Prozess
// lebt dauerhaft). Verbindet als 'postgres'-Superuser -> Table Editor braucht vollen
// Zugriff (Schema lesen, DDL perspektivisch), anders als der eingeschränkte
// 'authenticator'-Role, den PostgREST/GoTrue nutzen (siehe 10_env_reference.md § 4).
const tenantPools = new Map<string, Pool>();

function getTenantPool(dbName: string): Pool {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error("invalid db name");
  }
  let pool = tenantPools.get(dbName);
  if (!pool) {
    pool = new Pool({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
      max: 3,
    });
    tenantPools.set(dbName, pool);
  }
  return pool;
}

export interface TableInfo {
  name: string;
  rowEstimate: number;
}

export async function listTables(dbName: string): Promise<TableInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows } = await pool.query<{ table_name: string; row_estimate: string }>(
    `SELECT c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`
  );
  return rows.map((r) => ({ name: r.table_name, rowEstimate: Number(r.row_estimate) }));
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  columnDefault: string | null;
}

export async function getTableColumns(dbName: string, table: string): Promise<ColumnInfo[]> {
  const pool = getTenantPool(dbName);
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const { rows: pk } = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = format('public.%I', $1)::regclass AND i.indisprimary`,
    [table]
  );
  const pkNames = new Set(pk.map((r) => r.column_name));
  return cols.map((c) => ({
    name: c.column_name,
    dataType: c.data_type,
    isNullable: c.is_nullable === "YES",
    isPrimaryKey: pkNames.has(c.column_name),
    columnDefault: c.column_default,
  }));
}

export async function getRows(
  dbName: string,
  table: string,
  limit: number,
  offset: number
): Promise<{ rows: Record<string, unknown>[]; columns: ColumnInfo[] }> {
  const pool = getTenantPool(dbName);
  const columns = await getTableColumns(dbName, table);
  const sql = format("SELECT * FROM %I.%I LIMIT %L OFFSET %L", "public", table, limit, offset);
  const { rows } = await pool.query(sql);
  return { rows, columns };
}

export async function insertRow(
  dbName: string,
  table: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = format(
    "INSERT INTO %I.%I (%s) VALUES (%s) RETURNING *",
    "public",
    table,
    cols.map((c) => format("%I", c)).join(", "),
    placeholders.join(", ")
  );
  const { rows } = await pool.query<Record<string, unknown>>(sql, Object.values(values));
  return rows[0];
}

export async function updateRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const pool = getTenantPool(dbName);
  const cols = Object.keys(values);
  const setClauses = cols.map((c, i) => format("%I = $%s", c, i + 1)).join(", ");
  const sql = format(
    "UPDATE %I.%I SET %s WHERE %I = $%s RETURNING *",
    "public",
    table,
    setClauses,
    pkColumn,
    cols.length + 1
  );
  const { rows } = await pool.query<Record<string, unknown>>(sql, [
    ...Object.values(values),
    pkValue,
  ]);
  return rows[0];
}

export async function deleteRow(
  dbName: string,
  table: string,
  pkColumn: string,
  pkValue: unknown
): Promise<void> {
  const pool = getTenantPool(dbName);
  const sql = format("DELETE FROM %I.%I WHERE %I = $1", "public", table, pkColumn);
  await pool.query(sql, [pkValue]);
}

// SQL-Editor: freie Query-Ausführung. Bewusst ohne Statement-Whitelist -
// Dashboard ist single-admin-only (Cloudflare Zero Trust + NextAuth davor),
// analog zum echten Supabase SQL Editor.
export async function runSql(dbName: string, sql: string): Promise<QueryResult> {
  const pool = getTenantPool(dbName);
  return pool.query(sql);
}
PC_EOF
mkdir -p "provisioning-agent/src"
cat > "provisioning-agent/src/index.ts" << 'PC_EOF'
import express from 'express';
import { Client } from 'pg';
import format from 'pg-format';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import crypto from 'crypto';
import { projectsRouter } from './routes/projects';
import { deploymentsRouter } from './routes/deployments';
import { domainsRouter } from './routes/domains';
import { webhooksRouter } from './routes/webhooks';
import { encrypt } from './lib/crypto';

const execFileP = promisify(execFile);
const app = express();

const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';

app.use('/webhooks', express.raw({ type: 'application/json', limit: '5mb' }), webhooksRouter);

app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.post('/tenants', async (req, res) => {
  const { tenantSlug, tariff } = req.body;
  const tenantTariff = ['starter','business','premium'].includes(tariff) ? tariff : 'starter';

  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  const dbName = `kunde_${tenantSlug}`;
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const authenticatorPw = crypto.randomBytes(16).toString('hex');

  try {
    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    await master.query(format('CREATE DATABASE %I;', dbName));
    await master.end();

    const tenant = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/${dbName}`,
    });
    await tenant.connect();
    const rolesSql = await readFile('/opt/multitenant-platform/core-postgres/init-scripts/01_roles.sql', 'utf8');
    await tenant.query(rolesSql.replace(/CHANGE_ME/g, authenticatorPw));
    await tenant.query(`ALTER ROLE authenticator WITH PASSWORD '${authenticatorPw}';`);
    await tenant.query(`CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION authenticator;`);
    await tenant.query(`GRANT ALL ON SCHEMA auth TO authenticator;`);
    await tenant.end();

    const tierPrefix = tenantTariff.toUpperCase();
    const postgrestMem = process.env[`${tierPrefix}_POSTGREST_MEM`] || '64m';
    const postgrestCpus = process.env[`${tierPrefix}_POSTGREST_CPUS`] || '0.25';
    const gotrueMem = process.env[`${tierPrefix}_GOTRUE_MEM`] || '128m';
    const gotrueCpus = process.env[`${tierPrefix}_GOTRUE_CPUS`] || '0.25';

    const template = await readFile('/app/templates/tenant-compose.yml', 'utf8');
    const compose = template
      .replace(/\$\{SLUG\}/g, tenantSlug)
      .replace(/\$\{JWT_SECRET\}/g, jwtSecret)
      .replace(/\$\{AUTH_PW\}/g, authenticatorPw)
      .replace(/\$\{PLATFORM_DOMAIN\}/g, process.env.PLATFORM_DOMAIN as string)
      .replace(/\$\{POSTGREST_MEM\}/g, postgrestMem)
      .replace(/\$\{POSTGREST_CPUS\}/g, postgrestCpus)
      .replace(/\$\{GOTRUE_MEM\}/g, gotrueMem)
      .replace(/\$\{GOTRUE_CPUS\}/g, gotrueCpus)
      .replace(/\$\{RESEND_API_KEY\}/g, '')
      .replace(/\$\{TENANT_NAME\}/g, tenantSlug);

    const tenantDir = `/opt/multitenant-platform/kunden-instances/${tenantSlug}`;
    await mkdir(tenantDir, { recursive: true });
    await writeFile(`${tenantDir}/docker-compose.yml`, compose);

    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d', 'auth']);
    await new Promise((r) => setTimeout(r, 8000));

    await execFileP('mc', ['alias', 'set', 'localminio', 'http://core-minio:9000', process.env.MINIO_ROOT_USER!, process.env.MINIO_ROOT_PASSWORD!]);
    try {
      await execFileP('mc', ['mb', `localminio/kunde-${tenantSlug}-storage`]);
    } catch (e: any) {
      if (!e.message.includes('already own it')) throw e;
    }

    const minioAccessKey = crypto.randomBytes(16).toString('hex');
    const minioSecretKey = crypto.randomBytes(24).toString('hex');
    await execFileP('mc', ['admin', 'user', 'add', 'localminio', minioAccessKey, minioSecretKey]);
    const policyDoc = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        Resource: [
          `arn:aws:s3:::kunde-${tenantSlug}-storage`,
          `arn:aws:s3:::kunde-${tenantSlug}-storage/*`,
        ],
      }],
    });
    const policyPath = `/tmp/policy-${tenantSlug}.json`;
    await writeFile(policyPath, policyDoc);
    await execFileP('mc', ['admin', 'policy', 'create', 'localminio', `kunde-${tenantSlug}-policy`, policyPath]);
    await execFileP('mc', ['admin', 'policy', 'attach', 'localminio', `kunde-${tenantSlug}-policy`, '--user', minioAccessKey]);

    await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d', 'api']);

    const admin = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin.connect();
    await admin.query(
      'INSERT INTO kunden (slug, db_name, tariff, gotrue_jwt_secret, authenticator_password, minio_access_key, minio_secret_key_encrypted) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [tenantSlug, dbName, tenantTariff, jwtSecret, authenticatorPw, minioAccessKey, encrypt(minioSecretKey)]
    );
    await admin.end();

    res.json({ status: 'ok', slug: tenantSlug, dbName });
  } catch (err: any) {
    console.error('Provisioning failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.delete('/tenants/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  const dbName = `kunde_${slug}`;
  const tenantDir = `/opt/multitenant-platform/kunden-instances/${slug}`;

  try {
    try {
      await execFileP('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'down']);
    } catch (e: any) {
      console.error('Container stop failed (continuing):', e.message);
    }

    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    await master.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
    await master.query(format('DROP DATABASE IF EXISTS %I;', dbName));
    await master.end();

    try {
      await execFileP('mc', ['rb', '--force', `localminio/kunde-${slug}-storage`]);
    } catch (e: any) {
      console.error('MinIO bucket removal failed (continuing):', e.message);
    }

    const admin2 = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
    });
    await admin2.connect();
    const { rows } = await admin2.query('SELECT minio_access_key FROM kunden WHERE slug = $1', [slug]);
    if (rows[0]?.minio_access_key) {
      try {
        await execFileP('mc', ['admin', 'user', 'remove', 'localminio', rows[0].minio_access_key]);
      } catch (e: any) {
        console.error('MinIO user removal failed (continuing):', e.message);
      }
    }
    try {
      await execFileP('mc', ['admin', 'policy', 'remove', 'localminio', `kunde-${slug}-policy`]);
    } catch (e: any) {
      console.error('MinIO policy removal failed (continuing):', e.message);
    }

    await execFileP('rm', ['-rf', tenantDir]);

    await admin2.query('DELETE FROM kunden WHERE slug = $1', [slug]);
    await admin2.end();

    res.json({ status: 'ok', slug });
  } catch (err: any) {
    console.error('Tenant deletion failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(projectsRouter);
app.use(deploymentsRouter);
app.use(domainsRouter);


app.get('/stats', async (_req, res) => {
  try {
    const { stdout } = await execFileP('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    const containers = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const master = new Client({
      connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/postgres`,
    });
    await master.connect();
    const { rows: dbConnections } = await master.query(
      "SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE datname LIKE 'kunde_%' GROUP BY datname"
    );
    await master.end();

    res.json({ containers, dbConnections });
  } catch (err: any) {
    console.error('Stats fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => console.log('Provisioning Agent (mit Deployment Engine) listening on :3001'));
PC_EOF
mkdir -p "provisioning-agent/src"
cat > "provisioning-agent/src/pg-format.d.ts" << 'PC_EOF'
declare module 'pg-format';
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/secrets.ts" << 'PC_EOF'
import { Client as PGClient } from 'pg';
import { decrypt } from './crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export interface TenantSecrets {
  gotrueJwtSecret: string;
  minioAccessKey: string;
  minioSecretKey: string;
}

/**
 * Holt die pro-Kunde-Secrets aus admin_dashboard.kunden (entschlüsselt) für die
 * Auto-Env-Injection in den Kunden-App-Container (siehe 05_deployment_engine_specification.md § 4.1).
 */
export async function getTenantSecrets(tenantSlug: string): Promise<TenantSecrets> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT gotrue_jwt_secret, minio_access_key, minio_secret_key_encrypted
       FROM kunden WHERE slug = $1`,
      [tenantSlug]
    );
    if (rows.length === 0) throw new Error(`tenant not found: ${tenantSlug}`);
    const row = rows[0];
    return {
      gotrueJwtSecret: row.gotrue_jwt_secret,
      minioAccessKey: row.minio_access_key,
      minioSecretKey: row.minio_secret_key_encrypted ? decrypt(row.minio_secret_key_encrypted) : '',
    };
  } finally {
    await db.end();
  }
}

/**
 * Holt manuell im Dashboard gesetzte project_env_vars (entschlüsselt).
 */
export async function getProjectEnvVars(projectId: string): Promise<Record<string, string>> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT key, value_encrypted FROM project_env_vars WHERE project_id = $1`,
      [projectId]
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = decrypt(row.value_encrypted);
    }
    return out;
  } finally {
    await db.end();
  }
}

/**
 * Baut die vollständige Env-Var-Liste für den `docker run`-Aufruf: Tenant-Secrets
 * (MinIO, GoTrue) + manuell gesetzte project_env_vars. Nie geloggt im Klartext.
 */
export async function buildEnvVars(
  tenantSlug: string,
  projectId: string
): Promise<Record<string, string>> {
  const tenant = await getTenantSecrets(tenantSlug);
  const projectVars = await getProjectEnvVars(projectId);

  return {
    MINIO_ENDPOINT: 'http://core-minio:9000',
    MINIO_ACCESS_KEY: tenant.minioAccessKey,
    MINIO_SECRET_KEY: tenant.minioSecretKey,
    S3_BUCKET_NAME: `kunde-${tenantSlug}-storage`,
    GOTRUE_URL: `http://auth-${tenantSlug}:9999`,
    JWT_SECRET: tenant.gotrueJwtSecret,
    ...projectVars,
  };
}
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/deploy.ts" << 'PC_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client as PGClient } from 'pg';
import { checkoutRepo } from './git';
import { nixpacksBuild } from './nixpacks';
import { buildEnvVars } from './secrets';
import { maskSecrets } from './crypto';

const execFileP = promisify(execFile);

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

const TARIFF_LIMITS: Record<string, { mem: string; cpus: string }> = {
  starter: { mem: '256m', cpus: '0.5' },
  business: { mem: '512m', cpus: '1' },
  premium: { mem: '1g', cpus: '2' },
};

export interface Project {
  id: string;
  tenant_slug: string;
  slug: string;
  repo_url: string;
  default_branch: string;
  build_command: string | null;
  active_container: string | null;
  preview_hostname: string;
}

async function updateDeployment(
  db: PGClient,
  deploymentId: string,
  fields: { status?: string; build_log?: string; container_name?: string; image_tag?: string; finished_at?: boolean }
) {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); vals.push(fields.status); }
  if (fields.build_log !== undefined) { sets.push(`build_log = $${i++}`); vals.push(fields.build_log); }
  if (fields.container_name !== undefined) { sets.push(`container_name = $${i++}`); vals.push(fields.container_name); }
  if (fields.image_tag !== undefined) { sets.push(`image_tag = $${i++}`); vals.push(fields.image_tag); }
  if (fields.finished_at) { sets.push(`finished_at = now()`); }
  vals.push(deploymentId);
  await db.query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * Prüft Health eines internen Containers via HTTP-Request von innerhalb des
 * Provisioning-Agent-Containers (der selbst auf traefik-net hängt) — kein curl/wget
 * im Zielcontainer nötig, kein Shell-Exec, reines Node `fetch`.
 */
async function pollHealthcheck(containerName: string, port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${containerName}:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // Container noch nicht bereit — weiter pollen.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Voller Deploy-Flow für ein Projekt, entspricht 05_deployment_engine_specification.md § 4.
 * Läuft asynchron im Hintergrund; der aufrufende Endpoint gibt sofort die deploymentId zurück
 * und der Status wird über GET /deployments/:projectId pollbar aktualisiert.
 */
export async function runDeployment(
  project: Project,
  ref: string,
  triggeredBy: 'webhook' | 'manual' | 'api',
  tariff: string,
  deploymentId: string
): Promise<void> {
  const db = adminClient();
  await db.connect();
  let buildLog = '';

  try {
    await updateDeployment(db, deploymentId, { status: 'building' });

    // 1. Repo auschecken
    const { path: buildPath, resolvedSha } = await checkoutRepo(project.slug, project.repo_url, ref);
    buildLog += `Checked out ${resolvedSha} for ${project.slug}\n`;
    await db.query('UPDATE deployments SET commit_sha = $1 WHERE id = $2', [resolvedSha, deploymentId]);

    // 2. Nixpacks-Build
    const imageTag = `app-${project.slug}:${resolvedSha.slice(0, 12)}`;
    const buildResult = await nixpacksBuild(buildPath, imageTag, project.build_command || undefined);
    buildLog += buildResult.log;
    await updateDeployment(db, deploymentId, { build_log: buildLog, image_tag: imageTag });

    // 3. Env-Vars sammeln (Tenant-Secrets + manuelle project_env_vars, Auto-Injection)
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    // 4. Neuen Container starten (interner Name, noch ohne öffentliche Traefik-Labels)
    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const newContainerName = `app-${project.slug}-${resolvedSha.slice(0, 8)}`;
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', newContainerName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      ...envArgs,
      imageTag,
    ]);
    buildLog += `Started candidate container ${newContainerName}\n`;
    await updateDeployment(db, deploymentId, { status: 'healthchecking', build_log: maskSecrets(buildLog), container_name: newContainerName });

    // 5. Healthcheck gegen den neuen Container (intern, noch kein Traffic)
    const healthy = await pollHealthcheck(newContainerName, 3000, 60_000);
    if (!healthy) {
      buildLog += `Healthcheck FAILED for ${newContainerName} — rolling back, old container bleibt aktiv.\n`;
      await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }
    buildLog += `Healthcheck OK\n`;

    // 6. Traffic umschalten: neuen Container mit öffentlichem Namen + Traefik-Labels final starten,
    //    alten Container beiseiteschieben (nicht sofort löschen — Rollback-Fallback).
    const publicName = `app-${project.slug}`;
    const oldBackupName = `${publicName}-old-${Date.now()}`;

    const { stdout: existing } = await execFileP('docker', ['ps', '-aq', '--filter', `name=^/${publicName}$`]);
    const hadPrevious = existing.trim().length > 0;
    if (hadPrevious) {
      await execFileP('docker', ['rename', publicName, oldBackupName]);
      await execFileP('docker', ['stop', oldBackupName]).catch(() => {});
    }

    // Candidate-Container droppen und mit finalem Namen + Labels neu starten
    // (Docker erlaubt kein nachträgliches Hinzufügen von Labels zu einem laufenden Container).
    await execFileP('docker', ['rm', '-f', newContainerName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=3000`,
      ...envArgs,
      imageTag,
    ]);

    const finalHealthy = await pollHealthcheck(publicName, 3000, 30_000);
    if (!finalHealthy) {
      // Rollback: finalen Container entfernen, alten wiederherstellen
      buildLog += `Final container failed post-swap healthcheck — rolling back to previous container.\n`;
      await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
      if (hadPrevious) {
        await execFileP('docker', ['rename', oldBackupName, publicName]);
        await execFileP('docker', ['start', publicName]);
      }
      await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true });
      return;
    }

    // 7. Alten Container endgültig entfernen
    if (hadPrevious) {
      await execFileP('docker', ['rm', '-f', oldBackupName]).catch(() => {});
    }
    buildLog += `Deployed ${publicName} (${imageTag}) — live traffic switched.\n`;

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [
      publicName, deploymentId, project.id,
    ]);
    await updateDeployment(db, deploymentId, { status: 'deployed', build_log: maskSecrets(buildLog), container_name: publicName, finished_at: true });
  } catch (err: any) {
    buildLog += `\nError: ${err.buildLog || err.message}`;
    await updateDeployment(db, deploymentId, { status: 'failed', build_log: maskSecrets(buildLog), finished_at: true }).catch(() => {});
  } finally {
    await db.end();
  }
}

/**
 * Rollback: letzten erfolgreichen Deployment-Eintrag (vor dem aktuellen) erneut ausrollen,
 * ohne neu zu bauen — Image ist lokal noch getaggt (siehe § 4, "Images bleiben lokal getaggt").
 */
export async function rollbackToDeployment(project: Project, targetDeploymentId: string, tariff: string): Promise<void> {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT * FROM deployments WHERE id = $1 AND project_id = $2', [targetDeploymentId, project.id]);
    if (rows.length === 0) throw new Error('deployment not found');
    const target = rows[0];
    if (!target.image_tag) throw new Error('target deployment has no image_tag — cannot roll back');

    const limits = TARIFF_LIMITS[tariff] || TARIFF_LIMITS.starter;
    const envVars = await buildEnvVars(project.tenant_slug, project.id);
    const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const publicName = `app-${project.slug}`;

    await execFileP('docker', ['rm', '-f', publicName]).catch(() => {});
    await execFileP('docker', [
      'run', '-d',
      '--name', publicName,
      '--network', 'traefik-net',
      `--memory=${limits.mem}`,
      `--cpus=${limits.cpus}`,
      '--label', 'traefik.enable=true',
      '--label', `traefik.http.routers.${project.slug}-app.rule=Host(\`${project.preview_hostname}\`)`,
      '--label', `traefik.http.routers.${project.slug}-app.entrypoints=websecure`,
      '--label', `traefik.http.routers.${project.slug}-app.tls.certresolver=myresolver`,
      '--label', `traefik.http.services.${project.slug}-app.loadbalancer.server.port=3000`,
      ...envArgs,
      target.image_tag,
    ]);

    await db.query('UPDATE projects SET active_container = $1, active_deployment_id = $2 WHERE id = $3', [publicName, targetDeploymentId, project.id]);
    await db.query(
      `INSERT INTO deployments (project_id, commit_sha, status, container_name, image_tag, triggered_by, finished_at)
       VALUES ($1, $2, 'rolled_back', $3, $4, 'api', now())`,
      [project.id, target.commit_sha, publicName, target.image_tag]
    );
  } finally {
    await db.end();
  }
}
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/git.ts" << 'PC_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

const BUILDS_ROOT = '/opt/multitenant-platform/deployments/builds';

/**
 * Klont (oder pullt, falls bereits vorhanden) ein Repo für ein Projekt und checkt
 * den angeforderten Commit/Branch aus. Gibt den lokalen Pfad + aufgelösten commit_sha zurück.
 *
 * Nutzt ausschließlich execFile mit Argument-Arrays — keine Shell-String-Konkatenation
 * (repo_url kommt aus der DB, ist aber trotzdem nie Teil eines Shell-Strings, siehe CLAUDE.md § 1.1).
 */
export async function checkoutRepo(
  projectSlug: string,
  repoUrl: string,
  ref: string // Branch-Name oder Commit-SHA
): Promise<{ path: string; resolvedSha: string }> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for git checkout');
  }

  const repoDir = `${BUILDS_ROOT}/${projectSlug}/repo`;

  if (!existsSync(repoDir)) {
    await execFileP('mkdir', ['-p', repoDir]);
    await execFileP('git', ['clone', '--no-single-branch', repoUrl, repoDir]);
  } else {
    await execFileP('git', ['-C', repoDir, 'fetch', '--all', '--prune']);
  }

  // ref kann Branch oder SHA sein — 'git checkout' handhabt beides.
  await execFileP('git', ['-C', repoDir, 'checkout', ref]);
  // Falls ref ein Branch war: auf neuesten Remote-Stand ziehen.
  await execFileP('git', ['-C', repoDir, 'reset', '--hard', `origin/${ref}`]).catch(() => {
    // Kein Remote-Branch dieses Namens (z.B. weil ref bereits ein SHA war) — ignorieren.
  });

  const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const resolvedSha = stdout.trim();

  // Isolierter Build-Snapshot pro Commit, damit parallele Deploys sich nicht in die Quere kommen.
  const commitDir = `${BUILDS_ROOT}/${projectSlug}/${resolvedSha.slice(0, 12)}`;
  await execFileP('rm', ['-rf', commitDir]);
  await execFileP('cp', ['-r', repoDir, commitDir]);

  return { path: commitDir, resolvedSha };
}

/**
 * Verifiziert eine GitHub-Webhook-Signatur (X-Hub-Signature-256, HMAC-SHA256).
 * Timing-safe Vergleich, siehe 05_deployment_engine_specification.md § 6.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/traefikDynamic.ts" << 'PC_EOF'
import { writeFile, unlink } from 'fs/promises';

const DYNAMIC_DIR = '/opt/multitenant-platform/traefik/dynamic';

/**
 * Schreibt/aktualisiert einen Traefik File-Provider-Router für eine Custom Domain.
 * Traefik v3 watcht dieses Verzeichnis (`--providers.file.watch=true`, siehe
 * 02_vps_bootstrap_guide.md § 5.1) — kein Container-Neustart nötig.
 *
 * WICHTIG: hostname und containerName werden NIE in einen Shell-Befehl interpoliert,
 * nur in eine YAML-Struktur (Template-Literal ist hier unkritisch, da direkt in eine
 * Datei geschrieben wird, nicht an eine Shell übergeben — siehe CLAUDE.md § 1.1 vs § 2.2).
 */
export async function writeCustomDomainRouter(
  projectSlug: string,
  hostname: string,
  containerName: string,
  containerPort = 3000
): Promise<void> {
  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('invalid hostname for traefik router');
  }
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for traefik router');
  }

  const routerName = `app-${projectSlug}-custom`;
  const serviceName = `app-${projectSlug}`;

  const yaml = `http:
  routers:
    ${routerName}:
      rule: "Host(\`${hostname}\`)"
      entryPoints:
        - websecure
      service: ${serviceName}
      tls:
        certResolver: myresolver
  services:
    ${serviceName}:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${containerPort}"
`;

  await writeFile(`${DYNAMIC_DIR}/${projectSlug}.yml`, yaml, 'utf8');
}

export async function removeCustomDomainRouter(projectSlug: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error('invalid project slug for traefik router removal');
  }
  await unlink(`${DYNAMIC_DIR}/${projectSlug}.yml`).catch(() => {
    /* Datei existiert nicht — ignorieren */
  });
}
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/crypto.ts" << 'PC_EOF'
import crypto from 'crypto';

// ENCRYPTION_MASTER_KEY: 256-bit (32 byte) key, hex-encoded, aus .env (siehe 10_env_reference.md § 5.2)
// NIEMALS in der DB speichern, NIEMALS loggen.
const MASTER_KEY_HEX = process.env.ENCRYPTION_MASTER_KEY;

function getKey(): Buffer {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    throw new Error('ENCRYPTION_MASTER_KEY fehlt oder hat falsche Länge (muss 64 hex chars / 32 bytes sein)');
  }
  return Buffer.from(MASTER_KEY_HEX, 'hex');
}

/**
 * Verschlüsselt einen Klartext-String mit AES-256-GCM.
 * Rückgabeformat (Buffer, direkt in BYTEA-Spalte speicherbar): [12 byte IV][16 byte authTag][ciphertext]
 */
export function encrypt(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Entschlüsselt einen Buffer, der mit encrypt() erzeugt wurde.
 */
export function decrypt(payload: Buffer): string {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Maskiert Secret-Patterns in Log-/Build-Output, bevor er in `deployments.build_log` geschrieben
 * oder in die Console geloggt wird. Siehe CLAUDE.md § 1.5.
 */
export function maskSecrets(input: string): string {
  return input.replace(
    /(JWT_SECRET|PASSWORD|API_KEY|SECRET_KEY|TOKEN|WEBHOOK_SECRET)=\S+/gi,
    '$1=***'
  );
}
PC_EOF
mkdir -p "provisioning-agent/src/lib"
cat > "provisioning-agent/src/lib/nixpacks.ts" << 'PC_EOF'
import { execFile } from 'child_process';
import { promisify } from 'util';
import { maskSecrets } from './crypto';

const execFileP = promisify(execFile);

/**
 * Baut ein OCI-Image aus dem ausgecheckten Repo-Pfad via Nixpacks v1.41.0.
 * Respektiert ein vorhandenes Dockerfile im Repo automatisch (Nixpacks-Default-Verhalten).
 *
 * Rückgabe: gebauter Image-Tag + (secret-maskiertes) Build-Log für die `deployments.build_log`-Spalte.
 */
export async function nixpacksBuild(
  buildPath: string,
  imageTag: string,
  buildCommand?: string
): Promise<{ imageTag: string; log: string }> {
  const args = ['build', buildPath, '--name', imageTag];
  if (buildCommand) {
    // Nixpacks erlaubt Override einzelner Build-Phasen über --build-cmd.
    // buildCommand kommt aus project.build_command (DB), wird NIE in eine Shell interpoliert —
    // hier als eigenes Argument im Array, execFile führt kein Shell-Parsing durch.
    args.push('--build-cmd', buildCommand);
  }

  try {
    const { stdout, stderr } = await execFileP('nixpacks', args, {
      maxBuffer: 1024 * 1024 * 32, // 32MB — Build-Logs können lang werden
      timeout: 10 * 60 * 1000, // 10 Minuten Hard-Timeout pro Build
    });
    return { imageTag, log: maskSecrets(stdout + '\n' + stderr) };
  } catch (err: any) {
    const log = maskSecrets((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + err.message);
    throw Object.assign(new Error('nixpacks build failed'), { buildLog: log });
  }
}
PC_EOF
mkdir -p "provisioning-agent/src/routes"
cat > "provisioning-agent/src/routes/domains.ts" << 'PC_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import dns from 'dns/promises';
import { writeCustomDomainRouter, removeCustomDomainRouter } from '../lib/traefikDynamic';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const VPS_IP = process.env.VPS_PUBLIC_IP; // aus .env, für den A-Record-Vergleich

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const domainsRouter = Router();

// POST /domains — Custom Domain für ein Projekt registrieren, DNS-Polling im Hintergrund starten
domainsRouter.post('/domains', async (req, res) => {
  const { projectId, hostname } = req.body;
  if (!projectId || !hostname) return res.status(400).json({ error: 'projectId and hostname required' });
  if (!/^[a-z0-9.-]+$/.test(hostname)) return res.status(400).json({ error: 'invalid hostname' });

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO domains (project_id, hostname, kind) VALUES ($1, $2, 'custom') RETURNING id`,
      [projectId, hostname]
    );
    res.json({
      status: 'pending_dns',
      domainId: rows[0].id,
      instructions: VPS_IP
        ? `Lege einen A-Record an: ${hostname} → ${VPS_IP}`
        : `Lege einen A-Record auf die VPS-IP an (VPS_PUBLIC_IP ist im Agent-.env nicht gesetzt).`,
    });

    // Hintergrund-Polling (60s Intervall, max 30min) — analog Dashboard-seitigem Polling in Doc 05 §5.2.
    // Läuft hier serverseitig, damit es auch funktioniert wenn niemand das Dashboard offen hat.
    pollDnsAndActivate(rows[0].id, projectId, hostname).catch((err) =>
      console.error(`DNS polling for ${hostname} failed:`, err.message)
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

async function pollDnsAndActivate(domainId: string, projectId: string, hostname: string): Promise<void> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const addresses = await dns.resolve4(hostname);
      if (!VPS_IP || addresses.includes(VPS_IP)) {
        const db = adminClient();
        await db.connect();
        try {
          const { rows } = await db.query('SELECT slug, active_container FROM projects WHERE id = $1', [projectId]);
          if (rows.length === 0) return;
          const containerName = rows[0].active_container || `app-${rows[0].slug}`;
          await writeCustomDomainRouter(rows[0].slug, hostname, containerName);
          await db.query('UPDATE domains SET dns_verified = true WHERE id = $1', [domainId]);
          // TLS wird von Traefiks HTTP-01-Challenge automatisch nachgezogen; wir markieren
          // optimistisch nach kurzer Wartezeit, echte Bestätigung könnte via ACME-Log erfolgen.
          setTimeout(async () => {
            const db2 = adminClient();
            await db2.connect();
            await db2.query('UPDATE domains SET tls_issued = true WHERE id = $1', [domainId]).catch(() => {});
            await db2.end();
          }, 60_000);
        } finally {
          await db.end();
        }
        return;
      }
    } catch {
      // DNS noch nicht propagiert — weiter pollen.
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.warn(`DNS für ${hostname} nach 30min nicht propagiert — Polling abgebrochen.`);
}

// DELETE /domains/:id — Custom Domain entfernen
domainsRouter.delete('/domains/:id', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT d.hostname, p.slug FROM domains d JOIN projects p ON p.id = d.project_id WHERE d.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'domain not found' });
    await removeCustomDomainRouter(rows[0].slug);
    await db.query('DELETE FROM domains WHERE id = $1', [req.params.id]);
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
PC_EOF
mkdir -p "provisioning-agent/src/routes"
cat > "provisioning-agent/src/routes/projects.ts" << 'PC_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import crypto from 'crypto';
import { encrypt } from '../lib/crypto';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;
const PREVIEW_DOMAIN_SUFFIX = process.env.PLATFORM_DOMAIN || 'up2-web.com';
const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL || 'https://webhooks.up2-web.com';
const GITHUB_PAT = process.env.GITHUB_PAT; // Fine-grained PAT, Scope: Webhooks (write) — Solo-Admin-Setup, kein OAuth-Flow (Phase 3 YAGNI für 1 User).

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

// slug-<10 zufällige Hex-Zeichen>.<suffix> — kollisionsarm, keine Rückschlüsse auf Kundenzahl.
function generatePreviewHostname(slug: string): string {
  return `${slug}-${crypto.randomBytes(5).toString('hex')}.${PREVIEW_DOMAIN_SUFFIX}`;
}

interface GithubWebhookResult {
  registered: boolean;
  reason?: string;
}

async function registerGithubWebhook(
  repoUrl: string,
  webhookUrl: string,
  secret: string
): Promise<GithubWebhookResult> {
  if (!GITHUB_PAT) return { registered: false, reason: 'GITHUB_PAT nicht gesetzt — manuell in GitHub eintragen.' };

  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?\/?$/);
  if (!match) return { registered: false, reason: 'Keine GitHub-URL erkannt.' };
  const [, owner, repo] = match;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: { url: webhookUrl, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { registered: false, reason: `GitHub API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { registered: true };
  } catch (err: any) {
    return { registered: false, reason: err.message };
  }
}

export const projectsRouter = Router();

// POST /projects — neues Deployment-Projekt für einen bestehenden Tenant anlegen,
// inkl. automatischer Preview-Domain + automatischer GitHub-Webhook-Registrierung.
projectsRouter.post('/projects', async (req, res) => {
  const { tenantSlug, slug, repoUrl, repoProvider, defaultBranch, buildCommand } = req.body;

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid project slug' });
  if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) return res.status(400).json({ error: 'invalid tenant slug' });
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const previewHostname = generatePreviewHostname(slug);
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO projects (tenant_slug, slug, repo_url, repo_provider, default_branch, build_command, webhook_secret, preview_hostname)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, slug, tenant_slug, repo_url, default_branch, active_container, preview_hostname, created_at`,
      [tenantSlug, slug, repoUrl, repoProvider || 'github', defaultBranch || 'main', buildCommand || null, webhookSecret, previewHostname]
    );
    await db.query(
      `INSERT INTO domains (project_id, hostname, kind, dns_verified, tls_issued)
       VALUES ($1, $2, 'subdomain', true, true)`,
      [rows[0].id, previewHostname]
    );

    const webhookUrl = `${WEBHOOK_PUBLIC_URL}/webhooks/github/${rows[0].id}`;
    const githubWebhook = await registerGithubWebhook(repoUrl, webhookUrl, webhookSecret);

    res.json({
      status: 'ok',
      project: rows[0],
      previewHostname,
      webhookSecret, // einmalig im Klartext zurückgeben, danach nur noch verschlüsselt/gehashed genutzt
      webhookUrl,
      githubWebhook,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /projects — Liste für Dashboard-Übersicht
projectsRouter.get('/projects', async (_req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.tenant_slug, p.slug, p.repo_url, p.default_branch, p.active_container,
              p.preview_hostname, p.created_at, k.tariff
       FROM projects p JOIN kunden k ON k.slug = p.tenant_slug
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// PUT /projects/:id/env — Env-Var setzen (verschlüsselt gespeichert)
projectsRouter.put('/projects/:id/env', async (req, res) => {
  const { id } = req.params;
  const { key, value } = req.body;
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'invalid env var key format' });

  const db = adminClient();
  await db.connect();
  try {
    const encrypted = encrypt(value);
    // Parameterisierte Query statt pg-format hier — %L ist für Bytea/Buffer-Werte nicht
    // zuverlässig; pg-format bleibt reserviert für Identifier-Quoting (siehe CLAUDE.md § 2.3).
    await db.query(
      `INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
      [id, key, encrypted]
    );
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
PC_EOF
mkdir -p "provisioning-agent/src/routes"
cat > "provisioning-agent/src/routes/deployments.ts" << 'PC_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { runDeployment, rollbackToDeployment, Project } from '../lib/deploy';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

async function loadProject(db: PGClient, projectId: string): Promise<Project | null> {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return rows[0] || null;
}

export const deploymentsRouter = Router();

// POST /deployments — manueller oder API-getriggerter Deploy
deploymentsRouter.post('/deployments', async (req, res) => {
  const { projectId, ref, triggeredBy } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const db = adminClient();
  await db.connect();
  try {
    const project = await loadProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    const { rows: depRows } = await db.query(
      `INSERT INTO deployments (project_id, status, triggered_by) VALUES ($1, 'queued', $2) RETURNING id`,
      [projectId, triggeredBy || 'manual']
    );
    const deploymentId = depRows[0].id;

    // Async im Hintergrund laufen lassen, Response sofort mit deploymentId zurückgeben.
    // Der Aufrufer pollt GET /deployments/:projectId für den Status.
    runDeployment(project, ref || project.default_branch, triggeredBy || 'manual', tariff, deploymentId).catch((err) => {
      console.error(`Deployment ${deploymentId} crashed unexpectedly:`, err.message);
    });

    res.json({ status: 'queued', deploymentId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});

// GET /deployments/:projectId — Deployment-Historie für Dashboard-Ansicht/Polling
deploymentsRouter.get('/deployments/:projectId', async (req, res) => {
  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, commit_sha, status, container_name, image_tag, triggered_by, created_at, finished_at,
              LEFT(build_log, 8000) AS build_log
       FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.projectId]
    );
    res.json(rows);
  } finally {
    await db.end();
  }
});

// POST /deployments/:id/rollback — auf einen vorherigen erfolgreichen Deploy zurückrollen
deploymentsRouter.post('/deployments/:id/rollback', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const db = adminClient();
  await db.connect();
  try {
    const project = await loadProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    await rollbackToDeployment(project, req.params.id, tariff);
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
PC_EOF
mkdir -p "provisioning-agent/src/routes"
cat > "provisioning-agent/src/routes/webhooks.ts" << 'PC_EOF'
import { Router } from 'express';
import { Client as PGClient } from 'pg';
import { verifyGithubSignature } from '../lib/git';
import { runDeployment, Project } from '../lib/deploy';

const PGBOUNCER_HOST = process.env.PGBOUNCER_HOST || 'pgbouncer';
const MASTER_DB_PASSWORD = process.env.MASTER_DB_PASSWORD!;

function adminClient(): PGClient {
  return new PGClient({
    connectionString: `postgres://postgres:${MASTER_DB_PASSWORD}@${PGBOUNCER_HOST}:5432/admin_dashboard`,
  });
}

export const webhooksRouter = Router();

// POST /webhooks/github/:projectId
// WICHTIG: dieser Router wird in index.ts mit express.raw() statt express.json()
// gemountet, weil die HMAC-Signatur über den EXAKTEN rohen Body berechnet wird —
// ein bereits geparster/re-serialisierter JSON-Body würde die Signatur invalidieren.
webhooksRouter.post('/webhooks/github/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const rawBody: Buffer = req.body; // Buffer dank express.raw()
  const signature = req.header('X-Hub-Signature-256');
  const event = req.header('X-GitHub-Event');

  const db = adminClient();
  await db.connect();
  try {
    const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (rows.length === 0) return res.status(404).json({ error: 'project not found' });
    const project: Project = rows[0];

    const secretRow = await db.query('SELECT webhook_secret FROM projects WHERE id = $1', [projectId]);
    const secret = secretRow.rows[0]?.webhook_secret;
    if (!secret || !verifyGithubSignature(rawBody, signature, secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Nur auf 'push' reagieren, und nur wenn der Ziel-Branch der default_branch ist.
    if (event !== 'push') {
      return res.json({ status: 'ignored', reason: `event ${event} not handled` });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
    if (pushedBranch !== project.default_branch) {
      return res.json({ status: 'ignored', reason: `push to ${pushedBranch}, watching ${project.default_branch}` });
    }

    const { rows: tariffRows } = await db.query('SELECT tariff FROM kunden WHERE slug = $1', [project.tenant_slug]);
    const tariff = tariffRows[0]?.tariff || 'starter';

    const { rows: depRows } = await db.query(
      `INSERT INTO deployments (project_id, status, triggered_by) VALUES ($1, 'queued', 'webhook') RETURNING id`,
      [projectId]
    );
    const deploymentId = depRows[0].id;

    runDeployment(project, payload.after || project.default_branch, 'webhook', tariff, deploymentId).catch((err) => {
      console.error(`Webhook-triggered deployment ${deploymentId} crashed:`, err.message);
    });

    res.json({ status: 'queued', deploymentId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await db.end();
  }
});
PC_EOF
mkdir -p "provisioning-agent"
cat > "provisioning-agent/docker-compose.yml" << 'PC_EOF'
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:v0.4.2
    container_name: docker-socket-proxy
    environment:
      CONTAINERS: 1
      IMAGES: 1
      NETWORKS: 1
      VOLUMES: 1
      BUILD: 1
      POST: 1
      INFO: 1
      PING: 1
      EXEC: 0
      SERVICES: 0
      SWARM: 0
      SYSTEM: 0
      TASKS: 0
      NODES: 0
      PLUGINS: 0
      SECRETS: 0
      CONFIGS: 0
      DISTRIBUTION: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik-net
    restart: always
    read_only: true
    tmpfs:
      - /tmp
      - /run
      - /var/lib/haproxy

  provisioning-agent:
    build: .
    container_name: provisioning-agent
    environment:
      DOCKER_HOST: tcp://docker-socket-proxy:2375
      PROVISIONING_AGENT_SECRET: ${PROVISIONING_AGENT_SECRET}
      MASTER_DB_PASSWORD: ${MASTER_DB_PASSWORD}
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      ENCRYPTION_MASTER_KEY: ${ENCRYPTION_MASTER_KEY}
      PGBOUNCER_HOST: core-postgres
      PLATFORM_DOMAIN: ${PLATFORM_DOMAIN}
      WEBHOOK_PUBLIC_URL: ${WEBHOOK_PUBLIC_URL}
      GITHUB_PAT: ${GITHUB_PAT}
      STARTER_POSTGREST_MEM: ${STARTER_POSTGREST_MEM}
      STARTER_POSTGREST_CPUS: ${STARTER_POSTGREST_CPUS}
      STARTER_GOTRUE_MEM: ${STARTER_GOTRUE_MEM}
      STARTER_GOTRUE_CPUS: ${STARTER_GOTRUE_CPUS}
      BUSINESS_POSTGREST_MEM: ${BUSINESS_POSTGREST_MEM}
      BUSINESS_POSTGREST_CPUS: ${BUSINESS_POSTGREST_CPUS}
      BUSINESS_GOTRUE_MEM: ${BUSINESS_GOTRUE_MEM}
      BUSINESS_GOTRUE_CPUS: ${BUSINESS_GOTRUE_CPUS}
      PREMIUM_POSTGREST_MEM: ${PREMIUM_POSTGREST_MEM}
      PREMIUM_POSTGREST_CPUS: ${PREMIUM_POSTGREST_CPUS}
      PREMIUM_GOTRUE_MEM: ${PREMIUM_GOTRUE_MEM}
      PREMIUM_GOTRUE_CPUS: ${PREMIUM_GOTRUE_CPUS}
    volumes:
      - /opt/multitenant-platform:/opt/multitenant-platform
    depends_on:
      - docker-socket-proxy
    networks:
      - traefik-net
    restart: always
    labels:
      - "traefik.enable=true"
      # NUR /webhooks/* öffentlich — alle anderen Pfade brauchen weiterhin X-Agent-Secret
      # und sind über diesen Router technisch zwar erreichbar, aber ohne Secret 401.
      - "traefik.http.routers.agent-webhooks.rule=Host(`webhooks.${PLATFORM_DOMAIN:-up2-web.com}`) && PathPrefix(`/webhooks`)"
      - "traefik.http.routers.agent-webhooks.entrypoints=websecure"
      - "traefik.http.routers.agent-webhooks.tls.certresolver=myresolver"
      - "traefik.http.services.agent-webhooks.loadbalancer.server.port=3001"
networks:
  traefik-net:
    external: true
PC_EOF
mkdir -p "core-postgres/init-scripts"
cat > "core-postgres/init-scripts/04_preview_domains.sql" << 'PC_EOF'
-- Automatische Preview-Domain pro Projekt: <slug>-<random>.<PREVIEW_DOMAIN_SUFFIX>
-- statt app.<slug>.vps.meine-domain.com — flacher, ein Wildcard-Level, kein
-- zusätzlicher Zertifikats-Overhead (Let's Encrypt/Cloudflare-Certs sind ohnehin
-- kostenlos, auch pro Subdomain einzeln — dieser Wechsel ist rein strukturell).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_hostname TEXT UNIQUE;
PC_EOF
mkdir -p "."
cat > ".env.example" << 'PC_EOF'
# .env.example — Vorlage. Kopieren nach .env und mit echten Werten befüllen.
# NIEMALS die ausgefüllte .env committen (siehe .gitignore).
# Vollständige Referenz: 10_env_reference.md

# --- Core Database ---
MASTER_DB_PASSWORD=CHANGE_ME_generate_with_openssl_rand_hex_32

# --- MinIO (Storage) ---
MINIO_ROOT_USER=admin
MINIO_ROOT_PASSWORD=CHANGE_ME_generate_with_openssl_rand_hex_32

# --- Resend (E-Mail: GoTrue-SMTP, Uptime-Kuma-Alerts, Disk-Check) ---
RESEND_API_KEY=re_CHANGE_ME

# --- Cloudflare Tunnel (Admin-Zugriff ohne offenen Port) ---
CLOUDFLARE_TUNNEL_TOKEN=CHANGE_ME_from_cloudflare_zero_trust_dashboard

# --- Provisioning Agent ---
PROVISIONING_AGENT_SECRET=CHANGE_ME_generate_with_openssl_rand_hex_32
PGBOUNCER_HOST=pgbouncer

# --- Deployment Engine (neu) ---
# 256-bit Key für AES-256-GCM-Verschlüsselung von project_env_vars & minio_secret_key.
# WICHTIG: bei Verlust sind alle verschlüsselten Werte in der DB unbrauchbar (siehe 10_env_reference.md § 5.2).
ENCRYPTION_MASTER_KEY=CHANGE_ME_generate_with_openssl_rand_hex_32
VPS_PUBLIC_IP=CHANGE_ME_your_hetzner_ip

# --- Traefik / Let's Encrypt ---
ACME_EMAIL=deine-email@meine-domain.com

# --- Preview-Domains & GitHub-Webhooks (neu) ---
# Basis-Domain für automatische Tenant-/Preview-Subdomains: <slug>-<random>.<PLATFORM_DOMAIN>
# Kostenlos (Let's Encrypt/Cloudflare-Zertifikate sind pro Subdomain gratis, kein
# Wildcard-Zertifikat nötig). DNS: A-Record für *.PLATFORM_DOMAIN einmalig auf VPS-IP.
PLATFORM_DOMAIN=up2-web.com
# Öffentlich erreichbare Basis-URL des Agent-Webhook-Endpunkts (Traefik-Router,
# NUR /webhooks/* ist public — Rest des Agents bleibt intern). DNS: A-Record für
# webhooks.PLATFORM_DOMAIN auf VPS-IP.
WEBHOOK_PUBLIC_URL=https://webhooks.up2-web.com
# Fine-grained GitHub Personal Access Token, Scope "Webhooks: Read & write", nur
# für Repos die du selbst verbindest. Ohne diesen Wert: Webhook muss manuell in
# GitHub eingetragen werden (URL wird bei Projekt-Erstellung angezeigt).
GITHUB_PAT=CHANGE_ME_github_pat_mit_webhooks_scope

# --- Hetzner Storage Box (Backups, für rclone — nicht Docker-relevant) ---
HETZNER_SBX_USER=CHANGE_ME
HETZNER_SBX_PASS=CHANGE_ME

# --- Dashboard (Next.js) ---
NEXTAUTH_SECRET=CHANGE_ME_generate_with_openssl_rand_hex_32
NEXTAUTH_URL=https://admin.vps.meine-domain.com
ADMIN_EMAIL=admin@meine-domain.com
ADMIN_PASSWORD_HASH=CHANGE_ME_bcrypt_hash
PROVISIONING_AGENT_URL=http://provisioning-agent:3001
DATABASE_URL=postgres://postgres:CHANGE_ME@pgbouncer:5432/admin_dashboard

# Resource-Tiers pro Tarif (mem_limit/cpus für GoTrue+PostgREST-Container)
# TODO: Werte für 8GB-VPS (statt geplanter 16GB) neu kalkulieren, aktuell nur Platzhalter aus Blueprint
STARTER_POSTGREST_MEM=64m
STARTER_POSTGREST_CPUS=0.25
STARTER_GOTRUE_MEM=128m
STARTER_GOTRUE_CPUS=0.25

BUSINESS_POSTGREST_MEM=128m
BUSINESS_POSTGREST_CPUS=0.5
BUSINESS_GOTRUE_MEM=128m
BUSINESS_GOTRUE_CPUS=0.25

PREMIUM_POSTGREST_MEM=256m
PREMIUM_POSTGREST_CPUS=0.5
PREMIUM_GOTRUE_MEM=256m
PREMIUM_GOTRUE_CPUS=0.5

# Resource-Tiers pro Tarif (mem_limit/cpus für GoTrue+PostgREST-Container)
# TODO: Werte für 8GB-VPS (statt geplanter 16GB) neu kalkulieren, aktuell nur Platzhalter aus Blueprint
STARTER_POSTGREST_MEM=64m
STARTER_POSTGREST_CPUS=0.25
STARTER_GOTRUE_MEM=128m
STARTER_GOTRUE_CPUS=0.25

BUSINESS_POSTGREST_MEM=128m
BUSINESS_POSTGREST_CPUS=0.5
BUSINESS_GOTRUE_MEM=128m
BUSINESS_GOTRUE_CPUS=0.25

PREMIUM_POSTGREST_MEM=256m
PREMIUM_POSTGREST_CPUS=0.5
PREMIUM_GOTRUE_MEM=256m
PREMIUM_GOTRUE_CPUS=0.5
PC_EOF
echo Fertig geschrieben.
