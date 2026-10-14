import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { destinations, editAll, mirrorsOf, pingIn, sendAll } from './mirror.js';
import { can, roleIdsWith } from './access.js';
import { C, COLOR, EPH, isOnVacation, msk, mskDate, nowTs, sendDM, stamp } from './util.js';

// старые кураторства «ожидает начала» (до отказа от кнопки «Приступить») — считаем начатыми с момента назначения
db.prepare(`UPDATE mentorships SET status='active', started_ts=COALESCE(started_ts, created_ts) WHERE status='pending'`).run();
const OPEN = ['pending', 'active'];
export const STATUS = {
  pending: '⏳ Ожидает начала', active: '🟢 Идёт', done: '✅ Завершено успешно',
  failed: '❌ Завершено неуспешно', refused: '🚫 Отказ куратора', cancelled: '⚪ Отменено',
};
const STATUS_COLOR = { pending: C.warn, active: C.details, done: C.success, failed: C.danger, refused: C.danger, cancelled: C.muted };

const get = (id) => db.prepare('SELECT * FROM mentorships WHERE id=?').get(id);
/** Каналы карточек кураторства на всех серверах (по умолчанию — канал панели «Кураторство») */
const cardChannels = () => destinations('mentoring_cards', 'mentoring');
const deny = (i, what = 'Эта функция доступна ролям с доступом «Кураторство».') => i.reply({ content: `⛔ ${what}`, ...EPH });
const isMentor = (i, m) => i.user.id === m.mentor_id;
const canManage = (i) => can(i, 'mentoring');
const canAct = (i, m) => isMentor(i, m) || canManage(i);

/* ---------- компоненты окон ---------- */
const labelText = (id, label, { style = TextInputStyle.Short, required = true, value, placeholder, max } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
  if (value) t.setValue(value);
  if (placeholder) t.setPlaceholder(placeholder);
  if (max) t.setMaxLength(max);
  return new LabelBuilder().setLabel(label).setTextInputComponent(t);
};
const labelUser = (id, label, defaultId) => {
  const u = new UserSelectMenuBuilder().setCustomId(id).setPlaceholder('Выберите участника').setMinValues(1).setMaxValues(1);
  if (defaultId) u.setDefaultUsers(defaultId);
  return new LabelBuilder().setLabel(label).setUserSelectMenuComponent(u);
};
const labelSelect = (id, label, options, placeholder) =>
  new LabelBuilder().setLabel(label).setStringSelectMenuComponent(
    new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options));

const addModal = (menteeId) =>
  new ModalBuilder().setCustomId('mnt:addm').setTitle('Добавить куратора').addLabelComponents(
    labelUser('mentor', 'Куратор'),
    labelUser('mentee', 'Курируемый', menteeId),
    labelText('days', 'Срок кураторства (дней)', { value: '3', placeholder: '1–60', max: 2 }),
    labelText('goal', 'Цель / комментарий (необязательно)', { style: TextInputStyle.Paragraph, required: false, max: 500 }));

/* ---------- панель ---------- */
export const mentoringPanelPayload = () => ({
  embeds: [new EmbedBuilder().setColor(C.info).setTitle('🎓 Кураторство')
    .setDescription('Назначение кураторов новым сотрудникам и контроль сроков.')
    // три колонки в ряд растягивают панель на всю ширину
    .addFields(
      { name: '🎓 Назначить', value: 'Выбрать куратора и курируемого', inline: true },
      { name: '📋 Активные', value: 'Кто кого курирует сейчас', inline: true },
      { name: '📖 Инструкция', value: 'Порядок и правила', inline: true },
      {
        name: 'Важно',
        value: '• Кураторство начинается сразу при назначении\n' +
          '• Срок кураторства задаётся при назначении\n' +
          '• Назначать кураторов могут СГП, ЗГП и ГП',
      })
    .setFooter({ text: stamp() })],
  // как на панели «Отпуска и увольнения»: одна главная кнопка, остальные спокойные
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mnt:add').setLabel('Назначить куратора').setEmoji('🎓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mnt:active').setLabel('Активные кураторства').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mnt:mine').setLabel('Мои кураторства').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mnt:instr').setLabel('Инструкция').setEmoji('📖').setStyle(ButtonStyle.Secondary))],
});

