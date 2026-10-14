import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db } from './db.js';
import { isLeader, roleIdsWith } from './access.js';
import { destinations, editAll, pingIn, sendAll } from './mirror.js';
import { C, EPH, isProsecutor, nowTs, sendDM, stamp } from './util.js';

const getRes = (id) => db.prepare('SELECT * FROM resignations WHERE id=?').get(id);

const reasonModal = (customId, title, label, placeholder) =>
  new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel(label).setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));

const requestEmbed = (r) =>
  new EmbedBuilder().setColor(C.brand).setTitle('📄 Заявление на увольнение')
    .setDescription(`**Сотрудник:** <@${r.user_id}>\n**Причина:** ${r.reason}`)
    .setFooter({ text: stamp(r.created_ts) });

/** Как в оригинале: одобрено — причина увольнения; отклонено — только причина отказа */
const decidedEmbed = (r) => {
  const ok = r.status === 'approved';
  return new EmbedBuilder().setColor(ok ? C.success : C.danger)
    .setTitle(ok ? '✅ Заявление одобрено' : '❌ Заявление отклонено')
    .setDescription(ok
      ? `**Сотрудник:** <@${r.user_id}>\n**Причина:** ${r.reason}\n\n**Одобрил:** <@${r.decided_by}>`
      : `**Сотрудник:** <@${r.user_id}>\n\n**Отклонил:** <@${r.decided_by}>\n**Причина:** ${r.reject_reason}`)
    .setFooter({ text: stamp(r.decided_ts) });
};

async function submit(client, i) {
  if (!isProsecutor(i.user.id)) return i.reply({ content: 'Вы не зарегистрированы как прокурор.', ...EPH });
  if (db.prepare(`SELECT 1 FROM resignations WHERE user_id=? AND status='pending'`).get(i.user.id)) {
    return i.reply({ content: 'Ваше заявление уже на рассмотрении.', ...EPH });
  }
  const chIds = destinations('requests', 'vacations');
  if (!chIds.length) return i.reply({ content: 'Панель увольнений не настроена: /setup panel:Отпуска и увольнения.', ...EPH });
  // без ответа «Заявление отправлено»: форма просто закрывается, заявление появляется в канале
  await (i.isFromMessage() ? i.deferUpdate() : i.deferReply(EPH));
  const r = db.prepare('INSERT INTO resignations(user_id,reason,created_ts) VALUES(?,?,?)')
    .run(i.user.id, i.fields.getTextInputValue('reason').trim(), nowTs());
  const row = getRes(Number(r.lastInsertRowid));
  await sendAll(client, chIds, (ch) => ({
    content: pingIn(ch, roleIdsWith('approve')) || undefined,
    embeds: [requestEmbed(row)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`res:ok:${row.id}`).setLabel('Одобрить').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`res:no:${row.id}`).setLabel('Отклонить').setEmoji('❌').setStyle(ButtonStyle.Danger))],
  }), { kind: 'res', ref: row.id });
  if (!i.isFromMessage()) await i.deleteReply().catch(() => {});
}

export async function handleResign(client, i) {
  const [, action, id] = i.customId.split(':');
  if (action === 'new') {
    return i.showModal(reasonModal('res:subm', 'Заявление на увольнение', 'Причина увольнения', 'Укажите причину увольнения...'));
  }
  if (action === 'subm') return submit(client, i);

  if (!isLeader(i)) return i.reply({ content: '⛔ Решение принимает руководство.', ...EPH });
  const r = getRes(Number(id));
  if (!r || r.status !== 'pending') return i.update({ components: [] });

  if (action === 'ok') {
    db.prepare(`UPDATE resignations SET status='approved', decided_by=?, decided_ts=? WHERE id=?`).run(i.user.id, nowTs(), r.id);
    // уволенный больше не попадает в списки назначения; открытые отпуска закрываем
    db.prepare('DELETE FROM prosecutors WHERE user_id=?').run(r.user_id);
    db.prepare(`UPDATE vacations SET status='cancelled' WHERE user_id=? AND status IN ('approved','pending')`).run(r.user_id);
    const done = { embeds: [decidedEmbed(getRes(r.id))], components: [] };
    await i.update(done);
    await editAll(client, 'res', r.id, done, i.message.id);
    await sendDM(client, r.user_id, { content: 'Ваше заявление на увольнение одобрено ✅' });
    return;
  }
  if (action === 'no') {
    return i.showModal(reasonModal(`res:nm:${r.id}`, 'Причина отказа', 'Причина отказа', 'Укажите причину отказа...'));
  }
  if (action === 'nm') {
    const reason = i.fields.getTextInputValue('reason').trim();
    db.prepare(`UPDATE resignations SET status='rejected', decided_by=?, decided_ts=?, reject_reason=? WHERE id=?`)
      .run(i.user.id, nowTs(), reason, r.id);
    const payload = { embeds: [decidedEmbed(getRes(r.id))], components: [] };
    await (i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...EPH }));
    await editAll(client, 'res', r.id, payload, i.message?.id);
    await sendDM(client, r.user_id, { content: `Ваше заявление на увольнение отклонено ❌\nПричина: ${reason}` });
    return;
  }
}
