/* keystrokes engine — shared audio core for index.html (the site) and
 * live.html (the local session soundtrack).
 *
 * Keystrokes don't choose the music; they steer it. Every key proposes a
 * note, the engine quantizes it to the grid and snaps it to the current
 * chord. A style preset decides what everything sounds like: instruments,
 * tempo, chords, drums, and the background texture.
 */
'use strict';

window.KS = (() => {

/* ---------- shared music constants ---------- */
const DIA = [0, 2, 4, 5, 7, 9, 11];
const PENT = [0, 2, 4, 7, 9];
const NOTE_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const FREQ = 'etaoinshrdlcumwfgypbvkjxqz';
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ROW_BASE = [76, 64, 59, 52];
const LEFT_HAND = new Set('12345qwertasdfgzxcvb');
const CADENCE = { '.': 0, ',': 7, '?': 14, '!': 12 };

/* ---------- styles ----------
 * bpc: bars per chord. harmony: stab | pad | padlong | arp.
 * lead voices: rhodes (sampled) | pulse | saw | kalimba.
 */
const STYLES = {
  lofi: {
    title: 'Lofi tape', bpm: 76, bpc: 1, leadOct: 0,
    lead: 'rhodes', harmony: 'stab', bass: 'lofi', drums: 'boombap', bed: 'vinyl',
    progs: [
      [ // IV - iii - ii - vi
        { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
        { label: 'm7',   root: 4, tones: [4, 7, 11, 2] },
        { label: 'm9',   root: 2, tones: [2, 5, 9, 0, 4] },
        { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
      ],
      [ // vi - IV - I - V13
        { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
        { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
        { label: 'maj9', root: 0, tones: [0, 4, 7, 11, 2] },
        { label: '13',   root: 7, tones: [7, 11, 5, 4] },
      ],
      [ // ii - V13 - I - vi
        { label: 'm9',   root: 2, tones: [2, 5, 9, 0, 4] },
        { label: '13',   root: 7, tones: [7, 11, 5, 4] },
        { label: 'maj9', root: 0, tones: [0, 4, 7, 11, 2] },
        { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
      ],
    ],
  },
  arcade: {
    title: 'Arcade (8-bit)', bpm: 112, bpc: 1, leadOct: 12,
    lead: 'pulse', harmony: 'arp', bass: 'chip', drums: 'chip', bed: 'hiss',
    progs: [
      [ // I - V - vi - IV, sunny
        { label: '',  root: 0, tones: [0, 4, 7] },
        { label: '',  root: 7, tones: [7, 11, 2] },
        { label: 'm', root: 9, tones: [9, 0, 4] },
        { label: '',  root: 5, tones: [5, 9, 0] },
      ],
      [ // I - vi - IV - V
        { label: '',  root: 0, tones: [0, 4, 7] },
        { label: 'm', root: 9, tones: [9, 0, 4] },
        { label: '',  root: 5, tones: [5, 9, 0] },
        { label: '',  root: 7, tones: [7, 11, 2] },
      ],
    ],
  },
  drive: {
    title: 'Night drive', bpm: 92, bpc: 1, leadOct: 0,
    lead: 'saw', harmony: 'pad', bass: 'octave', drums: 'retro', bed: 'hiss',
    progs: [
      [ // i - VI - III - VII, neon
        { label: 'm7',   root: 9, tones: [9, 0, 4, 7] },
        { label: 'maj7', root: 5, tones: [5, 9, 0, 4] },
        { label: 'maj7', root: 0, tones: [0, 4, 7, 11] },
        { label: '7',    root: 7, tones: [7, 11, 2, 5] },
      ],
    ],
  },
  rain: {
    title: 'Rainy day', bpm: 62, bpc: 2, leadOct: 0,
    lead: 'kalimba', harmony: 'padlong', bass: 'drone', drums: 'sparse', bed: 'rain',
    progs: [
      [ // slow sway
        { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
        { label: 'maj9', root: 0, tones: [0, 4, 7, 11, 2] },
        { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
        { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
      ],
    ],
  },
};

/* ---------- state ---------- */
let STYLE = STYLES.lofi;
let SPB = 60 / STYLE.bpm;
let P16 = SPB / 4;

let ctx = null, started = false, running = false;
let t0 = 0, slot = 0, tickTimer = null;
let keyOff = 0, drumsOn = true, claudeOn = true, mapping = 'geo';
let masterGain, masterFilter, comp, drumBus, wobble, noiseBuf;
let crackleGain, bedSources = [], msDest = null, recorder = null, recChunks = [];
let keyTimes = [], lastKeyAt = 0, lastWasBoundary = true, wordCharIdx = 0;
let smoothedAct = 0;
let tapLive = false, lastClaudeAt = 0;
let claudeSymbolCount = 0, claudeBoundary = true, claudeWordIdx = 0;
const claudeQueue = [];
const slotNotes = new Map();
const vizNotes = [];
let demoTimer = null;

const $ = id => document.getElementById(id);
const setChip = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const val = (id, dflt) => { const el = $(id); return el ? +el.value : dflt; };
const density = () => val('densRange', 50) / 100;

/* ---------- samples ---------- */
const sampler = { ok: false, rhodes: new Map(), keys: [], drums: {} };
const prefetch = (async () => {
  const man = await (await fetch('samples/manifest.json')).json();
  const get = async f => await (await fetch('samples/' + f)).arrayBuffer();
  const rhodes = await Promise.all(
    Object.entries(man.rhodes).map(async ([m, f]) => [+m, await get(f)]));
  const drums = await Promise.all(
    Object.entries(man.drums).map(async ([k, f]) => [k, await get(f)]));
  return { rhodes, drums };
})().catch(() => null);

async function loadSamples() {
  const raw = await prefetch;
  if (!raw) { setChip('soundChip', 'synth'); return; }
  try {
    for (const [m, ab] of raw.rhodes) sampler.rhodes.set(m, await ctx.decodeAudioData(ab.slice(0)));
    for (const [k, ab] of raw.drums) sampler.drums[k] = await ctx.decodeAudioData(ab.slice(0));
    sampler.keys = [...sampler.rhodes.keys()].sort((a, b) => a - b);
    sampler.ok = true;
    setChip('soundChip', 'sampled');
  } catch {
    setChip('soundChip', 'synth');
  }
}

/* ---------- mapping ---------- */
function chordAt(slotIdx) {
  const chordBar = Math.floor(slotIdx / 16 / STYLE.bpc);
  const prog = STYLE.progs[Math.floor(chordBar / 8) % STYLE.progs.length];
  return prog[chordBar % 4];
}
function bassOf(chord) { return 36 + ((chord.root + keyOff) % 12); }
function allowedPcs(chord, tier) {
  const s = new Set(chord.tones.map(pc => (pc + keyOff) % 12));
  if (tier >= 1) PENT.forEach(pc => s.add((pc + keyOff) % 12));
  if (tier >= 2) DIA.forEach(pc => s.add((pc + keyOff) % 12));
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
  let last = 48;
  let v = chord.tones.map(pc => {
    let m = 36 + pc + keyOff;
    while (m <= last) m += 12;
    last = m; return m;
  });
  if (v[0] >= 53) v = v.map(m => m - 12);
  return v;
}

/* ---------- audio graph ---------- */
function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 4;
  masterGain = ctx.createGain();
  masterGain.gain.value = volLevel();
  masterFilter = ctx.createBiquadFilter();
  masterFilter.type = 'lowpass'; masterFilter.frequency.value = 1100; masterFilter.Q.value = 0.4;

  masterFilter.connect(comp); comp.connect(masterGain); masterGain.connect(ctx.destination);

  drumBus = ctx.createGain(); drumBus.gain.value = 0; drumBus.connect(masterFilter);

  wobble = ctx.createGain(); wobble.gain.value = 6;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.45; lfo.connect(wobble); lfo.start();

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  buildBed();
  loadSamples();
}
function volLevel() { return (val('volRange', 75) / 100) * 1.1; }
function cracLevel() { return (val('crackleRange', 45) / 100) * 0.16; }

/* ---------- background texture (the "bed") ---------- */
function buildBed() {
  bedSources.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
  bedSources = [];
  if (crackleGain) { try { crackleGain.disconnect(); } catch { /* fine */ } }
  crackleGain = ctx.createGain();
  crackleGain.gain.value = cracLevel();
  crackleGain.connect(comp);

  const noiseLayer = (lpHz, hpHz, gain) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpHz;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(crackleGain);
    src.start(); bedSources.push(src);
  };
  const popLayer = (count, bright, gain) => {
    const len = ctx.sampleRate * 4;
    const pb = ctx.createBuffer(1, len, ctx.sampleRate);
    const pd = pb.getChannelData(0);
    for (let n = 0; n < count; n++) {
      const at = Math.floor(Math.random() * (len - 200));
      const amp = 0.25 + Math.random() * 0.75;
      const w = 2 + Math.floor(Math.random() * 5);
      for (let j = 0; j < w * 12; j++) {
        pd[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / (w * 3));
      }
    }
    const pops = ctx.createBufferSource();
    pops.buffer = pb; pops.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = bright ? 'highpass' : 'lowpass';
    f.frequency.value = bright ? 500 : 2800;
    const g = ctx.createGain(); g.gain.value = gain;
    pops.connect(f); f.connect(g); g.connect(crackleGain);
    pops.start(); bedSources.push(pops);
  };

  switch (STYLE.bed) {
    case 'vinyl':
      noiseLayer(4200, 60, 0.012);
      popLayer(42, true, 0.5);
      break;
    case 'rain':
      noiseLayer(2600, 400, 0.05);
      popLayer(140, false, 0.35);   // soft droplets
      break;
    case 'hiss':
    default:
      noiseLayer(6000, 100, 0.014);
      break;
  }
}

/* ---------- voice helpers ---------- */
function envGain(dest, when, peak, dur, attack) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + (attack || 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  g.connect(dest);
  return g;
}
function stopAll(when, ...nodes) { nodes.forEach(n => n.stop(when)); }
function panner(midi, bias) {
  const pan = ctx.createStereoPanner();
  pan.pan.value = clamp((midi - 64) / 36, -0.45, 0.45) + (bias || -0.12);
  pan.connect(masterFilter);
  return pan;
}

/* ---------- lead voices ---------- */
function rhodesNote(midi, vel, when, o = {}) {
  if (!sampler.ok) { playMelodyOsc(midi, vel, when, o.tier || 0); return; }
  let best = sampler.keys[0];
  for (const k of sampler.keys) if (Math.abs(k - midi) < Math.abs(best - midi)) best = k;
  const src = ctx.createBufferSource();
  src.buffer = sampler.rhodes.get(best);
  src.playbackRate.value = Math.pow(2, (midi - best) / 12);
  src.detune.value = Math.random() * 6 - 3;
  wobble.connect(src.detune);

  const g = ctx.createGain();
  const peak = Math.pow(vel, 1.25) * (o.gainMul ?? 1);
  const dur = o.dur ?? 1.4;
  g.gain.setValueAtTime(peak, when);
  g.gain.setValueAtTime(peak, when + dur * 0.55);
  g.gain.linearRampToValueAtTime(0.0001, when + dur);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = o.cutoff ?? 1900;
  src.connect(g); g.connect(lp); lp.connect(panner(midi, o.panBias));
  src.start(when);
  src.stop(when + dur + 0.05);
}
function playPulse(midi, vel, when, tier) {
  const dur = 0.16 + tier * 0.05;
  const g = envGain(panner(midi, -0.08), when, vel * 0.22, dur + 0.05, 0.004);
  const o = ctx.createOscillator();
  o.type = 'square';
  const f = mtof(midi);
  o.frequency.setValueAtTime(f * 0.94, when);          // tiny chip pitch-blip
  o.frequency.linearRampToValueAtTime(f, when + 0.03);
  o.connect(g); o.start(when); o.stop(when + dur + 0.1);
}
function playSawLead(midi, vel, when, tier) {
  const dur = 0.5 + tier * 0.15;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2400;
  lp.connect(panner(midi, -0.08));
  const g = envGain(lp, when, vel * 0.3, dur, 0.006);
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
  o1.frequency.value = mtof(midi); o1.detune.value = -7;
  const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
  o2.frequency.value = mtof(midi); o2.detune.value = 7;
  wobble.connect(o1.detune);
  o1.connect(g); o2.connect(g);
  o1.start(when); o2.start(when);
  stopAll(when + dur + 0.05, o1, o2);
}
function playKalimba(midi, vel, when) {
  const dur = 1.7;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 3000;
  lp.connect(panner(midi, -0.06));
  const g = envGain(lp, when, vel * 0.32, dur, 0.003);
  const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = mtof(midi);
  o1.detune.value = Math.random() * 6 - 3;
  wobble.connect(o1.detune);
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = mtof(midi) * 3.2;
  const g2 = envGain(lp, when, vel * 0.07, 0.15, 0.002);
  o1.connect(g); o2.connect(g2);
  o1.start(when); o2.start(when);
  stopAll(when + dur + 0.05, o1, o2);
}
function playMelody(midi, vel, when, tier) {
  midi += STYLE.leadOct;
  switch (STYLE.lead) {
    case 'pulse':   return playPulse(midi, vel, when, tier);
    case 'saw':     return playSawLead(midi, vel, when, tier);
    case 'kalimba': return playKalimba(midi, vel, when);
    default:        return rhodesNote(midi, vel, when, { tier, dur: 0.95 + tier * 0.25, cutoff: 1900, gainMul: 0.62 });
  }
}

/* oscillator fallback lead + the permanent Claude music box */
function playMelodyOsc(midi, vel, when, tier) {
  const dur = 0.85 + tier * 0.25;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1750;
  lp.connect(panner(midi));
  const g = envGain(lp, when, vel * 0.5, dur);
  const o1 = ctx.createOscillator();
  o1.type = 'triangle'; o1.frequency.value = mtof(midi);
  o1.detune.value = Math.random() * 8 - 4;
  wobble.connect(o1.detune);
  const o2 = ctx.createOscillator();
  o2.type = 'sine'; o2.frequency.value = mtof(midi - 12);
  const g2 = ctx.createGain(); g2.gain.value = 0.35;
  o1.connect(g); o2.connect(g2); g2.connect(g);
  o1.start(when); o2.start(when);
  stopAll(when + dur + 0.05, o1, o2);
}
function playClaude(midi, vel, when) {
  const dur = 1.25;
  const pan = ctx.createStereoPanner();
  pan.pan.value = 0.3 + clamp((midi - 78) / 60, -0.1, 0.1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2400;
  lp.connect(pan); pan.connect(masterFilter);
  const g = envGain(lp, when, vel * 0.34, dur, 0.004);
  const o1 = ctx.createOscillator();
  o1.type = 'sine'; o1.frequency.value = mtof(midi);
  o1.detune.value = Math.random() * 6 - 3;
  wobble.connect(o1.detune);
  const o2 = ctx.createOscillator();
  o2.type = 'sine'; o2.frequency.value = mtof(midi) * 3;
  const g2 = envGain(lp, when, vel * 0.08, 0.3, 0.002);
  o1.connect(g); o2.connect(g2);
  o1.start(when); o2.start(when);
  stopAll(when + dur + 0.05, o1, o2);
}

/* ---------- harmony voices ---------- */
function playStabTone(midi, vel, when) {
  if (sampler.ok) {
    rhodesNote(midi, vel, when, { dur: 2.6, cutoff: 1250, panBias: 0.12, gainMul: 0.8 });
    return;
  }
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1250;
  lp.connect(masterFilter);
  const g = envGain(lp, when, vel, 2.6, 0.012);
  const o1 = ctx.createOscillator();
  o1.type = 'sine'; o1.frequency.value = mtof(midi);
  wobble.connect(o1.detune);
  const o2 = ctx.createOscillator();
  o2.type = 'triangle'; o2.frequency.value = mtof(midi); o2.detune.value = 5;
  const g2 = ctx.createGain(); g2.gain.value = 0.25;
  const bell = ctx.createOscillator();
  bell.type = 'sine'; bell.frequency.value = mtof(midi) * 4;
  const bg = envGain(lp, when, vel * 0.18, 0.22);
  o1.connect(g); o2.connect(g2); g2.connect(g); bell.connect(bg);
  o1.start(when); o2.start(when); bell.start(when);
  stopAll(when + 2.7, o1, o2, bell);
}
function playPadChord(voicing, when, dur, soft) {
  for (const midi of voicing) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = soft ? 1400 : 950;
    lp.connect(masterFilter);
    const g = ctx.createGain();
    const peak = soft ? 0.05 : 0.055;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + (soft ? 0.6 : 0.3));
    g.gain.setValueAtTime(peak, when + dur - 0.5);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    g.connect(lp);
    const mk = type => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = mtof(midi);
      o.detune.value = Math.random() * 10 - 5;
      wobble.connect(o.detune);
      o.connect(g); o.start(when); o.stop(when + dur + 0.1);
    };
    if (soft) { mk('sine'); mk('triangle'); }
    else { mk('sawtooth'); mk('sawtooth'); }
  }
}

/* ---------- bass ---------- */
function bassHit(midi, vel, when, o = {}) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = o.cutoff ?? 420;
  lp.connect(masterFilter);
  const g = envGain(lp, when, vel, o.dur ?? 0.8, 0.012);
  const o1 = ctx.createOscillator(); o1.type = o.wave ?? 'sine'; o1.frequency.value = mtof(midi);
  const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = mtof(midi);
  const g2 = ctx.createGain(); g2.gain.value = 0.3;
  o1.connect(g); o2.connect(g2); g2.connect(g);
  o1.start(when); o2.start(when);
  stopAll(when + (o.dur ?? 0.8) + 0.1, o1, o2);
}
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
    default: // lofi
      if (pos === 0) bassHit(root, 0.5, t);
      if (pos === 10) bassHit(bar % 2 ? root + 7 : root, 0.38, t);
  }
}

/* ---------- drums ---------- */
function drumSample(name, dest, when, gain) {
  const src = ctx.createBufferSource();
  src.buffer = sampler.drums[name];
  src.playbackRate.value = 0.97 + Math.random() * 0.06;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(g); g.connect(dest); src.start(when);
}
function kickBoom(when, vel) {
  if (sampler.ok) return drumSample('kick', drumBus, when, vel * 0.95);
  const g = envGain(drumBus, when, vel, 0.28, 0.004);
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(120, when);
  o.frequency.exponentialRampToValueAtTime(46, when + 0.09);
  o.connect(g); o.start(when); o.stop(when + 0.3);
}
function snareDust(when, vel) {
  if (sampler.ok) return drumSample('snare', drumBus, when, vel * 0.6);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 1700; bp.Q.value = 0.9; bp.connect(drumBus);
  const ng = envGain(bp, when, vel * 0.7, 0.16, 0.002);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(ng); n.start(when); n.stop(when + 0.2);
}
function hatTick(when, vel, open) {
  if (STYLE.drums === 'boombap' && sampler.ok) {
    return drumSample(open ? 'hatopen' : 'hat', drumBus, when, vel * 0.34);
  }
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
  hp.frequency.value = STYLE.drums === 'chip' ? 8000 : 7000;
  hp.connect(drumBus);
  const g = envGain(hp, when, vel * 0.25, open ? 0.3 : 0.04, 0.001);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + (open ? 0.35 : 0.06));
}
function chipKick(when, vel) {
  const g = envGain(drumBus, when, vel * 0.8, 0.15, 0.002);
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(160, when);
  o.frequency.exponentialRampToValueAtTime(50, when + 0.07);
  o.connect(g); o.start(when); o.stop(when + 0.18);
}
function chipSnare(when, vel) {
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
  hp.frequency.value = 1200; hp.connect(drumBus);
  const g = envGain(hp, when, vel * 0.4, 0.09, 0.001);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + 0.12);
}
function retroKick(when, vel) {
  const g = envGain(drumBus, when, vel, 0.3, 0.003);
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(100, when);
  o.frequency.exponentialRampToValueAtTime(40, when + 0.06);
  o.connect(g); o.start(when); o.stop(when + 0.32);
}
function gatedSnare(when, vel) {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 1500; bp.Q.value = 0.7; bp.connect(drumBus);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel * 0.55, when);
  g.gain.setValueAtTime(vel * 0.35, when + 0.16);
  g.gain.linearRampToValueAtTime(0.0001, when + 0.19);  // the gate slam
  g.connect(bp);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + 0.22);
}
function shaker(when, vel) {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 4500; bp.Q.value = 1; bp.connect(drumBus);
  const g = envGain(bp, when, vel * 0.18, 0.09, 0.01);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + 0.12);
}
function playRim(when, vel) {
  if (sampler.ok) return drumSample('rim', masterFilter, when, vel * 0.5);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
  hp.frequency.value = 3000; hp.connect(masterFilter);
  const g = envGain(hp, when, vel * 0.2, 0.03, 0.001);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + 0.04);
}
function playScratch(when) {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(2800, when);
  bp.frequency.exponentialRampToValueAtTime(320, when + 0.09);
  bp.connect(comp);
  const g = envGain(bp, when, 0.22, 0.1, 0.002);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  n.connect(g); n.start(when); n.stop(when + 0.12);
}

