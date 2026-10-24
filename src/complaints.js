import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { applicantFromTitle, fetchComplaintDetails, fetchFirstPost, fetchPage, fetchThreads, uniqueThreads } from './forum.js';
import { analyzeText, docWarnings, mayUseAI, resultEmbed } from './analyze.js';
import { can, isLeader, isSenior } from './access.js';
import { accusedIds } from './restricted.js';
import { rankById, rankOfMember, rankOfText, ranks, reviewersOf } from './hierarchy.js';
import { conf } from './config.js';
import { closedText, extendedText, isAlertMessage, resolveAlerts } from './alerts.js';
import { deleteAll, destinations, editAll, mirrorsOf, sendAll } from './mirror.js';
import { C, COLOR, EPH, displayNameOf, listProsecutors, msk, nameAndTag, nowTs, safeText, sendDM, stamp } from './util.js';

/** Дедлайн ответа (нажать «Принять») — через столько часов после подачи жалобы: время первого напоминания (по умолчанию 24) */
export const respondHours = () => conf.reminderHours()[0] ?? 24;
/** Срок ответа: от подачи жалобы на форуме; если назначили уже позже — минимум N часов на то, чтобы принять (/settings → Жалобы) */
export const respondByOf = (c, now = nowTs()) => Math.max((c.created_ts ?? now) + respondHours() * 3600, now + conf.minRespondHours() * 3600);
const PAGE = 25;
const YELLOW = C.warn;
const RESULTS = { satisfied: 'удовлетворена', rejected: 'отклонена' };

export const getComplaint = (id) => db.prepare('SELECT * FROM complaints WHERE thread_id=?').get(id);

/* ---------- embed'ы ---------- */
// Заголовок и автор приходят с публичного форума: экранируем разметку, чтобы в карточку
// нельзя было подсунуть свою ссылку вида [текст](адрес) или сломать оформление
/** Заявитель — имя из текста жалобы (пункт 1), а не аккаунт форума: они часто различаются */
const applicantOf = (c) => c.applicant || applicantFromTitle(c.title) || c.author || '—';
const head = (c) =>
  `**Номер:** №${c.number ?? '?'}\n**Тема:** ${safeText(c.title ?? '')}\n**Заявитель:** ${safeText(applicantOf(c))}\n` +
  `**Ссылка:** [Открыть на форуме](${c.url})`;

/** Пометка дубликата в карточке — строкой в конце, как в оригинале */
const DUP_LINE = '\n\n⚠️ **Дубликат номера жалобы!**';

/** Отдельное предупреждение в канал сразу после карточки дубликата */
export function duplicateEmbed(c) {
  const first = db.prepare('SELECT url FROM complaints WHERE number=? AND thread_id!=? ORDER BY created_ts LIMIT 1').get(c.number, c.thread_id);
  return new EmbedBuilder().setColor(C.danger).setTitle('⚠️ Дубликат номера жалобы!')
    .setDescription(`**Внимание:** Жалоба с номером **№${c.number ?? '?'}** уже была подана ранее!\n\n` +
      `Возможно, заявитель ошибся в нумерации.\nПроверьте форум: [Открыть тему](${first?.url ?? c.url})`)
    .setFooter({ text: stamp(c.created_ts) });
}

