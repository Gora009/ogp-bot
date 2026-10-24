import { EmbedBuilder, MessageFlags, escapeMarkdown } from 'discord.js';

/**
 * Текст из внешних источников (форум, ввод пользователей) для вставки в embed: экранирует разметку
 * и квадратные скобки — иначе можно подсунуть маскированную ссылку [безобидный текст](фишинг).
 */
export const safeText = (s) => escapeMarkdown(String(s ?? '')).replace(/[[\]]/g, '\\$&');
import { db } from './db.js';

/** Статичная конфигурация сервера (роли, второй сервер) — из .env */
export const cfg = (name) => process.env[name]?.trim() || null;

/** Единая палитра embed'ов — меняется здесь для всего бота */
export const C = {
  brand: 0xf5a200,   // жалобы, основные сообщения
  info: 0x5865f2,    // панели, справка, «на рассмотрении»
  details: 0x3498db, // карточки «Инфо», идущие процессы
  success: 0x2ecc71, // одобрено, успешно
  warn: 0xf1c40f,    // в работе, ожидает
  danger: 0xe74c3c,  // отклонено, просрочено, увольнение
  muted: 0x95a5a6,   // отменено, архив
};
export const COLOR = C.brand;
export const EPH = { flags: MessageFlags.Ephemeral };
export const nowTs = () => Math.floor(Date.now() / 1000);

export const msk = (ts) =>
  new Date(ts * 1000).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
export const mskDate = (ts) => msk(ts).split(' ')[0];
export const stamp = (ts = nowTs()) => `ОГП • ${msk(ts)} MSK`;

/** dd.mm.yyyy -> unix ts начала дня по Москве (UTC+3), либо null */
export function parseDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / 1000 - 3 * 3600;
}

export const isProsecutor = (userId) => !!db.prepare('SELECT 1 FROM prosecutors WHERE user_id=?').get(userId);

export function isOnVacation(userId) {
  const n = nowTs();
  return !!db.prepare(`SELECT 1 FROM vacations WHERE user_id=? AND status='approved' AND start_ts<=? AND end_ts>=?`)
    .get(userId, n, n);
}

/** Список прокуроров. seniorOnly — только старший состав; exclude — user_id, которых нельзя назначать (обвиняемые). */
export function listProsecutors({ seniorOnly = false, exclude = [] } = {}) {
  const n = nowTs();
  const skip = new Set(exclude);
  return db.prepare(`
    SELECT p.*, (p.on_leave OR EXISTS(SELECT 1 FROM vacations v WHERE v.user_id=p.user_id AND v.status='approved'
                       AND v.start_ts<=? AND v.end_ts>=?)) AS vacation
    FROM prosecutors p ORDER BY name COLLATE NOCASE`).all(n, n)
    .filter((p) => !skip.has(p.user_id) && (!seniorOnly || p.senior));
}

/**
 * Все участники сервера без лишних запросов: Discord разрешает загружать полный список не чаще ~раза в 30 секунд
 * (иначе «rate limited»). Загрузив один раз, дальше берём из памяти — с Server Members Intent Discord сам присылает
 * изменения (зашёл, вышел, роли). Полная перезагрузка — не чаще раза в 10 минут; если Discord просит подождать —
 * ждём и повторяем один раз, а при неудаче отдаём то, что уже есть в памяти.
 */
const membersLoadedAt = new Map();
export async function fetchMembers(guild) {
  if (Date.now() - (membersLoadedAt.get(guild.id) ?? 0) < 10 * 60_000) return guild.members.cache;
  for (let attempt = 0; ; attempt++) {
    try {
      const all = await guild.members.fetch();
      membersLoadedAt.set(guild.id, Date.now());
      return all;
    } catch (e) {
      const wait = Number(e?.data?.retry_after ?? 0);
      if (attempt === 0 && wait > 0 && wait < 60) { await new Promise((r) => setTimeout(r, (wait + 0.5) * 1000)); continue; }
      if (guild.members.cache.size > 1) return guild.members.cache;
      throw e;
    }
  }
}

