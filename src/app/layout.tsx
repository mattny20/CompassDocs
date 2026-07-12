import type { Metadata } from "next";
import { getAppSettings } from "@/lib/settings-store";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { company_name } = await getAppSettings();
  const isDefault = company_name === "CompassDocs";
  return {
    title: isDefault ? "CompassDocs — Team Knowledge Platform" : `${company_name} — Knowledge Base`,
    description:
      "Create, organize, and search SOPs, technical docs, policies, and internal knowledge with AI-powered search.",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