/* ---------- карточка ---------- */
function cardEmbed(m, title) {
  const e = new EmbedBuilder().setColor(STATUS_COLOR[m.status]).setTitle(title ?? `🎓 Кураторство ${m.mentee_name}`)
    .setDescription(
      `**Куратор:** <@${m.mentor_id}>\n**Курируемый:** <@${m.mentee_id}>` +
      (m.goal ? `\n**Цель:** ${m.goal}` : ''))
    // три колонки в ряд растягивают карточку на всю ширину, как «Инфо»
    .addFields(
      { name: '⏰ Начало', value: msk(m.started_ts ?? m.created_ts), inline: true },
      { name: '⏰ Конец', value: msk(m.end_by), inline: true },
      { name: 'Статус', value: STATUS[m.status], inline: true })
    .setFooter({ text: stamp(m.finished_ts ?? m.started_ts ?? m.created_ts) });
  if (m.refuse_reason) e.addFields({ name: 'Причина отказа', value: m.refuse_reason });
  if (m.cancel_reason) e.addFields({ name: 'Причина отмены', value: m.cancel_reason });
  if (m.result_comment) e.addFields({ name: 'Отзыв куратора', value: m.result_comment });
  return e;
}

const btn = (m, id, label, emoji, style, disabled = false) =>
  new ButtonBuilder().setCustomId(`mnt:${id}:${m.id}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);

function rows(m) {
  if (!OPEN.includes(m.status)) return [new ActionRowBuilder().addComponents(btn(m, 'inf', 'Инфо', 'ℹ️', ButtonStyle.Secondary))];
  // кураторство идёт сразу после назначения — «Приступить» не нужен; инструкция — на панели и в ЛС куратору
  const first = [
    btn(m, 'no', 'Отказать', '🚫', ButtonStyle.Secondary),
    btn(m, 'inf', 'Инфо', 'ℹ️', ButtonStyle.Secondary),
    btn(m, 'fin', 'Завершить', '🏁', ButtonStyle.Danger),
  ];
  // вторая строка — управление руководством (проверка доступа при нажатии)
  return [
    new ActionRowBuilder().addComponents(...first),
    new ActionRowBuilder().addComponents(
      btn(m, 're', 'Переназначить', '🔄', ButtonStyle.Secondary), btn(m, 'cx', 'Отменить', '🗑️', ButtonStyle.Secondary)),
  ];
}

/** Кнопки управления для «Инфо» и списка активных: продление сроков, переназначение, отмена */
const manageRows = (m) => [
  new ActionRowBuilder().addComponents(
    btn(m, 'exte', 'Продлить срок', '⏰', ButtonStyle.Secondary)),
  new ActionRowBuilder().addComponents(
    btn(m, 're', 'Переназначить', '🔄', ButtonStyle.Secondary), btn(m, 'cx', 'Отменить', '🗑️', ButtonStyle.Secondary)),
];

const payload = (m) => ({ embeds: [cardEmbed(m)], components: rows(m) });

/** При запуске перерисовывает карточки идущих кураторств — после обновления бота они сразу в новом виде */
export async function refreshOpenMentorships(client) {
  for (const m of db.prepare(`SELECT * FROM mentorships WHERE status IN ('pending','active') AND message_id IS NOT NULL`).all()) {
    await refreshCard(client, m);
  }
}

async function refreshCard(client, m, exceptMessageId = null) {
  if (mirrorsOf('mnt', m.id).length) return editAll(client, 'mnt', m.id, payload(m), exceptMessageId);
  if (!m.channel_id || !m.message_id || m.message_id === exceptMessageId) return;
  try {
    const ch = await client.channels.fetch(m.channel_id);
    await (await ch.messages.fetch(m.message_id)).edit(payload(m));
  } catch { /* сообщение удалено */ }
}

const instructionButton = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('mnt:instr').setLabel('Инструкция').setEmoji('📖').setStyle(ButtonStyle.Secondary));

/* ---------- назначение ---------- */
async function submitAdd(client, i) {
  if (!canManage(i)) return deny(i);
  const mentorUser = i.fields.getSelectedUsers('mentor', true).first();
  const menteeUser = i.fields.getSelectedUsers('mentee', true).first();
  const days = Number(i.fields.getTextInputValue('days'));
  const goal = i.fields.getTextInputValue('goal').trim() || null;

  if (mentorUser.bot || menteeUser.bot) return i.reply({ content: 'Боты не могут участвовать в кураторстве.', ...EPH });
  if (mentorUser.id === menteeUser.id) return i.reply({ content: 'Нельзя назначить человека куратором самому себе.', ...EPH });
  if (!Number.isInteger(days) || days < 1 || days > 60) return i.reply({ content: 'Срок — целое число дней от 1 до 60.', ...EPH });
  if (isOnVacation(mentorUser.id)) return i.reply({ content: `<@${mentorUser.id}> сейчас в отпуске — выберите другого куратора.`, ...EPH });
  if (db.prepare(`SELECT 1 FROM mentorships WHERE mentee_id=? AND status IN ('pending','active')`).get(menteeUser.id)) {
    return i.reply({ content: `У <@${menteeUser.id}> уже есть действующий куратор.`, ...EPH });
  }
  if (!cardChannels().length) return i.reply({ content: 'Панель кураторства не настроена: /setup panel:Кураторство.', ...EPH });

  await i.deferReply(EPH);
  const nameOf = async (u) => (await i.guild.members.fetch(u.id).catch(() => null))?.displayName ?? u.username;
  const now = nowTs();
  const r = db.prepare(`INSERT INTO mentorships(mentor_id,mentee_id,created_by,mentor_name,mentor_tag,mentee_name,mentee_tag,
                        goal,created_ts,start_by,end_by,status,started_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?)`)
    .run(mentorUser.id, menteeUser.id, i.user.id, await nameOf(mentorUser), mentorUser.username,
      await nameOf(menteeUser), menteeUser.username, goal, now, now, now + days * 86400, now);
  const m = get(Number(r.lastInsertRowid));

  const sent = await sendAll(client, cardChannels(), payload(m), { kind: 'mnt', ref: m.id }); // куратору уходит ЛС
  if (sent[0]) db.prepare('UPDATE mentorships SET channel_id=?, message_id=? WHERE id=?').run(sent[0].channelId, sent[0].id, m.id);

  // ЛС только куратору — ему нужно приступить; остальное видно на карточке
  await sendDM(client, m.mentor_id, {
    embeds: [cardEmbed(m, '🎓 Вам назначено кураторство')], components: [instructionButton()],
  });
  return i.editReply(`✅ Кураторство №${m.id} назначено: <@${m.mentor_id}> → <@${m.mentee_id}>, срок ${days} дн.`);
}

/* ---------- действия по карточке ---------- */
function infoEmbed(m) {
  const e = new EmbedBuilder().setColor(C.details).setTitle(`ℹ️ Кураторство ${m.mentee_name}`).addFields(
    { name: 'Куратор', value: `<@${m.mentor_id}>`, inline: true },
    { name: 'Курируемый', value: `<@${m.mentee_id}>`, inline: true },
    { name: 'Статус', value: STATUS[m.status], inline: true },
    { name: 'Назначено', value: msk(m.created_ts), inline: true },
    { name: 'Назначил', value: m.created_by ? `<@${m.created_by}>` : '—', inline: true },
    { name: 'Конец', value: msk(m.end_by), inline: true },
    { name: 'Завершено', value: m.finished_ts ? msk(m.finished_ts) : '—', inline: true });
  if (m.goal) e.addFields({ name: 'Цель', value: m.goal });
  if (m.refuse_reason) e.addFields({ name: 'Причина отказа', value: m.refuse_reason });
  if (m.cancel_reason) e.addFields({ name: 'Причина отмены', value: m.cancel_reason });
  if (m.result_comment) e.addFields({ name: 'Отзыв куратора', value: m.result_comment });
  return e.setFooter({ text: `№${m.id} • ${stamp()}` });
}

function refuseModal(i, m) {
  let list = db.prepare(`SELECT * FROM mentorships WHERE mentor_id=? AND status IN ('pending','active') ORDER BY id DESC LIMIT 25`)
    .all(i.user.id);
  if (!list.some((x) => x.id === m.id)) list = [m, ...list].slice(0, 25); // руководство отказывает по этой карточке
  const options = list.map((x) => ({
    label: `${x.mentee_name}`.slice(0, 100), value: String(x.id),
    description: `№${x.id} • ${STATUS[x.status]} • до ${mskDate(x.end_by)}`.slice(0, 100), default: x.id === m.id,
  }));
  return new ModalBuilder().setCustomId(`mnt:nom:${m.id}`).setTitle('Отказ от кураторства').addLabelComponents(
    labelSelect('target', 'Курируемый', options, 'Выберите курируемого'),
    labelText('reason', 'Причина отказа', { style: TextInputStyle.Paragraph, max: 500, placeholder: 'Почему вы отказываетесь' }));
}

async function submitRefuse(client, i) {
  const m = get(Number(i.fields.getStringSelectValues('target')[0]));
  if (!m || !OPEN.includes(m.status)) return i.reply({ content: 'Это кураторство уже не активно.', ...EPH });
  if (!canAct(i, m)) return deny(i, 'Отказать может куратор или руководство.');
  const reason = i.fields.getTextInputValue('reason').trim();
  db.prepare(`UPDATE mentorships SET status='refused', refuse_reason=?, finished_ts=? WHERE id=?`).run(reason, nowTs(), m.id);
  const f = get(m.id);
  await i.reply({ content: `🚫 Кураторство №${f.id} (<@${f.mentee_id}>) закрыто отказом.`, ...EPH });
  await refreshCard(client, f);

  const roles = [...new Set([...roleIdsWith('mentoring'), ...roleIdsWith('approve')])];
  await sendAll(client, cardChannels().length ? cardChannels() : [f.channel_id].filter(Boolean), (ch) => ({
    content: pingIn(ch, roles) || undefined,
    embeds: [new EmbedBuilder().setColor(C.danger).setTitle('🚫 Куратор отказался от кураторства').setDescription(
      `**Куратор:** <@${f.mentor_id}>\n**Курируемый:** <@${f.mentee_id}>\n` +
      `**Причина:** ${reason}\n**Отказал:** <@${i.user.id}>`).setFooter({ text: stamp() })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mnt:readd:${f.mentee_id}`).setLabel('Назначить заново').setEmoji('➕').setStyle(ButtonStyle.Primary))],
  }));
}

