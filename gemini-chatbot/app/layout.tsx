import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: 'swap',
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "LA Fires Project",
  description: "Scaled by IF Lab",
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
