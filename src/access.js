import { db } from './db.js';
import { cfg } from './util.js';
import { isVacationRole, namePerms, norm, positionOf } from './roles.js';
import { rankOfMember } from './hierarchy.js';
import { conf } from './config.js';

db.exec(`CREATE TABLE IF NOT EXISTS access (
  target_id TEXT NOT NULL, kind TEXT NOT NULL, perm TEXT NOT NULL, PRIMARY KEY (target_id, perm))`);

/** Права, которые выдаются ролям и людям в /settings → Доступ */
export const PERMS = {
  full: ['Полный доступ', 'Всё, включая доступ и иерархию'],
  setup: ['Настройка панелей', '/settings, /setup, /panels_list, /panel_delete, /sync'],
  staff: ['Управление сотрудниками', '/check_members, /invite_missing, /clear_all_dm'],
  monitor: ['Мониторинг и дедлайны', 'Продление дедлайнов, закрытие просроченных жалоб, /force_parse, /debug_forum, /check_deadlines'],
  approve: ['Одобрение заявок', 'Отпуска и увольнения, /cancel_vacation, чужие жалобы. Упоминается в новых заявках'],
  assign: ['Распределение жалоб', 'Назначение и переназначение жалоб'],
  case_review: ['Рассмотрение дел', 'Решения по уголовным делам и просмотр всех дел. Пока не выдано — рассматривает старший состав и «Одобрение заявок»'],
  judge: ['Судья', 'Решения по уголовным делам'],
  prosecutor: ['Прокурор', 'Получает жалобы'],
  senior: ['Старший состав', 'Жалобы на сотрудников ОГП, решения по делам, /broadcast'],
  case_register: ['Регистрация дел', 'Регистрация уголовных дел'],
  mentoring: ['Кураторство', 'Кураторы и сроки кураторства, /curators'],
  ai: ['Разбор документов (ИИ)', '/analyze и «Краткое содержание». Пока не выдано — доступно всем сотрудникам и судьям'],
  mentoring_text: ['Текст инструкции кураторства', 'Текст кнопки «Инструкция»'],
};

/** Права управления: только они выводят бота из режима первичной настройки (панельные права — нет). */
const MANAGEMENT = ['full', 'setup', 'staff', 'monitor', 'approve'];

/** Какое право нужно для команды. Команд, которых здесь нет, могут пользоваться все. */
export const COMMAND_PERMS = {
  setup: 'setup', panels_list: 'setup', panel_delete: 'setup', sync: 'setup',
  check_members: 'staff', invite_missing: 'staff',
  broadcast: 'senior', clear_all_dm: 'staff', // рассылка — весь старший состав (СГП, ЗГП, ГП)
  cancel_vacation: 'approve',
  force_parse: 'monitor', debug_forum: 'monitor', check_deadlines: 'monitor',
  check_responsible: 'monitor',
  curators: 'mentoring',
  distribution: 'assign', settings: 'setup', profile: 'senior',
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
  approve: 'Только СГП, ЗГП и ГП могут', mentoring: 'Только СГП, ЗГП и ГП могут', senior: 'Только СГП, ЗГП и ГП могут',
};
const ACTION = {
  panels_list: 'просматривать панели', setup: 'настраивать панели', panel_delete: 'удалять панели', sync: 'синхронизировать команды',
  settings: 'открывать настройки бота', distribution: 'менять распределение жалоб', profile: 'смотреть статистику сотрудников',
  check_members: 'проверять участников', invite_missing: 'рассылать приглашения', broadcast: 'делать рассылку',
  clear_all_dm: 'удалять ЛС бота', cancel_vacation: 'отменять отпуска', force_parse: 'запускать парсинг форума',
  debug_forum: 'отлаживать парсер', check_deadlines: 'проверять дедлайны',
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
/** Есть роль «Отпуск» — из /settings или любая роль с названием «Отпуск» (в том числе выданная вручную) */
export const hasLeaveRole = (m) => [...(m?.roles?.cache?.values?.() ?? [])]
  .some((r) => r.id === conf.vacationRoleId() || isVacationRole(norm(r.name)));

export function syncProsecutorRecord(member) {
  if (!member?.roles?.cache || member.user?.bot) return;
  const senior = isSeniorMember(member) ? 1 : 0;
  const row = db.prepare('SELECT name, senior, position, rank_id, on_leave FROM prosecutors WHERE user_id=?').get(member.id);
  const leave = hasLeaveRole(member) ? 1 : 0;
  const rank = rankOfMember(member);
  if (senior || memberHas(member, 'prosecutor') || rank) {
    const name = member.displayName ?? member.user?.username ?? member.id;
    // должность — из иерархии (/settings → Иерархия), иначе по правилам ролей
    const position = rank?.name ?? positionOf(member);
    const rankId = rank?.id ?? null;
    if (!row || row.name !== name || row.senior !== senior || row.position !== position || row.rank_id !== rankId || row.on_leave !== leave) {
      db.prepare(`INSERT INTO prosecutors(user_id,name,senior,position,rank_id,on_leave) VALUES(?,?,?,?,?,?)
                  ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, senior=excluded.senior, position=excluded.position,
                  rank_id=excluded.rank_id, on_leave=excluded.on_leave`).run(member.id, name, senior, position, rankId, leave);
    }
  } else if (row && hasRulesFor('prosecutor')) {
    db.prepare('DELETE FROM prosecutors WHERE user_id=?').run(member.id);
  }
}

export const isLeader = (i) => can(i, 'approve');
export const isJudge = (i) => can(i, 'judge') || !!db.prepare('SELECT 1 FROM judges WHERE user_id=?').get(i.user.id);

/** Вызывается после любого изменения прав (index.js подключает пересинхронизацию прокуроров и судей) */
let onAccessChange = null;
export const setAccessChangeHook = (fn) => { onAccessChange = fn; };
/** Сообщить о смене прав из других модулей (окно /settings) */
export const notifyAccessChange = () => onAccessChange?.();
