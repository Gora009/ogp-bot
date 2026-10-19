import { EmbedBuilder } from 'discord.js';
import { db } from './db.js';
import { C, EPH, nameAndTag, nowTs, stamp } from './util.js';

/* ---------- /distribution — выключить / включить распределение жалоб сотруднику ---------- */
export async function distribution(client, i) {
  const sub = i.options.getSubcommand();
  const u = i.options.getUser('user');
  if (sub === 'off') {
    db.prepare('INSERT OR REPLACE INTO assign_off(user_id,by_id,ts) VALUES(?,?,?)').run(u.id, i.user.id, nowTs());
    return i.reply({ content: `⏸ Распределение жалоб для <@${u.id}> выключено.`, ...EPH });
  }
  if (sub === 'on') {
    const n = db.prepare('DELETE FROM assign_off WHERE user_id=?').run(u.id).changes;
    return i.reply({ content: n ? `▶️ Распределение жалоб для <@${u.id}> снова включено.` : `У <@${u.id}> распределение и так включено.`, ...EPH });
  }
  const rows = db.prepare('SELECT * FROM assign_off ORDER BY ts').all();
  const e = new EmbedBuilder().setColor(C.info).setTitle('⏸ Распределение жалоб выключено')
    .setDescription(rows.map((r) => `• ${nameAndTag(r.user_id)} — выключил <@${r.by_id}>`).join('\n') ||
      'Никому не выключено.')
    .setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH });
}

/** После изменений иерархии — пересчитать должности сотрудников и нарушителей в открытых жалобах */
export async function applyHierarchy(client) {
  const { scheduleSync } = await import('./people.js');
  scheduleSync(client);
  const { recomputeTargets } = await import('./complaints.js');
  await recomputeTargets(client);
}
