// app/chat/layout.tsx
// app/chat/page.tsx is a client component ("use client"), so it cannot export
// route metadata directly. This server-component layout supplies it instead.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chat",
  description:
    "Look up any LA County parcel by APN or address: zoning, hazard overlays, assessor details, and building-code guidance for your rebuild.",
  alternates: {
    canonical: "/chat",
  },
};

export default function ChatLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
