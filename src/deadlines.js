import { EmbedBuilder } from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { fetchThreadState, fetchThreads } from './forum.js';
import { assign, pickAuto, refreshMessage, respondByOf } from './complaints.js';
import { postAlert } from './alerts.js';
import { C, msk, nowTs, sendDM, stamp } from './util.js';
import { conf } from './config.js';

const OPEN_SQL = `SELECT * FROM complaints WHERE status IN ('assigned','accepted') AND assignee_id IS NOT NULL AND close_by IS NOT NULL`;
const FORUM_SYNC_MS = 3 * 60_000; // состояние тем на форуме (ответы, закрытие) — раз в 3 минуты
let lastForumSync = 0;
// тема удалена с форума (404) — больше её не открываем, иначе каждые 3 минуты одна и та же ошибка в журнале
try { db.exec('ALTER TABLE complaints ADD COLUMN forum_gone INTEGER NOT NULL DEFAULT 0'); } catch { /* уже есть */ }

/**
 * Сроки по жалобе (от подачи на форуме): напоминания через 24 и 48 ч, дедлайн закрытия — 72 ч,
 * после него — повтор исполнителю каждые NAG_HOURS ч, пока жалоба не закрыта.
 * Напоминания считаются от дедлайна, поэтому после продления срока сдвигаются вместе с ним.
 */
// значения — в /settings (src/config.js): срок, часы напоминаний, интервал повтора

const left = (sec) => {
  const h = Math.max(0, Math.round(sec / 3600));
  return h >= 24 && h % 24 === 0 ? `${h / 24} ${h / 24 === 1 ? 'сутки' : 'суток'}` : `${h} ч`;
};
/** В журнал сервера: кому и что ушло (видно в journalctl -u ogp-bot) */
const logSent = (what, userId, ok) => console.log(`${what} → ${userId}: ${ok ? 'доставлено' : 'НЕ доставлено (закрыты ЛС или бот заблокирован)'}`);

/** Повтор после просрочки — тоже напоминание, в том же виде, что и первые два */
const nagEmbed = (c, now) =>
  new EmbedBuilder().setColor(C.warn).setTitle('⏰ Напоминание о жалобе')
    .setDescription(`Жалоба **№${c.number ?? '?'}** ещё не закрыта.\n\n` +
      `Срок закрытия истёк **${left(now - c.close_by)}** назад — ${msk(c.close_by)} MSK.\n` +
      'Пожалуйста, завершите работу по жалобе как можно скорее.\n\n' +
      `**Ссылка:** [Открыть на форуме](${c.url})`)
    .setFooter({ text: stamp() });

/** ЛС о просрочке — как в оригинале */
const OVERDUE_TEXT = {
  respond: ['Просрочен дедлайн ответа!', (n) => `Вы не ответили на жалобу **№${n}** в установленный срок.`,
    'Пожалуйста, срочно займитесь этой жалобой!'],
  close: ['Просрочен дедлайн закрытия!', (n) => `Жалоба **№${n}** не закрыта в установленный срок.`,
    'Пожалуйста, завершите работу по жалобе как можно скорее!'],
};
const overdueEmbed = (c, kind) => {
  const [title, line, ask] = OVERDUE_TEXT[kind];
  return new EmbedBuilder().setColor(C.danger).setTitle(`⚠️ ${title}`)
    .setDescription(`${line(c.number ?? '?')}\n\n${ask}\n\n**Ссылка:** [Открыть на форуме](${c.url})`)
    .setFooter({ text: stamp() });
};

/** ЛС о просрочке — только исполнителю; старший состав и ответственные видят просрочку в канале «Просроченные дедлайны» */
const overdueRecipients = (c) => [c.assignee_id].filter(Boolean);
async function notifyOverdue(client, c, kind) {
  const payload = { embeds: [overdueEmbed(c, kind)] };
  for (const id of overdueRecipients(c)) logSent(`Просрочка по жалобе №${c.number}`, id, await sendDM(client, id, payload));
}

const DEEP_PER_SYNC = 5; // сколько старых тем (дальше 3-й страницы) открывать напрямую за один проход

/** Записывает число ответов в теме. Закрытая на форуме тема жалобу в боте не закрывает — это делает человек. */
function applyState(id, { replies }) {
  db.prepare('UPDATE complaints SET replies=?, forum_checked_ts=? WHERE thread_id=?').run(replies, nowTs(), id);
}

/** Обновляет по форуму число ответов и закрытые темы. */
async function syncForum(client, forumUrl, res) {
  const open = db.prepare(`SELECT thread_id, url FROM complaints WHERE status IN ('new','assigned','accepted')`).all();
  if (!open.length) return;
  const byId = new Map((await fetchThreads(forumUrl, 3)).map((t) => [t.id, t]));
  const missing = [];
  for (const c of open) {
    const t = byId.get(c.thread_id);
    if (t) applyState(c.thread_id, t);
    else missing.push(c);
  }
  // темы, ушедшие дальше 3-й страницы: открываем напрямую, по чуть-чуть, начиная с давно не проверенных
  const gone = new Set(db.prepare('SELECT thread_id FROM complaints WHERE forum_gone=1').all().map((r) => r.thread_id));
  const ids = missing.map((c) => c.thread_id).filter((id) => !gone.has(id));
  const order = new Map(db.prepare(`SELECT thread_id, forum_checked_ts FROM complaints WHERE status IN ('new','assigned','accepted')`)
    .all().map((r) => [r.thread_id, r.forum_checked_ts ?? 0]));
  ids.sort((a, b) => order.get(a) - order.get(b));
  for (const id of ids.slice(0, DEEP_PER_SYNC)) {
    const c = missing.find((x) => x.thread_id === id);
    try {
      applyState(id, await fetchThreadState(c.url));
    } catch (e) {
      // тема удалена — больше не проверяем; другая ошибка — отметим проверку, чтобы не застревать на ней
      const deleted = /HTTP 404/.test(e.message);
      db.prepare(`UPDATE complaints SET forum_checked_ts=?${deleted ? ', forum_gone=1' : ''} WHERE thread_id=?`).run(nowTs(), id);
      console.warn(`forum: тема ${id}${deleted ? ' удалена с форума — больше не проверяется' : `: ${e.message}`}`);
    }
  }
}

