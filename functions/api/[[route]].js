// Cloudflare Pages Function: весь API сайта (/api/*).
// Привязки: DB (D1). Секреты: ADMIN_PASSWORD (обязательно, >= 12 символов).
// Необязательно: TURNSTILE_SECRET + TURNSTILE_SITE_KEY (защита регистрации от ботов),
// PBKDF2_ITERATIONS (10000–100000, если на бесплатном плане не хватает лимита CPU).

import {
  AI_NAMES, ID_RE, LIMITS, HttpError, json, clean, optionalText, parseAvatar, parseCriteria, calcScore,
  readJson, ipHash, rateLimit, verifyTurnstile, safeEqual, sha256Hex,
} from '../../lib/common.js';
import {
  hashPassword, verifyPassword, dummyHash, normalizeUsername, usernameKey, validatePassword,
  createSession, getSessionUser, destroySession, sessionCookie,
  adminEnabled, adminCookie, makeAdminSession, isAdmin,
} from '../../lib/auth.js';

/* ---------- преобразование строк БД ---------- */

function rowToReview(r) {
  return {
    id: r.id,
    articleTitle: r.article_title,
    reviewTitle: r.review_title,
    authorId: r.author_id,
    reviewerKind: r.reviewer_kind,
    reviewerName: r.reviewer_name,
    registered: !!r.registered,
    text: r.body,
    criteria: [r.c1, r.c2, r.c3, r.c4, r.c_atm],
    score: r.score,
    status: r.status,
    createdAt: r.created_at,
  };
}

const rowToAuthor = (a) => ({
  id: a.id, name: a.name, avatar: a.avatar, bio: a.bio || '', ownerUsername: a.owner || null, updatedAt: a.updated_at || 0,
});

const rowToUser = (u) => ({
  username: u.username, avatar: u.avatar, bio: u.bio, createdAt: u.created_at, banned: !!u.banned,
});

const SELECT_REVIEWS = 'SELECT *, (reviewer_user_id IS NOT NULL) AS registered FROM reviews';

const INSERT_REVIEW =
  'INSERT OR IGNORE INTO reviews (id, article_title, review_title, author_id, reviewer_kind, reviewer_name, reviewer_user_id, body, c1, c2, c3, c4, c_atm, score, status, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function bindReview(env, r) {
  const c = r.criteria;
  return env.DB.prepare(INSERT_REVIEW).bind(
    r.id, r.articleTitle, r.reviewTitle, r.authorId, r.reviewerKind, r.reviewerName, r.reviewerUserId || null, r.text,
    c[0], c[1], c[2], c[3], c[4], calcScore(c), r.status, r.createdAt,
  );
}

const isUnique = (e) => /UNIQUE|constraint/i.test(String((e && e.message) || e));

/* ---------- публичные данные ---------- */

async function getData(env, admin) {
  const usersSql = admin
    ? 'SELECT username, avatar, bio, created_at, banned FROM users ORDER BY created_at DESC LIMIT 5000'
    : 'SELECT username, avatar, bio, created_at, 0 AS banned FROM users WHERE banned = 0 ORDER BY created_at DESC LIMIT 5000';
  const [authors, reviews, users] = await Promise.all([
    env.DB.prepare(
      'SELECT a.id, a.name, a.avatar, a.bio, a.updated_at, u.username AS owner FROM authors a ' +
      'LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY a.created_at ASC, a.name ASC',
    ).all(),
    env.DB.prepare(`${SELECT_REVIEWS} WHERE status = 'approved' ORDER BY created_at DESC LIMIT 3000`).all(),
    env.DB.prepare(usersSql).all(),
  ]);
  return {
    authors: authors.results.map(rowToAuthor),
    reviews: reviews.results.map(rowToReview),
    users: users.results.map(rowToUser),
  };
}

