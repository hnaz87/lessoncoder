'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');

const SESSION_DAYS = 30;
const COOKIE = 'clai_session';
const hashToken = t => crypto.createHmac('sha256', config.sessionSecret).update(t).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const newId = p => p + '_' + crypto.randomBytes(9).toString('base64url');

function publicUser(u) { return u ? { id: u.id, email: u.email, name: u.name, org: u.org } : null; }

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

// Attaches req.user when a valid session cookie is present.
function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now());
    if (row) req.user = row;
  }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 'unauthorized', message: 'Log in to continue.' });
  next();
}

const emailOk = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;

async function signup(req, res) {
  if (config.disableSignup) return res.status(403).json({ code: 'signup_disabled', message: 'Sign-ups are closed on this server.' });
  const { email, password, name, org } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!emailOk(em)) return res.status(400).json({ code: 'bad_email', message: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return res.status(400).json({ code: 'bad_password', message: 'Use a password of at least 8 characters.' });
  const nm = String(name || '').trim().slice(0, 100);
  if (!nm) return res.status(400).json({ code: 'bad_name', message: 'Enter your name.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em)) return res.status(409).json({ code: 'email_taken', message: 'An account with this email already exists. Log in instead.' });
  const id = newId('u');
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id, email, password_hash, name, org, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, em, hash, nm, String(org || '').trim().slice(0, 120), Date.now());
  createSession(res, id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
}
async function login(req, res) {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Always run bcrypt to keep timing similar whether or not the account exists.
  const ok = await bcrypt.compare(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ code: 'bad_login', message: 'That email and password don\u2019t match.' });
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
}
function logout(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

module.exports = { loadUser, requireUser, signup, login, logout, publicUser, newId };
