/**
 * REST API Client — Helper functions for backend HTTP endpoints.
 *
 * All functions return parsed JSON (or throw on error).
 * Binary endpoints (like /slice) return ArrayBuffer.
 */

const BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

async function request(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res;
}

// ─── BLE ────────────────────────────────────────────────────────────

export async function scanDevices() {
  const res = await request('/api/scan', { method: 'POST' });
  return res.json();
}

export async function connectDevice(mac, serial) {
  const res = await request('/api/connect', {
    method: 'POST',
    body: JSON.stringify({ mac, serial }),
  });
  return res.json();
}

export async function disconnectDevice() {
  const res = await request('/api/disconnect', { method: 'POST' });
  return res.json();
}

// ─── Recording ──────────────────────────────────────────────────────

export async function startRecording(opts = {}) {
  const res = await request('/api/record/start', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  return res.json();
}

export async function stopRecording() {
  const res = await request('/api/record/stop', { method: 'POST' });
  return res.json();
}

// ─── Status ─────────────────────────────────────────────────────────

export async function getStatus() {
  const res = await request('/api/status');
  return res.json();
}

// ─── Studies ────────────────────────────────────────────────────────

export async function listStudies() {
  const res = await request('/api/studies');
  return res.json();
}

export async function getStudyMeta(studyId) {
  const res = await request(`/api/studies/${studyId}/meta`);
  return res.json();
}

/**
 * Fetch ECG samples for a time range.
 * Returns Float64Array for direct use with canvas rendering.
 */
export async function getSlice(studyId, startSec, endSec) {
  const res = await fetch(
    `${BASE}/api/studies/${studyId}/slice?start=${startSec}&end=${endSec}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Float64Array(buf);
}

/**
 * Decode raw BSE hex block using the backend JAR decompiler.
 * Retries up to 3 times with 2 s delay to survive brief backend restarts.
 * @param {string} hex - hex string e.g. "88 82 43 11 ..."
 * @returns {Promise<number[]>} decoded ECG integer samples
 */
export async function decodeBseBlock(hex, blockIndex = 0) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await request('/api/decode/bse', {
        method: 'POST',
        body: JSON.stringify({ hex, blockIndex }),
      });
      // Ignore preflight / no-content responses — only process POST 200 with body
      if (res.status === 204 || res.status === 0) return [];
      const data = await res.json();
      return Array.isArray(data.samples) ? data.samples : [];
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[API] decodeBseBlock attempt ${attempt} failed: ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

/**
 * Get EDF download URL for a study.
 */
export function getEdfUrl(studyId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.patientName) params.set('patientName', opts.patientName);
  if (opts.physicalMin != null) params.set('physicalMin', opts.physicalMin);
  if (opts.physicalMax != null) params.set('physicalMax', opts.physicalMax);
  return `${BASE}/api/studies/${studyId}/edf?${params}`;
}
