import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, MessageFlags,
  RoleSelectMenuBuilder, SectionBuilder, SeparatorBuilder, TextDisplayBuilder, ThumbnailBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { C, COLOR, EPH, cfg, stamp } from './util.js';
import { namePerms } from './roles.js';

db.exec(`CREATE TABLE IF NOT EXISTS access (
  target_id TEXT NOT NULL, kind TEXT NOT NULL, perm TEXT NOT NULL, PRIMARY KEY (target_id, perm))`);

/** Права, которые можно выдавать роли или пользователю через /access */
export const PERMS = {
  full: ['Полный доступ', 'всё, включая саму настройку доступа (/access)'],
  setup: ['Настройка панелей', '/setup, /panels_list, /panel_delete, /sync'],
  staff: ['Управление сотрудниками', '/register_prosecutors, /sync_judges, /check_members, /invite_missing, /broadcast, /clear_all_dm'],
  monitor: ['Мониторинг и дедлайны', 'упоминается в канале «Просроченные дедлайны», продлевает дедлайны и закрывает просроченные жалобы; ' +
    '/force_parse, /debug_forum, /check_deadlines, /deadline_responsible'],
  approve: ['Одобрение заявок', 'кнопки одобрения отпусков и увольнений, /cancel_vacation, продление дедлайнов, ' +
    'действия с чужими жалобами, просмотр всех дел. Эта роль упоминается в новых заявках'],
  assign: ['Распределение жалоб', 'выбор прокурора и «Авто» в новых жалобах, переназначение чужих жалоб'],
  judge: ['Судья', 'решения по уголовным делам (одобрить / на доработку / отклонить)'],
  prosecutor: ['Прокурор', 'получает жалобы; в базу прокуроров бот вносит сам, по ролям'],
  senior: ['Старший состав', 'получает жалобы на руководство и сотрудников офиса, принимает решения по уголовным делам (СГП, ЗГП, ГП)'],
  case_register: ['Регистрация дел', 'кнопка «Зарегистрировать дело» на панели и /register_case'],
  mentoring: ['Кураторство', 'добавлять кураторов через панель, продлевать сроки, отказ за куратора, /curators'],
  mentoring_text: ['Текст инструкции кураторства', 'изменять текст, который показывает кнопка «Инструкция» (обычно Генеральный прокурор)'],
};

/** Права управления: только они выводят бота из режима первичной настройки (панельные права — нет). */
const MANAGEMENT = ['full', 'setup', 'staff', 'monitor', 'approve'];

/** Какое право нужно для команды. Команд, которых здесь нет, могут пользоваться все. */
export const COMMAND_PERMS = {
  access: 'full', autosetup: 'full',
  setup: 'setup', panels_list: 'setup', panel_delete: 'setup', sync: 'setup',
  register_prosecutors: 'staff', sync_judges: 'staff', check_members: 'staff', invite_missing: 'staff',
  broadcast: 'staff', clear_all_dm: 'staff',
  cancel_vacation: 'approve',
  force_parse: 'monitor', debug_forum: 'monitor', check_deadlines: 'monitor', deadline_responsible: 'monitor',
  check_responsible: 'monitor',
  curators: 'mentoring',
  senior_keywords: 'setup', settings: 'setup',
};

/** Всегда имеют полный доступ: ADMIN_USER_IDS из .env и владелец(цы) приложения (добавляются при старте) */
export const trustedUsers = new Set((cfg('ADMIN_USER_IDS') || '').split(',').map((x) => x.trim()).filter(Boolean));

/*
 * Откуда берутся права (в порядке силы):
 *  1) владелец сервера и владелец бота — всё;
 *  2) снятие права с роли в /settings (kind 'role_deny') — роль его не даёт, даже если название подходит;
 *  3) выданное в /settings роли или человеку (kind 'role' / 'user');
 *  4) название роли — как в оригинальном боте (src/roles.js): «Генеральный Прокурор», «Заместитель…», «Прокурор»…
 * Право Discord «Управление сервером» / «Администратор» само по себе ничего в боте не даёт.
 */
let clientRef = null;
/** Нужен, чтобы видеть роли серверов (для упоминаний и списков) */
export const setAccessClient = (c) => { clientRef = c; };

