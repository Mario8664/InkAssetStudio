import type { StudioEditorSession } from '../domain/workspace/session';
import { createStudioDocumentSourceSnapshot, type InkStudioWorkFile } from '../domain/workspace/workspace';

const DATABASE_NAME = 'ink-asset-studio';
const DATABASE_VERSION = 1;
const DOCUMENT_STORE = 'documents';
const SETTINGS_STORE = 'settings';
const CURRENT_DOCUMENT_KEY = 'current-document-id';
const SESSION_KEY = 'editor-session';
const SAVED_AT_PREFIX = 'document-saved-at:';
let databasePromise: Promise<IDBDatabase> | null = null;

export async function saveDocument(document: InkStudioWorkFile): Promise<number> {
  const database = await openDatabase();
  const savedAt = Date.now();
  await transactionComplete(database, [DOCUMENT_STORE, SETTINGS_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(DOCUMENT_STORE).put(createStudioDocumentSourceSnapshot(document), document.documentId);
    transaction.objectStore(SETTINGS_STORE).put(document.documentId, CURRENT_DOCUMENT_KEY);
    transaction.objectStore(SETTINGS_STORE).put(savedAt, `${SAVED_AT_PREFIX}${document.documentId}`);
  });
  return savedAt;
}

export async function loadCurrentDocument(): Promise<unknown | null> {
  const database = await openDatabase();
  const id = await requestValue<string | undefined>(database.transaction(SETTINGS_STORE).objectStore(SETTINGS_STORE).get(CURRENT_DOCUMENT_KEY));
  if (!id) return null;
  return (await requestValue<unknown | undefined>(database.transaction(DOCUMENT_STORE).objectStore(DOCUMENT_STORE).get(id))) ?? null;
}

export async function loadDocumentSavedAt(documentId: string): Promise<number | null> {
  const database = await openDatabase();
  const savedAt = await requestValue<number | undefined>(database.transaction(SETTINGS_STORE).objectStore(SETTINGS_STORE).get(`${SAVED_AT_PREFIX}${documentId}`));
  return typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : null;
}

export async function saveEditorSession(session: StudioEditorSession): Promise<void> {
  const database = await openDatabase();
  await transactionComplete(database, SETTINGS_STORE, 'readwrite', (transaction) => {
    transaction.objectStore(SETTINGS_STORE).put(session, SESSION_KEY);
  });
}

export async function loadEditorSession(): Promise<StudioEditorSession | null> {
  const database = await openDatabase();
  return (await requestValue<StudioEditorSession | undefined>(database.transaction(SETTINGS_STORE).objectStore(SETTINGS_STORE).get(SESSION_KEY))) ?? null;
}

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) database.createObjectStore(DOCUMENT_STORE);
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) database.createObjectStore(SETTINGS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Unable to open local storage.'));
    };
  });
  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
  });
}

function transactionComplete(
  database: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was cancelled.'));
    action(transaction);
  });
}