async function start(client, i, m) {
  if (!canAct(i, m)) return deny(i, 'Приступить может куратор.');
  if (m.status !== 'pending') return i.update(payload(m));
  db.prepare(`UPDATE mentorships SET status='active', started_ts=? WHERE id=?`).run(nowTs(), m.id);
  return i.update(payload(get(m.id)));
}

const finishModal = (m) =>
  new ModalBuilder().setCustomId(`mnt:finm:${m.id}`).setTitle('Завершение кураторства').addLabelComponents(
    labelSelect('result', 'Результат', [
      { label: 'Успешно', value: 'done', emoji: '✅' }, { label: 'Неуспешно', value: 'failed', emoji: '❌' },
    ], 'Выберите результат'),
    labelText('review', 'Отзыв о курируемом', { style: TextInputStyle.Paragraph, required: false, max: 800 }));

async function submitFinish(client, i, id) {
  const m = get(id);
  if (!m || m.status !== 'active') return i.reply({ content: 'Кураторство уже не активно.', ...EPH });
  if (!canAct(i, m)) return deny(i, 'Завершить может куратор.');
  const status = i.fields.getStringSelectValues('result')[0] === 'done' ? 'done' : 'failed';
  const review = i.fields.getTextInputValue('review').trim() || null;
  db.prepare('UPDATE mentorships SET status=?, finished_ts=?, result_comment=? WHERE id=?').run(status, nowTs(), review, m.id);
  const f = get(m.id);
  if (i.isFromMessage()) await i.update(payload(f));
  else { await i.reply({ content: '✅ Кураторство завершено.', ...EPH }); await refreshCard(client, f); }
}

