import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import type { Metadata } from "next";
import { Suspense } from "react";
import { theme } from "./theme";
import { WorkspaceShell } from "./workspace-shell";
import "./styles.css";
import "@mantine/core/styles.layer.css";

export const metadata: Metadata = {
  title: "사맛디 | 음악 협업 공간",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" {...mantineHtmlProps}>
      <head><ColorSchemeScript forceColorScheme="light" /></head>
      <body>
        <MantineProvider theme={theme} forceColorScheme="light">
          <Suspense fallback={<p role="status">화면을 여는 중</p>}>
            <WorkspaceShell local={process.env.SAMTDI_LOCAL_MODE === "1"}>{children}</WorkspaceShell>
          </Suspense>
        </MantineProvider>
      </body>
    </html>
  );
}
