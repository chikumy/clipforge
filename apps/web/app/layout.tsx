import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "ClipForge AI", description: "Turn long videos into Shorts and manage social publishing." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
