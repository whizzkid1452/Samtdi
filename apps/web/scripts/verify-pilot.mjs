import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, devices } from "playwright";

const verifyURL = new URL(process.env.SAMTDI_VERIFY_ORIGIN ?? "http://127.0.0.1:3100");
assert.equal(verifyURL.protocol, "http:");
assert.equal(verifyURL.hostname, "127.0.0.1");
const origin = verifyURL.origin;
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

async function createInvitation(page, { email, role }) {
  await button(page, "팀원 초대").click();
  const dialog = page.getByRole("dialog", { name: "팀원 초대", exact: true });
  await dialog.getByRole("textbox", { name: "초대할 이메일" }).fill(email);
  await dialog.getByLabel("초대 역할").selectOption(role);

  await button(dialog, "초대 링크 만들기").click();
  await dialog.waitFor({ state: "hidden" });
  return page.getByLabel("초대 링크", { exact: true }).inputValue();
}

async function upload(page, { file, action, expected }) {
  await button(page, action).click();
  await page.getByLabel("오디오 파일 입력").setInputFiles(file);
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
  if (action === "수정본 업로드") {
    await link(page, "업로드한 버전 열기").waitFor();
    assert.notEqual(page.url(), url);
    await link(page, "업로드한 버전 열기").click();
  }
  await page.waitForURL(url);
  if (expected === "ready") await button(page, "재생").waitFor();
  else await page.locator(".version-overview > .row").getByText("처리 실패", { exact: true }).waitFor();
  const ready = await (await page.request.get(path)).json();
  assert.equal(ready.state, expected);
  return { ...ready, path, url };
}

