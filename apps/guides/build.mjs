import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const publisherId = process.env.SAMTDI_ADSENSE_PUBLISHER_ID?.trim();
const slotId = process.env.SAMTDI_ADSENSE_SLOT_ID?.trim();
const serveAds = process.env.SAMTDI_ADSENSE_ENABLED === "1";

if (publisherId && !/^ca-pub-\d{16}$/.test(publisherId)) {
  throw new Error("AdSense 게시자 ID는 ca-pub-과 숫자 16자리 형식이어야 합니다.");
}

if (serveAds && (!publisherId || !slotId || !/^\d+$/.test(slotId))) {
  throw new Error("광고를 켜려면 AdSense 게시자 ID와 숫자로 된 광고 단위 ID가 필요합니다.");
}

const script = serveAds
  ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}" crossorigin="anonymous"></script>`
  : "";

const adUnit = serveAds
  ? `<ins class="adsbygoogle" style="display:block" data-ad-client="${publisherId}" data-ad-slot="${slotId}"
  data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(window.adsbygoogle = window.adsbygoogle || []).push({});</script>`
  : "";

function renderPage({ title, description = "", content, includesAd = false }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${description ? `<meta name="description" content="${description}">` : ""}
  <title>${title} | 사맛디</title>
  <link rel="stylesheet" href="/guide.css">
  ${includesAd ? script : ""}
</head>
<body>
  <header>
    <a href="/" class="brand">사맛디</a>
    <a href="https://samat.studio/projects">작업공간 열기</a>
  </header>
  <main>
    ${content}
    ${includesAd ? adUnit : ""}
  </main>
  <footer><a href="/privacy/">가이드 개인정보 및 광고 안내</a></footer>
</body>
</html>
`;
}

const [article, privacyNotice] = await Promise.all([
  readFile(new URL("./audio-feedback.html", import.meta.url), "utf8"),
  readFile(new URL("./privacy.html", import.meta.url), "utf8"),
]);

const output = await mkdtemp(join(tmpdir(), "samtdi-guides-"));
await mkdir(join(output, "privacy"));

await Promise.all([
  writeFile(join(output, "index.html"), renderPage({
    title: "음원 피드백 작성 가이드",
    description: "음원 버전과 타임코드를 기준으로 믹스 피드백을 작성하고 수정본을 비교하는 방법입니다.",
    content: article,
    includesAd: true,
  })),
  writeFile(join(output, "privacy/index.html"), renderPage({ title: "가이드 개인정보 및 광고 안내", content: privacyNotice })),
  writeFile(join(output, "404.html"), renderPage({
    title: "페이지를 찾을 수 없음",
    content: '<h1>페이지를 찾을 수 없습니다</h1><p><a href="/">음원 피드백 가이드 보기</a></p>',
  })),
  copyFile(new URL("./guide.css", import.meta.url), join(output, "guide.css")),
  publisherId
    ? writeFile(join(output, "ads.txt"), `google.com, ${publisherId.slice(3)}, DIRECT, f08c47fec0942fa0\n`)
    : Promise.resolve(),
]);

console.log(output);
