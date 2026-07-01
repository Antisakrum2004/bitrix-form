import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono, Unbounded } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "700"],
});

const unbounded = Unbounded({
  variable: "--font-display",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "600", "700"],
});

export const metadata: Metadata = {
  title: "Bitrix Form — AI assistant for tasks",
  description: "AI backend for the Bitrix24 task form (decomposition, duplicate search, similar tasks, lexical search)",
  keywords: ["Bitrix24", "AI", "Tasks", "Search"],
  authors: [{ name: "Antisakrum2004" }],
  openGraph: {
    title: "Bitrix Form AI",
    description: "AI backend for the Bitrix24 task form",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bitrix Form AI",
    description: "AI backend for the Bitrix24 task form",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} ${unbounded.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
