import { EmbedBuilder, GatewayIntentBits } from 'discord.js';
import { db, getSetting, setSetting } from './db.js';
import { fetchThreads } from './forum.js';
import { complaintEmbed, lastCatchup, poll, publishByNumber, refreshOpenCards } from './complaints.js';
import { checkDeadlines } from './deadlines.js';
import { caseRegisterPanelPayload, requestPanelPayload } from './cases.js';
import { mentoringPanelPayload, refreshOpenMentorships } from './mentoring.js';
import { DEFAULT_KEYWORDS, getKeywords, setKeywords } from './restricted.js';
import { vacationsPanelPayload } from './vacations.js';
import { SETUP_PANELS, commands } from './commands.js';
import { analyzeCommand } from './analyze.js';
import { syncPeople } from './people.js';
import { conf } from './config.js';
import { alertPing } from './alerts.js';
import { setupReply as formSetupReply } from './forms.js';
import { PERMS, hasRulesFor, isSeniorMember, memberHas } from './access.js';
import { C, COLOR, EPH, cfg, listProsecutors, msk, nowTs, sendDM, stamp } from './util.js';

export const FORUM_URL = process.env.FORUM_URL || 'https://forum.gta5rp.com/forums/zhaloby-v-prokuraturu.2142/';
const embed = (title, desc) => new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(desc || '—').setFooter({ text: stamp() });
const reply = (i, title, desc) => i.reply({ embeds: [embed(title, desc.slice(0, 4000))], ...EPH });

export const PANEL_NAMES = {
  complaints: 'Жалобы', case_register: 'Уголовные дела (регистрация)', case_review: 'Дела на проверку', case_req_cards: 'Запросы дел',
  case_request: 'Дела (Правительство)', vacations: 'Отпуска и увольнения', requests: 'Заявки руководству (отпуска/увольнения)',
  mentoring: 'Кураторство', mentoring_cards: 'Кураторство (карточки)', overdue: 'Просроченные дедлайны', dm_blocked: 'Закрытые ЛС',
};

/**
 * Создаёт/заменяет панель типа type на сервере канала: у каждого сервера свои каналы, и панель одного сервера
 * не трогает такую же панель на другом (карточки уходят во все — см. mirror.js). Старое сообщение панели удаляется.
 */
async function putPanel(client, type, channelId, payload = null) {
  const ch = await client.channels.fetch(channelId);
  const old = db.prepare('SELECT * FROM panels WHERE type=? AND (guild_id=? OR guild_id IS NULL)').all(type, ch.guildId);
  for (const p of old) {
    db.prepare('DELETE FROM panels WHERE id=?').run(p.id);
    if (p.message_id) {
      try { await (await (await client.channels.fetch(p.channel_id)).messages.fetch(p.message_id)).delete(); } catch { /* уже удалено */ }
    }
  }
  const messageId = payload ? (await ch.send(payload)).id : null;
  db.prepare('INSERT INTO panels(type,channel_id,message_id,created_ts,guild_id) VALUES(?,?,?,?,?)').run(type, ch.id, messageId, nowTs(), ch.guildId);
}
const dropPanel = (type, guildId) => db.prepare('DELETE FROM panels WHERE type=? AND (guild_id=? OR guild_id IS NULL)').run(type, guildId);
const panelIn = (type, guildId) => db.prepare('SELECT * FROM panels WHERE type=? AND (guild_id=? OR guild_id IS NULL) ORDER BY id DESC').get(type, guildId);

/** Панели с сообщением и функции, которые их рисуют */
const PANEL_PAYLOADS = {
  case_register: () => caseRegisterPanelPayload(), case_request: () => requestPanelPayload(),
  vacations: () => vacationsPanelPayload(), mentoring: () => mentoringPanelPayload(),
};

/** При запуске перерисовывает опубликованные панели — после обновления бота не нужно заново делать /setup */
export async function refreshPanels(client) {
  for (const p of db.prepare('SELECT * FROM panels WHERE message_id IS NOT NULL').all()) {
    const make = PANEL_PAYLOADS[p.type];
    if (!make) continue;
    try {
      const ch = await client.channels.fetch(p.channel_id);
      await (await ch.messages.fetch(p.message_id)).edit(make());
    } catch (e) {
      console.error(`Панель «${PANEL_NAMES[p.type] ?? p.type}» не обновлена: ${e.message}`);
    }
  }
}

