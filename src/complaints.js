import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { applicantFromTitle, fetchComplaintDetails, fetchFirstPost, fetchPage, fetchThreads, uniqueThreads } from './forum.js';
import { analyzeText, mayUseAI, resultEmbed } from './analyze.js';
import { can, isLeader, isSenior, refreshSeniorFlags, roleIdsWith } from './access.js';
import { accusedIds, isRestricted } from './restricted.js';
import { conf } from './config.js';
import { closedText, extendedText, isAlertMessage, resolveAlerts } from './alerts.js';
import { destinations, editAll, mirrorsOf, pingIn, sendAll } from './mirror.js';
import { C, COLOR, EPH, listProsecutors, msk, nowTs, safeText, sendDM, stamp } from './util.js';

export const RESPOND_H = 12; // дедлайн ответа
export const CLOSE_H = 72;   // дедлайн закрытия
const PAGE = 25;
const YELLOW = C.warn;
const RESULTS = { satisfied: 'удовлетворена', rejected: 'отклонена' };

export const getComplaint = (id) => db.prepare('SELECT * FROM complaints WHERE thread_id=?').get(id);
const prosecutorName = (id) => db.prepare('SELECT name FROM prosecutors WHERE user_id=?').get(id)?.name;

/* ---------- embed'ы ---------- */
// Заголовок и автор приходят с публичного форума: экранируем разметку, чтобы в карточку
// нельзя было подсунуть свою ссылку вида [текст](адрес) или сломать оформление
/** Заявитель — имя из текста жалобы (пункт 1), а не аккаунт форума: они часто различаются */
const applicantOf = (c) => c.applicant || applicantFromTitle(c.title) || c.author || '—';
const head = (c) =>
  `**Номер:** №${c.number ?? '?'}\n**Тема:** ${safeText(c.title ?? '')}\n**Заявитель:** ${safeText(applicantOf(c))}\n` +
  `**Ссылка:** [Открыть на форуме](${c.url})`;

const DUP = {
  name: '⚠️ Дубликат номера жалобы!',
  value: 'Жалоба с таким номером уже подавалась. Возможно, заявитель ошибся в нумерации.',
};

/** Пометка жалобы на руководство — одной строкой в карточке */
const LOCK_LINE = '\n\n🔒 **Жалоба на руководство**';

/** Закрытая жалоба — как в оригинале: «🟢 Жалоба №… — Удовлетворена», тема, заявитель, ссылки, время закрытия */
const CLOSED = {
  satisfied: ['🟢', 'Удовлетворена', C.success],
  rejected: ['🔴', 'Отклонена', C.danger],
};
function closedEmbed(c) {
  const [dot, word, color] = CLOSED[c.result] ?? ['⚪', 'Закрыта', C.muted];
  const lines = [
    `**Тема:** ${safeText(c.title ?? '')}`,
    `**Заявитель:** ${safeText(applicantOf(c))}`,
    `**Ссылка:** [Форум](${c.url})`,
    ...(c.close_url ? [`**Ответ:** [Открыть](${c.close_url})`] : []),
    '',
    `**Закрыта:** ${msk(c.closed_ts ?? nowTs())}`,
  ];
  return new EmbedBuilder().setColor(color).setTitle(`${dot} Жалоба №${c.number ?? '?'} — ${word}`)
    .setDescription(lines.join('\n')).setFooter({ text: stamp(c.closed_ts ?? nowTs()) });
}

export function complaintEmbed(c) {
  const e = new EmbedBuilder().setDescription(head(c) + (c.restricted ? LOCK_LINE : ''));
  if (c.status === 'closed') return closedEmbed(c);
  if (!c.assignee_id) {
    e.setColor(C.brand).setTitle(`🔔 Жалоба №${c.number ?? '?'}`).setFooter({ text: stamp(c.created_ts) });
    if (c.duplicate) e.addFields(DUP);
    return e;
  }
  const accepted = c.status === 'accepted';
  e.setColor(YELLOW).setTitle(`${accepted ? '🟡' : '📋'} Жалоба №${c.number ?? '?'}`)
    .setFooter({ text: stamp(accepted ? c.accepted_ts : c.assigned_ts) });
  if (c.duplicate) e.addFields(DUP);
  e.addFields(
    { name: '📌 Назначено', value: `<@${c.assignee_id}>`, inline: true },
    { name: '⏰ Дедлайн', value: msk(c.close_by), inline: true }); // 72 ч с момента подачи жалобы на форуме
  return e;
}

