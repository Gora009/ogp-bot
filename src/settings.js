import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, GatewayIntentBits, MessageFlags, ModalBuilder, RoleSelectMenuBuilder,
  SeparatorBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { PERMS, can, hasAnyRules, notifyAccessChange, roleIdsWith, setRolesFor, userIdsWith } from './access.js';
import { addRank, moveRank, rankById, rankByName, ranks, removeRank, resetHierarchy, setKeywordsOf, setReviews, targetsOf } from './hierarchy.js';
import { applyHierarchy } from './staff.js';
import { autoAssignText, conf, setConf } from './config.js';
import { FORUM_URL, registerCommands } from './admin.js';
import { C, EPH } from './util.js';
import { deleteForm, formLine, listForms } from './forms.js';
import { allowGuild, disallowGuild, leaveIfForeign, storedGuilds } from './guard.js';
import { autosetup } from './autosetup.js';
import { faq } from './faq.js';
import { poll } from './complaints.js';
import { syncPeople } from './people.js';
import { logFile } from './log.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * /settings — все настройки бота в одном окне, кроме панелей (их размещают /setup, /panels_list, /panel_delete).
 * Оформление как у /faq: разделы переключаются кнопками, внутри — понятный текст и элементы управления.
 */
const LINE = '_'.repeat(22);
const POLL = Math.max(10, Number(process.env.POLL_SECONDS || 30));

const PAGES = [[['main', 'Общее'], ['access', 'Доступ'], ['complaints', 'Жалобы'], ['staff', 'Сотрудники'], ['system', 'Система']], [['hierarchy', 'Иерархия']]];

const V2 = MessageFlags.IsComponentsV2;
/** «Срок закрытия: 72 ч» → «**Срок закрытия:** 72 ч» (короткая подпись без разметки) */
const label = (l) => {
  const m = /^([А-ЯЁA-Z][^:*`<>\n]{1,40}):\s+(.+)$/.exec(l);
  return m ? `**${m[1]}:** ${m[2]}` : l;
};
/**
 * Раздел настроек: сверху «Настройки бота» и название раздела, дальше блоки — строка «**Заголовок**» в body
 * начинает новый блок (## Заголовок), между блоками — разделители. Как карточки на скрине «database.gov».
 */
function section(title, subtitle, body) {
  const c = new ContainerBuilder().setAccentColor(C.info)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**⚙️ Настройки бота**\n# ${title}\n-# ${subtitle}`));
  const blocks = [];
  let cur = null;
  for (const line of body) {
    const h = /^\*\*([^*]+)\*\*$/.exec(line.trim());
    if (h || line === LINE) { cur = { head: h ? h[1] : null, lines: [] }; blocks.push(cur); continue; }
    if (!cur) { cur = { head: null, lines: [] }; blocks.push(cur); }
    cur.lines.push(line);
  }
  for (const b of blocks) {
    const lines = b.lines.join('\n').trim().split('\n').filter((l, n, all) => l.trim() || all.length > 1);
    if (!b.head && !lines.join('').trim()) continue;
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent([...(b.head ? [`## ${b.head}`] : []), ...lines.map(label)].join('\n')));
  }
  return c;
}
/** Кнопки и списки — внутри той же карточки, под чертой */
const page = (container, rows) => {
  container.addSeparatorComponents(new SeparatorBuilder());
  for (const r of rows) container.addActionRowComponents(r);
  return { components: [container], flags: V2 };
};

const nav = (page) => PAGES.map((line) => new ActionRowBuilder().addComponents(line.map(([k, label]) =>
  new ButtonBuilder().setCustomId(`set:p:${k}`).setLabel(label)
    .setStyle(k === page ? ButtonStyle.Primary : ButtonStyle.Secondary))));

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

const mentions = (roles, users) => [...roles.map((r) => `<@&${r}>`), ...users.map((u) => `<@${u}>`)].join(' ') || 'не выдано';
const responsible = () => db.prepare('SELECT user_id FROM deadline_responsible').all().map((r) => r.user_id);
const hasIntent = (client) => client.options.intents.has(GatewayIntentBits.GuildMembers);
const note = (text) => (text ? ['', `> ${text}`] : []);

