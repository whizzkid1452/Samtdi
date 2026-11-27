import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const url = new URL(process.env.SAMTDI_VERIFY_ORIGIN ?? "http://127.0.0.1:3100");
assert.equal(url.protocol, "http:");
assert.equal(url.hostname, "127.0.0.1");

const browser = await chromium.launch({ headless: true, channel: process.env.SAMTDI_CHROME_CHANNEL });
const homeHeading = "음악을 함께 완성하는 공간";

async function verifyHomeNavigation(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const heading = (name) => page.getByRole("heading", { level: 1, name, exact: true });
  const projectSelect = page.getByRole("combobox", { name: "프로젝트 선택" });
  const headerLogo = page.locator("header").getByRole("button", { name: "사맛디 홈" });
  const sidebarLogo = page.locator("aside").getByRole("button", { name: "사맛디 홈" });

  try {
    await page.goto(url.origin);
    await heading(homeHeading).waitFor();
    await page.getByRole("textbox", { name: "새 프로젝트" }).fill("홈 이동 검증 프로젝트");
    await page.getByRole("button", { name: "프로젝트 만들기" }).click();
    await heading("홈 이동 검증 프로젝트").waitFor();
    await page.getByRole("heading", { name: "음원 버전" }).waitFor();
    const projectId = await projectSelect.inputValue();
    assert.ok(projectId);

    await headerLogo.click();
    await heading(homeHeading).waitFor();
    assert.equal(await projectSelect.inputValue(), "");
    assert.equal(await page.getByRole("heading", { name: "음원 버전" }).count(), 0);

    await projectSelect.selectOption(projectId);
    await heading("홈 이동 검증 프로젝트").waitFor();
    const logo = await sidebarLogo.isVisible() ? sidebarLogo : headerLogo;
    await logo.press("Enter");
    await heading(homeHeading).waitFor();
    await page.reload();
    await heading(homeHeading).waitFor();
    await projectSelect.selectOption(projectId);
    await heading("홈 이동 검증 프로젝트").waitFor();
  } finally {
    await context.close();
  }
}

try {
  await verifyHomeNavigation({ viewport: { width: 1280, height: 800 } });
  await verifyHomeNavigation(devices["iPhone 13"]);
  console.log("Local home navigation passed (desktop and mobile).");
} finally {
  await browser.close();
}
