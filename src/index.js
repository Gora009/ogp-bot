import 'dotenv/config';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Client, GatewayIntentBits, MessageFlags, MessageFlagsBitField, Partials } from 'discord.js';
import {
  COMMAND_PERMS, can, denyText, setAccessChangeHook, setAccessClient, syncProsecutorRecord, trustedUsers,
} from './access.js';
import { installPeopleSync, scheduleSync, syncPeople } from './people.js';
import { initAllowedGuilds, isAllowedGuild, leaveIfForeign } from './guard.js';
import { backupDb } from './db.js';
import { backfillApplicants, handleComponent, poll, recomputeTargets, refreshOpenCards } from './complaints.js';
import { autoAssign, checkDeadlines } from './deadlines.js';
import * as admin from './admin.js';
import * as cases from './cases.js';
import * as vac from './vacations.js';
import * as res from './resign.js';
import * as mnt from './mentoring.js';
import { faq, handleFaq } from './faq.js';
import { handleSettings, settings } from './settings.js';
import { handleForm, pollForms } from './forms.js';
import { handleAuto } from './autosetup.js';
import { cabinet, handleCab } from './cabinet.js';
import { EPH, prettyPayload, rememberName } from './util.js';
import { installLogo } from './logo.js';
import { acquireLock } from './lock.js';
import { installLog, logAction } from './log.js';
import { analyze } from './analyze.js';
import { distribution, profile } from './staff.js';
import { dmRoastEnabled, installDmRoast } from './dmroast.js';

const { DISCORD_TOKEN } = process.env;
const POLL_MS = Math.max(10, Number(process.env.POLL_SECONDS || 30)) * 1000;
if (!DISCORD_TOKEN) throw new Error('Заполните DISCORD_TOKEN в .env');

// Ошибка в одном обработчике не должна ронять бота целиком
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

installLog(); // журнал на сервере: data/logs (см. src/log.js)
// зависания: если что-то надолго заняло бота (тяжёлый расчёт), нажатия в это время ждут — пишем в журнал
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
setInterval(() => {
  const max = Math.round(lag.max / 1e6);
  if (max > 500) console.warn(`⏱ бот был занят ${max} мс подряд (за последнюю минуту)`);
  lag.reset();
}, 60_000).unref();
acquireLock();
installLogo();

/** Слэш-команды → обработчики */
const commandHandlers = {
  setup: admin.setup, panels_list: admin.panelsList, panel_delete: admin.panelDelete,
  check_members: admin.checkMembers, invite_missing: admin.inviteMissing,
  broadcast: admin.broadcast, clear_all_dm: admin.clearAllDm,
  force_parse: admin.forceParse, debug_forum: admin.debugForum,
  check_deadlines: admin.checkDeadlinesCmd,
  check_responsible: admin.checkResponsible, sync: admin.sync, distribution, profile,
  complaints: admin.complaintsStats, find_complaint: admin.findComplaint, faq, cabinet,
  vacation: vac.vacation, vacations: vac.vacations, cancel_vacation: vac.cancelVacation,
  register_case: cases.registerCase, case: cases.caseInfo, case_history: cases.caseHistory, cases: cases.casesStats,
  my_cases: cases.myCases, request_case: cases.requestCase, curators: mnt.curators, settings, analyze,
};

/** Кнопки, списки и формы → обработчики по префиксу customId */
const componentHandlers = {
  c: handleComponent, case: cases.handleCase, faq: handleFaq, mnt: mnt.handleMentoring,
  res: res.handleResign, vac: vac.handleVac, cab: handleCab, auto: handleAuto, set: handleSettings, form: handleForm,
};

/**
 * Фоновая задача раз в ms. flaky — задача ходит на внешний сайт (форум, Google): единичный сбой связи
 * не ошибка, следующая попытка через ms пройдёт — пишем в журнал только с 3-й неудачи подряд и когда снова заработало.
 */