/* ---------- разделы ---------- */
function mainView(client, msg) {
  const pros = db.prepare('SELECT COUNT(*) n, SUM(senior) s FROM prosecutors').get();
  const vr = conf.vacationRoleId();
  return page(section('Общее', 'Сводка настроек', [
      '**Жалобы**',
      `Назначение: ${autoAssignText()}`,
      `Срок закрытия: ${conf.deadlineHours()} ч от подачи на форуме`,
      '',
      '**Доступ**',
      hasAnyRules() ? `Правил доступа: ${db.prepare('SELECT COUNT(*) n FROM access').get().n}`
        : 'Права руководства ещё не выданы — всё могут только владелец сервера и владелец бота',
      '',
      '**Сотрудники**',
      `Прокуроров в базе: ${pros.n} (старший состав: ${pros.s ?? 0})`,
      `Роль «Отпуск»: ${vr ? `<@&${vr}>` : 'не задана'}`,
      '',
      '**Система**',
      `Команды: ${getSetting('commands_scope') === 'global' ? 'глобальные' : 'на этом сервере'}`,
      `Список участников сервера (Server Members Intent): ${hasIntent(client) ? 'доступен' : 'недоступен'}`,
      ...note(msg),
    ]), [...nav('main'), row(btn('set:auto', 'Автонастройка по ролям', ButtonStyle.Primary), btn('set:faq', 'Справка'))]);
}

function accessView(perm = 'prosecutor', msg = '') {
  const lines = Object.entries(PERMS).map(([k, [name]]) =>
    `${k === perm ? '**›** ' : ''}**${name}** — ${mentions(roleIdsWith(k), userIdsWith(k))}`);
  const roles = roleIdsWith(perm);
  const users = userIdsWith(perm);
  const roleSel = new RoleSelectMenuBuilder().setCustomId(`set:ar:${perm}`).setPlaceholder('Роли с этим правом')
    .setMinValues(0).setMaxValues(25);
  if (roles.length) roleSel.setDefaultRoles(roles.slice(0, 25));
  const userSel = new UserSelectMenuBuilder().setCustomId(`set:au:${perm}`).setPlaceholder('Отдельные пользователи с этим правом')
    .setMinValues(0).setMaxValues(25);
  if (users.length) userSel.setDefaultUsers(users.slice(0, 25));
  return page(section('Доступ', 'Кто что может в боте', [
      ...lines,
      LINE,
      '',
      `**Сейчас настраивается: ${PERMS[perm][0]}**`,
      PERMS[perm][1],
      '',
      '-# Отмеченные роли и люди получают право, снятая отметка его забирает.',
      ...note(msg),
    ]), [
      ...nav('access'),
      row(new StringSelectMenuBuilder().setCustomId('set:perm').setPlaceholder('Право')
        .addOptions(Object.entries(PERMS).map(([k, [n]]) => ({ label: n, value: k, default: k === perm })))),
      row(roleSel),
      row(userSel),
    ]);
}

function complaintsView(msg = '') {
  const resp = responsible();
  const rem = conf.reminderHours();
  const rep = conf.repeatHours();
  const sel = new UserSelectMenuBuilder().setCustomId('set:resp').setPlaceholder('Ответственные за дедлайны')
    .setMinValues(0).setMaxValues(25);
  if (resp.length) sel.setDefaultUsers(resp.slice(0, 25));
  return page(section('Жалобы', 'Назначение и сроки', [
      '**Назначение**',
      autoAssignText(),
      '',
      '**Сроки**',
      `Закрыть жалобу: ${conf.deadlineHours()} ч от подачи на форуме`,
      `Дедлайн ответа: ${rem[0] ?? 24} ч от подачи`,
      `Повтор после просрочки: ${rep > 0 ? `каждые ${rep} ч` : 'нет'}`,
      '',
      '**Ответственные за дедлайны**',
      resp.map((u) => `<@${u}>`).join(' ') || 'не назначены',
      ...note(msg),
    ]), [
      ...nav('complaints'),
      row(btn('set:m:times', 'Сроки и назначение'), btn('set:poll', 'Проверить форум сейчас')),
      row(sel),
    ]);
}

