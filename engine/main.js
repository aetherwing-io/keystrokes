/* keystrokes main — the live page wiring. Owns page state (style, key,
 * transport, activity), the lookahead scheduler, the keystroke and Claude
 * character sources, controls, recording, demo, and the viz. All actual
 * sound comes from the audio engine factory in core.js.
 */
import {
  STYLES, NOTE_NAMES, mtof, clamp,
  createAudioEngine, fetchSamplePack, makeSampler, decodeSamplerInto,
} from './core.js';

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
let smoothedAct = 0;
let tapLive = false, lastClaudeAt = 0;
let claudeSymbolCount = 0, claudeBoundary = true, claudeWordIdx = 0;
const claudeQueue = [];
const slotNotes = new Map();
const vizNotes = [];
let demoTimer = null;

/* voice bindings — destructured from the engine factory at init */
let rhodesNote, playPulse, playSawLead, playKalimba, playMelodyOsc, playClaude,
    playStabTone, playPadChord, bassHit,
    kickBoom, snareDust, hatTick, chipKick, chipSnare, retroKick, gatedSnare,
    shaker, playRim, playScratch;

const sampler = makeSampler();
const rawPack = fetchSamplePack();   // network fetch starts at page load

const $ = id => document.getElementById(id);
const setChip = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const val = (id, dflt) => { const el = $(id); return el ? +el.value : dflt; };
const density = () => val('densRange', 50) / 100;
function volLevel() { return (val('volRange', 75) / 100) * 1.1; }
function cracLevel() { return (val('crackleRange', 45) / 100) * 0.16; }

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
}

/* ---------- melody dispatch ---------- */
function playMelody(midi, vel, when, tier) {
  midi += STYLE.leadOct;
  switch (STYLE.lead) {
    case 'pulse':   return playPulse(midi, vel, when, tier);
    case 'saw':     return playSawLead(midi, vel, when, tier);
    case 'kalimba': return playKalimba(midi, vel, when);
    default:        return rhodesNote(midi, vel, when, { tier, dur: 0.95 + tier * 0.25, cutoff: 1900, gainMul: 0.62 });
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
    default: // lofi
      if (pos === 0) bassHit(root, 0.5, t);
      if (pos === 10) bassHit(bar % 2 ? root + 7 : root, 0.38, t);
  }
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

  engine.drumBus.gain.setTargetAtTime(drumsOn ? Math.pow(smoothedAct, 1.15) * 0.9 : 0, ctx.currentTime, 0.8);
  engine.masterFilter.frequency.setTargetAtTime(950 + smoothedAct * 1700, ctx.currentTime, 1.2);

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
    engine.buildBed();
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
  if (engine) engine.setVolume(volLevel());
});
const crackleRange = $('crackleRange');
if (crackleRange) crackleRange.addEventListener('input', () => {
  if (engine) engine.setCrackle(cracLevel());
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

/* introspection for tests and debugging — no audio side effects */
function debug() {
  return {
    started, running,
    ctxState: ctx ? ctx.state : null,
    now: ctx ? ctx.currentTime : null,
    slot, style: STYLE.title, sampled: sampler.ok,
    act: Math.round(smoothedAct * 100) / 100,
    vizCount: vizNotes.length,
  };
}

window.KS = { connectStream, enqueueClaude, handleChar, debug };
export { connectStream, enqueueClaude, debug };
