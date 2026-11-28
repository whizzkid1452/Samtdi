import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import type { Metadata } from "next";
import { Suspense } from "react";
import { theme } from "./theme";
import { WorkspaceShell } from "./workspace-shell";
import "./styles.css";
import "@mantine/core/styles.layer.css";

const title = "사맛디 | 음악 협업 공간";
const description = "음원을 나누고, 정확한 위치에 피드백을 남기며 음악을 함께 완성하세요.";
const shareImage = {
  url: "/samtdi-share.png",
  width: 1200,
  height: 630,
  alt: "사맛디 - 음악을 함께 완성하는 공간",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://samat.studio"),
  title,
  description,
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "사맛디",
    title,
    description,
    images: [shareImage],
  },
  twitter: { card: "summary_large_image", title, description, images: [shareImage] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const guideUrl = URL.parse(process.env.SAMTDI_GUIDE_URL ?? "");
  const guideHref = guideUrl?.protocol === "https:" ? guideUrl.href : undefined;

  return (
    <html lang="ko" {...mantineHtmlProps}>
      <head><ColorSchemeScript forceColorScheme="light" /></head>
      <body>
        <MantineProvider theme={theme} forceColorScheme="light">
          <Suspense fallback={<p role="status">화면을 여는 중</p>}>
            <WorkspaceShell local={process.env.SAMTDI_LOCAL_MODE === "1"} guideHref={guideHref}>
              {children}
            </WorkspaceShell>
          </Suspense>
        </MantineProvider>
      </body>
    </html>
  );
}