const extendModal = (m, kind) =>
  new ModalBuilder().setCustomId(`mnt:extm:${m.id}:${kind}`).setTitle('Продление дедлайна').addLabelComponents(
    labelText('hours', 'Продлить на (часов)', { placeholder: 'Например: 24', max: 3 }));

async function submitExtend(client, i, id, kind) {
  if (!canManage(i)) return deny(i, 'Продлевать сроки может руководство.');
  const m = get(id);
  const h = Number(i.fields.getTextInputValue('hours'));
  if (!m || !OPEN.includes(m.status)) return i.reply({ content: 'Кураторство уже не активно.', ...EPH });
  if (!Number.isInteger(h) || h < 1 || h > 336) return i.reply({ content: 'Укажите целое число часов от 1 до 336.', ...EPH });
  if (kind === 's') db.prepare('UPDATE mentorships SET start_by=start_by+?, notified_start=0 WHERE id=?').run(h * 3600, m.id);
  else db.prepare('UPDATE mentorships SET end_by=end_by+?, notified_end=0, reminded=0 WHERE id=?').run(h * 3600, m.id);
  const f = get(m.id);
  await i.reply({ content: `✅ Продлено на ${h} ч.`, ...EPH });
  await refreshCard(client, f);
}

/* ---------- мои кураторства, инструкция ---------- */
function mine(i) {
  const list = db.prepare('SELECT * FROM mentorships WHERE mentor_id=? OR mentee_id=? ORDER BY created_ts DESC LIMIT 15')
    .all(i.user.id, i.user.id);
  if (!list.length) return i.reply({ content: 'У вас нет кураторств.', ...EPH });
  const text = list.map((m) => m.mentor_id === i.user.id
    ? `• **№${m.id}** — вы куратор → <@${m.mentee_id}> — ${STATUS[m.status]} — до ${mskDate(m.end_by)}`
    : `• **№${m.id}** — ваш куратор: <@${m.mentor_id}> — ${STATUS[m.status]} — до ${mskDate(m.end_by)}`).join('\n');
  return i.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📋 Мои кураторства').setDescription(text).setFooter({ text: stamp() })], ...EPH });
}