const STATUS_TEXT = { new: 'Новая', assigned: 'Назначена', accepted: 'В работе', closed: 'Закрыта', old: 'Архив' };

export function infoEmbed(c) {
  const who = c.assignee_id ? `${prosecutorName(c.assignee_id) ?? '—'} (<@${c.assignee_id}>)` : '—';
  const status = c.status === 'closed' && c.result ? `Закрыта (${RESULTS[c.result]})` : STATUS_TEXT[c.status] ?? c.status;
  const e = new EmbedBuilder().setColor(C.details).setTitle(`ℹ️ Жалоба №${c.number ?? '?'}`)
    .setDescription(`**${safeText(c.title ?? '')}**`)
    .addFields(
      { name: 'Заявитель', value: safeText(applicantOf(c)), inline: true },
      { name: 'Аккаунт на форуме', value: safeText(c.author || '—'), inline: true },
      { name: 'Статус', value: `📋 ${status}`, inline: true },
      { name: 'Исполнитель', value: who, inline: true },
      { name: 'Создана', value: msk(c.created_ts), inline: true },
      { name: 'Назначена', value: c.assigned_ts ? msk(c.assigned_ts) : '—', inline: true },
      { name: 'Ответ на форуме', value: c.replies > 0 ? '✅ Да' : '❌ Нет', inline: true },
      { name: 'Дедлайн закрытия', value: c.close_by ? msk(c.close_by) : '—', inline: true },
      { name: 'Закрыта', value: c.closed_ts ? msk(c.closed_ts) : '—', inline: true },
      { name: 'Ссылка', value: `[Открыть на форуме](${c.url})` + (c.close_url ? `\n[Ответ прокурора](${c.close_url})` : '') });
  if (c.duplicate) e.addFields({ name: '⚠️', value: 'Возможный дубликат' });
  if (c.restricted) e.addFields({ name: '🔒', value: 'Жалоба на руководство — только старший состав' });
  return e.setFooter({ text: stamp() });
}

/* ---------- компоненты ---------- */
/** Кого можно назначить на жалобу c: старший состав для жалоб на руководство, и никогда — обвиняемого */
const candidatesOf = (c) => listProsecutors({ seniorOnly: !!c?.restricted, exclude: accusedIds(c?.violator) });

/** Сколько жалоб сейчас в работе у каждого прокурора — показывается в списке выбора */
const workload = () => new Map(db.prepare(`SELECT assignee_id id, COUNT(*) n FROM complaints
  WHERE status IN ('assigned','accepted') GROUP BY assignee_id`).all().map((r) => [r.id, r.n]));

/** withAuto — первым пунктом «Автоматически» (только на 1-й странице; ради него страницы на 24 человека) */
function pickerRows(tid, page, selId, pgId, extra = [], c = null, withAuto = false) {
  const list = candidatesOf(c ?? getComplaint(tid));
  const load = workload();
  const size = withAuto ? PAGE - 1 : PAGE;
  const pages = Math.max(1, Math.ceil(list.length / size));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = list.slice(page * size, (page + 1) * size);
  const auto = withAuto && page === 0
    ? [{ label: 'Автоматически', value: 'auto', description: 'Бот сам выберет наименее загруженного прокурора' }] : [];
  const rows = [];
  if (slice.length || auto.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${selId}:${tid}:${page}`)
        .setPlaceholder(`Прокуроры (стр. ${page + 1}/${pages})`)
        .addOptions(...auto, ...slice.map((p) => ({
          label: (p.vacation ? '[Отпуск] ' : '') + p.name.slice(0, 90), value: p.user_id,
          description: `${p.senior ? 'Старший состав' : 'Прокурор'} • в работе: ${load.get(p.user_id) ?? 0}`,
        })))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${pgId}:${tid}:${page - 1}`).setLabel('◀ Назад')
      .setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`${pgId}:${tid}:${page + 1}`).setLabel('Вперёд ▶')
      .setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    ...extra));
  return rows;
}

