#!/usr/bin/env node
/**
 * journal2midi — export a session journal (the score) as a standard MIDI file.
 * Open it in GarageBand/Logic/Ableton, or hand it to anything that reads SMF.
 *
 *   node tools/journal2midi.mjs                    # newest session
 *   node tools/journal2midi.mjs <path.jsonl>       # specific session
 *
 * Tracks: melody (EP), claude (music box), bass, harmony (stabs/pads), drums.
 * Tempo is the session's base bpm; mid-session style/tempo switches are noted
 * but the tick math uses one tempo (good enough for a re-arrangement source).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESS_DIR = path.join(os.homedir(), '.keystrokes', 'sessions');
let file = process.argv[2];
if (!file) {
  const all = fs.readdirSync(SESS_DIR).filter(f => f.endsWith('.jsonl')).sort();
  file = path.join(SESS_DIR, all[all.length - 1]);
}

let header = null;
const events = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const o = JSON.parse(line);
    if (o.e === 'hdr') header = o;
    else events.push(o);
  } catch { /* skip */ }
}
const bpm = (header && header.bpm) || 76;
const TPQ = 480;
const toTicks = s => Math.max(0, Math.round(s * (bpm / 60) * TPQ));

const MELODY = new Set(['rhodes', 'pulse', 'saw', 'kalimba', 'osc']);
const DRUM_NOTE = { kick: 36, ckick: 36, rkick: 36, snare: 38, csnare: 38, gsnare: 38,
                    rim: 37, shaker: 70, scratch: 39 };
const DUR_S = { rhodes: 0.5, pulse: 0.2, saw: 0.4, kalimba: 0.6, osc: 0.45,
                claude: 0.5, stab: 1.2, bass: 0.5 };

/* track builders: collect {tick, bytes} then sort + delta-encode */
function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
function makeTrack(msgs, name, program, ch) {
  const evts = [];
  const push = (tick, ...bytes) => evts.push({ tick, bytes });
  push(0, 0xff, 0x03, name.length, ...[...name].map(c => c.charCodeAt(0)));
  if (program !== null) push(0, 0xc0 | ch, program);
  for (const m of msgs) {
    const vel = Math.min(127, Math.max(1, Math.round((m.v ?? 0.5) * 127)));
    push(m.on, 0x90 | ch, m.note, vel);
    push(m.off, 0x80 | ch, m.note, 0);
  }
  evts.sort((a, b) => a.tick - b.tick);
  const bytes = [];
  let last = 0;
  for (const e of evts) {
    bytes.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  return bytes;
}

const tracks = { melody: [], claude: [], bass: [], harmony: [], drums: [] };
for (const ev of events) {
  if (typeof ev.t !== 'number') continue;
  const on = toTicks(ev.t);
  const durS = ev.e === 'pad' ? (ev.d || 4) : (DUR_S[ev.e] || 0.3);
  const off = on + Math.max(24, toTicks(durS) - toTicks(0));
  if (MELODY.has(ev.e) && typeof ev.m === 'number') {
    tracks.melody.push({ on, off: on + toTicks(durS), note: ev.m, v: ev.v });
  } else if (ev.e === 'claude' && typeof ev.m === 'number') {
    tracks.claude.push({ on, off: on + toTicks(durS), note: ev.m, v: ev.v });
  } else if (ev.e === 'bass' && typeof ev.m === 'number') {
    tracks.bass.push({ on, off: on + toTicks((ev.o && ev.o.dur) || 0.5), note: ev.m, v: ev.v });
  } else if (ev.e === 'stab' && typeof ev.m === 'number') {
    tracks.harmony.push({ on, off: on + toTicks(1.2), note: ev.m, v: ev.v });
  } else if (ev.e === 'pad' && Array.isArray(ev.vc)) {
    for (const m of ev.vc) tracks.harmony.push({ on, off: on + toTicks(ev.d || 4), note: m, v: 0.4 });
  } else if (ev.e === 'hat') {
    tracks.drums.push({ on, off: on + 30, note: ev.open ? 46 : 42, v: ev.v });
  } else if (DRUM_NOTE[ev.e]) {
    tracks.drums.push({ on, off: on + 40, note: DRUM_NOTE[ev.e], v: ev.v ?? 0.6 });
  }
}

/* tempo/meta track */
const usPerBeat = Math.round(60000000 / bpm);
const tempoTrack = [
  0x00, 0xff, 0x51, 0x03,
  (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff,
  0x00, 0xff, 0x2f, 0x00,
];

const built = [
  tempoTrack,
  makeTrack(tracks.melody, 'melody', 4, 0),     // Electric Piano 1
  makeTrack(tracks.claude, 'claude', 10, 1),    // Music Box
  makeTrack(tracks.bass, 'bass', 33, 2),        // Fingered Bass
  makeTrack(tracks.harmony, 'harmony', 4, 3),
  makeTrack(tracks.drums, 'drums', null, 9),    // GM drum channel
];

function chunk(tag, bytes) {
  const len = bytes.length;
  return Buffer.concat([
    Buffer.from(tag, 'ascii'),
    Buffer.from([(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]),
    Buffer.from(bytes),
  ]);
}
const headerChunk = chunk('MThd', [0, 1, 0, built.length, (TPQ >> 8) & 0xff, TPQ & 0xff]);
const out = Buffer.concat([headerChunk, ...built.map(t => chunk('MTrk', t))]);

const outPath = file.replace(/\.jsonl$/, '.mid');
fs.writeFileSync(outPath, out);
const counts = Object.fromEntries(Object.entries(tracks).map(([k, v]) => [k, v.length]));
console.log(`wrote ${outPath} (${out.length} bytes, bpm ${bpm})`);
console.log('notes per track:', JSON.stringify(counts));