/* ---------- /setup panel:<тип>[; <тип>…] channel:<канал> ---------- */
/** Какое право нужно, чтобы пользоваться панелью (выдаётся в /settings → Доступ) */
const PANEL_ROLE_PERM = { complaints: 'assign', cases: 'case_register', mentoring: 'mentoring', overdue: 'monitor' };

/** «Все панели (Прокуратура)» — набор основных панелей */
const ALL = ['complaints', 'cases', 'cases_gov', 'vacations', 'mentoring'];
const panelName = (v) => SETUP_PANELS.find(([k]) => k === v)?.[1] ?? v;
/** «жалобы; кураторство» → ['complaints', 'mentoring']; нераспознанные — в bad */
function parsePanels(text) {
  const want = [];
  const bad = [];
  for (const part of String(text).split(';').map((x) => x.trim()).filter(Boolean)) {
    const low = part.toLowerCase();
    const hit = SETUP_PANELS.find(([k, n]) => k === low || n.toLowerCase() === low)
      ?? SETUP_PANELS.find(([, n]) => n.toLowerCase().startsWith(low));
    if (!hit) bad.push(part);
    else for (const t of hit[0] === 'all' ? ALL : [hit[0]]) if (!want.includes(t)) want.push(t);
  }
  return { want, bad };
}

export async function setup(client, i) {
  const main = i.options.getChannel('channel');
  // одна панель — один канал («Все панели» раскрывается в несколько, все в этот канал)
  const { want, bad } = parsePanels(i.options.getString('panel'));
  const pairs = want.map((t) => [t, main]);
  await i.deferReply(EPH);
  // Google Форма — не панель с кнопками: присылаем скрипт и кнопку подключения
  if (pairs.length === 1 && pairs[0][0] === 'gform') return i.editReply(formSetupReply(pairs[0][1].id));
  const done = []; // [название, где что] — поля карточки
  const notes = [];
  const gid = main.guildId;

  // всё, что относится к панели (карточки, заявки), приходит в тот же канал
  for (const [panel, ch] of pairs) {
    if (panel === 'complaints') {
      await putPanel(client, 'complaints', ch.id);
      done.push(['📝 Жалобы', `Новые жалобы → <#${ch.id}>`]);
    }
    if (panel === 'cases') {
      await putPanel(client, 'case_register', ch.id, caseRegisterPanelPayload());
      // карточки на проверку — в свой канал, если он выбран на этом сервере («Дела на проверку»), иначе сюда же
      if (!panelIn('case_review', gid)) await putPanel(client, 'case_review', ch.id);
      const review = panelIn('case_review', gid).channel_id;
      done.push(['📂 Уголовные дела', `Панель → <#${ch.id}>\nКарточки на проверку → <#${review}>` +
        (review === ch.id ? '\n-# Отдельный канал для карточек: `/setup panel:Дела на проверку`' : '')]);
    }
    if (panel === 'case_review') {
      await putPanel(client, 'case_review', ch.id);
      done.push(['⚖️ Дела на проверку', `Карточки новых дел → <#${ch.id}>` +
        (panelIn('case_req_cards', gid) ? '' : '\nЗапросы дел — тоже сюда, пока не выбран отдельный канал: `/setup panel:Запросы дел`')]);
    }
    if (panel === 'case_req_cards') {
      await putPanel(client, 'case_req_cards', ch.id);
      done.push(['📨 Запросы дел', `Запросы доступа к делам (одобрить / отклонить) → <#${ch.id}>`]);
    }
    if (panel === 'cases_gov') {
      await putPanel(client, 'case_request', ch.id, requestPanelPayload());
      done.push(['🏛️ Дела (Правительство)', `Панель «Запросить дело» → <#${ch.id}>`]);
    }
    if (panel === 'vacations') {
      await putPanel(client, 'vacations', ch.id, vacationsPanelPayload());
      dropPanel('requests', gid);
      done.push(['🏖️ Отпуска и увольнения', `Панель и заявки руководству → <#${ch.id}>`]);
    }
    if (panel === 'mentoring') {
      await putPanel(client, 'mentoring', ch.id, mentoringPanelPayload());
      await putPanel(client, 'mentoring_cards', ch.id);
      done.push(['🎓 Кураторство', `Панель и карточки кураторств → <#${ch.id}>`]);
    }
    if (panel === 'overdue') {
      await putPanel(client, 'overdue', ch.id);
      done.push(['⏰ Просроченные дедлайны', `Карточки просрочек → <#${ch.id}>`]);
      notes.push(`Упоминаются ответственные за дедлайны: ${alertPing(ch) || 'пока никто — добавьте их в `/settings` → Жалобы или `/deadline_responsible`'}`);
    }
    if (panel === 'dm_blocked') {
      await putPanel(client, 'dm_blocked', ch.id);
      done.push(['🔕 Закрытые ЛС', `Сообщения о тех, кому бот не смог написать в ЛС (закрыты ЛС или бот заблокирован) → <#${ch.id}>`]);
    }
    const perm = PANEL_ROLE_PERM[panel];
    if (perm && panel !== 'overdue' && !hasRulesFor(perm)) {
      notes.push(`**${panelName(panel)}: роль не выбрана** — пока панелью пользуются ${panel === 'cases' ? 'зарегистрированные прокуроры' : 'владелец сервера и руководство'}.\n` +
        `Добавить роль: \`/settings\` → Доступ → «${PERMS[perm][0]}».`);
    }
  }
  if (pairs.some(([t]) => t === 'gform')) notes.push('Google Форма подключается отдельной командой: `/setup panel:Google Форма`.');
  if (bad.length) notes.push(`Не понял: ${bad.map((x) => `«${x}»`).join(', ')}. Выберите панели из подсказок.`);
  if (!done.length) return i.editReply(notes.join('\n\n') || 'Не выбрано ни одной панели.');

  const e = new EmbedBuilder().setColor(C.success).setTitle(done.length > 1 ? '✅ Панели настроены' : '✅ Панель настроена')
    .addFields(done.map(([name, value]) => ({ name, value })))
    .setFooter({ text: stamp() });
  if (notes.length) e.setDescription(notes.join('\n\n'));
  return i.editReply({ embeds: [e] });
}

