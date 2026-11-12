import type { Metadata } from "next";
import { Suspense } from "react";
import { Workspace } from "./workspace";
import "./styles.css";

export const metadata: Metadata = {
  title: "사맛디 | 음악 협업 공간",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body><Suspense fallback={<p role="status">화면을 여는 중</p>}><Workspace>{children}</Workspace></Suspense></body></html>;
}
