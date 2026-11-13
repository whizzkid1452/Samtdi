"use strict";

const { project, review } = document.body.dataset;
const byId = (id) => document.getElementById(id);
const projectAPI = `/v1/projects/${project}/reviews`;
const reviewAPI = `${projectAPI}/${review}`;
const stateNames = { open: "검토 중", stale: "이전 검토", merged: "병합됨", clean: "검증 완료", conflict: "충돌 있음", unchecked: "검증 전" };
const roleNames = { owner: "소유자", editor: "편집자", reviewer: "리뷰어" };
const mediaNames = { queued: "대기 중", running: "렌더 중", ready: "준비됨", incomplete: "플러그인 누락", failed: "실패" };
const errors = {
    insufficient_role: "이 작업을 할 권한이 없습니다.",
    authentication_required: "세션이 만료됐습니다. 화면을 새로고침해 로그인하세요.",
    review_not_current: "브랜치가 변경됐습니다. 최신 커밋으로 새 검토를 시작하세요.",
    review_conflict: "음악 편집이 충돌했습니다. 검증 결과의 해결 선택을 확인하세요.",
    renderer_unavailable: "이 서버의 렌더 작업자가 연결되지 않았습니다.",
    invalid_review_render: "렌더 범위 또는 검토 커밋을 확인하세요.",
    review_already_included: "이미 공유 브랜치에 포함된 작업입니다.",
};

let currentReview;
let comparisonPairs = [];
let audioSide = "";
let playbackChange;
let mediaRequest;

function createText(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
}

async function requestJSON(url, payload) {
    const options = payload === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    };
    const response = await fetch(url, options);
    const data = response.status === 204 ? null : await response.json();

    if (!response.ok) {
        throw new Error(errors[data?.error] ?? `요청을 처리하지 못했습니다 (${response.status}).`);
    }

    return data;
}

function message(text) {
    byId("feedback").textContent = text;
}

function bindAction(element, eventName, task) {
    element?.addEventListener(eventName, async (event) => {
        event.preventDefault();
        const button = element.tagName === "FORM" ? element.querySelector("button") : element;
        if (button.disabled) return;

        button.disabled = true;
        message("");
        try {
            await task(event);
        } catch (error) {
            message(error.message);
        } finally {
            button.disabled = false;
        }
    });
}

function showListing(items, render) {
    const listing = byId("listing");
    if (!items?.length) {
        listing.replaceChildren(createText("p", "표시할 항목이 없습니다.", "muted"));
        return;
    }

    listing.replaceChildren(...items.map(render));
}

function listingLink(url, title, detail) {
    const item = createText("article", "", "item");
    const link = createText("a", title);
    link.href = url;
    item.append(link, createText("p", detail, "muted"));
    return item;
}

async function showReviewList() {
    const items = await requestJSON(projectAPI);
    showListing(items, (item) => listingLink(
        `/review/${project}/${item.id}`, item.title,
        `${stateNames[item.state]} · ${item.source_ref.slice("refs/heads/".length)} · ${item.head_oid.slice(0, 12)}`,
    ));

    const create = byId("create-review");
    bindAction(create, "submit", async () => {
        const data = new FormData(create);
        const item = await requestJSON(projectAPI, { title: data.get("title"), source_branch: data.get("branch") });
        window.location.assign(`/review/${project}/${item.id}`);
    });
}

function displayValue(value) {
    if (!value?.present) return "없음";
    const json = JSON.stringify(value.value);
    return (json.length > 220 ? `${json.slice(0, 220)}…` : json) + (value.unit ? ` ${value.unit}` : "");
}

async function showDiff() {
    const { diff } = await requestJSON(`${reviewAPI}/diff`);
    const changes = diff.result.changes;
    byId("diff-count").textContent = changes.length > 150 ? `${changes.length}개 중 150개` : `${changes.length}개`;

    const rows = changes.slice(0, 150).map((change) => {
        const row = createText("article", "", "item");
        row.append(
            createText("strong", `${change.object.kind} · ${change.property || change.object.id}`),
            createText("p", `${displayValue(change.before)} → ${displayValue(change.after)}`, "muted"),
        );
        return row;
    });
    byId("diff-list").replaceChildren(...(rows.length ? rows : [createText("p", "음악 변경이 없습니다.", "muted")]));
}

async function showComments() {
    const comments = await requestJSON(`${reviewAPI}/comments`);
    const rows = comments.map((comment) => {
        const row = createText("article", "", "item");
        const position = comment.position_ticks === null ? "" : ` · ${comment.position_ticks}틱`;
        const side = comment.commit_oid === currentReview.base_oid ? "기준" : "변경";
        row.append(
            createText("strong", `${side} · ${comment.commit_oid.slice(0, 12)}${position}`),
            createText("p", comment.body, "comment-body"),
        );
        return row;
    });
    byId("comments").replaceChildren(...(rows.length ? rows : [createText("p", "기록된 댓글이 없습니다.", "muted")]));
}

async function showReviewState() {
    currentReview = await requestJSON(reviewAPI);
    byId("page-title").textContent = currentReview.title;
    byId("review-state").textContent = stateNames[currentReview.state];
    byId("base-commit").textContent = currentReview.base_oid;
    byId("head-commit").textContent = currentReview.head_oid;
    byId("source-branch").textContent = `변경 · ${currentReview.source_ref.slice("refs/heads/".length)}`;
    byId("review-note").textContent = currentReview.state === "stale"
        ? "검토 이후 브랜치가 변경됐습니다. 아래 비교와 댓글은 이전 커밋에 연결됩니다."
        : currentReview.state === "merged" ? `병합 커밋 ${currentReview.merged_oid}` : stateNames[currentReview.validation];
    const controls = byId("merge-tools");
    if (controls) controls.hidden = currentReview.state !== "open";
}

