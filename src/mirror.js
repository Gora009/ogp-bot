import { db } from './db.js';

/**
 * Синхронизация карточек между серверами. Каждая панель может стоять на нескольких серверах бота
 * (по одному каналу на сервер — у каждого сервера свои каналы). Карточка (жалоба, дело, заявка…)
 * отправляется во все каналы своей панели, а копии запоминаются здесь: при любом изменении
 * бот правит все копии одинаково. Упоминания ролей — только тех, что есть на сервере канала.
 */
try { db.exec('ALTER TABLE panels ADD COLUMN guild_id TEXT'); } catch { /* уже есть */ }
db.exec(`CREATE TABLE IF NOT EXISTS mirrors (
  kind TEXT NOT NULL, ref TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY (kind, ref, channel_id))`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mirrors_message ON mirrors(message_id)');

const rowsOf = (type) => db.prepare('SELECT * FROM panels WHERE type=? ORDER BY id').all(type);

/**
 * Каналы панели type на всех серверах. fallback — панель, в канал которой идут карточки,
 * если на этом сервере отдельный канал не выбран (например, заявки → канал панели «Отпуска»).
 */
export function destinations(type, fallback = null) {
  const byGuild = new Map();
  const key = (r) => r.guild_id ?? `ch:${r.channel_id}`;
  if (fallback) for (const r of rowsOf(fallback)) byGuild.set(key(r), r.channel_id);
  for (const r of rowsOf(type)) byGuild.set(key(r), r.channel_id);
  return [...new Set(byGuild.values())];
}

const payloadOf = (p, ch) => (typeof p === 'function' ? p(ch) : p);

/** Отправить во все каналы; kind/ref — запомнить копии для последующих правок. Возвращает отправленные сообщения. */
export async function sendAll(client, channelIds, payload, { kind, ref } = {}) {
  const sent = await Promise.all(channelIds.map(async (id) => {
    try {
      const ch = await client.channels.fetch(id);
      const msg = await ch.send(payloadOf(payload, ch));
      if (kind) {
        db.prepare('INSERT OR REPLACE INTO mirrors(kind,ref,channel_id,message_id) VALUES(?,?,?,?)').run(kind, String(ref), ch.id, msg.id);
      }
      return msg;
    } catch (e) {
      console.error(`Не удалось отправить в канал ${id}: ${e.message}`);
      return null;
    }
  }));
  return sent.filter(Boolean); // в порядке каналов: первый — основной
}

/** Копии карточки */
export const mirrorsOf = (kind, ref) => db.prepare('SELECT * FROM mirrors WHERE kind=? AND ref=?').all(kind, String(ref));
/** Чья это копия: { kind, ref } или null */
export const mirrorByMessage = (messageId) => db.prepare('SELECT * FROM mirrors WHERE message_id=?').get(messageId) ?? null;

/** Поправить все копии (кроме сообщения, которое уже обновлено нажатием кнопки) */
export async function editAll(client, kind, ref, payload, exceptMessageId = null) {
  await Promise.all(mirrorsOf(kind, ref).filter((m) => m.message_id !== exceptMessageId).map(async (m) => {
    try {
      const ch = await client.channels.fetch(m.channel_id);
      await ch.messages.edit(m.message_id, payloadOf(payload, ch));
    } catch (e) {
      // сообщение или канал удалены — забываем эту копию; остальное (нет доступа к каналу и т.п.) — в журнал
      if ([10003, 10008].includes(e.code)) db.prepare('DELETE FROM mirrors WHERE kind=? AND ref=? AND channel_id=?').run(kind, String(ref), m.channel_id);
      else console.error(`Не удалось обновить сообщение в канале ${m.channel_id} (${kind} ${ref}): ${e.message}`);
    }
  }));
}

/** Удалить все копии карточки */
export async function deleteAll(client, kind, ref) {
  await Promise.all(mirrorsOf(kind, ref).map(async (m) => {
    try { await (await client.channels.fetch(m.channel_id)).messages.delete(m.message_id); } catch { /* уже нет */ }
  }));
  db.prepare('DELETE FROM mirrors WHERE kind=? AND ref=?').run(kind, String(ref));
}

/** Упоминания ролей — только тех, что есть на сервере канала (на другом сервере свои роли) */
export const pingIn = (ch, roleIds) => roleIds.filter((id) => ch?.guild?.roles?.cache?.has(id)).map((id) => `<@&${id}>`).join(' ');

/** Ссылка на карточку (сообщение бота) — копию на сервере guildId, иначе любую; null — карточки нет */
export function messageUrl(client, kind, ref, guildId = null) {
  const rows = mirrorsOf(kind, ref);
  const chOf = (r) => client?.channels?.cache?.get(r.channel_id);
  const pick = rows.find((r) => chOf(r)?.guildId === guildId) ?? rows.find(chOf);
  const ch = pick && chOf(pick);
  return ch ? `https://discord.com/channels/${ch.guildId}/${pick.channel_id}/${pick.message_id}` : null;
}
