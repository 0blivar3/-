// Cloudflare Pages Function: весь API сайта (/api/*).
// Привязки: DB (D1). Секреты: ADMIN_PASSWORD (обязательно, >= 12 символов),
// TURNSTILE_SECRET и TURNSTILE_SITE_KEY (необязательно, защита от ботов).

const ATM = { 1: 1.0, 2: 1.0675, 3: 1.1349, 4: 1.2024, 5: 1.2699, 6: 1.3373, 7: 1.4048, 8: 1.4723, 9: 1.5397, 10: 1.6072 };
const AI_NAMES = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Grok'];
const SESSION_COOKIE = 'wb_admin';
const SESSION_MS = 8 * 3600 * 1000;
const PENDING_CAP = 300;
const LIMITS = { article: 150, title: 120, nick: 32, body: 5000, minBody: 20, authorName: 60 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CTRL_LINE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const CTRL_MULTI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
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

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function adminEnabled(env) {
  return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 12;
}

async function makeSession(env) {
  const exp = Date.now() + SESSION_MS;
  const sig = await hmacHex('session:' + env.ADMIN_PASSWORD, String(exp));
  return `${exp}.${sig}`;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function isAdmin(request, env) {
  if (!adminEnabled(env)) return false;
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !sig || Number(exp) < Date.now()) return false;
  const expected = await hmacHex('session:' + env.ADMIN_PASSWORD, exp);
  return safeEqual(sig, expected);
}

async function requireAdmin(request, env) {
  if (!(await isAdmin(request, env))) throw new HttpError(401, 'Требуется вход администратора');
}

const cookieHeader = (value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/* ---------- лимиты и защита от ботов ---------- */

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return toHex(await sha256(`${ip}|${env.ADMIN_PASSWORD || 'salt'}`));
}

async function rateLimit(env, kind, hash, max, windowSec) {
  const since = Date.now() - windowSec * 1000;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit WHERE kind = ? AND ip_hash = ? AND ts > ?')
    .bind(kind, hash, since).first();
  if (row && row.n >= max) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
  await env.DB.prepare('INSERT INTO rate_limit (kind, ip_hash, ts) VALUES (?, ?, ?)').bind(kind, hash, Date.now()).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM rate_limit WHERE ts < ?').bind(Date.now() - 86400000).run();
  }
}

async function verifyTurnstile(env, token, request) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', typeof token === 'string' ? token : '');
  form.append('remoteip', request.headers.get('CF-Connecting-IP') || '');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

/* ---------- валидация ---------- */

function clean(value, { min = 1, max, multiline = false, label = 'Поле' } = {}) {
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

function parseCriteria(v) {
  if (!Array.isArray(v) || v.length !== 5 || !v.every((n) => Number.isInteger(n) && n >= 1 && n <= 10)) {
    throw new HttpError(400, 'Критерии: нужно 5 целых чисел от 1 до 10');
  }
  return v;
}

function calcScore(c) {
  return Math.min(90, Math.round((c[0] + c[1] + c[2] + c[3]) * 1.4 * ATM[c[4]]));
}

function parseAvatar(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > 300) throw new HttpError(400, 'Аватар: некорректный URL');
  let u;
  try { u = new URL(v.trim()); } catch { throw new HttpError(400, 'Аватар: некорректный URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'Аватар: разрешены только https-ссылки');
  return u.toString();
}

function rowToReview(r) {
  return {
    id: r.id,
    articleTitle: r.article_title,
    reviewTitle: r.review_title,
    authorId: r.author_id,
    reviewerKind: r.reviewer_kind,
    reviewerName: r.reviewer_name,
    text: r.body,
    criteria: [r.c1, r.c2, r.c3, r.c4, r.c_atm],
    score: r.score,
    status: r.status,
    createdAt: r.created_at,
  };
}

const INSERT_REVIEW =
  'INSERT OR IGNORE INTO reviews (id, article_title, review_title, author_id, reviewer_kind, reviewer_name, body, c1, c2, c3, c4, c_atm, score, status, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function bindReview(env, r) {
  const c = r.criteria;
  return env.DB.prepare(INSERT_REVIEW).bind(
    r.id, r.articleTitle, r.reviewTitle, r.authorId, r.reviewerKind, r.reviewerName, r.text,
    c[0], c[1], c[2], c[3], c[4], calcScore(c), r.status, r.createdAt,
  );
}

async function readJson(request, maxBytes) {
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

/* ---------- обработчики ---------- */

async function getData(env) {
  const [authors, reviews] = await Promise.all([
    env.DB.prepare('SELECT id, name, avatar FROM authors ORDER BY created_at ASC, name ASC').all(),
    env.DB.prepare("SELECT * FROM reviews WHERE status = 'approved' ORDER BY created_at DESC LIMIT 3000").all(),
  ]);
  return { authors: authors.results, reviews: reviews.results.map(rowToReview) };
}

async function createReview(request, env) {
  const admin = await isAdmin(request, env);
  const body = await readJson(request, 40 * 1024);

  // Ловушка для ботов: поле скрыто от людей.
  if (typeof body.website === 'string' && body.website !== '') return json({ ok: true, status: 'pending' });

  const hash = await ipHash(request, env);
  if (!admin) {
    if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, body.turnstile, request))) {
      throw new HttpError(400, 'Проверка «я не робот» не пройдена');
    }
    await rateLimit(env, 'review', hash, 3, 3600);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'").first();
    if (pending && pending.n >= PENDING_CAP) throw new HttpError(503, 'Очередь модерации переполнена, попробуйте позже');
  }

  let articleTitle = clean(body.articleTitle, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const reviewTitle = clean(body.reviewTitle, { min: 2, max: LIMITS.title, label: 'Заголовок рецензии' });
  const text = clean(body.text, { min: LIMITS.minBody, max: LIMITS.body, multiline: true, label: 'Текст рецензии' });
  const criteria = parseCriteria(body.criteria);

  let reviewerKind = 'user';
  let reviewerName;
  if (admin && body.reviewerKind === 'ai') {
    if (!AI_NAMES.includes(body.reviewerName)) throw new HttpError(400, 'Неизвестный ИИ-критик');
    reviewerKind = 'ai';
    reviewerName = body.reviewerName;
  } else {
    reviewerName = clean(body.reviewerName, { min: 2, max: LIMITS.nick, label: 'Никнейм' });
  }

  if (typeof body.authorId !== 'string' || !ID_RE.test(body.authorId)) throw new HttpError(400, 'Выберите автора статьи');
  let authorId = body.authorId;
  const author = await env.DB.prepare('SELECT id FROM authors WHERE id = ?').bind(authorId).first();
  if (!author) throw new HttpError(400, 'Автор не найден');

  // Если рецензии на эту статью уже есть, берём каноничное написание и автора.
  const existing = await env.DB.prepare(
    'SELECT article_title, author_id FROM reviews WHERE article_title = ? COLLATE NOCASE LIMIT 1',
  ).bind(articleTitle).first();
  if (existing) {
    articleTitle = existing.article_title;
    authorId = existing.author_id;
  }

  const review = {
    id: crypto.randomUUID(),
    articleTitle, reviewTitle, authorId, reviewerKind, reviewerName, text, criteria,
    status: admin ? 'approved' : 'pending',
    createdAt: Date.now(),
  };
  await bindReview(env, review).run();
  return json({ ok: true, status: review.status, id: review.id }, 201);
}

