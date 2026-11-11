import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./feed.css";

export const metadata: Metadata = {
  title: "The Second Source",
  description: "News printed the moment a second outlet confirms it. Nothing runs on one source alone.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#14120F",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&family=Libre+Franklin:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400..900;1,400..900&family=UnifrakturCook:wght@700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
