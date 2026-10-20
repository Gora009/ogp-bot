import { getSetting, setSetting } from './db.js';
import { conf } from './config.js';

/**
 * Бот работает только на «своих» серверах: на сервере ОГП и на сервере Прокуратуры (из /settings).
 * Если его добавят куда-то ещё, он сразу выходит оттуда и ничего там не делает — иначе владелец чужого
 * сервера получил бы в боте полный доступ к общей базе (жалобы, права, рассылка прокурорам).
 *
 * Список задаётся один раз при первом запуске этой версии: туда попадают серверы, где бот уже стоит.
 */
const KEY = 'allowed_guilds';
const stored = () => (getSetting(KEY) ?? '').split(',').filter(Boolean);

export const allowedGuilds = () => new Set([...stored(), conf.prosecutionGuildId()].filter(Boolean));
export const isAllowedGuild = (id) => allowedGuilds().has(id);

/** Первый запуск: разрешаем серверы, где бот уже есть (сейчас это сервер ОГП) */
export function initAllowedGuilds(client) {
  if (!stored().length && client.guilds.cache.size) setSetting(KEY, [...client.guilds.cache.keys()].join(','));
}

/** Выйти с сервера, которого нет в списке */
export async function leaveIfForeign(guild) {
  // чистая установка (бот ещё ни на одном сервере): первый сервер, куда его добавили, становится своим
  if (!stored().length) { setSetting(KEY, guild.id); return false; }
  if (isAllowedGuild(guild.id)) return false;
  console.warn(`⚠️ Бота добавили на посторонний сервер «${guild.name}» (${guild.id}, владелец ${guild.ownerId}) — выхожу.`);
  await guild.leave().catch((e) => console.error('Не удалось выйти с сервера:', e.message));
  return true;
}

/** Разрешённые вручную (без сервера Прокуратуры из настроек) */
export const storedGuilds = () => stored();
export const allowGuild = (id) => setSetting(KEY, [...new Set([...stored(), id])].join(','));
export const disallowGuild = (id) => setSetting(KEY, stored().filter((x) => x !== id).join(','));
