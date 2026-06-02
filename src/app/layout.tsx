import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "EOD Inspector — Панель управления",
  description: "Панель управления отчётами EOD Inspector для Bitrix24",
  keywords: ["EOD", "Bitrix24", "Inspector", "Reports"],
  authors: [{ name: "EOD Inspector" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "EOD Inspector — Панель управления",
    description: "Панель управления отчётами EOD Inspector для Bitrix24",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "EOD Inspector",
    description: "Панель управления отчётами EOD Inspector для Bitrix24",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
