import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import JSZip from "jszip";

// ===================== HELPERS =====================
function fmtNum(n) { return Number(n).toLocaleString("en-IN"); }
function fmtCr(n) {
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(1) + " L";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}
function dlFile(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
}
function tick() { return new Promise(r => setTimeout(r, 0)); }

const VPD_MAP = { "21600000": 21600000, "25920000": 25920000, "17280000": 17280000 };

// ===================== FILE SCANNER =====================
async function scanFile(file, encoding, onProgress) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0, leftover = "", count = 0;
  while (offset < file.size) {
    const blob = file.slice(offset, offset + CHUNK);
    const buf = await blob.arrayBuffer();
    let text = "";
    try { text = new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "").replace(/\u0000/g, ""); }
    catch { const b = new Uint8Array(buf); text = b.map(x => ((x >= 45 && x <= 57) || x === 10 || x === 13 || x === 43) ? String.fromCharCode(x) : "\n").join(""); }
    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";
    for (const l of lines) { const t = l.trim(); if (t && /^[+-]?\d+(\.\d+)?$/.test(t)) count++; }
    offset += CHUNK;
    onProgress(Math.min(99, Math.round(offset / file.size * 100)), count);
    await tick();
  }
  if (leftover.trim() && /^[+-]?\d+(\.\d+)?$/.test(leftover.trim())) count++;
  return count;
}

function detectEncoding(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return "utf-16le";
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return "utf-16be";
  if (bytes.length > 3 && bytes[1] === 0x00 && bytes[3] === 0x00) return "utf-16le";
  return "utf-8";
}

// ===================== BOUNDARIES =====================
async function calcBoundaries(file, encoding, valPerDay, maxDays) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0, leftover = "", lineCount = 0, results = [], dayStart = 0, dayLines = 0;
  while (offset < file.size && results.length < maxDays) {
    const blob = file.slice(offset, offset + CHUNK);
    const buf = await blob.arrayBuffer();
    let text = "";
    try { text = new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "").replace(/\u0000/g, ""); }
    catch { const b = new Uint8Array(buf); text = b.map(x => ((x >= 45 && x <= 57) || x === 10 || x === 13 || x === 43) ? String.fromCharCode(x) : "\n").join(""); }
    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";
    const chunkBytes = buf.byteLength;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || !/^[+-]?\d+(\.\d+)?$/.test(t)) continue;
      lineCount++; dayLines++;
      if (dayLines >= valPerDay && results.length < maxDays - 1) {
        const frac = lines.length > 0 ? (i + 1) / lines.length : 1;
        const endByte = Math.min(offset + Math.round(frac * chunkBytes), offset + chunkBytes);
        results.push({ startByte: dayStart, endByte, count: dayLines });
        dayStart = endByte; dayLines = 0;
      }
    }
    offset += CHUNK;
    await tick();
  }
  if (dayLines > 0 && results.length < maxDays) results.push({ startByte: dayStart, endByte: file.size, count: dayLines });
  if (results.length > 0) results[results.length - 1].endByte = file.size;
  return results;
}

// ===================== EDF HELPERS =====================
async function edfPass1(file, encoding, onProgress) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0, leftover = "", mn = Infinity, mx = -Infinity, count = 0;
  while (offset < file.size) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    let text = "";
    try { text = new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "").replace(/\u0000/g, ""); } catch { text = ""; }
    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";
    for (const l of lines) { const t = l.trim(); if (!t || !/^[+-]?\d+(\.\d+)?$/.test(t)) continue; const v = parseFloat(t); if (v < mn) mn = v; if (v > mx) mx = v; count++; }
    offset += CHUNK;
    onProgress(Math.round(offset / file.size * 100));
    await tick();
  }
  if (leftover.trim() && /^[+-]?\d+(\.\d+)?$/.test(leftover.trim())) { const v = parseFloat(leftover.trim()); if (v < mn) mn = v; if (v > mx) mx = v; count++; }
  return { mn: mn === Infinity ? 0 : mn, mx: mx === -Infinity ? 1 : mx, count };
}

async function edfPass2(file, encoding, sampPerRec, gain, scaleOffset, recsPerChunk, onProgress, onChunk) {
  const CHUNK = 2 * 1024 * 1024;
  let offset = 0, leftover = "", sampleBuf = [], sampTarget = recsPerChunk * sampPerRec;
  function flush(final) {
    if (final) { const rem = sampleBuf.length % sampPerRec; if (rem > 0) for (let p = 0; p < sampPerRec - rem; p++) sampleBuf.push(0); }
    if (!sampleBuf.length) return;
    const ab = new ArrayBuffer(sampleBuf.length * 2), dv = new DataView(ab);
    for (let j = 0; j < sampleBuf.length; j++) { let d = Math.round((sampleBuf[j] - scaleOffset) / gain); d = Math.max(-32768, Math.min(32767, d)); dv.setInt16(j * 2, d, true); }
    onChunk(ab); sampleBuf = [];
  }
  while (offset < file.size) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    let text = "";
    try { text = new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "").replace(/\u0000/g, ""); } catch { text = ""; }
    const combined = leftover + text;
    const lines = combined.split(/\r?\n|\r/);
    leftover = lines.pop() || "";
    for (const l of lines) { const t = l.trim(); if (!t || !/^[+-]?\d+(\.\d+)?$/.test(t)) continue; sampleBuf.push(parseFloat(t)); if (sampleBuf.length >= sampTarget) flush(false); }
    offset += CHUNK;
    onProgress(Math.round(offset / file.size * 100));
    await tick();
  }
  if (leftover.trim() && /^[+-]?\d+(\.\d+)?$/.test(leftover.trim())) sampleBuf.push(parseFloat(leftover.trim()));
  flush(true);
}