const unassignedRows = (c, page = 0) => pickerRows(c.thread_id, page, 'c:sel', 'c:pg', [
  new ButtonBuilder().setCustomId(`c:auto:${c.thread_id}`).setLabel('🎲 Авто').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId(`c:ref:${c.thread_id}:${page}`).setLabel('🔄 Обновить список').setStyle(ButtonStyle.Secondary),
], c);

function actionRows(c) {
  const accepted = c.status === 'accepted';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:acc:${c.thread_id}`).setLabel(accepted ? 'В работе' : 'Принять')
      .setEmoji(accepted ? '✔️' : '✅').setStyle(accepted ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(accepted),
    new ButtonBuilder().setCustomId(`c:re:${c.thread_id}`).setLabel('Переназначить').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`c:cl:${c.thread_id}`).setLabel('Закрыть').setEmoji('📝').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`c:inf:${c.thread_id}`).setLabel('Инфо').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary))];
}

/** Полное содержимое сообщения жалобы в канале для её текущего состояния. */
export function messagePayload(c, page = 0) {
  const embeds = [complaintEmbed(c)];
  if (c.status === 'closed') return { content: '', embeds, components: [] };
  if (!c.assignee_id) return { content: '', embeds, components: unassignedRows(c, page) };
  return { content: `📋 <@${c.assignee_id}>, вам назначена жалоба!`, embeds, components: actionRows(c) };
}

/* ---------- назначение ---------- */
/** Дедлайн закрытия: 72 ч с момента подачи жалобы на форуме */
const deadlineOf = (c) => (c.created_ts ?? nowTs()) + conf.deadlineHours() * 3600;

/**
 * Однократно: жалобам в работе пересчитываем срок от подачи на форуме (раньше считался от назначения).
 * Продлённые вручную сроки не трогаем — у них дедлайн позже, чем «назначение + 72 ч».
 */
if (getSetting('deadline_from_created') !== '1') {
  db.prepare(`UPDATE complaints SET close_by=created_ts+?, remind_stage=0
              WHERE status IN ('assigned','accepted') AND created_ts IS NOT NULL AND close_by<=assigned_ts+?`)
    .run(CLOSE_H * 3600, CLOSE_H * 3600);
  setSetting('deadline_from_created', '1');
}
/** Назначить жалобу (сбрасывает принятие и просрочки). ЛС исполнителю уходит в фоне. */
export function assign(client, c, userId, auto = false) {
  const now = nowTs();
  db.prepare(`UPDATE complaints SET assignee_id=?, status='assigned', assigned_ts=?, accepted_ts=NULL,
              respond_by=?, close_by=?, notified_respond=0, notified_close=0, remind_stage=0, last_nag_ts=NULL
              WHERE thread_id=?`)
    // срок считается от подачи жалобы на форуме, а не от назначения; при переназначении не сбрасывается
    .run(userId, now, now + RESPOND_H * 3600, c.close_by ?? deadlineOf(c), c.thread_id);
  const f = getComplaint(c.thread_id);
  sendDM(client, userId, {
    embeds: [
      new EmbedBuilder().setColor(COLOR)
        .setTitle(auto ? '📋 Вам автоматически назначена жалоба' : '📋 Вам назначена жалоба')
        .setDescription(`${head(f)}\n\n⏰ **Дедлайн закрытия:** ${msk(f.close_by)}`)
        .setFooter({ text: stamp(now) }),
    ],
  });
  return f;
}

/** Наименее загруженный подходящий прокурор (не в отпуске, не обвиняемый, для жалоб на руководство — старший состав) */
export function pickAuto(c = null, exclude = []) {
  const n = nowTs();
  const skip = new Set([...accusedIds(c?.violator), ...exclude]);
  const rows = db.prepare(`
    SELECT p.user_id, p.senior FROM prosecutors p
    WHERE NOT EXISTS (SELECT 1 FROM vacations v WHERE v.user_id=p.user_id AND v.status='approved'
                      AND v.start_ts<=? AND v.end_ts>=?)
    ORDER BY (SELECT COUNT(*) FROM complaints c WHERE c.assignee_id=p.user_id AND c.status IN ('assigned','accepted')),
             RANDOM()`).all(n, n);
  return rows.find((p) => !skip.has(p.user_id) && (!c?.restricted || p.senior))?.user_id;
}

/** null — можно назначать; иначе причина отказа */
function ineligible(c, userId) {
  if (accusedIds(c.violator).includes(userId)) return 'Нельзя назначить жалобу на самого обвиняемого.';
  if (c.restricted && !db.prepare('SELECT 1 FROM prosecutors WHERE user_id=? AND senior=1').get(userId)) {
    return '🔒 Эту жалобу могут вести только СГП, ЗГП и ГП (старший состав).';
  }
  return null;
}

/** Каналы «Жалобы» на всех серверах бота */
const complaintChannels = () => destinations('complaints');

/**
 * Обновить карточку жалобы во всех каналах (автоназначение, закрытие на форуме, продление).
 * exceptMessageId — копия, которую уже обновило нажатие кнопки.
 */
export async function refreshMessage(client, c, exceptMessageId = null) {
  if (!c) return;
  if (mirrorsOf('complaint', c.thread_id).length) return editAll(client, 'complaint', c.thread_id, messagePayload(c), exceptMessageId);
  // карточки, опубликованные до синхронизации серверов, — одна копия в первом канале
  const chId = complaintChannels()[0];
  if (!chId || !c.message_id || c.message_id === exceptMessageId) return;
  try {
    const ch = await client.channels.fetch(chId);
    await (await ch.messages.fetch(c.message_id)).edit(messagePayload(c));
  } catch { /* сообщение удалено */ }
}

/* ---------- обработчики ---------- */
const canAct = (i, c) => i.user.id === c.assignee_id || isLeader(i);
/** Назначать жалобы: роли с правом «Распределение жалоб» и руководство */
const canAssign = (i) => can(i, 'assign') || isLeader(i);
const isResponsible = (i) => !!db.prepare('SELECT 1 FROM deadline_responsible WHERE user_id=?').get(i.user.id);
/** Контроль дедлайнов (продление, закрытие просроченных): руководство, «Мониторинг и дедлайны», ответственные */
const canControl = (i) => isLeader(i) || can(i, 'monitor') || isResponsible(i);
const deny = (i) => i.reply({ content: '⛔ Это действие доступно исполнителю жалобы и руководству.', ...EPH });
/** Переназначать — только старший состав от ЗГП: право «Распределение жалоб» (и «Полный доступ» у ГП) */
const canReassign = (i) => can(i, 'assign');
const denyReassign = (i) => i.reply({ content: '⛔ Нет прав: переназначать жалобы может руководство (от ЗГП).', ...EPH });

/** Действия, которые меняют жалобу: после них правим копии карточки на других серверах */
const CHANGES = new Set(['sel', 'auto', 'acc', 'rs', 'cm', 'xm']);

export async function handleComponent(client, i) {
  const [, action, tid] = i.customId.split(':');
  await handleComplaint(client, i);
  if (CHANGES.has(action)) await refreshMessage(client, getComplaint(Number(tid)), i.message?.id).catch(() => {});
}

async function handleComplaint(client, i) {
  const [, action, tid, arg] = i.customId.split(':');
  const c = getComplaint(Number(tid));
  if (!c) return i.reply({ content: 'Жалоба не найдена.', ...EPH });

  // --- выбор исполнителя для новой жалобы ---
  if (['sel', 'auto', 'pg', 'ref'].includes(action)) {
    if (c.assignee_id || c.status === 'closed') return i.update(messagePayload(c));
    if (action === 'pg' || action === 'ref') return i.update(messagePayload(c, Number(arg)));
    if (!canAssign(i)) {
      return i.reply({ content: '⛔ Назначать жалобы могут только роли с доступом «Распределение жалоб». Его выдаёт руководство: /access.', ...EPH });
    }
    if (c.restricted && !isSenior(i)) {
      return i.reply({ content: '🔒 Жалобу на руководство назначает только старший состав.', ...EPH });
    }
    const userId = action === 'sel' ? i.values[0] : pickAuto(c);
    if (!userId) {
      return i.reply({
        content: c.restricted
          ? '🔒 Нет доступных представителей старшего состава. Выдайте роли право «Старший состав» в `/access panel`.'
          : 'Нет доступных прокуроров. Выдайте роли право «Прокурор» в `/access panel`.',
        ...EPH,
      });
    }
    const why = ineligible(c, userId);
    if (why) return i.reply({ content: why, ...EPH });
    return i.update(messagePayload(assign(client, c, userId)));
  }

  // --- принять ---
  if (action === 'acc') {
    // принять может только тот, кому жалоба назначена
    if (i.user.id !== c.assignee_id) return i.reply({ content: '⛔ Нет прав: принять жалобу может только назначенный исполнитель.', ...EPH });
    if (c.status !== 'assigned') return i.update(messagePayload(c));
    db.prepare(`UPDATE complaints SET status='accepted', accepted_ts=? WHERE thread_id=?`).run(nowTs(), c.thread_id);
    return i.update(messagePayload(getComplaint(c.thread_id)));
  }

  // --- переназначить ---
  // список выбора появляется прямо под жалобой вместо её кнопок; «Отмена» возвращает кнопки
  const reassignRows = (page) => pickerRows(c.thread_id, page, 'c:rs', 'c:rp',
    [new ButtonBuilder().setCustomId(`c:rx:${c.thread_id}`).setLabel('Отмена').setStyle(ButtonStyle.Danger)], c, true);
  if (action === 're') {
    if (!canReassign(i)) return denyReassign(i);
    if (c.status === 'closed') return i.update(messagePayload(c));
    return i.update({ components: reassignRows(0) });
  }
  if (action === 'rp') {
    if (!canReassign(i)) return denyReassign(i);
    return i.update({ components: reassignRows(Number(arg)) });
  }
  if (action === 'rx') {
    if (!canReassign(i)) return denyReassign(i);
    return i.update(messagePayload(c));
  }
  if (action === 'rs') {
    if (!canReassign(i)) return denyReassign(i); // повторная проверка: не доверяем одному лишь показу списка
    if (c.status === 'closed') return i.update(messagePayload(c));
    // «Автоматически» — наименее загруженный подходящий прокурор, кроме текущего исполнителя
    const target = i.values[0] === 'auto' ? pickAuto(c, [c.assignee_id]) : i.values[0];
    if (!target) return i.reply({ content: 'Нет других подходящих прокуроров для этой жалобы.', ...EPH });
    const why = ineligible(c, target);
    if (why) return i.reply({ content: why, ...EPH });
    // карточка меняется на месте; новому исполнителю уходит ЛС о назначении
    const f = assign(client, c, target, i.values[0] === 'auto');
    if (i.message?.id === c.message_id) return i.update(messagePayload(f));
    await i.update({ content: `✅ Жалоба переназначена на <@${f.assignee_id}>.`, components: [] }); // старый личный список
    await refreshMessage(client, f);
    return;
  }

  // --- закрыть ---
  if (action === 'cl') {
    if (!canAct(i, c) && !canControl(i)) return deny(i);
    if (c.status === 'closed') return i.reply({ content: 'Жалоба уже закрыта.', ...EPH });
    return i.showModal(new ModalBuilder().setCustomId(`c:cm:${c.thread_id}`).setTitle('Закрытие жалобы').addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('link').setLabel('Ссылка на ответ').setStyle(TextInputStyle.Short)
          .setPlaceholder('https://forum.gta5rp.com/threads/...').setRequired(true).setMaxLength(300)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('result').setLabel('Статус (удовлетворена / отклонена)')
          .setStyle(TextInputStyle.Short).setValue('удовлетворена').setRequired(true).setMaxLength(30))));
  }
  if (action === 'cm') {
    if (!canAct(i, c) && !canControl(i)) return deny(i);
    if (c.status === 'closed') return i.reply({ content: 'Жалоба уже закрыта.', ...EPH });
    const link = i.fields.getTextInputValue('link').trim();
    const raw = i.fields.getTextInputValue('result').trim().toLowerCase();
    if (!/^https?:\/\/forum\.gta5rp\.com\/threads\//i.test(link)) {
      return i.reply({ content: 'Ссылка должна вести на тему форума: https://forum.gta5rp.com/threads/...', ...EPH });
    }
    const result = raw.startsWith('удовл') ? 'satisfied' : raw.startsWith('откл') ? 'rejected' : null;
    if (!result) return i.reply({ content: 'Статус: «удовлетворена» или «отклонена».', ...EPH });
    db.prepare(`UPDATE complaints SET status='closed', result=?, close_url=?, closed_ts=? WHERE thread_id=?`)
      .run(result, link, nowTs(), c.thread_id);
    const f = getComplaint(c.thread_id);
    if (i.isFromMessage() && isAlertMessage(i.message.id)) {
      // закрыли из канала просрочек: отвечаем там, карточку жалобы обновляем отдельно
      await i.reply({ content: `✅ Жалоба №${f.number ?? '?'} закрыта.`, ...EPH });
      await refreshMessage(client, f);
    } else {
      await (i.isFromMessage() ? i.update(messagePayload(f)) : i.reply({ ...messagePayload(f), ...EPH }));
    }
    await resolveAlerts(client, f, closedText(i.user.id));
    return;
  }

  // --- инфо и продление дедлайнов ---
  if (action === 'inf') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`c:det:${c.thread_id}`).setLabel('Краткое содержание').setEmoji('📄').setStyle(ButtonStyle.Secondary));
    return i.reply({ embeds: [infoEmbed(c)], components: [row], ...EPH });
  }
  // «Краткое содержание» (кнопка в «Инфо»): суть жалобы и требования заявителя из первого сообщения темы.
  // Дописывается в то же сообщение «Инфо» — оно и остаётся там же, под карточкой, где нажали «Инфо».
  if (action === 'det') {
    await i.deferUpdate();
    const info = EmbedBuilder.from(infoEmbed(c).toJSON()).setThumbnail('attachment://logo.webp');
    const text = await fetchFirstPost(c.url).catch(() => null);
    if (!text) return i.followUp({ content: '⚠️ Не удалось открыть тему жалобы на форуме. Попробуйте позже.', ...EPH });
    const r = await analyzeText(text, 'complaint', i.user.id, { paid: await mayUseAI(client, i) });
    const summary = resultEmbed({ title: `Жалоба №${c.number ?? '—'}`, url: c.url, typeLabel: 'Краткое содержание', ...r });
    return i.editReply({ embeds: [info, summary], components: [], __noLogo: true });
  }
  if (action === 'xr' || action === 'xc') {
    if (!canControl(i)) return i.reply({ content: '⛔ Продлевать дедлайны может руководство.', ...EPH });
    if (c.status === 'closed') return i.reply({ content: 'Жалоба уже закрыта.', ...EPH });
    return i.showModal(new ModalBuilder().setCustomId(`c:xm:${c.thread_id}:${action}`)
      .setTitle('Продление дедлайна').addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('hours').setLabel('Продлить на (часов)').setPlaceholder('Например: 12')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3))));
  }
  if (action === 'xm') {
    if (!canControl(i)) return i.reply({ content: '⛔ Продлевать дедлайны может руководство.', ...EPH });
    const h = Number(i.fields.getTextInputValue('hours'));
    if (!Number.isInteger(h) || h < 1 || h > 168) return i.reply({ content: 'Укажите целое число часов от 1 до 168.', ...EPH });
    const col = arg === 'xr' ? 'respond_by' : 'close_by';
    const flag = arg === 'xr' ? 'notified_respond' : 'notified_close';
    // уже просроченный срок продлеваем от текущего момента — иначе он сразу снова окажется просроченным
    db.prepare(`UPDATE complaints SET ${col}=MAX(${col}, ?)+?, ${flag}=0, last_nag_ts=NULL WHERE thread_id=?`).run(nowTs(), h * 3600, c.thread_id);
    const f = getComplaint(c.thread_id);
    await i.reply({ content: `✅ Дедлайн продлён на ${h} ч. Новый срок: ${msk(f[col])}.`, ...EPH });
    await refreshMessage(client, f);
    await resolveAlerts(client, f, extendedText(i.user.id, h, f[col]), arg === 'xr' ? 'respond' : 'close');
    return;
  }
}

/* ---------- опрос форума ---------- */
async function postComplaint(client, t) {
  const dup = t.number && db.prepare('SELECT 1 FROM complaints WHERE number=?').get(t.number) ? 1 : 0;
  // пункты жалобы: «Сведения о нарушителе» → уровень жалобы, «Сведения о заявителе» → имя заявителя
  const { violator, applicant } = await fetchComplaintDetails(t.url)
    .catch((e) => { console.error('complaint details:', e.message); return {}; });
  const restricted = isRestricted(violator) ? 1 : 0;
  db.prepare(`INSERT INTO complaints(thread_id,number,title,author,url,created_ts,duplicate,posted_ts,replies,violator,restricted,applicant)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t.id, t.number, t.title, t.author, t.url, t.createdTs, dup, nowTs(), t.replies, violator ?? null, restricted,
      applicant ?? applicantFromTitle(t.title));
  if (restricted) for (const g of client.guilds.cache.values()) await refreshSeniorFlags(g).catch(() => {});
  // автоназначение «сразу» — карточка выходит уже с исполнителем (настраивается в /settings)
  if (conf.autoAssignSec() === 0) {
    const uid = pickAuto(getComplaint(t.id));
    if (uid) assign(client, getComplaint(t.id), uid, true);
  }
  // во все каналы «Жалобы»; упоминание старшего состава — ролями того сервера, куда уходит копия
  const sent = await sendAll(client, complaintChannels(), (ch) => {
    const payload = messagePayload(getComplaint(t.id));
    const ping = restricted ? pingIn(ch, roleIdsWith('senior')) : '';
    if (ping) payload.content = `🔒 ${ping}` + (payload.content ? `\n${payload.content}` : '');
    return payload;
  }, { kind: 'complaint', ref: t.id });
  if (sent[0]) db.prepare('UPDATE complaints SET message_id=? WHERE thread_id=?').run(sent[0].id, t.id);
}

