import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { db } from './db.js';
import { STATUS as CASE_STATUS } from './cases.js';
import { VAC_STATUS } from './vacations.js';
import { STATUS as MENTOR_STATUS } from './mentoring.js';
import { COLOR, EPH, isOnVacation, msk, mskDate, nowTs, stamp } from './util.js';

const PER = 5;
const PERIODS = { week: 'Неделя', month: 'Месяц', all: 'Всё' };
const VIEWS = { complaints: ['📋', 'Жалобы'], cases: ['📁', 'Дела'], vacation: ['🏖️', 'Отпуск'], load: ['📊', 'Нагрузка'], vacations: ['📈', 'Отпуска'] };
const CSTATUS = { assigned: '📋 назначена', accepted: '🟡 в работе', closed: '🔒 закрыта', new: '⚪ новая' };
const RESULT = { satisfied: 'удовлетворена', rejected: 'отклонена' };

const since = (p) => (p === 'week' ? nowTs() - 7 * 86400 : p === 'month' ? nowTs() - 30 * 86400 : 0);

function page(rows, p) {
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const n = Math.min(Math.max(p, 0), pages - 1);
  return { items: rows.slice(n * PER, n * PER + PER), n, pages };
}

function buttons(view, period, p, pages) {
  const row1 = new ActionRowBuilder().addComponents(
    ...Object.entries(VIEWS).map(([k, [emoji, label]]) =>
      new ButtonBuilder().setCustomId(`cab:${k}:${period}:0`).setLabel(`${emoji} ${label}`)
        .setStyle(view === k ? ButtonStyle.Primary : ButtonStyle.Secondary)));
  const listView = ['complaints', 'cases', 'vacations', 'mentoring'].includes(view);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cab:${view}:${period}:${p - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Primary)
      .setDisabled(!listView || p <= 0),
    new ButtonBuilder().setCustomId(`cab:${view}:${period}:${p + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Primary)
      .setDisabled(!listView || p >= pages - 1),
    ...Object.entries(PERIODS).map(([k, label]) =>
      new ButtonBuilder().setCustomId(`cab:${view}:${k}:0`).setLabel(label)
        .setStyle(period === k ? ButtonStyle.Success : ButtonStyle.Secondary)));
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cab:mentoring:${period}:0`).setLabel('🎓 Кураторство')
      .setStyle(view === 'mentoring' ? ButtonStyle.Primary : ButtonStyle.Secondary));
  return [row1, row2, row3];
}

