/**
 * ECG Live Studio — Backend Server
 *
 * Wires together:
 *   - Express (REST API)
 *   - Socket.IO (real-time WebSocket)
 *   - BLE Service (Bluetooth device communication)
 *   - Data Pipeline (chunked storage)
 *
 * ── How to run ──────────────────────────────────────────────────────
 *   cd backend
 *   npm install
 *   npm run dev      ← development (auto-restart on changes)
 *   npm start        ← production
 *
 * ── Environment variables (optional) ────────────────────────────────
 *   PORT=3001        ← server port (default 3001)
 * ────────────────────────────────────────────────────────────────────
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';

import apiRouter from './routes/api.js';
import setupSocket from './services/socketHandler.js';

const PORT = process.env.PORT || 3001;

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: true, maxAge: 86400 })); // Allow all origins; cache preflight 24h to stop per-request OPTIONS
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Mount API routes
app.use('/api', apiRouter);

// ─── HTTP + Socket.IO Server ────────────────────────────────────────

const httpServer = createServer(app);

const io = new SocketIO(httpServer, {
  cors: {
    origin: '*',                           // Tighten in production
    methods: ['GET', 'POST'],
  },
});

// Attach WebSocket handlers
setupSocket(io);

// ─── Crash protection ───────────────────────────────────────────────
// Node 15+ exits on unhandledRejection by default — log and survive instead.

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (kept alive):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (kept alive):', err);
});

// ─── Start ──────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║   ECG Live Studio — Backend                   ║
  ║   REST API  → http://localhost:${PORT}/api      ║
  ║   WebSocket → ws://localhost:${PORT}            ║
  ╚═══════════════════════════════════════════════╝
  `);
});
