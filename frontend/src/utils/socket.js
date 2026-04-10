/**
 * Socket.IO Client — Singleton connection to the backend WebSocket.
 *
 * Usage in any React component:
 *   import socket from '../utils/socket';
 *   socket.on('ecg:data', (samples) => { ... });
 *
 * The socket auto-connects when imported and auto-reconnects on failure.
 */

import { io } from 'socket.io-client';

// In development, Vite proxy forwards /socket.io to backend.
// In production, adjust this to your backend URL.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const socket = io(BACKEND_URL, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
});

socket.on('disconnect', (reason) => {
  console.log('[Socket] Disconnected:', reason);
});

socket.on('connect_error', (err) => {
  console.warn('[Socket] Connection error:', err.message);
});

export default socket;
