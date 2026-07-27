import Link from "next/link";
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";

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
        <Link href="/dashboard/database" className="nav-link">
          Datenbank
        </Link>
        <Link href="/dashboard/sql" className="nav-link">
          SQL Editor
        </Link>
        <Link href="/dashboard/hosting" className="nav-link">
          Hosting
        </Link>
        <div style={{ flex: 1 }} />
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