function instruction(i) {
  const text = getSetting('mentor_instruction');
  const rowsOut = can(i, 'mentoring_text')
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mnt:instedit').setLabel('Изменить текст').setEmoji('✏️').setStyle(ButtonStyle.Secondary))]
    : [];
  return i.reply({
    embeds: [new EmbedBuilder().setColor(C.info).setTitle('📖 Инструкция по кураторству')
      .setDescription(text || 'Инструкция пока не заполнена. Её добавляет Генеральный прокурор.').setFooter({ text: stamp() })],
    components: rowsOut, ...EPH,
  });
}

/* ---------- переназначение и отмена (доступ «Кураторство») ---------- */
const reassignModal = (m) =>
  new ModalBuilder().setCustomId(`mnt:rem:${m.id}`).setTitle('Переназначить куратора').addLabelComponents(
    labelUser('mentor', 'Новый куратор'),
    labelText('days', 'Срок кураторства (дней)', { value: String(Math.min(60, Math.max(1, Math.ceil((m.end_by - nowTs()) / 86400)))), max: 2 }),
    labelText('reason', 'Причина (необязательно)', { style: TextInputStyle.Paragraph, required: false, max: 500 }));

async function submitReassign(client, i, id) {
  if (!canManage(i)) return deny(i, 'Переназначать может руководство.');
  const m = get(id);
  if (!m || !OPEN.includes(m.status)) return i.reply({ content: 'Это кураторство уже не активно.', ...EPH });
  const user = i.fields.getSelectedUsers('mentor', true).first();
  const days = Number(i.fields.getTextInputValue('days'));
  const reason = i.fields.getTextInputValue('reason').trim();

  if (user.bot) return i.reply({ content: 'Бот не может быть куратором.', ...EPH });
  if (user.id === m.mentor_id) return i.reply({ content: `<@${user.id}> уже ведёт это кураторство.`, ...EPH });
  if (user.id === m.mentee_id) return i.reply({ content: 'Курируемый не может стать своим куратором.', ...EPH });
  if (!Number.isInteger(days) || days < 1 || days > 60) return i.reply({ content: 'Срок — целое число дней от 1 до 60.', ...EPH });
  if (isOnVacation(user.id)) return i.reply({ content: `<@${user.id}> сейчас в отпуске — выберите другого куратора.`, ...EPH });

  await i.deferReply(EPH);
  const oldMentor = m.mentor_id;
  const name = (await i.guild.members.fetch(user.id).catch(() => null))?.displayName ?? user.username;
  const now = nowTs();
  db.prepare(`UPDATE mentorships SET mentor_id=?, mentor_name=?, mentor_tag=?, status='active', started_ts=?,
              start_by=?, end_by=?, notified_start=0, notified_end=0, reminded=0 WHERE id=?`)
    .run(user.id, name, user.username, now, now, now + days * 86400, m.id);
  const f = get(m.id);
  await refreshCard(client, f);

  // ЛС только новому куратору — ему нужно приступить
  await sendDM(client, f.mentor_id, { embeds: [cardEmbed(f, '🎓 Вам назначено кураторство')], components: [instructionButton()] });
  return i.editReply(`🔄 Кураторство над <@${f.mentee_id}> переназначено: <@${oldMentor}> → <@${f.mentor_id}>.` +
    (reason ? `\nПричина: ${reason}` : ''));
}

