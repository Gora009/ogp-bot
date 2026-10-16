import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { db } from './db.js';
import { destinations, editAll, mirrorByMessage, mirrorsOf, sendAll } from './mirror.js';
import { C, msk, nowTs, stamp } from './util.js';

/**
 * Канал «Просроченные дедлайны» (/setup): карточка на каждую просрочку с упоминанием ответственных за дедлайны
 * и кнопками «Продлить» / «Закрыть жалобу».
 * Когда жалобу закрыли или дедлайн продлили, карточка обновляется, а кнопки с неё убираются.
 */
db.exec(`CREATE TABLE IF NOT EXISTS overdue_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, kind TEXT NOT NULL,
  channel_id TEXT NOT NULL, message_id TEXT NOT NULL, resolved TEXT, created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alerts_thread ON overdue_alerts(thread_id);
CREATE INDEX IF NOT EXISTS idx_alerts_message ON overdue_alerts(message_id);`);

const KIND = { respond: 'Ответ', close: 'Закрытие' };
export const alertsChannelId = () => destinations('overdue')[0] ?? null;
export const isAlertMessage = (messageId) => mirrorByMessage(messageId)?.kind === 'alert'
  || !!db.prepare('SELECT 1 FROM overdue_alerts WHERE message_id=?').get(messageId);

const nameOf = (id) => db.prepare('SELECT name FROM prosecutors WHERE user_id=?').get(id)?.name;

function alertEmbed(c, kind, resolved = null) {
  const lines = [
    `**Жалоба:** №${c.number ?? '?'}`,
    // «ПСК | Riley Zakonov (@…)»; имени в базе нет — только упоминание, без пустых скобок
    `**Исполнитель:** ${!c.assignee_id ? '—' : nameOf(c.assignee_id) ? `${nameOf(c.assignee_id)} (<@${c.assignee_id}>)` : `<@${c.assignee_id}>`}`,
    `**Тип:** ${KIND[kind]}`,
    `**Ссылка:** [Форум](${c.url})`,
  ];
  if (resolved) lines.push('', resolved);
  return new EmbedBuilder().setColor(resolved ? (resolved.startsWith('✅') ? C.success : C.warn) : C.danger)
    .setTitle('⚠️ Просрочен дедлайн').setDescription(lines.join('\n')).setFooter({ text: stamp() });
}

const alertButtons = (c, kind) => [
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`c:${kind === 'respond' ? 'xr' : 'xc'}:${c.thread_id}`)
    .setLabel(kind === 'respond' ? 'Продлить дедлайн ответа' : 'Продлить дедлайн закрытия').setEmoji('⏰').setStyle(ButtonStyle.Secondary)),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`c:cl:${c.thread_id}`)
    .setLabel('Закрыть жалобу').setEmoji('✅').setStyle(ButtonStyle.Success)),
];

/** Кого упомянуть — только ответственных за дедлайны (люди, без ролей), как в оригинале.
 *  Список — /settings → Жалобы или /deadline_responsible. */
export function alertPing(ch = null) {
  return db.prepare('SELECT user_id FROM deadline_responsible').all().map((r) => `<@${r.user_id}>`).join(' ');
}

/** Публикует карточку просрочки. false — канал не настроен (тогда уведомляем по-старому, в ЛС). */
export async function postAlert(client, c, kind) {
  const chIds = destinations('overdue');
  if (!chIds.length) return false;
  const r = db.prepare('INSERT INTO overdue_alerts(thread_id,kind,channel_id,message_id,created_ts) VALUES(?,?,?,?,?)')
    .run(c.thread_id, kind, '', '', nowTs());
  const id = Number(r.lastInsertRowid);
  const sent = await sendAll(client, chIds, (ch) => ({
    content: alertPing(ch) || undefined, embeds: [alertEmbed(c, kind)], components: alertButtons(c, kind),
  }), { kind: 'alert', ref: id });
  if (!sent.length) { db.prepare('DELETE FROM overdue_alerts WHERE id=?').run(id); return false; }
  db.prepare('UPDATE overdue_alerts SET channel_id=?, message_id=? WHERE id=?').run(sent[0].channelId, sent[0].id, id);
  return true;
}

/**
 * Отмечает карточки просрочек по жалобе как решённые: убирает кнопки и дописывает, что произошло.
 * kind — только этого типа (продление), без него — все (жалоба закрыта).
 */
export async function resolveAlerts(client, c, text, kind = null, card = null) {
  const rows = db.prepare(`SELECT * FROM overdue_alerts WHERE thread_id=? AND resolved IS NULL${kind ? ' AND kind=?' : ''}`)
    .all(...(kind ? [c.thread_id, kind] : [c.thread_id]));
  for (const r of rows) {
    db.prepare('UPDATE overdue_alerts SET resolved=? WHERE id=?').run(text, r.id);
    // card — карточка закрытой жалобы («🟢 Жалоба №… — Удовлетворена»): ею заменяем карточку просрочки
    const payload = { embeds: [card ?? alertEmbed(c, r.kind, text)], components: [] };
    if (mirrorsOf('alert', r.id).length) { await editAll(client, 'alert', r.id, payload); continue; }
    try {
      const msg = await (await client.channels.fetch(r.channel_id)).messages.fetch(r.message_id);
      await msg.edit(payload);
    } catch { /* сообщение удалили — ничего страшного */ }
  }
}

export const extendedText = (userId, h, until) => `⏰ Продлено на ${h} ч — <@${userId}>, новый срок: ${msk(until)}`;
export const closedText = (userId) => (userId ? `✅ Жалоба закрыта — <@${userId}>` : '✅ Жалоба закрыта на форуме');
