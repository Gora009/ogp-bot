import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { STATUS as CASE_STATUS } from './cases.js';
import { positionOf } from './roles.js';
import { messageUrl } from './mirror.js';
import { COLOR, EPH, isOnVacation, mskDate, nowTs, safeText, stamp } from './util.js';

/**
 * /cabinet — личный кабинет, как в оригинале:
 *  главная (должность, статус, жалобы, дела), «Мои жалобы», «Мои дела», «История отпусков» — списки по 5 со стрелками;
 *  «Нагрузка» и «Отпуска» — статистика офиса с графиком и фильтром Неделя / Месяц / Всё.
 */
const PER = 5;
const PERIODS = { week: 'За неделю', month: 'За месяц', all: 'Всё время' };
const STATS = new Set(['load', 'vacations']); // фильтр по периоду — только здесь
const since = (p) => (p === 'week' ? nowTs() - 7 * 86400 : p === 'month' ? nowTs() - 30 * 86400 : 0);
/** «№430» — ссылкой на карточку бота (если её нет — на тему форума), иначе просто текстом */
const linked = (text, url) => (url ? `[${text}](${url})` : text);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function page(rows, p) {
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const n = Math.min(Math.max(p, 0), pages - 1);
  return { items: rows.slice(n * PER, n * PER + PER), n, pages };
}

function buttons(view, period, p) {
  const nav = (k, emoji, label) => new ButtonBuilder().setCustomId(`cab:${k}:${period}:0`).setLabel(label).setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(
      nav('complaints', '📋', 'Жалобы'), nav('cases', '📁', 'Дела'), nav('vacation', '🏖️', 'Отпуск'),
      nav('load', '📊', 'Нагрузка'), nav('vacations', '📈', 'Отпуска')),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cab:${view}:${period}:${p - 1}:prev`).setEmoji('◀️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cab:${view}:${period}:${p + 1}:next`).setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cab:${view}:week:0:f`).setLabel('Неделя').setEmoji('📅').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cab:${view}:month:0:f`).setLabel('Месяц').setEmoji('📅').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cab:${view}:all:0:f`).setLabel('Всё').setEmoji('📊').setStyle(ButtonStyle.Secondary)),
  ];
}

/** Должность по ролям (как в списке выбора прокурора), иначе старшая роль */
function position(member) {
  const top = member?.roles?.highest;
  return positionOf(member) ?? (top && top.name !== '@everyone' ? top.name : 'Прокурор');
}

const personName = (uid) => db.prepare('SELECT name FROM prosecutors WHERE user_id=?').get(uid)?.name ?? null;
/**
 * Имя человека для графиков и списков: ник на сервере (из Discord), иначе имя в базе, иначе имя аккаунта.
 * Без приставки должности: «ГП | Kai» → «Kai». Подгружается заранее — render() синхронный.
 */
async function loadNames(i, ids) {
  const names = new Map();
  for (const id of new Set(ids)) {
    const m = i.guild ? await i.guild.members.fetch(id).catch(() => null) : null;
    const u = m ? null : await i.client?.users.fetch(id).catch(() => null);
    const raw = m?.displayName ?? personName(id) ?? u?.globalName ?? u?.username ?? 'Сотрудник';
    names.set(id, raw.split('|').pop().trim() || raw);
  }
  return names;
}
/** Чьи имена понадобятся разделу: исполнители на графике нагрузки и кто сейчас в отпуске */
function namesNeeded(view, period) {
  const n = nowTs();
  if (view === 'load') {
    return db.prepare(`SELECT assignee_id id FROM complaints WHERE assignee_id IS NOT NULL AND status!='old' AND created_ts>=?
                        GROUP BY assignee_id ORDER BY SUM(status='closed') + SUM(status IN ('assigned','accepted')) DESC LIMIT 6`)
      .all(since(period)).map((r) => r.id);
  }
  if (view === 'vacations') {
    return db.prepare(`SELECT user_id id FROM vacations WHERE status='approved' AND start_ts<=? AND end_ts>=?`).all(n, n).map((r) => r.id);
  }
  return [];
}

/** Картинка-график (Chart.js через quickchart.io) — как в оригинале */
function chartUrl(config) {
  return `https://quickchart.io/chart?w=500&h=300&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

const COMPLAINT_DOT = (c) => (c.status === 'closed'
  ? ({ satisfied: '🟢', rejected: '🔴' }[c.result] ?? '⚪') : c.status === 'accepted' ? '🟡' : '📋');

function vacDot(v, n = nowTs()) {
  if (v.status === 'pending') return '⏳';
  if (v.status === 'rejected') return '❌';
  if (v.status === 'cancelled') return '🚫';
  if (v.start_ts <= n && v.end_ts >= n) return '🏖️';
  return v.end_ts < n ? '✔️' : '✅';
}

