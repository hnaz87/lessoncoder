// Smoke test against a running server:  node scripts/smoke.js [http://localhost:3000]
const base = process.argv[2] || 'http://localhost:3000';
let cookie = '';
async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  let data; try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}
let failures = 0;
// required checks fail the run; optional ones only warn
const ok = (name, cond, extra = '', optional = false) => {
  if (!cond && !optional) failures++;
  console.log(`${cond ? 'PASS' : optional ? 'WARN' : 'FAIL'}  ${name}${extra && !cond ? '  — ' + extra : ''}`);
};
(async () => {
  const cfg = await call('GET', '/api/config');
  ok('server responds', cfg.status === 200);
  ok(`AI key configured (${cfg.data.aiProvider})`, cfg.data.ai, 'set GEMINI_API_KEY (free at aistudio.google.com/apikey)', true);
  ok('Python sandbox reachable', cfg.data.sandbox, 'run with docker compose, or SANDBOX_MODE=local-unsafe for dev');
  ok(`AI voice configured (${cfg.data.ttsProvider})`, cfg.data.tts, 'uses the same GEMINI_API_KEY', true);
  ok('ffmpeg available', cfg.data.ffmpeg, 'install ffmpeg', true);
  const email = `smoke+${Date.now()}@example.com`;
  const su = await call('POST', '/api/auth/signup', { email, password: 'smoke-test-pass', name: 'Smoke Test' });
  ok('sign up', su.status === 200, su.data && su.data.message);
  const lesson = { id: 'l_smoke' + Date.now(), lesson_title: 'Smoke', platform: 'python', scenes: [] };
  ok('save lesson', (await call('PUT', '/api/lessons/' + lesson.id, { lesson })).status === 200);
  const list = await call('GET', '/api/lessons');
  ok('list lessons', list.data.lessons.some(l => l.id === lesson.id));
  if (cfg.data.sandbox) {
    const r = await call('POST', '/api/run', { code: 'for i in range(3):\n    print("Hello")' });
    ok('run Python', r.data && r.data.stdout === 'Hello\nHello\nHello\n', JSON.stringify(r.data));
    const t = await call('POST', '/api/run', { code: 'while True: pass' });
    ok('runaway code is stopped', t.data && !t.data.ok, t.data && t.data.stderr);
    const n = await call('POST', '/api/run', { code: 'import socket\ntry:\n    socket.create_connection(("1.1.1.1", 80), timeout=2); print("NETWORK OPEN")\nexcept OSError: print("blocked")' });
    ok('no network inside sandbox', n.data && n.data.stdout.trim() === 'blocked', n.data && n.data.stdout.trim());
  }
  await call('DELETE', '/api/lessons/' + lesson.id);
  ok('log out', (await call('POST', '/api/auth/logout')).status === 200);
  ok('protected after logout', (await call('GET', '/api/lessons')).status === 401);
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll required checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL  could not reach ' + base + ': ' + e.message); process.exit(1); });
