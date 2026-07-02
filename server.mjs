#!/usr/bin/env node
/**
 * keystrokes hub — serves the live engine page and fans events into it.
 *
 *   browser page  <--SSE--  this server  <--UDP:8124--  tap.py (your keys)
 *                                        <--fs.watch--  ~/.claude/projects/*.jsonl (Claude's characters)
 *
 * Zero dependencies. Binds to 127.0.0.1 only. Nothing is logged or stored;
 * events flow through memory and are gone.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
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
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
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