export function render(i, view = 'main', period = 'all', p = 0, names = new Map()) {
  const uid = i.user.id;
  const name = i.member?.displayName ?? i.user.globalName ?? i.user.username;
  const e = new EmbedBuilder().setColor(COLOR);

  if (view === 'main') {
    const active = db.prepare(`SELECT COUNT(*) n FROM complaints WHERE assignee_id=? AND status IN ('assigned','accepted')`).get(uid).n;
    const total = db.prepare('SELECT COUNT(*) n FROM complaints WHERE assignee_id=?').get(uid).n;
    const cases = db.prepare('SELECT COUNT(*) n FROM cases WHERE prosecutor_id=?').get(uid).n;
    e.setTitle(`Личный кабинет — ${name}`).setThumbnail(i.user.displayAvatarURL()).addFields(
      { name: 'Должность', value: `⭐ ${position(i.member)}`, inline: true },
      { name: 'Статус', value: isOnVacation(uid) ? '🏖️ В отпуске' : '✅ На службе', inline: true },
      { name: '​', value: '​', inline: true },
      { name: '📋 Активные жалобы', value: String(active), inline: true },
      { name: '📋 Всего жалоб', value: String(total), inline: true },
      { name: '📁 Всего дел', value: String(cases), inline: true },
    ).setFooter({ text: 'Используйте кнопки ниже для навигации' });
  } else if (view === 'complaints') {
    const rows = db.prepare('SELECT * FROM complaints WHERE assignee_id=? ORDER BY created_ts DESC').all(uid);
    const pg = page(rows, p);
    p = pg.n;
    e.setTitle('📋 Мои жалобы').setDescription(pg.items.map((c) =>
      `${COMPLAINT_DOT(c)} **${linked(`№${c.number ?? '?'}`, messageUrl(i.client, 'complaint', c.thread_id, i.guildId) ?? c.url)}** | ${mskDate(c.created_ts)}\n└ ${safeText(clip(c.title ?? '', 48))}`).join('\n\n') || 'Нет жалоб')
      .setFooter({ text: `Страница ${pg.n + 1}/${pg.pages} • Всего: ${rows.length}` });
  } else if (view === 'cases') {
    const rows = db.prepare('SELECT * FROM cases WHERE prosecutor_id=? ORDER BY created_ts DESC').all(uid);
    const pg = page(rows, p);
    p = pg.n;
    e.setTitle('📁 Мои дела').setDescription(pg.items.map((c) =>
      `${(CASE_STATUS[c.status] ?? '•').split(' ')[0]} **${linked(c.uin, messageUrl(i.client, 'case', c.uin, i.guildId))}** | ${mskDate(c.created_ts)}\n└ ${safeText(clip(c.accused ?? '—', 48))}`).join('\n\n') ||
      'Нет уголовных дел')
      .setFooter({ text: `Страница ${pg.n + 1}/${pg.pages} • Всего: ${rows.length}` });
  } else if (view === 'vacation') {
    const rows = db.prepare('SELECT * FROM vacations WHERE user_id=? ORDER BY start_ts DESC').all(uid);
    const pg = page(rows, p);
    p = pg.n;
    e.setTitle('🏖️ История отпусков').setDescription(pg.items.map((v) =>
      `${vacDot(v)} **ID: ${v.id}**\n└ ${mskDate(v.start_ts)} — ${mskDate(v.end_ts)}`).join('\n') || 'Нет истории отпусков')
      .setFooter({ text: pg.pages > 1 ? `Страница ${pg.n + 1}/${pg.pages} • Всего: ${rows.length}` : stamp() });
  } else if (view === 'load') {
    const from = since(period);
    const s = db.prepare(`SELECT SUM(status='new') fresh, SUM(status IN ('assigned','accepted')) work, SUM(status='closed') closed,
                                 SUM(notified_close=1 OR notified_respond=1) overdue,
                                 SUM(status='closed' AND notified_close=0 AND notified_respond=0) clean,
                                 AVG(CASE WHEN status='closed' AND closed_ts>created_ts THEN closed_ts-created_ts END) avg_close
                          FROM complaints WHERE status!='old' AND created_ts>=?`).get(from);
    const eff = s.closed ? `${Math.round(((s.clean ?? 0) / s.closed) * 100)}%` : '—';
    const avg = s.avg_close ? `${(s.avg_close / 3600).toFixed(1)}ч` : '—';
    e.setTitle('📊 Статистика нагрузки').setDescription([
      `📊 **Период:** ${PERIODS[period]}`, '',
      '**Общая статистика:**',
      `• 🔔 Новых: **${s.fresh ?? 0}**`, `• 📋 В работе: **${s.work ?? 0}**`,
      `• ✅ Закрыто: **${s.closed ?? 0}**`, `• ⏰ Просрочено: **${s.overdue ?? 0}**`, '',
      '**Метрики:**', `• ⏰ Средний срок закрытия: **${avg}**`, `• 📈 Эффективность: **${eff}**`,
    ].join('\n')).setFooter({ text: stamp() });
    // график: активные и закрытые по исполнителям (самые нагруженные)
    const per = db.prepare(`SELECT assignee_id id, SUM(status IN ('assigned','accepted')) active, SUM(status='closed') closed
                            FROM complaints WHERE assignee_id IS NOT NULL AND status!='old' AND created_ts>=?
                            GROUP BY assignee_id ORDER BY closed + active DESC LIMIT 6`).all(from);
    if (per.length) {
      e.setImage(chartUrl({
        type: 'bar',
        data: {
          // только имя человека: «ГП | Kai» → «Kai»
          labels: per.map((r) => clip(names.get(r.id) ?? 'Сотрудник', 14)),
          datasets: [
            { label: 'Актив', data: per.map((r) => r.active), backgroundColor: 'rgb(254,231,92)' },
            { label: 'Закр', data: per.map((r) => r.closed), backgroundColor: 'rgb(87,242,135)' },
          ],
        },
      }));
    }
  } else if (view === 'vacations') {
    const from = since(period);
    const n = nowTs();
    const s = db.prepare(`SELECT SUM(status='pending') pending,
                                 SUM(status='approved' AND start_ts>?) upcoming,
                                 SUM(status='approved' AND start_ts<=? AND end_ts>=?) active,
                                 SUM(status='approved' AND end_ts<?) done,
                                 SUM(status='rejected') rejected, SUM(status='cancelled') cancelled,
                                 SUM(CASE WHEN status='approved' THEN (end_ts-start_ts)/86400+1 ELSE 0 END) days
                          FROM vacations WHERE created_ts>=?`).get(n, n, n, n, from);
    const now = db.prepare(`SELECT user_id FROM vacations WHERE status='approved' AND start_ts<=? AND end_ts>=?`).all(n, n)
      .map((v) => (names.has(v.user_id) ? safeText(names.get(v.user_id)) : `<@${v.user_id}>`));
    e.setTitle('📈 Статистика отпусков').setDescription([
      `📈 **Период:** ${PERIODS[period]}`, '',
      '**Статистика отпусков:**',
      `• ⏳ Ожидают одобрения: **${s.pending ?? 0}**`, `• ✅ Одобрено: **${s.upcoming ?? 0}**`,
      `• 🏖️ Активно сейчас: **${s.active ?? 0}**`, `• ✔️ Завершено: **${s.done ?? 0}**`,
      `• ❌ Отклонено: **${s.rejected ?? 0}**`, `• 🚫 Отменено: **${s.cancelled ?? 0}**`, '',
      `📅 **Всего дней отпусков:** ${Math.round(s.days ?? 0)}`, '',
      '🏖️ **Сейчас в отпуске:**', now.join('\n') || 'Никого',
    ].join('\n')).setFooter({ text: stamp() });
    const parts = [['Одобр', s.upcoming, 'rgb(84,160,214)'], ['Актив', s.active, 'rgb(87,242,135)'],
      ['Заверш', s.done, 'rgb(160,170,180)'], ['Откл', s.rejected, 'rgb(237,66,69)']];
    if (parts.some(([, v]) => v)) {
      e.setImage(chartUrl({
        type: 'pie',
        data: { labels: parts.map(([l]) => l), datasets: [{ data: parts.map(([, v]) => v ?? 0), backgroundColor: parts.map(([, , c]) => c) }] },
      }));
    }
  }
  return { embeds: [e], components: buttons(view, period, p) };
}

