import type { Metadata } from "next";
import { Figtree, Fraunces } from "next/font/google";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
const display = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });

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
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