/* ---------- иерархия: кто рассматривает жалобу (/settings → Иерархия) ---------- */
/** id должностей, которые рассматривают жалобу; null — жалоба не на сотрудника ОГП, её может вести любой прокурор */
const reviewerRanks = (c) => {
  if (!c?.target_rank || !rankById(c.target_rank)) return null;
  const r = reviewersOf(c.target_rank);
  // на эту должность никто не назначен рассматривать (например, на ГП) — рассматривает высшая должность
  return r.length ? r : [ranks()[0]?.id].filter(Boolean);
};
const fitsRank = (c, rankId) => { const r = reviewerRanks(c); return !r || r.includes(rankId); };
const reviewerNames = (c) => (reviewerRanks(c) ?? []).map((id) => rankById(id)?.name).filter(Boolean);
/** Кому выключено распределение жалоб (/distribution) */
export const assignOff = () => new Set(db.prepare('SELECT user_id FROM assign_off').all().map((r) => r.user_id));
/** «на кого»: ЗГП → ЗГП, Прокурор → прокурора, Первый ЗГП → первого ЗГП, Помощник прокурора → помощника прокурора */
const whom = (name) => name.split(' ').map((w) => {
  if (/^[А-ЯЁA-Z]{2,}$/.test(w)) return w; // сокращение
  const low = w.toLowerCase();
  if (/ый$|ой$/.test(low)) return low.replace(/(ый|ой)$/, 'ого');
  if (/ий$/.test(low)) return low.replace(/ий$/, /[гкх]ий$/.test(low) ? 'ого' : 'его');
  if (/ь$/.test(low)) return low.replace(/ь$/, 'я');
  return /[бвгджзклмнпрстфхцчшщ]$/.test(low) ? `${low}а` : low;
}).join(' ');
/** «🔒 Жалоба на ЗГП» */
function targetLine(c) {
  const t = c?.target_rank ? rankById(c.target_rank) : null;
  return t ? `\n\n🔒 **Жалоба на ${whom(t.name)}**` : '';
}
/**
 * Должность нарушителя: сотрудник ОГП, которого назвали в жалобе по нику (его должность из базы),
 * иначе должность из текста «Сведения о нарушителе» («ЗГП Иванов», «прокурор Travis Coils»).
 */
export function targetRankOf(violator) {
  if (!violator) return null;
  const named = accusedIds(violator).map((id) => rankById(db.prepare('SELECT rank_id FROM prosecutors WHERE user_id=?').get(id)?.rank_id))
    .filter(Boolean).sort((x, y) => x.sort - y.sort);
  return named[0]?.id ?? rankOfText(violator)?.id ?? null;
}

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
  const e = new EmbedBuilder().setDescription(head(c) + targetLine(c) + (c.duplicate ? DUP_LINE : ''));
  if (c.status === 'closed') return closedEmbed(c);
  if (!c.assignee_id) {
    e.setColor(C.brand).setTitle(`🔔 Жалоба №${c.number ?? '?'}`).setFooter({ text: stamp(c.created_ts) });
    return e;
  }
  const accepted = c.status === 'accepted';
  e.setColor(YELLOW).setTitle(`${accepted ? '🟡' : '📋'} Жалоба №${c.number ?? '?'}`)
    .setFooter({ text: stamp(accepted ? c.accepted_ts : c.assigned_ts) });
  e.addFields(
    { name: '📌 Назначено', value: displayNameOf(c.assignee_id) ? safeText(displayNameOf(c.assignee_id)) : `<@${c.assignee_id}>`, inline: true },
    { name: '⏰ Дедлайн', value: msk(c.close_by), inline: true }); // 72 ч с момента подачи жалобы на форуме
  return e;
}

const STATUS_TEXT = { new: 'Новая', assigned: 'Назначена', accepted: 'В работе', closed: 'Закрыта', old: 'Архив' };

/** Статус в «Инфо» — значок по состоянию, как в оригинале («🟡 В работе») */
const STATUS_ICON = { new: '🔔', assigned: '📋', accepted: '🟡', old: '📦' };
const statusLine = (c) => (c.status === 'closed'
  ? `${{ satisfied: '🟢', rejected: '🔴' }[c.result] ?? '⚪'} ${c.result ? `Закрыта (${RESULTS[c.result]})` : 'Закрыта'}`
  : `${STATUS_ICON[c.status] ?? '•'} ${STATUS_TEXT[c.status] ?? c.status}`);

