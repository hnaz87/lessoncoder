'use strict';
const path = require('path');
const fs = require('fs');

// Minimal .env loader (no dependency): KEY=value lines, # comments.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const e = process.env;
module.exports = {
  port: parseInt(e.PORT || '3000', 10),
  dataDir: path.resolve(e.DATA_DIR || path.join(__dirname, '..', 'data')),
  sessionSecret: e.SESSION_SECRET || 'dev-secret',
  cookieSecure: e.COOKIE_SECURE === '1',
  geminiKey: e.GEMINI_API_KEY || '',
  geminiModel: e.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiThinking: e.GEMINI_THINKING || 'low',
  geminiTtsModel: e.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
  anthropicKey: e.ANTHROPIC_API_KEY || '',
  anthropicModel: e.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  openaiKey: e.OPENAI_API_KEY || '',
  ttsModel: e.OPENAI_TTS_MODEL || 'tts-1',
  // Which service writes lessons / speaks narration. Defaults to Gemini whenever a Gemini key is present.
  aiProvider: (e.AI_PROVIDER || (e.GEMINI_API_KEY ? 'gemini' : e.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini')).toLowerCase(),
  ttsProvider: (e.TTS_PROVIDER || (e.GEMINI_API_KEY ? 'gemini' : e.OPENAI_API_KEY ? 'openai' : 'gemini')).toLowerCase(),
  aiConcurrency: parseInt(e.AI_CONCURRENCY || '0', 10),
  aiDailyLimit: parseInt(e.AI_DAILY_LIMIT || '300', 10),
  disableSignup: e.DISABLE_SIGNUP === '1',
  sandboxMode: e.SANDBOX_MODE || 'socket',
  sandboxSocket: e.SANDBOX_SOCKET || '/sock/sandbox.sock',
  isProd: e.NODE_ENV === 'production'
};
if (module.exports.isProd && module.exports.sessionSecret === 'dev-secret') {
  console.error('Refusing to start: set SESSION_SECRET in production.');
  process.exit(1);
}
