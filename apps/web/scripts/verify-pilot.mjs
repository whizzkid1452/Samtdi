import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, devices } from "playwright";

const origin = "http://127.0.0.1:3100";
const headers = { Origin: origin };
const ownerEmail = "owner@example.test";
const reviewerEmail = "reviewer@example.test";
const assets = await mkdtemp(join(tmpdir(), "samtdi-pilot-"));
const browsers = [];

async function launch(engine, options) {
  const browser = await engine.launch({ headless: true, ...options });
  browsers.push(browser);
  return browser;
}

async function login(page, email, url = origin + "/v1/auth/login") {
  const target = new URL(url);
  assert.equal(target.origin, origin);
  await page.goto(target.href);
  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill("samtdi-demo");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(origin + "/");
}

async function upload(page, file, expected) {
  await page.getByLabel("WAV 또는 MP3").setInputFiles(file);
  const registration = page.waitForResponse((response) =>
    response.url().endsWith("/complete") && response.request().method() === "POST");
  await page.getByRole("button", { name: "버전 업로드" }).click();
  const response = await registration;
  assert.equal(response.status(), 202);
  const version = await response.json();
  const base = response.url().replace(/\/uploads\/[^/]+\/complete$/, "");
  const path = base + "/versions/" + version.id;

  const repeated = await page.request.post(response.url(), { headers: { ...headers, "Idempotency-Key": version.id } });
  assert.equal(repeated.status(), 202);
  assert.equal((await repeated.json()).id, version.id);
  let state;
  const timeout = Date.now() + 30_000;
  while (Date.now() < timeout) {
    state = await (await page.request.get(path)).json();
    if (state.state === "ready" || state.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(state?.state, expected);
  return { ...state, path };
}

function taskPayload(task, changes = {}) {
  return {
    title: task.title, description: task.description, status: task.status, assignee_id: task.assignee_id,
    due_on: task.due_on, result_version_id: task.result_version_id, review_text: task.review_text,
    archived: task.archived, revision: task.revision, note_ids: task.notes.map(({ id }) => id), ...changes,
  };
}

try {
  const wav = join(assets, "mix-v1.wav");
  const mp3 = join(assets, "mix-v2.mp3");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "pcm_s16le", wav]);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", wav, "-t", "2", "-c:a", "libmp3lame", "-q:a", "4", mp3]);

  const desktop = await launch(chromium, process.env.SAMTDI_CHROME_CHANNEL ? { channel: process.env.SAMTDI_CHROME_CHANNEL } : {});
  const other = await launch(firefox, {});
  console.log("Desktop browsers:", desktop.version(), other.version());
  const owner = await desktop.newPage({ viewport: { width: 1440, height: 900 } });
  const reviewer = await other.newPage();
  await login(owner, ownerEmail);
  const title = "파일럿 검증 " + new Date().toISOString().slice(11, 19);
  await owner.getByLabel("새 프로젝트 이름").fill(title);
  await owner.getByRole("button", { name: "프로젝트 만들기" }).click();
  await owner.getByRole("heading", { name: title, exact: true }).waitFor();
  const projects = await (await owner.request.get(origin + "/v1/projects")).json();
  const project = projects.find((entry) => entry.title === title);
  assert.ok(project);
  const base = origin + "/v1/projects/" + project.id;
  await owner.getByLabel("초대할 이메일").fill(reviewerEmail);
  await owner.getByRole("button", { name: "초대 링크 만들기" }).click();
  const invite = await owner.getByLabel("초대 링크", { exact: true }).inputValue();
  await login(reviewer, reviewerEmail, invite);

  await owner.getByLabel("새 음원 이름").fill("메인 믹스");
  await owner.getByRole("button", { name: "음원 추가" }).click();
  const first = await upload(owner, wav, "ready");
  const reviewLink = origin + "/?" + new URLSearchParams({ project: project.id, version: first.id });
  await reviewer.goto(reviewLink);
  await reviewer.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  const seek = reviewer.getByRole("slider", { name: "재생 위치" });
  await seek.press("Home");
  await reviewer.locator("audio").evaluate((element) => element.play());
  await reviewer.waitForFunction(() => document.querySelector("audio")?.currentTime > .15);
  await reviewer.locator("audio").evaluate((element) => element.pause());
  const anchor = Number(await seek.inputValue());
  assert.ok(anchor >= 0 && anchor <= 3000);
  const message = "인트로 볼륨을 조금 낮춰 주세요.";
  await reviewer.getByLabel("새 노트").fill(message);
  await reviewer.getByRole("button", { name: "노트 남기기" }).click();
  await reviewer.getByText(message, { exact: true }).waitFor();
  const [note] = await (await reviewer.request.get(first.path + "/notes")).json();
  assert.equal(note.start_ms, anchor);

  const second = await upload(owner, mp3, "ready");
  assert.ok(second.duration_ms < first.duration_ms);
  assert.deepEqual(await (await owner.request.get(second.path + "/notes")).json(), []);
  const retained = await (await owner.request.get(first.path + "/notes")).json();
  assert.equal(retained[0].id, note.id);
  assert.deepEqual(await (await owner.request.get(first.path + "/files/original")).body(), await readFile(wav));

  await owner.goto(reviewLink);
  await owner.getByRole("link", { name: "작업으로 연결" }).click();
  const cardTitle = "인트로 레벨 조정";
  await owner.getByLabel("카드 제목").fill(cardTitle);
  await owner.getByLabel("작업 상태").selectOption("review");
  const account = await (await owner.request.get(origin + "/v1/me")).json();
  await owner.getByLabel("담당자").selectOption(account.account_id);
  await owner.getByLabel("결과 버전").selectOption(second.id);
  await owner.getByRole("button", { name: "카드 저장" }).click();
  const reviewLane = owner.getByRole("region", { name: "검토 요청" });
  await reviewLane.getByRole("heading", { name: cardTitle }).waitFor();
  const [task] = await (await owner.request.get(base + "/tasks")).json();
  assert.equal(task.result_version_id, second.id);
  assert.equal(task.notes[0].id, note.id);
  assert.equal((await owner.request.put(base + "/tasks/" + task.id, {
    headers, data: taskPayload(task, { status: "done" }),
  })).status(), 409);

  await owner.getByRole("textbox", { name: "답글", exact: true }).fill("수정본을 올렸습니다.");
  await owner.getByRole("button", { name: "답글 남기기" }).click();
  await owner.locator("p.message-body").filter({ hasText: /^수정본을 올렸습니다\.$/ }).waitFor();
  const inbox = await (await reviewer.request.get(origin + "/v1/notifications")).json();
  const notice = inbox.items.find((item) => item.project_id === project.id && item.action === "reply.created");
  assert.ok(notice);
  assert.equal((await reviewer.request.post(origin + "/v1/notifications/" + notice.id + "/read", { headers })).status(), 204);
  await reviewLane.getByRole("button", { name: "카드 편집" }).click();
  await owner.getByLabel("작업 상태").selectOption("done");
  await owner.getByLabel(/미해결 노트/).check();
  await owner.getByRole("button", { name: "카드 저장" }).click();
  await owner.getByRole("region", { name: "완료" }).getByRole("heading", { name: cardTitle }).waitFor();

  const exported = await (await owner.request.get(base + "/export/json")).json();
  assert.ok(exported.records.some(({ kind, data }) => kind === "task" && data.status === "done" && data.id === task.id));
  const activity = await (await owner.request.get(base + "/activity?type=task")).json();
  assert.ok(activity.some(({ action, detail }) => action === "task.updated" && detail.status === "done"));

  await upload(owner, { name: "invalid.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid waveform") }, "failed");
  assert.equal((await (await owner.request.get(first.path)).json()).state, "ready");

  if (process.env.SAMTDI_VERIFY_MOBILE === "1") {
    const mobile = await launch(webkit, {});
    const touch = await mobile.newPage({ ...devices["iPhone 13"] });
    await login(touch, reviewerEmail);
    await touch.goto(reviewLink);
    await touch.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
    await touch.getByLabel("새 노트").fill("모바일 화면에서 확인했습니다.");
    await touch.getByRole("button", { name: "노트 남기기" }).click();
    await touch.locator("p.message-body").filter({ hasText: /^모바일 화면에서 확인했습니다\.$/ }).waitFor();
    console.log("Mobile WebKit viewport:", mobile.version(), "audio metadata and note entry passed");
  }

  const guest = await (await reviewer.request.get(origin + "/v1/me")).json();
  assert.equal((await owner.request.delete(base + "/members/" + guest.account_id, { headers })).status(), 204);
  assert.equal((await reviewer.request.get(first.path + "/files/playback", { headers: { Range: "bytes=0-31" } })).status(), 404);
  assert.equal((await reviewer.request.get(base + "/export/json")).status(), 404);
  console.log("Pilot journey passed: two browsers, two versions, anchored note, review, inbox, export, media failure and revocation");
} finally {
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  await rm(assets, { recursive: true, force: true });
}
