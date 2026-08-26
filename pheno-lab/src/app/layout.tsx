import type { Metadata, Viewport } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted webfonts so phones and tablets render the same typography as
// desktop (Android has neither Inter nor Helvetica Neue installed).
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});
const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-roboto-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Pheno Lab Data Platform",
  description: "Structured capture of perovskite solar cell experiments",
  appleWebApp: {
    capable: true,
    title: "Pheno Lab",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/brand/web/favicon-32x32.png", sizes: "32x32" },
      { url: "/brand/web/favicon-16x16.png", sizes: "16x16" },
    ],
    apple: "/brand/web/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${robotoMono.variable} font-sans antialiased text-ink bg-surface`}
      >
        {children}
      </body>
    </html>
  );
}
