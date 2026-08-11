import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "회의실 예약 | BDO Korea",
  description: "9층과 12층 회의실 현황을 보고 바로 예약하는 사내 시스템",
  icons: { icon: "/bdo-logo.png", shortcut: "/bdo-logo.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
