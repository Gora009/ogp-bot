import { EmbedBuilder } from 'discord.js';
import { db } from './db.js';
import { C, EPH, displayNameOf, mskDate, nameAndTag, nowTs, safeText, stamp } from './util.js';
import { messageUrl } from './mirror.js';

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

/* ---------- /profile — вся статистика сотрудника (старший состав) ---------- */
const CASE_ICON = { pending: '⏳', approved: '✅', rework: '🔄', rejected: '❌' };
const MNT_ICON = { active: '🟢', pending: '⏳', done: '✅', failed: '❌', refused: '🚫', cancelled: '⚪' };
const COMPLAINT_ICON = (c) => (c.status === 'closed' ? ({ satisfied: '🟢', rejected: '🔴' }[c.result] ?? '⚪')
  : c.status === 'accepted' ? '🟡' : '📋');
const linked = (text, url) => (url ? `[${text}](${url})` : text);
const days = (a, b) => Math.max(1, Math.ceil((b - a) / 86400)); // отпуск хранится «начало дня — конец дня»

export async function profile(client, i) {
  const u = i.options.getUser('user');
  const id = u.id;
  const n = nowTs();
  const member = await i.guild.members.fetch(id).catch(() => null);
  const p = db.prepare('SELECT * FROM prosecutors WHERE user_id=?').get(id);
  const name = member?.displayName ?? displayNameOf(id) ?? u.username;

  // жалобы
  const cs = db.prepare(`SELECT COUNT(*) total, SUM(status IN ('assigned','accepted')) active, SUM(result='satisfied') sat,
                                SUM(result='rejected') rej, SUM(notified_close=1 OR notified_respond=1) overdue,
                                AVG(CASE WHEN status='closed' AND closed_ts>created_ts THEN closed_ts-created_ts END) avg
                         FROM complaints WHERE assignee_id=? AND status!='old'`).get(id);
  const lastC = db.prepare(`SELECT * FROM complaints WHERE assignee_id=? AND status!='old' ORDER BY created_ts DESC LIMIT 5`).all(id);
  // дела
  const cases = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM cases WHERE prosecutor_id=? GROUP BY status').all(id).map((r) => [r.status, r.n]));
  const lastCases = db.prepare('SELECT * FROM cases WHERE prosecutor_id=? ORDER BY created_ts DESC LIMIT 5').all(id);
  const casesTotal = Object.values(cases).reduce((s, x) => s + x, 0);
  const reviewed = db.prepare('SELECT COUNT(*) n FROM cases WHERE decided_by=?').get(id).n;
  // отпуска
  const vac = db.prepare(`SELECT * FROM vacations WHERE user_id=? ORDER BY start_ts DESC`).all(id);
  const approved = vac.filter((v) => v.status === 'approved');
  const now = approved.find((v) => v.start_ts <= n && v.end_ts >= n);
  const vacDays = approved.reduce((s, v) => s + days(v.start_ts, v.end_ts), 0);
  // кураторство и увольнения
  const asMentor = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM mentorships WHERE mentor_id=? GROUP BY status').all(id).map((r) => [r.status, r.n]));
  const asMentee = db.prepare('SELECT * FROM mentorships WHERE mentee_id=? ORDER BY created_ts DESC LIMIT 1').get(id);
  const resign = db.prepare(`SELECT status, created_ts FROM resignations WHERE user_id=? ORDER BY created_ts DESC LIMIT 1`).get(id);

  const status = now || p?.on_leave ? '🏖️ В отпуске' : resign?.status === 'approved' ? '📄 Уволен' : '✅ На службе';
  const avg = cs.avg ? `${(cs.avg / 3600).toFixed(1)} ч` : '—';
  const e = new EmbedBuilder().setColor(C.info).setTitle(`👤 ${name}`.slice(0, 256))
    .setThumbnail(u.displayAvatarURL())
    .setDescription([
      `**Сотрудник:** <@${id}>`,
      `**Должность:** ${p?.position ?? '—'}${p?.senior ? ' • старший состав' : ''}`,
      `**Статус:** ${status}`,
      ...(db.prepare('SELECT 1 FROM assign_off WHERE user_id=?').get(id) ? ['**Распределение жалоб:** ⏸ выключено'] : []),
    ].join('\n'))
    .addFields(
      { name: '📋 Жалобы', value: [
        `Всего: **${cs.total ?? 0}** • в работе: **${cs.active ?? 0}**`,
        `🟢 удовлетворено: **${cs.sat ?? 0}** • 🔴 отклонено: **${cs.rej ?? 0}**`,
        `⏰ просрочек: **${cs.overdue ?? 0}** • средний срок закрытия: **${avg}**`,
        ...lastC.map((c) => `${COMPLAINT_ICON(c)} ${linked(`№${c.number ?? '?'}`, messageUrl(client, 'complaint', c.thread_id, i.guildId) ?? c.url)} — ${mskDate(c.created_ts)}`),
      ].join('\n').slice(0, 1024) },
      { name: '📁 Уголовные дела', value: [
        `Всего: **${casesTotal}** • ⏳ ${cases.pending ?? 0} • ✅ ${cases.approved ?? 0} • 🔄 ${cases.rework ?? 0} • ❌ ${cases.rejected ?? 0}`,
        ...(reviewed ? [`Рассмотрел чужих дел: **${reviewed}**`] : []),
        ...lastCases.map((c) => `${CASE_ICON[c.status] ?? '•'} ${linked(c.number?.startsWith('б/н-') ? c.uin : safeText(c.number), messageUrl(client, 'case', c.uin, i.guildId))} — ${safeText(c.accused ?? '—')}`),
      ].join('\n').slice(0, 1024) },
      { name: '🏖️ Отпуска', value: [
        `Одобрено: **${approved.length}** (дней: **${vacDays}**) • на рассмотрении: **${vac.filter((v) => v.status === 'pending').length}**`,
        now ? `Сейчас в отпуске: ${mskDate(now.start_ts)} — ${mskDate(now.end_ts)}` : null,
        ...vac.slice(0, 3).map((v) => `• ${mskDate(v.start_ts)} — ${mskDate(v.end_ts)} • ${{ approved: '✅', pending: '⏳', rejected: '❌', cancelled: '🚫' }[v.status] ?? ''}`),
      ].filter(Boolean).join('\n').slice(0, 1024) },
      { name: '🎓 Кураторство', value: [
        `Куратор: 🟢 ${asMentor.active ?? 0} • ✅ ${asMentor.done ?? 0} • ❌ ${asMentor.failed ?? 0} • 🚫 ${asMentor.refused ?? 0}`,
        asMentee ? `Курируемый: ${MNT_ICON[asMentee.status] ?? ''} куратор <@${asMentee.mentor_id}>` : 'Курируемым не был',
      ].join('\n') },
      ...(resign ? [{ name: '📄 Увольнение', value: `Заявление от ${mskDate(resign.created_ts)}: ${{ pending: '⏳ на рассмотрении', approved: '✅ одобрено', rejected: '❌ отклонено' }[resign.status] ?? resign.status}` }] : []))
    .setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH, __noLogo: true });
}
