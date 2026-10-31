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
    hasReview: r.has_review == null ? true : !!r.has_review,
    hasScore: r.has_score == null ? true : !!r.has_score,
    text: r.has_review === 0 ? '' : r.body,
    criteria: r.has_score === 0 ? null : [r.c1, r.c2, r.c3, r.c4, r.c_atm],
    rating: r.has_score === 0 ? null : (r.rating ?? Math.min(100, Math.round(Number(r.score) * 100 / 90))),
    score: r.has_score === 0 ? null : (r.rating ?? Math.min(100, Math.round(Number(r.score) * 100 / 90))),
    status: r.status,
    createdAt: r.created_at,
    likes: Number(r.likes || 0),
    likedByMe: !!r.liked_by_me,
  };
}

const rowToAuthor = (a) => ({
  id: a.id, name: a.name, avatar: a.avatar, bio: a.bio || '', ownerUsername: a.owner || null, updatedAt: a.updated_at || 0,
});

function publicUserAvatar(id, avatar) {
  return typeof avatar === 'string' && avatar.startsWith('data:image/webp;base64,')
    ? `/api/avatar/${id}`
    : (avatar || '');
}

function parseJson(value, fallback) {
  try { const parsed = JSON.parse(value || ''); return parsed && typeof parsed === 'object' ? parsed : fallback; }
  catch { return fallback; }
}

const rowToUser = (u) => ({
  username: u.username, avatar: publicUserAvatar(u.id, u.avatar), bio: u.bio || '', createdAt: u.created_at, banned: !!u.banned,
  socialLinks: parseJson(u.social_links, {}), favoriteAuthorIds: parseJson(u.favorite_author_ids, []), favoriteArticles: parseJson(u.favorite_articles, []),
});

const SELECT_REVIEWS = "SELECT reviews.*, (reviews.reviewer_user_id IS NOT NULL) AS registered, review_ratings.rating, CASE WHEN review_decisions.decision = 'rejected' THEN 'rejected' ELSE reviews.status END AS status FROM reviews LEFT JOIN review_ratings ON review_ratings.review_id = reviews.id LEFT JOIN review_decisions ON review_decisions.review_id = reviews.id";

const INSERT_REVIEW =
  'INSERT OR IGNORE INTO reviews (id, article_title, review_title, author_id, reviewer_kind, reviewer_name, reviewer_user_id, body, c1, c2, c3, c4, c_atm, score, has_review, has_score, status, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function bindReview(env, r) {
  const c = r.criteria;
  return env.DB.prepare(INSERT_REVIEW).bind(
    r.id, r.articleTitle, r.reviewTitle, r.authorId, r.reviewerKind, r.reviewerName, r.reviewerUserId || null, r.text,
    c[0], c[1], c[2], c[3], c[4], calcScore(c), r.hasReview === false ? 0 : 1, r.hasScore === false ? 0 : 1, r.status, r.createdAt,
  );
}

const isUnique = (e) => /UNIQUE|constraint/i.test(String((e && e.message) || e));

async function recordSiteLog(env, category, message, actor = 'Система') {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO site_logs (id, category, message, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), clean(category, { min: 1, max: 32, label: 'Категория журнала' }), clean(message, { min: 1, max: 240, label: 'Событие журнала' }), clean(actor || 'Система', { min: 1, max: 60, label: 'Автор события' }), now),
    env.DB.prepare('DELETE FROM site_logs WHERE id NOT IN (SELECT id FROM site_logs ORDER BY created_at DESC LIMIT 5000)'),
  ]);
}

async function adminDashboard(env) {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const [catalog, reviews, ratings, engagement, users, logs] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS articles FROM articles').first(),
    env.DB.prepare("SELECT SUM(CASE WHEN status = 'approved' AND has_review = 1 THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'pending' AND review_decisions.review_id IS NULL THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM reviews LEFT JOIN review_decisions ON review_decisions.review_id = reviews.id").bind(week).first(),
    env.DB.prepare('SELECT COUNT(*) AS total, AVG(rating) AS average FROM review_ratings').first(),
    env.DB.prepare('SELECT COUNT(*) AS likes FROM review_likes').first(),
    env.DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM users WHERE banned = 0').bind(week).first(),
    env.DB.prepare('SELECT id, category, message, actor, created_at AS createdAt FROM site_logs ORDER BY created_at DESC LIMIT 100').all(),
  ]);
  return json({ stats: {
    articles: Number(catalog?.articles || 0), authors: Number((await env.DB.prepare('SELECT COUNT(*) AS total FROM authors').first())?.total || 0),
    users: Number(users?.total || 0), publishedReviews: Number(reviews?.published || 0), pendingReviews: Number(reviews?.pending || 0),
    ratings: Number(ratings?.total || 0), averageRating: ratings?.average == null ? null : Number(ratings.average), likes: Number(engagement?.likes || 0),
    newReviewsWeek: Number(reviews?.recent || 0), newUsersWeek: Number(users?.recent || 0),
  }, logs: logs.results });
}

