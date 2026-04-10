/**
 * BSE Decoder Service
 * Runs bsedecoder-2.0.0.jar on raw hex ECG data and returns decoded integer samples.
 *
 * JAR usage: java -jar bsedecoder-2.0.0.jar <inputFolderPath> <outputFilePath>
 * Input:  folder containing a hex file (raw block bytes as hex string)
 * Output: text file of decoded ECG values — first 6 lines are header, last line is footer (stripped)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JAR_PATH = path.join(__dirname, 'decompiler', 'bsedecoder-2.0.0.jar');

/**
 * Decode raw BSE hex data using the JAR decompiler.
 * @param {string} hexString - Raw block bytes as hex string (e.g. "88 82 43 11 ...")
 * @returns {Promise<number[]>} Decoded ECG integer samples
 */
export async function decodeBse(hexString, blockIndex = 0) {
  // The JAR is designed to process a FOLDER of fragment files together.
  // It reads ALL fragment_000000.bin, fragment_000001.bin, etc. sorted
  // by name and decodes the complete study in one pass.
  // We maintain a persistent session folder per study and add one new
  // fragment file per block. Each call adds the latest block and
  // re-runs the JAR on the full folder to get all samples so far.

  const cleanHex = hexString.replace(/\s+/g, '');
  const totalBytes = cleanHex.length / 2;
  const randomKey    = `bse_session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpBase      = path.join(os.tmpdir(), randomKey);
  const inputFolder  = path.join(tmpBase, 'input');
  const outputFolder = path.join(tmpBase, 'output');
  const outputFile   = path.join(outputFolder, 'result.txt');

  try {
    await fs.promises.mkdir(inputFolder,  { recursive: true });
    await fs.promises.mkdir(outputFolder, { recursive: true });

    if (totalBytes < 8192) {
      console.log(`[bseDecoder] Need at least 8192 bytes — skipping (have ${totalBytes})`);
      return [];
    }

    const allBinary = Buffer.from(cleanHex, 'hex');
    const inputFile = path.join(inputFolder, 'fragment_000000.bin');
    await fs.promises.writeFile(inputFile, allBinary);

    console.log(`[bseDecoder] Running JAR on ${totalBytes} bytes as single file`);

    const { stdout, stderr } = await execAsync(
      `java -jar "${JAR_PATH}" "${inputFolder}" "${outputFile}"`
    );
    if (stdout) console.log(`[bseDecoder] JAR stdout:`, stdout);
    if (stderr) console.log(`[bseDecoder] JAR stderr:`, stderr);

    // Resolve output file
    let readPath = outputFile;
    const outStat = await fs.promises.stat(outputFile).catch(() => null);
    if (!outStat) {
      const outFolderFiles = await fs.promises.readdir(outputFolder).catch(() => []);
      if (outFolderFiles.length > 0) {
        readPath = path.join(outputFolder, outFolderFiles[0]);
      } else {
        throw new Error(`JAR produced no output for ${totalBytes} bytes`);
      }
    }

    const rawContent = await fs.promises.readFile(readPath, 'utf8');
    const allLines   = rawContent.split(/\r?\n/);
    const dataLines  = allLines.slice(6);
    const samples    = dataLines
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => parseInt(l, 10))
      .filter(n => !isNaN(n));

    console.log(`[bseDecoder] ${totalBytes} bytes → ${samples.length} total samples`);
    return samples;

  } finally {
    fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}