export async function panelsList(client, i) {
  const rows = db.prepare('SELECT * FROM panels ORDER BY id').all();
  const lines = rows.map((p) => `**#${p.id}** ${PANEL_NAMES[p.type] ?? p.type} → <#${p.channel_id}>`);
  const env = [
    ['VACATION_ROLE_ID', 'Роль «Отпуск»'],
    ['PROSECUTION_GUILD_ID', 'Сервер Прокуратуры'],
  ].map(([k, label]) => `${cfg(k) || (k === 'VACATION_ROLE_ID' && getSetting('vacation_role_id')) ? '✅' : '⚠️'} ${label} (\`${k}\`)`);
  env.push('Доступ, роли прокуроров и судей: /access list');
  return reply(i, 'Зарегистрированные панели', `${lines.join('\n') || 'Панелей нет. Используйте /setup.'}\n\n**Настройки .env:**\n${env.join('\n')}`);
}

/** Убирает панель: запись из базы и её сообщение в канале. Возвращает удалённую запись или null. */
export async function removePanel(client, id) {
  const p = db.prepare('SELECT * FROM panels WHERE id=?').get(id);
  if (!p) return null;
  db.prepare('DELETE FROM panels WHERE id=?').run(p.id);
  if (p.message_id) {
    try { await (await (await client.channels.fetch(p.channel_id)).messages.fetch(p.message_id)).delete(); } catch { /* уже удалено */ }
  }
  return p;
}

