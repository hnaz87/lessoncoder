'use strict';
/* Client for the Python sandbox.
   socket       — talks to the sandbox container (no network, read-only FS, CPU/memory/process limits,
                  runs code as an unprivileged user). Recommended for every real deployment.
   local-unsafe — runs sandbox/runner on this machine with rlimits only. Development only.
   off          — Python execution disabled; videos fall back to the lesson's expected output. */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const MAX_CODE = 20000;

function viaSocket(code) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(config.sandboxSocket);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('Sandbox did not answer.'), { code: 'sandbox_timeout' })); }, 15000);
    sock.on('connect', () => sock.write(JSON.stringify({ code }) + '\n'));
    sock.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); sock.end(); try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); } } });
    sock.on('error', e => { clearTimeout(timer); reject(Object.assign(new Error('Sandbox unavailable: ' + e.message), { code: 'sandbox_unavailable' })); });
  });
}
function viaLocal(code) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [path.join(__dirname, '..', 'sandbox', 'server.py'), '--once'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('error', e => reject(Object.assign(new Error('Could not start python3: ' + e.message), { code: 'sandbox_unavailable' })));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(Object.assign(new Error('Sandbox runner failed.'), { code: 'sandbox_unavailable' })); } });
    p.stdin.end(JSON.stringify({ code }));
  });
}
async function run(code) {
  if (typeof code !== 'string' || !code.trim()) throw Object.assign(new Error('No code to run.'), { code: 'bad_request' });
  if (code.length > MAX_CODE) throw Object.assign(new Error('Code is too long.'), { code: 'bad_request' });
  if (config.sandboxMode === 'socket') return viaSocket(code);
  if (config.sandboxMode === 'local-unsafe') return viaLocal(code);
  throw Object.assign(new Error('Python execution is turned off on this server.'), { code: 'sandbox_off' });
}
async function available() {
  if (config.sandboxMode === 'off') return false;
  if (config.sandboxMode === 'local-unsafe') return true;
  try { const r = await viaSocket('print(1)'); return r && r.ok; } catch { return false; }
}
module.exports = { run, available };
