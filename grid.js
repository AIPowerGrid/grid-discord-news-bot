// AI Power Grid /v1 client (OpenAI-compatible).
//
// Replaces the legacy horde async-submit + status-polling flow with plain
// /v1/chat/completions and /v1/images/generations calls. No poll loops.
const axios = require('axios');

const BASE = (process.env.GRID_API_BASE || 'https://grid.aipowergrid.io/v1').replace(/\/+$/, '');
const KEY = process.env.GRID_API_KEY;
const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen3-27b';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'z-image-turbo';

const http = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'grid-news-bot/2.0',
  },
  timeout: 120000,
});

// Strip a model's <think>…</think> reasoning so callers only see the answer.
function stripThink(text) {
  return (text || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim();
}

/**
 * One chat completion. messages = [{role, content}]. Returns the answer string.
 * Non-streaming on purpose — the bot wants the whole reply, not tokens.
 */
async function chat(messages, { model = TEXT_MODEL, maxTokens = 1024, temperature = 0.6 } = {}) {
  const r = await http.post('/chat/completions', {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  });
  return stripThink(r.data?.choices?.[0]?.message?.content || '');
}

/**
 * Ask the model for JSON and parse it leniently (models wrap JSON in prose or
 * code fences). Returns the parsed object or null.
 */
async function chatJson(messages, opts = {}) {
  const raw = await chat(messages, { temperature: 0.4, ...opts });
  const match = raw.match(/\{[\s\S]*\}/); // first {...} block
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Generate one image. Returns an absolute URL (or a data: URI), or null.
 */
async function generateImage(prompt, { model = IMAGE_MODEL, size = '1024x1024' } = {}) {
  const r = await http.post(
    '/images/generations',
    { model, prompt, n: 1, size, response_format: 'url' },
    { timeout: 180000 }
  );
  const d = r.data?.data?.[0];
  if (d?.url) return d.url;
  if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
  return null;
}

module.exports = { chat, chatJson, generateImage, TEXT_MODEL, IMAGE_MODEL, BASE };
