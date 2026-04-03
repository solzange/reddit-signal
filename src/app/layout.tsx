import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { getSignalConfig } from "@/signal.config";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

const config = getSignalConfig();

export const metadata: Metadata = {
  title: config.name,
  description: config.description,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body className="bg-bg-base text-text-primary antialiased">
        <main className="mx-auto max-w-[800px] px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
