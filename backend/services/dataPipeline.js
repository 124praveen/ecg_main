/**
 * Data Pipeline — Buffers real-time ECG samples, slices into chunks,
 *                 and persists to the file system.
 *
 * ── How it works ────────────────────────────────────────────────────
 *
 *   BLE packets arrive at irregular intervals (BLE is bursty).
 *   Each packet might contain 5-20 samples depending on the device.
 *
 *   We need to:
 *     1. Buffer incoming samples in memory
 *     2. When the buffer reaches CHUNK_SIZE → flush to disk as a .bin file
 *     3. Keep a running metadata file (meta.json) up-to-date
 *
 *   File layout on disk:
 *
 *     /data/studies/{studyId}/
 *       ├── meta.json          ← study metadata
 *       ├── chunk_000000.bin   ← Float64Array (7500 samples = 30s @ 250Hz)
 *       ├── chunk_000001.bin
 *       └── ...
 *
 *   We use Float64Array (same as your frontend IndexedDB chunks)
 *   so the data format is identical across the entire system.
 *
 * ── Common mistakes ────────────────────────────────────────────────
 *   - Holding all samples in memory → OOM on multi-day recordings
 *     Fix: flush to disk at CHUNK_SIZE intervals
 *   - Writing one file per sample → millions of tiny files
 *     Fix: batch into chunks (30 seconds each)
 *   - Not syncing metadata after each chunk
 *     Fix: update meta.json on every flush
 * ────────────────────────────────────────────────────────────────────
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Configuration ──────────────────────────────────────────────────

const CHUNK_SIZE = 7500;           // Samples per chunk (30s @ 250Hz)
const DEFAULT_SAMPLE_RATE = 250;   // Hz
const DATA_DIR = path.resolve('data', 'studies');

// Ensure data directory exists at startup
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Data Pipeline Class ────────────────────────────────────────────

class DataPipeline {
  constructor() {
    /** @type {Map<string, StudySession>} */
    this.activeSessions = new Map();
  }

  /**
   * Start a new recording session.
   *
   * @param {object} opts
   * @param {number} [opts.sampleRate=250]
   * @param {string} [opts.deviceMac]
   * @param {string} [opts.deviceSerial]
   * @param {string} [opts.patientName]
   * @returns {{ studyId: string, studyDir: string }}
   */
  startSession({
    sampleRate = DEFAULT_SAMPLE_RATE,
    deviceMac = '',
    deviceSerial = '',
    patientName = '',
  } = {}) {
    const studyId = uuidv4();
    const studyDir = path.join(DATA_DIR, studyId);
    mkdirSync(studyDir, { recursive: true });

    const session = new StudySession({
      studyId,
      studyDir,
      sampleRate,
      deviceMac,
      deviceSerial,
      patientName,
    });

    this.activeSessions.set(studyId, session);
    return { studyId, studyDir };
  }

  /**
   * Push samples from BLE into the pipeline.
   * Call this from bleService.startStreaming callback.
   *
   * @param {string} studyId
   * @param {number[]} samples
   */
  async pushSamples(studyId, samples) {
    const session = this.activeSessions.get(studyId);
    if (!session) throw new Error(`No active session: ${studyId}`);
    await session.push(samples);
  }

  /**
   * Stop recording and finalize all pending data.
   * @param {string} studyId
   * @returns {object} final metadata
   */
  async stopSession(studyId) {
    const session = this.activeSessions.get(studyId);
    if (!session) throw new Error(`No active session: ${studyId}`);

    const meta = await session.finalize();
    this.activeSessions.delete(studyId);
    return meta;
  }

  /**
   * Read metadata for a study (active or completed).
   * @param {string} studyId
   */
  async getMeta(studyId) {
    const session = this.activeSessions.get(studyId);
    if (session) return session.meta;

    // Read from disk for completed studies
    const metaPath = path.join(DATA_DIR, studyId, 'meta.json');
    const raw = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(raw);
  }

  /**
   * Read a range of chunks from disk.
   * Returns a flat Float64Array of all requested samples.
   *
   * @param {string} studyId
   * @param {number} startChunk — inclusive
   * @param {number} endChunk   — exclusive
   * @returns {Float64Array}
   */
  async getChunks(studyId, startChunk, endChunk) {
    const studyDir = path.join(DATA_DIR, studyId);
    const arrays = [];

    for (let i = startChunk; i < endChunk; i++) {
      const chunkPath = path.join(
        studyDir,
        `chunk_${String(i).padStart(6, '0')}.bin`
      );
      try {
        const buf = await fs.readFile(chunkPath);
        arrays.push(new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8));
      } catch {
        // Chunk doesn't exist yet (live recording still in progress)
        break;
      }
    }

    // Merge into single array
    const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
    const merged = new Float64Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      merged.set(arr, offset);
      offset += arr.length;
    }
    return merged;
  }

  /**
   * Get samples by time range (seconds from recording start).
   *
   * @param {string} studyId
   * @param {number} startSec
   * @param {number} endSec
   * @returns {Float64Array}
   */
  async getSliceByTime(studyId, startSec, endSec) {
    const meta = await this.getMeta(studyId);
    const startSample = Math.floor(startSec * meta.sampleRate);
    const endSample = Math.ceil(endSec * meta.sampleRate);

    const startChunk = Math.floor(startSample / CHUNK_SIZE);
    const endChunk = Math.ceil(endSample / CHUNK_SIZE);

    const allData = await this.getChunks(studyId, startChunk, endChunk);

    // Trim to exact range
    const chunkOffset = startChunk * CHUNK_SIZE;
    const sliceStart = startSample - chunkOffset;
    const sliceEnd = sliceStart + (endSample - startSample);

    return allData.slice(sliceStart, Math.min(sliceEnd, allData.length));
  }

  /** List all studies on disk. */
  async listStudies() {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const studies = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const metaPath = path.join(DATA_DIR, entry.name, 'meta.json');
        const raw = await fs.readFile(metaPath, 'utf-8');
        studies.push(JSON.parse(raw));
      } catch {
        // Ignore directories without meta
      }
    }
    return studies;
  }
}

