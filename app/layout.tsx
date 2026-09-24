import type { Metadata, Viewport } from "next";
import { Pwa } from "@/components/pwa";
import { Toaster } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "BookerReads",
    template: "%s · BookerReads",
  },
  description: "Borrow books from readers in your neighbourhood. Bangalore.",
  applicationName: "BookerReads",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "BookerReads" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#f3ecda",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// System serif stack on purpose: no webfont request on the critical path (Requirement 14.1).
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        {children}
        <Toaster />
        <Pwa />
      </body>
    </html>
  );
}