function staffView(msg = '') {
  const vr = conf.vacationRoleId();
  const instr = getSetting('mentor_instruction');
  const pros = db.prepare('SELECT COUNT(*) n, SUM(senior) s FROM prosecutors').get();
  const judges = db.prepare('SELECT COUNT(*) n FROM judges').get().n;
  const roleSel = new RoleSelectMenuBuilder().setCustomId('set:vr').setPlaceholder('Роль «Отпуск»').setMinValues(0).setMaxValues(1);
  if (vr) roleSel.setDefaultRoles(vr);
  return page(section('Сотрудники', 'Отпуска, кураторство и базы сотрудников', [
      '**Роль «Отпуск»**',
      vr ? `<@&${vr}>` : 'не задана',
      '-# Роль бота должна стоять выше неё.',
      '',
      '**Инструкция кураторства**',
      instr ? `${instr.slice(0, 300)}${instr.length > 300 ? '…' : ''}` : 'не заполнена',
      '',
      '**Базы**',
      `Прокуроров: ${pros.n} (старший состав: ${pros.s ?? 0}), судей: ${judges}`,
      ...note(msg),
    ]), [
      ...nav('staff'),
      row(roleSel),
      row(btn('set:m:instr', 'Изменить инструкцию кураторства'), btn('set:sync', 'Сверить базы сейчас')),
    ]);
}

function systemView(client, msg = '') {
  const global = getSetting('commands_scope') === 'global';
  const forms = listForms();
  const pg = conf.prosecutionGuildId();
  const pgName = pg ? client.guilds.cache.get(pg)?.name : null;
  return page(section('Система', 'Команды, серверы бота и форум', [
      '**Серверы бота**',
      ...storedGuilds().map((id) => `• ${client.guilds.cache.get(id)?.name ?? 'бот ещё не добавлен'} (${id})`),
      '-# С других серверов бот выходит сам.',
      '',
      '**Команды бота**',
      global ? 'Глобальные' : 'Серверные',
      '',
      '**Сервер Прокуратуры**',
      pg ? `${pgName ?? 'бот не состоит на этом сервере'} (${pg})` : 'не задан',
      '',
      '**Форум**',
      `Раздел жалоб: ${FORUM_URL}`,
      `Проверка новых жалоб: каждые ${POLL} с`,
      '',
      '**Список участников сервера**',
      hasIntent(client) ? 'Доступен' : 'Недоступен — включите Server Members Intent в Developer Portal',
      '',
      '**Google Формы**',
      ...(forms.length ? forms.map(formLine) : ['не подключены']),
      ...note(msg),
    ]), [
      ...nav('system'),
      row(btn('set:scope', global ? 'Сделать команды серверными' : 'Сделать команды глобальными'),
        btn('set:m:pg', 'Сервер Прокуратуры'), btn('set:m:guild', 'Разрешить сервер'), btn('set:logs', 'Журнал за сегодня')),
      ...(storedGuilds().length > 1 ? [row(new StringSelectMenuBuilder().setCustomId('set:gdel').setPlaceholder('Запретить сервер (бот выйдет)')
        .addOptions(storedGuilds().slice(0, 25).map((id) => ({ label: (client.guilds.cache.get(id)?.name ?? id).slice(0, 100), value: id, description: id }))))] : []),
      ...(forms.length ? [row(new StringSelectMenuBuilder().setCustomId('set:fdel').setPlaceholder('Отключить Google Форму')
        .addOptions(forms.slice(0, 25).map((f) => ({ label: f.name.slice(0, 100), value: String(f.id) }))))] : []),
    ]);
}

