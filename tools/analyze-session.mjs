#!/usr/bin/env node
/**
 * analyze-session — Claude's ears. Reads a session journal (the score) and
 * reports what the music actually did: density, balance, velocity, harmony,
 * sourness, and every parameter the human tuned along the way.
 *
 *   node tools/analyze-session.mjs                 # newest session
 *   node tools/analyze-session.mjs <path.jsonl>    # specific session
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

const MELODY = new Set(['rhodes', 'pulse', 'saw', 'kalimba', 'osc']);
const DRUMS = new Set(['kick', 'snare', 'ckick', 'csnare', 'rkick', 'gsnare', 'shaker', 'rim', 'hat', 'scratch']);
const DIA = [0, 2, 4, 5, 7, 9, 11];
const PCN = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

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

const dur = events.reduce((m, e) => Math.max(m, e.t || 0), 0);
const byVoice = {};
for (const e of events) byVoice[e.e] = (byVoice[e.e] || 0) + 1;

/* --- the tuning story: every param change, in order --- */
const tunes = events.filter(e => e.e === 'set')
  .map(e => `${Math.round(e.t)}s ${e.k}=${e.val}`);

/* --- melodic analysis --- */
let key = header ? header.key : 0;
const melodic = events.filter(e => (MELODY.has(e.e) || e.e === 'claude') && typeof e.m === 'number');
const pcHist = new Array(12).fill(0);
for (const e of melodic) pcHist[((e.m % 12) + 12) % 12]++;
const diaSet = new Set(DIA.map(pc => (pc + key) % 12));
const outOfKey = melodic.filter(e => !diaSet.has(((e.m % 12) + 12) % 12)).length;

/* --- sourness: melodic pairs within 130ms at a semitone / flat-nine --- */
const sorted = [...melodic].sort((a, b) => a.t - b.t);
let clashes = 0;
const clashSamples = [];
for (let i = 0; i < sorted.length; i++) {
  for (let j = i + 1; j < sorted.length && sorted[j].t - sorted[i].t < 0.13; j++) {
    const iv = Math.abs(sorted[i].m - sorted[j].m) % 12;
    if (iv === 1 || iv === 11) {
      clashes++;
      if (clashSamples.length < 5) {
        clashSamples.push(`${Math.round(sorted[i].t)}s ${PCN[sorted[i].m % 12]}${sorted[i].e}+${PCN[sorted[j].m % 12]}${sorted[j].e}`);
      }
    }
  }
}

/* --- density over time (melody notes per active minute) --- */
const perMin = {};
for (const e of melodic) {
  const b = Math.floor(e.t / 60);
  perMin[b] = (perMin[b] || 0) + 1;
}
const activeMins = Object.values(perMin);
const densityLine = Object.entries(perMin).slice(0, 40)
  .map(([m, n]) => n > 120 ? '█' : n > 60 ? '▓' : n > 20 ? '▒' : '░').join('');

/* --- velocity stats per group --- */
function velStats(list) {
  if (!list.length) return null;
  const vs = list.map(e => e.v || 0).sort((a, b) => a - b);
  return {
    n: vs.length,
    med: vs[Math.floor(vs.length / 2)],
    p90: vs[Math.floor(vs.length * 0.9)],
  };
}

const report = {
  file: path.basename(file),
  header,
  duration: `${Math.round(dur / 60)}m ${Math.round(dur % 60)}s`,
  totalEvents: events.length,
  byVoice,
  paramTunes: tunes,
  melody: {
    notes: melodic.length,
    perActiveMinute: activeMins.length
      ? Math.round(melodic.length / activeMins.length) : 0,
    peakMinute: Math.max(0, ...activeMins),
    velocity: velStats(sorted.filter(e => MELODY.has(e.e))),
    claudeVelocity: velStats(sorted.filter(e => e.e === 'claude' || e.c === 1)),
    claudeShare: melodic.length
      ? Math.round(100 * sorted.filter(e => e.e === 'claude' || e.c === 1).length / melodic.length) + '%' : '0%',
  },
  harmony: {
    key: PCN[key],
    pitchClassTop: pcHist.map((n, pc) => [PCN[pc], n]).sort((a, b) => b[1] - a[1]).slice(0, 6),
    outOfKeyPct: melodic.length ? Math.round(100 * outOfKey / melodic.length) + '%' : '0%',
    semitoneClashes: clashes,
    clashesPerMinute: dur ? Math.round(10 * clashes / (dur / 60)) / 10 : 0,
    clashSamples,
  },
  densityMap: densityLine + ' (per minute: ░<20 ▒<60 ▓<120 █≥120 melodic notes)',
};

console.log(JSON.stringify(report, null, 2));