const cancelModal = (m) =>
  new ModalBuilder().setCustomId(`mnt:cxm:${m.id}`).setTitle('Отмена кураторства').addLabelComponents(
    labelText('reason', 'Причина отмены', { style: TextInputStyle.Paragraph, max: 500, placeholder: 'Почему кураторство отменяется' }));

async function submitCancel(client, i, id) {
  if (!canManage(i)) return deny(i, 'Отменять может руководство.');
  const m = get(id);
  if (!m || !OPEN.includes(m.status)) return i.reply({ content: 'Это кураторство уже не активно.', ...EPH });
  const reason = i.fields.getTextInputValue('reason').trim();
  db.prepare(`UPDATE mentorships SET status='cancelled', cancel_reason=?, finished_ts=? WHERE id=?`).run(reason, nowTs(), m.id);
  const f = get(m.id);
  await i.reply({ content: `🗑️ Кураторство над <@${f.mentee_id}> отменено.`, ...EPH });
  await refreshCard(client, f);
}

/* ---------- роутер ---------- */
export async function handleMentoring(client, i) {
  const [, action, arg] = i.customId.split(':');
  await routeMentoring(client, i);
  // карточку обновило нажатие — остальные копии на других серверах
  if (['go', 'finm'].includes(action)) {
    const m = get(Number(arg));
    if (m) await refreshCard(client, m, i.message?.id).catch(() => {});
  }
}

async function routeMentoring(client, i) {
  const [, action, arg, arg2] = i.customId.split(':');
  const id = Number(arg);

  if (action === 'add') return canManage(i) ? i.showModal(addModal()) : deny(i);
  if (action === 'readd') return canManage(i) ? i.showModal(addModal(arg)) : deny(i);
  if (action === 'addm') return submitAdd(client, i);
  if (action === 'active') return showActive(client, i);
  if (action === 'actp') return i.update(activeView(i, Number(arg)));
  if (action === 'mine') return mine(i);
  if (action === 'instr') return instruction(i);
  if (action === 'instedit') {
    if (!can(i, 'mentoring_text')) return deny(i, 'Менять инструкцию может Генеральный прокурор.');
    return i.showModal(new ModalBuilder().setCustomId('mnt:instm').setTitle('Инструкция по кураторству').addLabelComponents(
      labelText('text', 'Текст инструкции', { style: TextInputStyle.Paragraph, max: 4000, value: getSetting('mentor_instruction') || undefined })));
  }
  if (action === 'instm') {
    if (!can(i, 'mentoring_text')) return deny(i, 'Менять инструкцию может Генеральный прокурор.');
    setSetting('mentor_instruction', i.fields.getTextInputValue('text').trim());
    return i.reply({ content: '✅ Текст инструкции обновлён.', ...EPH });
  }
  if (action === 'nom') return submitRefuse(client, i);
  if (action === 'finm') return submitFinish(client, i, id);
  if (action === 'extm') return submitExtend(client, i, id, arg2);
  if (action === 'rem') return submitReassign(client, i, id);
  if (action === 'cxm') return submitCancel(client, i, id);
  if (action === 'pick') {
    if (!canManage(i)) return deny(i, 'Управлять кураторствами может руководство.');
    const picked = get(Number(i.values[0]));
    if (!picked) return i.reply({ content: 'Кураторство не найдено.', ...EPH });
    // кураторство уже закрыто или отменено, пока список был открыт — просто обновляем список
    if (!OPEN.includes(picked.status)) return i.update(activeView(i));
    return i.reply({ embeds: [infoEmbed(picked)], components: manageRows(picked), ...EPH });
  }

  const m = get(id);
  if (!m) return i.reply({ content: 'Кураторство не найдено.', ...EPH });
  if (action === 'go') return start(client, i, m);
  if (action === 'inf') {
    return i.reply({ embeds: [infoEmbed(m)], components: canManage(i) && OPEN.includes(m.status) ? manageRows(m) : [], ...EPH });
  }
  if (action === 're' || action === 'cx') {
    if (!canManage(i)) return deny(i, action === 're' ? 'Переназначать может руководство.' : 'Отменять может руководство.');
    if (!OPEN.includes(m.status)) return i.reply({ content: 'Это кураторство уже не активно.', ...EPH });
    return i.showModal(action === 're' ? reassignModal(m) : cancelModal(m));
  }
  if (action === 'exts' || action === 'exte') {
    if (!canManage(i)) return deny(i, 'Продлевать сроки может руководство.');
    return i.showModal(extendModal(m, action === 'exts' ? 's' : 'e'));
  }
  if (action === 'no') {
    if (!OPEN.includes(m.status)) return i.reply({ content: 'Это кураторство уже не активно.', ...EPH });
    if (!canAct(i, m)) return deny(i, 'Отказать может куратор или руководство.');
    return i.showModal(refuseModal(i, m));
  }
  if (action === 'fin') {
    if (m.status !== 'active') return i.reply({ content: 'Завершить можно только начатое кураторство.', ...EPH });
    if (!canAct(i, m)) return deny(i, 'Завершить может куратор.');
    return i.showModal(finishModal(m));
  }
}

