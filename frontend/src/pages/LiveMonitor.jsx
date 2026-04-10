/**
 * LiveMonitor — Real-time ECG streaming, visualization & recording.
 *
 * ── Flow ───────────────────────────────────────────────────────────
 *   1. Click "Connect Device" → Study config modal
 *   2. Fill config, click "Start Study" → Bluetooth picker
 *   3. Device pairs → Swipe-to-Start appears
 *   4. Swipe → sends START command to device → streaming begins
 *   5. Swipe-to-Stop → sends STOP command → streaming ends
 *   6. Auto-stop after configured duration
 * ────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { FaBluetooth, FaCircle, FaStop } from "react-icons/fa";
import { MdSpeed, MdDownload } from "react-icons/md";
import { HiStatusOnline } from "react-icons/hi";
import socket from "../utils/socket";
import ble, { EVT } from "../utils/ble";
import { startRecording, stopRecording, getEdfUrl, decodeBseBlock } from "../utils/api";
import SwipeButton from "../components/SwipeButton";

const PIXELS_PER_MM = 2.4;
const DISPLAY_SECONDS = 8;
const SAMPLE_RATE = 250;
const BUFFER_SIZE = DISPLAY_SECONDS * SAMPLE_RATE;

// ─── Ring Buffer ────────────────────────────────────────────────────

class RingBuffer {
  constructor(size) {
    this.data = new Float64Array(size);
    this.size = size;
    this.writePos = 0;
    this.count = 0;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.data[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.size;
      if (this.count < this.size) this.count++;
    }
  }

  toArray() {
    if (this.count < this.size) {
      return this.data.slice(0, this.count);
    }
    const result = new Float64Array(this.size);
    const tail = this.size - this.writePos;
    result.set(this.data.subarray(this.writePos, this.size), 0);
    result.set(this.data.subarray(0, this.writePos), tail);
    return result;
  }

  clear() {
    this.data.fill(0);
    this.writePos = 0;
    this.count = 0;
  }
}

// ─── ECG Grid Drawing ──────────────────────────────────────────────

function drawECGGrid(ctx, width, height, bgColor) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  const smallGrid = PIXELS_PER_MM;
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 0.5;

  for (let x = 0; x <= width; x += smallGrid) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += smallGrid) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  const largeGrid = smallGrid * 5;
  ctx.strokeStyle = "#2e2d2dff";
  ctx.lineWidth = 1.5;

  for (let x = 0; x <= width; x += largeGrid) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += largeGrid) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

// ─── Component ──────────────────────────────────────────────────────

function LiveMonitor() {
  // BLE state
  const [bleConnected, setBleConnected] = useState(false);
  const [bleStreaming, setBleStreaming] = useState(false);
  const [bleStatus, setBleStatus] = useState("Disconnected");
  const [bleSupported] = useState(() => ble.constructor.isSupported());

  // Recording state
  const [recording, setRecording] = useState(false);
  const [studyId, setStudyId] = useState(null);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Optional serial validation
  const [serialInput, setSerialInput] = useState("");

  // Study config modal state
  const [showStudyModal, setShowStudyModal] = useState(false);
  const [studyConfig, setStudyConfig] = useState({
    studyType: "MCT",
    duration: 5,
    orientation: "horizontal",
  });

  // Swipe state (key to force remount SwipeButton after stop)
  const [swipeKey, setSwipeKey] = useState(0);
  const [swipeLoading, setSwipeLoading] = useState(false);

  // Study elapsed time
  const [studyElapsed, setStudyElapsed] = useState(0);
  const studyStartTimeRef = useRef(null);
  const studyIntervalRef = useRef(null);

  // Auto-stop timer ref
  const autoStopTimerRef = useRef(null);

  // Display controls
  const [gain, setGain] = useState(10);
  const [speed, setSpeed] = useState(25);
  const [lineColor, setLineColor] = useState("#00ff99");
  const [bgColor, setBgColor] = useState("#000000");

  // Canvas refs
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Ring buffer (8s live display)
  const bufferRef = useRef(new RingBuffer(BUFFER_SIZE));
  const animFrameRef = useRef(null);
  const recordingStartRef = useRef(null);
  const durationIntervalRef = useRef(null);

  // Smooth feed: decoded samples queue → drip-fed into bufferRef at ~250 Hz (internal only)
  const sampleQueueRef = useRef([]);        // pending samples waiting to be fed
  const smoothFeedIntervalRef = useRef(null); // setInterval handle

  // Pagination over allSamplesRef
  const [currentPage, setCurrentPage] = useState(0);
  const currentPageRef = useRef(0);          // mirror for animation loop (no stale closure)
  const [totalPages, setTotalPages] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const autoFollowRef = useRef(true);        // mirror for animation loop

  // Throttle ref for render diagnostics (log every 2s max)
  const lastRenderLogRef = useRef(0);

  // Polling fallback ref (unused but kept for cleanup safety)
  const blockPollIntervalRef = useRef(null);
  const bleStreamingRef = useRef(false);    // ref mirror of bleStreaming for use in intervals

  // Block fetch state
  const blockIndexRef = useRef(1);       // block index: offset = blockIndex * 0x10
  const blockFetchingRef = useRef(false);
  const pendingBlockFetchesRef = useRef(0); // MCT_BLOCK events queued while a fetch is in progress
  const stuckBlockCountRef = useRef(0);    // consecutive "no new samples" blocks from JAR
  const bseFileRef = useRef([]);         // accumulated MCT file bytes across all blocks
  const decodedSampleCountRef = useRef(0); // samples already plotted from accumulated file
  const [blockStatus, setBlockStatus] = useState('');

  // Accumulated decoded ECG samples (all blocks combined) — used for plotting & export
  // allSamplesRef is the single accumulation source — no parallel React state needed
  const allSamplesRef = useRef([]);

  // Accumulates raw BSE bytes (0-255) from device before decoding, for verification export
  const allRawBytesRef = useRef([]);

  // Accumulates full raw block bytes (entire block as-is from device) for hex dump export
  const allRawBlocksRef = useRef([]);

  // Audio
  const audioCtxRef = useRef(null);

  // Last completed study (for download)
  const [completedStudy, setCompletedStudy] = useState(null);

  // ── Cleanup on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
      if (studyIntervalRef.current) clearInterval(studyIntervalRef.current);
      if (blockPollIntervalRef.current) clearInterval(blockPollIntervalRef.current);
    };
  }, []);

  // ── Container size tracking ──────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function measure() {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Web Bluetooth status callback ────────────────────────────────
  useEffect(() => {
    ble.onStatusChange = (status) => {
      setBleStatus(status);
      setBleConnected(ble.connected);
      setBleStreaming(ble.streaming);
      socket.emit("ecg:bleStatus", { connected: ble.connected, streaming: ble.streaming });
    };
    return () => { ble.onStatusChange = null; };
  }, []);

  // ── Device async event handler ───────────────────────────────────
  useEffect(() => {
    ble.onEvent = (evtType) => {
      if (evtType === EVT.REC_STARTED) {
        // Device confirmed recording started — update streaming indicator
        setBleStreaming(true);
      } else if (evtType === EVT.MCT_BLOCK) {
        // Queue the event — never drop a block even if a fetch is already running
        pendingBlockFetchesRef.current += 1;
        fetchAndDisplayBlock();
      } else if (evtType === EVT.END_RECORDING) {
        // Device finished recording — mark streaming inactive so fetchAndDisplayBlock
        // is no longer gated. Keep BLE alive to fetch any remaining blocks.
        bleStreamingRef.current = false;
        setBleStreaming(false);
        setBlockStatus('Recording complete — fetching final blocks...');
      }
    };
    return () => { ble.onEvent = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Socket.IO: receive data from other clients ───────────────────
  useEffect(() => {
    function onEcgData(samples) {
      for (const s of samples) sampleQueueRef.current.push(s);
    }
    socket.on("ecg:data", onEcgData);
    return () => socket.off("ecg:data", onEcgData);
  }, []);

  // ── Smooth feed: drip decoded samples into ring buffer at ~250 Hz ──
  useEffect(() => {
    const CHUNK = 4;       // samples per tick — 4 × (1000ms / 16ms) ≈ 250 Hz playback rate
    const INTERVAL = 16;   // ms (~60 fps)
    smoothFeedIntervalRef.current = setInterval(() => {
      const q = sampleQueueRef.current;
      if (q.length === 0) return;
      const batch = q.splice(0, CHUNK);  // take up to 16 samples from front
      bufferRef.current.push(batch);
    }, INTERVAL);
    return () => clearInterval(smoothFeedIntervalRef.current);
  }, []);

  // ── Animation loop ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerSize.width === 0) return;
    const ctx = canvas.getContext("2d");

    function draw() {
      const width = containerSize.width;
      const height = containerSize.height;
      canvas.width = width;
      canvas.height = height;

      drawECGGrid(ctx, width, height, bgColor);

      // ── Render from allSamplesRef (single source of truth) ─────────
      const pixelsPerSecond = speed * PIXELS_PER_MM;
      const pixelsPerSample = pixelsPerSecond / SAMPLE_RATE;
      // windowSize = exact number of samples needed to fill the full canvas width
      const windowSize = Math.ceil(width / pixelsPerSample);
      const midY = height / 2;

      const allData = allSamplesRef.current;
      const totalSamples = allData.length;
      if (totalSamples < 2) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Pages are sized to exactly one canvas-width of samples
      const computedTotalPages = Math.max(1, Math.ceil(totalSamples / windowSize));
      const pageToShow = autoFollowRef.current
        ? computedTotalPages - 1
        : currentPageRef.current;
      const pageStart = pageToShow * windowSize;
      const pageEnd   = Math.min(pageStart + windowSize, totalSamples);
      const samples   = allData.slice(pageStart, pageEnd);

      if (samples.length < 2) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      // ── Throttled diagnostic log (every 2s) ──────────────────────
      const now = Date.now();
      if (now - lastRenderLogRef.current > 2000) {
        lastRenderLogRef.current = now;
        console.log(
          `[Render] allSamples=${totalSamples} | windowSize=${windowSize}` +
          ` | totalPages=${computedTotalPages} | pageShown=${pageToShow}` +
          ` | pageStart=${pageStart} | pageEnd=${pageEnd}` +
          ` | sliceLen=${samples.length} | autoFollow=${autoFollowRef.current}` +
          ` | queue=${sampleQueueRef.current.length}`
        );
      }

      const visibleSamples = samples.length;  // always render all samples in the page slice
      // Live page: anchor to the right (show latest); historical: anchor left (start of page)
      const startIdx = autoFollowRef.current
        ? Math.max(0, samples.length - windowSize)
        : 0;

      // Remove DC baseline and auto-scale to fit canvas
      let sum = 0;
      for (let i = startIdx; i < startIdx + visibleSamples; i++) sum += samples[i];
      const mean = sum / visibleSamples;

      let peakAbs = 0;
      for (let i = startIdx; i < startIdx + visibleSamples; i++) {
        const dev = Math.abs(samples[i] - mean);
        if (dev > peakAbs) peakAbs = dev;
      }
      // gain slider acts as zoom: gain=10 default, gain=20 zooms in 2x
      const autoScale = peakAbs > 0 ? (height * 0.4) / peakAbs : 1;
      const scale = autoScale * (gain / 10);

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < visibleSamples; i++) {
        const x = i * pixelsPerSample;
        const y = midY - (samples[startIdx + i] - mean) * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Status pill
      const statusText = recording
        ? `REC  ${formatDuration(recordingDuration)}`
        : bleStreaming
        ? `LIVE  ${formatDuration(studyElapsed)}`
        : bleConnected
        ? "CONNECTED"
        : "OFFLINE";
      const statusColor = recording ? "#ef4444" : bleStreaming ? "#22c55e" : bleConnected ? "#3b82f6" : "#6b7280";

      ctx.font = "bold 11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
      ctx.textBaseline = "top";
      const textW = ctx.measureText(statusText).width;
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.beginPath(); ctx.roundRect(8, 8, textW + 24, 22, 4); ctx.fill();
      ctx.fillStyle = statusColor;
      ctx.beginPath(); ctx.arc(20, 19, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e2ffe9";
      ctx.fillText(statusText, 28, 12);

      animFrameRef.current = requestAnimationFrame(draw);
    }

    animFrameRef.current = requestAnimationFrame(draw);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [containerSize, gain, speed, lineColor, bgColor, bleConnected, bleStreaming, recording, recordingDuration, studyElapsed]);

  // ── Actions ──────────────────────────────────────────────────────

  // Step 1: Open study config modal
  const handleOpenStudyModal = useCallback(() => {
    setShowStudyModal(true);
  }, []);

  // Step 2: Pair device (from modal "Start Study" button)
  const handlePairDevice = useCallback(async () => {
    // Initialise AudioContext during user gesture (must be before any await)
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    setShowStudyModal(false);
    console.log("[LiveMonitor] Study config:", studyConfig);
    try {
      const success = await ble.connect(serialInput || undefined);
      if (success) {
        playPairSound();
        setBleConnected(true);
        // Now show swipe-to-start (bleConnected && !bleStreaming)
        setSwipeKey((k) => k + 1); // reset swipe button
      }
    } catch (err) {
      console.error("[LiveMonitor] Connect failed:", err);
      setBleStatus(`Failed: ${err.message}`);
    }
  }, [serialInput, studyConfig]);

  // ── UI sounds (placeholder - not used in web version) ───────────
  function playTone(freq, duration, delay = 0) {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gainNode.gain.setValueAtTime(0.25, ctx.currentTime + delay);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + duration);
    } catch { /* audio not available */ }
  }

  // Two-tone chime when device pairs
  function playPairSound() {
    playTone(523, 0.15, 0);    // C5
    playTone(784, 0.2, 0.15);  // G5
  }

  // Single confirm tone when streaming starts
  function playStartSound() {
    playTone(880, 0.25, 0);
  }

  // ── Pagination helpers ───────────────────────────────────────────

  // Samples that exactly fill the current canvas width at the current speed
  function getWindowSize() {
    if (containerSize.width === 0) return BUFFER_SIZE;
    return Math.ceil(containerSize.width / ((speed * PIXELS_PER_MM) / SAMPLE_RATE));
  }

  function getTotalPages() {
    const ws = getWindowSize();
    return Math.max(1, Math.ceil(allSamplesRef.current.length / ws));
  }

  // ── Pagination handlers ──────────────────────────────────────────

  function handlePrevPage() {
    if (currentPageRef.current <= 0) return;
    autoFollowRef.current = false;
    setAutoFollow(false);
    const newPage = currentPageRef.current - 1;
    currentPageRef.current = newPage;
    setCurrentPage(newPage);
  }

  function handleNextPage() {
    const tp = getTotalPages();
    if (currentPageRef.current >= tp - 1) return;
    const newPage = currentPageRef.current + 1;
    currentPageRef.current = newPage;
    setCurrentPage(newPage);
    if (newPage >= tp - 1) {
      autoFollowRef.current = true;
      setAutoFollow(true);
    } else {
      autoFollowRef.current = false;
      setAutoFollow(false);
    }
  }

  function handleGoLive() {
    const tp = getTotalPages();
    autoFollowRef.current = true;
    setAutoFollow(true);
    currentPageRef.current = tp - 1;
    setCurrentPage(tp - 1);
    setTotalPages(tp);
  }

  // ── ECG block fetch & display ────────────────────────────────────
  async function fetchAndDisplayBlock() {
    if (blockFetchingRef.current) return;  // already fetching — caller already incremented pendingBlockFetchesRef
    if (pendingBlockFetchesRef.current <= 0) return; // nothing queued
    pendingBlockFetchesRef.current -= 1;
    blockFetchingRef.current = true;
    try {
      setBlockStatus('Fetching ECG block...');
      ble.pauseNotifications();

      // Wait 300ms for device to be ready before issuing request
      await new Promise(r => setTimeout(r, 300));

      // Call FILE_INFO to confirm file is ready
      await ble.getFileInfo();

      // Fixed protocol token — confirmed working with device
      const token = [0x9C, 0x5B, 0xE7, 0xDA];
      const offset = 0x10;  // constant — device auto-advances its internal pointer
      console.log(`[LiveMonitor] Fetching block ${blockIndexRef.current} at offset 0x${offset.toString(16)}`);

      // Fetch raw block; on NACK 0x12 the error propagates to catch — do NOT retry here
      const block = await ble.fetchRawBlock(offset, token);

      // Capture entire raw block bytes for hex dump export
      allRawBlocksRef.current.push(Array.from(block));

      // DEBUG: dump key regions of the block to find where ECG data starts
      {
        const dump = (label, from, to) => {
          const hex = Array.from(block.slice(from, to)).map(b => b.toString(16).padStart(2,'0')).join(' ');
          console.log(`[BSE] ${label}:`, hex);
        };
        dump('header   [7..167]',   7,    167);   // BSE header region
        dump('mid-A  [200..280]',   200,  280);   // likely still header or early ECG
        dump('mid-B  [400..480]',   400,  480);   // should be ECG data by here
        dump('mid-C [1000..1080]',  1000, 1080);  // definitely ECG data
        dump('end  [4058..4104]',   4058, 4104);  // near-end ECG + CRC
      }

      // ── JAR-based BSE decoder ──────────────────────────────────────
      // Strip the 8-byte BLE transport+subcommand header and 4-byte CRC32 trailer.
      // The MCT data payload is bytes [8 .. len-4] = exactly 4096 bytes per block.
      const BLE_HDR = 8;  // 7-byte protocol header + 1-byte sub-command response
      const BLE_CRC = 4;
      const currentBlock = blockIndexRef.current;
      const blockPayload = block.slice(BLE_HDR, block.length - BLE_CRC);
      for (const b of blockPayload) bseFileRef.current.push(b);
      blockIndexRef.current += 1;
      for (let i = 0; i < block.length; i++) allRawBytesRef.current.push(block[i]);
      const hexString = bseFileRef.current.map(b => b.toString(16).padStart(2,'0')).join('');
      setBlockStatus(`Decoding block ${currentBlock} (${bseFileRef.current.length}B accumulated)...`);
      const allSamples = await decodeBseBlock(hexString, 0);
      const newSamples = allSamples.slice(decodedSampleCountRef.current);
      if (newSamples.length > 0) decodedSampleCountRef.current = allSamples.length;
      if (newSamples.length > 0) {
        // BSE decode is the primary data source in MCT mode (device does NOT send 0x4F live packets)
        for (const s of newSamples) allSamplesRef.current.push(s);
        for (const s of newSamples) sampleQueueRef.current.push(s);
        socket.emit('ecg:samples', newSamples);
        // Update pagination
        const ws = getWindowSize();
        const newTotalPages = Math.max(1, Math.ceil(allSamplesRef.current.length / ws));
        setTotalPages(newTotalPages);
        if (autoFollowRef.current) {
          const lastPage = newTotalPages - 1;
          currentPageRef.current = lastPage;
          setCurrentPage(lastPage);
        }
        console.log(`[BSE] +${newSamples.length} new samples (total: ${allSamplesRef.current.length})`);
        setBlockStatus(`+${newSamples.length} samples (total: ${allSamplesRef.current.length}), next block ${blockIndexRef.current}`);
      } else {
        setBlockStatus(`Block ${blockIndexRef.current - 1}: no new samples`);
      }
    } catch (err) {
      console.error('[LiveMonitor] Block fetch error:', err.message);
      setBlockStatus(`Fetch error: ${err.message}`);
    } finally {
      ble.resumeNotifications();
      blockFetchingRef.current = false;
      // Process the next queued block event if any arrived while this fetch was running
      if (pendingBlockFetchesRef.current > 0) {
        fetchAndDisplayBlock();
      }
    }
  }

  // Step 3: Swipe-to-Start → run full init sequence on device
  const handleSwipeStart = useCallback(async () => {
    // Ensure AudioContext exists during user gesture
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    setSwipeLoading(true);
    blockIndexRef.current = 1;        // block 1 → offset 0x10, block 2 → 0x20, etc.
    bseFileRef.current = [];
    decodedSampleCountRef.current = 0;
    pendingBlockFetchesRef.current = 0; // clear any leftover queued events from previous session
    blockFetchingRef.current = false;
    stuckBlockCountRef.current = 0;
    allSamplesRef.current = [];
    sampleQueueRef.current = [];      // clear smooth-feed queue
    bufferRef.current.clear();        // clear ring buffer (internal)
    currentPageRef.current = 0;
    setCurrentPage(0);
    setTotalPages(0);
    autoFollowRef.current = true;
    setAutoFollow(true);
    allSamplesRef.current = [];        // clear accumulated samples for new session
    allRawBytesRef.current = [];
    allRawBlocksRef.current = [];
    try {
      await ble.startStudy(
        (samples) => {
          const plotSamples = samples.join('\n').split('\n').map(Number);
          // Live 0x4F stream is the primary data source — continuous, real-time, no JAR dependency.
          // BSE block decode (fetchAndDisplayBlock) captures the same signal for raw export only.
          for (const s of plotSamples) allSamplesRef.current.push(s);
          for (const s of plotSamples) sampleQueueRef.current.push(s);
          socket.emit("ecg:samples", plotSamples);
        },
        {
          studyType:  studyConfig.studyType,
          duration:   studyConfig.duration,
          sampleRate: SAMPLE_RATE,
        },
      );
      playStartSound();
      setBleStreaming(true);
      bleStreamingRef.current = true;

      // Block fetching is event-driven via EVT.MCT_BLOCK.
      // No polling here — FILE_INFO / FETCH_BLOCK must NOT run while BLE notifications are active.

      // Start elapsed timer
      studyStartTimeRef.current = Date.now();
      setStudyElapsed(0);
      studyIntervalRef.current = setInterval(() => {
        setStudyElapsed(Math.floor((Date.now() - studyStartTimeRef.current) / 1000));
      }, 1000);

      // Auto-stop after configured duration (UI-side safety)
      if (studyConfig.duration > 0) {
        const durationMs = studyConfig.duration * 60 * 1000;
        autoStopTimerRef.current = setTimeout(() => {
          handleSwipeStop();
        }, durationMs);
      }
    } catch (err) {
      console.error("[LiveMonitor] Start study failed:", err);
      setBleStatus(`Start failed: ${err.message}`);
    } finally {
      setSwipeLoading(false);
    }
  }, [studyConfig]);

  // Download accumulated ECG integer samples as a plain .txt file (one value per line)
  function downloadEcgTxt() {
    const samples = allSamplesRef.current;
    if (samples.length === 0) return;
    const txt = samples.join('\n');
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ecg_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[LiveMonitor] Downloaded ${samples.length} ECG samples as txt`);
  }

  // Download raw BSE bytes (0-255, ASCII) for verifying delta decode against TXT file
  // Format: "rawByte | delta | decodedSample" per line
  function downloadEcgBse() {
    const rawBytes = allRawBytesRef.current;
    const samples  = allSamplesRef.current;
    if (rawBytes.length === 0) return;
    const lines = [];
    lines.push('raw_byte\tdelta\tdecoded_sample');
    for (let i = 0; i < rawBytes.length; i++) {
      const b     = rawBytes[i];
      const delta = b - 128;
      const val   = samples[i] !== undefined ? samples[i] : '';
      lines.push(`${b}\t${delta}\t${val}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ecg_${Date.now()}.bse`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[LiveMonitor] Downloaded ${rawBytes.length} raw BSE bytes as bse`);
  }

  // Download full raw block bytes as hex (space-separated, one block per line)
  function downloadEcgHex() {
    const blocks = allRawBlocksRef.current;
    if (blocks.length === 0) return;
    const lines = blocks.map(blockBytes =>
      blockBytes.map(b => b.toString(16).padStart(2, '0')).join(' ')
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ecg_${Date.now()}_raw.hex`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[LiveMonitor] Downloaded ${blocks.length} raw blocks as hex`);
  }

  // Step 4: Swipe-to-Stop → send STOP command to device
  const handleSwipeStop = useCallback(async () => {
    try {
      setBlockStatus('');
      bleStreamingRef.current = false;
      if (blockPollIntervalRef.current) {
        clearInterval(blockPollIntervalRef.current);
        blockPollIntervalRef.current = null;
      }
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      if (studyIntervalRef.current) {
        clearInterval(studyIntervalRef.current);
        studyIntervalRef.current = null;
      }
      // Stagger downloads — browsers block multiple simultaneous programmatic downloads
      downloadEcgTxt();
      setTimeout(() => downloadEcgBse(), 300);
      setTimeout(() => downloadEcgHex(), 600);
      await ble.stopStudy();
      setBleStreaming(false);
      setSwipeKey((k) => k + 1); // reset swipe button for next start
    } catch (err) {
      console.error("[LiveMonitor] Stop study failed:", err);
    }
  }, []);

  // Disconnect entirely
  const handleDisconnect = useCallback(async () => {
    try {
      bleStreamingRef.current = false;
      if (blockPollIntervalRef.current) { clearInterval(blockPollIntervalRef.current); blockPollIntervalRef.current = null; }
      if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
      if (studyIntervalRef.current) { clearInterval(studyIntervalRef.current); studyIntervalRef.current = null; }
      await ble.disconnect();
      setBleConnected(false);
      setBleStreaming(false);
      setBlockStatus('');
      bufferRef.current.clear();
      currentPageRef.current = 0;
      setCurrentPage(0);
      setTotalPages(0);
      autoFollowRef.current = true;
      setAutoFollow(true);
      setStudyElapsed(0);
    } catch (err) {
      console.error("Disconnect failed:", err);
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    try {
      const result = await startRecording({ sampleRate: SAMPLE_RATE });
      setStudyId(result.studyId);
      setRecording(true);
      setRecordingDuration(0);
      recordingStartRef.current = Date.now();
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }, 1000);
    } catch (err) {
      console.error("Start recording failed:", err);
    }
  }, []);

  const handleStopRecording = useCallback(async () => {
    try {
      clearInterval(durationIntervalRef.current);
      const result = await stopRecording();
      setRecording(false);
      setCompletedStudy(result.meta);
    } catch (err) {
      console.error("Stop recording failed:", err);
    }
  }, []);

  // ── Render ───────────────────────────────────────────────────────

  const gainValues = [2, 5, 10, 20, 30, 40, 50];
  const speedValues = [10, 20, 25, 30, 40, 50];

  return (
    <div style={{ padding: "0 1rem", height: "calc(100vh - 3.5rem)", display: "flex", flexDirection: "column" }}>

      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 0.75rem",
        background: "rgba(17, 24, 39, 0.85)",
        borderRadius: "0.75rem",
        margin: "0.5rem 0",
        flexWrap: "wrap",
        border: "1px solid rgba(148, 163, 184, 0.15)",
      }}>

        {/* BLE Status */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <HiStatusOnline size={16} style={{ color: bleStreaming ? "#22c55e" : bleConnected ? "#3b82f6" : "#6b7280" }} />
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{bleStatus}</span>
        </div>

        <div style={{ width: 1, height: 24, background: "rgba(148, 163, 184, 0.2)" }} />

        {/* Connect button (when not connected) */}
        {!bleConnected && (
          <button
            onClick={handleOpenStudyModal}
            disabled={!bleSupported}
            style={btnStyle("#22c55e")}
            title={bleSupported ? "Configure study and connect device" : "Web Bluetooth not supported — use Chrome or Edge"}
          >
            <FaBluetooth size={12} />
            {bleSupported ? "Connect Device" : "BLE Not Supported"}
          </button>
        )}

        {/* Disconnect + controls (when connected) */}
        {bleConnected && (
          <>
            <button onClick={handleDisconnect} style={btnStyle("#ef4444")}>
              Disconnect
            </button>

            {bleStreaming && (
              <>
                <div style={{ width: 1, height: 24, background: "rgba(148, 163, 184, 0.2)" }} />
                <span style={{ fontSize: "0.75rem", color: "#22c55e", fontWeight: 600 }}>
                  {studyConfig.studyType} — {formatDuration(studyElapsed)} / {studyConfig.duration}m
                </span>

                <div style={{ width: 1, height: 24, background: "rgba(148, 163, 184, 0.2)" }} />

                {/* Recording controls */}
                {!recording ? (
                  <button onClick={handleStartRecording} style={btnStyle("#ef4444")}>
                    <FaCircle size={10} /> Record
                  </button>
                ) : (
                  <button onClick={handleStopRecording} style={btnStyle("#f59e0b")}>
                    <FaStop size={10} /> Stop ({formatDuration(recordingDuration)})
                  </button>
                )}
              </>
            )}
          </>
        )}

        <div style={{ width: 1, height: 24, background: "rgba(148, 163, 184, 0.2)" }} />

        {/* Gain */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <MdSpeed size={14} style={{ color: "#9ca3af" }} />
          <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>Gain</span>
          <select value={gain} onChange={(e) => setGain(Number(e.target.value))} style={selectStyle}>
            {gainValues.map((v) => <option key={v} value={v}>{v} mm/mV</option>)}
          </select>
        </div>

        {/* Speed */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={selectStyle}>
            {speedValues.map((v) => <option key={v} value={v}>{v} mm/s</option>)}
          </select>
        </div>

        {/* Colors */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>Line</span>
          <input type="color" value={lineColor} onChange={(e) => setLineColor(e.target.value)}
            style={{ width: 22, height: 22, border: "none", background: "none", cursor: "pointer" }} />
          <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>BG</span>
          <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)}
            style={{ width: 22, height: 22, border: "none", background: "none", cursor: "pointer" }} />
        </div>

        {/* Block fetch status */}
        {blockStatus !== '' && (
          <span style={{ fontSize: "0.7rem", color: "#a78bfa" }}>{blockStatus}</span>
        )}

        {/* Download EDF */}
        {completedStudy && (
          <>
            <div style={{ width: 1, height: 24, background: "rgba(148, 163, 184, 0.2)" }} />
            <a href={getEdfUrl(completedStudy.studyId)} download="recording.edf"
              style={{ ...btnStyle("#8b5cf6"), textDecoration: "none" }}>
              <MdDownload size={14} /> Download EDF
            </a>
            <span style={{ fontSize: "0.7rem", color: "#9ca3af" }}>
              {completedStudy.durationSeconds?.toFixed(0)}s recorded
            </span>
          </>
        )}
      </div>

      {/* ── Canvas ───────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          borderRadius: "0.75rem",
          overflow: "hidden",
          border: "1px solid rgba(148, 163, 184, 0.15)",
          background: "#000",
          minHeight: 200,
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
      </div>

      {/* ── Pagination controls ──────────────────────────────────── */}
      {totalPages > 0 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.5rem",
          padding: "0.3rem 0",
        }}>
          <button
            onClick={handlePrevPage}
            disabled={currentPage === 0}
            style={btnStyle(currentPage === 0 ? "#374151" : "#4b5563")}
          >
            ‹ Prev
          </button>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af", minWidth: 90, textAlign: "center" }}>
            Page {currentPage + 1} of {totalPages}
          </span>
          <button
            onClick={handleNextPage}
            disabled={autoFollow || currentPage >= totalPages - 1}
            style={btnStyle(autoFollow || currentPage >= totalPages - 1 ? "#374151" : "#4b5563")}
          >
            Next ›
          </button>
          {!autoFollow && (
            <button onClick={handleGoLive} style={btnStyle("#22c55e")}>
              Go Live
            </button>
          )}
        </div>
      )}

      {/* ── Swipe-to-Start / Swipe-to-Stop (over canvas, centered) ── */}
      {bleConnected && !showStudyModal && (
        <div style={{
          position: "absolute",
          bottom: 40,
          left: "50%",
          transform: "translateX(-50%)",
          width: 340,
          maxWidth: "80vw",
          zIndex: 10,
        }}>
          {!bleStreaming ? (
            <SwipeButton
              key={`start-${swipeKey}`}
              label="Swipe to start reading..."
              color="#22c55e"
              loading={swipeLoading}
              onSwipeComplete={handleSwipeStart}
            />
          ) : (
            <SwipeButton
              key={`stop-${swipeKey}`}
              label="Swipe to stop reading..."
              color="#ef4444"
              onSwipeComplete={handleSwipeStop}
            />
          )}
        </div>
      )}

      {/* ── No device message ────────────────────────────────────── */}
      {!bleConnected && !showStudyModal && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: "#6b7280",
          pointerEvents: "none",
        }}>
          <FaBluetooth size={48} style={{ marginBottom: "1rem", opacity: 0.3 }} />
          <div style={{ fontSize: "1rem" }}>Click "Connect Device" to pair your ECG sensor</div>
          <div style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
            {bleSupported ? "Your browser will show a Bluetooth device picker" : "Web Bluetooth requires Chrome or Edge browser"}
          </div>
        </div>
      )}

      {/* ── Study Config Modal ──────────────────────────────────── */}
      {showStudyModal && (
        <div style={modalOverlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ margin: "0 0 1rem", color: "#e2e8f0", fontSize: "1rem" }}>
              Study Configuration
            </h3>

            <div style={modalFieldStyle}>
              <label style={modalLabelStyle}>Study Type</label>
              <select
                value={studyConfig.studyType}
                onChange={(e) => setStudyConfig((c) => ({ ...c, studyType: e.target.value }))}
                style={modalSelectStyle}
              >
                <option value="MCT">MCT</option>
                <option value="Holter">Holter</option>
                <option value="Event">Event</option>
                <option value="Stress">Stress</option>
              </select>
            </div>

            <div style={modalFieldStyle}>
              <label style={modalLabelStyle}>Duration (minutes)</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={studyConfig.duration}
                onChange={(e) => setStudyConfig((c) => ({ ...c, duration: Number(e.target.value) || 1 }))}
                style={modalInputStyle}
              />
            </div>

            <div style={modalFieldStyle}>
              <label style={modalLabelStyle}>Orientation</label>
              <select
                value={studyConfig.orientation}
                onChange={(e) => setStudyConfig((c) => ({ ...c, orientation: e.target.value }))}
                style={modalSelectStyle}
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </div>

            <div style={modalFieldStyle}>
              <label style={modalLabelStyle}>Serial Number (optional)</label>
              <input
                type="text"
                placeholder="e.g. ABC123"
                value={serialInput}
                onChange={(e) => setSerialInput(e.target.value)}
                style={modalInputStyle}
              />
            </div>

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", justifyContent: "flex-end" }}>
              <button onClick={() => setShowStudyModal(false)} style={btnStyle("#4b5563")}>
                Cancel
              </button>
              <button onClick={handlePairDevice} style={btnStyle("#22c55e")}>
                <FaBluetooth size={12} />
                Pair Device
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const selectStyle = {
  background: "rgba(0, 0, 0, 0.4)",
  border: "1px solid rgba(148, 163, 184, 0.2)",
  borderRadius: "0.25rem",
  color: "#e2e8f0",
  padding: "0.15rem 0.25rem",
  fontSize: "0.7rem",
  cursor: "pointer",
  outline: "none",
};

const modalOverlayStyle = {
  position: "fixed",
  top: 0, left: 0, right: 0, bottom: 0,
  background: "rgba(0, 0, 0, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle = {
  background: "#1f2937",
  borderRadius: "0.75rem",
  padding: "1.5rem",
  width: 360,
  maxWidth: "90vw",
  border: "1px solid rgba(148, 163, 184, 0.2)",
};

const modalFieldStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  marginBottom: "0.75rem",
};

const modalLabelStyle = {
  fontSize: "0.75rem",
  color: "#9ca3af",
  fontWeight: 500,
};

const modalSelectStyle = {
  background: "rgba(0, 0, 0, 0.4)",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  borderRadius: "0.375rem",
  color: "#e2e8f0",
  padding: "0.4rem 0.5rem",
  fontSize: "0.8rem",
  outline: "none",
};

const modalInputStyle = {
  background: "rgba(0, 0, 0, 0.4)",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  borderRadius: "0.375rem",
  color: "#e2e8f0",
  padding: "0.4rem 0.5rem",
  fontSize: "0.8rem",
  outline: "none",
};

function btnStyle(color) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.3rem 0.65rem",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default LiveMonitor;