/** При первом запуске свежие жалобы без ответа (моложе срока ответа) всё равно публикуются */
const SEED_RECENT_H = Number(process.env.SEED_RECENT_HOURS ?? 12);

/** Сколько страниц раздела максимум листать, догоняя жалобы после простоя (~20 тем на странице) */
const CATCHUP_PAGES = 10;

/**
 * Жалобы старше этой отметки бот не публикует сам (они были до его первого запуска).
 * Для баз, созданных до появления отметки, — самая свежая из «старых» жалоб.
 */
function baselineTs() {
  const v = getSetting('baseline_ts');
  if (v) return Number(v);
  const b = db.prepare(`SELECT MAX(created_ts) ts FROM complaints WHERE status='old'`).get().ts ?? 0;
  setSetting('baseline_ts', String(b));
  return b;
}

/**
 * Темы с форума, начиная с первой страницы. Раздел отсортирован по дате создания, поэтому после простоя
 * листаем дальше, пока не дойдём до тем, созданных до последней успешной проверки.
 */
async function fetchSince(forumUrl, since) {
  const all = [];
  for (let p = 1; p <= CATCHUP_PAGES; p++) {
    const page = await fetchPage(forumUrl, p);
    // за последней страницей форум снова отдаёт последнюю — значит, дальше листать некуда
    if (!page.length || page.every((t) => all.some((x) => x.id === t.id))) break;
    all.push(...page);
    if (!since || Math.min(...page.map((t) => t.createdTs)) <= since) break;
  }
  return uniqueThreads(all);
}

