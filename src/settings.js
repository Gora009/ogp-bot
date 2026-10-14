import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GatewayIntentBits, ModalBuilder, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { PERMS, can, hasAnyRules, notifyAccessChange, roleIdsWith, setRolesFor, userIdsWith } from './access.js';
import { getKeywords, setKeywords } from './restricted.js';
import { autoAssignText, conf, setConf } from './config.js';
import { FORUM_URL, registerCommands } from './admin.js';
import { C, EPH, stamp } from './util.js';
import { deleteForm, formLine, listForms } from './forms.js';
import { allowGuild, disallowGuild, leaveIfForeign, storedGuilds } from './guard.js';
import { autosetup } from './autosetup.js';
import { faq } from './faq.js';
import { poll } from './complaints.js';
import { syncPeople } from './people.js';

/**
 * /settings — все настройки бота в одном окне, кроме панелей (их размещают /setup, /panels_list, /panel_delete).
 * Оформление как у /faq: разделы переключаются кнопками, внутри — понятный текст и элементы управления.
 */
const LINE = '_'.repeat(22);
const POLL = Math.max(10, Number(process.env.POLL_SECONDS || 30));

const PAGES = [[['main', 'Общее'], ['access', 'Доступ'], ['complaints', 'Жалобы'], ['staff', 'Сотрудники'], ['system', 'Система']]];

const section = (title, subtitle, body) => new EmbedBuilder().setColor(C.info).setTitle(`Настройки бота — ${title}`)
  .setDescription(`**${subtitle}**\n\n${LINE}\n\n${body.join('\n')}`).setFooter({ text: stamp() });

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
  return {
    embeds: [section('Общее', 'Сводка всех настроек. Разделы — кнопками ниже.', [
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
      '',
      '-# «Автонастройка по ролям» сама выдаст права ролям по их названиям (ГП, ЗГП, СГП, Прокурор, Судья, Отпуск) — сначала покажет план.',
      ...note(msg),
    ])],
    components: [...nav('main'), row(btn('set:auto', 'Автонастройка по ролям', ButtonStyle.Primary), btn('set:faq', 'Справка'))],
  };
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
  return {
    embeds: [section('Доступ', 'Кто что может в боте', [
      ...lines,
      LINE,
      '',
      `**Сейчас настраивается: ${PERMS[perm][0]}**`,
      PERMS[perm][1],
      '',
      'Выберите право в первом списке. Во втором и третьем отметьте роли и людей: отмеченные получат право, ' +
        'снятая отметка его заберёт.',
      ...note(msg),
    ])],
    components: [
      ...nav('access'),
      row(new StringSelectMenuBuilder().setCustomId('set:perm').setPlaceholder('Право')
        .addOptions(Object.entries(PERMS).map(([k, [n]]) => ({ label: n, value: k, default: k === perm })))),
      row(roleSel),
      row(userSel),
    ],
  };
}

function complaintsView(msg = '') {
  const resp = responsible();
  const rem = conf.reminderHours();
  const rep = conf.repeatHours();
  const sel = new UserSelectMenuBuilder().setCustomId('set:resp').setPlaceholder('Ответственные за дедлайны')
    .setMinValues(0).setMaxValues(25);
  if (resp.length) sel.setDefaultUsers(resp.slice(0, 25));
  return {
    embeds: [section('Жалобы', 'Назначение, сроки и жалобы на руководство', [
      '**Назначение**',
      autoAssignText(),
      '',
      '**Сроки**',
      `Закрыть жалобу: ${conf.deadlineHours()} ч от подачи на форуме`,
      `Напоминания исполнителю: ${rem.length ? `через ${rem.join(' и ')} ч после подачи` : 'выключены'}`,
      `После просрочки: ${rep > 0 ? `повтор исполнителю каждые ${rep} ч` : 'без повторов'}`,
      '',
      '**Жалобы на руководство**',
      'Если в пункте «Сведения о нарушителе» есть одно из слов, жалобу получает только старший состав:',
      getKeywords().join(', ') || 'список пуст — ограничение выключено',
      '',
      '**Ответственные за дедлайны**',
      `${resp.map((u) => `<@${u}>`).join(' ') || 'не назначены'} — упоминаются в канале просрочек и могут продлевать сроки`,
      ...note(msg),
    ])],
    components: [
      ...nav('complaints'),
      row(btn('set:m:times', 'Сроки и назначение'), btn('set:m:kw', 'Слова для жалоб на руководство'), btn('set:poll', 'Проверить форум сейчас')),
      row(sel),
    ],
  };
}

