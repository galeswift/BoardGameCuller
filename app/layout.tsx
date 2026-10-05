import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Collection Cull",
  description: "Review your board games, save preferences and refine a live cull shortlist.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