export async function panelDelete(client, i) {
  const type = i.options.getString('panel_type');
  const ch = i.options.getChannel('channel');
  const rows = db.prepare('SELECT id FROM panels WHERE type=? AND (guild_id=? OR guild_id IS NULL)' + (ch ? ' AND channel_id=?' : ''))
    .all(...(ch ? [type, i.guildId, ch.id] : [type, i.guildId]));
  if (!rows.length) return i.reply({ content: 'Панель не найдена.', ...EPH });
  for (const r of rows) await removePanel(client, r.id);
  return i.reply({ content: `✅ Панель «${PANEL_NAMES[type] ?? type}» удалена${ch ? ` из <#${ch.id}>` : ''}.`, ...EPH });
}

/* ---------- люди ---------- */
/** Участники сервера, у которых есть право perm (выданное роли или лично). */
async function membersWith(guild, perm) {
  const members = await guild.members.fetch();
  return [...members.values()].filter((m) => !m.user.bot && memberHas(m, perm));
}
const NO_RULE = (name) =>
  `Нет ни одной роли с доступом «${name}». Выдайте: /access grant permission:${name} role:@роль`;

/**
 * Список всех участников сервера Discord отдаёт только при включённом Server Members Intent.
 * Без него запрос не падает сразу, а висит ~2 минуты — поэтому проверяем заранее.
 */
const NEED_INTENT = '⚠️ Эта команда читает список всех участников сервера, а для этого в Developer Portal → Bot ' +
  'должен быть включён **Server Members Intent**. Сейчас он выключен.\n' +
  'Прокуроры всё равно попадают в базу сами, когда пользуются ботом (любая команда или кнопка).';
const noMembersIntent = (client) => !client.options.intents.has(GatewayIntentBits.GuildMembers);

/** /register_prosecutors и /sync_judges: сверить прямо сейчас (бот и так делает это сам при каждом изменении ролей) */
async function syncNow(client, i) {
  if (noMembersIntent(client)) return i.reply({ content: NEED_INTENT, ...EPH });
  await i.deferReply(EPH);
  const r = await syncPeople(client);
  if (!r) return i.editReply('⚠️ Не удалось прочитать участников сервера. Попробуйте позже.');
  const warn = [
    ...(hasRulesFor('prosecutor') ? [] : [NO_RULE('Прокурор')]),
    ...(hasRulesFor('judge') ? [] : [NO_RULE('Судья')]),
  ];
  return i.editReply({ embeds: [new EmbedBuilder().setColor(C.success).setTitle('👥 Базы сверены по ролям')
    .addFields(
      { name: 'Прокуроры', value: `**${r.prosecutors}**`, inline: true },
      { name: 'Старший состав', value: `**${r.seniors}**`, inline: true },
      { name: 'Судьи', value: `**${r.judges}**`, inline: true })
    .setDescription(['Делать это вручную не нужно: бот обновляет базы сам, когда роли выдают или снимают.',
      ...(r.removed ? [`Убрано из базы (нет роли): **${r.removed}**`] : []), ...warn].join('\n\n'))
    .setFooter({ text: stamp() })] });
}
export const registerProsecutors = syncNow;
export const syncJudges = syncNow;

async function missingMembers(client, i) {
  const gid = conf.prosecutionGuildId();
  if (!gid) return { error: 'Не задан сервер Прокуратуры: `/settings` → Система.' };
  let pg;
  try { pg = await client.guilds.fetch(gid); } catch { return { error: 'Бот не состоит на сервере Прокуратуры.' }; }
  const there = await pg.members.fetch();
  const all = await membersWith(i.guild, 'prosecutor');
  if (!all.length) return { error: NO_RULE('Прокурор') };
  return { pg, missing: all.filter((m) => !there.has(m.id)) };
}

export async function checkMembers(client, i) {
  if (noMembersIntent(client)) return i.reply({ content: NEED_INTENT, ...EPH });
  await i.deferReply(EPH);
  const r = await missingMembers(client, i);
  if (r.error) return i.editReply(r.error);
  return i.editReply({
    embeds: [embed('Отсутствуют в ДС Прокуратуры', r.missing.map((m) => `• <@${m.id}> (${m.displayName})`).join('\n') || 'Все на месте ✅')],
  });
}

export async function inviteMissing(client, i) {
  if (noMembersIntent(client)) return i.reply({ content: NEED_INTENT, ...EPH });
  await i.deferReply(EPH);
  const r = await missingMembers(client, i);
  if (r.error) return i.editReply(r.error);
  const ch = r.pg.channels.cache.find((c) => c.isTextBased() && !c.isThread() && c.permissionsFor(r.pg.members.me)?.has('CreateInstantInvite'));
  if (!ch) return i.editReply('Нет канала на сервере Прокуратуры, где у бота есть право создавать приглашения.');
  let sent = 0;
  for (const m of r.missing) {
    const inv = await ch.createInvite({ maxAge: 7 * 86400, maxUses: 1, unique: true });
    if (await sendDM(client, m.id, { embeds: [embed('Приглашение в ДС Прокуратуры', `Вы отсутствуете на сервере Прокуратуры.\n${inv.url}`)] })) sent++;
  }
  return i.editReply(`Приглашений отправлено: ${sent} из ${r.missing.length} (у остальных закрыты ЛС).`);
}

/**
 * Кому слать рассылку. С Server Members Intent — все участники сервера с правом «Прокурор»/старший состав
 * (или с выбранной ролью), без него — только прокуроры из базы бота.
 */
async function broadcastTargets(client, i, role) {
  if (noMembersIntent(client)) {
    if (role) return { error: `Рассылка по роли читает список участников сервера.\n${NEED_INTENT}` };
    return { ids: listProsecutors().map((p) => p.user_id), source: 'прокуроры из базы бота (Server Members Intent выключен)' };
  }
  const members = await i.guild.members.fetch();
  if (role) {
    return { ids: members.filter((m) => !m.user.bot && m.roles.cache.has(role.id)).map((m) => m.id), source: `участники с ролью <@&${role.id}>` };
  }
  if (!hasRulesFor('prosecutor') && !hasRulesFor('senior')) {
    return { error: 'Бот не знает, какие роли — прокуроры. Выполните `/autosetup` или `/access grant permission:Прокурор role:@роль`.' };
  }
  const ids = new Set(members.filter((m) => !m.user.bot && (memberHas(m, 'prosecutor') || isSeniorMember(m))).map((m) => m.id));
  return { ids: [...ids], source: 'все прокуроры и старший состав сервера' };
}

/** Прямая ссылка на картинку/гифку: её можно показать прямо в карточке */
const IMAGE_URL = /^https?:\/\/\S+\.(gif|png|jpe?g|webp)(\?\S*)?$/i;
/** Страницы с гифками (Tenor, Giphy): Discord сам разворачивает их, если ссылка стоит в тексте сообщения */
const GIF_PAGE = /^https?:\/\/(www\.)?(tenor\.com|giphy\.com|gph\.is)\/\S+$/i;

/** Достаёт из текста рассылки картинку и ссылки на гифки; возвращает очищенный текст */
export function splitMedia(text) {
  let image = null;
  const pages = [];
  // markdown-ссылки вида [image.gif](url) заменяем на сам url
  const clean = text.replace(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, '$1').replace(/https?:\/\/\S+/g, (url) => {
    if (!image && IMAGE_URL.test(url)) { image = url; return ''; }
    if (GIF_PAGE.test(url)) { pages.push(url); return ''; }
    return url;
  });
  return { text: clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), image, pages };
}

export async function broadcast(client, i) {
  await i.deferReply(EPH);
  const role = i.options.getRole('role');
  const file = i.options.getAttachment('image');
  if (file && !/^image\//.test(file.contentType ?? '')) return i.editReply('⚠️ В `image` можно прикрепить только картинку или гифку.');
  const r = await broadcastTargets(client, i, role);
  if (r.error) return i.editReply(r.error);
  if (!r.ids.length) return i.editReply(`Получателей нет (${r.source}).`);

  // карточка с автором рассылки, без герба; картинка/гифка — прямо в карточке
  const { text, image, pages } = splitMedia(i.options.getString('message'));
  const card = new EmbedBuilder().setColor(COLOR).setTitle('Рассылка').setFooter({ text: stamp() })
    .setAuthor({ name: i.member?.displayName ?? i.user.username, iconURL: i.user.displayAvatarURL() });
  if (text) card.setDescription(text.slice(0, 4000));
  const payload = { embeds: [card], __noLogo: true };
  if (file) {
    // файл скачиваем один раз и прикладываем к каждому ЛС: ссылки Discord на вложения со временем истекают
    const name = `broadcast.${(file.name.split('.').pop() || 'png').toLowerCase()}`;
    const buf = Buffer.from(await (await fetch(file.url, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
    payload.files = [{ attachment: buf, name }];
    card.setImage(`attachment://${name}`);
  } else if (image) {
    card.setImage(image);
  }
  if (pages.length) payload.content = pages.join('\n'); // Tenor/Giphy Discord развернёт под карточкой
  let ok = 0;
  const failed = [];
  for (let k = 0; k < r.ids.length; k += 5) { // по 5 параллельно: быстро и без упора в лимиты Discord
    const res = await Promise.all(r.ids.slice(k, k + 5).map((id) => sendDM(client, id, payload)));
    res.forEach((sent, j) => (sent ? ok++ : failed.push(r.ids[k + j])));
  }
  const fail = failed.length
    ? `\n\n⚠️ Не доставлено (закрыты ЛС или нет общего сервера с ботом):\n${failed.slice(0, 40).map((id) => `<@${id}>`).join(' ')}${failed.length > 40 ? ' …' : ''}`
    : '';
  return i.editReply({ content: `Доставлено: ${ok} из ${r.ids.length} (${r.source})${fail}`, plain: true });
}

/**
 * Удаляет ВСЕ сообщения бота в личках. Журнал отправленных ЛС бывает неполным (очистка базы, старые версии),
 * поэтому бот сам проходит по личным чатам со всеми, кому мог писать: сотрудники, судьи, исполнители жалоб,
 * авторы заявок и запросов дел, кураторы — и удаляет каждое своё сообщение в каждом чате.
 */
export async function clearAllDm(client, i) {
  await i.deferReply(EPH);
  const ids = new Set();
  const add = (sql) => { for (const r of db.prepare(sql).all()) if (r.id) ids.add(String(r.id)); };
  add('SELECT user_id id FROM prosecutors');
  add('SELECT user_id id FROM judges');
  add('SELECT DISTINCT assignee_id id FROM complaints');
  add('SELECT DISTINCT user_id id FROM vacations');
  add('SELECT DISTINCT user_id id FROM resignations');
  add('SELECT DISTINCT prosecutor_id id FROM cases');
  add('SELECT DISTINCT requester_id id FROM case_requests');
  add('SELECT DISTINCT mentor_id id FROM mentorships');
  add('SELECT DISTINCT mentee_id id FROM mentorships');
  add('SELECT user_id id FROM deadline_responsible');
  ids.add(i.user.id);
  const chats = new Set(db.prepare('SELECT DISTINCT channel_id FROM dm_log').all().map((r) => r.channel_id));
  for (const id of ids) {
    const dm = await client.users.fetch(id).then((u) => u.createDM()).catch(() => null);
    if (dm) chats.add(dm.id);
  }
  let deleted = 0;
  let failed = 0;
  let done = 0;
  let lastShown = Date.now();
  for (const id of chats) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch?.isDMBased?.()) {
      // история чата — пачками по 100, от новых к старым; удаляем только свои сообщения
      for (let before; ;) {
        const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
        if (!batch?.size) break;
        for (const m of batch.values()) {
          if (m.author.id !== client.user.id) continue;
          if (await m.delete().then(() => true, () => false)) deleted++; else failed++;
        }
        before = batch.last().id;
        if (batch.size < 100) break;
      }
    }
    done++;
    // прогресс раз в 10 секунд — удаление может идти несколько минут (ограничения Discord на скорость)
    if (Date.now() - lastShown > 10_000) {
      lastShown = Date.now();
      await i.editReply(`🗑️ Удаляю… проверено чатов: ${done} из ${chats.size}, удалено сообщений: ${deleted}`).catch(() => {});
    }
  }
  db.prepare('DELETE FROM dm_log').run();
  const text = `🗑️ Готово: удалено сообщений бота в ЛС — ${deleted} (проверено личных чатов: ${chats.size})` +
    (failed ? `\nНе удалось удалить: ${failed} — повторите команду позже.` : '');
  // ответ на команду живёт 15 минут; если удаление шло дольше — итог в ЛС
  return i.editReply(text).catch(() => sendDM(client, i.user.id, { content: text }));
}

/* ---------- ответственные за дедлайны ---------- */
export async function deadlineResponsible(client, i) {
  const action = i.options.getString('action');
  const u = i.options.getUser('user');
  if (action !== 'list' && !u) return i.reply({ content: 'Укажите пользователя (user).', ...EPH });
  if (action === 'add') db.prepare('INSERT OR IGNORE INTO deadline_responsible(user_id) VALUES(?)').run(u.id);
  if (action === 'remove') db.prepare('DELETE FROM deadline_responsible WHERE user_id=?').run(u.id);
  const rows = db.prepare('SELECT user_id FROM deadline_responsible').all();
  return reply(i, 'Ответственные за дедлайны', rows.map((r) => `• <@${r.user_id}>`).join('\n') || 'Список пуст.');
}

export async function checkResponsible(client, i) {
  await i.deferReply(EPH);
  // ответственные — список из /settings → Жалобы и /deadline_responsible; их и тегает канал просрочек
  const ids = new Set(db.prepare('SELECT user_id FROM deadline_responsible').all().map((r) => r.user_id));
  const members = await i.guild.members.fetch().catch(() => null);
  const lines = [];
  for (const id of ids) {
    const m = members?.get(id) ?? await i.guild.members.fetch(id).catch(() => null);
    const name = m?.displayName ?? (await client.users.fetch(id).catch(() => null))?.globalName ?? 'Неизвестный';
    lines.push(`• **${name}** (ID: \`${id}\`) — ${m ? '✅ На сервере' : '❌ Не найден на сервере'}`);
  }
  const e = new EmbedBuilder().setColor(COLOR).setTitle('⏰ Проверка ответственных')
    .setDescription(`⏰ **Ответственные за мониторинг дедлайнов:**\n\n${lines.join('\n') ||
      'Никого нет. Добавьте в \`/settings\` → Жалобы или командой \`/deadline_responsible\`.'}`)
    .setFooter({ text: stamp() });
  return i.editReply({ embeds: [e] });
}

export async function checkDeadlinesCmd(client, i) {
  await i.deferReply(EPH);
  await checkDeadlines(client, FORUM_URL, { force: true });
  // «таймер» — повтор напоминаний по просроченным жалобам (настройка в /settings → Жалобы)
  return i.editReply(`✅ Проверка дедлайнов выполнена. Таймер сброшен на ${conf.repeatHours()} ${hoursWord(conf.repeatHours())}.`);
}
const hoursWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'час' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'часа' : 'часов');

/* ---------- парсер ---------- */
const STATUS_NAMES = { old: '⏭️ пропущена (была на форуме до запуска бота)', new: '🆕 ждёт назначения', assigned: '👤 назначена', accepted: '🛠️ в работе', closed: '✅ закрыта' };

export async function forceParse(client, i) {
  await i.deferReply(EPH);
  const number = i.options.getString('number')?.replace(/\D/g, '');
  if (number) return i.editReply(await publishByNumber(client, FORUM_URL, number));

  const n = await poll(client, FORUM_URL);
  // последние темы форума и что с ними в боте — видно, если какую-то жалобу бот пропустил
  const lines = (await fetchThreads(FORUM_URL)).slice(0, 5).map((t) => {
    const row = db.prepare('SELECT status FROM complaints WHERE thread_id=?').get(t.id);
    const st = t.locked && !row ? '🔒 закрыта на форуме' : STATUS_NAMES[row?.status] ?? '⏳ ещё не обработана';
    return `№${t.number ?? '?'} • ${msk(t.createdTs)} MSK — ${st}`;
  });
  const skipped = lines.some((l) => l.includes('пропущена'));
  const cu = lastCatchup();
  const catchup = cu
    ? `\n\n**После последнего перезапуска** (бот не работал с ${msk(cu.from)} по ${msk(cu.ts)} MSK)\n` +
      `догнано жалоб: **${cu.numbers.length}** — ${cu.numbers.map((x) => `№${x}`).join(', ').slice(0, 900)}`
    : '';
  return i.editReply({
    embeds: [embed('🔄 Принудительный парсинг', `Новых жалоб опубликовано: **${n}**\n\n**Последние темы на форуме:**\n${lines.join('\n')}` +
      catchup + (skipped ? '\n\nОпубликовать пропущенную: `/force_parse number:<номер>`' : ''))],
  });
}

export async function debugForum(client, i) {
  await i.deferReply(EPH);
  const t0 = Date.now();
  try {
    const t = await fetchThreads(FORUM_URL);
    const lines = t.slice(0, 5).map((x) => `№${x.number ?? '?'} • ${x.author} • ${msk(x.createdTs)} MSK • ответов ${x.replies}${x.locked ? ' • 🔒' : ''}`);
    const forumMs = Date.now() - t0;
    return i.editReply({ embeds: [embed('Отладка парсера форума',
      `Форум ответил за **${forumMs} мс**, тем: **${t.length}**\nПинг до Discord: **${client.ws.ping} мс**, ` +
      `ваше нажатие дошло до бота за **${t0 - i.createdTimestamp} мс**\n\n${lines.join('\n')}`)] });
  } catch (e) {
    return i.editReply(`Ошибка парсера: ${e.message}`);
  }
}

/* ---------- жалобы: поиск, статистика ---------- */
export async function findComplaint(client, i) {
  const n = String(i.options.getString('number')).replace(/\D/g, '');
  const rows = db.prepare(`SELECT * FROM complaints WHERE number=? AND status!='old' ORDER BY thread_id`).all(n);
  if (!rows.length) return i.reply({ content: `Жалоба №${n} не найдена.`, ...EPH });
  return i.reply({ embeds: rows.slice(0, 5).map(complaintEmbed), ...EPH });
}

export async function complaintsStats(client, i) {
  const r = db.prepare(`SELECT SUM(status='new') fresh, SUM(status='assigned') assigned, SUM(status='accepted') accepted,
                               SUM(result='satisfied') satisfied, SUM(result='rejected') rejected
                        FROM complaints WHERE status!='old'`).get();
  const e = new EmbedBuilder().setColor(COLOR).setTitle('📋 Статистика жалоб').addFields(
    { name: '🔔 Новые', value: String(r.fresh ?? 0), inline: true },
    { name: '📋 Назначены', value: String(r.assigned ?? 0), inline: true },
    { name: '🟡 В работе', value: String(r.accepted ?? 0), inline: true },
    { name: '🟢 Удовлетворены', value: String(r.satisfied ?? 0), inline: true },
    { name: '🔴 Отклонены', value: String(r.rejected ?? 0), inline: true },
  ).setFooter({ text: stamp() });
  return i.reply({ embeds: [e], ...EPH });
}

/* ---------- /senior_keywords: должности, жалобы на которых идут старшему составу ---------- */
export async function seniorKeywords(client, i) {
  const sub = i.options.getSubcommand();
  const word = (i.options.getString('word') ?? '').trim().toLowerCase();
  let list = getKeywords();
  if (sub === 'add' && word && !list.includes(word)) list = [...list, word];
  if (sub === 'remove') list = list.filter((w) => w !== word);
  if (sub === 'reset') list = [...DEFAULT_KEYWORDS];
  if (sub !== 'list') setKeywords(list);
  const note = sub === 'add' ? `✅ Добавлено: «${word}»\n\n` : sub === 'remove' ? `🗑️ Убрано: «${word}»\n\n` : sub === 'reset' ? '↩️ Список сброшен к стандартному.\n\n' : '';
  return reply(i, '🔒 Должности «руководства»',
    `${note}Если в пункте жалобы «Сведения о нарушителе» есть одно из слов, жалоба идёт только старшему составу:\n` +
    `${list.map((w) => `• ${w}`).join('\n') || '— список пуст, ограничение выключено —'}\n\n` +
    'Слова до 3 букв (ГП, ЗГП) ищутся как отдельные слова, остальные — как часть слова (например, «прокурор» найдёт «Помощник прокурора»).');
}

/* ---------- регистрация команд: на каждом сервере (сразу) или глобально (до часа) ---------- */
/**
 * Команды живут либо на серверах, либо глобально — не в обоих местах сразу, иначе в списке будут дубли.
 * Выбор запоминается и соблюдается при каждом запуске бота.
 */
export async function registerCommands(client) {
  const global = getSetting('commands_scope') === 'global';
  // /analyze всегда глобальная — только так она есть и в ЛС с ботом
  await client.application.commands.set(global ? [...commands, analyzeCommand] : [analyzeCommand]).catch((e) => console.error('global commands:', e.message));
  for (const g of client.guilds.cache.values()) await registerGuildCommands(client, g);
}
export const registerGuildCommands = (client, guild) =>
  client.application.commands.set(getSetting('commands_scope') === 'global' ? [] : commands, guild.id)
    .then(() => console.log(`Команды (${commands.length}) → ${guild.name}`))
    .catch((e) => console.error(`Не удалось зарегистрировать команды на ${guild.name}: ${e.message}`));

/* ---------- /sync ---------- */
export async function sync(client, i) {
  await i.deferReply(EPH);
  const global = !!i.options.getBoolean('global');
  setSetting('commands_scope', global ? 'global' : 'guild');
  await registerCommands(client);
  // карточки и панели на всех серверах — к одному виду
  await refreshPanels(client);
  await refreshOpenCards(client);
  await refreshOpenMentorships(client);
  return i.editReply((global
    ? `Команды (${commands.length}) зарегистрированы глобально, серверные убраны. Появятся у всех в течение часа.`
    : `Команды (${commands.length}) зарегистрированы на всех серверах бота, глобальные убраны.`) +
    '\nПанели и карточки жалоб и кураторств перерисованы на всех серверах.');
}