/** Запомнить ник человека на сервере (для «Исполнитель: Gora (@Gora)» и т.п.) */
export function rememberName(member) {
  const id = member?.id ?? member?.user?.id;
  const name = member?.displayName ?? member?.user?.globalName ?? member?.user?.username;
  if (!id || !name || member?.user?.bot) return;
  db.prepare('INSERT INTO names(user_id,name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name WHERE name!=excluded.name').run(id, name);
}
/** Ник человека: из базы прокуроров, иначе из справочника ников; null — бот этого человека ещё не видел */
export const displayNameOf = (id) => (id ? db.prepare('SELECT name FROM prosecutors WHERE user_id=?').get(id)?.name
  ?? db.prepare('SELECT name FROM names WHERE user_id=?').get(id)?.name ?? null : null);
/** «Gora💢 (@Gora💢)» — ник и тег; если ник неизвестен — только тег */
export const nameAndTag = (id) => (!id ? '—' : displayNameOf(id) ? `${safeText(displayNameOf(id))} (<@${id}>)` : `<@${id}>`);

/** ЛС с учётом журнала (для /clear_all_dm). Возвращает отправленное сообщение или false. */
export async function sendDM(client, userId, payload) {
  let user = null;
  try {
    user = await client.users.fetch(userId);
    const m = await user.send(payload);
    db.prepare('INSERT INTO dm_log(channel_id,message_id) VALUES(?,?)').run(m.channelId, m.id);
    return m;
  } catch (e) {
    // 50007 — нельзя написать: закрыты ЛС от участников сервера или бот заблокирован
    if (e?.code === 50007) await reportDmBlocked(client, userId, user, payload).catch(() => {});
    return false;
  }
}

/** Панель «Закрытые ЛС»: кому бот не смог написать и что именно не дошло. Об одном человеке — не чаще раза в 3 часа. */
const lastBlocked = new Map();
async function reportDmBlocked(client, userId, user, payload) {
  if (Date.now() - (lastBlocked.get(userId) ?? 0) < 3 * 3600_000) return;
  lastBlocked.set(userId, Date.now());
  const e0 = payload?.embeds?.[0];
  const what = (e0?.toJSON?.().title ?? e0?.title ?? String(payload?.content ?? '').split('\n')[0]) || 'сообщение бота';
  const card = new EmbedBuilder().setColor(C.warn).setTitle('🔕 Не удалось написать в ЛС')
    .setDescription(`**Пользователь:** <@${userId}>${user ? ` (${escapeMarkdown(user.username)})` : ''}\n` +
      `**Не доставлено:** ${escapeMarkdown(what).slice(0, 200)}\n\n` +
      'У пользователя закрыты личные сообщения от участников сервера или он заблокировал бота.')
    .setFooter({ text: stamp() });
  const { destinations, sendAll } = await import('./mirror.js');
  await sendAll(client, destinations('dm_blocked'), { embeds: [card], __noLogo: true });
}

/**
 * Общая обработка текстовых ответов: как в оригинале — обычным текстом. При правке сообщения со старой карточкой
 * текстом — карточку убираем, иначе текст окажется над ней. Ответы со своими embed или файлами не трогаются.
 */
export function prettyPayload(p, edit = false) {
  if (typeof p === 'string') p = { content: p };
  if (p?.plain) { const { plain, ...rest } = p; p = rest; } // eslint-disable-line no-unused-vars -- старый флаг «только текст»
  if (!p?.content || p.embeds?.length || p.files?.length || p.poll) return p;
  return edit ? { ...p, embeds: [] } : p;
}

/** Список строк в одну карточку (лимит Discord ~4000 символов): что не влезло — «…и ещё N» */
export function fitLines(lines, max = 3900) {
  const out = [];
  let size = 0;
  for (const [k, l] of lines.entries()) {
    if (size + l.length + 1 > max) { out.push(`…и ещё ${lines.length - k}`); break; }
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}
