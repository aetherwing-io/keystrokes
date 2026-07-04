/* keystrokes main — the live page wiring. Owns page state (style, key,
 * transport, activity), the lookahead scheduler, the keystroke and Claude
 * character sources, controls, recording, demo, and the viz. All actual
 * sound comes from the audio engine factory in core.js.
 */
import {
  STYLES, NOTE_NAMES, mtof, clamp,
  createAudioEngine, fetchSamplePack, makeSampler, decodeSamplerInto,
} from './core.js';
import { idbOpen, idbPutBatch, idbPrune } from './idb.js';

/* ---------- mapping constants (live derivation only) ---------- */
const DIA = [0, 2, 4, 5, 7, 9, 11];
const PENT = [0, 2, 4, 7, 9];
const FREQ = 'etaoinshrdlcumwfgypbvkjxqz';
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ROW_BASE = [76, 64, 59, 52];
const LEFT_HAND = new Set('12345qwertasdfgzxcvb');
const CADENCE = { '.': 0, ',': 7, '?': 14, '!': 12 };

/* ---------- state ---------- */
let STYLE = STYLES.lofi;
let SPB = 60 / STYLE.bpm;
let P16 = SPB / 4;

let engine = null;
let ctx = null, started = false, running = false;
let t0 = 0, slot = 0, tickTimer = null;
let keyOff = 0, drumsOn = true, claudeOn = true, mapping = 'geo';
let masterGain = null;
let msDest = null, recorder = null, recChunks = [];
let keyTimes = [], lastKeyAt = 0, lastWasBoundary = true, wordCharIdx = 0;
let lastCharNL = false;              // consecutive newlines = a paragraph break
let bsTimes = [];                    // recent backspaces: edit bursts drive the kit
let smoothedAct = 0;
let tapLive = false, lastClaudeAt = 0;
let claudeSymbolCount = 0, claudeBoundary = true, claudeWordIdx = 0, claudeLastNoteAt = 0;
let lastUserMidi = 0, lastUserNoteAt = 0;
let lastUserWasTension = false, lastClaudeMidi = 0, phraseNoteCount = 0;
let combo = 0, comboTier = 0, lastComboAt = 0;   // arcade typing streaks
let prevVoicing = null;

/* leitmotifs: recurring words become the session's theme (memory only — the
 * words themselves are never persisted or journaled, only their notes) */
let currentWord = '';
const wordCounts = new Map();
let motifs = [];
let motifIdx = 0, lastMotifBar = -4, motifGroup = 0;