/* ---------- публичные данные ---------- */

async function getData(env, admin, userId) {
  const usersSql = admin
    ? 'SELECT id, username, avatar, bio, social_links, favorite_author_ids, favorite_articles, created_at, banned FROM users ORDER BY created_at DESC LIMIT 5000'
    : 'SELECT id, username, avatar, bio, social_links, favorite_author_ids, favorite_articles, created_at, 0 AS banned FROM users WHERE banned = 0 ORDER BY created_at DESC LIMIT 5000';
  const [authors, reviews, users, articleDates, articles, articleAuthors] = await Promise.all([
    env.DB.prepare(
      'SELECT a.id, a.name, a.avatar, a.bio, a.updated_at, u.username AS owner FROM authors a ' +
      'LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY a.created_at ASC, a.name ASC',
    ).all(),
    env.DB.prepare(
      'SELECT reviews.*, review_ratings.rating, (reviews.reviewer_user_id IS NOT NULL) AS registered, COUNT(review_likes.user_id) AS likes, ' +
      'MAX(CASE WHEN review_likes.user_id = ? THEN 1 ELSE 0 END) AS liked_by_me ' +
      'FROM reviews LEFT JOIN review_ratings ON review_ratings.review_id = reviews.id LEFT JOIN review_likes ON review_likes.review_id = reviews.id ' +
      "WHERE reviews.status = 'approved' GROUP BY reviews.id ORDER BY reviews.created_at DESC LIMIT 3000",
    ).bind(userId || '').all(),
    env.DB.prepare(usersSql).all(),
    env.DB.prepare('SELECT article_title, created_date FROM article_dates ORDER BY article_title COLLATE NOCASE').all(),
    env.DB.prepare('SELECT article_key, article_title, author_id, created_date, wiki_url, cover_image FROM articles ORDER BY article_title COLLATE NOCASE').all(),
    env.DB.prepare('SELECT article_key, author_id FROM article_authors ORDER BY position, author_id').all(),
  ]);
  const authorIdsByKey = new Map();
  for (const row of articleAuthors.results) { if (!authorIdsByKey.has(row.article_key)) authorIdsByKey.set(row.article_key, []); authorIdsByKey.get(row.article_key).push(row.author_id); }
  return {
    authors: authors.results.map(rowToAuthor),
    reviews: reviews.results.map(rowToReview),
    users: users.results.map(rowToUser),
    articleDates: articleDates.results.map((row) => ({ articleTitle: row.article_title, createdDate: row.created_date })),
    articles: articles.results.map((row) => ({ articleKey: row.article_key, title: row.article_title, authorId: row.author_id, authorIds: authorIdsByKey.get(row.article_key) || [row.author_id], createdDate: row.created_date, wikiUrl: row.wiki_url, coverImage: row.cover_image || '' })),
  };
}

