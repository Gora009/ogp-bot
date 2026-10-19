import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, GatewayIntentBits, MessageFlags, ModalBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db } from './db.js';
import {
  C, COLOR, EPH, fetchMembers, isProsecutor, mskDate, nowTs, parseDate, safeText, sendDM, stamp,
} from './util.js';
import { can, isLeader, roleIdsWith } from './access.js';
import { destinations, editAll, mirrorsOf, pingIn, sendAll } from './mirror.js';
import { conf } from './config.js';

export const VAC_STATUS = { pending: '⏳ На рассмотрении', approved: '✅ Одобрен', rejected: '❌ Отклонён', cancelled: '🚫 Отменён' };
const range = (v) => `${mskDate(v.start_ts)} — ${mskDate(v.end_ts)}`;
const getVac = (id) => db.prepare('SELECT * FROM vacations WHERE id=?').get(id);

/* ---------- панель «Отпуска и увольнения» ---------- */
export const vacationsPanelPayload = () => ({
  embeds: [new EmbedBuilder().setColor(C.info).setTitle('🏖️ Отпуска и увольнения').setDescription(
    '**Отпуск:**\nНажмите кнопку для подачи заявки на отпуск.\n\n' +
    '**Увольнение:**\nНажмите кнопку для подачи заявления на увольнение.\n\n' +
    '**Важно:**\n• Заявки должны быть одобрены СГП, ЗГП или ГП\n• Роль «Отпуск» выдаётся автоматически в день начала\n' +
    '• Во время отпуска вам не будут назначаться жалобы').setFooter({ text: stamp() })],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vac:new').setLabel('Подать заявку на отпуск').setEmoji('🏖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vac:mine').setLabel('Мои отпуска').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('res:new').setLabel('Заявление на увольнение').setEmoji('📄').setStyle(ButtonStyle.Danger))],
});

const requestEmbed = (v) =>
  new EmbedBuilder().setColor(COLOR).setTitle('🏖️ Заявка на отпуск')
    .setDescription(`**Сотрудник:** <@${v.user_id}>\n**Период:** ${range(v)}\n**Причина:** ${safeText(v.reason || '—')}`)
    .setFooter({ text: stamp(v.created_ts) });

const decidedEmbed = (v) => {
  if (v.status === 'cancelled') {
    const who = v.cancelled_by ? (v.cancelled_by === v.user_id ? 'сам сотрудник' : `<@${v.cancelled_by}>`) : 'руководство';
    return new EmbedBuilder().setColor(C.muted).setTitle('🚫 Отпуск отменён')
      .setDescription(`**Сотрудник:** <@${v.user_id}>\n**Период:** ${range(v)}\n\n**Отменил:** ${who}`)
      .setFooter({ text: stamp(v.cancelled_ts ?? nowTs()) });
  }
  const ok = v.status === 'approved';
  return new EmbedBuilder().setColor(ok ? C.success : C.danger)
    .setTitle(ok ? '✅ Заявка одобрена' : '❌ Заявка отклонена')
    .setDescription(
      `**Сотрудник:** <@${v.user_id}>\n**Период:** ${range(v)}\n\n` +
      `**${ok ? 'Одобрил' : 'Отклонил'}:** <@${v.decided_by}>` +
      (ok ? '' : `\n**Причина:** ${safeText(v.reject_reason)}`))
    .setFooter({ text: stamp(v.decided_ts) });
};

/* ---------- подача заявки ---------- */
const input = (id, label, placeholder, style, required, value, max = 1000) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
    .setStyle(style).setRequired(required).setMaxLength(max);
  if (value) t.setValue(value);
  return new ActionRowBuilder().addComponents(t);
};

export const vacationModal = () =>
  new ModalBuilder().setCustomId('vac:subm').setTitle('Заявка на отпуск').addComponents(
    input('start', 'Дата начала (ДД.ММ.ГГГГ)', '01.01.2025', TextInputStyle.Short, true),
    input('end', 'Дата окончания (ДД.ММ.ГГГГ)', '07.01.2025', TextInputStyle.Short, true),
    input('reason', 'Причина (необязательно)', 'Личные обстоятельства', TextInputStyle.Paragraph, false, undefined, 500));

/** /vacation — открывает ту же форму, что и кнопка на панели */
export const vacation = (client, i) => i.showModal(vacationModal());

