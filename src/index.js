import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  COMMAND_PERMS, access, can, denyText, handleAccess, setAccessChangeHook, setAccessClient, syncProsecutorRecord, trustedUsers,
} from './access.js';
import { installPeopleSync, scheduleSync, syncPeople } from './people.js';
import { initAllowedGuilds, isAllowedGuild, leaveIfForeign } from './guard.js';
import { backupDb } from './db.js';
import { backfillApplicants, handleComponent, poll, refreshOpenCards } from './complaints.js';
import { autoAssign, checkDeadlines } from './deadlines.js';
import * as admin from './admin.js';
import * as cases from './cases.js';
import * as vac from './vacations.js';
import * as res from './resign.js';
import * as mnt from './mentoring.js';
import { faq, handleFaq } from './faq.js';
import { handleSettings, settings } from './settings.js';
import { handleForm, pollForms } from './forms.js';
import { autosetup, handleAuto } from './autosetup.js';
import { cabinet, handleCab } from './cabinet.js';
import { EPH, prettyPayload } from './util.js';
import { installLogo } from './logo.js';
import { acquireLock } from './lock.js';
import { analyze, handleDoc } from './analyze.js';

const { DISCORD_TOKEN } = process.env;
const POLL_MS = Math.max(10, Number(process.env.POLL_SECONDS || 30)) * 1000;
if (!DISCORD_TOKEN) throw new Error('Заполните DISCORD_TOKEN в .env');

// Ошибка в одном обработчике не должна ронять бота целиком
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

acquireLock();
installLogo();

/** Слэш-команды → обработчики */
const commandHandlers = {
  access, setup: admin.setup, panels_list: admin.panelsList, panel_delete: admin.panelDelete,
  register_prosecutors: admin.registerProsecutors, sync_judges: admin.syncJudges,
  check_members: admin.checkMembers, invite_missing: admin.inviteMissing,
  broadcast: admin.broadcast, clear_all_dm: admin.clearAllDm,
  force_parse: admin.forceParse, debug_forum: admin.debugForum,
  check_deadlines: admin.checkDeadlinesCmd, deadline_responsible: admin.deadlineResponsible,
  check_responsible: admin.checkResponsible, sync: admin.sync, senior_keywords: admin.seniorKeywords,
  complaints: admin.complaintsStats, find_complaint: admin.findComplaint, faq, cabinet,
  vacation: vac.vacation, vacations: vac.vacations, cancel_vacation: vac.cancelVacation,
  register_case: cases.registerCase, case: cases.caseInfo, cases: cases.casesStats,
  my_cases: cases.myCases, request_case: cases.requestCase, curators: mnt.curators, autosetup, settings, analyze,
};

/** Кнопки, списки и формы → обработчики по префиксу customId */
const componentHandlers = {
  c: handleComponent, case: cases.handleCase, faq: handleFaq, mnt: mnt.handleMentoring,
  res: res.handleResign, vac: vac.handleVac, cab: handleCab, auto: handleAuto, acc: handleAccess, set: handleSettings, form: handleForm, doc: handleDoc,
};

const loop = (name, ms, fn) => {
  const run = async () => {
    try { await fn(); } catch (e) { console.error(`${name} error:`, e.message); }
    setTimeout(run, ms);
  };
  run();
};

/** Все текстовые ответы бота оформляются карточками в едином стиле (см. prettyPayload) */
function prettify(i) {
  for (const m of ['reply', 'editReply', 'followUp', 'update']) {
    if (typeof i[m] !== 'function') continue;
    const orig = i[m].bind(i);
    i[m] = (p) => orig(prettyPayload(p, m === 'editReply' || m === 'update'));
  }
}

async function route(client, i) {
  prettify(i);
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

  // подсказки при вводе: /setup panel (несколько панелей через «;»)
  if (i.isAutocomplete()) return i.commandName === 'setup' ? admin.setupAutocomplete(i) : i.respond([]).catch(() => {});
  if (i.isChatInputCommand()) {
    const need = COMMAND_PERMS[i.commandName];
    if (need && !can(i, need)) return i.reply({ content: denyText(i.commandName, need), plain: true, ...EPH });
    return Object.hasOwn(commandHandlers, i.commandName) ? commandHandlers[i.commandName](client, i) : undefined;
  }
  const prefix = (i.customId ?? '').split(':')[0];
  return Object.hasOwn(componentHandlers, prefix) ? componentHandlers[prefix](client, i) : undefined;
}

/**
 * Server Members Intent нужен для /register_prosecutors, /sync_judges, /check_members и роли «Отпуск».
 * Если он не включён в Developer Portal, бот не падает, а запускается без него (эти функции тогда недоступны).
 * Принудительно без него: USE_MEMBERS_INTENT=0.
 */
function boot(useMembers) {
  if (!useMembers) console.warn('⚠️ Запуск без Server Members Intent: /register_prosecutors, /sync_judges, /check_members и роль «Отпуск» не работают. Включите интент в Developer Portal → Bot.');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, ...(useMembers ? [GatewayIntentBits.GuildMembers] : [])],
    // бот упоминает только конкретных людей и роли; @everyone/@here не сработают ни при каком тексте
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
  });

  // добавили на сервер: свой — регистрируем команды, чужой — сразу выходим
  client.on('guildCreate', async (g) => {
    if (await leaveIfForeign(g)) return;
    admin.registerGuildCommands(client, g);
  });
  setAccessClient(client); // права по названиям ролей серверов
  // базы прокуроров и судей — по ролям, без /register_prosecutors
  installPeopleSync(client);
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
    backfillApplicants(client).then(() => refreshOpenCards(client)).then(() => mnt.refreshOpenMentorships(client)).then(() => vac.fixCancelledCards(client))
      .catch((e) => console.error('refresh cards:', e.message));
    console.log(`Запущен как ${client.user.tag}; серверов: ${client.guilds.cache.size}; опрос форума каждые ${POLL_MS / 1000}с`);
    loop('poll', POLL_MS, async () => {
      const n = await poll(client, admin.FORUM_URL);
      if (n) console.log(`Новых жалоб: ${n}`);
    });
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
    });
    loop('backup', 3_600_000, () => { if (backupDb()) console.log('Резервная копия базы сохранена в data/backups'); });
  });

  client.on('interactionCreate', async (i) => {
    // замер скорости: сколько нажатие шло от Discord до бота и сколько бот его обрабатывал
    const got = Date.now();
    const done = () => {
      const total = Date.now() - i.createdTimestamp;
      if (total > 1000) {
        console.warn(`⏱ ${i.commandName ?? i.customId}: всего ${total} мс (доставка ${got - i.createdTimestamp} мс, ` +
          `обработка ${Date.now() - got} мс, пинг ${client.ws.ping} мс)`);
      }
    };
    try {
      await route(client, i);
      done();
      // кнопка от старой версии бота или удалённая команда — отвечаем, а не оставляем «не ответило»
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i.reply({ content: '⚠️ Эта кнопка или команда устарела. Откройте панель или команду заново.', ...EPH });
      }
    } catch (e) {
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
