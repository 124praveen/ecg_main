import { useRef, useState, useCallback } from "react";

/**
 * SwipeButton — Swipe-to-confirm action button.
 *
 * Props:
 *   label       — text shown behind the thumb (e.g. "Swipe to start reading...")
 *   onSwipeComplete — called when swipe reaches the end
 *   color       — gradient start color (default green)
 *   disabled    — disables interaction
 *   loading     — shows spinner on the thumb after swipe completes
 */
export default function SwipeButton({
  label = "Swipe to start reading...",
  onSwipeComplete,
  color = "#22c55e",
  disabled = false,
  loading = false,
}) {
  const trackRef = useRef(null);
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [completed, setCompleted] = useState(false);

  const THUMB_SIZE = 56;
  const THRESHOLD = 0.85; // 85% swipe to trigger

  const getMaxOffset = useCallback(() => {
    if (!trackRef.current) return 0;
    return trackRef.current.offsetWidth - THUMB_SIZE;
  }, []);

  const handlePointerDown = useCallback((e) => {
    if (disabled || completed) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, [disabled, completed]);

  const handlePointerMove = useCallback((e) => {
    if (!dragging || disabled || completed) return;
    const track = trackRef.current;
    if (!track) return;
    const trackRect = track.getBoundingClientRect();
    const maxOffset = track.offsetWidth - THUMB_SIZE;
    const newX = Math.min(Math.max(0, e.clientX - trackRect.left - THUMB_SIZE / 2), maxOffset);
    setOffsetX(newX);
  }, [dragging, disabled, completed]);

  const handlePointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    const maxOffset = getMaxOffset();
    if (maxOffset > 0 && offsetX >= maxOffset * THRESHOLD) {
      setOffsetX(maxOffset);
      setCompleted(true);
      onSwipeComplete?.();
    } else {
      setOffsetX(0);
    }
  }, [dragging, offsetX, getMaxOffset, onSwipeComplete]);

  // Reset from parent by changing key or calling reset
  const progress = getMaxOffset() > 0 ? offsetX / getMaxOffset() : 0;

  return (
    <div
      ref={trackRef}
      style={{
        position: "relative",
        width: "100%",
        height: THUMB_SIZE,
        borderRadius: THUMB_SIZE / 2,
        border: "1px solid rgba(148, 163, 184, 0.15)",
        background: "rgba(17, 24, 39, 0.85)",
        overflow: "hidden",
        userSelect: "none",
        touchAction: "none",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "default",
      }}
    >
      {/* Label text (centered behind thumb) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#9ca3af",
          fontSize: "0.85rem",
          fontWeight: 500,
          pointerEvents: "none",
          opacity: 1 - progress * 1.5, // fade out as thumb slides
          transition: dragging ? "none" : "opacity 0.2s",
        }}
      >
        {label}
      </div>

      {/* Progress fill */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          height: "100%",
          width: offsetX + THUMB_SIZE,
          background: `linear-gradient(90deg, ${color}, ${color}88)`,
          borderRadius: THUMB_SIZE / 2,
          opacity: 0.2,
          transition: dragging ? "none" : "width 0.3s ease",
        }}
      />

      {/* Draggable thumb */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          width: THUMB_SIZE - 4,
          height: THUMB_SIZE - 4,
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${color}, ${color}cc)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateX(${offsetX}px)`,
          transition: dragging ? "none" : "transform 0.3s ease",
          cursor: disabled || completed ? "not-allowed" : "grab",
          boxShadow: `0 2px 8px ${color}44`,
        }}
      >
        {loading ? (
          <div
            style={{
              width: 20,
              height: 20,
              border: "2px solid rgba(255,255,255,0.3)",
              borderTopColor: "#fff",
              borderRadius: "50%",
              animation: "swipe-spin 0.8s linear infinite",
            }}
          />
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M7 4l6 6-6 6"
              stroke="#fff"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      {/* Spinner keyframes (injected once) */}
      <style>{`
        @keyframes swipe-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