async function writeFeedback(page, message, { playing = false } = {}) {
  await button(page, "이 위치에 피드백 남기기").click();
  const composer = page.getByRole("form", { name: "피드백 남기기" });
  const [minutes, seconds] = (await composer.locator(".feedback-time").textContent()).split(":");
  const anchor = Math.round((Number(minutes) * 60 + Number(seconds)) * 1000);
  await composer.getByLabel("피드백 내용").fill(message);
  if (playing) {
    assert.equal(await page.locator("audio").evaluate(audio => audio.paused), true);
    await button(page, "재생").click();
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

async function verifyWaveformSeeking(page, durationMs) {
  const waveform = page.getByRole("slider", { name: "재생 위치", exact: true });
  const bounds = await waveform.boundingBox();
  assert.ok(bounds);
  const volume = page.getByRole("slider", { name: "음량", exact: true });
  await volume.press("ArrowLeft");
  assert.equal(await page.locator("audio").evaluate((audio) => audio.volume), 0.95);
  await volume.press("End");

  const y = bounds.y + bounds.height / 4;
  const start = bounds.x + bounds.width * .2;
  const end = bounds.x + bounds.width * .75;
  await page.mouse.click(start, y);
  await page.waitForFunction(ms => Math.abs(document.querySelector("audio").currentTime * 1000 - ms) < 20, durationMs * .2);
  await page.mouse.move(start, y);
  await page.mouse.down();
  await page.mouse.move(end, y, { steps: 8 });
  await page.waitForFunction(ms => Math.abs(document.querySelector("audio").currentTime * 1000 - ms) < 20, durationMs * .75);
  await page.mouse.up();

  await waveform.press("End");
  assert.equal(Number(await waveform.getAttribute("aria-valuenow")), durationMs);
  await waveform.press("Home");
}

async function verifyRangeSelection(page, durationMs) {
  const waveform = page.getByRole("slider", { name: "재생 위치", exact: true });
  const bounds = await waveform.boundingBox();
  assert.ok(bounds);

  const y = bounds.y + bounds.height / 3;
  const start = bounds.x + bounds.width * .2;
  const end = bounds.x + bounds.width * .6;
  await page.mouse.move(end, y);
  await page.mouse.down();
  await page.mouse.move(start, y, { steps: 8 });
  await page.mouse.up();

  const tolerance = durationMs / bounds.width + 1;
  for (const [label, fraction] of [["시작", .2], ["끝", .6]]) {
    const milliseconds = Number(await page.getByLabel(label + " (초)").inputValue()) * 1000;
    assert.ok(Math.abs(milliseconds - fraction * durationMs) <= tolerance, `Unexpected range ${label} ${milliseconds}ms`);
  }
}

async function verifyMovingPlayhead(page) {
  const playhead = page.locator(".waveform-playhead");
  const sample = await playhead.evaluate(async (element) => {
    const audio = element.closest("section").querySelector("audio");
    const start = audio.currentTime;
    const positions = new Set();
    const deadline = performance.now() + 2000;
    while (audio.currentTime < start + .5 && performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      const position = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
      positions.add(position);
    }
    return positions.size;
  });
  assert.ok(sample >= 5, `Expected smooth playhead movement, observed ${sample} positions`);
}

async function verifyFeedbackPagination({ owner, first, note }) {
  const url = first.path + "/notes";
  async function collect(sort) {
    const notes = [];
    for (let cursor = ""; ;) {
      const query = new URLSearchParams({ sort });
      if (cursor) query.set("after", cursor);
      const response = await owner.request.get(url + "?" + query);
      assert.equal(response.status(), 200);
      const page = await response.json();
      notes.push(...page);
      if (page.length < 100) return notes;
      cursor = page.at(-1).id;
    }
  }

  const existing = (await collect("recent")).length;
  for (let index = 0; index < 205; index++) {
    const response = await owner.request.post(url, {
      headers, data: { start_ms: index % 2, body: "페이지 검증 " + index },
    });
    assert.equal(response.status(), 201);
  }

  const legacy = await (await owner.request.get(url)).json();
  assert.equal(legacy.length, 100);
  assert.ok(!legacy.some(({ id }) => id === note.id));

  for (const sort of ["time", "recent"]) {
    const notes = await collect(sort);
    assert.equal(notes.length, existing + 205);
    assert.equal(new Set(notes.map(({ id }) => id)).size, notes.length);
    if (sort === "time") {
      const sorted = [...notes].sort((left, right) => left.start_ms - right.start_ms || left.id.localeCompare(right.id));
      assert.deepEqual(notes, sorted);
    } else {
      assert.equal(notes[0].id, legacy[0].id);
      assert.equal(notes.at(-1).id, note.id);
    }
  }

  await owner.goto(first.url + "?note=" + note.id + "&sort=recent&feedback=all");
  await owner.getByRole("region", { name: "선택한 피드백" }).getByText(note.body, { exact: true }).waitFor();
  await owner.getByText("현재 목록 밖의 피드백").waitFor();
  await button(owner, "피드백 더 보기").click();
  await owner.getByText("불러온 피드백 200개 표시").waitFor();
  await button(owner, "피드백 더 보기").click();
  await owner.locator(".feedback-list > li").filter({ hasText: note.body }).waitFor();
  await owner.getByLabel("정렬").selectOption("time");
  await owner.waitForURL((url) => url.searchParams.get("sort") === "time");
}

async function verifyFeedbackTaskFlow({ owner, editor, first, base, projectURL }) {
  const ownerSession = await (await owner.request.get(origin + "/v1/me")).json();
  const message = "엔딩 리버브 조정 " + projectURL.split("/").at(-1).slice(0, 8);
  await button(editor, "이 위치에 피드백 남기기").click();
  const composer = editor.getByRole("form", { name: "피드백 남기기" });
  await composer.getByLabel("피드백 내용").fill(message);
  await composer.getByLabel("할 일로 만들기").check();
  await composer.getByRole("combobox", { name: "담당자" }).click();
  const ownerName = ownerSession.name || ownerSession.email.split("@")[0];
  await composer.getByRole("option", { name: ownerName, exact: true }).click();
  const saved = editor.waitForResponse((response) => response.url().endsWith("/notes") && response.request().method() === "POST");
  await button(composer, "피드백 저장").click();
  const created = await (await saved).json();
  assert.ok(created.task_id, "Feedback must create its linked task");
  const taskPath = base + "/tasks/" + created.task_id;
  const task = await (await owner.request.get(taskPath)).json();
  assert.equal(task.title, message);
  assert.equal(task.assignee_id, ownerSession.account_id);
  assert.equal(task.source.note_id, created.id);
  assert.equal(task.source.version_id, first.id);
  await editor.locator(".feedback-list").getByRole("button").filter({ hasText: message }).filter({ hasText: "할 일" }).first().waitFor();

  await owner.goto(projectURL + "/tasks");
  const card = owner.locator("article.task-card").filter({ has: link(owner, message) });
  await card.locator("a.task-source-link").waitFor();
  await button(card, message + " 관리").click();
  const moved = owner.waitForResponse((response) => response.url() === taskPath && response.request().method() === "PUT");
  await button(owner, "진행 중으로 이동").click();
  assert.equal((await moved).status(), 200);
  await owner.getByRole("region", { name: "진행 중", exact: true }).getByRole("link", { name: message, exact: true }).waitFor();

  await owner.goto(projectURL + "/tasks?view=timeline");
  const chip = owner.getByRole("group", { name: "날짜 없는 작업" }).getByRole("link", { name: message });
  const today = owner.locator(".timeline-day.today");
  const body = owner.locator(".timeline-body");
  const column = await today.boundingBox();
  const area = await body.boundingBox();
  assert.ok(column && area, "Timeline and today column are visible");
  const scheduled = owner.waitForResponse((response) => response.url() === taskPath && response.request().method() === "PUT");
  await chip.dragTo(body, { targetPosition: { x: column.x - area.x + column.width / 2, y: 30 } });
  assert.equal((await scheduled).status(), 200);
  const dated = await (await owner.request.get(taskPath)).json();
  assert.ok(dated.start_on && dated.start_on === dated.due_on, "Dropping on the timeline schedules one day");
  await owner.getByRole("img", { name: new RegExp("^" + message) }).waitFor();

  await owner.goto(origin + "/work");
  await owner.getByRole("region", { name: "오늘" }).getByRole("link", { name: message }).waitFor();
  await owner.getByRole("region", { name: "내 음원에 온 피드백" }).getByText(message).waitFor();
  return created.task_id;
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
  await owner.getByRole("textbox", { name: "프로젝트 이름", exact: true }).fill(title);
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
  const waveform = await owner.getByRole("slider", { name: "재생 위치", exact: true }).boundingBox();
  assert.ok(waveform && waveform.y + waveform.height <= 900);

  await tab(owner, "설정").click();
  const invite = await createInvitation(owner, { email: reviewerEmail, role: "editor" });
  await login(editor, { email: reviewerEmail, url: invite, target: media });

  await link(editor, "mix-v1").click();
  await editor.waitForURL(first.url);
  await verifyWaveformSeeking(editor, first.duration_ms);
  await button(editor, "구간 지정").click();
  await verifyRangeSelection(editor, first.duration_ms);
  await editor.getByLabel("시작 (초)").fill("0.2");
  await editor.getByLabel("끝 (초)").fill("0.6");
  await editor.getByRole("slider", { name: "구간 끝" }).press("ArrowRight");
  const end = Number(await editor.getByLabel("끝 (초)").inputValue());
  assert.ok(end > .6);
  await button(editor, "구간 듣기").click();
  await editor.waitForFunction((seconds) => {
    const audio = document.querySelector("audio");
    return audio?.paused && Math.abs(audio.currentTime - seconds) < .025;
  }, end);
  await button(editor, "구간 해제").click();
  await button(editor, "재생").click();
  await verifyMovingPlayhead(editor);
  const message = "인트로 볼륨을 조금 낮춰 주세요.";
  const createdNote = await writeFeedback(editor, message, { playing: true });
  const feedbackURL = first.url + "?note=" + createdNote.id;
  const note = await (await editor.request.get(first.path + "/notes/" + createdNote.id)).json();
  assert.equal(note.start_ms, createdNote.anchor);
  await button(editor, "이 위치에 피드백 남기기").click();
  await editor.getByLabel("피드백 내용").fill("새로고침 뒤 초안 확인");
  await editor.reload();
  await button(editor, "피드백 계속 작성").click();
  assert.equal(await editor.getByLabel("피드백 내용").inputValue(), "새로고침 뒤 초안 확인");
  await button(editor, "초안 버리기").click();
  console.log("Project, WAV, invitation, playback and anchored feedback passed");

  await verifyFeedbackTaskFlow({ owner, editor, first, base, projectURL });
  console.log("Feedback to task, board move, timeline scheduling and dashboard passed");

  const signedOut = await desktop.newPage();
  await signedOut.goto(feedbackURL);
  await link(signedOut, "로그인").waitFor();
  await login(signedOut, { email: ownerEmail, url: feedbackURL, target: feedbackURL });
  await signedOut.getByRole("region", { name: "선택한 피드백" }).getByText(message, { exact: true }).waitFor();
  await signedOut.waitForFunction((ms) => Math.abs(document.querySelector("audio")?.currentTime * 1000 - ms) <= 20, note.start_ms);
  await signedOut.close();

  await owner.goto(feedbackURL);
  await button(owner, "작업 만들기").click();
  const taskTitle = "인트로 레벨 조정 " + project.slice(0, 8);
  await owner.getByLabel("작업 제목").fill(taskTitle);
  await owner.getByRole("dialog", { name: "새 작업" }).getByRole("combobox", { name: "담당자", exact: true }).click();
  await owner.getByRole("option", { name: reviewerEmail, exact: true }).click();
  await button(owner.getByRole("dialog", { name: "새 작업" }), "작업 만들기").click();
  assert.equal(owner.url(), feedbackURL);
  await link(owner, taskTitle).click();
  await owner.waitForURL("**/tasks/*");
  const taskURL = owner.url();
  const taskPath = base + "/tasks/" + taskURL.split("/").at(-1);
  const task = await (await owner.request.get(taskPath)).json();
  assert.equal(task.notes[0].id, note.id);
  const linkedTasks = await owner.request.get(base + "/tasks?note=" + note.id);
  assert.equal(linkedTasks.status(), 200);
  assert.deepEqual((await linkedTasks.json()).map(({ id }) => id), [task.id]);
  const taskCounts = await (await owner.request.get(base + "/task-counts?note=" + note.id)).json();
  assert.equal(taskCounts.todo, 1);

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
  await editor.getByRole("option", { name: "mix-v2.mp3", exact: true }).click();
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
  await owner.keyboard.press("Escape");
  await button(owner.getByRole("dialog", { name: "미저장 변경 버리기" }), "버리기").click();
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  console.log("Assignment notification, MP3 revision, review, completion and board navigation passed");

  await owner.goto(feedbackURL);
  await button(owner, "답글").click();
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
    await button(touch, "이 위치에 피드백 남기기").click();
    await touch.keyboard.press("Escape");
    await touch.getByRole("form", { name: "피드백 남기기" }).waitFor({ state: "hidden" });
    assert.equal(await button(touch, "이 위치에 피드백 남기기").evaluate((element) => element === document.activeElement), true);
    await writeFeedback(touch, "모바일 화면에서 확인했습니다.");
    await ensureFits(touch);
    await tab(touch, "작업").click();
    await link(touch, taskTitle).waitFor();
    await ensureFits(touch);
    console.log("Mobile WebKit:", mobile.version(), "viewport, audio, keyboard, feedback and tasks passed");
  }

  await owner.goto(projectURL + "/settings");
  await button(owner, reviewerEmail + " 제거").click();
  await button(owner.getByRole("dialog", { name: "팀원 제거" }), "제거").click();
  await owner.getByText("팀원을 제거했습니다.", { exact: true }).waitFor();
  assert.equal((await editor.request.get(first.path + "/files/playback", { headers: { Range: "bytes=0-31" } })).status(), 404);
  assert.equal((await editor.request.get(base + "/export/json")).status(), 404);
  await editor.goto(taskURL);
  await editor.getByRole("heading", { name: "프로젝트를 열 수 없습니다" }).waitFor();

  const reviewerInvite = await createInvitation(owner, { email: reviewerEmail, role: "reviewer" });
  const reviewer = await other.newPage();
  await login(reviewer, { email: reviewerEmail, url: reviewerInvite, target: media });
  await link(reviewer, "mix-v1").waitFor();
  assert.equal(await button(reviewer, "음원 업로드").count(), 0);
  await reviewer.goto(tasks);
  await link(reviewer, taskTitle).waitFor();
  assert.equal(await button(reviewer, "새 작업").count(), 0);
  await reviewer.goto(feedbackURL);
  await reviewer.getByRole("region", { name: "선택한 피드백" }).waitFor();
  await button(reviewer, "이 위치에 피드백 남기기").waitFor();
  console.log("Reviewer: direct links and feedback are available, upload and task creation are restricted");

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