const rules = (perm) => db.prepare(`SELECT kind, target_id FROM access WHERE perm=? AND kind IN ('role','user')`).all(perm);
const denied = (perm) => new Set(db.prepare(`SELECT target_id FROM access WHERE perm=? AND kind='role_deny'`).all(perm).map((r) => r.target_id));
/** Даёт ли роль право по своему названию (с учётом снятия в /settings) */
const roleByName = (role, perm, deny = denied(perm)) => !!role && !deny.has(role.id) && namePerms(role.name).includes(perm);
/** Все роли всех серверов бота */
const allRoles = () => (clientRef ? [...clientRef.guilds.cache.values()].flatMap((g) => [...g.roles.cache.values()]) : []);

/** Есть ли у участника право ровно perm (без учёта «Полного доступа») */
export function memberHas(member, perm) {
  if (!member) return false;
  const id = member.id ?? member.user?.id;
  if (rules(perm).some((r) => (r.kind === 'user' ? r.target_id === id : !!member.roles?.cache?.has(r.target_id)))) return true;
  const deny = denied(perm);
  return [...(member.roles?.cache?.values?.() ?? [])].some((role) => roleByName(role, perm, deny));
}
/** Роли с правом perm: выданные в /settings и подходящие по названию (кроме снятых) */
export function roleIdsWith(perm) {
  const deny = denied(perm);
  const ids = new Set(rules(perm).filter((r) => r.kind === 'role').map((r) => r.target_id));
  for (const role of allRoles()) if (roleByName(role, perm, deny)) ids.add(role.id);
  return [...ids];
}
export const userIdsWith = (perm) => rules(perm).filter((r) => r.kind === 'user').map((r) => r.target_id);
/** Роли, которые дают право только по названию (без записи в /settings) — их снятие сохраняется как «запрет» */
export const nameRoleIds = (perm) => allRoles().filter((r) => namePerms(r.name).includes(perm)).map((r) => r.id);

/** Есть ли у кого-нибудь это право (роль по названию или выданное в /settings) */
export const hasRulesFor = (perm) => rules(perm).length > 0 || roleIdsWith(perm).length > 0;
/** Права руководства есть хоть у кого-то — иначе всё могут только владелец сервера и бота */
export const hasAnyRules = () => MANAGEMENT.some((p) => hasRulesFor(p));

/**
 * Может ли пользователь interaction i выполнять действия уровня perm.
 * Владелец сервера и владелец бота — всегда (без доступа остаться нельзя).
 */
export function can(i, perm) {
  if (i.guild?.ownerId === i.user.id || trustedUsers.has(i.user.id)) return true;
  return memberHas(i.member, perm) || memberHas(i.member, 'full');
}

/**
 * Записывает в /settings ровно выбранный набор ролей для права: снятая роль «по названию» — запрет,
 * добавленная — разрешение. Возвращает { added, removed }.
 */
export function setRolesFor(perm, wanted) {
  const before = new Set(roleIdsWith(perm));
  const want = new Set(wanted);
  const byName = new Set(nameRoleIds(perm));
  const added = [...want].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !want.has(x));
  for (const id of removed) {
    db.prepare(`DELETE FROM access WHERE target_id=? AND perm=? AND kind='role'`).run(id, perm);
    if (byName.has(id)) db.prepare(`INSERT OR REPLACE INTO access(target_id,kind,perm) VALUES(?,'role_deny',?)`).run(id, perm);
  }
  for (const id of added) {
    db.prepare(`DELETE FROM access WHERE target_id=? AND perm=? AND kind='role_deny'`).run(id, perm);
    if (!byName.has(id)) db.prepare(`INSERT OR IGNORE INTO access(target_id,kind,perm) VALUES(?,'role',?)`).run(id, perm);
  }
  return { added, removed };
}