async function likeReview(env, user, reviewId) {
  await rateLimit(env, 'review-like', user.id, 30, 3600);
  const review = await env.DB.prepare(
    "SELECT reviewer_user_id, review_title FROM reviews WHERE id = ? AND status = 'approved' AND reviewer_kind = 'user' AND has_review = 1",
  ).bind(reviewId).first();
  if (!review) throw new HttpError(404, 'Рецензия не найдена');
  if (review.reviewer_user_id === user.id) throw new HttpError(403, 'Нельзя поставить лайк своей рецензии');
  const likedAt = Date.now();
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO review_likes (review_id, user_id, created_at) VALUES (?, ?, ?)')
    .bind(reviewId, user.id, likedAt).run();
  if (inserted.meta.changes && review.reviewer_user_id) {
    const liker = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(user.id).first();
    await env.DB.prepare('INSERT OR IGNORE INTO notifications (id, user_id, type, review_id, review_title, actor_user_id, actor_name, created_at) VALUES (?, ?, \'review_liked\', ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), review.reviewer_user_id, reviewId, review.review_title || 'Рецензия', user.id, liker?.username || 'Пользователь', likedAt).run();
  }
  if (inserted.meta.changes) {
    const liker = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(user.id).first();
    await recordSiteLog(env, 'Лайк', `Поставлен лайк рецензии «${review.review_title || 'Без заголовка'}»`, liker?.username || 'Пользователь');
  }
  const result = await env.DB.prepare('SELECT COUNT(*) AS likes FROM review_likes WHERE review_id = ?').bind(reviewId).first();
  return json({ ok: true, likes: Number(result?.likes || 0), likedByMe: true });
}

async function meInfo(env, user) {
  if (!user) return { user: null, authorId: null };
  const results = await Promise.all([
    env.DB.prepare('SELECT id, username, avatar, bio, social_links, favorite_author_ids, favorite_articles, created_at FROM users WHERE id = ?').bind(user.id).first(),
    env.DB.prepare('SELECT id FROM authors WHERE owner_user_id = ?').bind(user.id).first(),
  ]);
  return { user: results[0] ? rowToUser(results[0]) : null, authorId: results[1] ? results[1].id : null };
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
  await recordSiteLog(env, 'Регистрация', `Создан аккаунт «${name}»`, name);
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

const SOCIAL_FIELDS = ['fandom', 'youtube', 'tiktok', 'discord', 'telegram', 'instagram', 'vk', 'other'];

function parseSocialLinks(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Социальные ссылки: неверный формат');
  const result = {};
  for (const key of SOCIAL_FIELDS) {
    const raw = value[key];
    if (raw == null || raw === '') { result[key] = ''; continue; }
    if (typeof raw !== 'string' || raw.length > 300) throw new HttpError(400, 'Ссылка должна быть не длиннее 300 символов');
    let url;
    try { url = new URL(raw.trim()); } catch { throw new HttpError(400, 'Проверьте формат социальных ссылок'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, 'Для социальных ссылок разрешены только HTTPS-адреса');
    result[key] = url.toString();
  }
  return result;
}

function parseFavorites(value, label, max = 20) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, label + ': выберите не больше ' + max);
  const result = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim() || [...raw].length > 150) throw new HttpError(400, label + ': некорректное значение');
    const item = raw.trim();
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

async function updateProfile(request, env, user) {
  const body = await readJson(request, 16 * 1024);
  const bio = optionalText(body.bio, LIMITS.bio, 'О себе');
  const avatar = body.avatar == null ? user.avatar : parseAvatar(body.avatar);
  const socialLinks = parseSocialLinks(body.socialLinks || {});
  const favoriteAuthorIds = parseFavorites(body.favoriteAuthorIds || [], 'Любимые авторы');
  const favoriteArticles = parseFavorites(body.favoriteArticles || [], 'Избранные статьи');
  if (favoriteAuthorIds.length) {
    const placeholders = favoriteAuthorIds.map(() => '?').join(', ');
    const rows = await env.DB.prepare('SELECT id FROM authors WHERE id IN (' + placeholders + ')').bind(...favoriteAuthorIds).all();
    const validIds = new Set(rows.results.map((row) => row.id));
    if (favoriteAuthorIds.some((id) => !validIds.has(id))) throw new HttpError(400, 'Список любимых авторов устарел. Обновите страницу.');
  }
  await env.DB.prepare('UPDATE users SET bio = ?, avatar = ?, social_links = ?, favorite_author_ids = ?, favorite_articles = ? WHERE id = ?')
    .bind(bio, avatar, JSON.stringify(socialLinks), JSON.stringify(favoriteAuthorIds), JSON.stringify(favoriteArticles), user.id).run();
  await recordSiteLog(env, 'Аккаунт', 'Обновлён профиль пользователя', user.username);
  return json({ ok: true });
}

async function uploadUserAvatar(request, env, user) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > 2 * 1024 * 1024 + 65536) throw new HttpError(413, 'Исходное изображение должно быть не больше 2 МБ');
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Не удалось прочитать загруженный файл'); }
  const file = form.get('avatar');
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'Выберите изображение');
  if (!file.size || file.size > 350 * 1024) throw new HttpError(413, 'После обработки изображение должно быть не больше 350 КБ');
  if (file.type !== 'image/webp') throw new HttpError(400, 'Изображение не обработано: обновите страницу и попробуйте снова');
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isWebp = signature.length >= 12 && String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP';
  if (!isWebp) throw new HttpError(400, 'Файл не похож на корректное WebP-изображение');

  const data = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  const avatar = `data:image/webp;base64,${btoa(binary)}`;
  await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, user.id).run();
  await recordSiteLog(env, 'Аккаунт', 'Обновлена фотография профиля', user.username);
  return json({ ok: true, avatar: `/api/avatar/${user.id}` });
}