/** «Инфо» — один в один с оригиналом: по три поля в ряд, дедлайны ответа и закрытия рядом */
export function infoEmbed(c) {
  const who = nameAndTag(c.assignee_id); // «Gora💢 (@Gora💢)»
  const e = new EmbedBuilder().setColor(C.details).setTitle(`ℹ️ Жалоба №${c.number ?? '?'}`)
    .setDescription(`**${safeText(c.title ?? '')}**`)
    .addFields(
      { name: 'Заявитель', value: safeText(applicantOf(c)), inline: true },
      { name: 'Статус', value: statusLine(c), inline: true },
      { name: 'Исполнитель', value: who, inline: true },
      { name: 'Создана', value: msk(c.created_ts), inline: true },
      { name: 'Назначена', value: c.assigned_ts ? msk(c.assigned_ts) : '—', inline: true },
      { name: 'Ответ на форуме', value: c.replies > 0 ? '✅ Да' : '❌ Нет', inline: true },
      { name: 'Дедлайн ответа', value: c.respond_by && c.status !== 'new' ? msk(c.respond_by) : '—', inline: true },
      { name: 'Дедлайн закрытия', value: c.close_by ? msk(c.close_by) : '—', inline: true },
      { name: 'Закрыта', value: c.closed_ts ? msk(c.closed_ts) : '—', inline: true },
      { name: 'Ссылка', value: `[Открыть на форуме](${c.url})` + (c.close_url ? `\n[Ответ прокурора](${c.close_url})` : '') });
  if (c.duplicate) e.addFields({ name: '⚠️', value: 'Возможный дубликат' });
  if (targetLine(c)) e.addFields({ name: '🔒', value: targetLine(c).trim().replace(/\*\*/g, '').replace(/^🔒 /, '') });
  return e.setFooter({ text: stamp() });
}

/* ---------- компоненты ---------- */
/**
 * Кого можно назначить на жалобу c: по иерархии (жалобу на ЗГП — Первый ЗГП и ГП и т.д.), никогда — обвиняемого
 * и тех, кому распределение выключено (/distribution off)
 */
const candidatesOf = (c) => listProsecutors({ exclude: [...accusedIds(c?.violator), ...offFor(c)] })
  .filter((p) => fitsRank(c, p.rank_id));
/**
 * Кому из «распределение выключено» эту жалобу всё же можно дать: если её больше некому рассматривать
 * (жалоба на Первого ЗГП — только ГП, а ГП выключил себе распределение), выключение не действует.
 */
function offFor(c) {
  const off = assignOff();
  if (!off.size) return off;
  const accused = new Set(accusedIds(c?.violator));
  const others = listProsecutors().some((p) => !off.has(p.user_id) && !accused.has(p.user_id) && fitsRank(c, p.rank_id));
  return others ? off : new Set();
}

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
          // должность по ролям (СГП, ЗГП, Прокурор…), как в оригинале — под именем
          description: `${p.position ?? (p.senior ? 'Старший состав' : 'Прокурор')} • в работе: ${load.get(p.user_id) ?? 0}`,
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

// как в оригинале: список, под ним «Назад / Вперёд / Авто», и ниже отдельной строкой «Обновить список»
const unassignedRows = (c, page = 0) => [
  ...pickerRows(c.thread_id, page, 'c:sel', 'c:pg', [
    new ButtonBuilder().setCustomId(`c:auto:${c.thread_id}`).setLabel('🎲 Авто').setStyle(ButtonStyle.Primary),
  ], c),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:ref:${c.thread_id}:${page}`).setLabel('🔄 Обновить список').setStyle(ButtonStyle.Secondary)),
];

function actionRows(c) {
  const accepted = c.status === 'accepted';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:acc:${c.thread_id}`).setLabel(accepted ? 'В работе' : 'Принять')
      .setEmoji('✅').setStyle(accepted ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(accepted),
    new ButtonBuilder().setCustomId(`c:re:${c.thread_id}`).setLabel('Переназначить').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`c:cl:${c.thread_id}`).setLabel('Закрыть').setEmoji('📝').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`c:inf:${c.thread_id}`).setLabel('Инфо').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary))];
}

/** Полное содержимое сообщения жалобы в канале для её текущего состояния. */
export function messagePayload(c, page = 0) {
  const embeds = [complaintEmbed(c)];
  if (c.status === 'closed') return { content: '', embeds, components: [] };
  if (!c.assignee_id) return { content: '', embeds, components: unassignedRows(c, page) };
  return { content: c.status === 'accepted' ? '' : `📋 <@${c.assignee_id}>, вам назначена жалоба!`, embeds, components: actionRows(c) };
}

