import type { Metadata, Viewport } from "next";
import { Libre_Franklin, Lora, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const libreFranklin = Libre_Franklin({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-libre-franklin",
});

const lora = Lora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-lora",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-mono",
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
  themeColor: "#0c0a09",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${libreFranklin.variable} ${lora.variable} ${plexMono.variable}`}
    >
      <body className="antialiased h-screen sm:h-auto">
        <div className="flex flex-col h-full">{children}</div>
      </body>
    </html>
  );
}
