'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const usage = require('./usage');
const ai = require('./ai');
const tts = require('./tts');
const sandbox = require('./sandbox');
const convert = require('./convert');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cookieParser());
app.use(auth.loadUser);

const json = express.json({ limit: '2mb' });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { code: 'rate_limited', message: 'Too many attempts. Wait a few minutes.' } });
const perUser = (limit, windowMs = 60 * 1000) => rateLimit({ windowMs, limit, keyGenerator: req => req.user ? req.user.id : req.ip, standardHeaders: true, legacyHeaders: false, message: { code: 'rate_limited', message: 'Too many requests right now. Wait a minute, then try again.' } });

const fail = (res, e, status) => {
  const map = { unauthorized: 401, rate_limited: 429, quota: 429, bad_request: 400, invalid_json: 422, ai_not_configured: 503, tts_not_configured: 503, sandbox_off: 503, sandbox_unavailable: 503, ffmpeg_missing: 503 };
  res.status(status || map[e.code] || 500).json({ code: e.code || 'server_error', message: e.message || 'Server error', text: e.text });
};

/* ---- config & auth ---- */
let sandboxOk = null, sandboxCheckedAt = 0;
app.get('/api/config', async (req, res) => {
  if (Date.now() - sandboxCheckedAt > 60000) { sandboxCheckedAt = Date.now(); sandboxOk = await sandbox.available(); }
  res.json({
    user: auth.publicUser(req.user),
    ai: ai.configured(), aiProvider: ai.provider(),
    aiConcurrency: config.aiConcurrency || (ai.provider() === 'gemini' ? 2 : 3),
    tts: tts.configured(), ttsProvider: tts.provider(), voices: tts.voices(),
    sandbox: sandboxOk, ffmpeg: convert.available(), signup: !config.disableSignup
  });
});
app.post('/api/auth/signup', authLimiter, json, (req, res) => auth.signup(req, res).catch(e => fail(res, e)));
app.post('/api/auth/login', authLimiter, json, (req, res) => auth.login(req, res).catch(e => fail(res, e)));
app.post('/api/auth/logout', (req, res) => auth.logout(req, res));
app.patch('/api/me', auth.requireUser, json, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100), org = String(req.body?.org ?? '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ code: 'bad_name', message: 'Enter your name.' });
  db.prepare('UPDATE users SET name = ?, org = ? WHERE id = ?').run(name, org, req.user.id);
  res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

/* ---- lessons ---- */
const idOk = s => typeof s === 'string' && /^[A-Za-z0-9_\-]{3,64}$/.test(s);
app.get('/api/lessons', auth.requireUser, (req, res) => {
  const rows = db.prepare('SELECT id, json FROM lessons WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  res.json({ lessons: rows.map(r => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean) });
});
app.put('/api/lessons/:id', auth.requireUser, json, (req, res) => {
  const id = req.params.id, lesson = req.body && req.body.lesson;
  if (!idOk(id) || !lesson || typeof lesson !== 'object' || lesson.id !== id) return res.status(400).json({ code: 'bad_request', message: 'Invalid lesson.' });
  const owner = db.prepare('SELECT user_id FROM lessons WHERE id = ?').get(id);
  if (owner && owner.user_id !== req.user.id) return res.status(404).json({ code: 'not_found', message: 'Lesson not found.' });
  const text = JSON.stringify(lesson);
  if (text.length > 1_500_000) return res.status(413).json({ code: 'too_large', message: 'This lesson is too large to save.' });
  db.prepare(`INSERT INTO lessons (id, user_id, title, platform, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title, platform = excluded.platform, json = excluded.json, updated_at = excluded.updated_at`)
    .run(id, req.user.id, String(lesson.lesson_title || '').slice(0, 300), String(lesson.platform || ''), text, Date.now());
  res.json({ ok: true });
});
app.delete('/api/lessons/:id', auth.requireUser, (req, res) => {
  db.prepare('DELETE FROM lessons WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ---- AI ---- */
app.post('/api/ai/json', auth.requireUser, perUser(20), json, async (req, res) => {
  const prompt = req.body && req.body.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 120000) return res.status(400).json({ code: 'bad_request', message: 'Invalid prompt.' });
  if (!usage.take(req.user.id, 'ai')) return res.status(429).json({ code: 'quota', message: `Daily AI limit reached (${config.aiDailyLimit} requests). It resets at midnight UTC.` });
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try { res.json({ data: await ai.completeJson(prompt, { signal: ctl.signal }) }); }
  catch (e) { if (e.name === 'AbortError') return; fail(res, e); }
});

/* ---- Python sandbox ---- */
app.post('/api/run', auth.requireUser, perUser(30), json, async (req, res) => {
  try { res.json(await sandbox.run(req.body && req.body.code)); } catch (e) { fail(res, e); }
});

/* ---- AI voice ---- */
app.post('/api/tts', auth.requireUser, perUser(120), json, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 1500) return res.status(400).json({ code: 'bad_request', message: 'Narration must be 1–1500 characters.' });
  if (!usage.take(req.user.id, 'tts', config.aiDailyLimit * 20)) return res.status(429).json({ code: 'quota', message: 'Daily voice limit reached.' });
  try { res.json({ url: '/media/tts/' + await tts.speech(text, req.body.voice, req.body.speed) }); } catch (e) { fail(res, e); }
});
app.use('/media/tts', auth.requireUser, express.static(tts.dir, { maxAge: '365d', immutable: true, fallthrough: false }));

/* ---- WebM → MP4 ---- */
app.post('/api/convert', auth.requireUser, perUser(6, 10 * 60 * 1000), express.raw({ type: ['video/webm', 'application/octet-stream'], limit: '800mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ code: 'bad_request', message: 'No video uploaded.' });
  try { const mp4 = await convert.toMp4(req.body); res.set('content-type', 'video/mp4').send(mp4); } catch (e) { fail(res, e); }
});

/* ---- frontend ---- */
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: 0 }));
app.use('/api', (_req, res) => res.status(404).json({ code: 'not_found', message: 'Unknown API route.' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(config.port, () => {
  console.log(`CodeLesson AI running on http://localhost:${config.port}`);
  console.log(`  Lessons: ${ai.provider()}${ai.configured() ? '' : ' (no API key — generation disabled)'} · Voice: ${tts.provider()}${tts.configured() ? '' : ' (no API key — AI voice disabled)'}`);
  if (config.sandboxMode === 'local-unsafe') console.warn('  ! SANDBOX_MODE=local-unsafe — Python runs on this machine with rlimits only. Use the Docker sandbox in production.');
});