/* ---------- назначение ---------- */
/** Дедлайн закрытия: 72 ч с момента подачи жалобы на форуме */
const deadlineOf = (c) => (c.created_ts ?? nowTs()) + conf.deadlineHours() * 3600;

/** Назначить жалобу (сбрасывает принятие и просрочки). ЛС исполнителю уходит в фоне. */
export function assign(client, c, userId, auto = false) {
  const now = nowTs();
  db.prepare(`UPDATE complaints SET assignee_id=?, status='assigned', assigned_ts=?, accepted_ts=NULL,
              respond_by=?, close_by=?, notified_respond=0, notified_close=0, remind_stage=0, last_nag_ts=NULL
              WHERE thread_id=?`)
    // срок считается от подачи жалобы на форуме, а не от назначения; при переназначении не сбрасывается
    .run(userId, now, respondByOf(c, now), c.close_by ?? deadlineOf(c), c.thread_id);
  const f = getComplaint(c.thread_id);
  // прежнему исполнителю — его ЛС «Вам назначена жалоба» меняется на «🔄 Жалоба переназначена»;
  // если то ЛС бот не знает (отправлено до обновления или удалено) — пишет новое
  if (c.assignee_id && c.assignee_id !== userId) {
    const payload = { embeds: [new EmbedBuilder().setColor(C.muted).setTitle('🔄 Жалоба переназначена')
      .setDescription(`${head(c)}\n\n**Новый исполнитель:** ${nameAndTag(userId)}`).setFooter({ text: stamp(now) })] };
    (async () => {
      const ch = c.dm_message_id ? await client.channels.fetch(c.dm_channel_id).catch(() => null) : null;
      const msg = ch ? await ch.messages.fetch(c.dm_message_id).catch(() => null) : null;
      if (!msg || !(await msg.edit(payload).then(() => true, () => false))) await sendDM(client, c.assignee_id, payload);
    })().catch((e) => console.error(`ЛС «переназначена» по жалобе №${c.number}: ${e.message}`));
  }
  sendDM(client, userId, {
    embeds: [
      new EmbedBuilder().setColor(COLOR)
        .setTitle(auto ? '📋 Вам автоматически назначена жалоба' : '📋 Вам назначена жалоба')
        .setDescription(`${head(f)}\n\n⏰ **Дедлайн ответа:** ${msk(f.respond_by)}\n⏰ **Дедлайн закрытия:** ${msk(f.close_by)}`)
        .setFooter({ text: stamp(now) }),
    ],
  }).then((m) => m && db.prepare('UPDATE complaints SET dm_channel_id=?, dm_message_id=? WHERE thread_id=? AND assignee_id=?')
    .run(m.channelId, m.id, c.thread_id, userId));
  return f;
}

/** Наименее загруженный подходящий прокурор (не в отпуске, не обвиняемый, для жалоб на руководство — старший состав) */
export function pickAuto(c = null, exclude = []) {
  const n = nowTs();
  const skip = new Set([...accusedIds(c?.violator), ...exclude, ...offFor(c)]);
  const rows = db.prepare(`
    SELECT p.user_id, p.senior, p.rank_id FROM prosecutors p
    WHERE p.on_leave=0 -- роль «Отпуск», выданная вручную, тоже считается отпуском
      AND NOT EXISTS (SELECT 1 FROM vacations v WHERE v.user_id=p.user_id AND v.status='approved'
                      AND v.start_ts<=? AND v.end_ts>=?)
    -- старший состав — в последнюю очередь: сначала прокуроры, и только если подходящих нет — СС
    ORDER BY p.senior,
             (SELECT COUNT(*) FROM complaints c WHERE c.assignee_id=p.user_id AND c.status IN ('assigned','accepted')),
             RANDOM()`).all(n, n);
  return rows.find((p) => !skip.has(p.user_id) && fitsRank(c, p.rank_id))?.user_id;
}

