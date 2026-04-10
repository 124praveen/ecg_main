const DB_NAME = "ecg-viewer";
const DB_VERSION = 1;
const STORE_NAME = "ecg-data";

// 30 seconds of data per chunk at 250Hz
export const CHUNK_SIZE = 7500;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function put(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Batch-put multiple key-value pairs in a single transaction
async function putBatch(entries) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function storeMeta(fileKey, meta) {
  await put(`${fileKey}_meta`, meta);
}

export async function storeChunkBatch(fileKey, chunks) {
  const entries = chunks.map(({ index, data }) => [
    `${fileKey}_chunk_${index}`,
    new Float64Array(data),
  ]);
  await putBatch(entries);
}

export async function getMeta(fileKey) {
  return get(`${fileKey}_meta`);
}

export async function getChunk(fileKey, index) {
  return get(`${fileKey}_chunk_${index}`);
}

// Load a range of chunks in parallel
export async function getChunks(fileKey, startIdx, endIdx) {
  const promises = [];
  for (let i = startIdx; i <= endIdx; i++) {
    promises.push(getChunk(fileKey, i));
  }
  return Promise.all(promises);
}

export async function clearFile(fileKey) {
  const meta = await getMeta(fileKey);
  if (!meta) return;
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  store.delete(`${fileKey}_meta`);
  for (let i = 0; i < meta.totalChunks; i++) {
    store.delete(`${fileKey}_chunk_${i}`);
  }
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
  });
}

export function makeFileKey(file) {
  return `${file.name}_${file.size}_${file.lastModified}`;
}
