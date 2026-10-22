import { GatewayIntentBits } from 'discord.js';
import { db } from './db.js';
import { hasLeaveRole, hasRulesFor, isSeniorMember, memberHas, syncProsecutorRecord } from './access.js';
import { positionOf } from './roles.js';
import { rankOfMember } from './hierarchy.js';
import { fetchMembers, rememberName } from './util.js';

/**
 * Базы прокуроров и судей бот ведёт сам:
 *  • при запуске и раз в 30 минут — полная сверка по ролям всех участников;
 *  • сразу при выдаче/снятии роли, входе и выходе участника;
 *  • сразу после изменения прав в /settings.
 * Нужен Server Members Intent; без него прокуроры попадают в базу, когда сами пользуются ботом.
 */
export const hasMembersIntent = (client) => client.options.intents.has(GatewayIntentBits.GuildMembers);

const isProsecutorMember = (m) => !m.user.bot && (isSeniorMember(m) || memberHas(m, 'prosecutor'));
const isJudgeMember = (m) => !m.user.bot && memberHas(m, 'judge');

/** Полная сверка. Возвращает { prosecutors, seniors, judges, removed } или null, если сверять нечем. */
export async function syncPeople(client) {
  if (!hasMembersIntent(client)) return null;
  const pros = new Map();
  const judges = new Map();
  for (const g of client.guilds.cache.values()) {
    const members = await fetchMembers(g).catch((e) => { console.error(`Участники ${g.name}:`, e.message); return null; });
    if (!members) return null; // не удалось прочитать сервер — ничего не удаляем
    for (const m of members.values()) {
      rememberName(m);
      const rank = rankOfMember(m);
      if (isProsecutorMember(m) || (rank && !m.user.bot)) {
        pros.set(m.id, { name: m.displayName, senior: isSeniorMember(m) ? 1 : 0, position: rank?.name ?? positionOf(m), rank: rank?.id ?? null, leave: hasLeaveRole(m) ? 1 : 0 });
      }
      if (isJudgeMember(m)) judges.set(m.id, m.displayName);
    }
  }

  let removed = 0;
  // права «Прокурор» ещё никому не выданы — базу не трогаем, чтобы не стереть её по ошибке
  if (hasRulesFor('prosecutor') || hasRulesFor('senior') || hasRulesFor('approve') || hasRulesFor('full')) {
    const up = db.prepare(`INSERT INTO prosecutors(user_id,name,senior,position,rank_id,on_leave) VALUES(?,?,?,?,?,?)
                           ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, senior=excluded.senior, position=excluded.position,
                           rank_id=excluded.rank_id, on_leave=excluded.on_leave`);
    for (const [id, p] of pros) up.run(id, p.name, p.senior, p.position, p.rank, p.leave);
    for (const r of db.prepare('SELECT user_id FROM prosecutors').all()) {
      if (!pros.has(r.user_id)) { db.prepare('DELETE FROM prosecutors WHERE user_id=?').run(r.user_id); removed++; }
    }
  }
  if (hasRulesFor('judge')) {
    db.prepare('DELETE FROM judges').run();
    const ins = db.prepare('INSERT INTO judges(user_id,name) VALUES(?,?)');
    for (const [id, name] of judges) ins.run(id, name);
  }
  return { prosecutors: pros.size, seniors: [...pros.values()].filter((p) => p.senior).length, judges: judges.size, removed };
}

/** Одна сверка за раз; повторные запросы за 3 секунды склеиваются в одну */
let timer = null;
export function scheduleSync(client) {
  clearTimeout(timer);
  timer = setTimeout(() => syncPeople(client).catch((e) => console.error('Сверка прокуроров:', e.message)), 3000);
}

/** Один участник: роли изменились, зашёл или вышел */
function syncMember(m, left = false) {
  if (m.user?.bot) return;
  if (left) {
    db.prepare('DELETE FROM prosecutors WHERE user_id=?').run(m.id);
    db.prepare('DELETE FROM judges WHERE user_id=?').run(m.id);
    return;
  }
  syncProsecutorRecord(m);
  if (hasRulesFor('judge')) {
    if (isJudgeMember(m)) db.prepare('INSERT OR REPLACE INTO judges(user_id,name) VALUES(?,?)').run(m.id, m.displayName);
    else db.prepare('DELETE FROM judges WHERE user_id=?').run(m.id);
  }
}

export function installPeopleSync(client) {
  if (!hasMembersIntent(client)) return;
  client.on('guildMemberUpdate', (_, m) => syncMember(m));
  client.on('guildMemberAdd', (m) => syncMember(m));
  client.on('guildMemberRemove', (m) => syncMember(m, true));
}
