'use strict';
/* Lesson-writing AI. Provider is chosen by AI_PROVIDER (gemini | anthropic); both return parsed JSON. */
const config = require('./config');

const SYSTEM = 'You are the lesson engine of CodeLesson AI, a tool that turns coding curricula into narrated teaching videos. ' +
  'Your reply is parsed by a program: reply with exactly one JSON value and nothing else — no Markdown fences, no commentary.';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// Tolerant JSON extraction: whole reply, else one fenced block, else first { or [ to the last } or ].
function extractJson(text) {
  const t = String(text || '').trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a !== Infinity && b > a) tries.push(t.slice(a, b + 1));
  for (const s of tries) { try { return { ok: true, value: JSON.parse(s) }; } catch { /* next */ } }
  return { ok: false };
}

function configured() {
  return config.aiProvider === 'anthropic' ? !!config.anthropicKey : !!config.geminiKey;
}
function notConfigured() {
  const key = config.aiProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  return Object.assign(new Error(`No ${key} is configured on the server.`), { code: 'ai_not_configured' });
}

/* ---- Google Gemini (Interactions API) ---- */
// Free-tier keys have low per-minute limits, so 429s are retried with the delay Google suggests (or backoff).
async function geminiRequest(body, { signal, label = 'Gemini' } = {}) {
  const delays = [8000, 20000, 45000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify(Object.assign({ store: false }, body))
    });
    if (res.ok) return res.json();
    let err = {}; try { err = (await res.json()).error || {}; } catch {}
    const retryable = res.status === 429 || res.status === 503 || res.status === 500;
    if (retryable && attempt < delays.length) {
      const hint = (err.details || []).map(d => d.retryDelay).find(Boolean);
      const wait = hint ? Math.min(60000, parseFloat(hint) * 1000 + 500) : delays[attempt];
      await sleep(wait, signal);
      continue;
    }
    const e = new Error(`${label} API error ${res.status}${err.message ? ': ' + err.message : ''}`);
    e.code = res.status === 429 ? 'rate_limited' : (res.status === 400 && /api key/i.test(err.message || '')) || res.status === 401 || res.status === 403 ? 'ai_bad_key' : 'ai_error';
    throw e;
  }
}
// Collects the text of the final model_output step(s), skipping thoughts.
function geminiText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const outs = (data.steps || []).filter(s => s.type === 'model_output');
  const last = outs[outs.length - 1];
  return last ? (last.content || []).filter(c => c.type === 'text').map(c => c.text).join('') : '';
}
async function geminiJson(prompt, signal) {
  const data = await geminiRequest({
    model: config.geminiModel,
    system_instruction: SYSTEM,
    input: prompt,
    generation_config: { thinking_level: config.geminiThinking }
  }, { signal });
  return geminiText(data);
}

/* ---- Anthropic (Messages API) ---- */
async function anthropicJson(prompt, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 12000, system: SYSTEM, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) {
    let detail = ''; try { detail = (await res.json()).error?.message || ''; } catch {}
    const e = new Error(`Anthropic API error ${res.status}${detail ? ': ' + detail : ''}`);
    e.code = res.status === 429 || res.status === 529 ? 'rate_limited' : res.status === 401 ? 'ai_bad_key' : 'ai_error';
    throw e;
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') return { truncated: true, text: (data.content || []).map(b => b.text || '').join('') };
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

async function completeJson(prompt, { signal } = {}) {
  if (!configured()) throw notConfigured();
  let out = config.aiProvider === 'anthropic' ? await anthropicJson(prompt, signal) : await geminiJson(prompt, signal);
  let truncated = false;
  if (out && typeof out === 'object') { truncated = out.truncated; out = out.text; }
  const parsed = extractJson(out);
  if (!parsed.ok || truncated) {
    const e = new Error(truncated ? 'The reply was cut off.' : 'The reply was not valid JSON.');
    e.code = 'invalid_json'; e.text = String(out || '').slice(0, 20000); throw e;
  }
  return parsed.value;
}

module.exports = { completeJson, extractJson, configured, geminiRequest, provider: () => config.aiProvider };