async function getUserAvatar(env, id) {
  const row = await env.DB.prepare('SELECT avatar FROM users WHERE id = ?').bind(id).first();
  const match = row && typeof row.avatar === 'string' && row.avatar.match(/^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(404, 'Аватар не найден');
  let binary;
  try { binary = atob(match[1]); } catch { throw new HttpError(404, 'Аватар не найден'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
  await recordSiteLog(env, 'Аккаунт', 'Изменён пароль пользователя', user.username);
  const { cookie } = await createSession(env, user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Удаление аккаунта: рецензии остаются, но отвязываются от пользователя.
function deleteUserStatements(env, userId) {
  return [
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM review_likes WHERE user_id = ?').bind(userId),
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
  await recordSiteLog(env, 'Аккаунт', 'Удалён пользовательский аккаунт', user.username);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/* ---------- рецензии ---------- */

function validateArticleDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, 'Укажите дату в формате ГГГГ-ММ-ДД');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, 'Указана несуществующая дата');
  }
  return value;
}

async function setArticleDate(request, env) {
  const body = await readJson(request, 4 * 1024);
  const requestedTitle = clean(body.articleTitle, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const article = await env.DB.prepare(
    'SELECT article_title FROM reviews WHERE article_title = ? COLLATE NOCASE LIMIT 1',
  ).bind(requestedTitle).first();
  const createdDate = validateArticleDate(body.createdDate);
  const catalogArticle = await env.DB.prepare('SELECT article_title FROM articles WHERE article_title = ? COLLATE NOCASE LIMIT 1').bind(requestedTitle).first();
  if (!article && !catalogArticle) throw new HttpError(404, 'Статья не найдена');
  if (catalogArticle) {
    await env.DB.prepare('UPDATE articles SET created_date = ? WHERE article_title = ? COLLATE NOCASE').bind(createdDate, catalogArticle.article_title).run();
    await recordSiteLog(env, 'Каталог', `Изменена дата выхода статьи «${catalogArticle.article_title}»`, 'Администратор');
    return json({ ok: true, articleTitle: catalogArticle.article_title, createdDate });
  }
  if (!article) throw new HttpError(404, 'Статья не найдена');
  const articleTitle = article.article_title;
  const articleKey = articleTitle.normalize('NFC').toLowerCase();
  await env.DB.prepare(
    'INSERT INTO article_dates (article_key, article_title, created_date, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(article_key) DO UPDATE SET article_title = excluded.article_title, created_date = excluded.created_date, updated_at = excluded.updated_at',
  ).bind(articleKey, articleTitle, createdDate, Date.now()).run();
  await recordSiteLog(env, 'Каталог', `Изменена дата выхода статьи «${articleTitle}»`, 'Администратор');
  return json({ ok: true, articleTitle, createdDate });
}

function validateWikiUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, 'Ссылка на статью в ЗМВ слишком длинная');
  let candidate = value.trim();
  const markdownLink = candidate.match(/^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/i);
  if (markdownLink) candidate = markdownLink[2];
  if (candidate.length > 2048) throw new HttpError(400, 'Ссылка на статью в ЗМВ слишком длинная');
  let url;
  try { url = new URL(candidate); } catch { throw new HttpError(400, 'Проверьте ссылку на статью в ЗМВ'); }
  if (url.protocol !== 'https:' || url.hostname !== 'minecraft-backrooms.fandom.com' || url.username || url.password) throw new HttpError(400, 'Ссылка должна вести на HTTPS-страницу minecraft-backrooms.fandom.com');
  return url.toString();
}
function validateArticleAuthors(body) {
  const ids = Array.isArray(body.authorIds) ? body.authorIds : [body.authorId];
  if (!ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !ID_RE.test(id)) || new Set(ids).size !== ids.length) throw new HttpError(400, 'Выберите от одного до 20 разных авторов');
  return ids;
}
function validateCoverImage(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new HttpError(400, 'URL изображения слишком длинный');
  let url;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'Укажите корректный URL изображения'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipv4 = host.split('.').map(Number);
  const localAddress = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.startsWith('[') || (ipv4.length === 4 && ipv4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168)));
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || localAddress) throw new HttpError(400, 'Для изображения разрешены публичные HTTPS-ссылки без логина и пароля');
  return url.toString();
}
async function checkArticleAuthors(env, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const found = await env.DB.prepare(`SELECT id FROM authors WHERE id IN (${placeholders})`).bind(...ids).all();
  if (found.results.length !== ids.length) throw new HttpError(400, 'Один из авторов не найден');
}
async function adminCreateArticle(request, env) {
  const body = await readJson(request, 16 * 1024);
  const title = clean(body.title, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const authorIds = validateArticleAuthors(body);
  await checkArticleAuthors(env, authorIds);
  const createdDate = validateArticleDate(body.createdDate);
  const wikiUrl = validateWikiUrl(body.wikiUrl);
  const coverImage = validateCoverImage(body.coverImage);
  const key = title.normalize('NFC').toLowerCase();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO articles (article_key, article_title, author_id, created_date, wiki_url, created_at, cover_image) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(key, title, authorIds[0], createdDate, wikiUrl, now, coverImage),
      ...authorIds.map((id, i) => env.DB.prepare('INSERT INTO article_authors (article_key, author_id, position) VALUES (?, ?, ?)').bind(key, id, i)),
    ]);
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Статья с таким названием уже есть в каталоге');
    throw e;
  }
  await recordSiteLog(env, 'Каталог', `Добавлена статья «${title}»`, 'Администратор');
  return json({ ok: true }, 201);
}
async function adminUpdateArticle(request, env, key) {
  let article = await env.DB.prepare('SELECT * FROM articles WHERE article_key = ?').bind(key).first();
  if (!article) {
    const normalizedKey = key.normalize('NFC').toLowerCase();
    const titles = await env.DB.prepare('SELECT article_key, article_title FROM articles').all();
    const match = titles.results.find((row) => row.article_title.normalize('NFC').toLowerCase() === normalizedKey);
    if (match) article = await env.DB.prepare('SELECT * FROM articles WHERE article_key = ?').bind(match.article_key).first();
  }
  if (!article) throw new HttpError(404, 'Статья не найдена');
  const body = await readJson(request, 16 * 1024);
  const title = clean(body.title, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const authorIds = validateArticleAuthors(body);
  await checkArticleAuthors(env, authorIds);
  const createdDate = validateArticleDate(body.createdDate);
  const wikiUrl = validateWikiUrl(body.wikiUrl);
  const coverImage = validateCoverImage(body.coverImage);
  const newKey = title.normalize('NFC').toLowerCase();
  try {
    const statements = [env.DB.prepare('DELETE FROM article_authors WHERE article_key = ?').bind(key), env.DB.prepare('UPDATE articles SET article_key = ?, article_title = ?, author_id = ?, created_date = ?, wiki_url = ?, cover_image = ? WHERE article_key = ?').bind(newKey, title, authorIds[0], createdDate, wikiUrl, coverImage, key),
      env.DB.prepare('UPDATE reviews SET article_title = ? WHERE article_title = ?').bind(title, article.article_title)];
    statements.push(...authorIds.map((id, i) => env.DB.prepare('INSERT INTO article_authors (article_key, author_id, position) VALUES (?, ?, ?)').bind(newKey, id, i)));
    await env.DB.batch(statements);
  } catch (e) { if (isUnique(e)) throw new HttpError(409, 'Статья с таким названием уже есть в каталоге'); throw e; }
  await recordSiteLog(env, 'Каталог', `Обновлена статья «${title}»`, 'Администратор');
  return json({ ok: true });
}
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

  const hasReview = body.hasReview !== false;
  const hasScore = body.hasScore !== false;
  if (!hasReview && !hasScore) throw new HttpError(400, 'Выберите рецензию, оценку или оба варианта');

  if (!admin) {
    await rateLimit(env, 'review', user.id, 5, 3600);
    // Оценки без текстовой рецензии публикуются сразу и не занимают очередь модерации.
    if (hasReview || !hasScore) {
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending' AND id NOT IN (SELECT review_id FROM review_decisions WHERE decision = 'rejected')").first();
      if (pending && pending.n >= 300) throw new HttpError(503, 'Очередь модерации переполнена, попробуйте позже');
    }
  }
  let articleTitle = clean(body.articleTitle, { min: 2, max: LIMITS.article, label: 'Название статьи' });
  const reviewTitle = hasReview ? clean(body.reviewTitle, { min: 2, max: LIMITS.title, label: 'Заголовок рецензии' }) : '';
  const text = hasReview ? clean(body.text, { min: LIMITS.minBody, max: LIMITS.body, multiline: true, label: 'Текст рецензии' }) : '';
  const rating = hasScore ? body.rating : null;
  if (hasScore && (!Number.isInteger(rating) || rating < 0 || rating > 100)) throw new HttpError(400, 'Оценка должна быть целым числом от 0 до 100');
  const criteria = [5, 5, 5, 5, 5];

  if (typeof body.authorId !== 'string' || !ID_RE.test(body.authorId)) throw new HttpError(400, 'Выберите автора статьи');
  let authorId = body.authorId;
  if (!(await env.DB.prepare('SELECT id FROM authors WHERE id = ?').bind(authorId).first())) throw new HttpError(400, 'Автор не найден');

  // Если рецензии на эту статью уже есть, берём каноничное написание и автора.
  const catalogArticle = await env.DB.prepare('SELECT article_title, author_id FROM articles WHERE article_title = ? COLLATE NOCASE LIMIT 1').bind(articleTitle).first();
  const existing = catalogArticle || await env.DB.prepare('SELECT article_title, author_id FROM reviews WHERE article_title = ? COLLATE NOCASE LIMIT 1').bind(articleTitle).first();
  if (existing) { articleTitle = existing.article_title; authorId = existing.author_id; }

  const review = {
    id: crypto.randomUUID(), articleTitle, reviewTitle, authorId, reviewerKind, reviewerName, reviewerUserId, text, criteria, hasReview, hasScore,
    status: admin || (!hasReview && hasScore) ? 'approved' : 'pending', createdAt: Date.now(),
  };
  const legacyReview = bindReview(env, review);
  const inserts = [legacyReview];
  if (hasScore) inserts.push(env.DB.prepare('INSERT OR IGNORE INTO review_ratings (review_id, rating) VALUES (?, ?)').bind(review.id, rating));
  await env.DB.batch(inserts);
  await recordSiteLog(env, 'Новая запись', `${hasReview ? 'Добавлена рецензия' : 'Выставлена оценка'} для «${articleTitle}» (${review.status === 'pending' ? 'ожидает модерации' : 'опубликована'})`, reviewerName);
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
  await recordSiteLog(env, 'Профиль автора', `Создана карточка автора «${name}»`, user.username);
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
  await recordSiteLog(env, 'Профиль автора', `Изменена карточка автора «${name}»`, admin ? 'Администратор' : (user?.username || 'Автор'));
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
  await recordSiteLog(env, 'Профиль автора', `Создана карточка автора «${name}»`, 'Администратор');
  return json({ ok: true, id }, 201);
}