export function render(i, view = 'main', period = 'all', p = 0) {
  const uid = i.user.id;
  const name = i.member?.displayName ?? i.user.username;
  const from = since(period);
  const e = new EmbedBuilder().setColor(COLOR).setThumbnail(i.user.displayAvatarURL()).setFooter({ text: stamp() });
  let pages = 1;

  if (view === 'main') {
    const active = db.prepare(`SELECT COUNT(*) n FROM complaints WHERE assignee_id=? AND status IN ('assigned','accepted')`).get(uid).n;
    const total = db.prepare('SELECT COUNT(*) n FROM complaints WHERE assignee_id=?').get(uid).n;
    const cases = db.prepare('SELECT COUNT(*) n FROM cases WHERE prosecutor_id=?').get(uid).n;
    const role = i.member?.roles?.highest;
    e.setTitle(`Личный кабинет — ${name}`).addFields(
      { name: 'Должность', value: `⭐ ${role && role.name !== '@everyone' ? role.name : 'Прокурор'}`, inline: true },
      { name: 'Статус', value: isOnVacation(uid) ? '🏖️ В отпуске' : '✅ На службе', inline: true },
      { name: '​', value: '​', inline: true },
      { name: '📋 Активные жалобы', value: String(active), inline: true },
      { name: '📋 Всего жалоб', value: String(total), inline: true },
      { name: '📁 Всего дел', value: String(cases), inline: true },
      { name: '​', value: 'Используйте кнопки ниже для навигации' },
    );
  } else if (view === 'complaints') {
    const rows = db.prepare('SELECT * FROM complaints WHERE assignee_id=? AND assigned_ts>=? ORDER BY assigned_ts DESC').all(uid, from);
    const pg = page(rows, p); pages = pg.pages; p = pg.n;
    e.setTitle(`📋 Мои жалобы — ${PERIODS[period]}`).setDescription(
      pg.items.map((c) => `• **№${c.number ?? '?'}** [открыть](${c.url}) — ${CSTATUS[c.status] ?? c.status}${c.result ? ` (${RESULT[c.result]})` : ''}` +
        (c.status === 'assigned' || c.status === 'accepted' ? `\n  ⏰ закрыть до ${msk(c.close_by)}` : '')).join('\n') ||
      'Жалоб за период нет.').setFooter({ text: `Стр. ${p + 1}/${pages} • ${stamp()}` });
  } else if (view === 'cases') {
    const rows = db.prepare('SELECT * FROM cases WHERE prosecutor_id=? AND created_ts>=? ORDER BY created_ts DESC').all(uid, from);
    const pg = page(rows, p); pages = pg.pages; p = pg.n;
    e.setTitle(`📁 Мои дела — ${PERIODS[period]}`).setDescription(
      pg.items.map((c) => `• **${c.uin}** — ${c.accused} — ${CASE_STATUS[c.status]}`).join('\n') || 'Дел за период нет.')
      .setFooter({ text: `Стр. ${p + 1}/${pages} • ${stamp()}` });
  } else if (view === 'vacation') {
    const n = nowTs();
    const v = db.prepare(`SELECT * FROM vacations WHERE user_id=? AND status IN ('approved','pending') AND end_ts>=?
                          ORDER BY start_ts LIMIT 1`).get(uid, n);
    e.setTitle('🏖️ Мой отпуск').setDescription(v
      ? `**Период:** ${mskDate(v.start_ts)} — ${mskDate(v.end_ts)}\n**Статус:** ${VAC_STATUS[v.status]}`
      : 'Активных и запланированных отпусков нет. Подать заявку: `/vacation`.');
  } else if (view === 'load') {
    const stat = db.prepare(`
      SELECT assignee_id id, COUNT(*) total, SUM(status='closed') closed,
             SUM(notified_respond=1 OR notified_close=1) overdue,
             SUM(status='closed' AND notified_respond=0 AND notified_close=0) clean,
             AVG(CASE WHEN status='closed' AND closed_ts>assigned_ts THEN closed_ts-assigned_ts END) avg_close
      FROM complaints WHERE assignee_id IS NOT NULL AND assigned_ts>=? GROUP BY assignee_id ORDER BY total DESC`).all(from);
    const mine = stat.find((s) => s.id === uid);
    const pct = (n) => (mine?.total ? `${Math.round(((n ?? 0) / mine.total) * 100)}%` : '—');
    const hours = mine?.avg_close ? `${(mine.avg_close / 3600).toFixed(1)} ч` : '—';
    const avg = stat.length ? (stat.reduce((a, s) => a + s.total, 0) / stat.length).toFixed(1) : '0';
    const rank = stat.findIndex((s) => s.id === uid) + 1;
    e.setTitle(`📊 Нагрузка — ${PERIODS[period]}`).addFields(
      { name: 'Получено жалоб', value: String(mine?.total ?? 0), inline: true },
      { name: 'Закрыто', value: String(mine?.closed ?? 0), inline: true },
      { name: 'С просрочкой', value: String(mine?.overdue ?? 0), inline: true },
      { name: 'Среднее по прокурорам', value: avg, inline: true },
      { name: 'Место по нагрузке', value: rank ? `${rank} из ${stat.length}` : '—', inline: true },
      { name: 'Средний срок закрытия', value: hours, inline: true },
      { name: '% просрочек', value: pct(mine?.overdue), inline: true },
      { name: 'Эффективность', value: pct(mine?.clean), inline: true });
  } else if (view === 'vacations') {
    const rows = db.prepare('SELECT * FROM vacations WHERE user_id=? AND created_ts>=? ORDER BY start_ts DESC').all(uid, from);
    const pg = page(rows, p); pages = pg.pages; p = pg.n;
    e.setTitle(`📈 История отпусков — ${PERIODS[period]}`).setDescription(
      pg.items.map((v) => `• ${mskDate(v.start_ts)} — ${mskDate(v.end_ts)} — ${VAC_STATUS[v.status]}`).join('\n') || 'Отпусков за период нет.')
      .setFooter({ text: `Стр. ${p + 1}/${pages} • ${stamp()}` });
  } else if (view === 'mentoring') {
    const rows = db.prepare('SELECT * FROM mentorships WHERE (mentor_id=? OR mentee_id=?) AND created_ts>=? ORDER BY created_ts DESC')
      .all(uid, uid, from);
    const done = rows.filter((m) => m.mentor_id === uid && m.status === 'done').length;
    const pg = page(rows, p); pages = pg.pages; p = pg.n;
    e.setTitle(`🎓 Кураторство — ${PERIODS[period]}`).setDescription(
      (pg.items.map((m) => m.mentor_id === uid
        ? `• **№${m.id}** вы куратор → <@${m.mentee_id}> — ${MENTOR_STATUS[m.status]} — до ${mskDate(m.end_by)}`
        : `• **№${m.id}** ваш куратор: <@${m.mentor_id}> — ${MENTOR_STATUS[m.status]} — до ${mskDate(m.end_by)}`).join('\n') ||
        'Кураторств за период нет.') + `

**Успешно завершено как куратор:** ${done}`)
      .setFooter({ text: `Стр. ${p + 1}/${pages} • ${stamp()}` });
  }
  return { embeds: [e], components: buttons(view, period, p, pages) };
}

export const cabinet = (client, i) => i.reply({ ...render(i), ...EPH });

export function handleCab(client, i) {
  const [, view, period, p] = i.customId.split(':');
  return i.update(render(i, view, period, Number(p)));
}