function scheduleDrums(pos, bar, t, act) {
  const d = density();
  switch (STYLE.drums) {
    case 'chip':
      if (pos === 0 || pos === 8) chipKick(t, 0.85);
      if (pos === 4 || pos === 12) chipSnare(t, 0.8);
      if (pos % 2 === 0) hatTick(t, 0.4);
      else if (act > 1.05 - d * 0.6) hatTick(t, 0.2);
      break;
    case 'retro':
      if (pos % 4 === 0) retroKick(t, 0.85);
      if (pos === 4 || pos === 12) gatedSnare(t, 0.8);
      if (pos % 4 === 2) hatTick(t, 0.4);
      break;
    case 'sparse':
      if (pos === 0 && bar % 2 === 0) kickBoom(t, 0.5);
      if (pos === 8) shaker(t, 0.5 + act * 0.3);
      break;
    default: // boombap
      { const kicks = bar % 2 ? [0, 6, 10] : [0, 10];
        if (kicks.includes(pos)) kickBoom(t, 0.85);
        if (pos === 4 || pos === 12) snareDust(t, 0.8);
        if (pos % 2 === 0) hatTick(t, pos % 4 === 0 ? 0.4 : 0.55);
        else if (act > 1.05 - d * 0.6) hatTick(t, 0.22); }
  }
}