const loop = (name, ms, fn, { flaky = false } = {}) => {
  let fails = 0;
  const run = async () => {
    try {
      await fn();
      if (flaky && fails >= 3) console.log(`${name}: снова работает (было неудач подряд: ${fails})`);
      fails = 0;
    } catch (e) {
      fails++;
      if (!flaky || fails === 3) console.error(`${name} error${flaky ? ' (3 раза подряд)' : ''}:`, e.message);
    }
    setTimeout(run, ms);
  };
  run();
};

/** Общая обработка ответов бота (см. prettyPayload) */
function prettify(i) {
  for (const m of ['reply', 'editReply', 'followUp', 'update']) {
    if (typeof i[m] !== 'function') continue;
    const orig = i[m].bind(i);
    i[m] = (p) => orig(prettyPayload(p, m === 'editReply' || m === 'update'));
  }
  // замер первого ответа Discord (его ждёт человек): когда бот начал отвечать и сколько ответ шёл до Discord
  for (const m of ['reply', 'update', 'deferReply', 'deferUpdate', 'showModal']) {
    if (typeof i[m] !== 'function') continue;
    const orig = i[m].bind(i);
    i[m] = async (...a) => {
      if (i.ackStart) return orig(...a);
      i.ackStart = Date.now();
      try { return await orig(...a); } finally { i.ackEnd = Date.now(); }
    };
  }
}

/**
 * Страховка от «Взаимодействие не удалось»: Discord ждёт первый ответ не дольше 3 секунд.
 * Если обработчик за 1,5 с не ответил (долгая отправка ЛС, медленный Discord), бот сам отвечает «думает…»,
 * а последующие reply/update обработчика превращаются в правку этого ответа — обработчики об этом не знают.
 */
const AUTO_DEFER_MS = 1500;
const EPHEMERAL = MessageFlags.Ephemeral;
const isEphemeral = (p) => !!p && typeof p === 'object' && (p.ephemeral || new MessageFlagsBitField(p.flags ?? 0).has(EPHEMERAL));
/** Правка сообщения не принимает флаг «видно только вам» — он уже задан при ответе */
const forEdit = (p) => {
  if (!p || typeof p !== 'object' || p.flags == null) return p;
  const { ephemeral, ...rest } = p; // eslint-disable-line no-unused-vars
  return { ...rest, flags: new MessageFlagsBitField(p.flags).remove(EPHEMERAL).bitfield };
};

function autoDefer(i) {
  if (!i.isRepliable() || i.isAutocomplete()) return () => {};
  let auto = null; // Promise<'update' | 'reply' | null> — какой ответ бот дал сам
  const wrap = (m, fn) => {
    if (typeof i[m] !== 'function') return; // у слэш-команды нет update/deferUpdate
    const orig = i[m].bind(i);
    i[m] = async (...a) => {
      const kind = auto && await auto;
      return kind ? fn(kind, ...a) : orig(...a);
    };
  };
  // кнопка: бот уже ответил «тихо» (deferUpdate), а обработчик хочет отдельный ответ «думает…» + editReply —
  // его editReply не должен менять карточку: первый становится новым сообщением, следующие правят это сообщение
  let own = null;
  wrap('deferReply', (kind, opts) => { if (kind === 'update') own = { flags: opts?.flags }; });
  wrap('deferUpdate', () => undefined);
  const editReply = i.editReply.bind(i);
  i.editReply = async (p) => {
    if (!own) return editReply(p);
    const body = typeof p === 'string' ? { content: p } : p;
    if (!own.msg) return (own.msg = await i.followUp({ ...body, flags: new MessageFlagsBitField(body.flags ?? 0).add(own.flags ?? 0).bitfield }));
    return editReply({ ...forEdit(body), message: own.msg.id });
  };
  // карточка уже с гербом — правка не прикладывает его второй раз (см. logo.js)
  wrap('update', (kind, p) => i.editReply(p && typeof p === 'object' ? { ...forEdit(p), __edit: true } : p));
  wrap('reply', async (kind, p) => {
    if (kind === 'update') return i.followUp(p);
    if (isEphemeral(p)) return i.editReply(forEdit(p));
    await i.deleteReply().catch(() => {}); // «думает…» было скрытым, а ответ должен видеть весь канал
    return i.followUp(p);
  });
  // таймер — последним: обёртки уже стоят
  const timer = setTimeout(() => {
    if (i.ackStart || i.replied || i.deferred) return;
    const onMessage = i.isMessageComponent() || (i.isModalSubmit() && i.isFromMessage());
    i.autoDeferred = true;
    auto = (onMessage ? i.deferUpdate() : i.deferReply(EPH))
      .then(() => (onMessage ? 'update' : 'reply'), (e) => { console.warn(`автоответ «думает…» не удался: ${e.message}`); return null; });
  }, AUTO_DEFER_MS);
  return () => clearTimeout(timer);
}

