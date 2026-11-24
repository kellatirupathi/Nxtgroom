// Keeps what someone has filled in on the institute form in their own browser
// (IndexedDB, which can hold the photos too), so reloading the page by mistake
// does not lose it. Nothing here goes to the server. A kept draft is for one
// form link and one date; it is dropped once sent, cleared, or a week old.

const DB_NAME = 'facultytrack-form-drafts';
const STORE = 'drafts';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredPerson {
  id?: string;
  crop?: Blob;
  instructorId: string;
  source: 'label' | 'manual' | 'none';
  readText?: string;
  box: { left: number; top: number; width: number; height: number } | null;
}

export interface StoredPhotoPeople {
  status: 'ready' | 'failed';
  people: StoredPerson[];
  message?: string;
}

export interface StoredDraft {
  version: 1;
  savedAt: number;
  // The saved response this draft edits (its last update), or null for a new one.
  baseUpdatedAt: string | null;
  status: 'yes' | 'no' | '';
  submittedBy: string;
  reason: string;
  reasonOther: string;
  keptIds: string[];
  added: { key: string; file: Blob; name: string }[];
  // By saved photo id, or by the `key` of an added photo.
  people: Record<string, StoredPhotoPeople>;
}

export function draftKey(token: string, date: string): string {
  return `${token}:${date}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

// Whether a value read back is a draft this version can use, and not too old.
export function usableDraft(value: unknown, now: number = Date.now()): StoredDraft | null {
  const draft = value as StoredDraft | null;
  if (!draft || typeof draft !== 'object' || draft.version !== 1) return null;
  if (typeof draft.savedAt !== 'number' || now - draft.savedAt > MAX_AGE_MS) return null;
  if (!Array.isArray(draft.keptIds) || !Array.isArray(draft.added) || typeof draft.people !== 'object' || !draft.people) return null;
  return draft;
}

// Whether the draft still fits the response on the server: a draft of a new
// form only while nothing has been sent; an edit only while the saved
// response is unchanged since editing began.
export function draftMatches(draft: StoredDraft, responseUpdatedAt: string | null): boolean {
  return (draft.baseUpdatedAt ?? null) === (responseUpdatedAt ?? null);
}

export async function saveFormDraft(key: string, draft: StoredDraft): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.put(draft, key));
  } catch {
    // Private browsing or full storage: the form still works, it just is not kept.
  }
}

export async function loadFormDraft(key: string): Promise<StoredDraft | null> {
  try {
    const value = await withStore('readonly', (store) => store.get(key));
    const draft = usableDraft(value);
    if (!draft && value !== undefined) await deleteFormDraft(key);
    return draft;
  } catch {
    return null;
  }
}

export async function deleteFormDraft(key: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch { }
}