async function submitVacation(client, i) {
  if (!isProsecutor(i.user.id)) return i.reply({ content: 'Вы не зарегистрированы как прокурор.', ...EPH });
  const s = parseDate(i.fields.getTextInputValue('start'));
  const e = parseDate(i.fields.getTextInputValue('end'));
  if (s == null || e == null) return i.reply({ content: 'Даты указываются в формате ДД.ММ.ГГГГ.', ...EPH });
  const endTs = e + 86400 - 1; // конец дня включительно
  if (endTs < nowTs()) return i.reply({ content: 'Отпуск не может закончиться в прошлом.', ...EPH });
  if (endTs < s) return i.reply({ content: 'Дата окончания раньше даты начала.', ...EPH });
  const overlap = db.prepare(`SELECT 1 FROM vacations WHERE user_id=? AND status IN ('pending','approved')
                              AND start_ts<=? AND end_ts>=?`).get(i.user.id, endTs, s);
  if (overlap) return i.reply({ content: 'У вас уже есть заявка или отпуск на этот период.', ...EPH });
  const chIds = destinations('requests', 'vacations');
  if (!chIds.length) return i.reply({ content: 'Панель отпусков не настроена: /setup panel:Отпуска и увольнения.', ...EPH });

  // без ответа «Заявка отправлена»: форма просто закрывается, заявка появляется в канале
  await (i.isFromMessage() ? i.deferUpdate() : i.deferReply(EPH));
  const reason = i.fields.getTextInputValue('reason').trim() || null;
  const r = db.prepare('INSERT INTO vacations(user_id,start_ts,end_ts,reason,created_ts) VALUES(?,?,?,?,?)')
    .run(i.user.id, s, endTs, reason, nowTs());
  const v = getVac(Number(r.lastInsertRowid));
  const sent = await sendAll(client, chIds, (ch) => ({
    content: pingIn(ch, roleIdsWith('approve')) || undefined,
    embeds: [requestEmbed(v)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vac:ok:${v.id}`).setLabel('Одобрить').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vac:no:${v.id}`).setLabel('Отклонить').setEmoji('❌').setStyle(ButtonStyle.Danger))],
  }), { kind: 'vac', ref: v.id });
  if (sent[0]) db.prepare('UPDATE vacations SET channel_id=?, message_id=? WHERE id=?').run(sent[0].channelId, sent[0].id, v.id);
  if (!i.isFromMessage()) await i.deleteReply().catch(() => {}); // /vacation: убираем «бот думает…»
}

/**
 * «Мои отпуска»: каждый действующий отпуск — строкой, под ним кнопка «Отменить отпуск»; ниже — история.
 * После отмены окно обновляется на месте.
 */