/* ---------- активные кураторства: кнопка на панели и /curators ---------- */
/** Список строится заново при каждом показе (embed + листание + выпадающий список управления для руководства) */
const PER_PAGE = 6;

function activeView(i, page = 0) {
  const list = db.prepare(`SELECT * FROM mentorships WHERE status IN ('active','pending')
                           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, end_by LIMIT 200`).all();
  const nActive = list.filter((m) => m.status === 'active').length;
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const shown = list.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const e = new EmbedBuilder().setColor(C.success).setTitle('🟢 Активные кураторства')
    .setDescription(list.length
      ? `🟢 **Идут сейчас:** ${nActive}\n⏳ **Ожидают начала:** ${list.length - nActive}\n​`
      : 'Сейчас нет действующих кураторств.')
    .setFooter({ text: pages > 1 ? `Стр. ${page + 1}/${pages} • ${stamp()}` : stamp() });
  // у каждого кураторства свой блок: заголовок со статусом и три колонки в ряд (так карточка тянется на всю ширину)
  for (const m of shown) {
    e.addFields(
      { name: `🎓 Кураторство ${m.mentee_name}`.slice(0, 256), value: STATUS[m.status] },
      { name: 'Куратор', value: `<@${m.mentor_id}>`, inline: true },
      { name: 'Курируемый', value: `<@${m.mentee_id}>`, inline: true },
      { name: '⏰ Конец', value: msk(m.end_by), inline: true });
  }

  const components = [];
  // руководству — выбор кураторства для управления (переназначить, отменить, продлить)
  if (canManage(i) && shown.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('mnt:pick').setPlaceholder('Управление кураторством…').addOptions(
        shown.map((m) => ({
          label: m.mentee_name.slice(0, 100), value: String(m.id),
          description: `Куратор: ${m.mentor_name} • до ${mskDate(m.end_by)}`.slice(0, 100),
        })))));
  }
  if (pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mnt:actp:${page - 1}`).setLabel('◀ Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`mnt:actp:${page + 1}`).setLabel('Вперёд ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)));
  }
  return { embeds: [e], components };
}

export const showActive = (client, i) => i.reply({ ...activeView(i), ...EPH });
export const curators = showActive;

/* ---------- напоминание (вызывается раз в минуту) ---------- */
/** За сутки до конца куратору приходит одно напоминание. Уведомлений о просрочке нет. */
export async function checkMentoring(client) {
  const now = nowTs();
  for (const m of db.prepare(`SELECT * FROM mentorships WHERE status IN ('pending','active') AND reminded=0 AND end_by>? AND end_by<=?`)
    .all(now, now + 86400)) {
    db.prepare('UPDATE mentorships SET reminded=1 WHERE id=?').run(m.id);
    await sendDM(client, m.mentor_id, { content: `⏰ Кураторство №${m.id} (<@${m.mentee_id}>) заканчивается ${msk(m.end_by)} — осталось меньше суток.` });
  }
}
