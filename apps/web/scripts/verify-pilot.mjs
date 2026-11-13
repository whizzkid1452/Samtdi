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

async function login(page, { email, url = origin + "/v1/auth/login", target = origin + "/projects" }) {
  assert.equal(new URL(url).origin, origin);
  await page.goto(url);
  const start = page.getByRole("link", { name: "로그인", exact: true });
  if (new URL(url).pathname !== "/v1/auth/login") await start.click();

  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill("samtdi-demo");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(target);
}

function button(page, name) {
  return page.getByRole("button", { name, exact: true });
}

function link(page, name) {
  return page.getByRole("link", { name, exact: true });
}

function tab(page, name) {
  return page.getByRole("navigation", { name: "프로젝트 탭" }).getByRole("link", { name, exact: true });
}

async function upload(page, { file, action, expected }) {
  await button(page, action).click();
  await page.getByLabel("WAV 또는 MP3").setInputFiles(file);
  const registration = page.waitForResponse((response) =>
    response.url().endsWith("/complete") && response.request().method() === "POST");
  await button(page, "파일 업로드").click();
  const response = await registration;
  assert.equal(response.status(), 202);
  const version = await response.json();
  const base = response.url().replace(/\/uploads\/[^/]+\/complete$/, "");
  const path = base + "/versions/" + version.id;

  const repeated = await page.request.post(response.url(), { headers: { ...headers, "Idempotency-Key": version.id } });
  assert.equal(repeated.status(), 202);
  assert.equal((await repeated.json()).id, version.id);
  const url = base.replace("/v1/projects/", "/projects/") + "/media/" + version.item_id + "/versions/" + version.id;
  await page.waitForURL(url);
  if (expected === "ready") await button(page, "재생").waitFor();
  else await page.getByText("처리 실패", { exact: true }).waitFor();
  const ready = await (await page.request.get(path)).json();
  assert.equal(ready.state, expected);
  return { ...ready, path, url };
}

async function writeFeedback(page, message, { playing = false } = {}) {
  await button(page, "현재 위치에 피드백").click();
  const composer = page.getByRole("dialog", { name: "피드백 남기기" });
  const [minutes, seconds] = (await composer.locator(".feedback-time").textContent()).split(":");
  const anchor = Math.round((Number(minutes) * 60 + Number(seconds)) * 1000);
  await composer.getByLabel("피드백 내용").fill(message);
  if (playing) {
    await page.waitForFunction((ms) => document.querySelector("audio")?.currentTime > ms / 1000 + .25, anchor);
  }

  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/notes") && response.request().method() === "POST");
  await button(composer, "피드백 저장").click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const { id } = await response.json();
  await page.getByRole("region", { name: "선택한 피드백" }).getByText(message, { exact: true }).waitFor();
  return { id, anchor };
}

function taskPayload(task, changes = {}) {
  return {
    title: task.title, description: task.description, status: task.status, assignee_id: task.assignee_id,
    due_on: task.due_on, result_version_id: task.result_version_id, review_text: task.review_text,
    archived: task.archived, revision: task.revision, note_ids: task.notes.map(({ id }) => id), ...changes,
  };
}

async function ensureFits(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page must fit the viewport");
}