function myView(userId, note = '') {
  const rows = db.prepare('SELECT * FROM vacations WHERE user_id=? ORDER BY start_ts DESC LIMIT 25').all(userId);
  const isOpen = (v) => ['pending', 'approved'].includes(v.status) && v.end_ts >= nowTs();
  const open = rows.filter(isOpen).slice(0, 10);
  const past = rows.filter((v) => !open.includes(v)).slice(0, 15);
  const line = (v) => `${range(v)} — ${VAC_STATUS[v.status]}${v.reject_reason ? ` (${safeText(v.reject_reason)})` : ''}`;
  const c = new ContainerBuilder().setAccentColor(COLOR).addTextDisplayComponents(text('## 📋 Мои отпуска'));
  if (!rows.length) c.addTextDisplayComponents(text('У вас пока нет заявок на отпуск.'));
  for (const v of open) {
    c.addTextDisplayComponents(text(`**${line(v)}**`));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vac:mcx:${v.id}`)
      .setLabel('Отменить отпуск').setEmoji('🚫').setStyle(ButtonStyle.Danger)));
  }
  if (past.length) c.addTextDisplayComponents(text(`**История**\n${past.map((v) => `• ${line(v)}`).join('\n')}`));
  if (note) c.addTextDisplayComponents(text(`-# ${note}`));
  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}
const text = (t) => new TextDisplayBuilder().setContent(t);
const myVacations = (i) => i.reply({ ...myView(i.user.id), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

/** Кнопка «Отменить отпуск» под одобренной заявкой (видна в канале заявок) */
const cancelRow = (v) => [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`vac:cx:${v.id}`).setLabel('Отменить отпуск').setEmoji('🚫').setStyle(ButtonStyle.Secondary))];

/**
 * Сообщение заявки в канале. Для заявок, поданных до того, как бот стал его запоминать, —
 * ищем среди последних сообщений канала заявок по сотруднику и датам.
 */
async function findCard(client, v) {
  try {
    if (v.channel_id && v.message_id) return await (await client.channels.fetch(v.channel_id)).messages.fetch(v.message_id);
    const chId = destinations('requests', 'vacations')[0];
    if (!chId) return null;
    const msgs = await (await client.channels.fetch(chId)).messages.fetch({ limit: 100 });
    const m = msgs.find((x) => x.author.id === client.user.id && x.embeds[0]?.description?.includes(`<@${v.user_id}>`)
      && x.embeds[0].description.includes(range(v)));
    if (m) db.prepare('UPDATE vacations SET channel_id=?, message_id=? WHERE id=?').run(m.channelId, m.id, v.id);
    return m ?? null;
  } catch {
    return null;
  }
}

/** Обновить карточку заявки на всех серверах (старые заявки — одна копия, ищем её в канале) */
async function updateCards(client, v, payload, exceptMessageId = null) {
  if (mirrorsOf('vac', v.id).length) return editAll(client, 'vac', v.id, payload, exceptMessageId);
  const card = await findCard(client, v);
  if (card && card.id !== exceptMessageId) await card.edit(payload).catch(() => {});
}

/** Отменяет отпуск: карточка заявки обновляется, роль «Отпуск» снимается; если отменил не сам сотрудник — ему ЛС */
async function cancelVac(client, v, byId) {
  db.prepare(`UPDATE vacations SET status='cancelled', cancelled_by=?, cancelled_ts=? WHERE id=?`).run(byId, nowTs(), v.id);
  const f = getVac(v.id);
  await updateCards(client, f, { embeds: [decidedEmbed(f)], components: [] });
  if (byId !== v.user_id) await sendDM(client, v.user_id, { content: `Ваш отпуск ${range(v)} отменён руководством.` });
  syncVacationRole(client).catch(() => {});
  return f;
}

/* ---------- роутер кнопок и форм ---------- */
export async function handleVac(client, i) {
  const [, action, id] = i.customId.split(':');
  if (action === 'new') return i.showModal(vacationModal());
  if (action === 'subm') return submitVacation(client, i);
  if (action === 'mine') return myVacations(i);
  // cx — кнопка на карточке заявки, mcx — кнопка в «Моих отпусках»
  if (action === 'cx' || action === 'mcx') {
    const v = getVac(Number(id ?? i.values?.[0]));
    if (!v || !['pending', 'approved'].includes(v.status)) {
      return action === 'cx' ? i.update({ components: [] }) : i.update(myView(i.user.id, 'Этот отпуск уже не действует.'));
    }
    // отменить может только тот, кто взял отпуск, и руководство
    if (v.user_id !== i.user.id && !isLeader(i)) return i.reply({ content: '⛔ Нет прав: отменить отпуск может только сам сотрудник или руководство.', ...EPH });
    await i.deferUpdate();
    const f = await cancelVac(client, v, i.user.id);
    if (action === 'mcx') return i.editReply(myView(i.user.id, `Отпуск ${range(f)} отменён.`));
    return i.editReply({ embeds: [decidedEmbed(f)], components: [] });
  }

  if (!isLeader(i)) return i.reply({ content: '⛔ Решение принимает руководство.', ...EPH });
  const v = getVac(Number(id));
  if (!v || v.status !== 'pending') return i.update({ components: [] });
  // свою заявку одобряет или отклоняет другой руководитель (кроме ГП — над ним никого нет)
  if (v.user_id === i.user.id && !can(i, 'full')) return i.reply({ content: '⛔ Свою заявку нельзя рассмотреть самому.', ...EPH });

  if (action === 'ok') {
    db.prepare(`UPDATE vacations SET status='approved', decided_by=?, decided_ts=?, channel_id=?, message_id=? WHERE id=?`)
      .run(i.user.id, nowTs(), i.message.channelId, i.message.id, v.id);
    const done = { embeds: [decidedEmbed(getVac(v.id))], components: cancelRow(v) };
    await i.update(done);
    await updateCards(client, getVac(v.id), done, i.message.id);
    await sendDM(client, v.user_id, { content: `Ваш отпуск ${range(v)} одобрен ✅` });
    syncVacationRole(client).catch(() => {});
    return;
  }
  if (action === 'no') {
    return i.showModal(new ModalBuilder().setCustomId(`vac:nm:${v.id}`).setTitle('Причина отказа').addComponents(
      input('reason', 'Причина отказа', 'Укажите причину отказа...', TextInputStyle.Paragraph, true)));
  }
  if (action === 'nm') {
    const reason = i.fields.getTextInputValue('reason').trim();
    db.prepare(`UPDATE vacations SET status='rejected', decided_by=?, decided_ts=?, reject_reason=? WHERE id=?`)
      .run(i.user.id, nowTs(), reason, v.id);
    const payload = { embeds: [decidedEmbed(getVac(v.id))], components: [] };
    await (i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...EPH }));
    await updateCards(client, getVac(v.id), payload, i.message?.id);
    await sendDM(client, v.user_id, { content: `Ваша заявка на отпуск ${range(v)} отклонена ❌\nПричина: ${reason}` });
    return;
  }
}

