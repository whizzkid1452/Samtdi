"use client";

import { BrandWordmark } from "./brand-wordmark";
import { Alert, Badge, Button, FileInput, TextInput } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { processLocalAudio } from "../lib/local-audio";
import { readLocalLibrary, saveLocalNote, saveLocalProject, saveLocalVersion, type LocalLibrary, type LocalNote } from "../lib/local-review-store";
import { timecode } from "../lib/timecode";
import { LocalReview } from "./local-review";
import "./local-workspace.css";

export function LocalWorkspace() {
  const [library, setLibrary] = useState<LocalLibrary | null>(null);
  const [projectId, setProjectId] = useState<string>();
  const [versionId, setVersionId] = useState<string>();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    let active = true;

    readLocalLibrary().then((result) => {
      if (active) setLibrary(result);
    }).catch(() => {
      if (active) setError("브라우저 저장소를 열 수 없습니다. 일반 브라우징 환경에서 다시 시도해 주세요.");
    });

    return () => { active = false; };
  }, []);

  const projects = library?.projects ?? [];
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const versions = (library?.versions ?? []).filter((item) => item.projectId === project?.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const version = versions.find((item) => item.id === versionId) ?? versions[0];
  const notes = (library?.notes ?? []).filter((note) => note.version_id === version?.id);

  function selectProject(id: string) {
    setProjectId(id);
    setVersionId(undefined);
    setFile(null);
    setError("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || pending.current || !library) return;

    const item = { id: crypto.randomUUID(), title: title.trim(), createdAt: new Date().toISOString() };
    pending.current = true;
    setStatus("프로젝트를 저장하는 중…");
    setError("");

    try {
      await saveLocalProject(item);
      setLibrary((previous) => previous ? { ...previous, projects: [item, ...previous.projects] } : previous);
      selectProject(item.id);
      setTitle("");
    } catch {
      setError("프로젝트를 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.");
    } finally {
      pending.current = false;
      setStatus("");
    }
  }

  async function importAudio(event: FormEvent) {
    event.preventDefault();
    if (!file || !project || pending.current || !library) return;

    const target = project.id;
    const original = file;
    pending.current = true;
    setStatus("음원 처리를 준비하는 중…");
    setError("");

    try {
      const processed = await processLocalAudio(original, setStatus);
      setStatus("음원과 파형을 이 브라우저에 저장하는 중…");
      const item = {
        id: crypto.randomUUID(),
        projectId: target,
        filename: original.name,
        createdAt: new Date().toISOString(),
        original,
        ...processed,
      };

      await saveLocalVersion(item);
      setLibrary((previous) => previous ? { ...previous, versions: [...previous.versions, item] } : previous);
      setVersionId(item.id);
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "음원을 저장하지 못했습니다.");
    } finally {
      pending.current = false;
      setStatus("");
    }
  }

  async function saveNote(note: LocalNote) {
    await saveLocalNote(note);
    setLibrary((previous) => previous ? { ...previous, notes: [...previous.notes.filter(({ id }) => id !== note.id), note] } : previous);
  }

  return <div className="workspace-shell local-workspace">
    <aside className="workspace-sidebar">
      <nav className="workspace-navigation" aria-label="내 프로젝트">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i/><i/><i/></span><BrandWordmark /></div>
        <Badge color="lime" variant="outline">개인 작업실</Badge>
        <section aria-label="프로젝트 바로가기">
          <h2>내 프로젝트</h2>
          {projects.map((item) => <button className="workspace-link" key={item.id} aria-current={project?.id === item.id}
            disabled={!!status} type="button" onClick={() => selectProject(item.id)}>{item.title}</button>)}
        </section>
        <p className="local-sidebar-note">현재 작업 내용은 이 브라우저에 저장됩니다.</p>
      </nav>
    </aside>
    <div className="workspace-content">
      <header className="topbar">
        <div className="row"><span className="brand"><BrandWordmark /></span><Badge color="green" variant="light">브라우저 베타</Badge></div>
        {projects.length > 0 && <select aria-label="프로젝트 선택" value={project?.id ?? ""} disabled={!!status}
          onChange={(event) => selectProject(event.currentTarget.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
      </header>
      <main className="main-content project-home">
        <div className="section-header">
          <h1>{project?.title ?? "음악을 함께 완성하는 공간"}</h1>
          <p className="muted">음원을 불러오고, 재생 위치와 구간에 피드백을 남기세요.</p>
        </div>
        <Alert color="green" variant="light" title="개인 작업실 안내">
          음원을 추가하고 원하는 구간에 피드백을 남겨보세요. 현재 체험판의 작업 내용은 이 브라우저에 저장되며, 기기 간 동기화는 협업 서버 연결 후 제공됩니다.
        </Alert>
        {error && <Alert role="alert" color="red" title="확인해 주세요">{error}</Alert>}
        {!library && !error && <p role="status">작업실을 불러오는 중…</p>}
        <form className="panel local-project-form" onSubmit={createProject}>
          <TextInput label="새 프로젝트" placeholder="예: 새 싱글 믹스" maxLength={120} value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          <Button type="submit" disabled={!library || !title.trim() || !!status}>프로젝트 만들기</Button>
        </form>
        {project && <>
          <section className="panel">
            <h2>음원 버전</h2>
            <form className="local-upload-form" onSubmit={importAudio}>
              <FileInput label="음원 파일" placeholder="WAV, MP3, FLAC, M4A 등" accept="audio/*,.wav,.mp3,.flac,.m4a,.aif,.aiff,.ogg"
                value={file} onChange={setFile} disabled={!!status} clearable />
              <Button type="submit" disabled={!file || !!status}>음원 추가</Button>
            </form>
            <p className="muted">모노·스테레오, 최대 100MB / 10분. 원본과 재생용 음원을 기기 내에 저장합니다.</p>
            {status && <p role="status" className="notice">{status}</p>}
            {versions.length === 0 ? <p className="muted">첫 음원을 추가하면 파형과 피드백 도구가 표시됩니다.</p> :
              <div className="local-version-list">{versions.map((item) => <button type="button" key={item.id} disabled={!!status}
                className="local-version-item" aria-current={item.id === version?.id}
                onClick={() => setVersionId(item.id)}><strong>{item.filename}</strong><span>{timecode(item.duration)}</span></button>)}</div>}
          </section>
          {version && <LocalReview key={version.id} version={version} notes={notes} saveNote={saveNote} />}
        </>}
      </main>
    </div>
  </div>;
}