// ===================== MAIN COMPONENT =====================
export default function StripTool() {
  const navigate = useNavigate();

  const [theFile, setTheFile] = useState(null);
  const [encoding, setEncoding] = useState("utf-8");
  const [totalValues, setTotalValues] = useState(0);
  const [vpd, setVpd] = useState(21600000);
  const [completeDays, setCompleteDays] = useState(0);
  const [remainingValues, setRemainingValues] = useState(0);
  const [activeTab, setActiveTab] = useState("upload");
  const [scanning, setScanning] = useState(false);
  const [scanPct, setScanPct] = useState(0);
  const [scanCount, setScanCount] = useState(0);
  const [splitProgress, setSplitProgress] = useState({ show: false, pct: 0, lbl: "" });
  const [selProgress, setSelProgress] = useState({ show: false, pct: 0, lbl: "" });
  const [remainProgress, setRemainProgress] = useState({ show: false, lbl: "" });
  const [edfProgress, setEdfProgress] = useState({ show: false, pct: 0, lbl: "" });
  const [splitNote, setSplitNote] = useState("");
  const [selNote, setSelNote] = useState("Will download separate files for each selected day");
  const [remainNote, setRemainNote] = useState("");
  const [edfNote, setEdfNote] = useState("EDF uses 16-bit integer samples. Values scaled to -32768 to 32767.");
  const [splitDays, setSplitDays] = useState(7);
  const [fromDay, setFromDay] = useState(1);
  const [toDay, setToDay] = useState(2);
  const [edfMode, setEdfMode] = useState("none");
  const [metaName, setMetaName] = useState("");
  const [metaSex, setMetaSex] = useState("");
  const [metaStart, setMetaStart] = useState("");
  const [metaRecAdd, setMetaRecAdd] = useState("");
  const [mergeFiles, setMergeFiles] = useState([]);
  const [mergeOutName, setMergeOutName] = useState("merged");
  const [mergeOrder, setMergeOrder] = useState("keep");
  const [mergeProgress, setMergeProgress] = useState({ show: false, pct: 0, lbl: "" });
  const [mergeLog, setMergeLog] = useState([]);
  const [mergeDlUrl, setMergeDlUrl] = useState(null);
  const [mergeDlName, setMergeDlName] = useState("");

  const fileInputRef = useRef(null);
  const mergeInputRef = useRef(null);
  const dragRef = useRef(false);

  const calcEndDate = useCallback(() => {
    if (!metaStart || !totalValues) return "";
    const p = metaStart.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!p) return "";
    const hz = Math.round(vpd / 86400);
    const totalSec = Math.round(totalValues / hz);
    const startMs = Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +(p[6] || 0));
    const endMs = startMs + totalSec * 1000;
    const ed = new Date(endMs);
    const f = n => String(n).padStart(2, "0");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${f(ed.getUTCDate())} ${months[ed.getUTCMonth()]} ${ed.getUTCFullYear()} ${f(ed.getUTCHours())}:${f(ed.getUTCMinutes())}:${f(ed.getUTCSeconds())}`;
  }, [metaStart, totalValues, vpd]);

  async function startLoad(file) {
    setTheFile(null); setTotalValues(0);
    setScanning(true); setScanPct(0); setScanCount(0);
    const header = await file.slice(0, 8).arrayBuffer();
    const enc = detectEncoding(new Uint8Array(header));
    setEncoding(enc);
    const count = await scanFile(file, enc, (pct, cnt) => { setScanPct(pct); setScanCount(cnt); });
    setScanning(false);
    if (count === 0) { alert("No numeric values found.\nMake sure file has one number per line."); return; }
    const cd = Math.floor(count / vpd);
    const rv = count - cd * vpd;
    setTheFile(file); setTotalValues(count);
    setCompleteDays(cd); setRemainingValues(rv);
    setSplitDays(cd > 0 ? cd : 1);
    setFromDay(1); setToDay(Math.min(2, cd || 1));
    setSelNote(`Will download ${Math.min(2, cd || 1)} file(s) -- Day 1 to Day ${Math.min(2, cd || 1)}`);
    setActiveTab("details");
  }

  function onRateChange(val) {
    const newVpd = VPD_MAP[val] || 21600000;
    setVpd(newVpd);
    if (totalValues) {
      const cd = Math.floor(totalValues / newVpd);
      const rv = totalValues - cd * newVpd;
      setCompleteDays(cd); setRemainingValues(rv);
      setSplitDays(cd || 1);
    }
  }

  async function doSplitAll() {
    if (!theFile) return;
    setSplitProgress({ show: true, pct: 10, lbl: "Calculating boundaries..." });
    setSplitNote("");
    const bounds = await calcBoundaries(theFile, encoding, vpd, splitDays);
    const zip = new JSZip();
    for (let d = 0; d < bounds.length; d++) {
      const b = bounds[d], dayNum = String(d + 1).padStart(2, "0"), name = `day_${dayNum}.txt`;
      setSplitProgress({ show: true, pct: Math.round((d + 1) / bounds.length * 80) + 10, lbl: `Slicing ${name}...` });
      zip.folder(`day_${dayNum}`).file(name, theFile.slice(b.startByte, b.endByte));
      await tick();
    }
    setSplitProgress({ show: true, pct: 90, lbl: "Building ZIP..." });
    const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } }, m => setSplitProgress(p => ({ ...p, pct: 90 + m.percent * 0.1 })));
    dlFile(URL.createObjectURL(zipBlob), "ECG_Days.zip");
    setSplitProgress({ show: true, pct: 100, lbl: "Done! ZIP downloaded." });
    setSplitNote(`${bounds.length} day files packaged.`);
  }

  async function doDownloadSelectedDays() {
    if (!theFile) return;
    const from = Math.max(1, Math.min(fromDay, completeDays || 1));
    const to = Math.max(from, Math.min(toDay, completeDays || 1));
    setSelProgress({ show: true, pct: 10, lbl: "Calculating boundaries..." });
    const bounds = await calcBoundaries(theFile, encoding, vpd, to);
    const zip = new JSZip();
    const zipName = `ECG_Day_${String(from).padStart(2, "0")}_to_${String(to).padStart(2, "0")}.zip`;
    for (let d = from - 1; d < to && d < bounds.length; d++) {
      const b = bounds[d], dayNum = String(d + 1).padStart(2, "0"), name = `day_${dayNum}.txt`;
      setSelProgress({ show: true, pct: Math.round((d - from + 2) / (to - from + 1) * 80) + 10, lbl: `Adding ${name}...` });
      zip.file(name, theFile.slice(b.startByte, b.endByte));
      await tick();
    }
    setSelProgress({ show: true, pct: 90, lbl: "Building ZIP..." });
    const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } }, m => setSelProgress(p => ({ ...p, pct: 90 + m.percent * 0.1 })));
    dlFile(URL.createObjectURL(zipBlob), zipName);
    setSelProgress({ show: true, pct: 100, lbl: "Done! ZIP downloaded." });
    setSelNote(`${to - from + 1} files in ${zipName}`);
  }

  async function doDownloadRemaining() {
    if (!theFile || remainingValues === 0) return;
    setRemainProgress({ show: true, lbl: "Finding remaining data..." });
    if (completeDays === 0) {
      dlFile(URL.createObjectURL(theFile), "remaining_data.txt");
      setRemainProgress({ show: false, lbl: "" });
      setRemainNote(`Downloaded: remaining_data.txt (${fmtNum(remainingValues)} values)`);
      return;
    }
    const targetLines = completeDays * vpd;
    const CHUNK = 2 * 1024 * 1024;
    let offset = 0, leftover = "", counted = 0, foundByte = -1, leftoverByteLen = 0;
    while (foundByte === -1 && offset < theFile.size) {
      const buf = await theFile.slice(offset, offset + CHUNK).arrayBuffer();
      let text = "";
      try { text = new TextDecoder(encoding).decode(buf).replace(/^\uFEFF/, "").replace(/\u0000/g, ""); }
      catch { const b = new Uint8Array(buf); text = b.map(x => ((x >= 45 && x <= 57) || x === 10 || x === 13 || x === 43) ? String.fromCharCode(x) : "\n").join(""); }
      const combined = leftover + text, lines = combined.split(/\r?\n|\r/);
      leftover = lines.pop() || "";
      const bytesPerChar = buf.byteLength / (text.length || 1);
      let charPos = 0;
      for (const line of lines) {
        const t = line.trim(), lineLen = line.length + 1;
        if (t && /^[+-]?\d+(\.\d+)?$/.test(t)) {
          counted++;
          if (counted === targetLines) { foundByte = Math.min(offset + Math.round((charPos + lineLen - leftoverByteLen / bytesPerChar) * bytesPerChar), theFile.size); break; }
        }
        charPos += lineLen;
      }
      leftoverByteLen = new TextEncoder().encode(leftover).length;
      offset += CHUNK;
      await tick();
    }
    if (foundByte === -1) foundByte = theFile.size;
    const blob = theFile.slice(foundByte, theFile.size);
    if (blob.size === 0) { alert("No remaining data bytes found."); setRemainProgress({ show: false, lbl: "" }); return; }
    dlFile(URL.createObjectURL(blob), "remaining_data.txt");
    setRemainProgress({ show: false, lbl: "" });
    setRemainNote(`Downloaded: remaining_data.txt (${fmtNum(remainingValues)} values)`);
  }

  async function doConvertEDF() {
    if (!theFile) return;
    const hz = Math.round(vpd / 86400), sampPerRec = hz;
    setEdfProgress({ show: true, pct: 0, lbl: "Pass 1/2: Scanning min/max..." });
    const { mn: physMin, mx: physMax, count: n } = await edfPass1(theFile, encoding, pct => setEdfProgress(p => ({ ...p, pct: pct * 0.45, lbl: `Pass 1/2: Scanning range... ${pct}%` })));
    if (n === 0) { alert("No values found."); setEdfProgress({ show: false, pct: 0, lbl: "" }); return; }
    const digMin = -32768, digMax = 32767;
    const gain = (physMax - physMin) / (digMax - digMin) || 1;
    const scaleOffset = physMin - gain * digMin;
    const numRecs = Math.ceil(n / sampPerRec), numSig = 1, hdrBytes = 256 + numSig * 256;
    const pad = (s, len) => { s = String(s); while (s.length < len) s += " "; return s.substring(0, len); };
    let dd, mm2, yy, hh, mi, ss;
    if (edfMode === "with" && metaStart) {
      const p = metaStart.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (p) { dd = p[3]; mm2 = p[2]; yy = p[1].slice(-2); hh = p[4]; mi = p[5]; ss = p[6] || "00"; }
    }
    if (!dd) { const now = new Date(); dd = String(now.getDate()).padStart(2, "0"); mm2 = String(now.getMonth() + 1).padStart(2, "0"); yy = String(now.getFullYear()).slice(-2); hh = String(now.getHours()).padStart(2, "0"); mi = String(now.getMinutes()).padStart(2, "0"); ss = String(now.getSeconds()).padStart(2, "0"); }
    let patientField = "Unknown X X Unknown", recordingField = "ECG Study";
    if (edfMode === "with") {
      const pname = (metaName.trim() || "Unknown").replace(/ /g, "_");
      const psex = metaSex || "X";
      const recAdd = (metaRecAdd.trim() || "Converted_from_TXT").replace(/ /g, "_");
      const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      const sdate = `${dd}-${months[parseInt(mm2) - 1]}-20${yy}`;
      patientField = `X ${psex} X ${pname}`;
      recordingField = `Startdate ${sdate} X X ${recAdd}`;
    }
    const hdr = pad("0",8)+pad(patientField,80)+pad(recordingField,80)+pad(`${dd}.${mm2}.${yy}`,8)+pad(`${hh}.${mi}.${ss}`,8)+pad(hdrBytes,8)+pad("",44)+pad(numRecs,8)+pad("1",8)+pad(numSig,4)+pad("ECG",16)+pad("AgAgCl electrode",80)+pad("mV",8)+pad(physMin.toFixed(1),8)+pad(physMax.toFixed(1),8)+pad(digMin,8)+pad(digMax,8)+pad("",80)+pad(sampPerRec,8)+pad("",32);
    const hdrArr = new Uint8Array(hdrBytes);
    for (let i = 0; i < hdr.length && i < hdrBytes; i++) hdrArr[i] = hdr.charCodeAt(i) & 0xFF;
    setEdfProgress({ show: true, pct: 50, lbl: "Pass 2/2: Writing EDF data..." });
    const edfParts = [hdrArr.buffer];
    await edfPass2(theFile, encoding, sampPerRec, gain, scaleOffset, 3600,
      pct => setEdfProgress(p => ({ ...p, pct: 50 + pct * 0.48, lbl: `Pass 2/2: Writing EDF... ${pct}%` })),
      buf => edfParts.push(buf)
    );
    setEdfProgress({ show: true, pct: 99, lbl: "Assembling EDF file..." });
    await tick();
    const edfBlob = new Blob(edfParts, { type: "application/octet-stream" });
    dlFile(URL.createObjectURL(edfBlob), "ecg_study.edf");
    setEdfProgress({ show: true, pct: 100, lbl: "Done! EDF downloaded." });
    setEdfNote(`EDF: ${(edfBlob.size / 1048576).toFixed(1)} MB -- ${fmtNum(n)} samples -- ${numRecs} records at ${hz} Hz`);
  }

  function viewInLiveECG() {
    if (!theFile) return;
    navigate("/graph", { state: { files: [theFile] } });
  }

  function addMergeFiles(list) {
    const arr = Array.from(list);
    setMergeFiles(prev => {
      const existing = new Set(prev.map(m => m.name));
      const newFiles = arr.filter(f => !existing.has(f.name)).map(f => ({ file: f, name: f.name, size: f.size, selected: true }));
      return [...prev, ...newFiles];
    });
  }
  function toggleMerge(idx) { setMergeFiles(prev => prev.map((m, i) => i === idx ? { ...m, selected: !m.selected } : m)); }
  function removeMerge(idx) { setMergeFiles(prev => prev.filter((_, i) => i !== idx)); }

  // ── Merger with validation ──
  async function doMerge() {
    const sel = mergeFiles.filter(m => m.selected);
    if (!sel.length) return;

    // ✅ Validation: at least 2 files required
    if (sel.length < 2) {
      alert("Please upload at least 2 files to merge.\nMerging a single file is not valid.");
      return;
    }

    let sorted = [...sel];
    if (mergeOrder === "az") sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (mergeOrder === "za") sorted.sort((a, b) => b.name.localeCompare(a.name));
    const outName = (mergeOutName.trim() || "merged") + ".txt";
    setMergeProgress({ show: true, pct: 0, lbl: "Starting merge..." });
    setMergeLog([`> Merging ${sorted.length} files into ${outName}`]);
    const parts = [], nl = new Blob(["\n"], { type: "text/plain" });
    for (let i = 0; i < sorted.length; i++) {
      setMergeProgress({ show: true, pct: Math.round((i + 1) / sorted.length * 90), lbl: `Adding ${sorted[i].name}...` });
      if (i > 0) parts.push(nl);
      parts.push(sorted[i].file);
      setMergeLog(prev => [...prev, `> Added: ${sorted[i].name} (${(sorted[i].size / 1048576).toFixed(1)} MB)`]);
      await tick();
    }
    const merged = new Blob(parts, { type: "text/plain" });
    const url = URL.createObjectURL(merged);
    setMergeProgress({ show: true, pct: 100, lbl: "Done!" });
    setMergeLog(prev => [...prev, `> Merged size: ${(merged.size / 1048576).toFixed(1)} MB`]);
    setMergeDlUrl(url); setMergeDlName(outName);
  }

  const mins = remainingValues > 0 ? Math.round(remainingValues / (vpd / 1440)) : 0;
  const selCount = mergeFiles.filter(m => m.selected).length;
  const totalMergeSize = mergeFiles.filter(m => m.selected).reduce((a, m) => a + m.size, 0);
  const endDate = calcEndDate();

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e14", color: "#e0eaf8", fontFamily: "'Syne', sans-serif", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
        .st-card{background:#161f2e;border:1px solid #1e2d42;border-radius:14px;padding:22px;margin-bottom:14px;}
        .st-btn{padding:10px 22px;border:none;border-radius:8px;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:#0a0e14;cursor:pointer;transition:all .2s;white-space:nowrap;}
        .st-btn:hover:not(:disabled){transform:translateY(-1px);opacity:.9;}
        .st-btn:disabled{opacity:.4;cursor:not-allowed;}
        .st-btn.cyan{background:#00e5ff;}
        .st-btn.green{background:#00ff88;}
        .st-btn.orange{background:#ff6b35;}
        .st-btn.purple{background:#a78bfa;}
        .st-btn.live{background:linear-gradient(135deg,#00ff88,#00e5ff);font-size:14px;padding:12px 28px;}
        .st-input{background:#111822;border:1px solid #1e2d42;border-radius:8px;padding:8px 12px;color:#e0eaf8;font-family:'Space Mono',monospace;font-size:12px;outline:none;}
        .st-input:focus{border-color:#a78bfa;}
        .st-prog-bar{height:4px;background:#111822;border-radius:4px;overflow:hidden;margin-bottom:6px;}
        .st-prog-fill{height:100%;background:linear-gradient(90deg,#00e5ff,#00ff88);border-radius:4px;transition:width .4s;}
        .st-prog-lbl{font-family:'Space Mono',monospace;font-size:11px;color:#5a7a9a;}
        .st-tab{font-family:'Syne',sans-serif;font-size:13px;font-weight:700;padding:10px 24px;border:1px solid #1e2d42;border-bottom:none;border-radius:10px 10px 0 0;background:#111822;color:#5a7a9a;cursor:pointer;transition:all .2s;}
        .st-tab:hover:not(.active){color:#e0eaf8;background:#161f2e;}
        .st-tab.upload.active{background:#161f2e;color:#00e5ff;border-top:2px solid #00e5ff;}
        .st-tab.details.active{background:#161f2e;color:#00ff88;border-top:2px solid #00ff88;}
        .st-tab.merge.active{background:#161f2e;color:#a78bfa;border-top:2px solid #a78bfa;}
        .st-upload-zone{border:2px dashed #1e2d42;border-radius:16px;padding:60px 28px;text-align:center;cursor:pointer;transition:all .3s;background:#111822;}
        .st-upload-zone:hover,.st-upload-zone.over{border-color:#00e5ff;background:rgba(0,229,255,.03);}
        .st-meta-input{width:100%;background:#111822;border:1px solid #1e2d42;border-radius:8px;padding:8px 12px;color:#e0eaf8;font-family:'Space Mono',monospace;font-size:12px;outline:none;}
        .st-meta-input:focus{border-color:#a78bfa;}
        .st-meta-input.readonly{background:rgba(0,255,136,.04);border-color:rgba(0,255,136,.2);color:#00ff88;cursor:not-allowed;}
        input[type="datetime-local"]::-webkit-calendar-picker-indicator{filter:invert(0.6) sepia(1) saturate(3) hue-rotate(200deg);cursor:pointer;}
        .st-mfile{display:flex;align-items:center;gap:10px;background:#111822;border:1px solid #1e2d42;border-radius:10px;padding:10px 14px;margin-bottom:8px;font-family:'Space Mono',monospace;font-size:12px;transition:all .2s;}
        .st-mfile.sel{border-color:#00ff88;background:rgba(0,255,136,.04);}
        .st-chk{width:18px;height:18px;border:2px solid #1e2d42;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:900;}
        .st-chk.on{background:#00ff88;border-color:#00ff88;color:#0a0e14;}
      `}</style>

      {/* HERO */}
      <div style={{ textAlign: "center", padding: "36px 20px 24px" }}>
        <h2 style={{ fontSize: "clamp(24px,4vw,42px)", fontWeight: 800, letterSpacing: -2, background: "linear-gradient(135deg,#e0eaf8 40%,#00e5ff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 8 }}>
          ECG Signal Segmentation Engine
        </h2>
        <p style={{ color: "#5a7a9a", fontFamily: "'Space Mono',monospace", fontSize: 13 }}>Upload your ECG text file to get started</p>
      </div>

      {/* STATS */}
      <div style={{ maxWidth: 1100, margin: "0 auto 24px", padding: "0 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 2, background: "#1e2d42", borderRadius: 14, overflow: "hidden" }}>
          {[["15K","Values / Min"],["9L","Values / Hour"],["1.6Cr","Values / Day"],[theFile ? fmtCr(totalValues) : "--","Total Detected"]].map(([val, lbl]) => (
            <div key={lbl} style={{ background: "#111822", padding: "16px 18px", textAlign: "center" }}>
              <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 18, fontWeight: 700, color: "#00e5ff", display: "block" }}>{val}</span>
              <div style={{ fontSize: 10, color: "#5a7a9a", letterSpacing: 1, textTransform: "uppercase", marginTop: 3 }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* TABS */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button className={`st-tab upload ${activeTab === "upload" ? "active" : ""}`} onClick={() => setActiveTab("upload")}>Upload</button>
          {theFile && <button className={`st-tab details ${activeTab === "details" ? "active" : ""}`} onClick={() => setActiveTab("details")}>File Details</button>}
          <button className={`st-tab merge ${activeTab === "merge" ? "active" : ""}`} onClick={() => setActiveTab("merge")}>Merger</button>
        </div>
        <div style={{ borderTop: "1px solid #1e2d42" }} />
      </div>

      {/* CONTENT */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 0" }}>

        {/* UPLOAD TAB */}
        {activeTab === "upload" && (
          <>
            <div
              className={`st-upload-zone${dragRef.current ? " over" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); dragRef.current = true; }}
              onDragLeave={() => { dragRef.current = false; }}
              onDrop={e => { e.preventDefault(); dragRef.current = false; if (e.dataTransfer.files[0]) startLoad(e.dataTransfer.files[0]); }}
            >
              <input ref={fileInputRef} type="file" accept=".txt,.csv,.dat" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) startLoad(e.target.files[0]); }} />
              <div style={{ width: 64, height: 64, margin: "0 auto 16px", background: "rgba(0,229,255,.08)", border: "1px solid rgba(0,229,255,.15)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Drop ECG Text File Here</h3>
              <p style={{ color: "#5a7a9a", fontFamily: "'Space Mono',monospace", fontSize: 13 }}>One number per line &nbsp;(.txt / .csv / .dat)</p>
            </div>
            {scanning && (
              <div style={{ background: "#161f2e", border: "1px solid rgba(0,229,255,.2)", borderRadius: 12, padding: "18px 22px", marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontFamily: "'Space Mono',monospace", fontSize: 12 }}>
                  <span style={{ color: "#00e5ff" }}>Scanning... {scanPct}%</span>
                  <span style={{ color: "#00ff88" }}>{fmtNum(scanCount)} values</span>
                </div>
                <div style={{ height: 5, background: "#111822", borderRadius: 5, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${scanPct}%`, background: "linear-gradient(90deg,#00e5ff,#00ff88)", transition: "width .3s" }} />
                </div>
              </div>
            )}
          </>
        )}

        {/* DETAILS TAB */}
        {activeTab === "details" && theFile && (
          <>
            <div style={{ marginBottom: 20, textAlign: "center" }}>
              <button className="st-btn live" onClick={viewInLiveECG}>▶ View in Live ECG</button>
              <p style={{ fontFamily: "'Space Mono',monospace", fontSize: 10, color: "#5a7a9a", marginTop: 8 }}>Opens the ECG graph viewer with this file</p>
            </div>

            <div className="st-card">
              <div style={{ fontSize: 16, fontWeight: 800, color: "#00e5ff", marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                File Details
              </div>
              {[
                ["File Name", theFile.name, "#00e5ff"],
                ["Total Values", fmtNum(totalValues), "#e0eaf8"],
                ["Complete Days", `${completeDays} day(s)`, "#00ff88"],
                ["Remaining Values", remainingValues > 0 ? `${fmtNum(remainingValues)} (~${mins} minutes)` : "None", remainingValues > 0 ? "#ff6b35" : "#5a7a9a"],
              ].map(([lbl, val, clr]) => (
                <div key={lbl} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #1e2d42" }}>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, color: "#5a7a9a" }}>{lbl}</span>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, fontWeight: 700, color: clr }}>{val}</span>
                </div>
              ))}
            </div>

            <div className="st-card">
              <div style={{ fontSize: 15, fontWeight: 800, color: "#00e5ff", marginBottom: 4 }}>Split Into Day Files</div>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginBottom: 16 }}>Downloads each day as a separate file ({fmtNum(vpd)} values per day).</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a" }}>Days:</span>
                <input className="st-input" type="number" value={splitDays} min={1} max={365} style={{ width: 65 }} onChange={e => setSplitDays(parseInt(e.target.value) || 1)} />
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a" }}>Rate:</span>
                <select className="st-input" style={{ width: 160 }} onChange={e => onRateChange(e.target.value)}>
                  <option value="21600000">250 Hz</option>
                  <option value="25920000">300 Hz</option>
                  <option value="17280000">200 Hz</option>
                </select>
                <button className="st-btn cyan" onClick={doSplitAll}>Split All Days &amp; Download</button>
              </div>
              {splitProgress.show && (
                <div style={{ marginTop: 12 }}>
                  <div className="st-prog-bar"><div className="st-prog-fill" style={{ width: `${splitProgress.pct}%` }} /></div>
                  <div className="st-prog-lbl">{splitProgress.lbl}</div>
                </div>
              )}
              {splitNote && <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#00ff88", marginTop: 10 }}>{splitNote}</div>}
            </div>

            <div className="st-card">
              <div style={{ fontSize: 15, fontWeight: 800, color: "#00ff88", marginBottom: 4 }}>Select Days to Download</div>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginBottom: 16 }}>Pick which days you want.</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a" }}>From Day</span>
                <input className="st-input" type="number" value={fromDay} min={1} max={completeDays || 1} style={{ width: 75 }} onChange={e => { setFromDay(parseInt(e.target.value) || 1); setSelNote(`Will download files -- Day ${e.target.value} to Day ${toDay}`); }} />
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a" }}>To Day</span>
                <input className="st-input" type="number" value={toDay} min={1} max={completeDays || 1} style={{ width: 75 }} onChange={e => { setToDay(parseInt(e.target.value) || 1); setSelNote(`Will download files -- Day ${fromDay} to Day ${e.target.value}`); }} />
                <button className="st-btn green" onClick={doDownloadSelectedDays}>Download Selected Days</button>
              </div>
              {selProgress.show && (
                <div style={{ marginTop: 12 }}>
                  <div className="st-prog-bar"><div className="st-prog-fill" style={{ width: `${selProgress.pct}%` }} /></div>
                  <div className="st-prog-lbl">{selProgress.lbl}</div>
                </div>
              )}
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginTop: 10 }}>{selNote}</div>
            </div>

            {remainingValues > 0 && (
              <div className="st-card">
                <div style={{ fontSize: 15, fontWeight: 800, color: "#ff6b35", marginBottom: 4 }}>Download Remaining Data</div>
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginBottom: 16 }}>{fmtNum(remainingValues)} extra values (~{mins} minutes) that do not complete a full day.</div>
                <button className="st-btn orange" onClick={doDownloadRemaining} disabled={remainProgress.show}>{remainProgress.show ? "Processing..." : "Download Remaining"}</button>
                {remainNote && <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginTop: 10 }}>{remainNote}</div>}
              </div>
            )}

            <div className="st-card">
              <div style={{ fontSize: 15, fontWeight: 800, color: "#a78bfa", marginBottom: 4 }}>Convert Full File (TXT to EDF)</div>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginBottom: 16 }}>Convert the entire TXT file to EDF format and download.</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {["none", "with"].map(m => (
                  <button key={m} onClick={() => setEdfMode(m)} style={{ fontFamily: "'Syne',sans-serif", fontSize: 12, fontWeight: 700, padding: "8px 18px", border: "1px solid #1e2d42", borderRadius: 8, cursor: "pointer", transition: "all .2s", background: edfMode === m ? "#a78bfa" : "#111822", color: edfMode === m ? "#0a0e14" : "#5a7a9a" }}>
                    {m === "none" ? "Without Metadata" : "With Metadata"}
                  </button>
                ))}
              </div>
              {edfMode === "with" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                  <div>
                    <label style={{ display: "block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 5 }}>Patient Name</label>
                    <input type="text" placeholder="e.g. Praveen Kumar" value={metaName} onChange={e => setMetaName(e.target.value)} className="st-meta-input" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 5 }}>Sex</label>
                    <select value={metaSex} onChange={e => setMetaSex(e.target.value)} className="st-meta-input">
                      <option value="">Select</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 5 }}>Start Date &amp; Time</label>
                    <input type="datetime-local" step="1" value={metaStart} onChange={e => setMetaStart(e.target.value)} className="st-meta-input" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 5 }}>End Date &amp; Time <span style={{ color: "rgba(0,255,136,.5)", fontSize: 9, marginLeft: 4 }}>AUTO</span></label>
                    <input type="text" readOnly value={endDate} placeholder="Auto-calculated after upload" className="st-meta-input readonly" />
                  </div>
                  <div style={{ gridColumn: "span 2" }}>
                    <label style={{ display: "block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 5 }}>Recording Additional</label>
                    <input type="text" placeholder="e.g. Converted from TXT" value={metaRecAdd} onChange={e => setMetaRecAdd(e.target.value)} className="st-meta-input" />
                  </div>
                </div>
              )}
              <button className="st-btn purple" onClick={doConvertEDF}>Convert &amp; Download EDF</button>
              {edfProgress.show && (
                <div style={{ marginTop: 12 }}>
                  <div className="st-prog-bar"><div className="st-prog-fill" style={{ width: `${edfProgress.pct}%` }} /></div>
                  <div className="st-prog-lbl">{edfProgress.lbl}</div>
                </div>
              )}
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginTop: 10 }}>{edfNote}</div>
            </div>

            <button onClick={() => { setTheFile(null); setTotalValues(0); setActiveTab("upload"); }} style={{ background: "#111822", border: "1px solid #1e2d42", borderRadius: 10, padding: "11px 22px", fontFamily: "'Syne',sans-serif", fontSize: 13, fontWeight: 700, color: "#5a7a9a", cursor: "pointer", marginTop: 4 }}>
              Upload Another File
            </button>
          </>
        )}

        {/* MERGER TAB */}
        {activeTab === "merge" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <h2 style={{ fontSize: "clamp(22px,3vw,36px)", fontWeight: 800, letterSpacing: -1, background: "linear-gradient(135deg,#e0eaf8 40%,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 8 }}>ECG Strip Consolidator</h2>
              <p style={{ color: "#5a7a9a", fontFamily: "'Space Mono',monospace", fontSize: 13 }}>Upload day files, select which to combine, download as one merged file</p>
            </div>

            <div style={{ border: "2px dashed #1e2d42", borderRadius: 16, padding: "40px 28px", textAlign: "center", cursor: "pointer", background: "#111822", marginBottom: 14, transition: "all .3s" }}
              onClick={() => mergeInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); addMergeFiles(e.dataTransfer.files); }}>
              <input ref={mergeInputRef} type="file" accept=".txt,.csv,.dat" multiple style={{ display: "none" }} onChange={e => addMergeFiles(e.target.files)} />
              <div style={{ width: 52, height: 52, margin: "0 auto 12px", background: "rgba(167,139,250,.08)", border: "1px solid rgba(167,139,250,.15)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Drop Day Files Here</h3>
              <p style={{ color: "#5a7a9a", fontFamily: "'Space Mono',monospace", fontSize: 13 }}>Select multiple .txt files at once</p>
            </div>

            <div className="st-card">
              <div style={{ fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", fontFamily: "'Space Mono',monospace", marginBottom: 14 }}>Uploaded Files -- Select to Merge</div>
              {mergeFiles.length === 0
                ? <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a", textAlign: "center" }}>No files yet. Drop files above.</div>
                : <>
                  <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
                    <button onClick={() => setMergeFiles(p => p.map(m => ({ ...m, selected: true })))} style={{ background: "none", border: "1px solid #1e2d42", borderRadius: 6, color: "#5a7a9a", padding: "4px 12px", cursor: "pointer", fontSize: 11, fontFamily: "'Space Mono',monospace" }}>Select All</button>
                    <button onClick={() => setMergeFiles(p => p.map(m => ({ ...m, selected: false })))} style={{ background: "none", border: "1px solid #1e2d42", borderRadius: 6, color: "#5a7a9a", padding: "4px 12px", cursor: "pointer", fontSize: 11, fontFamily: "'Space Mono',monospace" }}>Deselect All</button>
                    <span style={{ marginLeft: "auto", color: "#a78bfa", fontFamily: "'Space Mono',monospace", fontSize: 12 }}>{selCount} selected</span>
                  </div>
                  {mergeFiles.map((mf, idx) => (
                    <div key={idx} className={`st-mfile${mf.selected ? " sel" : ""}`}>
                      <div className={`st-chk${mf.selected ? " on" : ""}`} onClick={() => toggleMerge(idx)}>{mf.selected ? "✓" : ""}</div>
                      <span style={{ color: "#00e5ff", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mf.name}</span>
                      <span style={{ color: "#5a7a9a", fontSize: 11 }}>{(mf.size / 1048576).toFixed(1)} MB</span>
                      <button onClick={() => removeMerge(idx)} style={{ background: "none", border: "none", color: "#5a7a9a", cursor: "pointer", fontSize: 14 }}>×</button>
                    </div>
                  ))}
                </>
              }
            </div>

            {selCount > 0 && (
              <div style={{ background: "rgba(0,255,136,.06)", border: "1px solid rgba(0,255,136,.18)", borderRadius: 10, padding: "14px 18px", marginBottom: 14, fontFamily: "'Space Mono',monospace", fontSize: 12 }}>
                {[["Files selected", selCount], ["Total size", `${(totalMergeSize / 1048576).toFixed(1)} MB`], ["Output", `${mergeOutName.trim() || "merged"}.txt`]].map(([l, v]) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: "#5a7a9a" }}>{l}</span><span style={{ color: "#00ff88", fontWeight: 700 }}>{v}</span></div>
                ))}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              <div className="st-card" style={{ margin: 0 }}>
                <label style={{ display: "block", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 7, fontFamily: "'Space Mono',monospace" }}>Output File Name</label>
                <input className="st-input" style={{ width: "100%" }} value={mergeOutName} onChange={e => setMergeOutName(e.target.value)} maxLength={40} />
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", marginTop: 5 }}>Saves as <strong style={{ color: "#a78bfa" }}>{mergeOutName.trim() || "merged"}.txt</strong></div>
              </div>
              <div className="st-card" style={{ margin: 0 }}>
                <label style={{ display: "block", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", marginBottom: 7, fontFamily: "'Space Mono',monospace" }}>Merge Order</label>
                <select className="st-input" style={{ width: "100%", appearance: "none" }} value={mergeOrder} onChange={e => setMergeOrder(e.target.value)}>
                  <option value="keep">Keep upload order</option>
                  <option value="az">Sort A to Z</option>
                  <option value="za">Sort Z to A</option>
                </select>
              </div>
            </div>

            {/* ✅ Merge button — disabled when less than 2 files selected */}
            <button
              disabled={selCount < 2}
              onClick={doMerge}
              style={{ width: "100%", padding: 15, border: "none", borderRadius: 12, fontFamily: "'Syne',sans-serif", fontSize: 15, fontWeight: 800, cursor: selCount < 2 ? "not-allowed" : "pointer", opacity: selCount < 2 ? 0.35 : 1, background: "linear-gradient(135deg,#a78bfa,#00b4d8)", color: "#0a0e14", marginBottom: 8 }}>
              Merge Selected Files
            </button>

            {/* ✅ Warning message when exactly 1 file is selected */}
            {selCount === 1 && (
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#ff6b35", textAlign: "center", marginBottom: 12 }}>
                ⚠ Select at least 2 files to merge
              </div>
            )}

            {mergeProgress.show && (
              <div className="st-card">
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: "#5a7a9a" }}>{mergeProgress.lbl}</span>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, fontWeight: 700, color: "#a78bfa" }}>{mergeProgress.pct}%</span>
                </div>
                <div style={{ height: 4, background: "#111822", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
                  <div style={{ height: "100%", width: `${mergeProgress.pct}%`, background: "linear-gradient(90deg,#a78bfa,#00b4d8)", transition: "width .3s" }} />
                </div>
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: "#5a7a9a", maxHeight: 80, overflowY: "auto", lineHeight: 1.9 }}>
                  {mergeLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}

            {mergeDlUrl && (
              <div>
                <div style={{ fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase", color: "#5a7a9a", fontFamily: "'Space Mono',monospace", marginBottom: 10 }}>Merged File Ready</div>
                <button onClick={() => dlFile(mergeDlUrl, mergeDlName)} style={{ background: "#111822", border: "1px solid #1e2d42", borderRadius: 10, padding: "11px 14px", color: "#e0eaf8", fontFamily: "'Space Mono',monospace", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                  ⬇ Download {mergeDlName}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}