async function route(client, i) {
  // в ЛС бот команды не принимает, кроме /analyze (кнопки в ЛС, например «Инструкция» куратору, работают)
  if (!i.inGuild() && i.isChatInputCommand() && i.commandName === 'analyze') return analyze(client, i);
  if (!i.inGuild() && (i.isChatInputCommand() || i.isAutocomplete())) {
    return i.isRepliable() ? i.reply({ content: 'Команды бота работают только на сервере.', ...EPH }) : undefined;
  }
  // чужой сервер (бот ещё не успел выйти) — ничего не делаем
  if (i.inGuild() && !isAllowedGuild(i.guildId)) {
    return i.isRepliable() ? i.reply({ content: 'Этот бот работает только на сервере ОГП.', ...EPH }) : undefined;
  }
  // роли пользователя известны из самого взаимодействия: прокурор попадает в базу сам, флаг «старший состав» актуален
  syncProsecutorRecord(i.member);
  rememberName(i.member);

  if (i.isAutocomplete()) return i.respond([]).catch(() => {});
  if (i.isChatInputCommand()) {
    const need = COMMAND_PERMS[i.commandName];
    if (need && !can(i, need)) return i.reply({ content: denyText(i.commandName, need), plain: true, ...EPH });
    return Object.hasOwn(commandHandlers, i.commandName) ? commandHandlers[i.commandName](client, i) : undefined;
  }
  const prefix = (i.customId ?? '').split(':')[0];
  return Object.hasOwn(componentHandlers, prefix) ? componentHandlers[prefix](client, i) : undefined;
}

/**
 * Server Members Intent нужен для сверки баз сотрудников, /check_members и роли «Отпуск».
 * Если он не включён в Developer Portal, бот не падает, а запускается без него (эти функции тогда недоступны).
 * Принудительно без него: USE_MEMBERS_INTENT=0.
 */
