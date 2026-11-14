import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "공사 소음 저감 연구 · 결과보고서",
  description: "SNR별 음원 시연, STOI·ESTOI 지표와 청음 평가 결과 비교",
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
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
