import {
  CHUNK_SIZE,
  storeChunkBatch,
  storeMeta,
  getMeta,
  makeFileKey,
} from "./ecgDB";

const BATCH_SIZE = 50; // flush 50 chunks per IndexedDB transaction

export function formatTimeLabel(date) {
  if (!date) return "";
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Main entry point ─────────────────────────────────────────────
export async function parseAndStoreFile(file, onProgress) {
  const fileKey = makeFileKey(file);

  // Check if already stored
  const existing = await getMeta(fileKey);
  if (existing && existing.totalChunks > 0) {
    if (onProgress) onProgress(100);
    return { fileKey, ...existing };
  }

  const ext = file.name.split(".").pop().toLowerCase();
  const nameLower = file.name.toLowerCase();

  let result;
  if (ext === "edf") {
    result = await parseAndStoreEdf(file, fileKey, onProgress);
  } else if (ext === "txt") {
    result = await parseAndStoreTxt(file, fileKey, nameLower.includes("denoised"), onProgress);
  } else if (ext === "csv") {
    result = await parseAndStoreCsv(file, fileKey, onProgress);
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  return { fileKey, ...result };
}

// ── Chunk flusher helper ─────────────────────────────────────────
class ChunkFlusher {
  constructor(fileKey) {
    this.fileKey = fileKey;
    this.buffer = [];
    this.pendingChunks = [];
    this.chunkIndex = 0;
    this.totalValues = 0;
  }

  push(value) {
    this.buffer.push(value);
    this.totalValues++;
    if (this.buffer.length >= CHUNK_SIZE) {
      this.pendingChunks.push({ index: this.chunkIndex, data: this.buffer });
      this.chunkIndex++;
      this.buffer = [];
    }
  }

  async flushIfNeeded() {
    if (this.pendingChunks.length >= BATCH_SIZE) {
      await storeChunkBatch(this.fileKey, this.pendingChunks);
      this.pendingChunks = [];
    }
  }

  async finalize() {
    if (this.buffer.length > 0) {
      this.pendingChunks.push({ index: this.chunkIndex, data: this.buffer });
      this.chunkIndex++;
      this.buffer = [];
    }
    if (this.pendingChunks.length > 0) {
      await storeChunkBatch(this.fileKey, this.pendingChunks);
      this.pendingChunks = [];
    }
  }
}

// ── Encoding detector ────────────────────────────────────────────
function detectEncoding(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return "utf-16le";
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return "utf-16be";
  if (bytes.length > 3 && bytes[1] === 0x00 && bytes[3] === 0x00) return "utf-16le";
  return "utf-8";
}

// ── EDF parser ───────────────────────────────────────────────────
async function parseAndStoreEdf(file, fileKey, onProgress) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

  function readAscii(start, length) {
    let s = "";
    for (let i = 0; i < length; i++) {
      s += String.fromCharCode(view.getUint8(start + i));
    }
    return s;
  }

  const headerBytes = parseInt(readAscii(184, 8).trim(), 10);
  const ns = parseInt(readAscii(252, 4).trim(), 10);

  if (!headerBytes || !ns) {
    const meta = {
      totalChunks: 0,
      chunkSize: CHUNK_SIZE,
      sampleRate: 250,
      totalValues: 0,
      durationInSeconds: 0,
      startTime: null,
    };
    await storeMeta(fileKey, meta);
    return meta;
  }

  const dateStr = readAscii(168, 8).trim();
  const timeStr = readAscii(176, 8).trim();

  function parseEdfDateTime(dStr, tStr) {
    const [dd, mm, yy] = dStr.split(".").map(Number);
    const [hh, min, ss] = tStr.split(".").map(Number);
    if (!dd || !mm || yy == null) return null;
    const year = yy < 85 ? 2000 + yy : 1900 + yy;
    return new Date(year, mm - 1, dd, hh || 0, min || 0, ss || 0);
  }

  const startTime = parseEdfDateTime(dateStr, timeStr);
  const recordDurationSec = parseFloat(readAscii(244, 8).trim());

  const base = 256;
  const physMinStart = base + 16 * ns + 80 * ns + 8 * ns;
  const physMaxStart = physMinStart + 8 * ns;
  const digMinStart = physMaxStart + 8 * ns;
  const digMaxStart = digMinStart + 8 * ns;
  const samplesStart = digMaxStart + 8 * ns + 80 * ns;

  const digMin = [], digMax = [], physMin = [], physMax = [], samplesPerRecord = [];

  for (let s = 0; s < ns; s++) {
    physMin[s] = parseFloat(readAscii(physMinStart + s * 8, 8).trim());
    physMax[s] = parseFloat(readAscii(physMaxStart + s * 8, 8).trim());
    digMin[s] = parseInt(readAscii(digMinStart + s * 8, 8).trim(), 10);
    digMax[s] = parseInt(readAscii(digMaxStart + s * 8, 8).trim(), 10);
    samplesPerRecord[s] = parseInt(readAscii(samplesStart + s * 8, 8).trim(), 10);
  }

  const totalSamplesPerRecord = samplesPerRecord.reduce((a, b) => a + b, 0);
  const dataStart = headerBytes;
  const bytesPerRecord = totalSamplesPerRecord * 2;
  const totalBytes = buffer.byteLength - dataStart;
  const numRecords = Math.floor(totalBytes / bytesPerRecord);
  const totalDurationSec = numRecords * recordDurationSec;

  const targetSignal = 0;
  const sampleRate =
    recordDurationSec && samplesPerRecord[targetSignal]
      ? samplesPerRecord[targetSignal] / recordDurationSec
      : 250;

  const flusher = new ChunkFlusher(fileKey);
  let ptr = dataStart;
  let lastProgress = 0;

  for (let r = 0; r < numRecords; r++) {
    for (let s = 0; s < ns; s++) {
      const count = samplesPerRecord[s];
      for (let i = 0; i < count; i++) {
        const raw = view.getInt16(ptr, true);
        if (s === targetSignal) {
          const scaled =
            ((raw - digMin[s]) / (digMax[s] - digMin[s])) *
              (physMax[s] - physMin[s]) +
            physMin[s];
          flusher.push(scaled);
        }
        ptr += 2;
      }
    }

    await flusher.flushIfNeeded();

    if (onProgress) {
      const pct = Math.round((r / numRecords) * 100);
      if (pct > lastProgress) {
        lastProgress = pct;
        onProgress(pct);
      }
    }

    if (r % 500 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await flusher.finalize();

  const meta = {
    totalChunks: flusher.chunkIndex,
    chunkSize: CHUNK_SIZE,
    sampleRate,
    totalValues: flusher.totalValues,
    durationInSeconds: totalDurationSec,
    startTime: startTime ? startTime.toISOString() : null,
  };
  await storeMeta(fileKey, meta);

  if (onProgress) onProgress(100);
  return meta;
}

// ── TXT parser (chunked — works for any file size) ───────────────
async function parseAndStoreTxt(file, fileKey, isDenoised, onProgress) {
  const CHUNK = 2 * 1024 * 1024; // 2MB chunks
  let offset = 0;
  let leftover = "";
  const flusher = new ChunkFlusher(fileKey);

  // Detect encoding from first 8 bytes
  const headerBuf = await file.slice(0, 8).arrayBuffer();
  const encoding = detectEncoding(new Uint8Array(headerBuf));

  while (offset < file.size) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    let text = "";
    try {
      text = new TextDecoder(encoding)
        .decode(buf)
        .replace(/^\uFEFF/, "")
        .replace(/\u0000/g, "");
    } catch {
      const bytes = new Uint8Array(buf);
      text = Array.from(bytes)
        .map(b =>
          (b >= 45 && b <= 57) || b === 10 || b === 13 || b === 43
            ? String.fromCharCode(b)
            : "\n"
        )
        .join("");
    }

    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const val = Number(t);
      if (!Number.isNaN(val)) {
        flusher.push(val);
      }
    }

    await flusher.flushIfNeeded();
    offset += CHUNK;

    if (onProgress) {
      onProgress(Math.round(offset / file.size * 100));
    }

    // Yield to keep UI responsive
    await new Promise(r => setTimeout(r, 0));
  }

  // Handle last leftover line
  if (leftover.trim()) {
    const val = Number(leftover.trim());
    if (!Number.isNaN(val)) flusher.push(val);
  }

  await flusher.finalize();

  const sampleRate = 250;
  const meta = {
    totalChunks: flusher.chunkIndex,
    chunkSize: CHUNK_SIZE,
    sampleRate,
    totalValues: flusher.totalValues,
    durationInSeconds: flusher.totalValues / sampleRate,
    startTime: null,
  };
  await storeMeta(fileKey, meta);

  if (onProgress) onProgress(100);
  return meta;
}

// ── CSV parser (chunked — works for any file size) ───────────────
async function parseAndStoreCsv(file, fileKey, onProgress) {
  const CHUNK = 2 * 1024 * 1024; // 2MB chunks
  let offset = 0;
  let leftover = "";
  const flusher = new ChunkFlusher(fileKey);

  while (offset < file.size) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    let text = "";
    try {
      text = new TextDecoder("utf-8")
        .decode(buf)
        .replace(/^\uFEFF/, "")
        .replace(/\u0000/g, "");
    } catch {
      text = "";
    }

    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";

    for (const line of lines) {
      const parts = line.split(/,|;|\s+/);
      for (const part of parts) {
        const t = part.trim();
        if (!t) continue;
        const val = Number(t);
        if (!Number.isNaN(val)) {
          flusher.push(val);
        }
      }
    }

    await flusher.flushIfNeeded();
    offset += CHUNK;

    if (onProgress) {
      onProgress(Math.round(offset / file.size * 100));
    }

    // Yield to keep UI responsive
    await new Promise(r => setTimeout(r, 0));
  }

  // Handle last leftover line
  if (leftover.trim()) {
    const parts = leftover.split(/,|;|\s+/);
    for (const part of parts) {
      const val = Number(part.trim());
      if (!Number.isNaN(val)) flusher.push(val);
    }
  }

  await flusher.finalize();

  const sampleRate = 250;
  const meta = {
    totalChunks: flusher.chunkIndex,
    chunkSize: CHUNK_SIZE,
    sampleRate,
    totalValues: flusher.totalValues,
    durationInSeconds: flusher.totalValues / sampleRate,
    startTime: null,
  };
  await storeMeta(fileKey, meta);

  if (onProgress) onProgress(100);
  return meta;
}