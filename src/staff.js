import { EmbedBuilder } from 'discord.js';
import { db } from './db.js';
import { C, EPH, displayNameOf, nowTs, stamp } from './util.js';
import { addRank, hierarchyLines, rankByName, removeRank, resetHierarchy, setKeywordsOf, setReviews } from './hierarchy.js';

/* ---------- /distribution — выключить / включить распределение жалоб сотруднику ---------- */
export async function distribution(client, i) {
  const sub = i.options.getSubcommand();
  const u = i.options.getUser('user');
  if (sub === 'off') {
    db.prepare('INSERT OR REPLACE INTO assign_off(user_id,by_id,ts) VALUES(?,?,?)').run(u.id, i.user.id, nowTs());
    return i.reply({ content: `⏸ Распределение жалоб для <@${u.id}> выключено: в списке выбора и в «Авто» его больше нет. Включить: \`/distribution on\`.`, ...EPH });
  }
  if (sub === 'on') {
    const n = db.prepare('DELETE FROM assign_off WHERE user_id=?').run(u.id).changes;
    return i.reply({ content: n ? `▶️ Распределение жалоб для <@${u.id}> снова включено.` : `У <@${u.id}> распределение и так включено.`, ...EPH });
  }
  const rows = db.prepare('SELECT * FROM assign_off ORDER BY ts').all();
  const e = new EmbedBuilder().setColor(C.info).setTitle('⏸ Распределение жалоб выключено')
    .setDescription(rows.map((r) => `• ${displayNameOf(r.user_id) ? `${displayNameOf(r.user_id)} (<@${r.user_id}>)` : `<@${r.user_id}>`} — выключил <@${r.by_id}>`).join('\n') ||
      'Всем сотрудникам жалобы распределяются как обычно.')
    .setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH });
}

/* ---------- /hierarchy — кто рассматривает жалобы на кого ---------- */
const list = (s) => String(s ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
function view(note = '') {
  return new EmbedBuilder().setColor(C.info).setTitle('🏛️ Иерархия ОГП')
    .setDescription(`${note ? `${note}\n\n` : ''}${hierarchyLines().join('\n\n') || 'Должностей нет.'}\n\n` +
      '-# Должность человека бот узнаёт по словам в названиях его ролей, должность нарушителя — по словам в «Сведениях о нарушителе» ' +
      '(или по нику, если это сотрудник ОГП). Жалобу на должность получают только те, кто её рассматривает. Жалобы не на сотрудников ОГП — любой прокурор.')
    .setFooter({ text: stamp() });
}
/** После изменений — пересчитать должности сотрудников и нарушителей в открытых жалобах */
async function apply(client) {
  const { scheduleSync } = await import('./people.js');
  scheduleSync(client);
  const { recomputeTargets } = await import('./complaints.js');
  await recomputeTargets(client);
}
export async function hierarchy(client, i) {
  const sub = i.options.getSubcommand();
  const o = i.options;
  let r = { ok: true };
  let note = '';
  if (sub === 'reviews') {
    r = setReviews(o.getString('position'), list(o.getString('targets')));
    note = `✅ «${o.getString('position')}» теперь рассматривает жалобы на: ${list(o.getString('targets')).join(', ') || '—'}.`;
  } else if (sub === 'add') {
    r = addRank(o.getString('name'), list(o.getString('keywords')), o.getString('before'));
    note = `✅ Должность «${o.getString('name')}» добавлена. Укажите, кого она рассматривает: \`/hierarchy reviews\`.`;
  } else if (sub === 'remove') {
    r = removeRank(o.getString('name'));
    note = `🗑️ Должность «${o.getString('name')}» удалена.`;
  } else if (sub === 'keywords') {
    r = setKeywordsOf(o.getString('name'), list(o.getString('keywords')));
    note = `✅ Слова должности «${o.getString('name')}» обновлены.`;
  } else if (sub === 'reset') {
    resetHierarchy();
    note = '↩️ Иерархия сброшена к начальной.';
  }
  if (r.error) return i.reply({ content: `⚠️ ${r.error} Названия должностей — как в \`/hierarchy list\`.`, ...EPH });
  if (sub !== 'list') await apply(client);
  return i.reply({ embeds: [view(note)], ...EPH });
}
export const rankExists = (name) => !!rankByName(name);
