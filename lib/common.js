// Общие утилиты API: ответы, криптография, валидация, лимиты.

export const ATM = { 1: 1.0, 2: 1.0675, 3: 1.1349, 4: 1.2024, 5: 1.2699, 6: 1.3373, 7: 1.4048, 8: 1.4723, 9: 1.5397, 10: 1.6072 };
export const AI_NAMES = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok'];
export const LIMITS = {
  article: 150, title: 120, body: 10000, minBody: 20,
  authorName: 60, bio: 600, username: 24,
};
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CTRL_LINE = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;
const CTRL_MULTI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;

export const enc = new TextEncoder();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

/* ---------- криптография ---------- */

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function sha256Hex(text) {
  return toHex(await sha256(text));
}

export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* ---------- валидация ---------- */

export function clean(value, { min = 1, max, multiline = false, label = 'Поле' } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label}: ожидается текст`);
  let s = value.normalize('NFC');
  if (multiline) {
    s = s.replace(/\r\n?/g, '\n').replace(CTRL_MULTI, '').replace(/\n{4,}/g, '\n\n\n').trim();
  } else {
    s = s.replace(/[\r\n\t]+/g, ' ').replace(CTRL_LINE, '').replace(/\s+/g, ' ').trim();
  }
  const len = [...s].length;
  if (len < min) throw new HttpError(400, `${label}: слишком коротко (минимум ${min})`);
  if (len > max) throw new HttpError(400, `${label}: слишком длинно (максимум ${max})`);
  return s;
}

// Необязательный многострочный текст (например, «О себе»).
export function optionalText(value, max, label) {
  if (value == null || value === '') return '';
  return clean(value, { min: 0, max, multiline: true, label });
}

export function parseAvatar(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && /^\/api\/avatar\/[A-Za-z0-9_-]{1,64}(?:\?v=\d{1,16})?$/.test(v.trim())) return v.trim();
  if (typeof v !== 'string' || v.length > 300) throw new HttpError(400, 'Аватар: некорректный URL');
  let u;
  try { u = new URL(v.trim()); } catch { throw new HttpError(400, 'Аватар: некорректный URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'Аватар: разрешены только https-ссылки');
  return u.toString();
}

export function parseCriteria(v) {
  if (!Array.isArray(v) || v.length !== 5 || !v.every((n) => Number.isInteger(n) && n >= 1 && n <= 10)) {
    throw new HttpError(400, 'Критерии: нужно 5 целых чисел от 1 до 10');
  }
  return v;
}

export function calcScore(c) {
  return Math.min(90, Math.round((c[0] + c[1] + c[2] + c[3]) * 1.4 * ATM[c[4]]));
}

export async function readJson(request, maxBytes) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Ожидается application/json');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Слишком большой запрос');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Слишком большой запрос');
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object') throw new Error('bad');
    return data;
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

/* ---------- лимиты и защита от ботов ---------- */

export async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256Hex(`${ip}|${env.ADMIN_PASSWORD || 'salt'}`);
}

export async function rateLimit(env, kind, key, max, windowSec) {
  const since = Date.now() - windowSec * 1000;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit WHERE kind = ? AND ip_hash = ? AND ts > ?')
    .bind(kind, key, since).first();
  if (row && row.n >= max) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
  await env.DB.prepare('INSERT INTO rate_limit (kind, ip_hash, ts) VALUES (?, ?, ?)').bind(kind, key, Date.now()).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM rate_limit WHERE ts < ?').bind(Date.now() - 86400000).run();
  }
}

export async function verifyTurnstile(env, token, request) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', typeof token === 'string' ? token : '');
  form.append('remoteip', request.headers.get('CF-Connecting-IP') || '');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}
