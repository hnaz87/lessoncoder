'use strict';
// WebM → MP4 conversion with ffmpeg (H.264 + AAC, faststart) for browsers that can only record WebM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const config = require('./config');

const tmp = path.join(config.dataDir, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
let hasFfmpeg = null;
function available() {
  if (hasFfmpeg === null) { try { hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0; } catch { hasFfmpeg = false; } }
  return hasFfmpeg;
}
let running = 0;
async function toMp4(buffer) {
  if (!available()) throw Object.assign(new Error('ffmpeg is not installed on the server.'), { code: 'ffmpeg_missing' });
  if (running >= 2) throw Object.assign(new Error('The converter is busy. Try again in a minute.'), { code: 'rate_limited' });
  running++;
  const id = crypto.randomBytes(8).toString('hex');
  const inp = path.join(tmp, id + '.webm'), out = path.join(tmp, id + '.mp4');
  try {
    fs.writeFileSync(inp, buffer);
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inp, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
      let err = ''; p.stderr.on('data', d => err += d);
      const t = setTimeout(() => p.kill('SIGKILL'), 30 * 60 * 1000);
      p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(Object.assign(new Error('ffmpeg failed: ' + err.slice(-400)), { code: 'convert_failed' })); });
    });
    return fs.readFileSync(out);
  } finally {
    running--;
    for (const f of [inp, out]) fs.rm(f, { force: true }, () => {});
  }
}
module.exports = { toMp4, available };