/** null — можно назначать; иначе причина отказа */
function ineligible(c, userId) {
  if (accusedIds(c.violator).includes(userId)) return 'Нельзя назначить жалобу на самого обвиняемого.';
  if (offFor(c).has(userId)) return '⏸ Этому сотруднику распределение жалоб выключено.';
  if (!fitsRank(c, db.prepare('SELECT rank_id FROM prosecutors WHERE user_id=?').get(userId)?.rank_id)) {
    return `🔒 Эту жалобу рассматривают: ${reviewerNames(c).join(', ') || '—'}.`;
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

/* ---------- переназначение: старая карточка удаляется, новая — отдельным сообщением ---------- */
/** Карточка жалобы в канале (копия на любом сервере), а не личный список выбора */
const isComplaintCard = (messageId, c) => !!messageId && (messageId === c.message_id
  || mirrorsOf('complaint', c.thread_id).some((m) => m.message_id === messageId));
/** Новая карточка жалобы во все каналы «Жалобы»; дальше бот правит уже её */
async function repostCard(client, f) {
  const sent = await sendAll(client, complaintChannels(), messagePayload(f), { kind: 'complaint', ref: f.thread_id });
  if (sent[0]) db.prepare('UPDATE complaints SET message_id=? WHERE thread_id=?').run(sent[0].id, f.thread_id);
}

/* ---------- обработчики ---------- */
const canAct = (i, c) => i.user.id === c.assignee_id || isLeader(i);
/** Назначать жалобы: роли с правом «Распределение жалоб» и руководство */
const canAssign = (i) => can(i, 'assign') || isLeader(i);
const isResponsible = (i) => !!db.prepare('SELECT 1 FROM deadline_responsible WHERE user_id=?').get(i.user.id);
/** Контроль дедлайнов (продление, закрытие просроченных): руководство, «Мониторинг и дедлайны», ответственные */
const canControl = (i) => isLeader(i) || isSenior(i) || can(i, 'monitor') || isResponsible(i);

/** Кнопки продления дедлайнов в «Инфо» — только старшему составу и только у открытой жалобы */
const extendRows = (i, c) => (isSenior(i) && c.status !== 'closed' ? [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`c:xr:${c.thread_id}`).setLabel('Продлить дедлайн ответа').setEmoji('⏰').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`c:xc:${c.thread_id}`).setLabel('Продлить дедлайн закрытия').setEmoji('⏰').setStyle(ButtonStyle.Secondary))] : []);
const deny = (i) => i.reply({ content: '⛔ Это действие доступно исполнителю жалобы и руководству.', ...EPH });
/** Переназначать — только старший состав от ЗГП: право «Распределение жалоб» (и «Полный доступ» у ГП) */
const canReassign = (i) => can(i, 'assign');
const denyReassign = (i) => i.reply({ content: '⛔ Нет прав: переназначать жалобы может руководство (от ЗГП).', ...EPH });

/** Действия, которые меняют жалобу: после них правим копии карточки на других серверах */
// rs (переназначение) сам рассылает новую карточку
const CHANGES = new Set(['sel', 'auto', 'acc', 'cm', 'xm']);

export async function handleComponent(client, i) {
  const [, action, tid] = i.customId.split(':');
  await handleComplaint(client, i);
  if (CHANGES.has(action)) await refreshMessage(client, getComplaint(Number(tid)), i.message?.id).catch(() => {});
}

/**
 * Нажали «Закрыть» / «Продлить» у уже закрытой жалобы. На карточке в канале просрочек — сразу показываем итог
 * («🟢 Жалоба №… — Удовлетворена»), убирая кнопки: так устаревшая карточка чинится сама, даже если бот не смог
 * обновить её раньше (например, не было доступа к каналу). В остальных местах — короткий ответ.
 */
