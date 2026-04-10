/**
 * REST API Routes — Express router for all HTTP endpoints.
 *
 * ── Updated Architecture ────────────────────────────────────────────
 * BLE is handled by the frontend (Web Bluetooth API).
 * The backend focuses on: recording management, data storage, and EDF export.
 *
 * Endpoints:
 *   POST /api/record/start     → Start recording (creates new study)
 *   POST /api/record/stop      → Stop recording (finalizes study)
 *   GET  /api/status            → Current recording status
 *   GET  /api/studies           → List all studies
 *   GET  /api/studies/:id/meta  → Get study metadata
 *   GET  /api/studies/:id/slice → Get ECG samples by time range
 *   GET  /api/studies/:id/edf   → Generate & download EDF file
 * ────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import dataPipeline from '../services/dataPipeline.js';
import exportToEdf from '../services/edfExport.js';
import { decodeBse } from '../services/bseDecoder.js';
import {
  getCurrentStudyId,
  getIsRecording,
  getBleConnected,
  setRecordingState,
} from '../services/socketHandler.js';

const router = Router();

// ─── Recording Endpoints ────────────────────────────────────────────

/**
 * POST /api/record/start
 * Body: { sampleRate?: number, patientName?: string, deviceMac?: string, deviceSerial?: string }
 * Creates a new study session. The frontend will start sending
 * ECG samples via Socket.IO once BLE streaming begins.
 */
router.post('/record/start', async (req, res) => {
  if (getIsRecording()) {
    return res
      .status(400)
      .json({ error: 'Already recording', studyId: getCurrentStudyId() });
  }

  try {
    const { sampleRate, patientName, deviceMac, deviceSerial } =
      req.body || {};

    const { studyId } = dataPipeline.startSession({
      sampleRate: sampleRate || 250,
      deviceMac: deviceMac || '',
      deviceSerial: deviceSerial || '',
      patientName: patientName || '',
    });

    setRecordingState(true, studyId);
    res.json({ success: true, studyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/record/stop
 * Stops the current recording and finalizes the study.
 * Returns the final metadata including duration and sample count.
 */
router.post('/record/stop', async (_req, res) => {
  if (!getIsRecording()) {
    return res.status(400).json({ error: 'Not recording' });
  }

  try {
    const studyId = getCurrentStudyId();
    const meta = await dataPipeline.stopSession(studyId);
    setRecordingState(false, null);
    res.json({ success: true, meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Status ─────────────────────────────────────────────────────────

/**
 * GET /api/status
 * Returns current connection and recording state.
 */
router.get('/status', (_req, res) => {
  res.json({
    bleConnected: getBleConnected(),
    recording: getIsRecording(),
    studyId: getCurrentStudyId(),
  });
});

// ─── Study Data Endpoints ───────────────────────────────────────────

/**
 * GET /api/studies
 * List all studies with their metadata.
 */
router.get('/studies', async (_req, res) => {
  try {
    const studies = await dataPipeline.listStudies();
    res.json({ studies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/studies/:id/meta
 * Get metadata for a specific study.
 */
router.get('/studies/:id/meta', async (req, res) => {
  try {
    const meta = await dataPipeline.getMeta(req.params.id);
    res.json(meta);
  } catch (err) {
    res.status(404).json({ error: 'Study not found' });
  }
});

/**
 * GET /api/studies/:id/slice?start=0&end=10
 * Get ECG samples for a time range (in seconds).
 * Returns raw Float64 binary for efficiency (same format as frontend IndexedDB).
 */
router.get('/studies/:id/slice', async (req, res) => {
  try {
    const start = parseFloat(req.query.start) || 0;
    const end = parseFloat(req.query.end) || start + 10;

    const samples = await dataPipeline.getSliceByTime(
      req.params.id,
      start,
      end
    );

    // Send as binary for maximum efficiency
    const buf = Buffer.from(samples.buffer);
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Sample-Count', String(samples.length));
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/studies/:id/edf?patientName=John&physicalMin=-5&physicalMax=5
 * Generate and download EDF file for a study.
 */
router.get('/studies/:id/edf', async (req, res) => {
  try {
    const opts = {
      patientName: req.query.patientName,
      physicalMin: req.query.physicalMin
        ? parseFloat(req.query.physicalMin)
        : undefined,
      physicalMax: req.query.physicalMax
        ? parseFloat(req.query.physicalMax)
        : undefined,
    };

    const edfPath = await exportToEdf(req.params.id, opts);

    res.download(edfPath, 'recording.edf', (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/decode/bse
 * Body: { hex: "88 82 43 11 ..." }
 * Runs bsedecoder-2.0.0.jar and returns decoded ECG integer samples.
 */
router.post('/decode/bse', async (req, res) => {
  try {
    const { hex, blockIndex } = req.body;
    if (!hex || typeof hex !== 'string') {
      return res.status(400).json({ error: 'hex string required in body' });
    }
    const idx = typeof blockIndex === 'number' ? blockIndex : 0;
    const samples = await decodeBse(hex, idx);
    res.json({ samples });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
