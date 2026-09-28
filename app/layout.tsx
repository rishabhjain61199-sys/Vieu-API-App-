import type { Metadata } from "next";
import { Share } from "next/font/google";
import "./globals.css";

const share = Share({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-share" });

export const metadata: Metadata = {
  title: "Stakeholder Lookup",
  description: "Look up and generate a tenant's stakeholders by power pod via the Vieu Partner API.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={share.variable}>
      <body>{children}</body>
    </html>
  );
}
