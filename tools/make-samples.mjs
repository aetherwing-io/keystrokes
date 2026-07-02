#!/usr/bin/env node
/**
 * make-samples — renders the keystrokes sample pack from source.
 *
 *   node tools/make-samples.mjs
 *
 * Writes samples/*.wav + samples/manifest.json. Everything is synthesized
 * here (FM electric piano in the DX7 tradition, designed boom-bap drums),
 * so the pack is reproducible and license-clean (it's ours, do what you
 * like with it). Swap any file for a real recording and update the
 * manifest — the engine doesn't care where a buffer came from.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const TAU = Math.PI * 2;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- wav writer (16-bit PCM mono) ---------- */
function writeWav(file, data, sampleRate) {
  // normalize handled by caller; clamp defensively
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, file), buf);
  return buf.length;
}
function normalize(data, peakTarget) {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) { const g = peakTarget / peak; for (let i = 0; i < data.length; i++) data[i] *= g; }
  return data;
}
/* one-pole helpers */
function highpass(data, sr, fc) {
  const a = 1 / (1 + TAU * fc / sr);
  const out = new Float64Array(data.length);
  let y = 0, xp = 0;
  for (let i = 0; i < data.length; i++) { y = a * (y + data[i] - xp); xp = data[i]; out[i] = y; }
  return out;
}
function lowpass(data, sr, fc) {
  const a = (TAU * fc / sr) / (1 + TAU * fc / sr);
  const out = new Float64Array(data.length);
  let y = 0;
  for (let i = 0; i < data.length; i++) { y += a * (data[i] - y); out[i] = y; }
  return out;
}

/* ---------- FM electric piano ---------- */
/* Two slightly detuned FM pairs (carrier:mod at 1:1, index decaying — the
   classic EP "wah"), a tine partial near 4x, and a soft key click. */
function renderRhodes(midi) {
  const sr = 22050;
  const f = mtof(midi);
  const ampTau = Math.max(0.7, Math.min(3.0, 1.0 + (69 - midi) * 0.045));
  const dur = Math.min(3.2, ampTau * 2.4);
  const n = Math.floor(sr * dur);
  const out = new Float64Array(n);

  const tineTau = 0.08 + ((84 - midi) / 48) * 0.14;
  const detunes = [-3, 3]; // cents — baked-in gentle chorus
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const amp = Math.exp(-t / ampTau);
    const idx = 1.35 * Math.exp(-t / 0.55) + 0.12;         // FM index: bark → warmth
    let s = 0;
    for (const c of detunes) {
      const fc = f * Math.pow(2, c / 1200);
      s += Math.sin(TAU * fc * t + idx * Math.sin(TAU * fc * t)) * 0.5;
    }
    s += Math.sin(TAU * f * 3.98 * t) * Math.exp(-t / tineTau) * 0.16;  // tine: felt, not rung
    out[i] = s * amp;
  }
  // key click: a soft 4ms thump, not a tick
  const clickN = Math.floor(sr * 0.004);
  for (let i = 0; i < clickN; i++) {
    out[i] += (Math.random() * 2 - 1) * 0.05 * (1 - i / clickN);
  }
  // final warmth: shave the zing off the whole note
  {
    let y = 0;
    const a = (TAU * 3600 / sr) / (1 + TAU * 3600 / sr);
    for (let i = 0; i < n; i++) { y += a * (out[i] - y); out[i] = y; }
  }
  // attack ramp + tail fade
  const aN = Math.floor(sr * 0.002);
  for (let i = 0; i < aN; i++) out[i] *= i / aN;
  const fN = Math.floor(sr * 0.12);
  for (let i = 0; i < fN; i++) out[n - 1 - i] *= i / fN;

  const tilt = 0.88 * (1 - (midi - 36) * 0.004);           // keep highs from shouting
  return { data: normalize(out, tilt), sr };
}

/* ---------- drums ---------- */
function renderKick() {
  const sr = 44100, dur = 0.4, n = Math.floor(sr * dur);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const freq = 42 + 53 * Math.exp(-t / 0.045);
    phase += TAU * freq / sr;
    out[i] = Math.sin(phase) * Math.exp(-t / 0.13);
  }
  const clickN = Math.floor(sr * 0.005);
  for (let i = 0; i < clickN; i++) out[i] += (Math.random() * 2 - 1) * 0.3 * (1 - i / clickN);
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.9) / Math.tanh(1.9);
  return { data: normalize(lowpass(out, sr, 7500), 0.95), sr };
}
function renderSnare() {
  const sr = 44100, dur = 0.3, n = Math.floor(sr * dur);
  const body = new Float64Array(n);
  let noise = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    body[i] = Math.sin(TAU * 176 * t) * Math.exp(-t / 0.05) * 0.6
            + Math.sin(TAU * 333 * t) * Math.exp(-t / 0.035) * 0.4;
    noise[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.095);
  }
  noise = highpass(noise, sr, 900);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.tanh((body[i] + noise[i] * 1.6) * 1.5) / Math.tanh(1.5);
  return { data: normalize(lowpass(out, sr, 8000), 0.9), sr };
}
function renderHat(open) {
  const sr = 44100, dur = open ? 0.5 : 0.08, tau = open ? 0.14 : 0.02;
  const n = Math.floor(sr * dur);
  const ratios = [2, 3.03, 4.16, 5.43, 6.79, 8.21];
  const phases = ratios.map(() => Math.random() * TAU);
  let out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let r = 0; r < ratios.length; r++) {
      s += Math.sign(Math.sin(TAU * 540 * ratios[r] * t + phases[r]));
    }
    out[i] = s / ratios.length * Math.exp(-t / tau);
  }
  out = highpass(highpass(out, sr, 6500), sr, 6500);
  const fN = Math.floor(sr * 0.01);
  for (let i = 0; i < fN; i++) out[n - 1 - i] *= i / fN;
  return { data: normalize(out, 0.7), sr };
}
function renderRim() {
  const sr = 44100, dur = 0.06, n = Math.floor(sr * dur);
  let noise = new Float64Array(n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(TAU * 1750 * t) * Math.exp(-t / 0.009) * 0.8;
    noise[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.004);
  }
  noise = highpass(noise, sr, 3000);
  for (let i = 0; i < n; i++) out[i] += noise[i] * 0.5;
  return { data: normalize(out, 0.75), sr };
}

/* ---------- render everything ---------- */
const manifest = { rhodes: {}, drums: {} };
let total = 0;

for (let midi = 36; midi <= 84; midi += 4) {
  const { data, sr } = renderRhodes(midi);
  const file = `rhodes-${String(midi).padStart(3, '0')}.wav`;
  total += writeWav(file, data, sr);
  manifest.rhodes[midi] = file;
}
const drums = {
  kick: renderKick(),
  snare: renderSnare(),
  hat: renderHat(false),
  hatopen: renderHat(true),
  rim: renderRim(),
};
for (const [name, { data, sr }] of Object.entries(drums)) {
  const file = `${name}.wav`;
  total += writeWav(file, data, sr);
  manifest.drums[name] = file;
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`rendered ${Object.keys(manifest.rhodes).length} rhodes notes + ${Object.keys(manifest.drums).length} drums`);
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB → ${OUT}`);
