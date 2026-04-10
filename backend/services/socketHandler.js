/**
 * Socket.IO Handler — Real-time WebSocket communication.
 *
 * ── Updated Architecture ────────────────────────────────────────────
 * BLE connection now happens in the browser (Web Bluetooth API).
 * The frontend sends ECG samples TO the backend via Socket.IO.
 * The backend stores them and broadcasts to any other connected clients.
 *
 * Events FROM frontend:
 *   'ecg:samples'     → raw ECG samples from BLE device
 *   'ecg:bleStatus'   → BLE connection status updates
 *
 * Events TO frontend:
 *   'ecg:data'        → ECG samples (broadcast to all clients)
 *   'ecg:status'      → Current recording/connection status
 *   'ecg:chunkSaved'  → Confirmation that a chunk was persisted
 * ────────────────────────────────────────────────────────────────────
 */

import dataPipeline from './dataPipeline.js';

// Shared state — accessible from API routes
let currentStudyId = null;
let isRecording = false;
let bleConnected = false;

export function getCurrentStudyId() { return currentStudyId; }
export function getIsRecording() { return isRecording; }
export function getBleConnected() { return bleConnected; }

export function setRecordingState(recording, studyId) {
  isRecording = recording;
  currentStudyId = studyId;
}

/**
 * Attach Socket.IO event handlers.
 * @param {import('socket.io').Server} io
 */
export default function setupSocket(io) {

  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Send current status so the UI initializes correctly
    socket.emit('ecg:status', {
      bleConnected,
      isRecording,
      studyId: currentStudyId,
    });

    // ── Receive ECG samples from the frontend (via Web Bluetooth) ──

    socket.on('ecg:samples', async (samples) => {
      // Broadcast to all OTHER clients (multi-window viewing)
      socket.broadcast.emit('ecg:data', samples);

      // If recording, push into the data pipeline
      if (isRecording && currentStudyId) {
        try {
          await dataPipeline.pushSamples(currentStudyId, samples);
        } catch (err) {
          // Session may have ended between packets — not critical
          console.warn('[Pipeline] Push failed:', err.message);
        }
      }
    });

    // ── BLE status updates from frontend ───────────────────────────

    socket.on('ecg:bleStatus', (status) => {
      bleConnected = status.connected;
      // Broadcast to other clients
      socket.broadcast.emit('ecg:status', {
        bleConnected,
        isRecording,
        studyId: currentStudyId,
      });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Client disconnected: ${socket.id} (${reason})`);
    });
  });
}