/** Понятные отказы, как в оригинале: «❌ Только ГП может просматривать панели.» */
const WHO = {
  full: 'Только ГП может', setup: 'Только ГП может', staff: 'Только ЗГП и ГП могут', monitor: 'Только ЗГП и ГП могут',
  approve: 'Только СГП, ЗГП и ГП могут', mentoring: 'Только СГП, ЗГП и ГП могут',
};
const ACTION = {
  panels_list: 'просматривать панели', setup: 'настраивать панели', panel_delete: 'удалять панели', sync: 'синхронизировать команды',
  access: 'настраивать доступ', autosetup: 'запускать автонастройку', settings: 'открывать настройки бота',
  senior_keywords: 'менять список должностей', register_prosecutors: 'сверять базу прокуроров', sync_judges: 'сверять базу судей',
  check_members: 'проверять участников', invite_missing: 'рассылать приглашения', broadcast: 'делать рассылку',
  clear_all_dm: 'удалять ЛС бота', cancel_vacation: 'отменять отпуска', force_parse: 'запускать парсинг форума',
  debug_forum: 'отлаживать парсер', check_deadlines: 'проверять дедлайны', deadline_responsible: 'назначать ответственных',
  check_responsible: 'проверять ответственных', curators: 'просматривать кураторства',
};
export const denyText = (command, perm) => `❌ ${WHO[perm] ?? 'Нет прав:'} ${ACTION[command] ?? 'использовать эту команду'}.`;

/** Старший состав: право «Старший состав» или руководство */
export const isSenior = (i) => can(i, 'senior') || can(i, 'approve');
/** То же для участника сервера (для пометки в базе прокуроров) */
export const isSeniorMember = (m) => memberHas(m, 'senior') || memberHas(m, 'approve') || memberHas(m, 'full');

/**
 * Держит запись участника в базе прокуроров актуальной по его ролям. Вызывается при каждом
 * взаимодействии с ботом, поэтому прокуроры попадают в базу сами — даже без Server Members Intent.
 * Если право «Прокурор» уже выдано ролям, а у участника его больше нет — запись удаляется.
 */
export function syncProsecutorRecord(member) {
  if (!member?.roles?.cache || member.user?.bot) return;
  const senior = isSeniorMember(member) ? 1 : 0;
  const row = db.prepare('SELECT name, senior FROM prosecutors WHERE user_id=?').get(member.id);
  if (senior || memberHas(member, 'prosecutor')) {
    const name = member.displayName ?? member.user?.username ?? member.id;
    if (!row || row.name !== name || row.senior !== senior) {
      db.prepare(`INSERT INTO prosecutors(user_id,name,senior) VALUES(?,?,?)
                  ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, senior=excluded.senior`).run(member.id, name, senior);
    }
  } else if (row && hasRulesFor('prosecutor')) {
    db.prepare('DELETE FROM prosecutors WHERE user_id=?').run(member.id);
  }
}

/**
 * Помечает в базе прокуроров, кто из них старший состав (по ролям на сервере).
 * Роли читаются через REST (интент участников не нужен); обновление не чаще раза в 10 минут.
 */
let lastSeniorRefresh = 0;
export async function refreshSeniorFlags(guild, force = false) {
  if (!guild || (!force && Date.now() - lastSeniorRefresh < 600_000)) return;
  lastSeniorRefresh = Date.now();
  const rows = db.prepare('SELECT user_id FROM prosecutors').all();
  const upd = db.prepare('UPDATE prosecutors SET senior=? WHERE user_id=?');
  for (let k = 0; k < rows.length; k += 5) {
    await Promise.all(rows.slice(k, k + 5).map(async (r) => {
      const m = await guild.members.fetch(r.user_id).catch(() => null);
      if (m) upd.run(isSeniorMember(m) ? 1 : 0, r.user_id);
    }));
  }
}

export const isLeader = (i) => can(i, 'approve');
export const isJudge = (i) => can(i, 'judge') || !!db.prepare('SELECT 1 FROM judges WHERE user_id=?').get(i.user.id);
/** Упоминания ролей, которые должны видеть новые заявки */
export const leaderPing = () => roleIdsWith('approve').map((r) => `<@&${r}>`).join(' ');

/* ---------- /access ---------- */
const who = (perm) => {
  const items = [...roleIdsWith(perm).map((r) => `<@&${r}>`), ...userIdsWith(perm).map((u) => `<@${u}>`)];
  return items.join(' ') || '—';
};

