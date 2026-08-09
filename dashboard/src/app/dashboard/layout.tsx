import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { SidebarNav } from "@/components/SidebarNav";

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
      <SidebarNav>
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
      </SidebarNav>
      <main className="main">{children}</main>
    </div>
  );
}
