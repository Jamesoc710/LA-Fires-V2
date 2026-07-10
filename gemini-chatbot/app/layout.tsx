import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: 'swap',
  variable: "--font-inter",
});

const SITE_URL = "https://rebuildlaagent.com";
const SITE_DESCRIPTION =
  "Instant zoning, overlay, and assessor lookups for any LA County parcel, plus LA County building-code guidance for your rebuild.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "LA Building Codes Assistant",
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "LA Building Codes Assistant",
    description: SITE_DESCRIPTION,
    type: "website",
    siteName: "LA Building Codes Assistant",
  },
  twitter: {
    card: "summary",
    title: "LA Building Codes Assistant",
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2563eb" },
    { media: "(prefers-color-scheme: dark)", color: "#1e293b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body
        className={`${inter.variable} antialiased h-screen sm:h-auto`}
      >
        <div className="flex flex-col h-full">
          {children}
        </div>
      </body>
    </html>
  );
}
