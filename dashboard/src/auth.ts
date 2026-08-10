import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";
import { logAudit } from "@/lib/audit";

// P3-5: weder erfolgreiche noch fehlgeschlagene Logins wurden bisher geloggt -
// ausgerechnet der Zugriffspunkt mit dem direktesten Bezug zu "wer war das".
function requestMeta(request: Request | undefined): { ip: string | null; userAgent: string | null } {
  if (!request) return { ip: null, userAgent: null };
  const h = request.headers;
  return {
    ip: h.get("cf-connecting-ip") || h.get("x-forwarded-for"),
    userAgent: h.get("user-agent"),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-Mail", type: "email" },
        password: { label: "Passwort", type: "password" },
      },
      authorize: async (credentials, request) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const meta = requestMeta(request as Request | undefined);
        const actor = email || "unknown";

        if (!email || !password) {
          await logAudit(actor, "auth.login_failure", null, { reason: "missing_credentials" }, meta);
          return null;
        }

        const adminEmail = process.env.ADMIN_EMAIL;
        const adminHash = process.env.ADMIN_PASSWORD_HASH;
        if (!adminEmail || !adminHash) {
          await logAudit(actor, "auth.login_failure", null, { reason: "server_misconfigured" }, meta);
          return null;
        }

        if (email.toLowerCase() !== adminEmail.toLowerCase()) {
          await logAudit(actor, "auth.login_failure", null, { reason: "unknown_email" }, meta);
          return null;
        }
        const valid = await bcrypt.compare(password, adminHash);
        if (!valid) {
          await logAudit(actor, "auth.login_failure", null, { reason: "wrong_password" }, meta);
          return null;
        }

        await logAudit(adminEmail, "auth.login_success", null, {}, meta);
        return { id: "admin", email: adminEmail, name: "Admin" };
      },
    }),
  ],
});
