'use strict';
const db = require('./db');
const config = require('./config');
const today = () => new Date().toISOString().slice(0, 10);

// Returns true and counts the request if the user is under their daily limit.
function take(userId, kind, limit = config.aiDailyLimit) {
  const day = today();
  const row = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ? AND kind = ?').get(userId, day, kind);
  if (row && row.count >= limit) return false;
  db.prepare(`INSERT INTO usage (user_id, day, kind, count) VALUES (?, ?, ?, 1)
              ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + 1`).run(userId, day, kind);
  return true;
}
module.exports = { take };