async function meInfo(env, user) {
  if (!user) return { user: null, authorId: null };
  const author = await env.DB.prepare('SELECT id FROM authors WHERE owner_user_id = ?').bind(user.id).first();
  return {
    user: { username: user.username, avatar: user.avatar, bio: user.bio, createdAt: user.created_at },
    authorId: author ? author.id : null,
  };
}

/* ---------- аккаунты ---------- */

async function register(request, env) {
  const body = await readJson(request, 4 * 1024);
  const hash = await ipHash(request, env);
  await rateLimit(env, 'register', hash, 5, 3600);
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, body.turnstile, request))) {
    throw new HttpError(400, 'Проверка «я не робот» не пройдена');
  }
  const { name, key } = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE username_key = ?').bind(key).first()) {
    throw new HttpError(409, 'Это имя уже занято');
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO users (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, key, await hashPassword(password, env), Date.now()).run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Это имя уже занято');
    throw e;
  }
  const { cookie } = await createSession(env, id);
  const me = await meInfo(env, { id, username: name, avatar: '', bio: '', created_at: Date.now() });
  return json({ ok: true, ...me }, 201, { 'Set-Cookie': cookie });
}

async function login(request, env) {
  const body = await readJson(request, 2 * 1024);
  const key = usernameKey(body.username);
  await rateLimit(env, 'login', await ipHash(request, env), 15, 900);
  if (key) await rateLimit(env, 'login-user', await sha256Hex(key), 10, 900);
  const row = key ? await env.DB.prepare('SELECT id, username, avatar, bio, created_at, password_hash, banned FROM users WHERE username_key = ?').bind(key).first() : null;
  const okPassword = typeof body.password === 'string' && await verifyPassword(body.password, row ? row.password_hash : dummyHash(env));
  if (!row || !okPassword) throw new HttpError(401, 'Неверное имя пользователя или пароль');
  if (row.banned) throw new HttpError(403, 'Аккаунт заблокирован');
  const { cookie } = await createSession(env, row.id);
  return json({ ok: true, ...(await meInfo(env, row)) }, 200, { 'Set-Cookie': cookie });
}

async function logout(request, env) {
  await destroySession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function updateProfile(request, env, user) {
  const body = await readJson(request, 8 * 1024);
  const bio = optionalText(body.bio, LIMITS.bio, 'О себе');
  const avatar = body.avatar == null ? user.avatar : parseAvatar(body.avatar);
  await env.DB.prepare('UPDATE users SET bio = ?, avatar = ? WHERE id = ?').bind(bio, avatar, user.id).run();
  return json({ ok: true });
}

async function uploadUserAvatar(request, env, user) {
  if (!env.AVATARS) throw new HttpError(503, 'Загрузка аватарок не настроена: администратору нужно подключить R2-бакет AVATARS в Cloudflare Pages');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > 2 * 1024 * 1024 + 65536) throw new HttpError(413, 'Изображение должно быть не больше 2 МБ');
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Не удалось прочитать загруженный файл'); }
  const file = form.get('avatar');
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'Выберите изображение');
  if (!file.size || file.size > 2 * 1024 * 1024) throw new HttpError(413, 'Изображение должно быть не больше 2 МБ');
  const types = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!types.has(file.type)) throw new HttpError(400, 'Поддерживаются только PNG, JPG и WebP');
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isPng = signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47 && signature[4] === 0x0d && signature[5] === 0x0a && signature[6] === 0x1a && signature[7] === 0x0a;
  const isJpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const isWebp = signature.length >= 12 && String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP';
  if (!(file.type === 'image/png' && isPng) && !(file.type === 'image/jpeg' && isJpeg) && !(file.type === 'image/webp' && isWebp)) {
    throw new HttpError(400, 'Файл не похож на корректное изображение');
  }
  const key = `avatars/${user.id}`;
  await env.AVATARS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=3600' },
  });
  const avatar = `/api/avatar/${user.id}?v=${Date.now()}`;
  await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, user.id).run();
  return json({ ok: true, avatar });
}

