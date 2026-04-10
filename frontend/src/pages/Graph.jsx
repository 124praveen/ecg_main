import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  HiArrowCircleLeft,
  HiChevronDoubleLeft,
  HiChevronDoubleRight,
  HiChevronLeft,
  HiChevronRight,
} from "react-icons/hi";
import { MdSpeed, MdTimeline, MdInvertColors } from "react-icons/md";
import { BiTimer } from "react-icons/bi";
import { useLocation, useNavigate } from "react-router-dom";
import { parseAndStoreFile, formatTimeLabel } from "../utils/fileParsers";
import { getChunks } from "../utils/ecgDB";

const PIXELS_PER_MM = 2.4;
const ROW_HEIGHT = 122;

function Graph() {
  const location = useLocation();
  const navigate = useNavigate();
  const files = location.state?.files || [];

  // Metadata from IndexedDB
  const [metadata, setMetadata] = useState(null);
  const [fileKey, setFileKey] = useState(null);

  // Loading state
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);

  // Rendering controls
  const [gain, setGain] = useState(10);
  const [speed, setSpeed] = useState(25);
  const [lineColor, setLineColor] = useState("#00ff99");
  const [bgColor, setBgColor] = useState("#000000");
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [invertGraph, setInvertGraph] = useState(false);
  const [singleRowMode, setSingleRowMode] = useState(false);

  // Navigation
  const [currentPage, setCurrentPage] = useState(0);

  // Container sizing
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Loaded page samples
  const [pageData, setPageData] = useState(null);

  const mmmvValues = [2, 5, 10, 20, 30, 40, 50];
  const mmsValues = [10, 20, 25, 30, 40, 50];

  // ── Parse & store file on mount ──────────────────────────────
  useEffect(() => {
    if (!files || files.length === 0) return;
    let cancelled = false;

    async function init() {
      setLoading(true);
      setProgress(0);
      try {
        // Process first file (primary use case)
        const result = await parseAndStoreFile(files[0], (pct) => {
          if (!cancelled) setProgress(pct);
        });
        if (cancelled) return;

        setFileKey(result.fileKey);
        setMetadata({
          totalChunks: result.totalChunks,
          chunkSize: result.chunkSize,
          sampleRate: result.sampleRate,
          totalValues: result.totalValues,
          durationInSeconds: result.durationInSeconds,
          startTime: result.startTime,
        });

        if (result.startTime) setShowTimeLabels(true);
      } catch (err) {
        console.error("Failed to parse file:", err);
      }
      if (!cancelled) setLoading(false);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [files]);

  // ── Container size tracking ──────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function measure() {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    }

    measure();

    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // ── Layout calculation ───────────────────────────────────────
  const layout = useMemo(() => {
    if (!metadata || !containerSize.width || !containerSize.height) return null;

    const pixelsPerSecond = speed * PIXELS_PER_MM;
    const secondsPerRow = containerSize.width / pixelsPerSecond;
    const samplesPerRow = Math.max(1, Math.floor(secondsPerRow * metadata.sampleRate));
    const rowHeight = singleRowMode ? containerSize.height : ROW_HEIGHT;
    const rowsPerScreen = singleRowMode
      ? 1
      : Math.max(1, Math.floor(containerSize.height / ROW_HEIGHT));
    const samplesPerScreen = samplesPerRow * rowsPerScreen;
    const totalRows = Math.ceil(metadata.totalValues / samplesPerRow);
    const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerScreen));

    return {
      pixelsPerSecond,
      secondsPerRow,
      samplesPerRow,
      rowHeight,
      rowsPerScreen,
      samplesPerScreen,
      totalRows,
      totalPages,
    };
  }, [metadata, containerSize, speed, singleRowMode]);

  // Reset page when layout changes
  useEffect(() => {
    setCurrentPage(0);
  }, [speed, singleRowMode]);

  // ── Load chunks for current page ─────────────────────────────
  useEffect(() => {
    if (!layout || !fileKey || !metadata) return;
    let cancelled = false;

    async function loadPage() {
      const startSample = currentPage * layout.samplesPerScreen;
      const endSample = Math.min(
        startSample + layout.samplesPerScreen,
        metadata.totalValues
      );

      if (startSample >= metadata.totalValues) {
        setPageData(null);
        return;
      }

      const startChunk = Math.floor(startSample / metadata.chunkSize);
      const endChunk = Math.min(
        Math.floor((endSample - 1) / metadata.chunkSize),
        metadata.totalChunks - 1
      );

      const chunks = await getChunks(fileKey, startChunk, endChunk);
      if (cancelled) return;

      // Stitch chunks and extract needed range
      const offsetInFirstChunk = startSample - startChunk * metadata.chunkSize;
      const needed = endSample - startSample;

      // Allocate fixed-size buffer: each chunk slot is always CHUNK_SIZE wide
      // so null/missing chunks leave zeros in the correct position (flat line)
      // rather than shifting subsequent chunks into the wrong position.
      const chunkCount = endChunk - startChunk + 1;
      const allData = new Float64Array(chunkCount * metadata.chunkSize);
      let writePos = 0;
      for (const chunk of chunks) {
        if (chunk) {
          allData.set(chunk, writePos);
        }
        writePos += metadata.chunkSize; // always advance, even for null chunks
      }

      const samples = allData.slice(offsetInFirstChunk, offsetInFirstChunk + needed);
      if (!cancelled) {
        setPageData({ samples, startSample });
      }
    }

    loadPage();
    return () => {
      cancelled = true;
    };
  }, [layout, fileKey, metadata, currentPage]);

  // ── Draw canvas ──────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || !pageData || !layout || !metadata) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const width = containerSize.width;
    const canvasHeight = layout.rowsPerScreen * layout.rowHeight;

    // Set canvas dimensions (also clears it)
    canvas.width = width;
    canvas.height = canvasHeight;

    const pixelsPerSecond = speed * PIXELS_PER_MM;
    const pixelsPerSample = pixelsPerSecond / metadata.sampleRate;

    const mvPerMm = 1000 / gain;
    const pixelsPerMilliVolt = PIXELS_PER_MM / mvPerMm;

    for (let r = 0; r < layout.rowsPerScreen; r++) {
      const start = r * layout.samplesPerRow;
      const end = Math.min(start + layout.samplesPerRow, pageData.samples.length);
      if (start >= pageData.samples.length) break;

      const yOffset = r * layout.rowHeight;

      ctx.save();
      ctx.translate(0, yOffset);
      ctx.beginPath();
      ctx.rect(0, 0, width, layout.rowHeight);
      ctx.clip();

      // Grid background
      drawECGGrid(ctx, width, layout.rowHeight, bgColor);

      // Waveform
      const midY = layout.rowHeight / 2;
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let i = start; i < end; i++) {
        const x = (i - start) * pixelsPerSample;
        const val = invertGraph ? -pageData.samples[i] : pageData.samples[i];
        const y = midY - val * pixelsPerMilliVolt;
        if (i === start) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Row separator
      ctx.strokeStyle = "#7e7e7eff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, layout.rowHeight - 1);
      ctx.lineTo(width, layout.rowHeight - 1);
      ctx.stroke();

      // Time label — bright text on dark pill for readability
      if (showTimeLabels && metadata.startTime) {
        const globalStart = pageData.startSample + start;
        const offsetSec = globalStart / metadata.sampleRate;
        const durationSec = (end - start) / metadata.sampleRate;
        const base = new Date(metadata.startTime);
        const rowStart = new Date(base.getTime() + offsetSec * 1000);
        const rowEnd = new Date(rowStart.getTime() + durationSec * 1000);

        const label =
          formatTimeLabel(rowStart) + "  \u2014  " + formatTimeLabel(rowEnd);

        ctx.font =
          "bold 11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
        ctx.textBaseline = "top";
        const textW = ctx.measureText(label).width;

        // Dark semi-transparent pill behind text
        const px = 5, py = 4, padX = 6, padY = 3;
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.beginPath();
        ctx.roundRect(px, py, textW + padX * 2, 16, 4);
        ctx.fill();

        // Bright white-green text
        ctx.fillStyle = "#e2ffe9";
        ctx.fillText(label, px + padX, py + padY);
      }

      ctx.restore();
    }
  }, [
    pageData,
    layout,
    containerSize,
    metadata,
    gain,
    speed,
    lineColor,
    bgColor,
    showTimeLabels,
    invertGraph,
  ]);

  // ── Keyboard navigation ──────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      if (!layout) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setCurrentPage((p) => Math.min(p + 1, layout.totalPages - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setCurrentPage((p) => Math.max(p - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        setCurrentPage(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setCurrentPage(layout.totalPages - 1);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [layout]);

  // ── Navigation handlers ──────────────────────────────────────
  const goNext = useCallback(() => {
    if (!layout) return;
    setCurrentPage((p) => Math.min(p + 1, layout.totalPages - 1));
  }, [layout]);

  const goPrev = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 0));
  }, []);

  // ── Scrollbar drag ───────────────────────────────────────────
  const scrollbarRef = useRef(null);

  const handleScrollbarClick = useCallback(
    (e) => {
      if (!layout || !scrollbarRef.current) return;
      const rect = scrollbarRef.current.getBoundingClientRect();
      const fraction = (e.clientY - rect.top) / rect.height;
      const page = Math.round(fraction * (layout.totalPages - 1));
      setCurrentPage(Math.max(0, Math.min(page, layout.totalPages - 1)));
    },
    [layout]
  );

  // ── Format duration ──────────────────────────────────────────
  const durationStr = useMemo(() => {
    if (!metadata || !metadata.durationInSeconds) return null;
    const s = metadata.durationInSeconds;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }, [metadata]);

  // ── Loading screen ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="graph-loading-screen">
        <div className="spinner"></div>
        <p className="loading-text">
          {progress < 100
            ? `Processing ECG data... ${progress}%`
            : "Loading ECG data..."}
        </p>
        {progress > 0 && progress < 100 && (
          <div
            style={{
              width: 200,
              height: 6,
              background: "#1f2937",
              borderRadius: 3,
              marginTop: 10,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "#22c55e",
                borderRadius: 3,
                transition: "width 0.2s",
              }}
            />
          </div>
        )}
      </div>
    );
  }

  const thumbHeight =
    layout && layout.totalPages > 1
      ? Math.max(20, (1 / layout.totalPages) * 100)
      : 100;
  const thumbTop =
    layout && layout.totalPages > 1
      ? (currentPage / (layout.totalPages - 1)) * (100 - thumbHeight)
      : 0;

  const fileName = files[0]?.name || "ECG Recording";

  return (
    <div className="container-fluid py-0 bg-black text-white graph-page">
      {/* ── Header toolbar ──────────────────────────────────── */}
      <div className="ecg-toolbar">
        {/* Left: back + file info */}
        <div className="toolbar-left">
          <button className="toolbar-back-btn" onClick={() => navigate("/")}>
            <HiArrowCircleLeft size={22} />
          </button>
          <div className="toolbar-file-info">
            <span className="toolbar-file-name">{fileName}</span>
            {durationStr && (
              <span className="toolbar-duration">
                <BiTimer size={13} style={{ marginRight: 2 }} />
                {durationStr}
              </span>
            )}
            {metadata && (
              <span className="toolbar-meta">
                {metadata.sampleRate} Hz
              </span>
            )}
          </div>
        </div>

        {/* Center: controls */}
        <div className="toolbar-controls">
          {/* Gain & Speed group */}
          <div className="toolbar-group">
            <div className="toolbar-control">
              <MdTimeline size={13} className="toolbar-icon" />
              <select
                className="toolbar-select"
                value={gain}
                onChange={(e) => setGain(Number(e.target.value))}
              >
                {mmmvValues.map((g) => (
                  <option key={g} value={g}>
                    {g} mm/mV
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-control">
              <MdSpeed size={13} className="toolbar-icon" />
              <select
                className="toolbar-select"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {mmsValues.map((s) => (
                  <option key={s} value={s}>
                    {s} mm/s
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="toolbar-divider" />

          {/* Colors group */}
          <div className="toolbar-group">
            <div className="toolbar-control">
              <span className="toolbar-label">Line</span>
              <input
                type="color"
                className="toolbar-color"
                value={lineColor}
                onChange={(e) => setLineColor(e.target.value)}
              />
            </div>
            <div className="toolbar-control">
              <span className="toolbar-label">BG</span>
              <input
                type="color"
                className="toolbar-color"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
              />
            </div>
          </div>

          <div className="toolbar-divider" />

          {/* Toggles group */}
          <div className="toolbar-group">
            <label className="toolbar-toggle">
              <input
                type="checkbox"
                checked={invertGraph}
                onChange={(e) => setInvertGraph(e.target.checked)}
              />
              <MdInvertColors size={13} />
              <span>Invert</span>
            </label>
            <label className="toolbar-toggle">
              <input
                type="checkbox"
                checked={singleRowMode}
                onChange={(e) => setSingleRowMode(e.target.checked)}
              />
              <span>Strip</span>
            </label>
            <label className="toolbar-toggle">
              <input
                type="checkbox"
                checked={showTimeLabels}
                onChange={(e) => setShowTimeLabels(e.target.checked)}
              />
              <BiTimer size={13} />
              <span>Time</span>
            </label>
          </div>
        </div>

        {/* Right: page info */}
        {layout && layout.totalPages > 1 && (
          <div className="toolbar-page-info">
            <span className="toolbar-page-text">
              {currentPage + 1}
              <span className="toolbar-page-sep">/</span>
              {layout.totalPages}
            </span>
          </div>
        )}
      </div>

      {/* ── Main area: canvas + scrollbar ───────────────────── */}
      <div className="d-flex" style={{ flex: "1 1 auto", overflow: "hidden" }}>
        <div
          ref={containerRef}
          style={{ flex: "1 1 auto", overflow: "hidden", position: "relative" }}
        >
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", height: "100%" }}
          />
        </div>

        {/* Scrollbar track */}
        {layout && layout.totalPages > 1 && (
          <div
            ref={scrollbarRef}
            className="ecg-scrollbar-track"
            onClick={handleScrollbarClick}
          >
            <div
              className="ecg-scrollbar-thumb"
              style={{
                top: `${thumbTop}%`,
                height: `${thumbHeight}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* ── Navigation bar ──────────────────────────────────── */}
      {layout && layout.totalPages > 1 && (
        <div className="ecg-nav-bar">
          <button
            className="ecg-nav-btn"
            onClick={() => setCurrentPage(0)}
            disabled={currentPage === 0}
            title="First page (Home)"
          >
            <HiChevronDoubleLeft size={16} />
          </button>
          <button
            className="ecg-nav-btn"
            onClick={goPrev}
            disabled={currentPage === 0}
            title="Previous page"
          >
            <HiChevronLeft size={16} />
          </button>

          <div className="ecg-nav-page-indicator">
            <span className="ecg-nav-current">{currentPage + 1}</span>
            <span className="ecg-nav-sep">of</span>
            <span className="ecg-nav-total">{layout.totalPages}</span>
          </div>

          <button
            className="ecg-nav-btn"
            onClick={goNext}
            disabled={currentPage >= layout.totalPages - 1}
            title="Next page"
          >
            <HiChevronRight size={16} />
          </button>
          <button
            className="ecg-nav-btn"
            onClick={() => setCurrentPage(layout.totalPages - 1)}
            disabled={currentPage >= layout.totalPages - 1}
            title="Last page (End)"
          >
            <HiChevronDoubleRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── ECG Grid drawing ─────────────────────────────────────────────
function drawECGGrid(ctx, width, height, bgColor) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  const smallGrid = PIXELS_PER_MM;
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 0.5;

  for (let x = 0; x <= width; x += smallGrid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += smallGrid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const largeGrid = smallGrid * 5;
  ctx.strokeStyle = "#2e2d2dff";
  ctx.lineWidth = 1.5;

  for (let x = 0; x <= width; x += largeGrid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += largeGrid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

export default Graph;
