import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized: ({ auth }) => !!auth,
  },
} satisfies NextAuthConfig;
