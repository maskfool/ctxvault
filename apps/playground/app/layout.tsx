import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CtxVault — the handoff button for AI tools",
  description:
    "Save your working context in one AI tool, resume it in another. Watch the Vault fill with readable, durable memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
