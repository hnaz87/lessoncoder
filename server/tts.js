'use strict';
/* AI narrator voice. Provider is chosen by TTS_PROVIDER (gemini | openai). Each sentence is cached on disk. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const VOICES = {
  gemini: ['Achird', 'Sulafat', 'Kore', 'Puck', 'Charon', 'Aoede', 'Leda', 'Iapetus'],
  openai: ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer']
};
const provider = () => config.ttsProvider === 'openai' ? 'openai' : 'gemini';
const voices = () => VOICES[provider()];
const configured = () => provider() === 'openai' ? !!config.openaiKey : !!config.geminiKey;

const dir = path.join(config.dataDir, 'tts');
fs.mkdirSync(dir, { recursive: true });
const inflight = new Map();

// Free-tier Gemini keys allow only a few requests per minute, so speech requests run two at a time.
let active = 0; const waiting = [];
async function slot(fn) {
  if (active >= 2) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; const next = waiting.shift(); if (next) next(); }
}

async function geminiSpeech(text, voice, speed) {
  const { geminiRequest } = require('./ai');
  const pace = speed < 0.95 ? ', speaking slowly' : speed > 1.05 ? ', at a brisk pace' : '';
  const data = await geminiRequest({
    model: config.geminiTtsModel,
    input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: 'warm, clear, encouraging teacher' + pace }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] }
  }, { label: 'Gemini TTS' });
  const audio = (data.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'audio').pop()
    || data.output_audio;
  if (!audio || !audio.data) throw Object.assign(new Error('Gemini TTS returned no audio.'), { code: 'tts_error' });
  let buf = Buffer.from(audio.data, 'base64');
  if (buf.slice(0, 4).toString() !== 'RIFF') buf = wavFromPcm(buf, 24000); // older models return raw PCM
  return { buf, ext: 'wav' };
}
async function openaiSpeech(text, voice, speed) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.openaiKey },
    body: JSON.stringify({ model: config.ttsModel, voice, input: text, speed, response_format: 'mp3' })
  });
  if (!res.ok) { let d = ''; try { d = (await res.json()).error?.message || ''; } catch {} throw Object.assign(new Error(`TTS error ${res.status}${d ? ': ' + d : ''}`), { code: res.status === 429 ? 'rate_limited' : 'tts_error' }); }
  return { buf: Buffer.from(await res.arrayBuffer()), ext: 'mp3' };
}
function wavFromPcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Returns the cached file name for (provider, voice, speed, text), generating it if needed.
async function speech(text, voice, speed = 1) {
  if (!configured()) {
    const key = provider() === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    throw Object.assign(new Error(`No ${key} is configured on the server.`), { code: 'tts_not_configured' });
  }
  const p = provider();
  const v = voices().includes(voice) ? voice : voices()[0];
  const sp = Math.min(1.4, Math.max(0.7, Number(speed) || 1));
  const model = p === 'openai' ? config.ttsModel : config.geminiTtsModel;
  const key = crypto.createHash('sha256').update([p, model, v, sp.toFixed(2), text].join('|')).digest('hex').slice(0, 40);
  for (const ext of ['wav', 'mp3']) if (fs.existsSync(path.join(dir, `${key}.${ext}`))) return `${key}.${ext}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = slot(async () => {
    const { buf, ext } = p === 'openai' ? await openaiSpeech(text, v, sp) : await geminiSpeech(text, v, sp);
    const file = path.join(dir, `${key}.${ext}`);
    fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file);
    return `${key}.${ext}`;
  });
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

module.exports = { speech, voices, configured, provider, dir, wavFromPcm };
