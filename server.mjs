#!/usr/bin/env node
/**
 * keystrokes hub — serves the live engine page and fans events into it.
 *
 *   browser page  <--SSE--  this server  <--UDP:8124--  tap.py (your keys)
 *                                        <--fs.watch--  ~/.claude/projects/*.jsonl (Claude's characters)
 *
 * Zero dependencies. Binds to 127.0.0.1 only. Keystrokes and characters flow
 * through memory and are gone. The one thing persisted is the session journal
 * (POST /journal → ~/.keystrokes/sessions): resolved SOUND events for the
 * shelf to replay — never text, never keys.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.KEYSTROKES_PORT || 8123);
const UDP_PORT = Number(process.env.KEYSTROKES_UDP || 8124);
const WATCH = process.env.KEYSTROKES_WATCH || path.join(os.homedir(), '.claude', 'projects');
const ROOT = path.dirname(new URL(import.meta.url).pathname);

/* ---------- SSE hub ---------- */
const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(line);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

/* ---------- http ---------- */
const STATIC = {
  '/': ['live.html', 'text/html; charset=utf-8'],
  '/live': ['live.html', 'text/html; charset=utf-8'],
  '/toy': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/shelf': ['shelf.html', 'text/html; charset=utf-8'],
  '/shelf.html': ['shelf.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 1500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, listeners: clients.size }));
    return;
  }
  if (u === '/journal' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let out = { ok: false };
      try { out = await acceptJournal(JSON.parse(body)); } catch { /* bad batch */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (u === '/sessions' && req.method === 'GET') {
    listSessions().then(list => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    });
    return;
  }
  {
    const m = u.match(/^\/sessions\/([\w.-]+)$/);
    if (m && SID_RE.test(m[1])) {
      const file = path.join(SESS_DIR, m[1] + '.jsonl');
      if (req.method === 'GET') {
        if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'DELETE') {
        // soft delete: rename out of sight, never destroy
        try { fs.renameSync(file, file + '.trashed'); } catch { /* already gone */ }
        try { fs.renameSync(path.join(SESS_DIR, m[1] + '.meta.json'),
                            path.join(SESS_DIR, m[1] + '.meta.json.trashed')); } catch { /* fine */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
    }
  }
  if (u === '/event' && req.method === 'POST') {
    // generic external event intake (e.g. a git post-commit hook):
    //   curl -s -XPOST localhost:8123/event -d '{"kind":"commit"}'
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        broadcast({
          src: 'ext',
          kind: String(j.kind || 'event').slice(0, 24),
          ok: j.ok !== false,
          label: typeof j.label === 'string' ? j.label.slice(0, 64) : undefined,
        });
      } catch { /* malformed body — ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  let file = null, type = null;
  if (STATIC[u]) {
    [file, type] = STATIC[u];
  } else if (/^\/samples\/[a-z0-9._-]+$/i.test(u)) {
    file = u.slice(1);
    type = u.endsWith('.json') ? 'application/json' : 'audio/wav';
  } else if (/^\/engine\/[a-z0-9._-]+\.js$/i.test(u)) {
    file = u.slice(1);
    type = 'text/javascript; charset=utf-8';
  }
  if (file) {
    fs.readFile(path.join(ROOT, file), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`keystrokes hub  →  http://localhost:${PORT}`);
  console.log(`key tap in on   →  udp://127.0.0.1:${UDP_PORT}`);
  console.log(`claude tail on  →  ${WATCH}`);
});

/* ---------- keystroke tap (UDP in) ---------- */
const udp = dgram.createSocket('udp4');
udp.on('message', buf => {
  try {
    const msg = JSON.parse(buf.toString('utf8'));
    if (typeof msg.ch === 'string' && msg.ch.length <= 2) {
      broadcast({ src: 'you', ch: msg.ch });
    }
  } catch { /* malformed datagram — drop it */ }
});
udp.bind(UDP_PORT, '127.0.0.1');

/* ---------- session journal storage ---------- */
const SESS_DIR = path.join(os.homedir(), '.keystrokes', 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });
const SID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9]{4}$/;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const writeChains = new Map();   // sid -> promise chain (appends never interleave)
const sessMeta = new Map();      // sid -> meta (mirrors the sidecar)

function metaPath(sid) { return path.join(SESS_DIR, sid + '.meta.json'); }
function sessPath(sid) { return path.join(SESS_DIR, sid + '.jsonl'); }

async function acceptJournal(j) {
  if (!j || !SID_RE.test(String(j.sid)) || !Array.isArray(j.events)) return { ok: false };
  const sid = j.sid;
  const seq = Number(j.seq) || 0;
  let meta = sessMeta.get(sid);
  if (!meta) {
    try { meta = JSON.parse(await fsp.readFile(metaPath(sid), 'utf8')); } catch { meta = null; }
    meta ??= { events: 0, lastT: 0, lastSeq: 0, peakEpm: 0, bytes: 0,
               startedWall: j.header?.startedWall || Date.now(),
               style: j.header?.style || 'lofi', key: j.header?.key || 0,
               buckets: {} };
    sessMeta.set(sid, meta);
  }
  if (seq <= meta.lastSeq) return { ok: true, dup: true };
  if (meta.bytes > MAX_SESSION_BYTES) return { ok: false, full: true };

  let lines = '';
  if (j.header && meta.events === 0) lines += JSON.stringify(j.header) + '\n';
  for (const ev of j.events.slice(0, 5000)) {
    lines += JSON.stringify(ev) + '\n';
    if (typeof ev.t === 'number') {
      if (ev.t > meta.lastT) meta.lastT = ev.t;
      const b = Math.floor(ev.t / 60);
      meta.buckets[b] = (meta.buckets[b] || 0) + 1;
      if (meta.buckets[b] > meta.peakEpm) meta.peakEpm = meta.buckets[b];
      // keep only recent buckets so meta stays tiny
      for (const k of Object.keys(meta.buckets)) if (+k < b - 3) delete meta.buckets[k];
    }
  }
  meta.events += j.events.length;
  meta.bytes += lines.length;
  meta.lastSeq = seq;

  const chain = (writeChains.get(sid) || Promise.resolve())
    .then(() => fsp.appendFile(sessPath(sid), lines))
    .then(() => fsp.writeFile(metaPath(sid), JSON.stringify({ ...meta, buckets: undefined })))
    .catch(() => {});
  writeChains.set(sid, chain);
  await chain;
  return { ok: true };
}

async function listSessions() {
  let files = [];
  try { files = await fsp.readdir(SESS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.slice(0, -6);
    if (!SID_RE.test(sid)) continue;
    let meta = sessMeta.get(sid);
    if (!meta) {
      try { meta = JSON.parse(await fsp.readFile(metaPath(sid), 'utf8')); } catch { meta = null; }
    }
    let bytes = 0;
    try { bytes = (await fsp.stat(sessPath(sid))).size; } catch { /* vanished */ }
    out.push({
      id: sid,
      startedWall: meta?.startedWall || 0,
      style: meta?.style || 'lofi',
      key: meta?.key || 0,
      duration: meta?.lastT || 0,
      events: meta?.events || 0,
      peakEpm: meta?.peakEpm || 0,
      bytes,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/* ---------- Claude transcript tailer ---------- */
const offsets = new Map();   // file path -> bytes already consumed
const partials = new Map();  // file path -> trailing partial line
const pending = new Map();   // file path -> debounce timer

function listJsonl(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// start from "now": existing history is not replayed
for (const f of listJsonl(WATCH)) {
  try { offsets.set(f, fs.statSync(f).size); } catch { /* vanished */ }
}

/* tool telemetry: pair tool_use (assistant lines) with tool_result (user lines)
 * so the engine can hear starts, successes, errors, tests, and commits. */
const pendingTools = new Map();   // fileKey -> Map(tool_use_id -> {name, cmd})
let lastTelemAt = 0;
const TELEM_MIN_GAP = 250;        // ms between low-priority telemetry events

function extractEvents(line, fkey) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  const events = [];
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const item of obj.message.content) {
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        events.push({ src: 'claude', text: item.text.slice(0, 1500), code: false });
      } else if (item.type === 'tool_use' && item.input && typeof item.input === 'object') {
        const t = item.input.new_string ?? item.input.content ?? item.input.command ?? '';
        if (typeof t === 'string' && t.trim()) {
          events.push({ src: 'claude', text: t.slice(0, 1200), code: true });
        }
        if (item.id && item.name) {
          let m = pendingTools.get(fkey);
          if (!m) { m = new Map(); pendingTools.set(fkey, m); }
          m.set(item.id, {
            name: item.name,
            cmd: typeof item.input.command === 'string' ? item.input.command : '',
          });
          if (m.size > 40) m.delete(m.keys().next().value);
          events.push({ src: 'claude', kind: 'tool', phase: 'start', tool: item.name, f: fkey });
        }
      }
    }
  } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
    for (const item of obj.message.content) {
      if (item && item.type === 'tool_result' && item.tool_use_id) {
        const m = pendingTools.get(fkey);
        const info = m && m.get(item.tool_use_id);
        if (!info) continue;
        m.delete(item.tool_use_id);
        const isBash = info.name === 'Bash' || /(^|__)bash$/i.test(info.name);
        events.push({
          src: 'claude', kind: 'tool', phase: 'end', tool: info.name, f: fkey,
          ok: item.is_error !== true,
          test: isBash && /\btest\b/i.test(info.cmd),
          commit: isBash && /\bgit commit\b/.test(info.cmd),
        });
      }
    }
  }
  return events;
}

function flushFile(f) {
  pending.delete(f);
  let size;
  try { size = fs.statSync(f).size; } catch { return; }
  let offset = offsets.get(f) ?? 0;
  if (size <= offset) { offsets.set(f, size); return; }
  // a file first seen with a huge backlog: skip to the end rather than flooding
  if (size - offset > 512 * 1024) { offsets.set(f, size); partials.set(f, ''); return; }

  const buf = Buffer.alloc(size - offset);
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, buf.length, offset);
  } catch { return; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  offsets.set(f, size);

  const chunk = (partials.get(f) || '') + buf.toString('utf8');
  const lines = chunk.split('\n');
  partials.set(f, lines.pop() || '');

  const fkey = path.basename(f, '.jsonl').slice(0, 8);
  let emitted = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const ev of extractEvents(line, fkey)) {
      if (ev.kind === 'tool') {
        // errors, tests, and commits always pass; routine start/ok ticks are throttled
        const important = ev.phase === 'end' && (!ev.ok || ev.test || ev.commit);
        const now = Date.now();
        if (!important && now - lastTelemAt < TELEM_MIN_GAP) continue;
        lastTelemAt = now;
        broadcast(ev);
      } else {
        if (emitted >= 30) continue;   // one flush shouldn't flood the char queue
        emitted++;
        broadcast(ev);
      }
    }
  }
}

try {
  fs.watch(WATCH, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return;
    const f = path.join(WATCH, filename);
    if (pending.has(f)) return;
    pending.set(f, setTimeout(() => flushFile(f), 60));
  });
} catch (err) {
  console.log(`(claude tail disabled: cannot watch ${WATCH}: ${err.message})`);
}
