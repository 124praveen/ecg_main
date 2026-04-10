/**
 * Web Bluetooth API — ECG device communication.
 *
 * ── Protocol ────────────────────────────────────────────────────────
 *   Packet format: [0x10][0x01][LEN_L][LEN_H][0x07][0x2A][0x4F][payload...][CRC32 4B]
 *   LEN = total packet size (including all 4 CRC bytes)
 *   CRC32 = standard ISO-HDLC CRC32 over bytes[0..n-4]
 *
 * ── Init sequence ───────────────────────────────────────────────────
 *   connect() → 2s stabilize → STOP → DELETE → SET_MODE → SET_PARAMS → START
 *   Device fires async event 0xA8/0x05 (RecStarted) then 0xA8/0x20 (MCT block ready)
 *   On 0x20: FILE_INFO → DATA_REQUEST → parse ECG → display
 *
 * ── Browser support ─────────────────────────────────────────────────
 *   Chrome 56+, Edge 79+. Must be HTTPS or localhost.
 * ────────────────────────────────────────────────────────────────────
 */

// ─── CRC32 (ISO-HDLC / IEEE 802.3, reflected polynomial 0xEDB88320) ──

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a full MCT command packet (type 0x4F) from a payload byte array. */
function buildPacket(payloadBytes) {
  const totalLen = 11 + payloadBytes.length; // 4 outer + 3 proto + payload + 4 CRC
  const header = [0x10, 0x01, totalLen & 0xFF, (totalLen >> 8) & 0xFF, 0x07, 0x2A, 0x4F];
  const prelude = [...header, ...payloadBytes];
  const crc = crc32(prelude);
  return new Uint8Array([
    ...prelude,
    crc & 0xFF, (crc >> 8) & 0xFF, (crc >> 16) & 0xFF, (crc >> 24) & 0xFF,
  ]);
}

// ─── Configuration ──────────────────────────────────────────────────

const BLE_CONFIG = {
  DEVICE_INFO_SERVICE: 0x180a,
  SERIAL_NUMBER_CHAR:  0x2a25,

  ECG_SERVICE:    '7b1b0001-2f3a-bb6f-7b9e-2d8308a752ec',
  ECG_WRITE_CHAR: '7b1b0002-2f3a-bb6f-7b9e-2d8308a752ec',
  ECG_DATA_CHAR:  '7b1b0003-2f3a-bb6f-7b9e-2d8308a752ec',

  // ── Verified hardcoded packets (correct CRC confirmed) ───────────
  //    If other commands fail, these are the reference to calibrate CRC algo.
  START_COMMAND:     [0x10,0x01,0x0D,0x00,0x07,0x2A,0x4F,0xC9,0x05,0xBD,0xF1,0x5A,0x7C],
  STOP_COMMAND:      [0x10,0x01,0x0D,0x00,0x07,0x2A,0x4F,0x1A,0x5C,0x51,0x99,0xDE,0xA0],
  FILE_INFO_COMMAND: [0x10,0x01,0x0D,0x00,0x07,0x2A,0x4F,0x1A,0x56,0x87,0x4F,0x54,0x8F],

  // ── Command payload bytes (passed through buildPacket at runtime) ─
  CMD_DELETE_HOLTER:        [0xCC, 0x01],
  CMD_SET_MODE_MCT:         [0xAF, 0x02],
  CMD_SET_MODE_HOLTER:      [0xAF, 0x01],
  CMD_GET_RECORDING_STATE:  [0x1A, 0x50],
  CMD_GET_HOLTER_INFO:      [0xCB, 0x01],
  // SET_PARAMS is built dynamically via _buildSetParams()
};

const OPTIONAL_SERVICES = [
  BLE_CONFIG.ECG_SERVICE,
  BLE_CONFIG.DEVICE_INFO_SERVICE,
  0x1800,
  0x1801,
  0x180d,
  0x180f,
];

// Async event sub-types (byte[8] when byte[7]=0xA8)
const EVT = {
  END_RECORDING: 0x02,
  REC_STARTED:   0x05,
  MCT_BLOCK:     0x20,
};