/* ---------- /vacations, /cancel_vacation ---------- */
export async function vacations(client, i) {
  const n = nowTs();
  const rows = db.prepare(`SELECT * FROM vacations WHERE status='approved' AND end_ts>=? ORDER BY start_ts LIMIT 25`).all(n);
  // ID — номер заявки на отпуск (тот же номер — в «Истории отпусков» кабинета)
  const text = rows.map((r) => `${r.start_ts <= n ? '🏖️' : '✅'} **ID: ${r.id}** — <@${r.user_id}>\n└ ${range(r)}`).join('\n');
  return i.reply({
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🏖️ Отпуска')
      .setDescription(text || 'Активных отпусков нет.').setFooter({ text: stamp() })],
    ...EPH,
  });
}

export async function cancelVacation(client, i) {
  const u = i.options.getUser('user');
  const list = db.prepare(`SELECT * FROM vacations WHERE user_id=? AND status IN ('approved','pending') AND end_ts>=?`).all(u.id, nowTs());
  if (!list.length) return i.reply({ content: 'У сотрудника нет активных отпусков.', ...EPH });
  await i.deferReply(EPH);
  for (const v of list) await cancelVac(client, v, i.user.id);
  return i.editReply(`Отпуск сотрудника <@${u.id}> отменён (записей: ${list.length}).`);
}

/* ---------- роль «Отпуск»: выдаётся в день начала, снимается по окончании ---------- */
let membersLoaded = false;
export async function syncVacationRole(client) {
  const roleId = conf.vacationRoleId(); // /settings или .env
  // без Server Members Intent список участников не получить (запрос завис бы на ~2 минуты)
  if (!roleId || !client.options.intents.has(GatewayIntentBits.GuildMembers)) return;
  const guild = client.guilds.cache.find((g) => g.roles.cache.has(roleId)); // сервер, где живёт роль «Отпуск»
  const role = guild?.roles.cache.get(roleId);
  if (!role) return;
  if (!membersLoaded) { await fetchMembers(guild); membersLoaded = true; }
  const n = nowTs();
  const active = new Set(db.prepare(`SELECT DISTINCT user_id FROM vacations WHERE status='approved' AND start_ts<=? AND end_ts>=?`)
    .all(n, n).map((r) => r.user_id));
  for (const uid of active) {
    const m = guild.members.cache.get(uid);
    if (m && !m.roles.cache.has(roleId)) await m.roles.add(roleId, 'Начался отпуск').catch(() => {});
  }
  // снимаем только у тех, кто вообще подавал отпуск через бота
  const known = new Set(db.prepare('SELECT DISTINCT user_id FROM vacations').all().map((r) => r.user_id));
  for (const m of role.members.values()) {
    if (known.has(m.id) && !active.has(m.id)) await m.roles.remove(roleId, 'Отпуск закончился').catch(() => {});
  }
}

/** При запуске: карточки недавно отменённых отпусков, которые не обновились (заявки до этого обновления бота) */
export async function fixCancelledCards(client) {
  const rows = db.prepare(`SELECT * FROM vacations WHERE status='cancelled' AND message_id IS NULL AND cancelled_ts>?`)
    .all(nowTs() - 14 * 86400);
  for (const v of rows) {
    await updateCards(client, getVac(v.id), { embeds: [decidedEmbed(getVac(v.id))], components: [] });
  }
}