function staffView(msg = '') {
  const vr = conf.vacationRoleId();
  const instr = getSetting('mentor_instruction');
  const pros = db.prepare('SELECT COUNT(*) n, SUM(senior) s FROM prosecutors').get();
  const judges = db.prepare('SELECT COUNT(*) n FROM judges').get().n;
  const roleSel = new RoleSelectMenuBuilder().setCustomId('set:vr').setPlaceholder('Роль «Отпуск»').setMinValues(0).setMaxValues(1);
  if (vr) roleSel.setDefaultRoles(vr);
  return {
    embeds: [section('Сотрудники', 'Отпуска, кураторство и базы сотрудников', [
      '**Роль «Отпуск»**',
      `${vr ? `<@&${vr}>` : 'не задана'} — выдаётся в день начала отпуска и снимается после него. ` +
        'Роль бота должна стоять выше неё.',
      '',
      '**Инструкция кураторства**',
      instr ? `${instr.slice(0, 300)}${instr.length > 300 ? '…' : ''}` : 'не заполнена',
      '',
      '**Базы**',
      `Прокуроров: ${pros.n} (старший состав: ${pros.s ?? 0}), судей: ${judges}`,
      'Бот ведёт их сам по ролям — права ролям выдаются в разделе «Доступ».',
      ...note(msg),
    ])],
    components: [
      ...nav('staff'),
      row(roleSel),
      row(btn('set:m:instr', 'Изменить инструкцию кураторства'), btn('set:sync', 'Сверить базы сейчас')),
    ],
  };
}

function systemView(client, msg = '') {
  const global = getSetting('commands_scope') === 'global';
  const forms = listForms();
  const pg = conf.prosecutionGuildId();
  const pgName = pg ? client.guilds.cache.get(pg)?.name : null;
  return {
    embeds: [section('Система', 'Команды, серверы бота и форум', [
      '**Серверы бота**',
      ...storedGuilds().map((id) => `• ${client.guilds.cache.get(id)?.name ?? 'бот ещё не добавлен'} (${id})`),
      'На любом другом сервере бот сразу выходит. Чтобы добавить второй сервер, сначала разрешите его здесь.',
      'Панели на каждом сервере свои (`/setup` там), а карточки жалоб, дел и заявок одинаковые и обновляются везде сразу.',
      '',
      '**Команды бота**',
      global ? 'Глобальные — видны на всех серверах бота (обновляются до часа)' : 'На этом сервере — обновляются сразу',
      '',
      '**Сервер Прокуратуры**',
      pg ? `${pgName ?? 'бот не состоит на этом сервере'} (${pg})` : 'не задан',
      'Нужен для /check_members и /invite_missing.',
      '',
      '**Форум**',
      `Раздел жалоб: ${FORUM_URL}`,
      `Проверка новых жалоб: каждые ${POLL} с`,
      '',
      '**Список участников сервера**',
      hasIntent(client) ? 'Доступен — базы сотрудников и роль «Отпуск» обновляются автоматически'
        : 'Недоступен — включите Server Members Intent в Developer Portal → Bot',
      '',
      '**Google Формы**',
      ...(forms.length ? forms.map(formLine) : ['не подключены — подключаются через `/setup`']),
      ...note(msg),
    ])],
    components: [
      ...nav('system'),
      row(btn('set:scope', global ? 'Сделать команды серверными' : 'Сделать команды глобальными'),
        btn('set:m:pg', 'Сервер Прокуратуры'), btn('set:m:guild', 'Разрешить сервер')),
      ...(storedGuilds().length > 1 ? [row(new StringSelectMenuBuilder().setCustomId('set:gdel').setPlaceholder('Запретить сервер (бот выйдет)')
        .addOptions(storedGuilds().slice(0, 25).map((id) => ({ label: (client.guilds.cache.get(id)?.name ?? id).slice(0, 100), value: id, description: id }))))] : []),
      ...(forms.length ? [row(new StringSelectMenuBuilder().setCustomId('set:fdel').setPlaceholder('Отключить Google Форму')
        .addOptions(forms.slice(0, 25).map((f) => ({ label: f.name.slice(0, 100), value: String(f.id) }))))] : []),
    ],
  };
}

