# keystrokes

A lofi instrument for people who type. Keystrokes don't *choose* the music —
they steer a generative lofi engine that is always in key, always on the grid.
The typing supplies rhythm, contour, and energy; the music theory is baked in.

Two ways to play:

- **The website** — https://aetherwing-io.github.io/keystrokes/ (`index.html`):
  a page you type into. Sampled Rhodes, swung drums, vinyl crackle, all
  steered by your keys. Runs entirely in the browser; nothing is stored or
  sent anywhere. This is the demo for —
- **The session soundtrack** — `./start.sh`: system-wide. Your keys in any
  app become the lead voice; the characters Claude Code generates (in every
  session, across all your projects) become a second music-box voice, panned
  right and drawn as outlined dots. No queue, no track picking — the music of
  the work, as you work it.

(`keystrokes-lofi.html` is the original self-contained single-file version,
kept for the claude.ai artifact; the shared engine now lives in `engine.js`.)

## Quick start (session soundtrack)

```sh
./start.sh
```

First run creates a python venv and installs `pynput`. The script starts the
hub server, opens http://localhost:8123, and runs the key tap. Click **Start
the tape** on the page, then go work anywhere. Ctrl-C stops everything.

macOS will ask you to grant your terminal app the **Accessibility**
permission (System Settings → Privacy & Security → Accessibility) the first
time — the tap can't see keys without it, and notes will simply not play for
typing outside the page until you grant it.

## Architecture

```
your keys, any app          claude's characters
      │                            │
   tap.py (pynput)          ~/.claude/projects/**/*.jsonl
      │ udp :8124                  │ fs.watch tail (assistant text + tool_use code)
      ▼                            ▼
              server.mjs  (zero-dep node hub, 127.0.0.1 only)
                          │ SSE /events
                          ▼
              live.html   (Web Audio engine in a browser tab)
```

## Styles

The Style select swaps the whole vibe — instruments, tempo, chords, drums,
and background texture — while your keys keep steering:

| Style | Lead | Groove | Bed |
|---|---|---|---|
| **Lofi tape** | sampled Rhodes | 76 BPM boom-bap, swung | vinyl crackle |
| **Arcade (8-bit)** | pulse-wave chip lead | 112 BPM chip kit + chord arp | tape hiss |
| **Night drive** | detuned saw lead | 92 BPM four-on-floor, gated snare, octave bass | tape hiss |
| **Rainy day** | kalimba | 62 BPM near-still, chords every 2 bars, drone bass | rain |

**Density** controls how busy the melody gets: it thins mid-word common
letters first (the least informative notes) down to ghosts or rests.
Typing into the pad auto-starts the tape — no button needed.

## Telemetry you can feel

The local version doesn't just hear characters — it hears the *work*. Tool
activity in your Claude sessions becomes musical punctuation:

- a **Bash command running** is a low tape-motor rumble that stops when it exits
- an **error** brings in a suspended chord that *holds* until the next success
  resolves it onto the third — you can hear an unfixed build
- **tests** ring a two-note bell when they pass, scratch when they fail
- a **git commit** gets the full treatment: drum fill, tape splice, V→I cadence
- **file edits** stamp three quick ascending notes; **web fetches** sweep like
  a radio tuning

Anything else on your machine can join via the hub's event endpoint — e.g. a
git `post-commit` hook (in any repo: `.git/hooks/post-commit`, `chmod +x`):

```sh
#!/bin/sh
curl -s -XPOST localhost:8123/event -d '{"kind":"commit"}' >/dev/null 2>&1 || true
```

The "Telemetry" checkbox on the live page mutes all of it.

## The shelf — every session is a tape

Sessions journal themselves automatically as **sound events** (never text,
never keys): the local deck tapes to `~/.keystrokes/sessions/`, the website
tapes to your browser's IndexedDB. The shelf (`/shelf` locally,
`shelf.html` on the site) lists them as cassettes — auto-titled, cover art
drawn from the session's own notes — and re-renders any of them through the
same engine in an `OfflineAudioContext`, playable in place or exported as WAV.
Renders are re-performances from the score: notes exact, tape jitter fresh.
Single renders cap at 45 minutes; longer sessions render a chosen range.

## More seasoning

- **Sessions have form**: sustained flow earns a 16-bar chorus (octave-doubled
  lead, open hats, brighter filter) after a one-bar build; going idle composes
  a real outro — cadence, then the vinyl runout groove — and the next
  keystroke spins the tape back up.
- **Leitmotifs**: any word you type 4+ times becomes a quiet counter-melody
  echoed at chord changes, adapted to the current harmony. Your project's
  vocabulary writes its own theme.
- **The duet is real**: Claude notes landing within 350ms of yours harmonize
  a third above; typing `?` gets a three-note answer; when you idle to read,
  Claude's voice takes the lead.
- **Arcade combos**: keep a typing streak alive in Arcade style and
  the chip lead sprouts harmonies at 20, 50, and 100 — with pixel fireworks.
- **Circadian key**: pages open in a key that matches the hour — bright C
  mornings, G middays, A evenings, E♭ late nights (until you touch Key).
- **Play any text**: `?text=…` or `?gist=<id>` on the site loads any text as
  a performable track — every document has a song.

Engine behavior worth knowing:

- **Your voice** drives everything: drums and brightness follow *your*
  rolling activity, so the track builds when you're in flow and mellows to
  chords-and-crackle when you stop to read.
- **Claude's voice** is purely melodic — a soft music box an octave up,
  panned right. Message-sized bursts are paced out through a queue at a
  humanized typing rate; backlogs drain faster and are thinned rather than
  machine-gunned. It never drives the drums: when you idle while Claude
  generates, you're listening to Claude think, quietly.