/**
 * Герб справа — во всех разделах, кроме главной (там аватар). Файл герба прикладываем сами при каждом
 * переключении: на главной его нет, и без этого после неё картинка в других разделах не показалась бы.
 */
const LOGO = fileURLToPath(new URL('../assets/logo.webp', import.meta.url));
function withLogo(payload, view) {
  if (view === 'main') return { ...payload, files: [], attachments: [], __noLogo: true };
  payload.embeds[0].setThumbnail('attachment://logo.webp');
  return { ...payload, files: [new AttachmentBuilder(LOGO, { name: 'logo.webp' })], attachments: [], __noLogo: true };
}

export const cabinet = (client, i) => i.reply({ ...withLogo(render(i), 'main'), ...EPH });

export async function handleCab(client, i) {
  const [, view, period, p, flag] = i.customId.split(':');
  // Неделя / Месяц / Всё — только в «Нагрузке» и «Отпусках»
  if (flag === 'f' && !STATS.has(view)) return i.reply({ content: '❌ Фильтр доступен только для статистики.', ...EPH });
  const v = ['main', 'complaints', 'cases', 'vacation', 'load', 'vacations'].includes(view) ? view : 'main';
  const per = Object.hasOwn(PERIODS, period) ? period : 'all';
  // имена людей из Discord подгружаются заранее — ответ на нажатие должен уйти за 3 секунды, поэтому сначала deferUpdate
  const ids = namesNeeded(v, per);
  if (!ids.length) return i.update(withLogo(render(i, v, per, Number(p) || 0), v));
  await i.deferUpdate();
  return i.editReply(withLogo(render(i, v, per, Number(p) || 0, await loadNames(i, ids)), v));
}