/* ---------- transport / scheduler ---------- */
function swingDelay() { return (val('swingRange', 15) / 100) * P16; }

function scheduleSlot(s) {
  const pos = s % 16;
  const bar = Math.floor(s / 16);
  const chord = chordAt(s);
  const base = t0 + s * P16;
  const t = base + (s % 2 ? swingDelay() : 0);
  const act = smoothedAct;
  const chordStart = pos === 0 && bar % STYLE.bpc === 0;

  if (pos === 0) {
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
    const delta = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => {
      setChip('chordChip', NOTE_NAMES[(chord.root + keyOff) % 12] + chord.label);
    }, delta);
  }

  if (STYLE.harmony === 'arp' && pos % 2 === 0) {
    const tones = chord.tones;
    const tone = 60 + ((tones[(s / 2) % tones.length] + keyOff) % 12);
    playPulse(tone, 0.13 + act * 0.1, t, 0);
  }

  scheduleBass(chord, pos, bar, t, act);
  if (drumsOn) scheduleDrums(pos, bar, t, act);
}

function tick() {
  const ahead = ctx.currentTime + 0.15;
  while (t0 + slot * P16 < ahead) { scheduleSlot(slot); slot++; }

  const now = performance.now();
  keyTimes = keyTimes.filter(t => now - t < 12000);
  const recent = keyTimes.filter(t => now - t < 6000).length;
  const act = clamp(recent / 26, 0, 1);
  smoothedAct += (act - smoothedAct) * 0.08;

  drumBus.gain.setTargetAtTime(drumsOn ? Math.pow(smoothedAct, 1.15) * 0.9 : 0, ctx.currentTime, 0.8);
  masterFilter.frequency.setTargetAtTime(950 + smoothedAct * 1700, ctx.currentTime, 1.2);

  setChip('wpmChip', String(Math.round((keyTimes.length / 5) * (60 / 12))));
  const bars = Math.round(smoothedAct * 5);
  setChip('flowChip', '▮'.repeat(bars) + '·'.repeat(5 - bars));
  const cc = $('claudeChip');
  if (cc) {
    cc.textContent = claudeQueue.length > 0 ? 'playing' :
      (now - lastClaudeAt < 15000 && lastClaudeAt > 0) ? 'listening' : 'quiet';
    cc.classList.toggle('on', claudeQueue.length > 0);
  }

  for (const k of slotNotes.keys()) if (k < slot - 8) slotNotes.delete(k);
}