// ─── Study Session (internal) ───────────────────────────────────────

class StudySession {
  constructor({ studyId, studyDir, sampleRate, deviceMac, deviceSerial, patientName }) {
    this.studyDir = studyDir;

    /** In-memory buffer for samples not yet flushed to disk. */
    this.buffer = [];

    /** How many chunks have been written so far. */
    this.chunkCount = 0;

    /** Total samples received (including buffered). */
    this.totalSamples = 0;

    /** Is a flush currently in progress? Prevents concurrent writes. */
    this.flushing = false;

    /** Metadata — kept in sync with disk. */
    this.meta = {
      studyId,
      sampleRate,
      chunkSize: CHUNK_SIZE,
      totalChunks: 0,
      totalSamples: 0,
      durationSeconds: 0,
      startTime: new Date().toISOString(),
      endTime: null,
      status: 'recording',
      deviceMac,
      deviceSerial,
      patientName,
    };

    // Write initial meta
    this._writeMeta();
  }

  /**
   * Push new samples into the buffer.
   * Flushes to disk whenever buffer >= CHUNK_SIZE.
   */
  async push(samples) {
    this.buffer.push(...samples);
    this.totalSamples += samples.length;

    // Flush complete chunks
    while (this.buffer.length >= CHUNK_SIZE) {
      const chunk = this.buffer.splice(0, CHUNK_SIZE);
      await this._flushChunk(chunk);
    }
  }

  /**
   * Finalize: flush remaining buffer (partial chunk), update meta.
   */
  async finalize() {
    // Flush remaining samples as a partial chunk
    if (this.buffer.length > 0) {
      await this._flushChunk(this.buffer.splice(0));
    }

    this.meta.endTime = new Date().toISOString();
    this.meta.status = 'completed';
    this.meta.totalSamples = this.totalSamples;
    this.meta.totalChunks = this.chunkCount;
    this.meta.durationSeconds = this.totalSamples / this.meta.sampleRate;

    await this._writeMeta();
    return this.meta;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  async _flushChunk(samples) {
    const chunkName = `chunk_${String(this.chunkCount).padStart(6, '0')}.bin`;
    const chunkPath = path.join(this.studyDir, chunkName);

    // Convert to Float64Array and write raw bytes
    const f64 = new Float64Array(samples);
    await fs.writeFile(chunkPath, Buffer.from(f64.buffer));

    this.chunkCount++;

    // Update running metadata
    this.meta.totalChunks = this.chunkCount;
    this.meta.totalSamples = this.totalSamples;
    this.meta.durationSeconds = this.totalSamples / this.meta.sampleRate;

    await this._writeMeta();
  }

  async _writeMeta() {
    const metaPath = path.join(this.studyDir, 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify(this.meta, null, 2));
  }
}

export default new DataPipeline();
export { CHUNK_SIZE, DATA_DIR };
