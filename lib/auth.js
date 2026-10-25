// Аккаунты пользователей и сессия администратора.
import { HttpError, enc, toHex, sha256Hex, safeEqual, hmacHex, getCookie } from './common.js';

/* ---------- пароли (PBKDF2-SHA256) ---------- */

const DEFAULT_ITERATIONS = 100000; // максимум, который разрешает Cloudflare Workers

function iterations(env) {
  const n = parseInt(env.PBKDF2_ITERATIONS, 10);
  return Number.isFinite(n) ? Math.min(100000, Math.max(10000, n)) : DEFAULT_ITERATIONS;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = iterations(env);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(await derive(password, salt, iter))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterRaw, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const iter = parseInt(iterRaw, 10);
    if (!Number.isFinite(iter) || iter < 1000 || iter > 100000) return false;
    const expected = unb64(hashB64);
    const got = await derive(password, unb64(saltB64), iter);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// Хеш-пустышка: чтобы вход с несуществующим именем занимал столько же времени.
export function dummyHash(env) {
  return `pbkdf2$${iterations(env)}$AAAAAAAAAAAAAAAAAAAAAA==$${b64(new Uint8Array(32))}`;
}

/* ---------- имя и пароль ---------- */

const RESERVED_EXACT = new Set(['claude', 'chatgpt', 'gemini', 'deepseek', 'grok', 'openai', 'anthropic', 'system', 'support', 'staff', 'owner', 'null', 'undefined']);
const RESERVED_PREFIX = ['admin', 'админ', 'moder', 'модер'];

export function normalizeUsername(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Имя пользователя: ожидается текст');
  const name = raw.normalize('NFKC').trim();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(name)) {
    throw new HttpError(400, 'Имя пользователя: 3–24 символа, только буквы, цифры, «_» и «-»');
  }
  const key = name.toLowerCase();
  if (RESERVED_EXACT.has(key) || RESERVED_PREFIX.some((p) => key.startsWith(p))) {
    throw new HttpError(400, 'Это имя зарезервировано, выберите другое');
  }
  return { name, key };
}

export function usernameKey(raw) {
  return typeof raw === 'string' ? raw.normalize('NFKC').trim().toLowerCase() : '';
}

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new HttpError(400, 'Пароль: минимум 8 символов');
  if (p.length > 128) throw new HttpError(400, 'Пароль: максимум 128 символов');
  return p;
}

/* ---------- сессии пользователей ---------- */

export const SESSION_COOKIE = 'wb_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;

export const sessionCookie = (token, maxAgeSec) =>
  `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, Date.now() + SESSION_MS).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  }
  return { token, cookie: sessionCookie(token, SESSION_MS / 1000) };
}

export async function getSessionUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.avatar, u.bio, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0',
  ).bind(await sha256Hex(token), Date.now()).first();
  return row || null;
}

export async function destroySession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
}

/* ---------- сессия администратора (по паролю из ADMIN_PASSWORD) ---------- */

export const ADMIN_COOKIE = 'wb_admin';
const ADMIN_SESSION_MS = 8 * 3600 * 1000;

export const adminEnabled = (env) => typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 12;

export const adminCookie = (value, maxAgeSec) =>
  `${ADMIN_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

export async function makeAdminSession(env) {
  const exp = Date.now() + ADMIN_SESSION_MS;
  const sig = await hmacHex('session:' + env.ADMIN_PASSWORD, String(exp));
  return { value: `${exp}.${sig}`, maxAge: ADMIN_SESSION_MS / 1000 };
}

export async function isAdmin(request, env) {
  if (!adminEnabled(env)) return false;
  const value = getCookie(request, ADMIN_COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmacHex('session:' + env.ADMIN_PASSWORD, exp));
}