const BOOTSTRAP_NOTE = '⚠️ Права руководства ещё не выданы: сейчас всё могут только владелец сервера и владелец бота. ' +
  'Выдайте «Полный доступ» роли ГП и остальные права в /settings → Доступ.';
const ALWAYS = () => 'Владелец сервера и владелец приложения' + (cfg('ADMIN_USER_IDS') ? ', пользователи из ADMIN_USER_IDS' : '');

const listEmbed = () => new EmbedBuilder().setColor(COLOR).setTitle('🔐 Доступ к функциям бота')
  .setDescription(hasAnyRules() ? 'Доступ выдаётся только по правилам ниже.' : BOOTSTRAP_NOTE)
  .addFields(
    ...Object.entries(PERMS).map(([k, [name, what]]) => ({ name: `${name} (\`${k}\`)`, value: `${who(k)}\n-# ${what}` })),
    { name: 'Всегда имеют доступ', value: ALWAYS() })
  .setFooter({ text: stamp() });

/* ---------- /access panel: список прав, у каждого ➕; внутри — роли с ✖ ---------- */
const PERM_EMOJI = {
  full: '👑', setup: '🔧', staff: '👥', monitor: '⏰', approve: '✅', assign: '📝', judge: '⚖️',
  prosecutor: '👤', senior: '⭐', case_register: '📂', mentoring: '🎓', mentoring_text: '📖',
};
const LOGO = 'attachment://logo.webp';
const LOGO_FILE = fileURLToPath(new URL('../assets/logo.webp', import.meta.url));
const MAX_ROWS = 9; // лимит Discord — 40 элементов на сообщение; остальных показываем списком
const V2 = MessageFlags.IsComponentsV2;

const text = (t) => new TextDisplayBuilder().setContent(t);
const header = (t) => new SectionBuilder().addTextDisplayComponents(text(t))
  .setThumbnailAccessory(new ThumbnailBuilder().setURL(LOGO));
const holders = (perm) => [...roleIdsWith(perm).map((r) => `<@&${r}>`), ...userIdsWith(perm).map((u) => `<@${u}>`)];

/** Главный экран: все права списком, рядом с каждым — ➕ */
function homeView() {
  const c = new ContainerBuilder().setAccentColor(C.info).addSectionComponents(header([
    '## 🔐 Доступ к функциям бота',
    hasAnyRules()
      ? '-# Нажмите «+ Роли» рядом с правом, чтобы добавить или убрать роли'
      : '-# Права руководства ещё не выданы: всё могут только владелец сервера и владелец бота',
  ].join('\n')));
  for (const [k, [name]] of Object.entries(PERMS)) {
    const who = holders(k);
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(text(`**${PERM_EMOJI[k]} ${name}**\n${who.join(' ') || '-# не выдано'}`))
      .setButtonAccessory(new ButtonBuilder().setCustomId(`acc:open:${k}`).setLabel('+ Роли').setStyle(ButtonStyle.Primary)));
  }
  return { components: [c], flags: V2 };
}

/** Экран одного права: каждая роль и человек — отдельной строкой с ✖, внизу «добавить» */
function permView(perm, note = '') {
  const [name, what] = PERMS[perm];
  const items = [
    ...roleIdsWith(perm).map((id) => ({ id, kind: 'r', label: `<@&${id}>` })),
    ...userIdsWith(perm).map((id) => ({ id, kind: 'u', label: `<@${id}>` })),
  ];
  const c = new ContainerBuilder().setAccentColor(C.info).addSectionComponents(header(
    `## ${PERM_EMOJI[perm]} ${name}\n${what}` + (note ? `\n\n${note}` : '')));
  c.addSeparatorComponents(new SeparatorBuilder());
  if (!items.length) c.addTextDisplayComponents(text('-# Пока никому не выдано — добавьте роль ниже'));
  for (const it of items.slice(0, MAX_ROWS)) {
    c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(it.label))
      .setButtonAccessory(new ButtonBuilder().setCustomId(`acc:rm:${perm}:${it.kind}:${it.id}`)
        .setLabel('✕ Убрать').setStyle(ButtonStyle.Danger)));
  }
  if (items.length > MAX_ROWS) {
    c.addTextDisplayComponents(text(`Ещё: ${items.slice(MAX_ROWS).map((x) => x.label).join(' ')}\n-# убрать их можно командой /access revoke`));
  }
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`acc:addr:${perm}`)
      .setPlaceholder('➕ Добавить роль').setMinValues(1).setMaxValues(10)),
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`acc:addu:${perm}`)
      .setPlaceholder('➕ Добавить пользователя').setMinValues(1).setMaxValues(10)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('acc:home')
      .setLabel('Все права').setEmoji('◀️').setStyle(ButtonStyle.Secondary)));
  return { components: [c], flags: V2 };
}

