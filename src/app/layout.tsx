import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CompassDocs — Team Knowledge Platform",
  description:
    "Create, organize, and search SOPs, technical docs, policies, and internal knowledge with AI-powered search.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