- **Long sessions**: three chord progressions in the same key family rotate
  every 8 bars, and one bar in eight the piano lays out to breathe.

## Why this can sound good (the core insight)

Raw keystroke→pitch mappings sound like a cat on a piano: ~6 events/sec of
unquantized chromatic noise. The fix is to invert the responsibility:

- A **fixed lofi bed** (76 BPM, swung 16ths, a IVmaj9–iii7–ii9–vi9 loop,
  vinyl crackle) plays regardless of typing.
- Each keystroke **proposes** a note; the engine **quantizes** it to the next
  swung 16th and **snaps** it to pitches consonant with the current chord.
- Lofi is the ideal target genre because it is built on repetition, low
  information density, and forgiveness — wrong notes read as "jazzy."

## The mapping (v1)

| Signal | Musical meaning |
|---|---|
| Letter frequency (etaoin shrdlu) | Consonance tier. Common letters → chord tones; mid → pentatonic; rare (q, z, x, j) → color tones/tensions. Zipf's law becomes harmony: information content = dissonance. |
| Keyboard row | Register. Bottom row low, home row middle, top row high, number row sparkle. Home position = tonal home. |
| Column position in row | Scale degree (left→right across the diatonic scale), so physical contour = melodic contour. |
| Hand (left/right split) | Register split, like piano hands. Left-hand letters play an octave down; hand alternation in words creates call-and-response. |
| Inter-keystroke timing | Rhythm, quantized to swung 16ths. ≥4 notes landing in one slot become a strum; overflow is dropped (common letters first — they carry the least information). |
| Space | Hi-hat tick. Avg English word ≈ 4.7 letters, so the spacebar arrives with pulse-like regularity — it *is* the hi-hat. Also marks word boundaries → next letter gets an accent. |
| Punctuation | Cadences with speech prosody: `.` resolves to the root, `,` rests on the 5th, `?` rises to the 9th, `!` accents the octave. |
| Enter | Open-hat splash + bass octave (paragraph = phrase boundary). |
| Backspace | Record scratch. Regret, sonified. |
| Tab | Bass root note (code indentation grooves). |
| Code symbols `{}[]();` | Rim clicks; brackets add a quiet high 9th. Code sessions naturally sound percussive and sparse vs. prose. |
| Paste | A pasted block of text = a rolled block chord. |
| Typing speed (rolling WPM) | Arrangement. Drums fade in with flow, master lowpass opens up; idle decays back to chords + crackle. The track is flow-state biofeedback. |

Emergent property: common bigrams/words produce **recurring motifs**. "the"
is always the same 3-note cell — language statistics literally write the hooks.

## Prior art (the "does a notation exist?" question)

- **Guido d'Arezzo (~1026)** — mapped vowels of Latin text to pitches; the
  oldest text-to-music algorithm.
- **Musical cryptograms** — BACH motif, Shostakovich's DSCH; the French system
  extends the whole alphabet onto pitches. (The "Alphabet cryptogram" toggle
  in the prototype implements this raw, mostly to hear why chord-snapping matters.)
- **Morse code** — a rhythm notation per letter, frequency-optimized (E is the
  shortest). A possible future percussion layer.
- **Leroy Anderson, "The Typewriter" (1950)** — typewriter as solo instrument.
- **Typatone (Lullatone × Jono Brandel)** — letters → pentatonic notes by
  frequency; closest existing web toy, prose-oriented.
- **listen.hatnote / github.audio** — event-stream sonification (Wikipedia
  edits, GitHub events) as ambient music; proof that live data streams can be
  genuinely listenable.

Unexplored territory this project targets: live typing as a *performance
instrument* with code-awareness, flow-state arrangement, and long-session structure.

## The sample pack

`samples/` holds a rendered pack: 13 electric-piano notes (FM synthesis in
the DX7 EP tradition — two detuned carriers, a decaying FM index for the
"wah", a tine partial, key click) plus designed boom-bap drums. It is built
from source, so it's reproducible and license-clean (ours; do what you like):

```sh
node tools/make-samples.mjs
```

The engine treats the pack as ordinary WAVs mapped by `samples/manifest.json`
— swap any file for a real recording (e.g. a CC0 Rhodes from
[VCSL](https://github.com/sgossner/VCSL)) and update the manifest; nearest
sampled note wins and playback-rate covers the gaps. If samples can't be
fetched (offline, `file://`), the engine falls back to pure oscillators —
the "sound" chip shows `sampled` or `synth`.

## Roadmap

1. **Recorded instruments** — drop in a CC0 sampled Rhodes and dustier drum
   one-shots via the manifest (the loader already doesn't care).
2. **Offline renderer** — feed any text file / git diff / chat transcript;
   synthesize timing from a per-bigram typing model; render via
   `OfflineAudioContext` to WAV. Deterministic: same document → same song.
   Every commit gets a theme song.
3. **Menu-bar app** — fold tap + hub + engine into one Swift menu-bar app so
   there's no terminal window and no browser tab.
4. **More mappings** — Morse rhythm layer, vowel-length sustain (vowels ring,
   consonants tick — word melodies mirror phonology), per-language frequency
   tables.

## Privacy notes

- Everything binds to `127.0.0.1`; nothing is written to disk; keys become
  notes and are discarded.
- macOS blocks event taps during secure input, so password fields are
  automatically silent to the tap.
- Still: the key→note mapping is largely invertible. A *recording* of you
  typing a password (if some app doesn't use secure input) is, to a
  determined listener, the password. Be deliberate about when Rec is on.
