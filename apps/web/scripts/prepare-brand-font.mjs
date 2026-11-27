import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fontDirectory = new URL("../public/fonts/", import.meta.url);
const fontFile = new URL("GyunMyeongjo-Regular.otf", fontDirectory);
const url = "https://github.com/ssayuz/gyun-fonts/releases/download/v0.1/GyunMyeongjo-Regular.otf";
const sha256 = "a5b57569dca33f554a9efb8af5d5dea79827df47b78dc1113c7202c0c8668ee9";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function prepareBrandFont() {
  const cached = await readFile(fontFile).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (cached && digest(cached) === sha256) return;

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Gyun Myeongjo download failed: ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error("Gyun Myeongjo checksum mismatch");

  await mkdir(fileURLToPath(fontDirectory), { recursive: true });
  await writeFile(fontFile, bytes);
}

await prepareBrandFont();