export async function handleAccess(client, i) {
  if (!can(i, 'full')) return i.reply({ content: '⛔ Настраивать доступ может только руководство с «Полным доступом».', ...EPH });
  const [, action, perm, kind, id] = i.customId.split(':');
  if (action === 'home' || !Object.hasOwn(PERMS, perm)) return i.update(homeView());
  if (action === 'open') return i.update(permView(perm));

  const ins = db.prepare('INSERT OR IGNORE INTO access(target_id,kind,perm) VALUES(?,?,?)');
  let note = '';
  if (action === 'addr' || action === 'addu') {
    const k = action === 'addr' ? 'role' : 'user';
    if (k === 'role') setRolesFor(perm, [...roleIdsWith(perm), ...i.values]);
    else for (const v of i.values) ins.run(v, k, perm);
    note = `✅ Добавлено: ${i.values.map((v) => (k === 'role' ? `<@&${v}>` : `<@${v}>`)).join(' ')}`;
  }
  if (action === 'rm') {
    if (kind === 'r') setRolesFor(perm, roleIdsWith(perm).filter((x) => x !== id));
    else db.prepare(`DELETE FROM access WHERE target_id=? AND perm=? AND kind='user'`).run(id, perm);
    note = `✖️ Убрано: ${kind === 'r' ? `<@&${id}>` : `<@${id}>`}`;
    if (perm === 'full' && !can(i, 'full')) note += '\n⚠️ Вы убрали «Полный доступ» у себя — панель больше не будет вам доступна.';
  }
  onAccessChange?.();
  return i.update(permView(perm, note));
}

/** Вызывается после любого изменения прав (index.js подключает пересинхронизацию прокуроров и судей) */
let onAccessChange = null;
export const setAccessChangeHook = (fn) => { onAccessChange = fn; };
/** Сообщить о смене прав из других модулей (окно /settings) */
export const notifyAccessChange = () => onAccessChange?.();

export async function access(client, i) {
  const sub = i.options.getSubcommand();

  if (sub === 'panel') {
    return i.reply({ ...homeView(), flags: V2 | MessageFlags.Ephemeral, files: [new AttachmentBuilder(LOGO_FILE, { name: 'logo.webp' })] });
  }
  if (sub === 'list') return i.reply({ embeds: [listEmbed()], ...EPH });

  const perm = i.options.getString('permission');
  const role = i.options.getRole('role');
  const user = i.options.getUser('user');
  if (!role && !user) return i.reply({ content: 'Укажите роль (role) или пользователя (user).', ...EPH });
  const kind = role ? 'role' : 'user';
  const target = role ? role.id : user.id;
  const mention = role ? `<@&${target}>` : `<@${target}>`;
  const [name] = PERMS[perm];

  if (sub === 'grant') {
    if (role) setRolesFor(perm, [...roleIdsWith(perm), target]);
    else db.prepare('INSERT OR IGNORE INTO access(target_id,kind,perm) VALUES(?,?,?)').run(target, kind, perm);
    onAccessChange?.();
    return i.reply({ content: `✅ ${mention} → **${name}**.`, ...EPH });
  }
  const had = role ? roleIdsWith(perm).includes(target) : userIdsWith(perm).includes(target);
  if (role) setRolesFor(perm, roleIdsWith(perm).filter((x) => x !== target));
  else db.prepare(`DELETE FROM access WHERE target_id=? AND perm=? AND kind='user'`).run(target, perm);
  const r = { changes: had ? 1 : 0 };
  if (r.changes) onAccessChange?.();
  return i.reply({ content: r.changes ? `🗑️ У ${mention} убрано: **${name}**.` : `У ${mention} не было права «${name}».`, ...EPH });
}