async function getUserAvatar(env, id) {
  if (!env.AVATARS) throw new HttpError(404, 'Аватар не найден');
  const object = await env.AVATARS.get(`avatars/${id}`);
  if (!object) throw new HttpError(404, 'Аватар не найден');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

async function changePassword(request, env, user) {
  const body = await readJson(request, 2 * 1024);
  await rateLimit(env, 'pwchange', user.id, 5, 900);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (typeof body.current !== 'string' || !(await verifyPassword(body.current, row.password_hash))) {
    throw new HttpError(401, 'Текущий пароль неверен');
  }
  const next = validatePassword(body.password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next, env), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const { cookie } = await createSession(env, user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Удаление аккаунта: рецензии остаются, но отвязываются от пользователя.
function deleteUserStatements(env, userId) {
  return [
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE reviews SET reviewer_user_id = NULL WHERE reviewer_user_id = ?').bind(userId),
    env.DB.prepare('UPDATE authors SET owner_user_id = NULL WHERE owner_user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ];
}

async function deleteAccount(request, env, user) {
  const body = await readJson(request, 2 * 1024);
  await rateLimit(env, 'pwchange', user.id, 5, 900);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (typeof body.password !== 'string' || !(await verifyPassword(body.password, row.password_hash))) {
    throw new HttpError(401, 'Пароль неверен');
  }
  await env.DB.batch(deleteUserStatements(env, user.id));
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/* ---------- рецензии ---------- */

async function createReview(request, env, user, admin) {
  const body = await readJson(request, 64 * 1024);

  let reviewerKind = 'user';
  let reviewerName;
  let reviewerUserId = null;
  if (body.reviewerKind === 'ai') {
    if (!admin) throw new HttpError(403, 'Рецензии от имени ИИ-критиков добавляет только администратор');
    if (!AI_NAMES.includes(body.reviewerName)) throw new HttpError(400, 'Неизвестный ИИ-критик');
    reviewerKind = 'ai';
    reviewerName = body.reviewerName;
  } else {
    if (!user) throw new HttpError(401, 'Войдите или зарегистрируйтесь, чтобы оставить рецензию');
    reviewerName = user.username;
    reviewerUserId = user.id;
  }

  if (!admin) {
    await rateLimit(env, 'review', user.id, 5, 3600);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'").first();
    if (pending && pending.n >= 300) throw new HttpError(503, 'Очередь модерации переполнена, попробуйте позже');
  }

  let articleTitle = clean(body.articleTitle, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const reviewTitle = clean(body.reviewTitle, { min: 2, max: LIMITS.title, label: 'Заголовок рецензии' });
  const text = clean(body.text, { min: LIMITS.minBody, max: LIMITS.body, multiline: true, label: 'Текст рецензии' });
  const criteria = parseCriteria(body.criteria);

  if (typeof body.authorId !== 'string' || !ID_RE.test(body.authorId)) throw new HttpError(400, 'Выберите автора статьи');
  let authorId = body.authorId;
  if (!(await env.DB.prepare('SELECT id FROM authors WHERE id = ?').bind(authorId).first())) throw new HttpError(400, 'Автор не найден');

  // Если рецензии на эту статью уже есть, берём каноничное написание и автора.
  const existing = await env.DB.prepare('SELECT article_title, author_id FROM reviews WHERE article_title = ? COLLATE NOCASE LIMIT 1').bind(articleTitle).first();
  if (existing) { articleTitle = existing.article_title; authorId = existing.author_id; }

  const review = {
    id: crypto.randomUUID(), articleTitle, reviewTitle, authorId, reviewerKind, reviewerName, reviewerUserId, text, criteria,
    status: admin ? 'approved' : 'pending', createdAt: Date.now(),
  };
  await bindReview(env, review).run();
  return json({ ok: true, status: review.status, id: review.id }, 201);
}

/* ---------- авторы ---------- */

async function createOwnAuthor(request, env, user) {
  const body = await readJson(request, 8 * 1024);
  if (await env.DB.prepare('SELECT id FROM authors WHERE owner_user_id = ?').bind(user.id).first()) {
    throw new HttpError(409, 'У вас уже есть карточка автора');
  }
  await rateLimit(env, 'author', user.id, 3, 3600);
  const name = clean(body.name, { min: 2, max: LIMITS.authorName, label: 'Имя автора' });
  const avatar = parseAvatar(body.avatar);
  const bio = optionalText(body.bio, LIMITS.bio, 'Описание');
  const id = 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO authors (id, name, avatar, bio, owner_user_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, avatar, bio, user.id, now, now).run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Автор с таким именем уже существует');
    throw e;
  }
  return json({ ok: true, id }, 201);
}

async function updateAuthor(request, env, id, user, admin) {
  const author = await env.DB.prepare('SELECT id, owner_user_id FROM authors WHERE id = ?').bind(id).first();
  if (!author) throw new HttpError(404, 'Автор не найден');
  if (!admin && !(user && author.owner_user_id === user.id)) throw new HttpError(403, 'Нет прав на редактирование этой карточки');
  const body = await readJson(request, 8 * 1024);
  const name = clean(body.name, { min: 2, max: LIMITS.authorName, label: 'Имя автора' });
  const avatar = parseAvatar(body.avatar);
  const bio = optionalText(body.bio, LIMITS.bio, 'Описание');
  try {
    await env.DB.prepare('UPDATE authors SET name = ?, avatar = ?, bio = ?, updated_at = ? WHERE id = ?')
      .bind(name, avatar, bio, Date.now(), id).run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Автор с таким именем уже существует');
    throw e;
  }
  return json({ ok: true });
}

/* ---------- администратор ---------- */

async function adminCreateAuthor(request, env) {
  const body = await readJson(request, 8 * 1024);
  const name = clean(body.name, { min: 2, max: LIMITS.authorName, label: 'Имя автора' });
  const avatar = parseAvatar(body.avatar);
  const bio = optionalText(body.bio, LIMITS.bio, 'Описание');
  const id = 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO authors (id, name, avatar, bio, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, name, avatar, bio, now, now).run();
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Автор с таким именем уже существует');
    throw e;
  }
  return json({ ok: true, id }, 201);
}

async function deleteAuthor(env, id) {
  if (id === 'a1') throw new HttpError(400, 'Нельзя удалить автора по умолчанию');
  await env.DB.batch([
    env.DB.prepare("UPDATE reviews SET author_id = 'a1' WHERE author_id = ?").bind(id),
    env.DB.prepare('DELETE FROM authors WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function setAuthorOwner(request, env, id) {
  const body = await readJson(request, 1024);
  if (!(await env.DB.prepare('SELECT id FROM authors WHERE id = ?').bind(id).first())) throw new HttpError(404, 'Автор не найден');
  if (body.username == null || body.username === '') {
    await env.DB.prepare('UPDATE authors SET owner_user_id = NULL WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  const u = await env.DB.prepare('SELECT id FROM users WHERE username_key = ?').bind(usernameKey(body.username)).first();
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  const other = await env.DB.prepare('SELECT id FROM authors WHERE owner_user_id = ? AND id != ?').bind(u.id, id).first();
  if (other) throw new HttpError(409, 'У этого пользователя уже есть другая карточка автора');
  await env.DB.prepare('UPDATE authors SET owner_user_id = ? WHERE id = ?').bind(u.id, id).run();
  return json({ ok: true });
}

async function findUser(env, username) {
  const u = await env.DB.prepare('SELECT id FROM users WHERE username_key = ?').bind(usernameKey(username)).first();
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  return u;
}

async function adminUserAction(request, env, username, action) {
  const u = await findUser(env, username);
  if (action === 'ban') {
    const body = await readJson(request, 1024);
    const banned = body.banned ? 1 : 0;
    const stmts = [env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(banned, u.id)];
    if (banned) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id));
    await env.DB.batch(stmts);
  } else if (action === 'password') {
    const body = await readJson(request, 1024);
    const next = validatePassword(body.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next, env), u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    ]);
  } else if (action === 'delete') {
    await env.DB.batch(deleteUserStatements(env, u.id));
  }
  return json({ ok: true });
}

async function exportAll(env) {
  const [authors, reviews] = await Promise.all([
    env.DB.prepare('SELECT a.id, a.name, a.avatar, a.bio, a.updated_at, u.username AS owner FROM authors a LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY a.created_at ASC').all(),
    env.DB.prepare(`${SELECT_REVIEWS} ORDER BY created_at DESC`).all(),
  ]);
  // Аккаунты и пароли в экспорт не попадают.
  return json({ version: 3, exportedAt: new Date().toISOString(), authors: authors.results.map(rowToAuthor), reviews: reviews.results.map(rowToReview) });
}

async function importAll(request, env) {
  const body = await readJson(request, 3 * 1024 * 1024);
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
      let bio = '';
      try { bio = optionalText(a.bio, LIMITS.bio, 'Описание'); } catch { bio = ''; }
      const key = name.toLowerCase();
      if (byName.has(key)) { idMap.set(a.id, byName.get(key)); continue; }
      const id = typeof a.id === 'string' && ID_RE.test(a.id) && !knownIds.has(a.id) ? a.id : 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      byName.set(key, id);
      knownIds.add(id);
      idMap.set(a.id, id);
      authorsAdded++;
      statements.push(env.DB.prepare('INSERT INTO authors (id, name, avatar, bio, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, avatar, bio, now, now));
    } catch { skipped++; }
  }

  let reviewsPrepared = 0;
  rawReviews.forEach((r, i) => {
    try {
      if (!r || typeof r !== 'object') throw new Error('bad');
      const kind = r.reviewerKind === 'user' ? 'user' : 'ai';
      const reviewerName = kind === 'ai'
        ? (AI_NAMES.includes(r.reviewerName) ? r.reviewerName : r.ai)
        : clean(r.reviewerName, { min: 2, max: 32 });
      if (kind === 'ai' && !AI_NAMES.includes(reviewerName)) throw new Error('bad ai');
      const rawId = r.id == null ? '' : String(r.id);
      const mapped = idMap.get(r.authorId) || (knownIds.has(r.authorId) ? r.authorId : 'a1');
      statements.push(bindReview(env, {
        id: ID_RE.test(rawId) ? rawId : crypto.randomUUID(),
        articleTitle: clean(r.articleTitle, { min: 1, max: LIMITS.article }),
        reviewTitle: clean(r.reviewTitle, { min: 1, max: LIMITS.title }),
        authorId: mapped, reviewerKind: kind, reviewerName, reviewerUserId: null,
        text: clean(r.text, { min: 1, max: LIMITS.body, multiline: true }),
        criteria: parseCriteria(r.criteria),
        status: r.status === 'pending' ? 'pending' : 'approved',
        createdAt: Number.isFinite(r.createdAt) ? Math.trunc(r.createdAt) : now - i,
      }));
      reviewsPrepared++;
    } catch { skipped++; }
  });

  for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));
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

    const needUser = async () => {
      const u = await getSessionUser(request, env);
      if (!u) throw new HttpError(401, 'Требуется вход в аккаунт');
      return u;
    };

    if (path === '/api/config' && method === 'GET') {
      return json({
        turnstileSiteKey: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null,
        adminEnabled: adminEnabled(env),
        limits: { body: LIMITS.body, bio: LIMITS.bio },
      });
    }
    if (path === '/api/data' && method === 'GET') return json(await getData(env, await isAdmin(request, env)));
    let avatarMatch = path.match(/^\/api\/avatar\/([A-Za-z0-9_-]{1,64})$/);
    if (avatarMatch && method === 'GET') return await getUserAvatar(env, avatarMatch[1]);

    if (path === '/api/register' && method === 'POST') return await register(request, env);
    if (path === '/api/login' && method === 'POST') return await login(request, env);
    if (path === '/api/logout' && method === 'POST') return await logout(request, env);
    if (path === '/api/me' && method === 'GET') return json(await meInfo(env, await getSessionUser(request, env)));
    if (path === '/api/me/profile' && method === 'POST') return await updateProfile(request, env, await needUser());
    if (path === '/api/me/avatar' && method === 'POST') return await uploadUserAvatar(request, env, await needUser());
    if (path === '/api/me/password' && method === 'POST') return await changePassword(request, env, await needUser());
    if (path === '/api/me/delete' && method === 'POST') return await deleteAccount(request, env, await needUser());
    if (path === '/api/me/reviews' && method === 'GET') {
      const u = await needUser();
      const res = await env.DB.prepare(`${SELECT_REVIEWS} WHERE reviewer_user_id = ? ORDER BY created_at DESC LIMIT 200`).bind(u.id).all();
      return json({ reviews: res.results.map(rowToReview) });
    }

    if (path === '/api/reviews' && method === 'POST') {
      const [user, admin] = await Promise.all([getSessionUser(request, env), isAdmin(request, env)]);
      return await createReview(request, env, user, admin);
    }

    if (path === '/api/authors' && method === 'POST') return await createOwnAuthor(request, env, await needUser());
    let m = path.match(/^\/api\/authors\/([A-Za-z0-9_-]{1,64})$/);
    if (m && method === 'POST') {
      const [user, admin] = await Promise.all([getSessionUser(request, env), isAdmin(request, env)]);
      if (!user && !admin) throw new HttpError(401, 'Требуется вход в аккаунт');
      return await updateAuthor(request, env, m[1], user, admin);
    }

    /* --- вход администратора --- */
    if (path === '/api/admin/me' && method === 'GET') return json({ admin: await isAdmin(request, env) });
    if (path === '/api/admin/login' && method === 'POST') {
      if (!adminEnabled(env)) throw new HttpError(503, 'Вход администратора не настроен (ADMIN_PASSWORD)');
      await rateLimit(env, 'admin-login', await ipHash(request, env), 8, 900);
      const body = await readJson(request, 2 * 1024);
      if (typeof body.password !== 'string' || !(await safeEqual(body.password, env.ADMIN_PASSWORD))) {
        throw new HttpError(401, 'Неверный пароль');
      }
      const s = await makeAdminSession(env);
      return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(s.value, s.maxAge) });
    }
    if (path === '/api/admin/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': adminCookie('', 0) });

    if (path.startsWith('/api/admin/')) {
      if (!(await isAdmin(request, env))) throw new HttpError(401, 'Требуется вход администратора');

      if (path === '/api/admin/pending' && method === 'GET') {
        const res = await env.DB.prepare(`${SELECT_REVIEWS} WHERE status = 'pending' ORDER BY created_at ASC LIMIT 500`).all();
        return json({ reviews: res.results.map(rowToReview) });
      }
      if (path === '/api/admin/authors' && method === 'POST') return await adminCreateAuthor(request, env);
      if (path === '/api/admin/export' && method === 'GET') return await exportAll(env);
      if (path === '/api/admin/import' && method === 'POST') return await importAll(request, env);

      m = path.match(/^\/api\/admin\/authors\/([A-Za-z0-9_-]{1,64})(\/owner)?$/);
      if (m && !m[2] && method === 'DELETE') return await deleteAuthor(env, m[1]);
      if (m && m[2] && method === 'POST') return await setAuthorOwner(request, env, m[1]);

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

      m = path.match(/^\/api\/admin\/users\/([^/]{1,64})\/(ban|password|delete)$/);
      if (m && method === 'POST') return await adminUserAction(request, env, decodeURIComponent(m[1]), m[2]);
    }

    throw new HttpError(404, 'Не найдено');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Внутренняя ошибка сервера' }, 500);
  }
}
