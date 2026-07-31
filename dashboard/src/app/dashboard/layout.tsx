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
        <Link href="/dashboard/backups" className="nav-link">
          Backups
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