let running = false;
/** Один проход опроса. Возвращает число новых жалоб. */
export async function poll(client, forumUrl) {
  if (running) return 0;
  running = true;
  try {
    const started = nowTs();
    const since = Number(getSetting('last_poll_ts') || 0);
    const threads = await fetchSince(forumUrl, since);

    // Первый запуск: старые и уже обработанные темы запоминаем, но не рассылаем
    if (getSetting('seeded') !== '1') {
      const ins = db.prepare(`INSERT OR IGNORE INTO complaints(thread_id,number,title,author,url,created_ts,status)
                              VALUES(?,?,?,?,?,?,'old')`);
      const border = started - SEED_RECENT_H * 3600;
      for (const t of threads) {
        if (t.locked || t.replies > 0 || t.createdTs < border) ins.run(t.id, t.number, t.title, t.author, t.url, t.createdTs);
      }
      setSetting('baseline_ts', String(border));
      setSetting('seeded', '1');
    }

    if (!complaintChannels().length) return 0; // канал не настроен — отметку не двигаем, после /setup жалобы догонятся
    const known = db.prepare('SELECT 1 FROM complaints WHERE thread_id=?');
    const base = baselineTs();
    const fresh = threads.filter((t) => !t.locked && t.createdTs > base && !known.get(t.id)).sort((a, b) => a.id - b.id);
    if (fresh.length) {
      for (const t of fresh) await postComplaint(client, t);
      // после простоя запоминаем, что догнали, — это покажет /force_parse
      if (since && started - since > 300) {
        setSetting('last_catchup', JSON.stringify({ ts: started, from: since, numbers: fresh.map((t) => t.number ?? '?') }));
        console.log(`После простоя с ${msk(since)} MSK опубликовано пропущенных жалоб: ${fresh.length}`);
      }
    }
    setSetting('last_poll_ts', String(started));
    return fresh.length;
  } finally {
    running = false;
  }
}

