import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "사맛디 | 음악 협업 공간",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