const view = (client, page, msg) => ({
  main: () => mainView(client, msg), access: () => accessView('prosecutor', msg), complaints: () => complaintsView(msg),
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
    input('rem', 'Напоминания через N часов после подачи', conf.reminderHours().join(', '), TextInputStyle.Short, 40, false),
    input('rep', 'Повтор после просрочки, часов (0 — нет)', conf.repeatHours(), TextInputStyle.Short, 3)),
  kw: () => new ModalBuilder().setCustomId('set:s:kw').setTitle('Жалобы на руководство').addComponents(
    input('kw', 'Слова или должности — по одному в строке', getKeywords().join('\n'), TextInputStyle.Paragraph, 1500, false)),
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
    const rem = v('rem') ? v('rem').split(/[,\s]+/).filter(Boolean).map(Number) : [];
    if (!Number.isInteger(auto) || auto < -1 || auto > 86400) return ['complaints', 'Назначение: целое число секунд, 0 или -1.'];
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 720) return ['complaints', 'Срок закрытия: от 1 до 720 часов.'];
    if (!Number.isInteger(rep) || rep < 0 || rep > 168) return ['complaints', 'Повтор: от 0 до 168 часов.'];
    if (rem.some((h) => !Number.isInteger(h) || h < 1 || h >= deadline)) {
      return ['complaints', `Напоминания: целые часы меньше срока закрытия (${deadline} ч), через запятую.`];
    }
    setConf('auto_assign_seconds', auto);
    setConf('deadline_hours', deadline);
    setConf('reminder_hours', [...new Set(rem)].sort((a, b) => a - b).join(','));
    setConf('overdue_repeat_hours', rep);
    return ['complaints', 'Сохранено. Новый срок действует для жалоб, назначенных с этого момента.'];
  }
  if (kind === 'kw') {
    const list = [...new Set(v('kw').toLowerCase().split('\n').map((s) => s.trim()).filter(Boolean))];
    setKeywords(list);
    return ['complaints', list.length ? `Сохранено слов: ${list.length}.` : 'Список очищен — ограничение выключено.'];
  }
  if (kind === 'instr') {
    setSetting('mentor_instruction', v('text'));
    return ['staff', 'Инструкция кураторства сохранена.'];
  }
  if (kind === 'guild') {
    const id = v('id');
    if (!/^\d{15,22}$/.test(id)) return ['system', 'ID сервера — это число из 17–20 цифр (ПКМ по серверу → «Копировать ID»).'];
    allowGuild(id);
    return ['system', `Сервер ${id} разрешён — теперь бота можно на него добавить.`];
  }
  if (kind === 'pg') {
    const id = v('id');
    if (id && !/^\d{15,22}$/.test(id)) return ['system', 'ID сервера — это число из 17–20 цифр (ПКМ по серверу → «Копировать ID»).'];
    setConf('prosecution_guild_id', id || null);
    return ['system', id ? 'Сервер Прокуратуры сохранён.' : 'Сервер Прокуратуры убран.'];
  }
  return ['main', ''];
}

/* ---------- вход и роутер ---------- */
export const settings = (client, i) => i.reply({ ...mainView(client), ...EPH });

export async function handleSettings(client, i) {
  if (!can(i, 'setup')) return i.reply({ content: '⛔ Настройки доступны руководству (право «Настройка панелей»).', ...EPH });
  const [, action, arg] = i.customId.split(':');

  if (action === 'p') return i.update(view(client, arg));

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
    if (!can(i, 'full')) return i.reply({ content: '❌ Только ГП может запрещать серверы.', plain: true, ...EPH });
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