/** Перерисовывает карточки жалоб в работе — после обновления бота они сразу в новом виде */
export async function refreshOpenCards(client) {
  for (const c of db.prepare(`SELECT * FROM complaints WHERE status IN ('new','assigned','accepted') AND message_id IS NOT NULL`).all()) {
    await refreshMessage(client, c).catch(() => {});
  }
}

/** Для уже опубликованных жалоб без имени заявителя: берём его из текста жалобы и обновляем карточки */
export async function backfillApplicants(client) {
  const rows = db.prepare(`SELECT * FROM complaints WHERE applicant IS NULL AND status IN ('new','assigned','accepted','closed')
                           AND message_id IS NOT NULL ORDER BY thread_id DESC LIMIT 50`).all();
  for (const c of rows) {
    const d = await fetchComplaintDetails(c.url).catch(() => ({}));
    const name = d.applicant ?? applicantFromTitle(c.title);
    if (!name) continue;
    db.prepare('UPDATE complaints SET applicant=? WHERE thread_id=?').run(name, c.thread_id);
    await refreshMessage(client, getComplaint(c.thread_id)).catch(() => {});
  }
  return rows.length;
}

/** Последнее «догоняние» после простоя: { ts, from, numbers } или null */
export const lastCatchup = () => {
  try { return JSON.parse(getSetting('last_catchup') || 'null'); } catch { return null; }
};

/**
 * Публикует жалобу по номеру, если бот её пропустил (например, она появилась до первого запуска бота).
 * Ищет на первых 3 страницах раздела. Возвращает текст результата.
 */
export async function publishByNumber(client, forumUrl, number) {
  const chIds = complaintChannels();
  if (!chIds.length) return 'Канал жалоб не настроен: `/setup panel:Жалобы`.';
  const t = (await fetchThreads(forumUrl, 3)).find((x) => x.number === number);
  if (!t) return `Жалоба №${number} не найдена на первых 3 страницах форума.`;
  const row = getComplaint(t.id);
  if (row && row.status !== 'old') return `Жалоба №${number} уже есть в канале жалоб (статус: ${row.status}).`;
  if (t.locked) return `Жалоба №${number} уже закрыта на форуме — публиковать нечего.`;
  while (running) await new Promise((r) => setTimeout(r, 300)); // не пересекаемся с опросом
  running = true;
  try {
    if (row) db.prepare('DELETE FROM complaints WHERE thread_id=?').run(t.id);
    await postComplaint(client, t);
  } finally {
    running = false;
  }
  return `✅ Жалоба №${number} опубликована в ${chIds.map((x) => `<#${x}>`).join(', ')}.`;
}