class BleConnection {
  constructor() {
    this.device   = null;
    this.server   = null;
    this.ecgChar  = null;
    this.writeChar = null;
    this.connected = false;
    this.streaming = false;
    this.serialNumber = null;

    this.onData         = null; // (samples: number[]) => void
    this.onStatusChange = null; // (status: string) => void
    this.onEvent        = null; // (eventType: number) => void  — fired for 0xA8 async events

    this._boundHandleNotification = this._handleNotification.bind(this);
    this._boundOnDisconnected     = this._onDisconnected.bind(this);

    this._reconnectAttempt    = 0;
    this._reconnecting        = false;
    this._intentionalDisconnect = false;
    this._suspended           = false; // when true, notification samples are dropped (during file ops)
    this._studyStartTime      = 0;     // timestamp of last startStudy() call — used to discard stale events
  }

  static isSupported() {
    return !!navigator.bluetooth;
  }

  // ── Connect ───────────────────────────────────────────────────────

  async connect(expectedSerial) {
    if (!BleConnection.isSupported()) {
      throw new Error('Web Bluetooth is not supported. Use Chrome or Edge.');
    }

    this._setStatus('Requesting device...');

    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OPTIONAL_SERVICES,
      });
    } catch (err) {
      if (err.name === 'NotFoundError') {
        this._setStatus('Cancelled — no device selected');
        return false;
      }
      this._setStatus(`BLE error: ${err.message}`);
      throw err;
    }

    this.device.addEventListener('gattserverdisconnected', this._boundOnDisconnected);
    this._setStatus(`Connecting to ${this.device.name || 'device'}...`);

    this.server = await this.device.gatt.connect();

    // 2-second stabilization — device firmware needs time after GATT connect
    this._setStatus('Stabilizing connection...');
    await new Promise(r => setTimeout(r, 2000));

    // Read serial number (optional)
    try {
      const infoService = await this.server.getPrimaryService(BLE_CONFIG.DEVICE_INFO_SERVICE);
      const serialChar  = await infoService.getCharacteristic(BLE_CONFIG.SERIAL_NUMBER_CHAR);
      const value       = await serialChar.readValue();
      this.serialNumber = new TextDecoder().decode(value).trim();

      if (expectedSerial && this.serialNumber !== expectedSerial) {
        await this.disconnect();
        throw new Error(`Serial mismatch: expected "${expectedSerial}", got "${this.serialNumber}"`);
      }
    } catch (err) {
      if (err.message?.includes('mismatch')) throw err;
      console.warn('[BLE] Could not read serial number:', err.message);
    }

    await this._discoverCharacteristics();
    this.connected = true;

    const parts = [`Connected: ${this.device.name || this.device.id}`];
    if (this.serialNumber) parts.push(`S/N: ${this.serialNumber}`);
    parts.push(this.ecgChar && this.writeChar ? 'Ready to start' : 'Paired — swipe to start');
    this._setStatus(parts.join(' — '));

    return true;
  }

  // ── Discover characteristics ──────────────────────────────────────

  async _discoverCharacteristics() {
    if (!this.server) return;
    try {
      const svc = await this.server.getPrimaryService(BLE_CONFIG.ECG_SERVICE);
      try {
        this.writeChar = await svc.getCharacteristic(BLE_CONFIG.ECG_WRITE_CHAR);
        console.log('[BLE] Write char ready:', this.writeChar.uuid);
      } catch (e) {
        console.error('[BLE] Write char not found:', e.message);
      }
      try {
        this.ecgChar = await svc.getCharacteristic(BLE_CONFIG.ECG_DATA_CHAR);
        console.log('[BLE] Notify char ready:', this.ecgChar.uuid);
      } catch (e) {
        console.error('[BLE] Notify char not found:', e.message);
      }
    } catch (err) {
      console.error('[BLE] ECG service not found:', err.message);
    }
  }

  // ── Start / Stop study ────────────────────────────────────────────

  /**
   * Run the full init sequence: STOP → DELETE → SET_MODE → SET_PARAMS → START
   * Then subscribe to notifications.
   * @param {function} onData  - called with each batch of ECG samples
   * @param {object}   config  - { studyType: 'MCT'|'Holter', duration: minutes, sampleRate: 250 }
   */
  async startStudy(onData, config = {}) {
    if (!this.connected) throw new Error('Not connected — call connect() first');

    if (!this.ecgChar || !this.writeChar) {
      this._setStatus('Discovering services...');
      await this._discoverCharacteristics();
    }

    this.onData = onData;
    const studyType  = config.studyType  || 'MCT';
    const durationMs = (config.duration  || 5) * 60; // minutes → seconds
    const sampleRate = config.sampleRate || 250;

    this._setStatus('Initialising device...');

    // 1. STOP any in-progress recording
    await this._writeCommand(BLE_CONFIG.STOP_COMMAND, 'STOP');
    await new Promise(r => setTimeout(r, 200));

    // 2. DELETE previous Holter file
    await this._writeCommand(buildPacket(BLE_CONFIG.CMD_DELETE_HOLTER), 'DELETE');
    await new Promise(r => setTimeout(r, 200));

    // 3. SET MODE
    const modePayload = studyType === 'Holter'
      ? BLE_CONFIG.CMD_SET_MODE_HOLTER
      : BLE_CONFIG.CMD_SET_MODE_MCT;
    await this._writeCommand(buildPacket(modePayload), 'SET_MODE');
    await new Promise(r => setTimeout(r, 200));

    // 4. SET PARAMS
    const paramsCmd = this._buildSetParams(sampleRate, durationMs);
    await this._writeCommand(paramsCmd, 'SET_PARAMS');
    await new Promise(r => setTimeout(r, 200));

    // 5. Subscribe to notifications first, then START
    if (this.ecgChar) {
      try {
        this.ecgChar.removeEventListener('characteristicvaluechanged', this._boundHandleNotification);
        await this.ecgChar.stopNotifications();
      } catch { /* not active */ }
      this.ecgChar.addEventListener('characteristicvaluechanged', this._boundHandleNotification);
      await this.ecgChar.startNotifications();
    }

    // 6. START recording
    await this._writeCommand(BLE_CONFIG.START_COMMAND, 'START');
    this.streaming = true;
    this._suspended = false;
    this._studyStartTime = Date.now(); // mark start time — ignore stale events before this
    this._setStatus('Recording started — waiting for data...');
  }

  /** Build SET_PARAMS command packet dynamically. */
  _buildSetParams(sampleRate = 250, durationSeconds = 300) {
    const sr_L = sampleRate & 0xFF;
    const sr_H = (sampleRate >> 8) & 0xFF;
    const dur0 = durationSeconds & 0xFF;
    const dur1 = (durationSeconds >> 8) & 0xFF;
    const dur2 = (durationSeconds >> 16) & 0xFF;
    const dur3 = (durationSeconds >> 24) & 0xFF;
    const payload = [
      0xCA,                    // SET_PARAMS command byte
      sr_L, sr_H,              // sample rate (Hz, LE)
      0x01,                    // cable: 1 = single lead
      0x01, 0x01, 0x01, 0x01, // filter flags ×4
      dur0, dur1, dur2, dur3, // duration in seconds (LE uint32)
      0x01,                    // EBC (ECG baseline correction)
    ];
    return buildPacket(payload);
  }

  async stopStudy() {
    if (this.writeChar && this.connected) {
      await this._writeCommand(BLE_CONFIG.STOP_COMMAND, 'STOP');
    }
    if (this.ecgChar) {
      try {
        await this.ecgChar.stopNotifications();
        this.ecgChar.removeEventListener('characteristicvaluechanged', this._boundHandleNotification);
      } catch { /* may already be disconnected */ }
    }
    this.streaming = false;
    this.onData    = null;
    this._suspended = false;
    this._setStatus('Study stopped — device connected');
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    this._reconnecting = false;
    if (this.streaming) await this.stopStudy();
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.connected     = false;
    this.streaming     = false;
    this.device        = null;
    this.server        = null;
    this.ecgChar       = null;
    this.writeChar     = null;
    this.serialNumber  = null;
    this._suspended    = false;
    this._setStatus('Disconnected');
  }

  // ── Notification suspension (used during file fetch to avoid noise) ──

  pauseNotifications() {
    this._suspended = true;
  }

  resumeNotifications() {
    this._suspended = false;
  }

  // ── Pull protocol (FILE_INFO + DATA_REQUEST) ──────────────────────

  /**
   * Request the latest file metadata. Returns 55-byte response as Uint8Array.
   * Last 4 bytes are the session token for subsequent data requests.
   */
  async getFileInfo() {
    if (!this.ecgChar || !this.writeChar) throw new Error('Not connected');
    const saved = this.onData;
    this.onData = null;
    try {
      const info = await this._sendAndCollect(BLE_CONFIG.FILE_INFO_COMMAND, 'FILE_INFO', 55, 5000, 0x79);
      const hex = Array.from(info).map(b => b.toString(16).padStart(2,'0')).join(' ');
      console.log('[BLE] FILE_INFO full response:', hex);
      const data = info.slice(7);
      console.log('[BLE] FILE_INFO data (no header):', Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' '));
      console.log('[BLE] FILE_INFO last-4:', Array.from(info.slice(-4)).map(b => b.toString(16).padStart(2,'0')).join(' '));
      return info;
    } finally {
      this.onData = saved;
    }
  }

  /**
   * Request a raw ECG data block. Returns the full response as Uint8Array.
   * @param {number}   offset - block byte offset (0x10 = first block)
   * @param {number[]} token  - 4-byte session token from getFileInfo() last 4 bytes
   */
  async fetchRawBlock(offset = 0x10, token = [0x9C, 0x5B, 0xE7, 0xDA]) {
    if (!this.ecgChar || !this.writeChar) throw new Error('Not connected');
    const saved = this.onData;
    this.onData = null;
    try {
      const cmd = this._buildDataRequest(offset, token);
      return await this._sendAndCollect(cmd, 'FETCH_BLOCK', 0, 15000, null, /*skipEcg=*/true);
    } finally {
      this.onData = saved;
    }
  }

  /**
   * Build a 52-byte DATA_REQUEST command (type 0x76, no CRC).
   * FETCH_BLOCK uses raw protocol — must NOT go through buildPacket().
   */
  _buildDataRequest(offset = 0x10, token = [0x9C, 0x5B, 0xE7, 0xDA]) {
    return new Uint8Array([
      0x10, 0x01, 0x34, 0x00, 0x07, 0x2A, 0x76,       // header (LEN=52, type=0x76, no CRC)
      0xC6,                                             // sub-command: read block
      0x6D, 0x63, 0x74, 0x62, 0x6C, 0x6F, 0x63, 0x6B, // "mctblock"
      ...Array(29).fill(0x00),                          // null padding
      offset & 0xFF, (offset >> 8) & 0xFF, (offset >> 16) & 0xFF, // 3-byte LE offset
      ...token,                                         // 4-byte token from FILE_INFO last-4
    ]);
  }

  /**
   * Send a command then accumulate notification packets until totalBytes received.
   *
   * @param {number|null} responseTypeByte - byte[6] to match (null = accept all)
   * @param {boolean}     skipEcg          - if true, skip live ECG packets (byte[6]=0x4F, 13 bytes)
   *                                         used by FETCH_BLOCK to ignore ambient streaming noise
   */
  _sendAndCollect(cmdBytes, label, expectedBytes = 0, timeoutMs = 10000, responseTypeByte = null, skipEcg = false) {
    return new Promise((resolve, reject) => {
      const chunks  = [];
      let received  = 0;
      let total     = expectedBytes;

      const onPacket = (event) => {
        const dv = event.target.value;

        // Always log every incoming packet header for diagnostics
        if (dv.byteLength >= 7) {
          const hdr = Array.from({length: Math.min(dv.byteLength, 9)}, (_, i) => dv.getUint8(i).toString(16).padStart(2,'0')).join(' ');
          console.log(`[BLE] ${label} pkt(${dv.byteLength}B): ${hdr}`);
        }

        // Always skip live ECG noise (byte[6]=0x4F, 13B) — these arrive at any time.
        // EXCEPTION: byte[7]=0xB3 means NACK — must NOT be silently dropped even if it
        // looks like an ECG packet, otherwise FETCH_BLOCK times out for 15s instead of
        // failing immediately with a useful error.
        if (skipEcg && dv.byteLength === 13 && dv.getUint8(6) === 0x4F && dv.getUint8(7) !== 0xB3) return;

        if (received === 0) {
          // No data collected yet — safe to apply protocol-level filters
          // Detect NACK: byte[7]=0xB3, byte[8]!=0x11
          if (dv.byteLength >= 9 && dv.getUint8(7) === 0xB3 && dv.getUint8(8) !== 0x11) {
            const code = dv.getUint8(8).toString(16).padStart(2,'0');
            cleanup();
            reject(new Error(`[BLE] ${label} rejected by device — NACK code 0x${code}`));
            return;
          }
          // Skip ACK SUCCESS and async event packets
          if (dv.byteLength >= 8) {
            const b7 = dv.getUint8(7);
            if (b7 === 0xA8 || (b7 === 0xB3 && dv.getUint8(8) === 0x11)) return;
          }
          // Filter by expected type byte (e.g. 0x79 for FILE_INFO)
          if (responseTypeByte !== null && dv.byteLength >= 7) {
            if (dv.getUint8(6) !== responseTypeByte) return;
          }
        }
        // Once received > 0: every packet is a data continuation — accept all
        // (NACK/ACK/event bytes can appear in raw ECG data by coincidence)

        for (let i = 0; i < dv.byteLength; i++) chunks.push(dv.getUint8(i));
        received += dv.byteLength;

        if (total === 0 && chunks.length >= 4) {
          total = chunks[2] | (chunks[3] << 8);
          console.log(`[BLE] ${label}: expecting ${total} bytes total (from header)`);
        }
        console.log(`[BLE] ${label}: ${received}/${total || '?'} bytes collected`);

        if (total > 0 && received >= total) {
          cleanup();
          resolve(new Uint8Array(chunks.slice(0, total)));
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        // Log what we have so far to help diagnose
        if (chunks.length > 0) {
          const preview = chunks.slice(0, Math.min(chunks.length, 16))
            .map(b => b.toString(16).padStart(2,'0')).join(' ');
          console.warn(`[BLE] ${label} partial (${chunks.length}B): ${preview}`);
        }
        reject(new Error(`[BLE] ${label} timeout after ${timeoutMs}ms (got ${received}/${total} bytes)`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.ecgChar.removeEventListener('characteristicvaluechanged', onPacket);
      };

      this.ecgChar.addEventListener('characteristicvaluechanged', onPacket);
      this._writeCommand(cmdBytes, label).catch(err => { cleanup(); reject(err); });
    });
  }

  // ── Write helper with MTU chunking ───────────────────────────────

  /**
   * Write a command to the write characteristic.
   * Commands > 20 bytes are split into 20-byte chunks with 30ms inter-chunk delay.
   */
  async _writeCommand(cmdBytes, label) {
    const cmd = cmdBytes instanceof Uint8Array ? cmdBytes : new Uint8Array(cmdBytes);
    const hex = Array.from(cmd).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[BLE] → ${label}: ${hex}`);

    const ch      = this.writeChar;
    const MTU     = 20;
    const DELAY   = 30; // ms between chunks

    if (cmd.length <= MTU) {
      // Single-chunk write
      try {
        await ch.writeValueWithoutResponse(cmd);
      } catch {
        await ch.writeValueWithResponse(cmd);
      }
      return true;
    }

    // Multi-chunk write
    for (let offset = 0; offset < cmd.length; offset += MTU) {
      const chunk = cmd.slice(offset, offset + MTU);
      try {
        await ch.writeValueWithoutResponse(chunk);
      } catch {
        await ch.writeValueWithResponse(chunk);
      }
      if (offset + MTU < cmd.length) {
        await new Promise(r => setTimeout(r, DELAY));
      }
    }
    return true;
  }

  // ── Notification handler ─────────────────────────────────────────

  _handleNotification(event) {
    const dv = event.target.value;
    if (dv.byteLength < 8) return;

    const typeByte  = dv.getUint8(6);
    const byte7     = dv.getUint8(7);

    // Async device event (byte[7] = 0xA8)
    if (byte7 === 0xA8 && dv.byteLength >= 9) {
      const evtType = dv.getUint8(8);
      const name = evtType === EVT.MCT_BLOCK     ? 'MCT_BLOCK_READY'
                 : evtType === EVT.REC_STARTED   ? 'REC_STARTED'
                 : evtType === EVT.END_RECORDING  ? 'END_RECORDING'
                 : `0x${evtType.toString(16)}`;
      const ageMs = Date.now() - this._studyStartTime;
      console.log(`[BLE] Async event: ${name} (0x${evtType.toString(16)}) age=${ageMs}ms`);

      // Discard MCT_BLOCK_READY events within 10 seconds of startStudy() —
      // these are stale queued events from a previous recording session.
      if (evtType === EVT.MCT_BLOCK && ageMs < 10000) {
        console.log('[BLE] Ignoring stale MCT_BLOCK_READY (queued from previous session)');
        return;
      }

      if (this.onEvent) this.onEvent(evtType);
      return;
    }

    // ACK (byte[7] = 0xB3, byte[8] = 0x11 = SUCCESS)
    if (byte7 === 0xB3 && dv.byteLength >= 9 && dv.getUint8(8) === 0x11) {
      console.log('[BLE] ACK: command accepted');
      return;
    }

    // Live ECG samples: type 0x4F, payload starting at byte 7, 16-bit LE
    if (typeByte === 0x4F && !this._suspended && this.onData) {
      const HEADER = 7;
      const samples = [];
      for (let i = HEADER; i + 1 < dv.byteLength; i += 2) {
        samples.push(dv.getInt16(i, true));
      }
      if (samples.length > 0) this.onData(samples);
    }
  }

  // ── Disconnect handler & auto-reconnect ──────────────────────────

  _onDisconnected() {
    this.connected  = false;
    this.streaming  = false;
    this.ecgChar    = null;
    this.writeChar  = null;
    this.server     = null;

    if (this._intentionalDisconnect) {
      this._intentionalDisconnect = false;
      this._setStatus('Disconnected');
      return;
    }

    this._setStatus('Connection lost — reconnecting...');
    this._autoReconnect();
  }

  async _autoReconnect() {
    if (!this.device || this._reconnecting) return;
    this._reconnecting     = true;
    this._reconnectAttempt = 0;
    const MAX = 5;

    while (this._reconnecting && this._reconnectAttempt < MAX) {
      this._reconnectAttempt++;
      const delay = Math.min(1000 * this._reconnectAttempt, 5000);
      this._setStatus(`Reconnecting... (${this._reconnectAttempt}/${MAX})`);
      await new Promise(r => setTimeout(r, delay));
      if (!this._reconnecting) break;

      try {
        this.server = await this.device.gatt.connect();
        await new Promise(r => setTimeout(r, 2000)); // stabilize
        await this._discoverCharacteristics();
        this.connected     = true;
        this._reconnecting = false;
        this._reconnectAttempt = 0;

        this._suspended = false; // always clear suspend — may have been set during a block fetch that was interrupted by disconnect
        if (this.onData) {
          this.ecgChar.addEventListener('characteristicvaluechanged', this._boundHandleNotification);
          await this.ecgChar.startNotifications();
          await this._writeCommand(BLE_CONFIG.START_COMMAND, 'START');
          this.streaming = true;
          this._setStatus('Reconnected — streaming resumed');
        } else {
          this._setStatus(`Reconnected: ${this.device.name || 'device'}`);
        }
        return;
      } catch (err) {
        console.warn(`[BLE] Reconnect attempt ${this._reconnectAttempt} failed:`, err.message);
      }
    }

    this._reconnecting = false;
    this._setStatus('Could not reconnect — please reconnect manually');
  }

  _setStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }
}

const ble = new BleConnection();
export default ble;
export { BLE_CONFIG, buildPacket, EVT };
