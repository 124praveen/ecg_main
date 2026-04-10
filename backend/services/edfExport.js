/**
 * EDF Export Service — Converts stored ECG chunks into EDF (European Data Format).
 *
 * ── EDF Format Overview ─────────────────────────────────────────────
 * EDF is the standard interchange format for physiological signals.
 * Structure:
 *   [Header — fixed-length ASCII fields]
 *   [Data Records — each contains N samples as 16-bit signed integers]
 *
 * Header layout (all fields are space-padded ASCII strings):
 *   256 bytes  → General header (patient, recording, date, etc.)
 *   256 bytes  → Per-signal header (label, units, scaling, etc.)
 *                (256 bytes × number of signals)
 *
 * Data records:
 *   Each record covers a fixed duration (e.g., 1 second).
 *   Samples are stored as Int16 little-endian (-32768 to 32767).
 *   Physical values are reconstructed using:
 *     physical = (digital - digMin) / (digMax - digMin) * (physMax - physMin) + physMin
 *
 * ── Common mistakes ────────────────────────────────────────────────
 *   - Wrong header field lengths → corrupted file, won't open in viewers
 *   - Not padding fields with spaces → off-by-one in header parsing
 *   - Using wrong byte order → garbled waveforms
 *   - Incorrect digital min/max → clipped or inverted signals
 * ────────────────────────────────────────────────────────────────────
 */

import fs from 'fs/promises';
import path from 'path';
import dataPipeline, { CHUNK_SIZE, DATA_DIR } from './dataPipeline.js';

// ─── Helper: pad or truncate a string to exact length ───────────────

function edfStr(value, length) {
  return String(value).padEnd(length).slice(0, length);
}

// ─── Helper: format date for EDF header ─────────────────────────────

function edfDate(isoString) {
  const d = new Date(isoString);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function edfTime(isoString) {
  const d = new Date(isoString);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}.${mm}.${ss}`;
}

// ─── Main Export Function ───────────────────────────────────────────

/**
 * Generate an EDF file from a completed (or active) study.
 *
 * @param {string} studyId — study identifier
 * @param {object} [opts]
 * @param {string} [opts.patientName='X']
 * @param {string} [opts.patientSex='']
 * @param {string} [opts.patientDob='']
 * @param {string} [opts.signalLabel='ECG']
 * @param {number} [opts.physicalMin=-5]     — in millivolts
 * @param {number} [opts.physicalMax=5]      — in millivolts
 * @param {string} [opts.physicalDimension='mV']
 * @returns {Promise<string>} path to generated EDF file
 */
async function exportToEdf(studyId, opts = {}) {
  const meta = await dataPipeline.getMeta(studyId);
  const studyDir = path.join(DATA_DIR, studyId);

  const {
    patientName = meta.patientName || 'X',
    patientSex = '',
    patientDob = '',
    signalLabel = 'ECG',
    physicalMin = -5,
    physicalMax = 5,
    physicalDimension = 'mV',
  } = opts;

  const sampleRate = meta.sampleRate;
  const numSignals = 1;
  const dataRecordDuration = 1; // 1 second per data record
  const samplesPerRecord = sampleRate * dataRecordDuration;
  const totalSamples = meta.totalSamples;
  const numDataRecords = Math.ceil(totalSamples / samplesPerRecord);

  const digitalMin = -32768;
  const digitalMax = 32767;

  // ── Build header ─────────────────────────────────────────────────

  const headerSize = 256 + 256 * numSignals;

  let header = '';

  // General header (256 bytes)
  header += edfStr('0', 8);                                            // version
  header += edfStr(`${patientName} ${patientSex} ${patientDob}`, 80);  // patient
  header += edfStr('ECG Live Studio', 80);                             // recording
  header += edfStr(edfDate(meta.startTime), 8);                        // start date
  header += edfStr(edfTime(meta.startTime), 8);                        // start time
  header += edfStr(headerSize, 8);                                     // header bytes
  header += edfStr('EDF+C', 44);                                      // reserved (EDF+C = continuous)
  header += edfStr(numDataRecords, 8);                                 // num data records
  header += edfStr(dataRecordDuration, 8);                             // record duration
  header += edfStr(numSignals, 4);                                     // num signals

  // Signal header (256 bytes per signal)
  header += edfStr(signalLabel, 16);           // label
  header += edfStr('', 80);                    // transducer type
  header += edfStr(physicalDimension, 8);      // physical dimension
  header += edfStr(physicalMin, 8);            // physical minimum
  header += edfStr(physicalMax, 8);            // physical maximum
  header += edfStr(digitalMin, 8);             // digital minimum
  header += edfStr(digitalMax, 8);             // digital maximum
  header += edfStr('', 80);                    // prefiltering
  header += edfStr(samplesPerRecord, 8);       // samples per record
  header += edfStr('', 32);                    // reserved

  const headerBuf = Buffer.from(header, 'ascii');

  // ── Build data records ───────────────────────────────────────────
  // Read all chunks and convert to 16-bit integers

  const allChunks = await dataPipeline.getChunks(studyId, 0, meta.totalChunks);

  // Scale factor: maps physical range to digital range
  const physRange = physicalMax - physicalMin;
  const digRange = digitalMax - digitalMin;

  // Allocate data buffer (2 bytes per sample × samplesPerRecord × numDataRecords)
  const dataSize = numDataRecords * samplesPerRecord * 2;
  const dataBuf = Buffer.alloc(dataSize);

  for (let rec = 0; rec < numDataRecords; rec++) {
    for (let s = 0; s < samplesPerRecord; s++) {
      const sampleIdx = rec * samplesPerRecord + s;
      const physValue =
        sampleIdx < allChunks.length ? allChunks[sampleIdx] : 0;

      // Clamp to physical range, then scale to digital
      const clamped = Math.max(physicalMin, Math.min(physicalMax, physValue));
      const digital = Math.round(
        ((clamped - physicalMin) / physRange) * digRange + digitalMin
      );

      // Write as 16-bit signed little-endian
      const byteOffset = (rec * samplesPerRecord + s) * 2;
      dataBuf.writeInt16LE(digital, byteOffset);
    }
  }

  // ── Write EDF file ───────────────────────────────────────────────

  const edfPath = path.join(studyDir, 'recording.edf');
  const finalBuf = Buffer.concat([headerBuf, dataBuf]);
  await fs.writeFile(edfPath, finalBuf);

  return edfPath;
}

export default exportToEdf;