async function verifyFeedbackPagination({ owner, first, note }) {
  for (let index = 0; index < 100; index++) {
    const response = await owner.request.post(first.path + "/notes", {
      headers, data: { start_ms: index, body: "페이지 검증 " + index },
    });
    assert.equal(response.status(), 201);
  }

  const page = await (await owner.request.get(first.path + "/notes")).json();
  assert.equal(page.length, 100);
  assert.ok(!page.some(({ id }) => id === note.id));
  await owner.goto(first.url + "?note=" + note.id);
  await owner.getByRole("region", { name: "선택한 피드백" }).getByText(note.body, { exact: true }).waitFor();
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
  const editor = await other.newPage();

  await login(owner, { email: ownerEmail });
  const title = "UI 파일럿 " + new Date().toISOString();
  await button(owner, "새 프로젝트").click();
  await owner.getByLabel("프로젝트 이름", { exact: true }).fill(title);
  await button(owner, "프로젝트 만들기").click();
  await owner.waitForURL("**/media");
  const media = owner.url();
  const projectURL = media.slice(0, -"/media".length);
  const project = projectURL.split("/").at(-1);
  const base = origin + "/v1/projects/" + project;
  await owner.getByRole("heading", { name: title, exact: true }).waitFor();
  await owner.getByText("WAV 또는 MP3 파일을 올려 검토를 시작하세요.", { exact: true }).waitFor();

  const first = await upload(owner, { file: wav, action: "음원 업로드", expected: "ready" });
  await ensureFits(owner);
  const waveform = await owner.locator("canvas.waveform").boundingBox();
  assert.ok(waveform && waveform.y + waveform.height <= 900);

  await tab(owner, "설정").click();
  await button(owner, "팀원 초대").click();
  await owner.getByLabel("초대할 이메일").fill(reviewerEmail);
  await owner.getByLabel("초대 역할").selectOption("editor");
  await button(owner, "초대 링크 만들기").click();
  const invite = await owner.getByLabel("초대 링크", { exact: true }).inputValue();
  await login(editor, { email: reviewerEmail, url: invite, target: media });
  const editorSession = await (await editor.request.get(origin + "/v1/me")).json();

  await link(editor, "mix-v1").click();
  await editor.waitForURL(first.url);
  const slider = editor.getByRole("slider", { name: "재생 위치", exact: true });
  await slider.press("End");
  assert.equal(Number(await slider.inputValue()), first.duration_ms);
  await slider.press("Home");
  await button(editor, "재생").click();
  await editor.waitForFunction(() => document.querySelector("audio")?.currentTime > .12);
  const message = "인트로 볼륨을 조금 낮춰 주세요.";
  const createdNote = await writeFeedback(editor, message, { playing: true });
  const feedbackURL = first.url + "?note=" + createdNote.id;
  const note = await (await editor.request.get(first.path + "/notes/" + createdNote.id)).json();
  assert.equal(note.start_ms, createdNote.anchor);
  console.log("Project, WAV, invitation, playback and anchored feedback passed");

  const signedOut = await desktop.newPage();
  await signedOut.goto(feedbackURL);
  await link(signedOut, "로그인").waitFor();
  await login(signedOut, { email: ownerEmail, url: feedbackURL, target: feedbackURL });
  await signedOut.getByRole("region", { name: "선택한 피드백" }).getByText(message, { exact: true }).waitFor();
  await signedOut.waitForFunction((ms) => Math.abs(document.querySelector("audio")?.currentTime * 1000 - ms) <= 20, note.start_ms);
  await signedOut.close();

  await owner.goto(feedbackURL);
  await link(owner, "작업 만들기").click();
  const taskTitle = "인트로 레벨 조정 " + project.slice(0, 8);
  await owner.getByLabel("작업 제목").fill(taskTitle);
  await owner.getByLabel("담당자", { exact: true }).selectOption(editorSession.account_id);
  await button(owner, "작업 만들기").click();
  await owner.waitForURL("**/tasks/*");
  const taskURL = owner.url();
  const taskPath = base + "/tasks/" + taskURL.split("/").at(-1);
  const task = await (await owner.request.get(taskPath)).json();
  assert.equal(task.notes[0].id, note.id);

  await editor.getByText(/^알림/).first().click();
  const inbox = editor.getByRole("region", { name: "알림 목록" });
  const assignment = inbox.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "작업이 배정됐습니다" });
  await link(assignment, "작업이 배정됐습니다").click();
  await editor.waitForURL(taskURL);
  await button(editor, "진행 시작").click();
  await button(editor, "저장").click();
  await button(editor, "검토 요청").waitFor();

  await editor.goto(first.url);
  const second = await upload(editor, { file: mp3, action: "수정본 업로드", expected: "ready" });
  assert.ok(second.duration_ms < first.duration_ms);
  assert.deepEqual(await (await editor.request.get(second.path + "/notes")).json(), []);
  assert.deepEqual(await (await owner.request.get(first.path + "/files/original")).body(), await readFile(wav));
  assert.equal((await (await owner.request.get(first.path + "/notes/" + note.id)).json()).start_ms, note.start_ms);

  await editor.goto(taskURL);
  await button(editor, "검토 요청").click();
  await editor.getByLabel("검토 설명").fill("수정본의 인트로 레벨을 확인해 주세요.");
  await editor.getByText("결과 버전 선택", { exact: true }).click();
  await button(editor, "mix-v2.mp3").click();
  await button(editor, "저장").click();
  await link(editor, "결과 버전 열기").waitFor();
  const review = await (await owner.request.get(taskPath)).json();
  assert.equal(review.result_version_id, second.id);
  assert.equal(review.status, "review");
  assert.equal((await owner.request.put(taskPath, { headers, data: taskPayload(review, { status: "done" }) })).status(), 409);

  await owner.goto(origin + "/work?filter=review");
  await link(owner, taskTitle).click();
  await owner.waitForURL(taskURL);
  await link(owner, "결과 버전 열기").click();
  await owner.waitForURL(second.url);
  await button(owner, "재생").waitFor();
  await owner.goto(taskURL);
  await button(owner, "완료").click();
  await owner.getByLabel("미해결 피드백을 확인하고 완료합니다").check();
  await button(owner, "저장").click();
  await button(owner, "다시 열기").waitFor();

  const tasks = projectURL + "/tasks";
  await owner.goto(tasks + "?view=board&status=done");
  const done = owner.getByRole("region", { name: "완료", exact: true });
  await link(done, taskTitle).click();
  await owner.waitForURL(taskURL + "?status=done&view=board");
  await link(owner, "작업 목록").click();
  await owner.waitForURL(tasks + "?status=done&view=board");
  await owner.goto(origin + "/?project=" + project + "#task-board");
  await owner.waitForURL(tasks);
  await link(owner, taskTitle).click();
  await owner.waitForURL(taskURL);
  await button(owner, "작업 편집").click();
  await owner.getByLabel("작업 설명").fill("작성 중인 변경");
  await owner.goBack();
  await owner.waitForURL(tasks);
  await link(owner, taskTitle).click();
  await owner.waitForURL(taskURL);
  await button(owner, "작업 편집").click();
  assert.equal(await owner.getByLabel("작업 설명").inputValue(), "작성 중인 변경");
  owner.once("dialog", (dialog) => dialog.accept());
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  console.log("Assignment notification, MP3 revision, review, completion and board navigation passed");

  await owner.goto(feedbackURL);
  await owner.getByRole("textbox", { name: "답글", exact: true }).fill("수정본을 올렸습니다.");
  await button(owner, "답글 남기기").click();
  await owner.locator("p.message-body").filter({ hasText: /^수정본을 올렸습니다\.$/ }).waitFor();
  await editor.getByText(/^알림/).first().click();
  const reply = inbox.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "새 답글" });
  await button(reply, "읽음").click();
  await link(reply, "새 답글").click();
  await editor.waitForURL(feedbackURL);
  await editor.locator("p.message-body").filter({ hasText: /^수정본을 올렸습니다\.$/ }).waitFor();

  await owner.goto(projectURL + "/activity?type=task");
  await owner.getByRole("link", { name: "작업 변경", exact: true }).first().click();
  await owner.waitForURL(taskURL);
  const exported = await (await owner.request.get(base + "/export/json")).json();
  assert.ok(exported.records.some(({ kind, data }) => kind === "task" && data.status === "done" && data.id === task.id));
  assert.equal((await owner.request.get(base + "/export/csv")).status(), 200);

  await owner.goto(second.url);
  await upload(owner, { file: { name: "invalid.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid waveform") },
    action: "수정본 업로드", expected: "failed" });
  assert.equal((await (await owner.request.get(first.path)).json()).state, "ready");
  await tab(owner, "음원").click();
  await link(owner, "mix-v1").click();
  await owner.waitForURL(second.url);
  await owner.getByRole("link", { name: /최신 버전 처리 실패/ }).waitFor();

  if (process.env.SAMTDI_VERIFY_PAGINATION === "1") {
    await verifyFeedbackPagination({ owner, first, note });
    console.log("Direct feedback link beyond the first 100 results passed");
  }

  if (process.env.SAMTDI_VERIFY_MOBILE === "1") {
    const mobile = await launch(webkit, {});
    const touch = await mobile.newPage({ ...devices["iPhone 13"] });
    await login(touch, { email: reviewerEmail });
    await touch.goto(first.url);
    await touch.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
    await ensureFits(touch);
    await button(touch, "현재 위치에 피드백").click();
    await touch.keyboard.press("Escape");
    await touch.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await button(touch, "현재 위치에 피드백").evaluate((element) => element === document.activeElement), true);
    await writeFeedback(touch, "모바일 화면에서 확인했습니다.");
    await tab(touch, "작업").click();
    await link(touch, taskTitle).waitFor();
    await ensureFits(touch);
    console.log("Mobile WebKit:", mobile.version(), "viewport, audio, keyboard, feedback and tasks passed");
  }

  await owner.goto(projectURL + "/settings");
  owner.once("dialog", (dialog) => dialog.accept());
  await button(owner, reviewerEmail + " 제거").click();
  await owner.getByText("팀원을 제거했습니다.", { exact: true }).waitFor();
  assert.equal((await editor.request.get(first.path + "/files/playback", { headers: { Range: "bytes=0-31" } })).status(), 404);
  assert.equal((await editor.request.get(base + "/export/json")).status(), 404);
  await editor.goto(taskURL);
  await editor.getByRole("heading", { name: "프로젝트를 열 수 없습니다" }).waitFor();
  assert.equal((await owner.request.patch(base + "/archive", { headers, data: { archived: true } })).status(), 204);
  await owner.reload();
  await owner.goto(origin + "/projects");
  const archived = owner.getByLabel("보관된 프로젝트");
  await archived.waitFor();
  assert.equal(await link(owner, title).count(), 0);
  await archived.check();
  await link(owner, title).waitFor();
  console.log("Pilot journey passed: two accounts, version review, precise links, exports, media failure and revocation");
} finally {
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  await rm(assets, { recursive: true, force: true });
}