function alreadyClosed(i, c) {
  if (i.isFromMessage?.() && i.message && isAlertMessage(i.message.id)) {
    return i.update({ embeds: [complaintEmbed(c)], components: [] });
  }
  return i.reply({ content: 'Жалоба уже закрыта.', ...EPH });
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
      return i.reply({ content: '⛔ Нет прав: назначать жалобы может руководство.', ...EPH });
    }
    // жалобу на сотрудника ОГП назначают те, кто её рассматривает по иерархии (и ГП с полным доступом)
    if (reviewerRanks(c) && !can(i, 'full') && !fitsRank(c, rankOfMember(i.member)?.id)) {
      return i.reply({ content: `🔒 Назначать эту жалобу могут: ${reviewerNames(c).join(', ')}.`, ...EPH });
    }
    const userId = action === 'sel' ? i.values[0] : pickAuto(c);
    if (!userId) {
      return i.reply({
        content: reviewerRanks(c)
          ? `🔒 Нет доступных сотрудников, которые рассматривают эту жалобу (${reviewerNames(c).join(', ')}).`
          : 'Нет доступных прокуроров.',
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
    // переназначение — в канале только новое сообщение «📋 @новый, вам назначена жалоба!» (с уведомлением),
    // старая карточка удаляется; прежнему исполнителю меняется его ЛС (см. assign)
    const f = assign(client, c, target, i.values[0] === 'auto');
    const onCard = isComplaintCard(i.message?.id, c);
    await (onCard ? i.deferUpdate() : i.update({ content: `✅ Жалоба переназначена на <@${f.assignee_id}>.`, embeds: [], components: [] }));
    await deleteAll(client, 'complaint', c.thread_id);
    if (c.message_id) { // карточка, отправленная до синхронизации серверов
      const ch = await client.channels.fetch(complaintChannels()[0]).catch(() => null);
      await ch?.messages.delete(c.message_id).catch(() => {});
    }
    await repostCard(client, f);
    return;
  }

  // --- закрыть ---
  if (action === 'cl') {
    if (!canAct(i, c) && !canControl(i)) return deny(i);
    if (c.status === 'closed') return alreadyClosed(i, c);
    // статус — выбором из списка, а не текстом: опечатка («отказано», «не удовл») больше не срывает закрытие
    return i.showModal(new ModalBuilder().setCustomId(`c:cm:${c.thread_id}`).setTitle('Закрытие жалобы').addLabelComponents(
      new LabelBuilder().setLabel('Ссылка на ответ').setTextInputComponent(
        new TextInputBuilder().setCustomId('link').setStyle(TextInputStyle.Short)
          .setPlaceholder('https://forum.gta5rp.com/threads/...').setRequired(true).setMaxLength(300)),
      new LabelBuilder().setLabel('Статус').setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId('result').setPlaceholder('Выберите статус').addOptions(
          { label: 'Удовлетворена', value: 'satisfied', emoji: '🟢' },
          { label: 'Отклонена', value: 'rejected', emoji: '🔴' }))));
  }
  if (action === 'cm') {
    if (!canAct(i, c) && !canControl(i)) return deny(i);
    if (c.status === 'closed') return alreadyClosed(i, c);
    const link = i.fields.getTextInputValue('link').trim();
    // любая ссылка на форум: тема, сообщение (/threads/…/post-…, /posts/…), goto
    if (!/^https?:\/\/(www\.)?forum\.gta5rp\.com\/\S+/i.test(link)) {
      console.warn(`Жалоба №${c.number} не закрыта: ссылка не на форум (${link.slice(0, 80)})`);
      return i.reply({ content: 'Ссылка должна вести на форум: https://forum.gta5rp.com/threads/...', ...EPH });
    }
    // новый вид формы — выбор из списка; старая форма (открыта до обновления) — текст
    let result = null;
    try { result = i.fields.getStringSelectValues('result')[0] ?? null; } catch { /* старая форма */ }
    if (!result) {
      const raw = (() => { try { return i.fields.getTextInputValue('result'); } catch { return ''; } })().trim().toLowerCase();
      result = /^(не\s*удовл|откл|отказ)/.test(raw) ? 'rejected' : /^удовл/.test(raw) ? 'satisfied' : null;
    }
    if (!['satisfied', 'rejected'].includes(result)) result = null;
    if (!result) return i.reply({ content: 'Статус: «удовлетворена» или «отклонена».', ...EPH });
    db.prepare(`UPDATE complaints SET status='closed', result=?, close_url=?, closed_ts=? WHERE thread_id=?`)
      .run(result, link, nowTs(), c.thread_id);
    const f = getComplaint(c.thread_id);
    if (i.isFromMessage() && isAlertMessage(i.message.id)) {
      // закрыли из канала просрочек: без отдельного ответа — сама карточка просрочки станет карточкой закрытой жалобы
      await i.deferUpdate();
      await refreshMessage(client, f);
    } else {
      await (i.isFromMessage() ? i.update(messagePayload(f)) : i.reply({ ...messagePayload(f), ...EPH }));
    }
    await resolveAlerts(client, f, closedText(i.user.id), null, complaintEmbed(f));
    return;
  }

  // --- инфо и продление дедлайнов ---
  if (action === 'inf') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`c:det:${c.thread_id}`).setLabel('Краткое содержание').setEmoji('📄').setStyle(ButtonStyle.Secondary));
    return i.reply({ embeds: [infoEmbed(c)], components: [...extendRows(i, c), row], ...EPH });
  }
  // «Краткое содержание» (кнопка в «Инфо»): суть жалобы и требования заявителя из первого сообщения темы.
  // Дописывается в то же сообщение «Инфо» — оно и остаётся там же, под карточкой, где нажали «Инфо».
  if (action === 'det') {
    await i.deferUpdate();
    const info = EmbedBuilder.from(infoEmbed(c).toJSON()).setThumbnail('attachment://logo.webp');
    const text = await fetchFirstPost(c.url).catch(() => null);
    if (!text) return i.followUp({ content: '⚠️ Не удалось открыть тему жалобы на форуме. Попробуйте позже.', ...EPH });
    const r = await analyzeText(text, 'complaint', i.user.id, { paid: await mayUseAI(client, i) });
    const summary = resultEmbed({ title: `Жалоба №${c.number ?? '—'}`, url: c.url, typeLabel: 'Краткое содержание', ...r, warnings: docWarnings(text) });
    return i.editReply({ embeds: [info, summary], components: extendRows(i, c), __noLogo: true });
  }
  if (action === 'xr' || action === 'xc') {
    if (!canControl(i)) return i.reply({ content: '⛔ Продлевать дедлайны может руководство.', ...EPH });
    if (c.status === 'closed') return alreadyClosed(i, c);
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
  // на кого жалоба по иерархии: ЗГП, прокурор… — тогда её получают только те, кто рассматривает эту должность
  const target = targetRankOf(violator);
  const restricted = target ? 1 : 0;
  db.prepare(`INSERT INTO complaints(thread_id,number,title,author,url,created_ts,duplicate,posted_ts,replies,violator,restricted,applicant,target_rank)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t.id, t.number, t.title, t.author, t.url, t.createdTs, dup, nowTs(), t.replies, violator ?? null, restricted,
      applicant ?? applicantFromTitle(t.title), target);
  // автоназначение «сразу» — карточка выходит уже с исполнителем (настраивается в /settings)
  if (conf.autoAssignSec() === 0) {
    const uid = pickAuto(getComplaint(t.id));
    if (uid) assign(client, getComplaint(t.id), uid, true);
  }
  // во все каналы «Жалобы»; упоминается только назначенный исполнитель (в тексте карточки), без ролей
  const sent = await sendAll(client, complaintChannels(), () => messagePayload(getComplaint(t.id)), { kind: 'complaint', ref: t.id });
  if (sent[0]) db.prepare('UPDATE complaints SET message_id=? WHERE thread_id=?').run(sent[0].id, t.id);
  // дубликат номера — следом отдельное предупреждение, туда же, куда ушла карточка
  if (dup) await sendAll(client, sent.map((m) => m.channelId), { embeds: [duplicateEmbed(getComplaint(t.id))] });
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

/** Иерархию поменяли — пересчитать, на кого открытые жалобы, и обновить их карточки */
export async function recomputeTargets(client) {
  for (const c of db.prepare("SELECT thread_id, violator, target_rank FROM complaints WHERE status IN ('new','assigned','accepted')").all()) {
    const t = targetRankOf(c.violator);
    if (t === c.target_rank) continue;
    db.prepare('UPDATE complaints SET target_rank=?, restricted=? WHERE thread_id=?').run(t, t ? 1 : 0, c.thread_id);
    await refreshMessage(client, getComplaint(c.thread_id)).catch(() => {});
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
  if (row && row.status !== 'old') return `Жалоба №${number} уже есть в канале жалоб (статус: ${STATUS_TEXT[row.status] ?? row.status}).`;
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