function flushWord() {
  const w = currentWord;
  currentWord = '';
  if (w.length < 4) return;
  const c = (wordCounts.get(w) || 0) + 1;
  wordCounts.set(w, c);
  if (wordCounts.size > 500) {
    let minK = null, minV = Infinity;
    for (const [k, v] of wordCounts) if (v < minV) { minV = v; minK = k; }
    wordCounts.delete(minK);
  }
  if (c >= 4) {
    motifs = [...wordCounts.entries()]
      .filter(([, v]) => v >= 4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
  }
}
const claudeQueue = [];
const slotNotes = new Map();
const vizNotes = [];
let demoTimer = null;

/* voice bindings — destructured from the engine factory at init */
let rhodesNote, playPulse, playSawLead, playKalimba, playMelodyOsc, playClaude,
    playStabTone, playPadChord, bassHit,
    kickBoom, snareDust, hatTick, chipKick, chipSnare, retroKick, gatedSnare,
    shaker, playRim, playScratch;

/* arrangement state — the session has a shape, not just a loop */
const FT = new URLSearchParams(location.search).has('fasttest') ? 0.1 : 1;
let section = 'intro';               // intro|verse|build|chorus|break|outro|runout
let flowSince = 0;
let buildAtBar = -1, chorusStartBar = -1, chorusUntilBar = -1, cooldownUntilBar = -1;
let outroAtBar = -1;

/* the weave: the two melodic voices braid registers over time. Each voice
 * folds its notes toward a center; the centers mirror each other and cross
 * as the phase turns, so who sits on top — with the presence and brightness
 * that come with it — trades back and forth. The phase turns at phrase
 * boundaries (and every 8 bars regardless); the centers glide in tick().
 * The chorus pins you on top: that lift stays yours. */
let weavePhase = 0.9, lastWeaveBar = -2;
const weave = { you: 71.3, cl: 55.7, lead: 0.79 };   // matches phase 0.9
function weaveTargets() {
  if (section === 'chorus') return { you: 68, cl: 61, lead: 1 };   // you on top, claude tucked warm underneath
  const s = Math.sin(2 * Math.PI * weavePhase);
  return { you: 66 - 9 * s, cl: 61 + 9 * s, lead: 0.5 - 0.5 * s };
}
function advanceWeave(amt, force) {
  const bar = Math.floor(slot / 16);
  if (!force && bar - lastWeaveBar < 2) return;   // at most one turn per 2 bars
  lastWeaveBar = bar;
  weavePhase += amt;
}
function foldToward(m, center, span = 8) {
  while (m < center - span) m += 12;
  while (m > center + span) m -= 12;
  return m;
}

const sampler = makeSampler();
const rawPack = fetchSamplePack();   // network fetch starts at page load

/* ---------- journal: the session as a score ----------
 * Every voice invocation is recorded as a resolved sound event — never a
 * character, never a word. The shelf replays the score through the same
 * voices in an OfflineAudioContext.
 */
let journalPref = null;              // 'hub' | 'idb' | null — set by the page
let journal = null;
let claudeVoicing = false;           // true while claude borrows a lead instrument
let sessionEpoch = 0;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function enableJournal(backend) { journalPref = backend; }

function jrn(ev) {
  if (!journal || !journal.on) return;
  journal.buf.push(ev);
  if (journal.buf.length >= 200) flushJournal();
  if (journal.buf.length > 5000) journal.buf.splice(0, journal.buf.length - 5000);
}
function jrnSet(k, val) {
  if (!journal || !journal.on || !ctx) return;
  journal.buf.push({ t: r3(ctx.currentTime - sessionEpoch), e: 'set', k, val });
}

function styleKey() { return Object.keys(STYLES).find(k => STYLES[k] === STYLE) || 'lofi'; }

function initJournal() {
  sessionEpoch = ctx.currentTime;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const sid = stamp + '-' + Math.random().toString(36).slice(2, 6);
  journal = {
    backend: journalPref, sid, seq: 0, buf: [], on: true, fails: 0, sentHeader: false,
    header: {
      v: 1, e: 'hdr', startedWall: Date.now(), style: styleKey(), key: keyOff,
      bpm: STYLE.bpm, swing: val('swingRange', 15), density: val('densRange', 50),
      crackle: val('crackleRange', 45), drums: drumsOn, claude: claudeOn,
      mapping, sampleRate: ctx.sampleRate,
    },
  };
  wrapVoicesForJournal();
  setInterval(() => { if (journal.buf.length) flushJournal(); }, 3000);
  window.addEventListener('pagehide', () => flushJournal(true));
  setChip('journalChip', 'on');
}

function wrapVoicesForJournal() {
  const T = w => r3(w - sessionEpoch);
  const wrap = (fn, map) => (...a) => {
    const ev = map(...a);
    if (claudeVoicing) ev.c = 1;   // claude on a lead instrument is still claude
    jrn(ev);
    return fn(...a);
  };
  const drumMap = e => (w, v) => ({ t: T(w), e, v: r2(v) });
  rhodesNote   = wrap(rhodesNote,   (m, v, w, o = {}) => ({ t: T(w), e: 'rhodes', m, v: r2(v),
    o: { dur: o.dur, cutoff: o.cutoff, gainMul: o.gainMul, panBias: o.panBias, tier: o.tier } }));
  playPulse    = wrap(playPulse,    (m, v, w, x) => ({ t: T(w), e: 'pulse', m, v: r2(v), x: x || 0 }));
  playSawLead  = wrap(playSawLead,  (m, v, w, x) => ({ t: T(w), e: 'saw', m, v: r2(v), x: x || 0 }));
  playKalimba  = wrap(playKalimba,  (m, v, w) => ({ t: T(w), e: 'kalimba', m, v: r2(v) }));
  playMelodyOsc = wrap(playMelodyOsc, (m, v, w, x) => ({ t: T(w), e: 'osc', m, v: r2(v), x: x || 0 }));
  playClaude   = wrap(playClaude,   (m, v, w) => ({ t: T(w), e: 'claude', m, v: r2(v) }));
  playStabTone = wrap(playStabTone, (m, v, w) => ({ t: T(w), e: 'stab', m, v: r2(v) }));
  playPadChord = wrap(playPadChord, (vc, w, d, soft) => ({ t: T(w), e: 'pad', vc, d: r2(d), soft: soft ? 1 : 0 }));
  bassHit      = wrap(bassHit,      (m, v, w, o = {}) => ({ t: T(w), e: 'bass', m, v: r2(v),
    o: { wave: o.wave, cutoff: o.cutoff, dur: o.dur } }));
  hatTick      = wrap(hatTick,      (w, v, open, dr) => ({ t: T(w), e: 'hat', v: r2(v), open: open ? 1 : 0, dr: dr ? 1 : 0 }));
  kickBoom     = wrap(kickBoom,     drumMap('kick'));
  snareDust    = wrap(snareDust,    drumMap('snare'));
  chipKick     = wrap(chipKick,     drumMap('ckick'));
  chipSnare    = wrap(chipSnare,    drumMap('csnare'));
  retroKick    = wrap(retroKick,    drumMap('rkick'));
  gatedSnare   = wrap(gatedSnare,   drumMap('gsnare'));
  shaker       = wrap(shaker,       drumMap('shaker'));
  playRim      = wrap(playRim,      drumMap('rim'));
  playScratch  = wrap(playScratch,  w => ({ t: T(w), e: 'scratch' }));
}

let idbHandle = null;
async function flushJournal(final) {
  if (!journal || !journal.on || !journal.buf.length) return;
  const events = journal.buf.splice(0);
  const seq = ++journal.seq;
  const payload = {
    sid: journal.sid, seq,
    header: journal.sentHeader ? undefined : journal.header,
    events,
  };
  try {
    if (journal.backend === 'hub') {
      if (final && navigator.sendBeacon) {
        navigator.sendBeacon('/journal', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        return;
      }
      const r = await fetch('/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.full) { journal.on = false; setChip('journalChip', 'full'); return; }
      if (!j.ok) throw new Error('journal rejected');
    } else {
      idbHandle ??= await idbOpen();
      await idbPutBatch(idbHandle, journal.sid, journal.header, events);
      if (seq % 20 === 0) idbPrune(idbHandle).catch(() => {});
    }
    journal.sentHeader = true;
    journal.fails = 0;
  } catch {
    journal.seq--;
    journal.buf.unshift(...events.slice(-2000));
    if (++journal.fails > 5) { journal.on = false; setChip('journalChip', 'off'); }
  }
}

const $ = id => document.getElementById(id);
const setChip = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const val = (id, dflt) => { const el = $(id); return el ? +el.value : dflt; };
const density = () => val('densRange', 50) / 100;
function volLevel() { return (val('volRange', 75) / 100) * 1.1; }
function cracLevel() { return (val('crackleRange', 45) / 100) * 0.16; }

/* ---------- mapping ---------- */
function chordAt(slotIdx) {
  const bar = Math.max(0, Math.floor(slotIdx / 16));
  if (STYLE.chorusProg && bar >= chorusStartBar && bar < chorusUntilBar) {
    return STYLE.chorusProg[bar % 4];   // chorus runs one chord a bar, always
  }
  const chordBar = Math.floor(bar / STYLE.bpc);
  const prog = STYLE.progs[Math.floor(chordBar / 8) % STYLE.progs.length];
  return prog[chordBar % 4];
}
function bassOf(chord) { return 36 + ((chord.root + keyOff) % 12); }
function allowedPcs(chord, tier) {
  const chordPcs = new Set(chord.tones.map(pc => (pc + keyOff) % 12));
  const s = new Set(chordPcs);
  if (tier >= 1) PENT.forEach(pc => s.add((pc + keyOff) % 12));
  if (tier >= 2) {
    DIA.forEach(pc => {
      const tpc = (pc + keyOff) % 12;
      // avoid-note rule: a diatonic tone one semitone above a chord tone clashes
      if (!chordPcs.has((tpc + 11) % 12)) s.add(tpc);
    });
  }
  return s;
}
function snapMidi(m, pcs) {
  for (let d = 0; d <= 6; d++) {
    for (const dd of (d === 0 ? [0] : [d, -d])) {
      if (pcs.has((((m + dd) % 12) + 12) % 12)) return m + dd;
    }
  }
  return m;
}
function pcOf(m) { return (((m % 12) + 12) % 12); }
function chordPcSet(chord) { return new Set(chord.tones.map(pc => (pc + keyOff) % 12)); }
function isChordTone(chord, midi) { return chordPcSet(chord).has(pcOf(midi)); }
function seeded01(a, b = 0, c = 0, d = 0) {
  let h = 2166136261;
  for (const x of [a, b, c, d]) {
    h ^= Math.floor(x) + 0x9e3779b9;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
function beatStrength(n) {
  const pos = n % 16;
  if (pos === 0) return 3;
  if (pos === 8) return 2;
  if (pos % 4 === 0) return 1;
  return 0;
}
function strumOffset(n, count) {
  if (!count) return 0;
  return count * (0.026 + seeded01(n, count, 17) * 0.014);
}
function humanDelay(n, role, emphasis = 0) {
  if (STYLE.lead === 'pulse') return seeded01(n, 31) * 0.006;
  const salt = role === 'claude' ? 43 : role === 'motif' ? 59 : 29;
  const base = role === 'claude' ? 0.018 : 0.01;
  const spread = role === 'claude' ? 0.017 : 0.012;
  return Math.max(0, base + (seeded01(n, salt, STYLE.bpm) - 0.5) * spread - emphasis * 0.004);
}
function melodyWhen(t, n, count, role = 'you', emphasis = 0) {
  return t + strumOffset(n, count) + humanDelay(n + count * 23, role, emphasis);
}
function melodicPcs(chord, tier, n, wordInitial, accented, resolving) {
  const chordPcs = chordPcSet(chord);
  const s = new Set(chordPcs);
  const strong = beatStrength(n) > 0;
  if (wordInitial || accented || resolving || strong || tier <= 0) return s;
  if (tier >= 1) PENT.forEach(pc => s.add((pc + keyOff) % 12));
  // Color notes read as color only when they are off the strong beats.
  if (tier >= 2 && n % 2 === 1) allowedPcs(chord, 2).forEach(pc => s.add(pc));
  return s;
}
function snapMelodicMidi(target, chord, tier, o = {}) {
  const pcs = melodicPcs(chord, tier, o.n || 0, !!o.wordInitial, !!o.accented, !!o.resolving);
  const chordPcs = chordPcSet(chord);
  const center = o.center ?? target;
  const prev = o.prev || 0;
  let best = null, bestScore = Infinity;
  for (let cand = Math.round(target) - 18; cand <= Math.round(target) + 18; cand++) {
    const pc = pcOf(cand);
    if (!pcs.has(pc)) continue;
    const chordTone = chordPcs.has(pc);
    let score = Math.abs(cand - target) * 1.15 + Math.abs(cand - center) * 0.08;
    if (chordTone) score -= (o.wordInitial || o.accented || o.resolving) ? 2.4 : 0.75;
    else score += beatStrength(o.n || 0) ? 3.0 : 0.55;
    if (prev) {
      const dist = Math.abs(cand - prev);
      const iv = dist % 12;
      if (iv === 1 || iv === 6 || iv === 11) score += beatStrength(o.n || 0) ? 5.0 : 2.0;
      if (dist > 7) score += (dist - 7) * (o.accented ? 0.18 : 0.75);
      if (dist >= 2 && dist <= 5) score -= 1.0;
      if (dist === 0 && !o.wordInitial) score += 0.5;
    }
    if (o.resolving && !chordTone) score += 4.0;
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best ?? snapMidi(target, pcs);
}
function tierFor(ch) {
  if (ch >= '0' && ch <= '9') return 1;
  const rank = FREQ.indexOf(ch);
  if (rank < 0) return 2;
  return rank < 8 ? 0 : rank < 18 ? 1 : 2;
}
function geoMidi(ch, handSplit) {
  for (let r = 0; r < ROWS.length; r++) {
    const c = ROWS[r].indexOf(ch);
    if (c < 0) continue;
    const pos = c / (ROWS[r].length - 1);
    const deg = Math.round(pos * 6);
    let m = ROW_BASE[r] + DIA[deg] + keyOff;
    if (handSplit && LEFT_HAND.has(ch)) m -= 12;
    return m;
  }
  return null;
}
function alphaMidi(ch) {
  const i = ch.charCodeAt(0) - 97;
  if (i < 0 || i > 25) return null;
  let m = 53 + DIA[i % 7] + 12 * Math.floor(i / 7) + keyOff;
  if (m > 86) m -= 24;
  return m;
}
function voicingOf(chord) {
  const out = [];
  for (let i = 0; i < chord.tones.length; i++) {
    const pc = (chord.tones[i] + keyOff) % 12;
    const min = i === 0 ? 40 : out[i - 1] + 2;
    const max = i === 0 ? 57 : 92;
    const target = prevVoicing && prevVoicing[i] ? prevVoicing[i] : 48 + i * 5;
    let best = null, bestDist = Infinity;
    for (let m = 36 + pc; m <= 96; m += 12) {
      if (m < min || m > max) continue;
      const dist = Math.abs(m - target);
      if (dist < bestDist) { bestDist = dist; best = m; }
    }
    if (best == null) {
      best = 36 + pc;
      while (best < min) best += 12;
      while (best > max) best -= 12;
    }
    out.push(best);
  }
  prevVoicing = out;
  return out;
}

/* ---------- init ---------- */
function initAudio() {
  engine = createAudioEngine(
    new (window.AudioContext || window.webkitAudioContext)(),
    { sampler, getStyle: () => STYLE, getCrackle: cracLevel });
  ctx = engine.ctx;
  masterGain = engine.masterGain;
  ({ rhodesNote, playPulse, playSawLead, playKalimba, playMelodyOsc, playClaude,
     playStabTone, playPadChord, bassHit,
     kickBoom, snareDust, hatTick, chipKick, chipSnare, retroKick, gatedSnare,
     shaker, playRim, playScratch } = engine.voices);
  engine.setVolume(volLevel());
  engine.buildBed();
  decodeSamplerInto(ctx, sampler, rawPack).then(ok => {
    setChip('soundChip', ok ? 'sampled' : 'synth');
  });
  if (journalPref) initJournal();
}

/* ---------- melody dispatch ---------- */
function leadVoice(midi, vel, when, tier, ld = weave.lead) {
  switch (STYLE.lead) {
    case 'pulse':   return playPulse(midi, vel, when, tier);
    case 'saw':     return playSawLead(midi, vel, when, tier);
    case 'kalimba': return playKalimba(midi, vel, when);
    default:        return rhodesNote(midi, vel, when, {
      tier, dur: 0.95 + tier * 0.25 + 0.5 * (1 - ld),
      cutoff: 900 + (350 + 1000 * leadLevel()) * ld,   // leading sits in the light, receding sinks into the haze
      gainMul: 0.55,
    });
  }
}
const leadLevel = () => val('leadRange', 45) / 100;
function playMelody(midi, vel, when, tier, prefolded) {
  if (!prefolded) midi = foldToward(midi, weave.you);   // your notes ride your side of the weave
  midi += STYLE.leadOct;
  vel *= (0.5 + 0.7 * leadLevel()) * (0.78 + 0.22 * weave.lead);   // Lead control × weave presence
  leadVoice(midi, vel, when, tier);
  if (section === 'chorus' && vel > 0.3) {
    leadVoice(midi + 12, vel * 0.6, when + 0.02, tier);   // the chorus doubles up an octave
  }
}

/* ---------- bass & drum patterns ---------- */
function scheduleBass(chord, pos, bar, t, act) {
  const root = bassOf(chord);
  switch (STYLE.bass) {
    case 'chip':
      if (pos % 4 === 0) bassHit(pos === 8 ? root + 7 : root, 0.4, t, { wave: 'square', cutoff: 700, dur: 0.22 });
      break;
    case 'octave':
      if (pos % 2 === 0) bassHit(pos % 4 === 0 ? root : root + 12, 0.22 + act * 0.25, t, { wave: 'sawtooth', cutoff: 600, dur: 0.24 });
      break;
    case 'drone':
      if (pos === 0 && bar % STYLE.bpc === 0) bassHit(root, 0.3, t, { dur: STYLE.bpc * 16 * P16, cutoff: 300 });
      break;
    case 'sub': { // the 808: an 8-bar low-end phrase, not the same answer every bar
      const next = bassOf(chordAt((bar + 1) * 16));
      const approach = next === root ? root : (next > root ? next - 1 : next + 1);
      const phrases = [
        [{ p: 0, m: 0, v: 0.62, d: 1.55 }, { p: 10, m: 0, v: 0.34, d: 0.75 }],
        [{ p: 0, m: 0, v: 0.56, d: 1.15 }, { p: 6, m: 0, v: 0.26, d: 0.35 }, { p: 11, m: 7, v: 0.33, d: 0.55 }],
        [{ p: 0, m: 0, v: 0.64, d: 1.85 }, { p: 14, a: 1, v: 0.24, d: 0.28 }],
        [{ p: 0, m: 0, v: 0.52, d: 0.85 }, { p: 7, m: 0, v: 0.27, d: 0.36 }, { p: 10, m: 5, v: 0.42, d: 0.85 }],
        [{ p: 0, m: 0, v: 0.60, d: 1.25 }, { p: 12, m: 0, v: 0.32, d: 0.5 }],
        [{ p: 0, m: 0, v: 0.48, d: 0.7 }, { p: 4, m: 0, v: 0.22, d: 0.25 }, { p: 9, m: 7, v: 0.36, d: 0.75 }, { p: 15, a: 1, v: 0.2, d: 0.22 }],
        [{ p: 0, m: 0, v: 0.58, d: 1.65 }],
        [{ p: 0, m: 0, v: 0.56, d: 0.9 }, { p: 5, m: 0, v: 0.25, d: 0.25 }, { p: 8, m: 7, v: 0.34, d: 0.45 }, { p: 13, a: 1, v: 0.24, d: 0.24 }],
      ];
      for (const e of phrases[bar % phrases.length]) {
        if (pos === e.p) bassHit(e.a ? approach : root + e.m, e.v + act * 0.05, t, { cutoff: 240, dur: e.d });
      }
      break; }
    default: // lofi
      if (pos === 0) bassHit(root, 0.5, t);
      if (pos === 10) bassHit(bar % 2 ? root + 7 : root, 0.38, t);
      if (pos === 14 && bar % 2 === 1) {
        // walk into the next chord: a quiet chromatic approach note
        const next = bassOf(chordAt((bar + 1) * 16));
        if (next !== root) bassHit(next > root ? next - 1 : next + 1, 0.28, t, { dur: 0.3 });
      }
  }
}
function scheduleDrums(pos, bar, t, act) {
  const d = density();
  const inChorus = section === 'chorus';
  if (bar === chorusUntilBar && pos < 8) return;   // the post-chorus breath
  if (bar % 8 === 7 && pos >= 12 && pos % 2 === 0) snareDust(t, 0.18 + (pos - 12) * 0.04); // phrase-end fill
  switch (STYLE.drums) {
    case 'chip':
      if (pos === 0 || pos === 8) chipKick(t, 0.85);
      if (pos === 4 || pos === 12) chipSnare(t, 0.8);
      if (pos % 2 === 0) hatTick(t, 0.4);
      else if (inChorus || act > 1.05 - d * 0.6) hatTick(t, 0.2);
      break;
    case 'retro': {
      const rh = (bar * 2654435761) >>> 0;
      if (pos % 4 === 0) retroKick(t, 0.85);
      if (pos === 14 && ((rh >>> 4) & 3) === 1) retroKick(t, 0.5);   // pickup kick
      if (pos === 4 || pos === 12) gatedSnare(t, 0.8);
      if (pos % 4 === 2) hatTick(t, 0.4);
      if (inChorus && pos % 4 === 0) hatTick(t, 0.25);
      break; }
    case 'sparse':
      if (pos === 0 && bar % 2 === 0) kickBoom(t, 0.5);
      if (pos === 8) shaker(t, 0.5 + act * 0.3);
      if (inChorus && pos === 4) shaker(t, 0.35);
      break;
    case 'headnod': { // harder than boombap: syncopated kicks, big backbeat,
      // phrase-level low-end variation, straight-8 hats with an open pickup
      const h = (bar * 2654435761) >>> 0;
      const kickPhrases = [
        [0, 10],
        [0, 3, 10],
        [0, 11],
        [0, 6, 10, 14],
        [0, 8],
        [0, 9, 15],
        [0],
        [0, 7, 10, 13],
      ];
      const kicks = kickPhrases[bar % kickPhrases.length];
      if (kicks.includes(pos)) kickBoom(t, pos === 0 ? 0.9 : 0.52 + (((h >>> (pos + 1)) & 3) * 0.08));
      if (pos === 4 || pos === 12) snareDust(t, 0.95);
      if (pos === 11 && ((h >>> 6) & 3) === 1) snareDust(t, 0.18);   // ghost into the backbeat
      if (pos === 15 && ((h >>> 9) & 7) === 2) snareDust(t, 0.15);   // flam into the one
      if (pos % 2 === 0) hatTick(t, pos % 4 === 0 ? 0.5 : 0.35);
      else if (inChorus || act > 1.0 - d * 0.5) hatTick(t, 0.2);
      if (pos === 14 && (inChorus || act > 0.9)) hatTick(t, 0.3, true); // open-hat pickup
      break; }
    default: // boombap
      { // per-bar variation, deterministic from the bar index — the drummer
        // plays the song, not a loop
        const h = (bar * 2654435761) >>> 0;
        const kickPool = [[0, 10], [0, 6, 10], [0, 10, 14], [0, 7, 10]];
        const kicks = kickPool[(h >>> 3) & 3];
        if (kicks.includes(pos)) kickBoom(t, 0.85);
        if (pos === 4 || pos === 12) snareDust(t, 0.8);
        if (pos === 14 && ((h >>> 5) & 7) === 0) snareDust(t, 0.16);   // ghost
        if (pos === 7 && ((h >>> 8) & 7) === 1) snareDust(t, 0.14);    // ghost
        const hatRest = ((h >>> 11) & 15) === 2 && pos < 8;            // a breath bar
        if (!hatRest && pos % 2 === 0) hatTick(t, pos % 4 === 0 ? 0.4 : 0.55);
        else if (!hatRest && (inChorus || act > 1.05 - d * 0.6)) hatTick(t, 0.22); }
  }
  if (inChorus && pos === 0) hatTick(t, 0.3, true);
}

/* ---------- transport / scheduler ---------- */
function swingDelay() { return (val('swingRange', 15) / 100) * P16; }

function riserFx(when, dur, down) {
  const src = ctx.createBufferSource(); src.buffer = engine.noiseBuf; src.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
  hp.frequency.setValueAtTime(down ? 6000 : 400, when);
  hp.frequency.exponentialRampToValueAtTime(down ? 400 : 6000, when + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(0.045, when + dur - 0.05);
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  src.connect(hp); hp.connect(g); g.connect(engine.masterFilter);
  src.start(when); src.stop(when + dur + 0.1);
}
function tapeStartFx() {
  const now = ctx.currentTime + 0.02;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(180, now);
  o.frequency.exponentialRampToValueAtTime(520, now + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(0.05, now + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  o.connect(g); g.connect(engine.masterFilter);
  o.start(now); o.stop(now + 0.6);
}

function scheduleSlot(s) {
  const pos = s % 16;
  const bar = Math.floor(s / 16);
  const chord = chordAt(s);
  const base = t0 + s * P16;
  const t = base + (s % 2 ? swingDelay() : 0);
  const act = smoothedAct;
  const chordStart = pos === 0 && bar % STYLE.bpc === 0;

  if (section === 'runout') {
    // the end-groove: bed keeps spinning, a soft home chord surfaces now and then
    if (pos === 0 && bar % 4 === 0) playStabTone(48 + keyOff, 0.08, t);
    if (pos === 0) setTimeout(() => setChip('chordChip', '—'), Math.max(0, (t - ctx.currentTime) * 1000));
    return;
  }
  if (section === 'outro') {
    if (bar === outroAtBar && pos === 0) {
      // the composed ending: V under the tonic, then home rings out
      bassHit(36 + ((keyOff + 7) % 12), 0.45, t);
      bassHit(36 + keyOff, 0.5, t + 8 * P16);
      [0, 4, 7, 11, 14].forEach((iv, i) => playStabTone(48 + keyOff + iv, 0.22, t + 8 * P16 + i * 0.03));
    }
    return;   // melody rests, drums are done for the night
  }

  if (pos === 0) {
    if (bar - lastWeaveBar >= 8) advanceWeave(1 / 6);   // the braid turns even without punctuation
    switch (STYLE.harmony) {
      case 'pad':
        if (chordStart) playPadChord(voicingOf(chord), t, STYLE.bpc * 16 * P16 + 0.3, false);
        break;
      case 'padlong':
        if (chordStart) playPadChord(voicingOf(chord), t, STYLE.bpc * 16 * P16 + 0.5, true);
        break;
      case 'arp':
        break; // handled per-8th below
      default: // stab
        if (bar % 8 !== 7) {
          voicingOf(chord).forEach((m, i) => playStabTone(m, 0.15 + 0.09 * act, t + i * 0.018));
        }
    }
    if (bar === chorusUntilBar - 1) riserFx(t + 8 * P16, 8 * P16, true);   // the faller out of the chorus
    const delta = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => {
      setChip('chordChip', NOTE_NAMES[(chord.root + keyOff) % 12] + chord.label);
    }, delta);

    if (motifs.length && bar - lastMotifBar >= 2 &&
        (section === 'verse' || section === 'chorus')) {
      lastMotifBar = bar;
      echoMotif(chord, t + 4 * P16);   // enters on beat 2, behind the chord
    }
  }

  if (STYLE.harmony === 'arp' && pos % 2 === 0) {
    const tones = chord.tones;
    const tone = 60 + ((tones[(s / 2) % tones.length] + keyOff) % 12);
    playPulse(tone, 0.13 + act * 0.1, t, 0);
  }

  if (section === 'build' && bar === buildAtBar) {
    if (pos === 0) riserFx(t, 16 * P16);
    if (pos >= 8 && pos % 2 === 0) snareDust(t, 0.25 + (pos - 8) * 0.05);
  }

  scheduleBass(chord, pos, bar, t, act);
  if (drumsOn && section !== 'break') scheduleDrums(pos, bar, t, act);
}

/* ---------- section state machine ---------- */
function updateSection(now) {
  if (section === 'runout') return;               // only typing wakes the tape back up
  if (lastKeyAt === 0) { section = 'intro'; return; }
  const bar = Math.floor(slot / 16);
  const idle = now - Math.max(lastKeyAt, lastMouseAt);   // mousing counts as being here

  if (section === 'outro') {
    if (bar > outroAtBar) section = 'runout';
    return;
  }
  if (idle > 180000 * FT) {
    section = 'outro';
    outroAtBar = bar + 1;
    return;
  }
  if (bar === buildAtBar) { section = 'build'; return; }
  if (bar >= chorusStartBar && bar < chorusUntilBar) { section = 'chorus'; return; }
  if (idle > 55000 * FT) { section = 'break'; flowSince = 0; return; }
  section = 'verse';

  // chorus arming: sustained flow earns the lift
  if (smoothedAct > 0.6 && idle < 8000 * FT) { if (!flowSince) flowSince = now; }
  else flowSince = 0;
  if (flowSince && now - flowSince > 120000 * FT && bar >= cooldownUntilBar) {
    buildAtBar = bar + 1;
    chorusStartBar = bar + 2;
    chorusUntilBar = chorusStartBar + 16;
    cooldownUntilBar = chorusUntilBar + 16;
    flowSince = 0;
  }
}

function tick() {
  updateSection(performance.now());
  const wt = weaveTargets();
  weave.you += (wt.you - weave.you) * 0.015;
  weave.cl += (wt.cl - weave.cl) * 0.015;
  weave.lead += (wt.lead - weave.lead) * 0.015;
  const ahead = ctx.currentTime + 0.15;
  while (t0 + slot * P16 < ahead) { scheduleSlot(slot); slot++; }

  const now = performance.now();
  keyTimes = keyTimes.filter(t => now - t < 45000);
  const wpmKeys = keyTimes.filter(t => now - t < 12000).length;
  const keyEnergy = keyTimes.reduce((s, t) => s + Math.exp(-(now - t) / 14000), 0);
  mouseTimes = mouseTimes.filter(x => now - x < 30000);
  const mouseEnergy = mouseTimes.reduce((s, t) => s + Math.exp(-(now - t) / 12000), 0);
  const act = clamp((keyEnergy + Math.min(mouseEnergy, 8) * 0.55) / 42, 0, 1);
  const rising = act > smoothedAct;
  smoothedAct += (act - smoothedAct) * (rising ? 0.09 : 0.012);

  bsTimes = bsTimes.filter(x => now - x < 3000);
  const editBoost = Math.min(0.3, bsTimes.length * 0.06);   // deleting leans on the kit
  engine.drumBus.gain.setTargetAtTime(
    drumsOn ? Math.pow(smoothedAct, 1.15) * 0.9 + editBoost : 0,
    ctx.currentTime,
    rising ? 0.45 : 1.8);
  engine.masterFilter.frequency.setTargetAtTime(
    950 + smoothedAct * 1700 + (section === 'chorus' ? 400 : 0), ctx.currentTime, 1.2);

  // journal the activity automation — offline renders need the drum/filter curve
  if (journal && journal.on) {
    const aEff = r2(drumsOn ? smoothedAct : 0);
    const tNow = ctx.currentTime - sessionEpoch;
    if (journal.lastAutoA === undefined ||
        Math.abs(aEff - journal.lastAutoA) > 0.03 || tNow - (journal.lastAutoT || 0) > 2) {
      journal.buf.push({ t: r3(tNow), e: 'auto', a: aEff, ch: section === 'chorus' ? 1 : 0 });
      journal.lastAutoA = aEff;
      journal.lastAutoT = tNow;
    }
  }

  setChip('wpmChip', String(Math.round((wpmKeys / 5) * (60 / 12))));
  setChip('sectionChip', section);
  const bars = Math.round(smoothedAct * 5);
  setChip('flowChip', '▮'.repeat(bars) + '·'.repeat(5 - bars));
  const cc = $('claudeChip');
  if (cc) {
    cc.textContent = claudeQueue.length > 0 ? 'playing' :
      (now - lastClaudeAt < 15000 && lastClaudeAt > 0) ? 'listening' : 'quiet';
    cc.classList.toggle('on', claudeQueue.length > 0);
  }

  // a Bash rumble that never got its result: fade out after 45s
  if (pendingBash > 0 && performance.now() - rumbleStartedAt > 45000) {
    pendingBash = 0;
    setRumble(false);
  }

  for (const k of slotNotes.keys()) if (k < slot - 8) slotNotes.delete(k);
}

function anchorTransport(lead = 0.15) {
  t0 = ctx.currentTime + lead;
  slot = 0;
  lastWeaveBar = -2;   // bar counter restarts — don't leave the guards stranded ahead of it
  lastMotifBar = -4;
  prevVoicing = null;
}
function tapeStopFx() {
  const now = ctx.currentTime + 0.02;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(520, now);
  o.frequency.exponentialRampToValueAtTime(90, now + 0.45);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.05, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  o.connect(g); g.connect(engine.masterFilter);
  o.start(now); o.stop(now + 0.55);
  engine.masterFilter.frequency.setTargetAtTime(450, now, 0.08);  // tick() reopens it
  playScratch(now + 0.06);
}
function startTransport() {
  anchorTransport();
  tickTimer = setInterval(tick, 25);
  running = true;
  document.body.classList.add('rolling');   // the cassette reels turn
}

function setStyle(name) {
  STYLE = STYLES[name] || STYLES.lofi;
  // the sky follows the style (see body.style-* in style.css)
  const skyName = STYLES[name] ? name : 'lofi';
  document.body.classList.remove('style-lofi', 'style-hiphop', 'style-arcade', 'style-drive', 'style-rain');
  document.body.classList.add('style-' + skyName);
  SPB = 60 / STYLE.bpm;
  P16 = SPB / 4;
  combo = 0; comboTier = 0;
  prevVoicing = null;
  setChip('comboChip', '·');
  if (started) {
    engine.buildBed();
    if (running) {
      // a real transition: tape stops, breath, tape spins up in the new groove
      tapeStopFx();
      anchorTransport(0.55);
      setTimeout(() => { if (running) tapeStartFx(); }, 250);
    }
  }
}

/* ---------- quantize & viz feed ---------- */
function quantized() {
  const now = ctx.currentTime;
  let n = Math.max(0, Math.ceil((now + 0.012 - t0) / P16));   // never before the anchor
  let t = t0 + n * P16 + (n % 2 ? swingDelay() : 0);
  if (t < now + 0.005) { n++; t = t0 + n * P16 + (n % 2 ? swingDelay() : 0); }
  return { n, t };
}
function pushViz(midi, tier, vel, kind, g) {
  vizNotes.push({ born: performance.now(), midi, tier, vel, kind, g, x: Math.random() });
  if (vizNotes.length > 500) vizNotes.splice(0, vizNotes.length - 500);
}

/* a registered word replayed through the current chord — the theme adapts */
function echoMotif(chord, t) {
  const w = motifs[motifIdx++ % motifs.length];
  const gid = ++motifGroup;
  let i = 0;
  let prev = lastUserMidi;
  for (const ch of w) {
    let m = geoMidi(ch, false);
    if (m == null) continue;
    m = foldToward(m, (weave.you + weave.cl) / 2);   // the motif threads the middle of the loom
    m = snapMelodicMidi(m, chord, 1, {
      n: slot + 4 + i,
      prev,
      center: (weave.you + weave.cl) / 2,
    });
    prev = m;
    if (m < 55) m += 12;                             // keep the kalimba out of the mud
    playKalimba(m, 0.17, t + i * P16 + humanDelay(slot + i, 'motif'));
    pushViz(m, 1, 0.3, 'motif', gid);
    i++;
  }
}

/* ---------- user voice ---------- */
function handleChar(ch, shift) {
  const now = performance.now();
  const iki = now - lastKeyAt;
  lastKeyAt = now;
  keyTimes.push(now);
  if (iki > 700) phraseNoteCount = 0;
  const d = density();
  const wasNL = lastCharNL;
  lastCharNL = ch === '\n';

  if (section === 'runout' || section === 'outro') {
    // resurrection: the tape spins back up
    section = 'verse';
    outroAtBar = -1;
    tapeStartFx();
  }

  if (ch === '\b') {
    currentWord = '';               // a corrected word is not the word you meant
    phraseNoteCount = 0;
    const { t } = quantized();
    playRim(t, 0.3);                // deletes join the groove, not the foreground
    bsTimes.push(now);
    bsTimes = bsTimes.filter(x => now - x < 3000);
    if (bsTimes.length === 4) {     // an edit burst drags the kit with it
      snareDust(t + P16, 0.22);
      snareDust(t + 2 * P16, 0.18);
    }
    pushViz(46, 2, 0.4, 'perc');
    return;
  }
  if (ch === ' ') {
    flushWord();
    const { t } = quantized();
    hatTick(t, 0.4 + d * 0.25, false, true);
    lastWasBoundary = true;
    pushViz(90, 1, 0.3, 'perc');
    return;
  }
  if (ch === '\n') {
    flushWord();
    phraseNoteCount = 0;
    if (wasNL) advanceWeave(1 / 3, true);   // a paragraph is deliberate — it always turns the braid
    const { n, t } = quantized();
    hatTick(t, 0.45, true, true);
    bassHit(bassOf(chordAt(n)) + 12, 0.4, t);
    lastWasBoundary = true;
    pushViz(43, 0, 0.6, 'perc');
    return;
  }
  if (ch === '\t') {
    const { n, t } = quantized();
    bassHit(bassOf(chordAt(n)), 0.5, t);
    pushViz(38, 0, 0.5, 'note');
    return;
  }

  const { n, t } = quantized();
  const chord = chordAt(n);
  const count = slotNotes.get(n) || 0;

  if (ch in CADENCE) {
    flushWord();
    if (ch !== ',') advanceWeave(1 / 6);   // sentence ends turn the braid
    phraseNoteCount = 0;
    const rootPc = (chord.root + keyOff) % 12;
    // fold the cadence root, then speak the interval — '.', ',', '?', '!' stay distinct
    let m = foldToward(60 + rootPc, weave.you - 7) + CADENCE[ch];
    if (m < 50) m += 12; else if (m > 88) m -= 12;
    playMelody(m, ch === '!' ? 0.6 : 0.4, melodyWhen(t, n, count, 'you', 1), 0, true);
    slotNotes.set(n, count + 1);
    lastWasBoundary = true;
    lastUserMidi = m; lastUserNoteAt = now;
    lastUserWasTension = !isChordTone(chord, m);
    pushViz(m, 0, 0.5, 'note');
    if (ch === '?' && claudeOn && claudeQueue.length === 0) {
      // a question deserves an answer: 9th, down through the (chord's own) 7th, home
      const base = foldToward(72 + rootPc, weave.cl);   // answered from claude's side of the weave
      const pcs = allowedPcs(chord, 2);
      const a = snapMidi(base + 14, pcs);
      const b = snapMidi(base + 10, pcs);
      const c = base + 12;
      playClaude(a, 0.4, t + SPB + humanDelay(n + 8, 'claude'));
      playClaude(b, 0.35, t + SPB * 1.5 + humanDelay(n + 12, 'claude'));
      playClaude(c, 0.45, t + SPB * 2 + humanDelay(n + 16, 'claude'));
      lastClaudeMidi = c;
      pushViz(a, 1, 0.4, 'claude');
      pushViz(c, 1, 0.4, 'claude');
    }
    return;
  }

  const isLetter = ch >= 'a' && ch <= 'z';
  const isDigit = ch >= '0' && ch <= '9';

  if (!isLetter && !isDigit) {
    flushWord();
    playRim(t, 0.45);
    pushViz(92, 2, 0.25, 'perc');
    if ('{}[]()<>'.includes(ch)) {
      const rootPc = (chord.root + keyOff) % 12;
      const bm = snapMelodicMidi(foldToward(74 + rootPc, weave.you), chord, 1, {
        n, prev: lastUserMidi, center: weave.you, accented: true,
      });
      playMelody(bm, 0.2, melodyWhen(t, n, 0, 'you', 1), 1);
      lastUserMidi = bm; lastUserNoteAt = now;
      lastUserWasTension = !isChordTone(chord, bm);
      pushViz(bm, 2, 0.25, 'note');
    }
    lastWasBoundary = false;
    return;
  }

  if (isLetter) currentWord = (currentWord + ch).slice(0, 24);

  const slotCap = d < 0.5 ? 3 : 4;
  if (count >= slotCap) return;

  const tier = tierFor(ch);
  const wordInitial = lastWasBoundary;
  wordCharIdx = wordInitial ? 0 : wordCharIdx + 1;
  lastWasBoundary = false;

  // phrase gate: keep bursts shaped like gestures instead of filling every slot.
  // Word starts and rare letters still get through; common mid-word letters give
  // the phrase its breaths.
  let phrasing = 'play';
  if (!wordInitial && !shift) {
    const cap = d > 0.72 ? 5 : d > 0.42 ? 4 : 3;
    if (tier === 0 && d < 0.5 && wordCharIdx % 2 === 1) return;
    if (phraseNoteCount >= cap && beatStrength(n) === 0 && tier < 2) return;
    if (tier === 0 && phraseNoteCount >= 2 && d < 0.72 && n % 2 === 1) phrasing = 'ghost';
  }

  let midi;
  if (mapping === 'alpha' && isLetter) {
    midi = alphaMidi(ch);
    if (midi == null) return;
  } else {
    midi = geoMidi(ch, true);
    if (midi == null) return;
    midi = clamp(midi, 50, 88);
  }
  midi = foldToward(midi, weave.you);   // the weave decides the octave; the key decides the note
  if (!(mapping === 'alpha' && isLetter)) {
    midi = snapMelodicMidi(midi, chord, tier, {
      n,
      wordInitial,
      accented: shift,
      resolving: lastUserWasTension,
      prev: lastUserMidi,
      center: weave.you,
    });
  }

  let vel = 0.36;
  if (wordInitial) vel += 0.13;
  if (shift) vel += 0.12;
  if (!wordInitial && tier === 0 && !shift) vel = 0.10 + d * 0.18;
  if (phrasing === 'ghost') vel *= 0.45;
  if (iki < 90) vel *= 0.88;

  const when = melodyWhen(t, n, count, 'you', wordInitial || shift ? 1 : 0);
  playMelody(midi, vel, when, tier);
  slotNotes.set(n, count + 1);
  lastUserMidi = midi; lastUserNoteAt = now;
  lastUserWasTension = !isChordTone(chord, midi);
  phraseNoteCount++;
  pushViz(midi, tier, vel, 'note');

  // arcade combo streaks: keep the run alive and the lead sprouts harmonies
  if (STYLE.lead === 'pulse') {
    if (now - lastComboAt < 2000) combo++;
    else { combo = 1; comboTier = 0; }
    lastComboAt = now;
    const newTier = combo >= 100 ? 3 : combo >= 50 ? 2 : combo >= 20 ? 1 : 0;
    if (newTier > comboTier) {
      comboTier = newTier;
      sparkBurst(midi);
      playPulse(96, 0.3, when, 0);
    }
    if (comboTier >= 1) playPulse(snapMidi(midi + 4, allowedPcs(chord, 1)), vel * 0.4, when, 0);
    if (comboTier >= 2) playPulse(snapMidi(midi + 7, allowedPcs(chord, 1)), vel * 0.35, when, 0);
    setChip('comboChip', combo >= 5 ? combo + '×' : '·');
  }
}
function sparkBurst(midi) {
  for (let i = 0; i < 14; i++) {
    pushViz(midi + Math.random() * 24 - 12, Math.floor(Math.random() * 3), 0.6, 'spark');
  }
}

/* ---------- Claude voice ---------- */
function enqueueClaude(text, code) {
  lastClaudeAt = performance.now();
  if (!claudeOn) return;
  for (const ch of text) {
    claudeQueue.push({ ch: ch.toLowerCase(), code });
    if (claudeQueue.length > 700) claudeQueue.shift();
  }
}
function claudeStep(item) {
  const ch = item.ch;
  if (!running) return;
  const { n, t } = quantized();
  const chord = chordAt(n);
  const d = density();

  if (ch === ' ' || ch === '\n' || ch === '\t') {
    if (ch === '\n') hatTick(t, 0.16);
    claudeBoundary = true;
    return;
  }
  if (ch in CADENCE) {
    const rootPc = (chord.root + keyOff) % 12;
    const cm = snapMelodicMidi(foldToward(72 + rootPc + CADENCE[ch], weave.cl), chord, 1, {
      n, prev: lastClaudeMidi, center: weave.cl, accented: true,
    });
    playClaude(cm, 0.4, melodyWhen(t, n, 0, 'claude', 1));
    lastClaudeMidi = cm;
    pushViz(cm, 1, 0.35, 'claude');
    claudeBoundary = true;
    return;
  }
  const isLetter = ch >= 'a' && ch <= 'z';
  const isDigit = ch >= '0' && ch <= '9';
  if (!isLetter && !isDigit) {
    if (++claudeSymbolCount % 4 === 0) { playRim(t, 0.15); pushViz(93, 2, 0.12, 'perc'); }
    claudeBoundary = false;
    return;
  }

  const tier = tierFor(ch);
  const wordInitial = claudeBoundary;
  claudeWordIdx = wordInitial ? 0 : claudeWordIdx + 1;
  claudeBoundary = false;
  // the note budget: claude is a counter-voice, not a firehose —
  // mid-word common letters never sound, and notes keep a courteous distance
  if (!wordInitial && tier === 0) return;
  if (!wordInitial && d < 0.5 && claudeWordIdx % 2 === 1) return;
  const sinceLast = performance.now() - (claudeLastNoteAt || 0);
  if (sinceLast < 320) return;

  const nowMs = performance.now();
  const idleLead = lastKeyAt > 0 && nowMs - lastKeyAt > 15000;
  let midi;
  if (lastUserMidi && nowMs - lastUserNoteAt < 350) {
    // playing together: harmonize a third toward claude's own side of the weave
    const below = weave.cl < weave.you;
    midi = snapMidi(lastUserMidi + (below ? -3 : 4), allowedPcs(chord, 1));
    if (below) {
      if (midi >= lastUserMidi - 2) midi = snapMidi(lastUserMidi - 7, allowedPcs(chord, 1));
      if (midi >= lastUserMidi - 2) midi -= 12;   // never a second under a ringing note
    } else if (midi <= lastUserMidi + 2) {
      midi = snapMidi(lastUserMidi + 7, allowedPcs(chord, 1));
    }
    midi = clamp(midi, 40, 98);
  } else {
    midi = geoMidi(ch, false);
    if (midi == null) return;
    midi = clamp(foldToward(midi, weave.cl), 40, 98);
    midi = snapMelodicMidi(midi, chord, tier, {
      n,
      wordInitial,
      prev: lastClaudeMidi,
      center: weave.cl,
      resolving: lastClaudeMidi && !isChordTone(chord, lastClaudeMidi),
    });
  }

  let vel = 0.22 + (idleLead ? 0.1 : 0);
  if (wordInitial) vel += 0.08;
  vel *= 0.55 + 0.6 * leadLevel();         // the Lead control calms both voices
  vel *= 0.7 + 0.6 * (1 - weave.lead);     // presence trades across the weave

  if (weave.lead < 0.35) {                 // on top, claude earns the lead instrument
    claudeVoicing = true;
    leadVoice(midi, vel, melodyWhen(t, n, 0, 'claude'), tier, 1 - weave.lead);
    claudeVoicing = false;
  } else playClaude(midi, vel, melodyWhen(t, n, 0, 'claude'));
  claudeLastNoteAt = performance.now();
  lastClaudeMidi = midi;
  pushViz(midi, tier, vel, 'claude');
}
function drainClaude() {
  let delay = 90;
  if (claudeQueue.length > 0) {
    const item = claudeQueue.shift();
    claudeStep(item);
    const ch = item.ch;
    delay = 65 + Math.random() * 70;
    if (ch === ' ') delay = 110;
    if ('.,?!;:'.includes(ch)) delay = 260 + Math.random() * 120;
    if (ch === '\n') delay = 340;
    if (claudeQueue.length > 250) delay *= 0.45;
    if (claudeQueue.length > 450) claudeQueue.shift();
  }
  setTimeout(drainClaude, delay);
}

/* ---------- telemetry: the sound of the workshop ----------
 * Tool activity from Claude sessions (and POST /event externals) becomes
 * musical punctuation: builds rumble, errors hold harmonic tension until
 * the next success resolves it, commits get a full cadence.
 */
let telemetryOn = true;
let telemCount = 0;
let pendingBash = 0, rumble = null, rumbleStartedAt = 0;
const erroredFiles = new Set();
let tensionDrone = null;

function rootPcNow() { return (chordAt(slot).root + keyOff) % 12; }
function nextBarTime() {
  const barLen = 16 * P16;
  let n = Math.ceil((ctx.currentTime + 0.02 - t0) / barLen);
  if (n < 1) n = 1;
  return t0 + n * barLen;
}
function setRumble(on) {
  if (!rumble) {
    const src = ctx.createBufferSource();
    src.buffer = engine.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(engine.masterFilter);
    src.start();
    rumble = g;
  }
  rumble.gain.setTargetAtTime(on ? 0.02 : 0, ctx.currentTime, on ? 0.5 : 0.3);
}
function okTickSound() {
  playKalimba(91, 0.13, ctx.currentTime + 0.02);
}
function tensionEnter(f) {
  erroredFiles.add(f || '?');
  pushViz(96, 2, 0.6, 'telem');
  if (tensionDrone) return;
  const root = 48 + rootPcNow();
  const g = ctx.createGain(); g.gain.value = 0;
  g.connect(engine.masterFilter);
  const oscs = [root + 5, root + 7, root + 12].map(m => {   // the sus4 that wants resolving
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = mtof(m);
    engine.wobble.connect(o.detune);
    o.connect(g); o.start();
    return o;
  });
  g.gain.setTargetAtTime(0.05, ctx.currentTime, 1.2);
  tensionDrone = { g, oscs, root };
}
function tensionResolve(f) {
  erroredFiles.delete(f || '?');
  if (erroredFiles.size > 0 || !tensionDrone) return;
  const { g, oscs, root } = tensionDrone;
  tensionDrone = null;
  const now = ctx.currentTime;
  g.gain.setTargetAtTime(0.0001, now, 0.4);
  oscs.forEach(o => o.stop(now + 2));
  playMelody(root + 16, 0.4, now + 0.1, 0);   // sus4 settles onto the third
  playClaude(root + 28, 0.3, now + 0.25);
  pushViz(root + 16, 1, 0.5, 'telem');
}
function commitCadence() {
  const t = nextBarTime();
  const rootPc = rootPcNow();
  snareDust(t - 3 * P16, 0.5); snareDust(t - 2 * P16, 0.6); snareDust(t - P16, 0.7);
  playScratch(t - 0.06);                        // the tape splice
  bassHit(36 + ((rootPc + 7) % 12), 0.5, t - 2 * P16, { dur: 0.4 });
  bassHit(36 + rootPc, 0.6, t);                 // V → I, work committed
  voicingOf(chordAt(slot)).forEach((m, i) => playStabTone(m, 0.3, t + i * 0.02));
  pushViz(36 + rootPc, 0, 0.8, 'telem');
}
function testBell(ok) {
  const now = ctx.currentTime + 0.05;
  const root = 72 + rootPcNow();
  if (ok) { playClaude(root + 7, 0.4, now); playClaude(root + 12, 0.45, now + 0.16); }
  else playScratch(now);
  pushViz(root, ok ? 1 : 2, 0.5, 'telem');
}
function stampNotes() {
  const now = ctx.currentTime + 0.03;
  const root = 76 + rootPcNow();
  [0, 4, 7].forEach((iv, i) => playPulse(root + iv, 0.18, now + i * 0.06, 0));
  pushViz(root, 1, 0.3, 'telem');
}
function radioBlip() {
  const now = ctx.currentTime + 0.02;
  const src = ctx.createBufferSource(); src.buffer = engine.noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
  bp.frequency.setValueAtTime(300, now);
  bp.frequency.exponentialRampToValueAtTime(3200, now + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(0.06, now + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  src.connect(g); g.connect(bp); bp.connect(engine.masterFilter);
  src.start(now); src.stop(now + 0.35);
  pushViz(88, 1, 0.3, 'telem');
}

function handleTelemetry(msg) {
  if (!telemetryOn || !running) return;
  telemCount++;
  if (msg.src === 'ext') {
    if (msg.kind === 'commit') commitCadence();
    else if (msg.ok === false) tensionEnter('ext:' + msg.kind);
    else okTickSound();
    return;
  }
  // verbose per-tool chatter (stamps, blips, ok-ticks) is opt-in — it was noise
  const verbose = new URLSearchParams(location.search).has('telemverbose');
  const base = String(msg.tool || '').replace(/^mcp__.*__/, '');
  if (msg.phase === 'start') {
    if (base === 'Bash') { pendingBash++; rumbleStartedAt = performance.now(); setRumble(true); }
    else if (verbose && (base === 'Write' || base === 'Edit' || base === 'NotebookEdit')) stampNotes();
    else if (verbose && (base === 'WebFetch' || base === 'WebSearch')) radioBlip();
    return;
  }
  if (base === 'Bash') {
    pendingBash = Math.max(0, pendingBash - 1);
    if (!pendingBash) setRumble(false);
  }
  if (msg.commit && msg.ok) { commitCadence(); return; }
  if (msg.test) {
    testBell(msg.ok);
    if (!msg.ok) tensionEnter(msg.f); else tensionResolve(msg.f);
    return;
  }
  if (!msg.ok) tensionEnter(msg.f);
  else {
    const hadTension = erroredFiles.size > 0;
    tensionResolve(msg.f);
    if (hadTension && new URLSearchParams(location.search).has('telemverbose')) okTickSound();
  }
}

/* ---------- SSE stream (live.html only calls this) ---------- */
function connectStream() {
  const es = new EventSource('/events');
  es.onopen = () => { if (!tapLive) setChip('tapChip', 'server ok'); };
  es.onerror = () => {
    setChip('tapChip', 'reconnecting…');
    const el = $('tapChip'); if (el) el.classList.remove('on');
  };
  es.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.kind === 'tool' || msg.src === 'ext') { handleTelemetry(msg); return; }
    if (msg.src === 'you' && typeof msg.ch === 'string') {
      tapLive = true;
      setChip('tapChip', 'live');
      const el = $('tapChip'); if (el) el.classList.add('on');
      if (running) handleChar(msg.ch === '\r' ? '\n' : msg.ch.length === 1 ? msg.ch.toLowerCase() : msg.ch, false);
    } else if (msg.src === 'claude' && typeof msg.text === 'string') {
      enqueueClaude(msg.text, !!msg.code);
    }
  };
}

/* ---------- local pad ---------- */
const pad = $('pad');
let padLastValue = pad ? pad.value : '';
let lastPadKeyHandledAt = 0;

function nudgePowerButton(b) {
  if (!b) return;
  b.classList.remove('nudge');
  void b.offsetWidth;
  b.classList.add('nudge');
}

function ensurePadRunning(musical) {
  if (tapLive || !musical) return false;
  if (running) return true;
  const b = $('powerBtn');
  if (!started && b) {
    b.click();
    return running;
  }
  nudgePowerButton(b);             // an explicit Pause stays paused
  return false;
}

function textDelta(prev, next) {
  let start = 0;
  const lim = Math.min(prev.length, next.length);
  while (start < lim && prev[start] === next[start]) start++;
  let prevEnd = prev.length, nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  return { inserted: next.slice(start, nextEnd), removed: prev.slice(start, prevEnd) };
}

function charsFromInput(e, prev, next) {
  const type = e.inputType || '';
  if (type === 'insertFromPaste') return '';
  if (type.startsWith('delete')) return textDelta(prev, next).removed ? '\b' : '';
  if (type === 'insertLineBreak' || type === 'insertParagraph') return '\n';
  if (type.startsWith('insert')) {
    if (typeof e.data === 'string' && e.data) return e.data;
    return textDelta(prev, next).inserted;
  }
  return textDelta(prev, next).inserted;
}

if (pad) {
  pad.addEventListener('keydown', e => {
    if (demoTimer && !e.metaKey && !e.ctrlKey) stopDemo();
    if (tapLive) return;
    if (!running) {
      const musical = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter';
      if (!e.metaKey && !e.ctrlKey && ensurePadRunning(musical)) {
        // typing IS the play button — a keydown is a valid audio gesture
      } else return;
    }
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Backspace') { handleChar('\b', false); lastPadKeyHandledAt = performance.now(); }
    else if (e.key === 'Enter') { handleChar('\n', false); lastPadKeyHandledAt = performance.now(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const s = pad.selectionStart;
      pad.setRangeText('  ', s, pad.selectionEnd, 'end');
      padLastValue = pad.value;
      handleChar('\t', false);
      lastPadKeyHandledAt = performance.now();
    }
    else if (e.key.length === 1) {
      handleChar(e.key.toLowerCase(), e.shiftKey);
      lastPadKeyHandledAt = performance.now();
    }
  });
  pad.addEventListener('beforeinput', e => {
    if (tapLive) return;
    const musical = e.inputType && !['historyUndo', 'historyRedo'].includes(e.inputType);
    if (!running) ensurePadRunning(musical);
  });
  pad.addEventListener('input', e => {
    const prev = padLastValue;
    const next = pad.value;
    padLastValue = next;
    if (demoTimer && e.isTrusted) stopDemo();
    if (running && !tapLive && e.inputType === 'insertFromPaste') {
      const { n, t } = quantized();
      const chord = chordAt(n);
      voicingOf(chord).forEach((m, i) => {
        playStabTone(m + 12, 0.3, t + i * 0.05);
        pushViz(m + 12, 0, 0.4, 'note');
      });
      return;
    }
    if (tapLive || performance.now() - lastPadKeyHandledAt < 140) return;
    const chars = charsFromInput(e, prev, next);
    if (!chars || !ensurePadRunning(true)) return;
    for (const ch of Array.from(chars).slice(0, 32)) {
      const lower = ch.toLowerCase();
      const shifted = ch !== lower && ch === ch.toUpperCase();
      handleChar(ch === '\r' ? '\n' : lower, shifted);
    }
  });
}

/* ---------- the mouse is company too ----------
 * Pointer glides land as soft kalimba ghosts — window height picks the
 * register, a quick flick leans in a little. Clicks keep time on the rim.
 * Mouse presence feeds a capped share of the activity meter and defers the
 * break/outro timers, so the groove idles along while you read and scroll.
 */
let mouseTimes = [];
let lastMouseAt = 0, lastMouseNoteAt = 0;
let mousePrevX = -1, mousePrevY = -1, mouseDist = 0, mouseSegT0 = 0;
function mouseNote(yFrac, fast) {
  const { n, t } = quantized();
  if ((slotNotes.get(n) || 0) >= 2) return;     // typing owns the slot; glides yield
  const chord = chordAt(n);
  let m = Math.round(79 - yFrac * 26);          // higher on the window sings higher
  m = snapMidi(clamp(m, 50, 84), allowedPcs(chord, 1));
  playKalimba(m, fast ? 0.2 : 0.13, t);
  pushViz(m, 1, fast ? 0.35 : 0.22, 'note');
}
document.addEventListener('pointermove', e => {
  if (!running) return;
  if (e.pointerType && e.pointerType !== 'mouse') return;   // touch-scroll shouldn't plink
  if (e.buttons) return;                        // drags (sliders, selection) aren't glides
  const now = performance.now();
  if (now - lastMouseAt > 1500) { mouseDist = 0; mousePrevX = -1; mousePrevY = -1; }   // a rest ends the gesture
  lastMouseAt = now;
  if (mousePrevX >= 0) mouseDist += Math.hypot(e.clientX - mousePrevX, e.clientY - mousePrevY);
  else mouseSegT0 = now;
  mousePrevX = e.clientX; mousePrevY = e.clientY;
  if (mouseDist > 150 && now - lastMouseNoteAt > 340) {
    const fast = now - mouseSegT0 < 240;
    mouseDist = 0; mouseSegT0 = now;
    lastMouseNoteAt = now;
    if (section === 'outro' || section === 'runout') return;   // the tape wound down — glides stay quiet
    mouseTimes.push(now);
    mouseNote(clamp(e.clientY / (window.innerHeight || 1), 0, 1), fast);
  }
});
document.addEventListener('pointerdown', e => {
  if (!running) return;
  if (e.pointerType && e.pointerType !== 'mouse') return;
  lastMouseAt = performance.now();              // a click is presence, even on a control
  if (section === 'outro' || section === 'runout') return;
  if (e.target && e.target.closest && e.target.closest('button, select, input, textarea, label, a, option')) return;
  const { t } = quantized();
  playRim(t, 0.3);                              // a click keeps time
  pushViz(58, 2, 0.3, 'perc');
});

/* ---------- controls ---------- */
const powerBtn = $('powerBtn');
if (powerBtn) powerBtn.addEventListener('click', async () => {
  if (!started) {
    initAudio();
    startTransport();
    started = true;
    drainClaude();
    powerBtn.textContent = 'Pause';
    if (pad) pad.focus();
    return;
  }
  if (running) {
    await ctx.suspend();
    clearInterval(tickTimer);
    running = false;
    document.body.classList.remove('rolling');
    if (recorder && recorder.state === 'recording') toggleRec();
    stopDemo();
    powerBtn.textContent = 'Resume';
  } else {
    await ctx.resume();
    anchorTransport();               // resume clean at bar 1 (style/tempo may have changed)
    tickTimer = setInterval(tick, 25);
    running = true;
    document.body.classList.add('rolling');
    powerBtn.textContent = 'Pause';
    if (pad) pad.focus();
  }
});

const styleSel = $('styleSel');
if (styleSel) styleSel.addEventListener('change', e => { setStyle(e.target.value); jrnSet('style', e.target.value); });
const keySel = $('keySel');
if (keySel) keySel.addEventListener('change', e => { keyOff = +e.target.value; prevVoicing = null; jrnSet('key', keyOff); });
const mapSel = $('mapSel');
if (mapSel) mapSel.addEventListener('change', e => { mapping = e.target.value; jrnSet('mapping', mapping); });
const drumsChk = $('drumsChk');
if (drumsChk) drumsChk.addEventListener('change', e => { drumsOn = e.target.checked; jrnSet('drums', drumsOn); });
const claudeChk = $('claudeChk');
if (claudeChk) claudeChk.addEventListener('change', e => {
  claudeOn = e.target.checked;
  if (!claudeOn) claudeQueue.length = 0;
});
const volRange = $('volRange');
if (volRange) volRange.addEventListener('input', () => {
  if (engine) engine.setVolume(volLevel());
});
const leadRange = $('leadRange');
if (leadRange) leadRange.addEventListener('input', () => { jrnSet('lead', val('leadRange', 45)); });
const densRange = $('densRange');
if (densRange) densRange.addEventListener('input', () => { jrnSet('density', val('densRange', 50)); });
const swingRange = $('swingRange');
if (swingRange) swingRange.addEventListener('input', () => { jrnSet('swing', val('swingRange', 15)); });
const crackleRange = $('crackleRange');
if (crackleRange) crackleRange.addEventListener('input', () => {
  if (engine) engine.setCrackle(cracLevel());
  jrnSet('crackle', val('crackleRange', 45));
});

/* ---------- the hint line: point at a control, read what it does ---------- */
const hintLine = $('hintLine');
if (hintLine) {
  const idleHint = hintLine.textContent;
  const showHint = el => {
    const label = el.querySelector('label');
    hintLine.textContent = '';
    if (label) {
      const b = document.createElement('b');
      b.textContent = label.textContent;
      hintLine.append(b, ' — ');
    }
    hintLine.append(el.dataset.hint);
  };
  for (const el of document.querySelectorAll('[data-hint]')) {
    el.addEventListener('pointerenter', () => showHint(el));
    el.addEventListener('pointerleave', () => { hintLine.textContent = idleHint; });
    el.addEventListener('focusin', () => showHint(el));
    el.addEventListener('focusout', () => { hintLine.textContent = idleHint; });
  }
}

/* ---------- recording ---------- */
function toggleRec() {
  const btn = $('recBtn');
  if (!btn) return;
  if (!recorder || recorder.state !== 'recording') {
    if (!started) powerBtn.click();
    if (!msDest) { msDest = ctx.createMediaStreamDestination(); masterGain.connect(msDest); }
    recChunks = [];
    recorder = new MediaRecorder(msDest.stream);
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      a.download = 'keystrokes-' + stamp + '.webm';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    recorder.start();
    btn.classList.add('on');
    btn.innerHTML = '<span class="dot"></span>Stop &amp; save';
  } else {
    recorder.stop();
    btn.classList.remove('on');
    btn.innerHTML = '<span class="dot"></span>Rec';
  }
}
const recBtn = $('recBtn');
if (recBtn) recBtn.addEventListener('click', toggleRec);

/* ---------- demo ---------- */
const DEMO_TEXT =
  'rain on the window, a warm cup, the cursor blinking back.\n' +
  'every word you type has a melody hiding in it.\n\n' +
  'function lofi(keys) {\n' +
  '  return keys.map(k => note(k));\n' +
  '}\n\n' +
  'the quick brown keys jam over a jazzy fourth chord. can you hear it?';
function stopDemo() {
  if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  const b = $('demoBtn'); if (b) b.textContent = 'Auto-type a demo';
}
function startAutotype(text) {
  if (!started) powerBtn.click();
  else if (!running) powerBtn.click();
  if ($('demoBtn')) $('demoBtn').textContent = 'Stop the demo';
  let i = 0;
  const step = () => {
    if (i >= text.length) { stopDemo(); return; }
    const ch = text[i++];
    if (pad) { pad.value += ch; pad.scrollTop = pad.scrollHeight; padLastValue = pad.value; }
    if (running) handleChar(ch === '\n' ? '\n' : ch.toLowerCase(), false);
    let d = 70 + Math.random() * 95;
    if (ch === ' ') d = 150 + Math.random() * 90;
    if ('.,?!;:'.includes(ch)) d = 330 + Math.random() * 150;
    if (ch === '\n') d = 620 + Math.random() * 250;
    if (Math.random() < 0.03) d += 500;
    demoTimer = setTimeout(step, d);
  };
  step();
}
const demoBtn = $('demoBtn');
if (demoBtn) demoBtn.addEventListener('click', () => {
  if (demoTimer) { stopDemo(); return; }
  startAutotype(pendingAutoText || DEMO_TEXT);
});

/* ---------- play any text: ?text=… or ?gist=<id> ---------- */
let pendingAutoText = null;
(async () => {
  const p = new URLSearchParams(location.search);
  if (p.has('text')) {
    pendingAutoText = p.get('text').slice(0, 4000);
  } else if (p.has('gist')) {
    try {
      const g = await (await fetch('https://api.github.com/gists/' + encodeURIComponent(p.get('gist')))).json();
      const f = g.files && Object.values(g.files)[0];
      if (f && typeof f.content === 'string') pendingAutoText = f.content.slice(0, 4000);
    } catch { /* gist unavailable — the pad still works */ }
  }
  if (pendingAutoText && demoBtn) {
    demoBtn.textContent = 'Play the loaded text';
    if (pad) pad.placeholder = 'Loaded ' + pendingAutoText.length + ' characters — press "Play the loaded text" to hear them.';
  }
})();

/* ---------- settings persistence: your tuning survives reloads ---------- */
const SAVE_IDS = ['styleSel', 'keySel', 'mapSel', 'swingRange', 'crackleRange',
                  'densRange', 'leadRange', 'volRange', 'drumsChk', 'claudeChk', 'telemChk'];
function saveSettings() {
  const o = {};
  for (const id of SAVE_IDS) {
    const el = $(id);
    if (el) o[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem('ks-settings', JSON.stringify(o)); } catch { /* private mode */ }
}
function restoreSettings() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem('ks-settings') || 'null'); } catch { /* fine */ }
  if (!o) return false;
  for (const id of SAVE_IDS) {
    const el = $(id);
    if (!el || o[id] === undefined) continue;
    if (el.type === 'checkbox') el.checked = o[id];
    else el.value = o[id];
    el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input'));
  }
  return o.keySel !== undefined;
}
for (const id of SAVE_IDS) {
  const el = $(id);
  if (el) el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', saveSettings);
}
restoreSettings();   // default key is C; your saved choice wins

/* ---------- visualization ---------- */
const viz = $('viz');
if (viz) {
  const vctx = viz.getContext('2d');
  const PRM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TIER_COLORS = ['#ffb26b', '#7fd4e4', '#f27ab8'];
  const SPEED = 76; // px/s — notes ride the whole way across, like a piano roll

  const drawViz = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = viz.clientWidth, H = viz.clientHeight;
    if (viz.width !== W * dpr || viz.height !== H * dpr) {
      viz.width = W * dpr; viz.height = H * dpr;
    }
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vctx.clearRect(0, 0, W, H);

    vctx.font = '48px "American Typewriter", Georgia, serif';
    vctx.fillStyle = 'rgba(236,230,244,0.05)';
    vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
    const chip = $('chordChip');
    vctx.fillText(chip ? chip.textContent : '', W / 2, H / 2);

    if (running && ctx) {
      const beat = Math.floor(((ctx.currentTime - t0) / SPB) % 4);
      for (let b = 0; b < 4; b++) {
        vctx.fillStyle = b === beat ? 'rgba(255,178,107,0.85)' : 'rgba(236,230,244,0.12)';
        vctx.fillRect(12 + b * 14, H - 10, 8, 3);
      }
    }

    const now = performance.now();
    const fadeZone = Math.max(60, W * 0.18);
    const motifLines = new Map();   // group id -> [{x, y, alpha}] for connecting lines
    for (let i = vizNotes.length - 1; i >= 0; i--) {
      const nn = vizNotes[i];
      const age = (now - nn.born) / 1000;
      let x, alpha;
      if (PRM) {
        if (age > 3.4) { vizNotes.splice(i, 1); continue; }
        x = 20 + nn.x * (W - 40);
        alpha = Math.max(0, 1 - age / 3.4);
      } else {
        x = W - 14 - age * SPEED;
        if (x < 6) { vizNotes.splice(i, 1); continue; }
        alpha = Math.min(1, age * 6) * clamp((x - 6) / fadeZone, 0, 1);
      }
      const y = H - 14 - ((clamp(nn.midi, 40, 96) - 40) / 56) * (H - 28);
      if (nn.kind === 'perc') {
        vctx.fillStyle = 'rgba(163,150,191,' + (alpha * 0.7).toFixed(3) + ')';
        vctx.fillRect(x - 2, y - 2, 4, 4);
      } else if (nn.kind === 'spark') {
        vctx.fillStyle = TIER_COLORS[nn.tier] + Math.round(alpha * 255).toString(16).padStart(2, '0');
        vctx.fillRect(x - 1.5 + (Math.random() * 3 - 1.5), y - 1.5 + (Math.random() * 3 - 1.5), 3, 3);
      } else if (nn.kind === 'telem') {
        vctx.save();
        vctx.translate(x, y); vctx.rotate(Math.PI / 4);
        vctx.fillStyle = 'rgba(255,178,107,' + (alpha * 0.9).toFixed(3) + ')';
        vctx.fillRect(-3, -3, 6, 6);
        vctx.restore();
      } else if (nn.kind === 'motif') {
        if (!motifLines.has(nn.g)) motifLines.set(nn.g, []);
        motifLines.get(nn.g).push({ x, y, alpha });
        vctx.beginPath();
        vctx.arc(x, y, 2.2, 0, Math.PI * 2);
        vctx.fillStyle = '#ece6f4' + Math.round(alpha * 150).toString(16).padStart(2, '0');
        vctx.fill();
      } else if (nn.kind === 'claude') {
        vctx.beginPath();
        vctx.arc(x, y, 2.5 + nn.vel * 5, 0, Math.PI * 2);
        vctx.strokeStyle = '#7fd4e4' + Math.round(alpha * 210).toString(16).padStart(2, '0');
        vctx.lineWidth = 1.4;
        vctx.stroke();
      } else {
        vctx.beginPath();
        vctx.arc(x, y, 2.5 + nn.vel * 5, 0, Math.PI * 2);
        vctx.fillStyle = TIER_COLORS[nn.tier] + Math.round(alpha * 210).toString(16).padStart(2, '0');
        vctx.fill();
      }
    }
    // connect each motif's notes — the theme reads as a little constellation
    for (const pts of motifLines.values()) {
      if (pts.length < 2) continue;
      vctx.beginPath();
      vctx.moveTo(pts[0].x, pts[0].y);
      for (let p = 1; p < pts.length; p++) vctx.lineTo(pts[p].x, pts[p].y);
      vctx.strokeStyle = 'rgba(236,230,244,' + (pts[0].alpha * 0.35).toFixed(3) + ')';
      vctx.lineWidth = 1;
      vctx.stroke();
    }
    requestAnimationFrame(drawViz);
  };
  requestAnimationFrame(drawViz);
}

/* honor a pre-selected style if the select was set before engine load */
if (styleSel && styleSel.value && styleSel.value !== 'lofi') setStyle(styleSel.value);

/* introspection for tests and debugging — no audio side effects */
function debug() {
  return {
    started, running,
    ctxState: ctx ? ctx.state : null,
    now: ctx ? ctx.currentTime : null,
    slot, style: STYLE.title, sampled: sampler.ok,
    act: Math.round(smoothedAct * 100) / 100,
    vizCount: vizNotes.length,
    telem: telemCount, tension: erroredFiles.size, pendingBash,
    section, buildAtBar, chorusStartBar, chorusUntilBar, outroAtBar,
    motifs: motifs.length, words: wordCounts.size,
    weave: { phase: r2(weavePhase), you: Math.round(weave.you), claude: Math.round(weave.cl), lead: r2(weave.lead) },
    recent: vizNotes.slice(-6).map(nn => ({ k: nn.kind, m: Math.round(nn.midi) })),
    mouseNotes: mouseTimes.length,
  };
}

const telemChk = $('telemChk');
if (telemChk) telemChk.addEventListener('change', e => {
  telemetryOn = e.target.checked;
  if (!telemetryOn) {
    pendingBash = 0;
    if (rumble) setRumble(false);
    erroredFiles.clear();
    if (tensionDrone) tensionResolve();
  }
});

window.KS = { connectStream, enqueueClaude, handleChar, handleTelemetry, enableJournal, debug };
export { connectStream, enqueueClaude, enableJournal, debug };