/**
 * Синхронизирует состояние форума, уведомляет о просрочках и автоназначает «зависшие» жалобы.
 * force — сходить на форум сразу, не дожидаясь трёхминутного интервала (/check_deadlines).
 */
export async function checkDeadlines(client, forumUrl, { force = false } = {}) {
  const res = { closed: 0, reminders: 0, overdueClose: 0, nags: 0, autoAssigned: 0 };
  if (force || Date.now() - lastForumSync >= FORUM_SYNC_MS) {
    lastForumSync = Date.now();
    await syncForum(client, forumUrl, res);
  }

  const now = nowTs();
  const open = db.prepare(OPEN_SQL).all();
  // один раз: открытым непринятым жалобам — срок ответа по новому правилу (24 ч с подачи). Кому уже ушло
  // первое напоминание — повторно не пишем, «просрочен ответ» им не придёт
  if (getSetting('respond_v2') === null) {
    for (const c of open.filter((x) => x.status === 'assigned' && !x.notified_respond)) {
      if (c.remind_stage > 0) db.prepare('UPDATE complaints SET notified_respond=1 WHERE thread_id=?').run(c.thread_id);
      else db.prepare('UPDATE complaints SET respond_by=? WHERE thread_id=?').run(respondByOf(c, c.assigned_ts ?? now), c.thread_id);
    }
    setSetting('respond_v2', '1');
    open.splice(0, open.length, ...db.prepare(OPEN_SQL).all());
  }
  for (const f of open) {
    // 0) не нажал «Принять» до дедлайна ответа (24 ч с подачи) — вместо первого напоминания «⚠️ Просрочен дедлайн ответа!»
    // исполнителю и карточка в канал просрочек; напоминание этого же этапа уже не шлём
    if (f.status === 'assigned' && f.respond_by && now >= f.respond_by && !f.notified_respond) {
      const stageNow = conf.reminderHours().map((h) => conf.deadlineHours() - h).filter((h) => h > 0)
        .filter((h) => now >= f.close_by - h * 3600).length;
      db.prepare('UPDATE complaints SET notified_respond=1, remind_stage=MAX(remind_stage, ?) WHERE thread_id=?').run(stageNow, f.thread_id);
      logSent(`Просрочен ответ по жалобе №${f.number}`, f.assignee_id, await sendDM(client, f.assignee_id, { embeds: [overdueEmbed(f, 'respond')] }));
      await postAlert(client, f, 'respond').catch((e) => console.error('alert:', e.message));
      res.overdueRespond = (res.overdueRespond ?? 0) + 1;
      continue;
    }
    // флаги ставятся до отправки — параллельный проход (/check_deadlines) не продублирует уведомления
    // 1) до дедлайна закрытия исполнителю ничего не пишем — как в оригинале: только «просрочен дедлайн ответа»
    // (выше) и просрочка закрытия (ниже)
    if (f.close_by > now) continue;

    // 2) дедлайн прошёл — ЛС только исполнителю, карточка в канал просрочек
    if (!f.notified_close) {
      db.prepare('UPDATE complaints SET notified_close=1, last_nag_ts=? WHERE thread_id=?').run(now, f.thread_id);
      await notifyOverdue(client, f, 'close');
      res.overdueClose++;
      // карточка в канал «Просроченные дедлайны» (если он поставлен) — там её видят ответственные и старший состав
      await postAlert(client, f, 'close').catch((e) => console.error('alert:', e.message));
      continue;
    }

    // 3) пока не закрыта — повторяем исполнителю каждые NAG_HOURS часов
    const nag = conf.repeatHours();
    if (nag > 0 && now - (f.last_nag_ts ?? 0) >= nag * 3600) {
      db.prepare('UPDATE complaints SET last_nag_ts=? WHERE thread_id=?').run(now, f.thread_id);
      logSent(`Повторное напоминание по жалобе №${f.number}`, f.assignee_id, await sendDM(client, f.assignee_id, { embeds: [nagEmbed(f, now)] }));
      res.nags++;
    }
  }

  res.autoAssigned = await autoAssign(client);
  return res;
}

/** Жалобы, которые никто не взял за AUTO_ASSIGN_SEC, бот назначает сам. Вызывается каждые 10 секунд. */
let assigning = false;
export async function autoAssign(client) {
  const sec = conf.autoAssignSec();
  if (sec < 0 || assigning) return 0; // при 0 подхватывает жалобы, которым сразу никто не подошёл
  assigning = true;
  let n = 0;
  try {
    const stale = db.prepare(`SELECT * FROM complaints WHERE status='new' AND assignee_id IS NULL AND posted_ts<=?`)
      .all(nowTs() - sec);
    for (const c of stale) {
      const uid = pickAuto(c);
      if (!uid) continue; // для этой жалобы подходящих нет (например, нет старшего состава)
      await refreshMessage(client, assign(client, c, uid, true));
      n++;
    }
  } finally {
    assigning = false;
  }
  return n;
}
