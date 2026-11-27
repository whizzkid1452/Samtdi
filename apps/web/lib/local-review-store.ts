import type { components } from "./api-types";

export type LocalProject = { id: string; title: string; createdAt: string };
export type LocalVersion = {
  id: string;
  projectId: string;
  filename: string;
  createdAt: string;
  duration: number;
  peaks: number[][];
  preview: Blob;
  original: File;
};
export type LocalNote = components["schemas"]["Note"];
export type LocalLibrary = {
  projects: LocalProject[];
  versions: LocalVersion[];
  notes: LocalNote[];
};

const name = "samtdi-local-review";
type Store = "projects" | "versions" | "notes";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(name, 1);

  request.onupgradeneeded = () => {
    const db = request.result;
    for (const store of ["projects", "versions", "notes"] as const) {
      db.createObjectStore(store, { keyPath: "id" });
    }
  };

  return requestResult(request);
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("저장을 취소했습니다."));
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function readLocalLibrary(): Promise<LocalLibrary> {
  const db = await openDatabase();

  try {
    const tx = db.transaction(["projects", "versions", "notes"], "readonly");
    const [projects, versions, notes] = await Promise.all([
      requestResult<LocalProject[]>(tx.objectStore("projects").getAll()),
      requestResult<LocalVersion[]>(tx.objectStore("versions").getAll()),
      requestResult<LocalNote[]>(tx.objectStore("notes").getAll()),
    ]);

    return { projects, versions, notes };
  } finally {
    db.close();
  }
}

async function put(store: Store, value: LocalProject | LocalVersion | LocalNote): Promise<void> {
  const db = await openDatabase();

  try {
    const tx = db.transaction(store, "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(store).put(value);
    await done;
  } finally {
    db.close();
  }
}

export const saveLocalProject = (project: LocalProject) => put("projects", project);
export const saveLocalVersion = (version: LocalVersion) => put("versions", version);
export const saveLocalNote = (note: LocalNote) => put("notes", note);