function matchingPairs(items) {
    const key = ({ settings, renderer_hash }) => `${renderer_hash}:${JSON.stringify(settings)}`;
    const bases = new Map();
    const pairs = new Map();

    for (const item of items) {
        if (item.state === "ready" && item.commit_oid === currentReview.base_oid && !bases.has(key(item))) {
            bases.set(key(item), item);
        }
    }
    for (const item of items) {
        const id = key(item);
        if (item.state === "ready" && item.commit_oid === currentReview.head_oid && bases.has(id) && !pairs.has(id)) {
            pairs.set(id, { id, a: bases.get(id), b: item });
        }
    }

    return [...pairs.values()];
}

function resetPlayback() {
    playbackChange?.abort();
    const audio = byId("audio");
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audioSide = "";

    for (const side of ["a", "b"]) byId(`play-${side}`).setAttribute("aria-pressed", "false");
}

async function showMedia() {
    const sequence = Symbol();
    mediaRequest = sequence;
    const media = await requestJSON(`${reviewAPI}/media`);
    if (mediaRequest !== sequence) return;

    const select = byId("audio-pair");
    const oldPair = select.value;
    comparisonPairs = matchingPairs(media);
    select.replaceChildren(...comparisonPairs.map(({ id, a }) => {
        const option = createText("option", `${a.settings.beginSeconds}–${a.settings.endSeconds}초 · ${a.settings.sampleRateHz / 1000} kHz`);
        option.value = id;
        return option;
    }));
    if (comparisonPairs.some(({ id }) => id === oldPair)) {
        select.value = oldPair;
    } else {
        resetPlayback();
    }
    for (const side of ["a", "b"]) byId(`play-${side}`).disabled = comparisonPairs.length === 0;

    const latest = [currentReview.base_oid, currentReview.head_oid].map((commit) => media.find((item) => item.commit_oid === commit));
    byId("media-state").textContent = latest.map((item, index) => {
        const status = item ? mediaNames[item.state] : "렌더 없음";
        return `${index === 0 ? "기준" : "변경"} ${status}`;
    }).join(" · ");
}

function switchAudio(side) {
    const pair = comparisonPairs.find(({ id }) => id === byId("audio-pair").value);
    if (!pair || audioSide === side) return;

    playbackChange?.abort();
    playbackChange = new AbortController();
    const audio = byId("audio");
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const resume = !audio.paused;

    audio.src = `${reviewAPI}/media/${pair[side].id}/wav`;
    audio.addEventListener("loadedmetadata", () => {
        audio.currentTime = Math.min(position, audio.duration);
        if (resume) audio.play().catch(() => message("선택한 WAV의 재생 버튼을 눌러주세요."));
    }, { once: true, signal: playbackChange.signal });
    audio.load();
    audioSide = side;

    for (const choice of ["a", "b"]) byId(`play-${choice}`).setAttribute("aria-pressed", String(choice === side));
}

async function showReview() {
    await showReviewState();
    const comment = byId("comment-form");
    const render = byId("render-form");

    bindAction(comment, "submit", async () => {
        const data = new FormData(comment);
        const ticks = data.get("ticks");
        await requestJSON(`${reviewAPI}/comments`, {
            body: data.get("body"),
            commit_oid: data.get("side") === "base" ? currentReview.base_oid : currentReview.head_oid,
            position_ticks: ticks === "" ? null : Number(ticks),
        });
        comment.reset();
        await showComments();
    });
    bindAction(render, "submit", async () => {
        const data = new FormData(render);
        const range = { begin_seconds: Number(data.get("begin")), end_seconds: Number(data.get("end")) };
        await Promise.all([currentReview.base_oid, currentReview.head_oid].map((commit) =>
            requestJSON(`${reviewAPI}/media`, { ...range, commit_oid: commit, retry: true }),
        ));
        await showMedia();
    });
    bindAction(byId("refresh-media"), "click", showMedia);
    byId("audio-pair").addEventListener("change", resetPlayback);
    for (const side of ["a", "b"]) byId(`play-${side}`).addEventListener("click", () => switchAudio(side));

    for (const action of ["validate", "merge"]) bindAction(byId(action), "click", async () => {
        const input = byId("resolutions").value.trim();
        const result = await requestJSON(`${reviewAPI}/${action}`, input ? JSON.parse(input) : { resolutions: [] });
        const output = byId("merge-result");
        output.textContent = action === "validate"
            ? JSON.stringify({ validation: result.validation, conflicts: result.merge.result.conflicts, issues: result.merge.result.issues }, null, 2)
            : `병합 커밋 ${result.merged_oid}`;
        output.hidden = false;
        await showReviewState();
    });

    await Promise.all([showDiff(), showComments(), showMedia()]);
}

bindAction(byId("logout"), "click", async () => {
    await requestJSON("/v1/auth/logout", {});
    window.location.assign("/review");
});

async function start() {
    if (review) return showReview();
    if (project) return showReviewList();
    const items = await requestJSON("/v1/projects");
    showListing(items, (item) => listingLink(`/review/${item.id}`, item.title, roleNames[item.role]));
}

start().catch((error) => message(error.message));