function boot(useMembers) {
  if (!useMembers) console.warn('⚠️ Запуск без Server Members Intent: сверка баз, /check_members и роль «Отпуск» не работают. Включите интент в Developer Portal → Bot.');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, ...(useMembers ? [GatewayIntentBits.GuildMembers] : []),
      // ответы в ЛС (src/dmroast.js): личные сообщения приходят боту, только если он их слушает
      ...(dmRoastEnabled() ? [GatewayIntentBits.DirectMessages] : [])],
    ...(dmRoastEnabled() ? { partials: [Partials.Channel] } : {}),
    // бот упоминает только конкретных людей и роли; @everyone/@here не сработают ни при каком тексте
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    // зависшее соединение с Discord: по умолчанию 15 с × 4 попытки (до минуты тишины) — ждём меньше и повторяем один раз
    rest: { timeout: 10_000, retries: 1 },
  });

  // добавили на сервер: свой — регистрируем команды, чужой — сразу выходим
  client.on('guildCreate', async (g) => {
    if (await leaveIfForeign(g)) return;
    admin.registerGuildCommands(client, g);
  });
  setAccessClient(client); // права по названиям ролей серверов
  // базы прокуроров и судей — по ролям
  installPeopleSync(client);
  installDmRoast(client);
  setAccessChangeHook(() => scheduleSync(client));

  client.once('clientReady', async () => {
    // владелец приложения (или участники команды-владельца) — всегда руководство
    const app = await client.application.fetch().catch(() => null);
    const owner = app?.owner;
    for (const id of owner?.members ? [...owner.members.keys()] : [owner?.id]) if (id) trustedUsers.add(id);
    // только свои серверы: при первом запуске запоминаем текущие, с посторонних выходим
    initAllowedGuilds(client);
    for (const g of [...client.guilds.cache.values()]) await leaveIfForeign(g);
    await admin.registerCommands(client);
    await admin.refreshPanels(client);
    backfillApplicants(client).then(() => recomputeTargets(client)).then(() => refreshOpenCards(client)).then(() => mnt.refreshOpenMentorships(client))
      .catch((e) => console.error('refresh cards:', e.message));
    console.log(`Запущен как ${client.user.tag}; серверов: ${client.guilds.cache.size}; опрос форума каждые ${POLL_MS / 1000}с`);
    loop('poll', POLL_MS, async () => {
      const n = await poll(client, admin.FORUM_URL);
      if (n) console.log(`Новых жалоб: ${n}`);
    }, { flaky: true });
    loop('deadlines', 60_000, () => checkDeadlines(client, admin.FORUM_URL));
    loop('auto-assign', 10_000, async () => {
      const n = await autoAssign(client);
      if (n) console.log(`Автоназначено жалоб: ${n}`);
    });
    if (useMembers) {
      loop('vacation-role', 60_000, () => vac.syncVacationRole(client));
      loop('people', 30 * 60_000, async () => {
        const r = await syncPeople(client);
        if (r) console.log(`Сверка по ролям: прокуроров ${r.prosecutors} (старший состав ${r.seniors}), судей ${r.judges}` + (r.removed ? `, убрано ${r.removed}` : ''));
      });
    }
    loop('mentoring', 60_000, () => mnt.checkMentoring(client));
    loop('forms', 30_000, async () => {
      const n = await pollForms(client);
      if (n) console.log(`Ответов Google Форм: ${n}`);
    }, { flaky: true });
    loop('backup', 3_600_000, () => { if (backupDb()) console.log('Резервная копия базы сохранена в data/backups'); });
  });

  client.on('interactionCreate', async (i) => {
    logAction(i); // в журнал: кто что нажал или вызвал
    // замер скорости до первого ответа (его и ждёт человек; лимит Discord — 3 с):
    // доставка — от нажатия до бота, бот — его работа до ответа, Discord — сколько ответ шёл до Discord
    const got = Date.now();
    const done = () => {
      if (!i.ackStart) return;
      const delivery = got - i.createdTimestamp;
      const bot = i.ackStart - got;
      const api = (i.ackEnd ?? Date.now()) - i.ackStart;
      if (bot > 800 || delivery + bot + api > 2500) {
        console.warn(`⏱ ${i.commandName ?? i.customId}: ответ через ${delivery + bot + api} мс (доставка ${delivery} мс, ` +
          `бот ${bot} мс, Discord ${api} мс, пинг ${client.ws.ping} мс)`);
      }
    };
    prettify(i);
    // страховка не должна мешать самой команде: если она не встала — команда работает без неё
    let stopAutoDefer = () => {};
    try { stopAutoDefer = autoDefer(i); } catch (e) { console.error('autoDefer:', e); }
    try {
      await route(client, i);
      stopAutoDefer();
      done();
      // кнопка от старой версии бота или удалённая команда — отвечаем, а не оставляем «не ответило»
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i.reply({ content: '⚠️ Эта кнопка или команда устарела. Откройте панель или команду заново.', ...EPH });
      }
    } catch (e) {
      stopAutoDefer();
      console.error(`Ошибка в ${i.commandName ?? i.customId}:`, e);
      const msg = { content: '⚠️ Ошибка при выполнении. Попробуйте ещё раз.', ...EPH };
      if (i.deferred || i.replied) i.followUp(msg).catch(() => {}); else i.reply(msg).catch(() => {});
    }
  });

  client.login(DISCORD_TOKEN).catch(async (e) => {
    if (useMembers && /disallowed intents/i.test(e.message)) {
      console.warn('Server Members Intent не включён у этого приложения — перезапускаюсь без него.');
      await client.destroy();
      return boot(false);
    }
    console.error('Не удалось войти в Discord:', e.message);
    process.exit(1);
  });
}

boot(process.env.USE_MEMBERS_INTENT !== '0');