/* ---------- раздел «Иерархия»: кто рассматривает жалобы на какие должности ---------- */
function hierarchyView(selected = null, msg = '') {
  const all = ranks();
  const nameOf = (id) => all.find((r) => r.id === id)?.name ?? '?';
  const sel = all.find((r) => r.id === selected) ?? null;
  const body = [
    '**Должности (выше — старше)**',
    ...all.map((r, k) => `${k + 1}. **${r.name}** → ${targetsOf(r.id).map(nameOf).join(', ') || '—'}`),
    '-# Справа — на кого должность рассматривает жалобы.',
  ];
  if (sel) {
    body.push(`**Должность: ${sel.name}**`,
      `Слова: ${sel.keywords.join(', ') || '—'}`,
      `Рассматривает жалобы на: ${targetsOf(sel.id).map(nameOf).join(', ') || '—'}`,
      '-# По словам бот узнаёт должность в ролях и в жалобах.');
  } else {
    body.push('-# Выберите должность, чтобы изменить её.');
  }
  body.push(...note(msg));
  const pick = new StringSelectMenuBuilder().setCustomId('set:h:pick').setPlaceholder('Выберите должность')
    .addOptions(all.slice(0, 25).map((r) => ({ label: r.name.slice(0, 100), value: String(r.id), default: r.id === sel?.id })));
  const rows = [...nav('hierarchy')];
  if (all.length) rows.push(row(pick));
  if (sel) {
    const others = all.filter((r) => r.id !== sel.id).slice(0, 25);
    const targets = new Set(targetsOf(sel.id));
    if (others.length) {
      rows.push(row(new StringSelectMenuBuilder().setCustomId(`set:h:rev:${sel.id}`).setPlaceholder('Рассматривает жалобы на… (отметьте)')
        .setMinValues(0).setMaxValues(others.length)
        .addOptions(others.map((r) => ({ label: r.name.slice(0, 100), value: String(r.id), default: targets.has(r.id) })))));
    }
    rows.push(row(btn(`set:h:kw:${sel.id}`, 'Изменить слова'), btn(`set:h:up:${sel.id}`, '↑ Выше'), btn(`set:h:down:${sel.id}`, '↓ Ниже'),
      btn(`set:h:del:${sel.id}`, 'Удалить', ButtonStyle.Danger)));
  }
  rows.push(row(btn('set:h:add', 'Добавить должность', ButtonStyle.Primary), btn('set:h:reset', 'Сбросить к начальной')));
  return page(section('Иерархия', 'Кто рассматривает жалобы на какие должности', body), rows);
}

