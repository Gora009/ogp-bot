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

  // оформление: по разделам, цифры — колонками по три (как «Инфо» жалобы), значков минимум
  const status = now || p?.on_leave ? 'в отпуске' : resign?.status === 'approved' ? 'уволен' : 'на службе';
  const avg = cs.avg ? `${(cs.avg / 3600).toFixed(1).replace('.', ',')} ч` : '—';
  const col = (name, value) => ({ name, value: String(value ?? 0), inline: true });
  const section = (name, lines, empty) => ({ name, value: (lines.length ? lines.join('\n') : empty).slice(0, 1024) });
  const C_STATE = { new: 'новая', assigned: 'назначена', accepted: 'в работе' };
  const complaintLine = (c) => `${linked(`№${c.number ?? '?'}`, messageUrl(client, 'complaint', c.thread_id, i.guildId) ?? c.url)} — ` +
    `${c.status === 'closed' ? ({ satisfied: 'удовлетворена', rejected: 'отклонена' }[c.result] ?? 'закрыта') : C_STATE[c.status] ?? c.status}, ${mskDate(c.created_ts)}`;
  const CASE_STATE = { pending: 'на рассмотрении', approved: 'одобрено', rework: 'на доработке', rejected: 'отклонено' };
  const caseLine = (c) => `${linked(c.number?.startsWith('б/н-') ? c.uin : safeText(c.number), messageUrl(client, 'case', c.uin, i.guildId))} — ` +
    `${CASE_STATE[c.status] ?? c.status}, ${safeText(c.accused ?? '—')}`;
  const VAC_STATE = { approved: 'одобрен', pending: 'на рассмотрении', rejected: 'отклонён', cancelled: 'отменён' };
  const off = !!db.prepare('SELECT 1 FROM assign_off WHERE user_id=?').get(id);

  const e = new EmbedBuilder().setColor(C.info).setTitle(name.slice(0, 256)).setThumbnail(u.displayAvatarURL())
    .setDescription([
      `<@${id}> • ${p?.position ?? 'должность не определена'}${p?.senior ? ' • старший состав' : ''}`,
      `Статус: **${status}**${off ? ' • распределение жалоб выключено' : ''}`,
    ].join('\n'))
    .addFields(
      section('Жалобы', lastC.map(complaintLine), 'Жалоб не было'),
      col('Всего', cs.total), col('В работе', cs.active), col('Просрочено', cs.overdue),
      col('Удовлетворено', cs.sat), col('Отклонено', cs.rej), col('Средний срок', avg),

      section('Уголовные дела', lastCases.map(caseLine), 'Дел не было'),
      col('Всего', casesTotal), col('Одобрено', cases.approved), col('На рассмотрении', cases.pending),
      col('На доработке', cases.rework), col('Отклонено', cases.rejected), col('Рассмотрел чужих', reviewed),

      section('Отпуска', [
        ...(now ? [`Сейчас в отпуске: ${mskDate(now.start_ts)} — ${mskDate(now.end_ts)}`] : []),
        ...vac.slice(0, 3).map((v) => `${mskDate(v.start_ts)} — ${mskDate(v.end_ts)}, ${VAC_STATE[v.status] ?? v.status}`),
      ], 'Отпусков не было'),
      col('Одобрено', approved.length), col('Дней', vacDays), col('На рассмотрении', vac.filter((v) => v.status === 'pending').length),

      section('Кураторство', [asMentee ? `Его куратор: <@${asMentee.mentor_id}>` : 'Курируемым не был'], ''),
      col('Ведёт сейчас', asMentor.active), col('Успешно', asMentor.done), col('Неуспешно', (asMentor.failed ?? 0) + (asMentor.refused ?? 0)),
      ...(resign ? [section('Увольнение', [`Заявление от ${mskDate(resign.created_ts)}: ${{ pending: 'на рассмотрении', approved: 'одобрено', rejected: 'отклонено' }[resign.status] ?? resign.status}`], '')] : []))
    .setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH, __noLogo: true });
}
