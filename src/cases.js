import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db } from './db.js';
import { deleteAll, destinations, editAll, sendAll } from './mirror.js';
import { can, hasRulesFor, isLeader, isJudge, isSenior } from './access.js';
import { C, COLOR, EPH, isProsecutor, nowTs, parseDate, safeText, sendDM, stamp } from './util.js';

export const STATUS = {
  pending: '⏳ На рассмотрении', approved: '✅ Одобрено', rework: '🔄 На доработке', rejected: '❌ Отклонено',
};
const STATUS_COLOR = { pending: C.info, approved: C.success, rework: C.warn, rejected: C.danger };

/** Ссылка на документ: только http(s); скобки кодируются, чтобы не сломать разметку [Открыть](...) */
function docLink(d) {
  try {
    const u = new URL(d);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `[Открыть](${u.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
  } catch { /* не ссылка */ }
  return safeText(String(d || '—'));
}
const isWebUrl = (d) => { try { return ['http:', 'https:'].includes(new URL(d).protocol); } catch { return false; } };

export const getCase = (uin) => db.prepare('SELECT * FROM cases WHERE uin=?').get(uin);
/** Номер дела необязателен: без него в базе хранится «б/н-<УИН>» (номер уникален), показываем «без номера» */
const NO_NUMBER = 'б/н-';
const numberOf = (c) => (c.number?.startsWith(NO_NUMBER) ? 'без номера' : c.number);

export function caseEmbed(c) {
  const e = new EmbedBuilder()
    .setColor(STATUS_COLOR[c.status] ?? COLOR)
    .setTitle(`📁 Уголовное дело — УИН ${c.uin}`)
    .addFields(
      { name: 'Номер дела', value: numberOf(c), inline: true },
      { name: 'Статус', value: STATUS[c.status], inline: true },
      { name: 'Прокурор', value: `<@${c.prosecutor_id}>`, inline: true },
      { name: 'Обвиняемый', value: c.accused, inline: true },
      { name: 'Паспорт', value: c.passport, inline: true },
      { name: 'Дата возбуждения', value: c.opened_date, inline: true },
    )
    .setFooter({ text: stamp(c.created_ts) });
  // решение по одобренному делу — отдельной строкой, чтобы статус не переносился
  if (c.status === 'approved' && c.action) e.addFields({ name: 'Решение', value: actionText(c) });
  e.addFields({ name: 'Документ', value: docLink(c.document) });
  if (c.status === 'rework' && c.comment) e.addFields({ name: 'Комментарий к доработке', value: c.comment });
  return e;
}

function newUin() {
  for (;;) {
    const uin = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    if (!getCase(uin)) return uin;
  }
}

/** Карточка дела в канале проверки: до решения — все реквизиты, после — статус и «Проверил» */
export function reviewEmbed(c) {
  const doc = docLink(c.document);
  const e = new EmbedBuilder().setTitle(`📁 Уголовное дело — УИН ${c.uin}`);
  if (c.status === 'pending') {
    // как в оригинале: строки, жёлтая полоса — дело ждёт решения
    return e.setColor(C.warn).setDescription([
      `**Номер:** ${numberOf(c)}`,
      `**Обвиняемый:** ${safeText(c.accused)}`,
      `**Паспорт:** ${safeText(c.passport)}`,
      `**Дата возбуждения:** ${safeText(c.opened_date)}`,
      `**Прокурор:** <@${c.prosecutor_id}>`,
      '',
      `**Документ:** ${doc}`,
    ].join('\n')).setFooter({ text: stamp(c.created_ts) });
  }
  // после решения — как в оригинале: строки «Номер / Обвиняемый / Статус / Проверил», ниже документ
  const lines = [
    `**Номер:** ${numberOf(c)}`,
    `**Обвиняемый:** ${safeText(c.accused)}`,
    `**Статус:** ${STATUS[c.status]}${c.status === 'approved' && c.action ? ` · ${actionText(c)}` : ''}`,
    `**Проверил:** <@${c.decided_by}>`,
    ...(c.status === 'rework' && c.comment ? [`**Комментарий к доработке:** ${safeText(c.comment)}`] : []),
    '',
    `**Документ:** ${doc}`,
  ];
  return e.setColor(c.status === 'rework' ? C.brand : STATUS_COLOR[c.status]).setDescription(lines.join('\n'))
    .setFooter({ text: stamp(c.decided_ts ?? c.created_ts) });
}

/** Действия по одобренному делу (как в оригинале) */
const ACTIONS = {
  court: { label: 'Отправить в суд', emoji: '📨', plain: () => 'Отправлено в суд' },
  warrant: { label: 'Выдать ордер', emoji: '📋', plain: () => 'Будет выдан ордер' },
  fine: { label: 'Назначить штраф', emoji: '💰', plain: (c) => `Штраф: ${c.action_value}` },
};
/** В карточке — со значком, в ЛС — простым текстом */
const actionText = (c) => (ACTIONS[c.action] ? `${ACTIONS[c.action].emoji} ${ACTIONS[c.action].plain(c)}` : '');
const actionPlain = (c) => ACTIONS[c.action]?.plain(c) ?? '';

/** ЛС прокурору о решении — как в оригинале: «Ваше дело УИН … - Одобрено» и строка «Решение: …» */
function decisionDM(c) {
  const head = `Ваше дело УИН ${c.uin} - ${{ approved: 'Одобрено', rejected: 'Отклонено', rework: 'На доработку' }[c.status]}`;
  if (c.status === 'approved' && c.action) return `${head}\nРешение: ${actionPlain(c)}`;
  if (c.status === 'rework' && c.comment) return `${head}\nКомментарий: ${c.comment}`;
  return head;
}

/** «50000» → «$50 000»; если ввели что-то своё (например, «$50k») — оставляем как есть */
function money(s) {
  const digits = String(s).replace(/[\s$,.]/g, '');
  return /^\d+$/.test(digits) ? `$${Number(digits).toLocaleString('ru-RU').replace(/ /g, ' ')}` : String(s).trim();
}

/** Под карточкой: до решения — выбор решения; одобрено без действия — выбор действия; иначе — снова выбор решения */
const reviewComponents = (uin) => {
  const c = getCase(uin);
  if (c?.status === 'approved' && !c.action) {
    return [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`case:act:${uin}`).setPlaceholder('Действие по одобренному делу...')
        .addOptions(Object.entries(ACTIONS).map(([value, a]) => ({ label: a.label, value, emoji: a.emoji }))))];
  }
  if (c?.status === 'approved') return [];
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`case:dec:${uin}`).setPlaceholder('Выберите решение...')
      .addOptions(
        { label: 'Одобрить', value: 'approve', emoji: '✅' },
        { label: 'На доработку', value: 'rework', emoji: '🔄' },
        { label: 'Отклонить', value: 'reject', emoji: '❌' }))];
};

/** Выбор действия по одобренному делу (штраф — с суммой через форму) */
async function chooseAction(client, i) {
  const c = getCase(i.customId.split(':')[2]);
  if (!c) return i.reply({ content: 'Дело не найдено.', ...EPH });
  if (!canDecide(i)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  if (c.status !== 'approved' || c.action) return i.update({ embeds: [reviewEmbed(c)], components: reviewComponents(c.uin) });
  const v = i.values[0];
  if (v === 'fine') {
    return i.showModal(new ModalBuilder().setCustomId(`case:finem:${c.uin}`).setTitle('Назначение штрафа').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sum').setLabel('Сумма штрафа ($)')
        .setPlaceholder('Например: 50000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30))));
  }
  return applyAction(client, i, c, v, null);
}

async function applyAction(client, i, c, action, value) {
  db.prepare('UPDATE cases SET action=?, action_value=?, action_by=? WHERE uin=?').run(action, value, i.user.id, c.uin);
  const f = getCase(c.uin);
  const payload = { embeds: [reviewEmbed(f)], components: reviewComponents(f.uin) };
  // сюда приходят и выбор из списка (у него нет isFromMessage), и форма штрафа
  const onCard = !i.isModalSubmit() || i.isFromMessage();
  await (onCard ? i.update(payload) : i.reply({ ...payload, ...EPH }));
  sendDM(client, f.prosecutor_id, { content: decisionDM(f), embeds: [caseEmbed(f)] });
}

const canSee = (i, c) => c.prosecutor_id === i.user.id || isLeader(i) || isJudge(i);
/** Решение по делу (одобрить / на доработку / отклонить, действие): старший состав прокуратуры; судьи — тоже */
const canDecide = (i) => isSenior(i) || isLeader(i) || isJudge(i);

/* ---------- регистрация дела: команда /register_case и панель «Уголовные дела» ---------- */
/** Если роли выбраны через /access (право «Регистрация дел») — только они и руководство; иначе зарегистрированные прокуроры. */
function canRegister(i) {
  if (isLeader(i)) return true;
  return hasRulesFor('case_register') ? can(i, 'case_register') : isProsecutor(i.user.id);
}
const denyRegister = (i) => i.reply({ content: '⛔ Регистрировать дела могут только выбранные роли. Доступ выдаёт руководство командой /access.', ...EPH });

async function createCase(client, i, { owner, number, accused, passport, date, document }) {
  if (![accused, date, document].every(Boolean)) return i.reply({ content: '⚠️ Заполните ссылку на документ, ФИО обвиняемого и дату.', ...EPH });
  if (!parseDate(date)) return i.reply({ content: 'Дата должна быть в формате ДД.ММ.ГГГГ.', ...EPH });
  if (!isWebUrl(document)) return i.reply({ content: '⚠️ Документ — это ссылка, начинающаяся с https://', ...EPH });
  const reviewChannels = destinations('case_review');
  if (!reviewChannels.length) return i.reply({ content: 'Канал проверки дел не настроен: /setup panel:Дела на проверку.', ...EPH });

  const existing = number ? db.prepare('SELECT * FROM cases WHERE number=?').get(number) : null;
  if (existing && !(existing.status === 'rework' && existing.prosecutor_id === owner)) {
    return i.reply({ content: `Дело с номером ${number} уже зарегистрировано (УИН ${existing.uin}).`, ...EPH });
  }
  await i.deferReply(EPH);
  if (existing) {
    await deleteAll(client, 'case', existing.uin); // старые карточки на всех серверах
    if (existing.review_message_id) {
      const old = await client.channels.fetch(existing.review_channel_id).catch(() => null);
      await old?.messages.delete(existing.review_message_id).catch(() => {});
    }
  }

  let uin = existing?.uin;
  if (existing) {
    db.prepare(`UPDATE cases SET accused=?, passport=?, opened_date=?, document=?, status='pending', comment=NULL
                WHERE uin=?`).run(accused, passport || '—', date, document, uin);
  } else {
    uin = newUin();
    db.prepare(`INSERT INTO cases(uin,number,accused,passport,opened_date,document,prosecutor_id,created_ts)
                VALUES(?,?,?,?,?,?,?,?)`).run(uin, number || `${NO_NUMBER}${uin}`, accused, passport || '—', date, document, owner, nowTs());
  }
  const c = getCase(uin);
  const sent = await sendAll(client, reviewChannels, { embeds: [reviewEmbed(c)], components: reviewComponents(uin) }, { kind: 'case', ref: uin });
  if (sent[0]) db.prepare('UPDATE cases SET review_channel_id=?, review_message_id=? WHERE uin=?').run(sent[0].channelId, sent[0].id, uin);
  // прокурору в ЛС — как в оригинале
  await sendDM(client, owner, { embeds: [new EmbedBuilder().setColor(C.success)
    .setTitle(existing ? '✅ Уголовное дело отправлено повторно' : '✅ Уголовное дело зарегистрировано')
    .setDescription(`**Номер дела:** ${safeText(c.number?.startsWith(NO_NUMBER) ? uin : c.number)}\n` +
      `**Обвиняемый:** ${safeText(c.accused ?? '—')}\n**Документ:** ${docLink(c.document)}\n\nДело отправлено на проверку ЗГП/ГП.`)
    .setFooter({ text: stamp() })] });
  return i.editReply(`Дело ${existing ? 'отправлено повторно' : 'зарегистрировано'}. УИН: **${uin}**. Ожидайте решения.`);
}

export async function registerCase(client, i) {
  const o = i.options;
  const target = o.getUser('prosecutor');
  if (target && !isLeader(i)) return i.reply({ content: '⛔ Указывать другого прокурора может только руководство.', ...EPH });
  if (!canRegister(i)) return denyRegister(i);
  return createCase(client, i, {
    owner: target?.id ?? i.user.id, number: (o.getString('number') ?? '').trim(), accused: o.getString('accused').trim(),
    passport: (o.getString('passport') ?? '').trim(), date: o.getString('date').trim(), document: o.getString('document').trim(),
  });
}

export const caseRegisterPanelPayload = () => ({
  embeds: [new EmbedBuilder().setColor(C.info).setTitle('📂 Уголовные дела').setDescription(
    '**Регистрация дела:**\nНажмите кнопку «Зарегистрировать» для внесения нового дела в реестр.\n\n' +
    '**Запрос дела:**\nНажмите «Запросить» для получения информации о деле по УИН или номеру.').setFooter({ text: stamp() })],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('case:regnew').setLabel('Зарегистрировать дело').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('case:req').setLabel('Запросить дело').setEmoji('🔍').setStyle(ButtonStyle.Secondary))],
});

const regField = (id, label, placeholder, required = true) =>
  new LabelBuilder().setLabel(label).setTextInputComponent(
    new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required).setMaxLength(200));

const registerModal = () =>
  new ModalBuilder().setCustomId('case:regm').setTitle('Регистрация уголовного дела').addLabelComponents(
    regField('document', 'Ссылка на Google Docs', 'https://docs.google.com/document/d/...'),
    regField('number', 'Номер дела (если есть)', 'DJR-1123', false),
    regField('accused', 'ФИО обвиняемого', 'Иванов Иван Иванович'),
    regField('passport', 'Паспорт обвиняемого', '1234567', false),
    regField('date', 'Дата возбуждения (ДД.ММ.ГГГГ)', '29.12.2024'));

async function submitRegister(client, i) {
  if (!canRegister(i)) return denyRegister(i);
  const f = (k) => i.fields.getTextInputValue(k).trim();
  return createCase(client, i, {
    owner: i.user.id, number: f('number'), accused: f('accused'), passport: f('passport'), date: f('date'), document: f('document'),
  });
}

/* ---------- /case, /cases, /my_cases ---------- */
export async function caseInfo(client, i) {
  const c = getCase(i.options.getString('uin').trim());
  if (!c) return i.reply({ content: 'Дело с таким УИН не найдено.', ...EPH });
  if (!canSee(i, c)) return i.reply({ content: '⛔ Нет доступа. Запросите его через /request_case.', ...EPH });
  return i.reply({ embeds: [caseEmbed(c)], ...EPH });
}

export async function casesStats(client, i) {
  const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM cases GROUP BY status').all().map((r) => [r.status, r.n]));
  const total = Object.values(by).reduce((s, n) => s + n, 0);
  const e = new EmbedBuilder().setColor(COLOR).setTitle('📁 Статистика уголовных дел')
    .setDescription(`**Всего зарегистрировано:** ${total}`)
    .addFields(
      { name: '⏳ На рассмотрении', value: String(by.pending ?? 0), inline: true },
      { name: '✅ Одобрены', value: String(by.approved ?? 0), inline: true },
      { name: '🔄 На доработке', value: String(by.rework ?? 0), inline: true },
      { name: '❌ Отклонены', value: String(by.rejected ?? 0), inline: true },
    ).setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH });
}

export function caseLines(rows) {
  return rows.map((c) => `• **${c.uin}** — ${c.accused} — ${STATUS[c.status]}`).join('\n') || 'Дел нет.';
}

export async function myCases(client, i) {
  const rows = db.prepare('SELECT * FROM cases WHERE prosecutor_id=? ORDER BY created_ts DESC LIMIT 25').all(i.user.id);
  if (!rows.length) return i.reply({ content: 'У вас нет зарегистрированных дел.', ...EPH });
  const e = new EmbedBuilder().setColor(COLOR).setTitle('📁 Мои уголовные дела')
    .setDescription(caseLines(rows)).setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH });
}

/* ---------- запрос доступа ---------- */
export function requestModal() {
  // как в оригинале: два необязательных поля, достаточно заполнить любое
  return new ModalBuilder().setCustomId('case:reqm').setTitle('Запрос доступа к делу').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('uin').setLabel('УИН дела (если известен)').setPlaceholder('1234567')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('number').setLabel('Номер дела (если известен)').setPlaceholder('DJR-1123')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(60)));
}
export const requestCase = (client, i) => i.showModal(requestModal());

async function submitRequest(client, i) {
  const uin = i.fields.getTextInputValue('uin').trim();
  const number = i.fields.getTextInputValue('number').trim();
  if (!uin && !number) return i.reply({ content: '⚠️ Укажите УИН или номер дела.', ...EPH });
  const c = (uin && getCase(uin)) || (number && db.prepare('SELECT * FROM cases WHERE number=? COLLATE NOCASE').get(number));
  if (!c) return i.reply({ content: 'Дело не найдено. Проверьте УИН или номер.', ...EPH });
  // доступ уже есть (прокурор дела, судья, руководство) — одобрение не нужно, но информация всё равно идёт в ЛС
  if (canSee(i, c)) {
    const ok = await sendDM(client, i.user.id, { embeds: [caseEmbed(c)] });
    return ok ? i.reply({ content: '✅ У вас есть доступ к этому делу — информация отправлена вам в ЛС.', ...EPH })
      : i.reply({ content: '⚠️ Не удалось написать вам в ЛС: откройте личные сообщения от участников сервера.', ...EPH });
  }
  const dup = db.prepare(`SELECT 1 FROM case_requests WHERE uin=? AND requester_id=? AND status='pending'`)
    .get(c.uin, i.user.id);
  if (dup) return i.reply({ content: 'Ваш запрос уже на рассмотрении.', ...EPH });
  // свой канал «Запросы дел»; не выбран — в «Дела на проверку», как раньше
  const reviewChannels = destinations('case_req_cards', 'case_review');
  if (!reviewChannels.length) return i.reply({ content: 'Канал для запросов дел не настроен.', ...EPH });

  const r = db.prepare('INSERT INTO case_requests(uin,requester_id,created_ts) VALUES(?,?,?)')
    .run(c.uin, i.user.id, nowTs());
  const id = Number(r.lastInsertRowid);
  await sendAll(client, reviewChannels, {
    embeds: [requestCard(db.prepare('SELECT * FROM case_requests WHERE id=?').get(id), c)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`case:ra:${id}`).setLabel('Одобрить').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`case:rd:${id}`).setLabel('Отклонить').setEmoji('❌').setStyle(ButtonStyle.Danger))],
  }, { kind: 'creq', ref: id });
  return i.reply({ content: 'Запрос отправлен. После одобрения информация придёт вам в ЛС.', ...EPH });
}

/**
 * Карточка запроса дела — как в оригинале:
 * ждёт решения → «📨 Запрос дела»; одобрен → «✅ Запрос одобрен … 📬 Информация отправлена в ЛС.»;
 * отклонён → «❌ Запрос отклонён … 📭 Запрашивающий уведомлён в ЛС.»
 */
function requestCard(r, c, decidedBy = null, dmOk = true) {
  const head = [`**Запрашивал:** <@${r.requester_id}>`, `**Номер дела:** ${numberOf(c)}`];
  if (r.status === 'pending') {
    return new EmbedBuilder().setColor(C.info).setTitle('📨 Запрос дела')
      .setDescription([...head, `**УИН:** ${c.uin}`, `**Прокурор по делу:** <@${c.prosecutor_id}>`].join('\n'))
      .setFooter({ text: stamp(r.created_ts) });
  }
  const ok = r.status === 'approved';
  const dmLine = !dmOk ? '⚠️ Не удалось написать в ЛС — у пользователя закрыты личные сообщения.'
    : ok ? '📬 Информация отправлена в ЛС.' : '📭 Запрашивающий уведомлён в ЛС.';
  return new EmbedBuilder().setColor(ok ? C.success : C.danger).setTitle(ok ? '✅ Запрос одобрен' : '❌ Запрос отклонён')
    .setDescription([...head, `**${ok ? 'Одобрил' : 'Отклонил'}:** <@${decidedBy}>`, '', dmLine].join('\n'))
    .setFooter({ text: stamp() });
}

async function decideRequest(client, i, approve) {
  const id = Number(i.customId.split(':')[2]);
  const r = db.prepare('SELECT * FROM case_requests WHERE id=?').get(id);
  const c = r && getCase(r.uin);
  if (!r || !c) return i.update({ content: 'Запрос не найден.', embeds: [], components: [] });
  if (!canSee(i, c)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  if (r.status !== 'pending') return i.update({ components: [] }); // уже решено (двойное нажатие)
  db.prepare('UPDATE case_requests SET status=? WHERE id=?').run(approve ? 'approved' : 'denied', id);
  await i.deferUpdate();
  const dmOk = approve
    ? await sendDM(client, r.requester_id, { content: `Ваш запрос дела ${numberOf(c)} - Одобрен`, embeds: [caseEmbed(c)] })
    : await sendDM(client, r.requester_id, { content: `Ваш запрос дела ${numberOf(c)} - Отклонён` });
  const f = db.prepare('SELECT * FROM case_requests WHERE id=?').get(id);
  const done = { embeds: [requestCard(f, c, i.user.id, dmOk)], components: [] };
  await i.editReply(done);
  return editAll(client, 'creq', id, done, i.message?.id); // копии на других серверах
}

/* ---------- решение по делу ---------- */
/** Решение по делу; при одобрении — сразу с действием. Прокурору уходит одно ЛС с итогом. */
async function finalize(client, i, c, status, comment, action = null, value = null) {
  db.prepare(`UPDATE cases SET status=?, comment=?, decided_by=?, decided_ts=?, action=?, action_value=?, action_by=?
              WHERE uin=?`).run(status, comment ?? null, i.user.id, nowTs(), action, value, action ? i.user.id : null, c.uin);
  const f = getCase(c.uin);
  sendDM(client, f.prosecutor_id, { content: decisionDM(f), embeds: [caseEmbed(f)] });
  return f;
}

/**
 * Одобрение — как в оригинале, в два шага: «Одобрить» → под карточкой выбор действия (и «Отмена»);
 * штраф спрашивает сумму отдельной формой. Дело одобряется и прокурору уходит ЛС только после выбора действия.
 */
const approveRows = (uin) => [
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`case:apa:${uin}`).setPlaceholder('Действие по одобренному делу...')
      .addOptions(Object.entries(ACTIONS).map(([value, a]) => ({ label: a.label, value, emoji: a.emoji })))),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`case:apx:${uin}`).setLabel('Отмена').setStyle(ButtonStyle.Secondary)),
];
const fineModal = (id) => new ModalBuilder().setCustomId(id).setTitle('Назначение штрафа').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sum').setLabel('Сумма штрафа ($)')
    .setPlaceholder('Например: 50000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)));

async function approveStep(client, i, action) {
  const c = getCase(i.customId.split(':')[2]);
  if (!c) return i.reply({ content: 'Дело не найдено.', ...EPH });
  if (!canDecide(i)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  const done = { embeds: [reviewEmbed(c)], components: reviewComponents(c.uin) };
  if (c.status !== 'pending') return i.update(done); // уже решено (двойное нажатие)
  if (action === 'apx') return i.update({ components: reviewComponents(c.uin) });
  if (action === 'apa' && i.values[0] === 'fine') return i.showModal(fineModal(`case:apf:${c.uin}`));
  const [act, value] = action === 'apf' ? ['fine', money(i.fields.getTextInputValue('sum'))] : [i.values[0], null];
  const f = await finalize(client, i, c, 'approved', null, act, value);
  const payload = { embeds: [reviewEmbed(f)], components: reviewComponents(f.uin) };
  return !i.isModalSubmit() || i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...EPH });
}

async function decide(client, i) {
  const c = getCase(i.customId.split(':')[2]);
  if (!c) return i.reply({ content: 'Дело не найдено.', ...EPH });
  if (!canDecide(i)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  const v = i.values[0];
  if (v === 'approve') return i.update({ components: approveRows(c.uin) });
  if (v === 'rework') {
    return i.showModal(new ModalBuilder().setCustomId(`case:rw:${c.uin}`).setTitle('Доработка дела').addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('comment').setLabel('Комментарий к доработке')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))));
  }
  const f = await finalize(client, i, c, 'rejected');
  return i.update({ embeds: [reviewEmbed(f)], components: reviewComponents(f.uin) });
}

async function submitRework(client, i) {
  const c = getCase(i.customId.split(':')[2]);
  if (!c) return i.reply({ content: 'Дело не найдено.', ...EPH });
  if (!canDecide(i)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  const f = await finalize(client, i, c, 'rework', i.fields.getTextInputValue('comment').trim());
  const payload = { embeds: [reviewEmbed(f)], components: reviewComponents(f.uin) };
  return i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...EPH });
}

/* ---------- панель «Запрос уголовных дел» ---------- */
export const requestPanelPayload = () => ({
  embeds: [new EmbedBuilder().setColor(C.info).setTitle('📂 Запрос уголовных дел')
    .setDescription('**Запрос дела:**\nНажмите кнопку для получения информации о деле по УИН или номеру.\n\n' +
      'После одобрения запроса информация будет отправлена вам в ЛС.').setFooter({ text: stamp() })],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('case:req').setLabel('🔍 Запросить дело').setStyle(ButtonStyle.Primary))],
});

/* ---------- роутер ---------- */
/** Действия, после которых карточка дела меняется: правим её копии на других серверах */
const CASE_CHANGES = new Set(['dec', 'rw', 'act', 'apa', 'apf', 'finem']);

export async function handleCase(client, i) {
  const [, action, uin] = i.customId.split(':');
  await routeCase(client, i, action);
  if (CASE_CHANGES.has(action)) {
    const c = getCase(uin);
    // «Одобрить» без выбора действия — пока только выбор под нажатой карточкой, остальные копии не трогаем
    if (c && c.status !== 'pending') await editAll(client, 'case', uin, { embeds: [reviewEmbed(c)], components: reviewComponents(uin) }, i.message?.id);
  }
}

async function routeCase(client, i, action) {
  if (action === 'regnew') return canRegister(i) ? i.showModal(registerModal()) : denyRegister(i);
  if (action === 'regm') return submitRegister(client, i);
  if (action === 'req') return i.showModal(requestModal());
  if (action === 'reqm') return submitRequest(client, i);
  if (action === 'ra') return decideRequest(client, i, true);
  if (action === 'rd') return decideRequest(client, i, false);
  if (action === 'dec') return decide(client, i);
  if (action === 'rw') return submitRework(client, i);
  if (action === 'act') return chooseAction(client, i); // старые карточки: действие после одобрения
  if (['apa', 'apf', 'apx'].includes(action)) return approveStep(client, i, action);
  if (action === 'finem') {
    const c = getCase(i.customId.split(':')[2]);
    if (!c) return i.reply({ content: 'Дело не найдено.', ...EPH });
    if (!canDecide(i)) return i.reply({ content: '⛔ Нет прав.', ...EPH });
    return applyAction(client, i, c, 'fine', money(i.fields.getTextInputValue('sum')));
  }
}