async function deleteAuthor(env, id) {
  if (id === 'a1') throw new HttpError(400, 'Нельзя удалить автора по умолчанию');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM article_authors WHERE author_id = ?').bind(id),
    env.DB.prepare("UPDATE articles SET author_id = COALESCE((SELECT aa.author_id FROM article_authors aa WHERE aa.article_key = articles.article_key ORDER BY aa.position LIMIT 1), 'a1') WHERE author_id = ?").bind(id),
    env.DB.prepare("INSERT OR IGNORE INTO article_authors (article_key, author_id, position) SELECT a.article_key, 'a1', 0 FROM articles a WHERE NOT EXISTS (SELECT 1 FROM article_authors aa WHERE aa.article_key = a.article_key)"),
    env.DB.prepare("UPDATE reviews SET author_id = 'a1' WHERE author_id = ?").bind(id),
    env.DB.prepare('DELETE FROM authors WHERE id = ?').bind(id),
  ]);
  await recordSiteLog(env, 'Профиль автора', `Удалена карточка автора ${id}`, 'Администратор');
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
  const [authors, reviews, articleDates] = await Promise.all([
    env.DB.prepare('SELECT a.id, a.name, a.avatar, a.bio, a.updated_at, u.username AS owner FROM authors a LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY a.created_at ASC').all(),
    env.DB.prepare(`${SELECT_REVIEWS} ORDER BY created_at DESC`).all(),
    env.DB.prepare('SELECT article_title, created_date FROM article_dates ORDER BY article_title COLLATE NOCASE').all(),
  ]);
  // Аккаунты и пароли в экспорт не попадают.
  return json({
    version: 5,
    exportedAt: new Date().toISOString(),
    authors: authors.results.map(rowToAuthor),
    reviews: reviews.results.map(rowToReview),
    articleDates: articleDates.results.map((row) => ({ articleTitle: row.article_title, createdDate: row.created_date })),
  });
}