function anchorTransport() {
  t0 = ctx.currentTime + 0.15;
  slot = 0;
}
function startTransport() {
  anchorTransport();
  tickTimer = setInterval(tick, 25);
  running = true;
}

function setStyle(name) {
  STYLE = STYLES[name] || STYLES.lofi;
  SPB = 60 / STYLE.bpm;
  P16 = SPB / 4;
  if (started) {
    buildBed();
    if (running) anchorTransport();  // re-anchor the grid at the new tempo
  }
}

/* ---------- quantize & viz feed ---------- */
function quantized() {
  const now = ctx.currentTime;
  let n = Math.ceil((now + 0.012 - t0) / P16);
  let t = t0 + n * P16 + (n % 2 ? swingDelay() : 0);
  if (t < now + 0.005) { n++; t = t0 + n * P16 + (n % 2 ? swingDelay() : 0); }
  return { n, t };
}
function pushViz(midi, tier, vel, kind) {
  vizNotes.push({ born: performance.now(), midi, tier, vel, kind, x: Math.random() });
  if (vizNotes.length > 500) vizNotes.splice(0, vizNotes.length - 500);
}

/* ---------- user voice ---------- */
function handleChar(ch, shift) {
  const now = performance.now();
  const iki = now - lastKeyAt;
  lastKeyAt = now;
  keyTimes.push(now);
  const d = density();

  if (ch === '\b') {
    playScratch(ctx.currentTime + 0.005);
    pushViz(48, 2, 0.5, 'perc');
    return;
  }
  if (ch === ' ') {
    const { t } = quantized();
    hatTick(t, 0.25 + d * 0.35);
    lastWasBoundary = true;
    pushViz(90, 1, 0.3, 'perc');
    return;
  }
  if (ch === '\n') {
    const { n, t } = quantized();
    hatTick(t, 0.45, true);
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
    const rootPc = (chord.root + keyOff) % 12;
    let m = 60 + rootPc; if (m < 58) m += 12;
    m += CADENCE[ch];
    playMelody(m, ch === '!' ? 0.7 : 0.45, t + count * 0.033, 0);
    slotNotes.set(n, count + 1);
    lastWasBoundary = true;
    pushViz(m, 0, 0.5, 'note');
    return;
  }

  const isLetter = ch >= 'a' && ch <= 'z';
  const isDigit = ch >= '0' && ch <= '9';

  if (!isLetter && !isDigit) {
    playRim(t, 0.45);
    pushViz(92, 2, 0.25, 'perc');
    if ('{}[]()<>'.includes(ch)) {
      const rootPc = (chord.root + keyOff) % 12;
      playMelody(72 + rootPc + 2, 0.2, t, 2);
      pushViz(74 + rootPc, 2, 0.25, 'note');
    }
    lastWasBoundary = false;
    return;
  }

  const slotCap = d < 0.5 ? 3 : 4;
  if (count >= slotCap) return;

  const tier = tierFor(ch);
  const wordInitial = lastWasBoundary;
  wordCharIdx = wordInitial ? 0 : wordCharIdx + 1;
  lastWasBoundary = false;

  // density gate: mid-word common letters are the least informative notes —
  // thin them first (ghost them, or rest them entirely when sparse)
  if (!wordInitial && tier === 0 && !shift) {
    if (d < 0.34 && wordCharIdx % 2 === 1) return;
  }

  let midi;
  if (mapping === 'alpha' && isLetter) {
    midi = alphaMidi(ch);
    if (midi == null) return;
  } else {
    midi = geoMidi(ch, true);
    if (midi == null) return;
    midi = clamp(midi, 45, 88);
    midi = snapMidi(midi, allowedPcs(chord, tier));
  }

  let vel = 0.42;
  if (wordInitial) vel += 0.16;
  if (shift) vel += 0.14;
  if (!wordInitial && tier === 0 && !shift) vel = 0.12 + d * 0.22;
  if (iki < 90) vel *= 0.88;

  playMelody(midi, vel, t + count * 0.033, tier);
  slotNotes.set(n, count + 1);
  pushViz(midi, tier, vel, 'note');
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
    playClaude(72 + rootPc + CADENCE[ch], 0.4, t);
    pushViz(72 + rootPc + CADENCE[ch], 1, 0.35, 'claude');
    claudeBoundary = true;
    return;
  }
  const isLetter = ch >= 'a' && ch <= 'z';
  const isDigit = ch >= '0' && ch <= '9';
  if (!isLetter && !isDigit) {
    if (++claudeSymbolCount % 3 === 0) { playRim(t, 0.2); pushViz(93, 2, 0.15, 'perc'); }
    claudeBoundary = false;
    return;
  }

  const tier = tierFor(ch);
  const wordInitial = claudeBoundary;
  claudeWordIdx = wordInitial ? 0 : claudeWordIdx + 1;
  claudeBoundary = false;
  if (!wordInitial && tier === 0 && d < 0.5 && claudeWordIdx % 2 === 1) return;

  let midi = geoMidi(ch, false);
  if (midi == null) return;
  midi = clamp(midi + 12, 64, 96);
  midi = snapMidi(midi, allowedPcs(chord, tier));

  let vel = 0.32;
  if (wordInitial) vel += 0.12;

  playClaude(midi, vel, t);
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
if (pad) {
  pad.addEventListener('keydown', e => {
    if (demoTimer && !e.metaKey && !e.ctrlKey) stopDemo();
    if (tapLive) return;
    if (!running) {
      const musical = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter';
      const b = $('powerBtn');
      if (!started && musical && b && !e.metaKey && !e.ctrlKey) {
        b.click();               // typing IS the play button — a keydown is a valid audio gesture
      } else {
        if (musical && b) { b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge'); }
        return;                  // an explicit Pause stays paused
      }
    }
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Backspace') handleChar('\b', false);
    else if (e.key === 'Enter') handleChar('\n', false);
    else if (e.key === 'Tab') {
      e.preventDefault();
      const s = pad.selectionStart;
      pad.setRangeText('  ', s, pad.selectionEnd, 'end');
      handleChar('\t', false);
    }
    else if (e.key.length === 1) handleChar(e.key.toLowerCase(), e.shiftKey);
  });
  pad.addEventListener('input', e => {
    if (running && !tapLive && e.inputType === 'insertFromPaste') {
      const { n, t } = quantized();
      const chord = chordAt(n);
      voicingOf(chord).forEach((m, i) => {
        playStabTone(m + 12, 0.3, t + i * 0.05);
        pushViz(m + 12, 0, 0.4, 'note');
      });
    }
  });
}

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
    if (recorder && recorder.state === 'recording') toggleRec();
    stopDemo();
    powerBtn.textContent = 'Resume';
  } else {
    await ctx.resume();
    anchorTransport();               // resume clean at bar 1 (style/tempo may have changed)
    tickTimer = setInterval(tick, 25);
    running = true;
    powerBtn.textContent = 'Pause';
    if (pad) pad.focus();
  }
});