/** Кнопки, списки и формы раздела «Иерархия» (менять может только «Полный доступ») */
async function handleHierarchy(client, i, sub, id) {
  if (!can(i, 'full')) return i.reply({ content: '⛔ Иерархию меняет только руководство с «Полным доступом».', ...EPH });
  const r = rankById(Number(id));
  const words = (s) => [...new Set(String(s).split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const done = async (sel, msg) => { await applyHierarchy(client); return i.update(hierarchyView(sel, msg)); };
  if (sub === 'pick') return i.update(hierarchyView(Number(i.values[0])));
  if (sub === 'rev' && r) {
    const names = i.values.map((v) => rankById(Number(v))?.name).filter(Boolean);
    setReviews(r.name, names);
    return done(r.id, `«${r.name}» рассматривает жалобы на: ${names.join(', ') || '— (никого)'}.`);
  }
  if (sub === 'up' || sub === 'down') { if (r) moveRank(r.id, sub); return done(r?.id, r ? `«${r.name}» перемещена ${sub === 'up' ? 'выше' : 'ниже'}.` : ''); }
  if (sub === 'del' && r) { removeRank(r.name); return done(null, `Должность «${r.name}» удалена.`); }
  if (sub === 'reset') { resetHierarchy(); return done(null, 'Иерархия сброшена к начальной.'); }
  if (sub === 'kw' && r) {
    return i.showModal(new ModalBuilder().setCustomId(`set:h:kws:${r.id}`).setTitle(`Слова: ${r.name}`.slice(0, 45)).addComponents(
      input('kw', 'Слова через запятую или с новой строки', r.keywords.join(', '), TextInputStyle.Paragraph, 1000)));
  }
  if (sub === 'kws' && r) {
    const kw = words(i.fields.getTextInputValue('kw'));
    if (!kw.length) return i.reply({ content: '⚠️ Нужно хотя бы одно слово.', ...EPH });
    setKeywordsOf(r.name, kw);
    return done(r.id, `Слова должности «${r.name}» сохранены.`);
  }
  if (sub === 'add') {
    return i.showModal(new ModalBuilder().setCustomId('set:h:adds').setTitle('Новая должность').addComponents(
      input('name', 'Название, например: Старший прокурор', '', TextInputStyle.Short, 60),
      input('kw', 'Слова в ролях и жалобах, через запятую', '', TextInputStyle.Paragraph, 1000)));
  }
  if (sub === 'adds') {
    const name = i.fields.getTextInputValue('name').trim();
    const kw = words(i.fields.getTextInputValue('kw'));
    const res = addRank(name, kw.length ? kw : [name.toLowerCase()]);
    if (res.error) return i.reply({ content: `⚠️ ${res.error}`, ...EPH });
    return done(rankByName(name)?.id, `Должность «${name}» добавлена.`);
  }
  return i.update(hierarchyView(r?.id ?? null, 'Должность не найдена — список обновлён.'));
}

const view = (client, page, msg) => ({
  main: () => mainView(client, msg), access: () => accessView('prosecutor', msg), complaints: () => complaintsView(msg),
  hierarchy: () => hierarchyView(null, msg),
  staff: () => staffView(msg), system: () => systemView(client, msg),
}[page] ?? (() => mainView(client, msg)))();

/* ---------- формы ---------- */
const input = (id, label, value, style = TextInputStyle.Short, max = 100, required = true) =>
  row((() => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (String(value ?? '') !== '') t.setValue(String(value));
    return t;
  })());

const MODALS = {
  times: () => new ModalBuilder().setCustomId('set:s:times').setTitle('Сроки и назначение').addComponents(
    input('auto', 'Назначение, сек (0 — сразу, -1 — вручную)', conf.autoAssignSec(), TextInputStyle.Short, 6),
    input('deadline', 'Срок закрытия жалобы, часов', conf.deadlineHours(), TextInputStyle.Short, 4),
    input('rem', 'Дедлайн ответа, часов от подачи', conf.reminderHours()[0] ?? 24, TextInputStyle.Short, 3),
    input('rep', 'Повтор после просрочки, часов (0 — нет)', conf.repeatHours(), TextInputStyle.Short, 3)),
  instr: () => new ModalBuilder().setCustomId('set:s:instr').setTitle('Инструкция кураторства').addComponents(
    input('text', 'Текст инструкции', getSetting('mentor_instruction') ?? '', TextInputStyle.Paragraph, 4000, false)),
  guild: () => new ModalBuilder().setCustomId('set:s:guild').setTitle('Разрешить сервер').addComponents(
    input('id', 'ID сервера (ПКМ по серверу → Копировать ID)', '', TextInputStyle.Short, 25)),
  pg: () => new ModalBuilder().setCustomId('set:s:pg').setTitle('Сервер Прокуратуры').addComponents(
    input('id', 'ID сервера (пусто — убрать)', conf.prosecutionGuildId() ?? '', TextInputStyle.Short, 25, false)),
};

/** Обработка форм: возвращает [раздел, сообщение] */
function submitModal(i, kind) {
  const v = (id) => i.fields.getTextInputValue(id).trim();
  if (kind === 'times') {
    const auto = Number(v('auto'));
    const deadline = Number(v('deadline'));
    const rep = Number(v('rep'));
    const rem = Number(v('rem'));
    if (!Number.isInteger(auto) || auto < -1 || auto > 86400) return ['complaints', 'Назначение: целое число секунд, 0 или -1.'];
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 720) return ['complaints', 'Срок закрытия: от 1 до 720 часов.'];
    if (!Number.isInteger(rep) || rep < 0 || rep > 168) return ['complaints', 'Повтор: от 0 до 168 часов.'];
    if (!Number.isInteger(rem) || rem < 1 || rem >= deadline) return ['complaints', `Дедлайн ответа: от 1 до ${deadline - 1} часов.`];
    setConf('auto_assign_seconds', auto);
    setConf('deadline_hours', deadline);
    setConf('reminder_hours', rem);
    setConf('overdue_repeat_hours', rep);
    return ['complaints', 'Сохранено.'];
  }
  if (kind === 'instr') {
    setSetting('mentor_instruction', v('text'));
    return ['staff', 'Инструкция кураторства сохранена.'];
  }
  if (kind === 'guild') {
    const id = v('id');
    if (!/^\d{15,22}$/.test(id)) return ['system', 'ID сервера — число из 17–20 цифр.'];
    allowGuild(id);
    return ['system', `Сервер ${id} разрешён.`];
  }
  if (kind === 'pg') {
    const id = v('id');
    if (id && !/^\d{15,22}$/.test(id)) return ['system', 'ID сервера — число из 17–20 цифр.'];
    setConf('prosecution_guild_id', id || null);
    return ['system', id ? 'Сервер Прокуратуры сохранён.' : 'Сервер Прокуратуры убран.'];
  }
  return ['main', ''];
}