async function importAll(request, env) {
  const body = await readJson(request, 3 * 1024 * 1024);
  // Поддерживается и старый формат (authorsData / reviewsData), и новый (authors / reviews).
  const rawAuthors = Array.isArray(body.authors) ? body.authors : Array.isArray(body.authorsData) ? body.authorsData : [];
  const rawReviews = Array.isArray(body.reviews) ? body.reviews : Array.isArray(body.reviewsData) ? body.reviewsData : [];
  const rawArticleDates = Array.isArray(body.articleDates) ? body.articleDates : [];
  if (rawAuthors.length > 500 || rawReviews.length > 5000 || rawArticleDates.length > 5000) throw new HttpError(413, 'Слишком много записей');
  if (!rawAuthors.length && !rawReviews.length && !rawArticleDates.length) throw new HttpError(400, 'В файле нет данных для импорта');

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
      const imported = {
        id: ID_RE.test(rawId) ? rawId : crypto.randomUUID(),
        articleTitle: clean(r.articleTitle, { min: 1, max: LIMITS.article }),
        reviewTitle: r.hasReview === false ? '' : clean(r.reviewTitle, { min: 1, max: LIMITS.title }),
        authorId: mapped, reviewerKind: kind, reviewerName, reviewerUserId: null,
        text: r.hasReview === false ? '' : clean(r.text || '', { min: 1, max: LIMITS.body, multiline: true }),
        criteria: r.hasScore === false ? [5, 5, 5, 5, 5] : parseCriteria(r.criteria),
        hasReview: r.hasReview !== false, hasScore: r.hasScore !== false,
        status: (r.status === 'pending' || r.status === 'rejected') ? 'pending' : 'approved',
        createdAt: Number.isFinite(r.createdAt) ? Math.trunc(r.createdAt) : now - i,
      };
      statements.push(bindReview(env, imported));
      if (imported.hasScore) {
        const migratedRating = Number.isInteger(r.rating) && r.rating >= 0 && r.rating <= 100
          ? r.rating
          : Math.min(100, Math.round((Number.isFinite(r.score) ? r.score : calcScore(imported.criteria)) * 100 / 90));
        statements.push(env.DB.prepare('INSERT OR IGNORE INTO review_ratings (review_id, rating) VALUES (?, ?)').bind(imported.id, migratedRating));
      }
      if (r.status === 'rejected') statements.push(env.DB.prepare("INSERT OR IGNORE INTO review_decisions (review_id, decision, decided_at) VALUES (?, 'rejected', ?)").bind(imported.id, imported.createdAt));
      reviewsPrepared++;
    } catch { skipped++; }
  });

  for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));

  let articleDatesImported = 0;
  for (const item of rawArticleDates) {
    try {
      if (!item || typeof item !== 'object') throw new Error('bad article date');
      const requestedTitle = clean(item.articleTitle, { min: 2, max: LIMITS.article, label: 'Название статьи' });
      const article = await env.DB.prepare(
        'SELECT article_title FROM reviews WHERE article_title = ? COLLATE NOCASE LIMIT 1',
      ).bind(requestedTitle).first();
      if (!article) throw new Error('unknown article');
      const createdDate = validateArticleDate(item.createdDate);
      const articleTitle = article.article_title;
      const articleKey = articleTitle.normalize('NFC').toLowerCase();
      await env.DB.prepare(
        'INSERT INTO article_dates (article_key, article_title, created_date, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(article_key) DO UPDATE SET article_title = excluded.article_title, created_date = excluded.created_date, updated_at = excluded.updated_at',
      ).bind(articleKey, articleTitle, createdDate, now).run();
      articleDatesImported++;
    } catch { skipped++; }
  }
  return json({ ok: true, authorsAdded, reviewsProcessed: reviewsPrepared, articleDatesImported, skipped });
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
    if (path === '/api/data' && method === 'GET') {
      const [admin, user] = await Promise.all([isAdmin(request, env), getSessionUser(request, env)]);
      return json(await getData(env, admin, user?.id));
    }
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
    if (path === '/api/me/notifications' && method === 'GET') {
      const u = await needUser();
      const res = await env.DB.prepare('SELECT id, type, review_id AS reviewId, review_title AS reviewTitle, actor_name AS actorName, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id).all();
      return json({ notifications: res.results });
    }
    if (path === '/api/me/notifications/read' && method === 'POST') {
      const u = await needUser();
      await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(Date.now(), u.id).run();
      return json({ ok: true });
    }

    if (path === '/api/reviews' && method === 'POST') {
      const [user, admin] = await Promise.all([getSessionUser(request, env), isAdmin(request, env)]);
      return await createReview(request, env, user, admin);
    }
    const likeMatch = path.match(/^\/api\/reviews\/([A-Za-z0-9_-]{1,64})\/like$/);
    if (likeMatch && method === 'POST') return await likeReview(env, await needUser(), likeMatch[1]);
    const likesMatch = path.match(/^\/api\/reviews\/([A-Za-z0-9_-]{1,64})\/likes$/);
    if (likesMatch && method === 'GET') {
      const review = await env.DB.prepare("SELECT id FROM reviews WHERE id = ? AND status = 'approved' AND reviewer_kind = 'user' AND has_review = 1").bind(likesMatch[1]).first();
      if (!review) throw new HttpError(404, 'Рецензия не найдена');
      const likes = await env.DB.prepare('SELECT users.username, review_likes.created_at AS createdAt FROM review_likes JOIN users ON users.id = review_likes.user_id WHERE review_likes.review_id = ? ORDER BY review_likes.created_at DESC LIMIT 500').bind(likesMatch[1]).all();
      return json({ likes: likes.results });
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

      if (path === '/api/admin/dashboard' && method === 'GET') return await adminDashboard(env);
      if (path === '/api/admin/articles/date' && method === 'POST') return await setArticleDate(request, env);
      if (path === '/api/admin/articles' && method === 'POST') return await adminCreateArticle(request, env);
      const articleEdit = path.match(/^\/api\/admin\/articles\/(.+)$/);
      if (articleEdit && method === 'PUT') return await adminUpdateArticle(request, env, decodeURIComponent(articleEdit[1]));

      if (path === '/api/admin/pending' && method === 'GET') {
        const res = await env.DB.prepare(`${SELECT_REVIEWS} WHERE reviews.status = 'pending' AND review_decisions.review_id IS NULL ORDER BY reviews.created_at ASC LIMIT 500`).all();
        return json({ reviews: res.results.map(rowToReview) });
      }
      if (path === '/api/admin/authors' && method === 'POST') return await adminCreateAuthor(request, env);
      if (path === '/api/admin/export' && method === 'GET') return await exportAll(env);
      if (path === '/api/admin/import' && method === 'POST') return await importAll(request, env);

      m = path.match(/^\/api\/admin\/authors\/([A-Za-z0-9_-]{1,64})(\/owner)?$/);
      if (m && !m[2] && method === 'DELETE') return await deleteAuthor(env, m[1]);
      if (m && m[2] && method === 'POST') return await setAuthorOwner(request, env, m[1]);

      m = path.match(/^\/api\/admin\/reviews\/([A-Za-z0-9_-]{1,64})\/(approve|reject)$/);
      if (m && method === 'POST') {
        const [review, now] = [await env.DB.prepare('SELECT reviewer_user_id, review_title, status FROM reviews WHERE id = ?').bind(m[1]).first(), Date.now()];
        if (!review) throw new HttpError(404, 'Рецензия не найдена');
        if (review.status !== 'pending') throw new HttpError(409, 'Рецензия уже обработана');
        if (m[2] === 'approve') {
          await env.DB.batch([
            env.DB.prepare("UPDATE reviews SET status = 'approved' WHERE id = ?").bind(m[1]),
            env.DB.prepare('DELETE FROM review_decisions WHERE review_id = ?').bind(m[1]),
            ...(review.reviewer_user_id ? [env.DB.prepare("INSERT OR IGNORE INTO notifications (id, user_id, type, review_id, review_title, created_at) VALUES (?, ?, 'review_approved', ?, ?, ?)").bind(crypto.randomUUID(), review.reviewer_user_id, m[1], review.review_title, now)] : []),
          ]);
        } else {
          await env.DB.batch([
            env.DB.prepare("INSERT OR REPLACE INTO review_decisions (review_id, decision, decided_at) VALUES (?, 'rejected', ?)").bind(m[1], now),
            ...(review.reviewer_user_id ? [env.DB.prepare("INSERT OR IGNORE INTO notifications (id, user_id, type, review_id, review_title, created_at) VALUES (?, ?, 'review_rejected', ?, ?, ?)").bind(crypto.randomUUID(), review.reviewer_user_id, m[1], review.review_title, now)] : []),
          ]);
        }
        await recordSiteLog(env, 'Модерация', `${m[2] === 'approve' ? 'Одобрена' : 'Отклонена'} рецензия «${review.review_title || 'Без заголовка'}»`, 'Администратор');
        return json({ ok: true });
      }
      const deleteReviewMatch = path.match(/^\/api\/admin\/reviews\/([A-Za-z0-9_-]{1,64})$/);
      if (deleteReviewMatch && method === 'DELETE') {
        const res = await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(deleteReviewMatch[1]).run();
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