const styleSel = $('styleSel');
if (styleSel) styleSel.addEventListener('change', e => { setStyle(e.target.value); });
const keySel = $('keySel');
if (keySel) keySel.addEventListener('change', e => { keyOff = +e.target.value; });
const mapSel = $('mapSel');
if (mapSel) mapSel.addEventListener('change', e => { mapping = e.target.value; });
const drumsChk = $('drumsChk');
if (drumsChk) drumsChk.addEventListener('change', e => { drumsOn = e.target.checked; });
const claudeChk = $('claudeChk');
if (claudeChk) claudeChk.addEventListener('change', e => {
  claudeOn = e.target.checked;
  if (!claudeOn) claudeQueue.length = 0;
});
const volRange = $('volRange');
if (volRange) volRange.addEventListener('input', () => {
  if (masterGain) masterGain.gain.setTargetAtTime(volLevel(), ctx.currentTime, 0.1);
});
const crackleRange = $('crackleRange');
if (crackleRange) crackleRange.addEventListener('input', () => {
  if (crackleGain) crackleGain.gain.setTargetAtTime(cracLevel(), ctx.currentTime, 0.2);
});

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
  'the quick brown fox jams over a jazzy fourth chord. can you hear it?';
function stopDemo() {
  if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  const b = $('demoBtn'); if (b) b.textContent = 'Auto-type a demo';
}
const demoBtn = $('demoBtn');
if (demoBtn) demoBtn.addEventListener('click', () => {
  if (demoTimer) { stopDemo(); return; }
  if (!started) powerBtn.click();
  else if (!running) powerBtn.click();
  demoBtn.textContent = 'Stop the demo';
  let i = 0;
  const step = () => {
    if (i >= DEMO_TEXT.length) { stopDemo(); return; }
    const ch = DEMO_TEXT[i++];
    if (pad) { pad.value += ch; pad.scrollTop = pad.scrollHeight; }
    if (running) handleChar(ch === '\n' ? '\n' : ch.toLowerCase(), false);
    let d = 70 + Math.random() * 95;
    if (ch === ' ') d = 150 + Math.random() * 90;
    if ('.,?!;:'.includes(ch)) d = 330 + Math.random() * 150;
    if (ch === '\n') d = 620 + Math.random() * 250;
    if (Math.random() < 0.03) d += 500;
    demoTimer = setTimeout(step, d);
  };
  step();
});