async function createAuthor(request, env) {
  const body = await readJson(request, 4 * 1024);
  const name = clean(body.name, { min: 2, max: LIMITS.authorName, label: 'Имя автора' });
  const avatar = parseAvatar(body.avatar);
  const id = 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  try {
    await env.DB.prepare('INSERT INTO authors (id, name, avatar, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, name, avatar, Date.now()).run();
  } catch {
    throw new HttpError(409, 'Автор с таким именем уже существует');
  }
  return json({ ok: true, author: { id, name, avatar } }, 201);
}

async function deleteAuthor(env, id) {
  if (id === 'a1') throw new HttpError(400, 'Нельзя удалить автора по умолчанию');
  await env.DB.batch([
    env.DB.prepare("UPDATE reviews SET author_id = 'a1' WHERE author_id = ?").bind(id),
    env.DB.prepare('DELETE FROM authors WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function exportAll(env) {
  const [authors, reviews] = await Promise.all([
    env.DB.prepare('SELECT id, name, avatar FROM authors ORDER BY created_at ASC').all(),
    env.DB.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all(),
  ]);
  return json({ version: 2, exportedAt: new Date().toISOString(), authors: authors.results, reviews: reviews.results.map(rowToReview) });
}

async function importAll(request, env) {
  const body = await readJson(request, 2 * 1024 * 1024);
  // Поддерживается и старый формат (authorsData / reviewsData), и новый (authors / reviews).
  const rawAuthors = Array.isArray(body.authors) ? body.authors : Array.isArray(body.authorsData) ? body.authorsData : [];
  const rawReviews = Array.isArray(body.reviews) ? body.reviews : Array.isArray(body.reviewsData) ? body.reviewsData : [];
  if (rawAuthors.length > 500 || rawReviews.length > 5000) throw new HttpError(413, 'Слишком много записей');
  if (!rawAuthors.length && !rawReviews.length) throw new HttpError(400, 'В файле нет данных для импорта');

  const idMap = new Map();
  const statements = [];
  let authorsAdded = 0;
  let skipped = 0;
  const now = Date.now();

  const existingAuthors = await env.DB.prepare('SELECT id, name FROM authors').all();
  const byName = new Map(existingAuthors.results.map((a) => [a.name.toLowerCase(), a.id]));
  const knownIds = new Set(existingAuthors.results.map((a) => a.id));

  for (const a of rawAuthors) {
    try {
      if (!a || typeof a !== 'object') throw new Error('bad');
      const name = clean(a.name, { min: 2, max: LIMITS.authorName });
      let avatar = '';
      try { avatar = parseAvatar(a.avatar); } catch { avatar = ''; }
      const key = name.toLowerCase();
      if (byName.has(key)) { idMap.set(a.id, byName.get(key)); continue; }
      const id = typeof a.id === 'string' && ID_RE.test(a.id) && !knownIds.has(a.id) ? a.id : 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      byName.set(key, id);
      knownIds.add(id);
      idMap.set(a.id, id);
      authorsAdded++;
      statements.push(env.DB.prepare('INSERT INTO authors (id, name, avatar, created_at) VALUES (?, ?, ?, ?)').bind(id, name, avatar, now));
    } catch { skipped++; }
  }

  let reviewsPrepared = 0;
  rawReviews.forEach((r, i) => {
    try {
      if (!r || typeof r !== 'object') throw new Error('bad');
      const kind = r.reviewerKind === 'user' ? 'user' : 'ai';
      const reviewerName = kind === 'ai'
        ? (AI_NAMES.includes(r.reviewerName) ? r.reviewerName : r.ai)
        : clean(r.reviewerName, { min: 2, max: LIMITS.nick });
      if (kind === 'ai' && !AI_NAMES.includes(reviewerName)) throw new Error('bad ai');
      const rawId = r.id == null ? '' : String(r.id);
      const id = ID_RE.test(rawId) ? rawId : crypto.randomUUID();
      const mapped = idMap.get(r.authorId) || (knownIds.has(r.authorId) ? r.authorId : 'a1');
      const review = {
        id,
        articleTitle: clean(r.articleTitle, { min: 1, max: LIMITS.article }),
        reviewTitle: clean(r.reviewTitle, { min: 1, max: LIMITS.title }),
        authorId: mapped,
        reviewerKind: kind,
        reviewerName,
        text: clean(r.text, { min: 1, max: LIMITS.body, multiline: true }),
        criteria: parseCriteria(r.criteria),
        status: r.status === 'pending' ? 'pending' : 'approved',
        createdAt: Number.isFinite(r.createdAt) ? Math.trunc(r.createdAt) : now - i,
      };
      statements.push(bindReview(env, review));
      reviewsPrepared++;
    } catch { skipped++; }
  });

  for (let i = 0; i < statements.length; i += 80) {
    await env.DB.batch(statements.slice(i, i + 80));
  }
  return json({ ok: true, authorsAdded, reviewsProcessed: reviewsPrepared, skipped });
}

/* ---------- маршрутизатор ---------- */

export async function onRequest({ request, env }) {
  try {
    if (!env.DB) throw new HttpError(500, 'База данных не подключена (привязка DB)');
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.get('Origin');
      if (!origin || origin !== url.origin) throw new HttpError(403, 'Недопустимый источник запроса');
    }

    if (path === '/api/config' && method === 'GET') {
      return json({ turnstileSiteKey: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null, adminEnabled: adminEnabled(env) });
    }
    if (path === '/api/data' && method === 'GET') return json(await getData(env));
    if (path === '/api/reviews' && method === 'POST') return await createReview(request, env);

    if (path === '/api/admin/me' && method === 'GET') return json({ admin: await isAdmin(request, env) });

    if (path === '/api/admin/login' && method === 'POST') {
      if (!adminEnabled(env)) throw new HttpError(503, 'Вход администратора не настроен (ADMIN_PASSWORD)');
      await rateLimit(env, 'login', await ipHash(request, env), 8, 900);
      const body = await readJson(request, 2 * 1024);
      if (typeof body.password !== 'string' || !(await safeEqual(body.password, env.ADMIN_PASSWORD))) {
        throw new HttpError(401, 'Неверный пароль');
      }
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(await makeSession(env), SESSION_MS / 1000) });
    }
    if (path === '/api/admin/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
    }

    if (path.startsWith('/api/admin/')) {
      await requireAdmin(request, env);

      if (path === '/api/admin/pending' && method === 'GET') {
        const res = await env.DB.prepare("SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at ASC LIMIT 500").all();
        return json({ reviews: res.results.map(rowToReview) });
      }
      if (path === '/api/admin/authors' && method === 'POST') return await createAuthor(request, env);
      if (path === '/api/admin/export' && method === 'GET') return await exportAll(env);
      if (path === '/api/admin/import' && method === 'POST') return await importAll(request, env);

      let m = path.match(/^\/api\/admin\/authors\/([A-Za-z0-9_-]{1,64})$/);
      if (m && method === 'DELETE') return await deleteAuthor(env, m[1]);

      m = path.match(/^\/api\/admin\/reviews\/([A-Za-z0-9_-]{1,64})(\/approve)?$/);
      if (m && m[2] && method === 'POST') {
        const res = await env.DB.prepare("UPDATE reviews SET status = 'approved' WHERE id = ?").bind(m[1]).run();
        if (!res.meta.changes) throw new HttpError(404, 'Рецензия не найдена');
        return json({ ok: true });
      }
      if (m && !m[2] && method === 'DELETE') {
        const res = await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(m[1]).run();
        if (!res.meta.changes) throw new HttpError(404, 'Рецензия не найдена');
        return json({ ok: true });
      }
    }

    throw new HttpError(404, 'Не найдено');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Внутренняя ошибка сервера' }, 500);
  }
}
