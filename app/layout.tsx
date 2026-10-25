import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Исход — рынок прогнозов",
  description: "Рабочий рынок прогнозов на виртуальные баллы.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
