import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: {
    default: "SYMBIOTIC CITY — Self-Healing Urban Intelligence",
    template: "%s · SYMBIOTIC CITY",
  },
  description:
    "A synthetic smart city digital twin: cascading failure simulation, constrained recovery optimisation and automated multi-step restoration workflows for the fictional city of Aurora Vale.",
  applicationName: "SYMBIOTIC CITY",
};

export const viewport: Viewport = {
  themeColor: "#040b18",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only sr-only-focusable">
          Skip to main content
        </a>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