/* ---------- вход и роутер ---------- */
export const settings = (client, i) => i.reply({ ...mainView(client), flags: V2 | MessageFlags.Ephemeral });

export async function handleSettings(client, i) {
  if (!can(i, 'setup')) return i.reply({ content: '⛔ Настройки доступны руководству (право «Настройка панелей»).', ...EPH });
  const [, action, arg, extra] = i.customId.split(':');
  if (action === 'h') return handleHierarchy(client, i, arg, extra);

  if (action === 'p') return i.update(view(client, arg));
  // серверы бота, область команд, сервер Прокуратуры, журнал — только «Полный доступ»
  if (['gdel', 'scope', 'logs'].includes(action) || (['m', 's'].includes(action) && ['guild', 'pg'].includes(arg))) {
    if (!can(i, 'full')) return i.reply({ content: '❌ Только ГП может это менять.', ...EPH });
  }

  // доступ — только «Полный доступ»
  if (['perm', 'ar', 'au'].includes(action)) {
    if (!can(i, 'full')) return i.reply({ content: '⛔ Права выдаёт только руководство с «Полным доступом».', ...EPH });
    if (action === 'perm') return i.update(accessView(i.values[0]));
    const perm = Object.hasOwn(PERMS, arg) ? arg : 'prosecutor';
    const kind = action === 'ar' ? 'role' : 'user';
    const before = new Set(kind === 'role' ? roleIdsWith(perm) : userIdsWith(perm));
    const after = new Set(i.values);
    if (kind === 'role') setRolesFor(perm, [...after]); // роли по названию: снятие сохраняется как запрет
    else {
      for (const x of before) if (!after.has(x)) db.prepare(`DELETE FROM access WHERE target_id=? AND perm=? AND kind='user'`).run(x, perm);
      for (const x of after) if (!before.has(x)) db.prepare(`INSERT OR IGNORE INTO access(target_id,kind,perm) VALUES(?,'user',?)`).run(x, perm);
    }
    notifyAccessChange();
    const fmt = (x) => (kind === 'role' ? `<@&${x}>` : `<@${x}>`);
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));
    const msg = [added.length && `Добавлено: ${added.map(fmt).join(' ')}`, removed.length && `Убрано: ${removed.map(fmt).join(' ')}`]
      .filter(Boolean).join('. ') || 'Без изменений.';
    return i.update(accessView(perm, msg));
  }

  if (action === 'resp') {
    db.prepare('DELETE FROM deadline_responsible').run();
    for (const u of i.values) db.prepare('INSERT OR IGNORE INTO deadline_responsible(user_id) VALUES(?)').run(u);
    return i.update(complaintsView('Ответственные за дедлайны сохранены.'));
  }
  if (action === 'vr') {
    setConf('vacation_role_id', i.values[0] ?? null);
    return i.update(staffView(i.values[0] ? 'Роль «Отпуск» сохранена.' : 'Роль «Отпуск» убрана.'));
  }
  if (action === 'gdel') {
    const id = i.values[0];
    if (id === i.guildId) return i.reply({ content: '⛔ Нельзя запретить сервер, на котором вы сейчас находитесь.', ...EPH });
    disallowGuild(id);
    const g = client.guilds.cache.get(id);
    if (g) await leaveIfForeign(g);
    return i.update(systemView(client, `Сервер ${g?.name ?? id} запрещён${g ? ', бот вышел с него' : ''}.`));
  }
  if (action === 'fdel') {
    const f = listForms().find((x) => String(x.id) === i.values[0]);
    deleteForm(Number(i.values[0]));
    return i.update(systemView(client, f ? `Форма «${f.name}» отключена.` : 'Форма уже отключена.'));
  }
  if (action === 'poll') {
    await i.deferUpdate();
    const n = await poll(client, FORUM_URL);
    return i.editReply(complaintsView(n ? `Опубликовано новых жалоб: ${n}.` : 'Форум проверен — новых жалоб нет.'));
  }
  if (action === 'sync') {
    await i.deferUpdate();
    const r = await syncPeople(client);
    return i.editReply(staffView(r ? `Базы сверены: прокуроров ${r.prosecutors} (старший состав ${r.seniors}), судей ${r.judges}.`
      : 'Сверить не удалось: недоступен список участников сервера.'));
  }
  if (action === 'faq') return faq(client, i);
  if (action === 'auto') {
    if (!can(i, 'full')) return i.reply({ content: '⛔ Автонастройку запускает руководство с «Полным доступом».', ...EPH });
    return autosetup(client, i);
  }
  // журнал бота за сегодня — файлом, только «Полный доступ» (в нём действия всех сотрудников)
  if (action === 'logs') {
    const file = logFile();
    if (!fs.existsSync(file)) return i.reply({ content: 'За сегодня в журнале пока пусто.', ...EPH });
    // Discord принимает файлы до 8 МБ — если журнал больше, присылаем его конец
    const MAX = 8 * 1024 * 1024;
    const size = fs.statSync(file).size;
    const data = size > MAX ? fs.readFileSync(file).subarray(size - MAX) : fs.readFileSync(file);
    return i.reply({
      content: `Журнал за сегодня${size > MAX ? ' (последние 8 МБ)' : ''}.`,
      files: [new AttachmentBuilder(data, { name: path.basename(file) })], ...EPH,
    });
  }
  if (action === 'scope') {
    await i.deferUpdate();
    setSetting('commands_scope', getSetting('commands_scope') === 'global' ? 'guild' : 'global');
    await registerCommands(client);
    return i.editReply(systemView(client, 'Команды перерегистрированы.'));
  }

  if (action === 'm') {
    if (arg === 'instr' && !can(i, 'mentoring_text') && !can(i, 'full')) {
      return i.reply({ content: '⛔ Инструкцию меняет Генеральный прокурор (право «Текст инструкции кураторства»).', ...EPH });
    }
    return MODALS[arg] ? i.showModal(MODALS[arg]()) : undefined;
  }
  if (action === 's') {
    if (arg === 'instr' && !can(i, 'mentoring_text') && !can(i, 'full')) {
      return i.reply({ content: '⛔ Инструкцию меняет Генеральный прокурор.', ...EPH });
    }
    const [page, msg] = submitModal(i, arg);
    return i.update(view(client, page, msg));
  }
}