/* ---------- visualization ---------- */
const viz = $('viz');
if (viz) {
  const vctx = viz.getContext('2d');
  const PRM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TIER_COLORS = ['#e2a65b', '#8fbdad', '#ce8398'];
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
    vctx.fillStyle = 'rgba(234,224,208,0.05)';
    vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
    const chip = $('chordChip');
    vctx.fillText(chip ? chip.textContent : '', W / 2, H / 2);

    if (running && ctx) {
      const beat = Math.floor(((ctx.currentTime - t0) / SPB) % 4);
      for (let b = 0; b < 4; b++) {
        vctx.fillStyle = b === beat ? 'rgba(226,166,91,0.85)' : 'rgba(234,224,208,0.12)';
        vctx.fillRect(12 + b * 14, H - 10, 8, 3);
      }
    }

    const now = performance.now();
    const fadeZone = Math.max(60, W * 0.18);
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
        vctx.fillStyle = 'rgba(138,123,108,' + (alpha * 0.7).toFixed(3) + ')';
        vctx.fillRect(x - 2, y - 2, 4, 4);
      } else if (nn.kind === 'claude') {
        vctx.beginPath();
        vctx.arc(x, y, 2.5 + nn.vel * 5, 0, Math.PI * 2);
        vctx.strokeStyle = '#8fbdad' + Math.round(alpha * 210).toString(16).padStart(2, '0');
        vctx.lineWidth = 1.4;
        vctx.stroke();
      } else {
        vctx.beginPath();
        vctx.arc(x, y, 2.5 + nn.vel * 5, 0, Math.PI * 2);
        vctx.fillStyle = TIER_COLORS[nn.tier] + Math.round(alpha * 210).toString(16).padStart(2, '0');
        vctx.fill();
      }
    }
    requestAnimationFrame(drawViz);
  };
  requestAnimationFrame(drawViz);
}

/* honor a pre-selected style if the select was set before engine load */
if (styleSel && styleSel.value && styleSel.value !== 'lofi') setStyle(styleSel.value);

return { connectStream, enqueueClaude };

})();
