/* keystrokes core — context-independent music constants plus the injectable
 * audio engine factory. Everything here works against ANY BaseAudioContext:
 * the live AudioContext on the playing pages, or an OfflineAudioContext when
 * the shelf re-renders a journaled session. No DOM, no live-page state.
 */
'use strict';

/* ---------- music constants ---------- */
export const NOTE_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- styles ----------
 * bpc: bars per chord. harmony: stab | pad | padlong | arp.
 * lead voices: rhodes (sampled) | pulse | saw | kalimba.
 */
export const STYLES = {
  lofi: {
    title: 'Lofi tape', bpm: 76, bpc: 1, leadOct: 0,
    lead: 'rhodes', harmony: 'stab', bass: 'lofi', drums: 'boombap', bed: 'vinyl',
    chorusProg: [ // the royal road, one chord a bar — the earned lift
      { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
      { label: '13',   root: 7, tones: [7, 11, 5, 4] },
      { label: 'm7',   root: 4, tones: [4, 7, 11, 2] },
      { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
    ],
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
    chorusProg: [ // I - IV - V - I, the victory lap
      { label: '', root: 0, tones: [0, 4, 7] },
      { label: '', root: 5, tones: [5, 9, 0] },
      { label: '', root: 7, tones: [7, 11, 2] },
      { label: '', root: 0, tones: [0, 4, 7] },
    ],
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
    chorusProg: [ // VI - VII - i - i, foot down
      { label: 'maj7', root: 5, tones: [5, 9, 0, 4] },
      { label: '7',    root: 7, tones: [7, 11, 2, 5] },
      { label: 'm7',   root: 9, tones: [9, 0, 4, 7] },
      { label: 'm7',   root: 9, tones: [9, 0, 4, 7] },
    ],
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
    chorusProg: [ // the sun through the clouds, briefly
      { label: 'maj9', root: 0, tones: [0, 4, 7, 11, 2] },
      { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
      { label: 'm9',   root: 9, tones: [9, 0, 4, 7, 11] },
      { label: 'maj9', root: 5, tones: [5, 9, 0, 4, 7] },
    ],
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

/* ---------- sample pack ---------- */
export function fetchSamplePack() {
  return (async () => {
    const man = await (await fetch('samples/manifest.json')).json();
    const get = async f => await (await fetch('samples/' + f)).arrayBuffer();
    const rhodes = await Promise.all(
      Object.entries(man.rhodes).map(async ([m, f]) => [+m, await get(f)]));
    const drums = await Promise.all(
      Object.entries(man.drums).map(async ([k, f]) => [k, await get(f)]));
    return { rhodes, drums };
  })().catch(() => null);
}

export function makeSampler() {
  return { ok: false, rhodes: new Map(), keys: [], drums: {} };
}

/* Decode a fetched pack into a sampler against the given context.
 * ArrayBuffers are sliced per decode (decodeAudioData detaches its input),
 * so one fetched pack can feed many contexts (live + every offline render). */
export async function decodeSamplerInto(actx, sampler, rawOrPromise) {
  const raw = await rawOrPromise;
  if (!raw) return false;
  try {
    for (const [m, ab] of raw.rhodes) sampler.rhodes.set(m, await actx.decodeAudioData(ab.slice(0)));
    for (const [k, ab] of raw.drums) sampler.drums[k] = await actx.decodeAudioData(ab.slice(0));
    sampler.keys = [...sampler.rhodes.keys()].sort((a, b) => a - b);
    sampler.ok = true;
    return true;
  } catch {
    return false;
  }
}

/* ---------- the audio engine factory ----------
 * opts: {
 *   sampler:    sampler object (may flip .ok later — voices check per call)
 *   getStyle:   () => current style object (bed + drum-flavor reads)
 *   getCrackle: () => bed gain 0..~0.16
 * }
 */
export function createAudioEngine(actx, opts) {
  const ctx = actx;
  const sampler = opts.sampler;

  /* ----- master chain: [voices] → duckBus → masterFilter → sat → comp → masterGain ----- */
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 4;
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.825;
  const masterFilter = ctx.createBiquadFilter();
  masterFilter.type = 'lowpass'; masterFilter.frequency.value = 1100; masterFilter.Q.value = 0.4;

  // tape saturation: gentle tanh curve between the filter and the compressor
  const sat = ctx.createWaveShaper();
  {
    const K = 1.3, N = 1024, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(K * x) / Math.tanh(K);
    }
    sat.curve = curve;
    sat.oversample = '2x';
  }

  masterFilter.connect(sat); sat.connect(comp);
  comp.connect(masterGain); masterGain.connect(ctx.destination);

  const drumBus = ctx.createGain(); drumBus.gain.value = 0; drumBus.connect(masterFilter);

  // sidechain: melodic voices + bed duck under the kick
  const duckBus = ctx.createGain(); duckBus.gain.value = 1; duckBus.connect(masterFilter);
  const crackleDuck = ctx.createGain(); crackleDuck.gain.value = 1; crackleDuck.connect(comp);
  function duck(when) {
    for (const g of [duckBus.gain, crackleDuck.gain]) {
      g.setTargetAtTime(0.62, when, 0.015);
      g.setTargetAtTime(1.0, when + 0.09, 0.11);
    }
  }

  // one shared reverb: synthesized impulse, wet path runs through the master filter
  const reverbSend = ctx.createGain(); reverbSend.gain.value = 0.13;
  const convolver = ctx.createConvolver();
  {
    const len = Math.floor(ctx.sampleRate * 1.8);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        y += 0.22 * ((Math.random() * 2 - 1) - y);   // darkened tail — a warm room, not a stairwell
        d[i] = y * Math.exp(-t / 0.55) * 1.6;
      }
    }
    convolver.buffer = ir;
  }
  reverbSend.connect(convolver); convolver.connect(masterFilter);

  const wobble = ctx.createGain(); wobble.gain.value = 6;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.45; lfo.connect(wobble); lfo.start();

  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  {
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  /* ----- background texture (the bed) ----- */
  let crackleGain = null;
  let bedSources = [];
  function buildBed(at) {
    const when = at ?? ctx.currentTime;
    // crossfade: the old weather takes a couple of seconds to clear
    bedSources.forEach(s => { try { s.stop(when + 2.5); } catch { /* already stopped */ } });
    bedSources = [];
    if (crackleGain) {
      crackleGain.gain.setTargetAtTime(0.0001, when, 0.5);
    }
    crackleGain = ctx.createGain();
    crackleGain.gain.setValueAtTime(0.0001, when);
    crackleGain.gain.setTargetAtTime(opts.getCrackle(), when, 0.6);
    crackleGain.connect(crackleDuck);

    const noiseLayer = (lpHz, hpHz, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpHz;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(crackleGain);
      src.start(when); bedSources.push(src);
    };
    const popLayer = (count, type, freq, gain) => {
      const len = ctx.sampleRate * 4;
      const pb = ctx.createBuffer(1, len, ctx.sampleRate);
      const pd = pb.getChannelData(0);
      for (let n = 0; n < count; n++) {
        const atS = Math.floor(Math.random() * (len - 200));
        const amp = 0.25 + Math.random() * 0.75;
        const w = 2 + Math.floor(Math.random() * 5);
        for (let j = 0; j < w * 12; j++) {
          pd[atS + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / (w * 3));
        }
      }
      const pops = ctx.createBufferSource();
      pops.buffer = pb; pops.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = gain;
      pops.connect(f); f.connect(g); g.connect(crackleGain);
      pops.start(when); bedSources.push(pops);
    };

    switch (opts.getStyle().bed) {
      case 'vinyl':
        noiseLayer(4200, 60, 0.012);
        popLayer(42, 'highpass', 500, 0.5);
        break;
      case 'rain': {
        // rain is HIGH: drops on glass hiss up around 2-8k, patter is bright and irregular
        noiseLayer(7000, 1400, 0.045);
        popLayer(220, 'highpass', 1800, 0.22);   // the patter
        popLayer(45, 'highpass', 900, 0.42);     // closer, fatter drops
        const gust = ctx.createOscillator();
        gust.frequency.value = 0.07;              // slow swells, like wind driving the rain
        const gustGain = ctx.createGain();
        gustGain.gain.value = opts.getCrackle() * 0.35;
        gust.connect(gustGain); gustGain.connect(crackleGain.gain);
        gust.start(when); bedSources.push(gust);
        break;
      }
      case 'hiss':
      default:
        noiseLayer(6000, 100, 0.014);
        break;
    }
  }

  /* ----- voice helpers ----- */
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
    pan.connect(duckBus);
    pan.connect(reverbSend);
    return pan;
  }

  /* ----- lead voices ----- */
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
    g.gain.setValueAtTime(peak * 0.35, when);          // round the attack — felt, not struck
    g.gain.linearRampToValueAtTime(peak, when + 0.015);
    g.gain.setValueAtTime(peak, when + dur * 0.55);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = o.cutoff ?? 1900;
    src.connect(g); g.connect(lp); lp.connect(panner(midi, o.panBias));
    src.start(when);
    src.stop(when + dur + 0.05);
  }
  function playPulse(midi, vel, when, tier) {
    const dur = 0.16 + (tier || 0) * 0.05;
    const g = envGain(panner(midi, -0.08), when, vel * 0.22, dur + 0.05, 0.004);
    const o = ctx.createOscillator();
    o.type = 'square';
    const f = mtof(midi);
    o.frequency.setValueAtTime(f * 0.94, when);          // tiny chip pitch-blip
    o.frequency.linearRampToValueAtTime(f, when + 0.03);
    o.connect(g); o.start(when); o.stop(when + dur + 0.1);
  }
  function playSawLead(midi, vel, when, tier) {
    const dur = 0.5 + (tier || 0) * 0.15;
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
  function playMelodyOsc(midi, vel, when, tier) {
    const dur = 0.85 + (tier || 0) * 0.25;
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
    pan.connect(duckBus); pan.connect(reverbSend);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    lp.connect(pan);
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

  /* ----- harmony voices ----- */
  function playStabTone(midi, vel, when) {
    if (sampler.ok) {
      rhodesNote(midi, vel, when, { dur: 2.6, cutoff: 1250, panBias: 0.12, gainMul: 0.8 });
      return;
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1250;
    lp.connect(duckBus); lp.connect(reverbSend);
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
      lp.connect(duckBus);
      const send = ctx.createGain(); send.gain.value = 0.5;
      lp.connect(send); send.connect(reverbSend);
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

  /* ----- bass ----- */
  function bassHit(midi, vel, when, o = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = o.cutoff ?? 420;
    lp.connect(duckBus);
    const g = envGain(lp, when, vel, o.dur ?? 0.8, 0.012);
    const o1 = ctx.createOscillator(); o1.type = o.wave ?? 'sine'; o1.frequency.value = mtof(midi);
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = mtof(midi);
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    o1.connect(g); o2.connect(g2); g2.connect(g);
    o1.start(when); o2.start(when);
    stopAll(when + (o.dur ?? 0.8) + 0.1, o1, o2);
  }

  /* ----- drums ----- */
  function drumSample(name, dest, when, gain) {
    const src = ctx.createBufferSource();
    src.buffer = sampler.drums[name];
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(dest); src.start(when);
  }
  function kickBoom(when, vel) {
    duck(when);
    if (sampler.ok) return drumSample('kick', drumBus, when, vel * 0.95);
    const g = envGain(drumBus, when, vel, 0.28, 0.004);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, when);
    o.frequency.exponentialRampToValueAtTime(46, when + 0.09);
    o.connect(g); o.start(when); o.stop(when + 0.3);
  }
  function snareDust(when, vel) {
    if (sampler.ok) {
      drumSample('snare', drumBus, when, vel * 0.6);
      drumSample('snare', reverbSend, when, vel * 0.25);
      return;
    }
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 1700; bp.Q.value = 0.9;
    bp.connect(drumBus); bp.connect(reverbSend);
    const ng = envGain(bp, when, vel * 0.7, 0.16, 0.002);
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    n.connect(ng); n.start(when); n.stop(when + 0.2);
    const tg = envGain(drumBus, when, vel * 0.35, 0.08, 0.002);
    const t = ctx.createOscillator(); t.type = 'sine'; t.frequency.value = 185;
    t.connect(tg); t.start(when); t.stop(when + 0.1);
  }
  function hatTick(when, vel, open) {
    if (opts.getStyle().drums === 'boombap' && sampler.ok) {
      return drumSample(open ? 'hatopen' : 'hat', drumBus, when, vel * 0.34);
    }
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    hp.frequency.value = opts.getStyle().drums === 'chip' ? 8000 : 7000;
    hp.connect(drumBus);
    const g = envGain(hp, when, vel * 0.25, open ? 0.3 : 0.04, 0.001);
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    n.connect(g); n.start(when); n.stop(when + (open ? 0.35 : 0.06));
  }
  function chipKick(when, vel) {
    duck(when);
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
    duck(when);
    const g = envGain(drumBus, when, vel, 0.3, 0.003);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(100, when);
    o.frequency.exponentialRampToValueAtTime(40, when + 0.06);
    o.connect(g); o.start(when); o.stop(when + 0.32);
  }
  function gatedSnare(when, vel) {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 1500; bp.Q.value = 0.7;
    bp.connect(drumBus); bp.connect(reverbSend);
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
    const tg = envGain(masterFilter, when, vel * 0.15, 0.03, 0.001);
    const t = ctx.createOscillator(); t.type = 'sine'; t.frequency.value = 1100;
    t.connect(tg); t.start(when); t.stop(when + 0.04);
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

  return {
    ctx, comp, masterGain, masterFilter, drumBus, wobble, noiseBuf, reverbSend,
    buildBed,
    setVolume(v) { masterGain.gain.setTargetAtTime(v, ctx.currentTime, 0.1); },
    setCrackle(v) { if (crackleGain) crackleGain.gain.setTargetAtTime(v, ctx.currentTime, 0.2); },
    setCrackleAt(v, at) { if (crackleGain) crackleGain.gain.setTargetAtTime(v, at, 0.2); },
    voices: {
      rhodesNote, playPulse, playSawLead, playKalimba, playMelodyOsc, playClaude,
      playStabTone, playPadChord, bassHit,
      kickBoom, snareDust, hatTick, chipKick, chipSnare, retroKick, gatedSnare,
      shaker, playRim, playScratch,
    },
  };
}
