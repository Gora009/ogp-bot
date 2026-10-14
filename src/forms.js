import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db } from './db.js';
import { can } from './access.js';
import { C, EPH, msk, nowTs, safeText } from './util.js';

/**
 * Google Формы → канал Discord, как вебхук (без кнопок).
 * В таблице с ответами работает маленький скрипт (FORM_SCRIPT): по секретной ссылке он отдаёт новые строки,
 * бот забирает их каждые 30 секунд. Порты на сервере открывать не нужно, после простоя бот догоняет пропущенное.
 */
db.exec(`CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  channel_id TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL, last_error TEXT)`);

export const FORM_SCRIPT = `// Скрипт для бота ОГП: отдаёт новые ответы Google Формы по секретной ссылке.
// Порядок настройки — в сообщении бота после /setup panel:Google Форма.

// Пароль: любой набор латинских букв и цифр. Тот же пароль вводится в боте.
const SECRET = 'замените-на-свой-пароль';
// ID формы: часть адреса формы между /forms/d/ и /edit
// (например, для https://docs.google.com/forms/d/17vgMOY…UAc/edit это 17vgMOY…UAc).
const FORM_ID = 'вставьте-id-формы';

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== SECRET) return out({ error: 'forbidden' });
  try {
    const form = FORM_ID ? FormApp.openById(FORM_ID) : FormApp.getActiveForm();
    if (!form) return out({ error: 'no_form' });
    const all = form.getResponses();
    const since = Math.max(0, Number(e.parameter.since || 0));
    const rows = [];
    for (let k = since; k < all.length && rows.length < 50; k++) {
      const r = all[k];
      rows.push({
        time: Utilities.formatDate(r.getTimestamp(), 'Europe/Moscow', 'dd.MM.yyyy HH:mm'),
        items: r.getItemResponses().map(function (it) {
          const a = it.getResponse();
          return [it.getItem().getTitle(), Array.isArray(a) ? a.join(', ') : String(a)];
        }),
      });
    }
    return out({ title: form.getTitle(), total: all.length, since: since, rows: rows });
  } catch (err) {
    return out({ error: 'script', message: String(err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Запустите один раз вручную (выбрать check → «Выполнить»): выдаёт скрипту разрешение читать форму.
// В журнале должно появиться название формы.
function check() {
  Logger.log(FormApp.openById(FORM_ID).getTitle());
}
`;

/** Только ссылки на веб-приложения Google Apps Script — бот не ходит по произвольным адресам */
const isScriptUrl = (u) => /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/.test(u);

async function fetchRows(form, since) {
  const url = `${form.url}?key=${encodeURIComponent(form.secret)}&since=${since}`;
  // как обычный браузер: на «непонятных» клиентов Google иногда отвечает страницей ошибки
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000), redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Google отдал страницу вместо данных: достаём из неё текст ошибки, чтобы было понятно, что не так
    const msg = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`Google вернул страницу вместо данных (код ${res.status}): «${msg || 'пусто'}»`);
  }
  if (data.error === 'forbidden') throw new Error('неверный пароль (SECRET в скрипте и в боте должны совпадать)');
  if (data.error === 'no_form' || data.error === 'no_sheet') {
    throw new Error('скрипт не видит форму: создайте его из самой формы («⋮» → «Apps Script») или впишите FORM_ID');
  }
  if (data.error === 'script') throw new Error(`ошибка в скрипте: ${data.message}`);
  if (!Array.isArray(data.rows)) throw new Error('неожиданный ответ скрипта');
  return data;
}

/** Карточка одного ответа: вопрос — жирным, ответ — под ним; без кнопок и без герба */
function answerEmbed(form, headers, row, number) {
  // новый скрипт (из формы): { time, items: [[вопрос, ответ]] }; старый (из таблицы): строка таблицы
  let pairs = Array.isArray(row?.items) ? row.items : (headers ?? []).map((q, k) => [q, row[k]]);
  let when = row?.time ?? null;
  if (!row?.items && /отметка времени|timestamp/i.test(pairs[0]?.[0] ?? '')) { when = pairs[0][1]; pairs = pairs.slice(1); }
  const lines = [];
  pairs.forEach(([q, raw], k) => {
    const a = String(raw ?? '').trim();
    if (a) lines.push(`**${safeText(q || `Вопрос ${k + 1}`)}**\n${safeText(a).slice(0, 1000)}`);
  });
  let desc = lines.join('\n\n');
  if (desc.length > 4000) desc = `${desc.slice(0, 3990)}…`;
  // заголовок — «Заявка от Имя Фамилия» из вопроса про имя; если такого вопроса нет — название формы и номер
  const name = String(pairs.find(([q, a]) => /имя|фамили|фио|nick|ник/i.test(q ?? '') && String(a ?? '').trim())?.[1] ?? '').trim();
  const title = name ? `Заявка от ${name}` : `${form.name} — ответ №${number}`;
  return new EmbedBuilder().setColor(C.info).setTitle(title.slice(0, 256))
    .setDescription(desc || '—').setFooter({ text: `Google Форма${when ? ` • ${when}` : ''}` });
}

let running = false;
/** Один проход по всем подключённым формам. Возвращает число отправленных ответов. */
export async function pollForms(client) {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    for (const form of db.prepare('SELECT * FROM forms').all()) {
      try {
        const data = await fetchRows(form, form.seen);
        const ch = data.rows.length ? await client.channels.fetch(form.channel_id) : null;
        let seen = form.seen;
        for (const row of data.rows) {
          seen++;
          await ch.send({ embeds: [answerEmbed(form, data.headers, row, seen)], __noLogo: true });
          db.prepare('UPDATE forms SET seen=? WHERE id=?').run(seen, form.id); // после каждого — чтобы не продублировать
          sent++;
        }
        // строки удалили из таблицы — продолжаем с нового конца
        if (data.total < form.seen) db.prepare('UPDATE forms SET seen=? WHERE id=?').run(data.total, form.id);
        if (form.last_error) db.prepare('UPDATE forms SET last_error=NULL WHERE id=?').run(form.id);
      } catch (e) {
        if (form.last_error !== e.message) console.error(`Форма «${form.name}»: ${e.message}`);
        db.prepare('UPDATE forms SET last_error=? WHERE id=?').run(e.message, form.id);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

/* ---------- подключение: /setup panel:Google Форма → скрипт и кнопка ---------- */
export function setupReply(channelId) {
  return {
    embeds: [new EmbedBuilder().setColor(C.info).setTitle('Google Форма → канал').setDescription([
      `Новые ответы формы будут приходить в <#${channelId}> карточками, без кнопок.`,
      '',
      '**1. Открыть редактор скрипта.** В редакторе формы: «⋮» справа вверху → «Apps Script».',
      '**2. Вставить скрипт.** Удалите всё и вставьте текст из файла ниже. Впишите:',
      '• `SECRET` — свой пароль (латиница и цифры);',
      '• `FORM_ID` — ID формы: часть адреса формы между `/forms/d/` и `/edit`.',
      'Сохраните (Ctrl+S).',
      '**3. Разрешение.** Вверху выберите функцию `check` → «Выполнить» → «Проверить разрешения» → ваш аккаунт → ' +
        '«Дополнительные настройки» → «Перейти…» → «Разрешить». В журнале должно появиться название формы.',
      '**4. Публикация.** «Начать развёртывание» → «Новое развёртывание» → значок шестерёнки → «Веб-приложение»; ' +
        '«Запуск от имени» — Я, «У кого есть доступ» — Все → «Начать развёртывание». Скопируйте URL веб-приложения ' +
        '(начинается с `https://script.google.com/macros/s/`, оканчивается на `/exec`).',
      '**5. Подключение.** Нажмите «Подключить форму», вставьте ссылку и пароль.',
      '',
      '**Если правили скрипт:** «Начать развёртывание» → «Управление развёртываниями» → ✏️ → «Версия: Новая версия» → ' +
        '«Начать развёртывание». Не создавайте новое развёртывание — у него будет другая ссылка.',
      '',
      '-# Старые ответы не присылаются — только те, что придут после подключения. Заголовок карточки — «Заявка от …» из вопроса с именем.',
    ].join('\n'))],
    files: [new AttachmentBuilder(Buffer.from(FORM_SCRIPT, 'utf8'), { name: 'скрипт-для-формы.gs' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`form:add:${channelId}`).setLabel('Подключить форму').setStyle(ButtonStyle.Primary))],
  };
}

const input = (id, label, placeholder, max) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(max));

export async function handleForm(client, i) {
  if (!can(i, 'setup')) return i.reply({ content: '⛔ Нет прав.', ...EPH });
  const [, action, channelId] = i.customId.split(':');
  if (action === 'add') {
    return i.showModal(new ModalBuilder().setCustomId(`form:addm:${channelId}`).setTitle('Подключить Google Форму').addComponents(
      input('name', 'Название (заголовок карточек)', 'Заявки на вступление', 80),
      input('url', 'Ссылка на веб-приложение скрипта', 'https://script.google.com/macros/s/.../exec', 300),
      input('secret', 'Пароль из строки SECRET', 'тот же, что в скрипте', 100)));
  }
  if (action === 'addm') {
    const name = i.fields.getTextInputValue('name').trim();
    const url = i.fields.getTextInputValue('url').trim();
    const secret = i.fields.getTextInputValue('secret').trim();
    if (!isScriptUrl(url)) {
      return i.reply({ content: '⚠️ Нужна ссылка веб-приложения Apps Script: https://script.google.com/macros/s/…/exec', ...EPH });
    }
    await i.deferReply(EPH);
    let data;
    try {
      data = await fetchRows({ url, secret }, 0);
    } catch (e) {
      return i.editReply(`⚠️ Не удалось подключиться: ${e.message}.`);
    }
    // старые ответы не присылаем: начинаем с текущего конца таблицы
    db.prepare('INSERT INTO forms(name,url,secret,channel_id,seen,created_ts) VALUES(?,?,?,?,?,?)')
      .run(name, url, secret, channelId, data.total, nowTs());
    return i.editReply(`✅ Форма «${name}» подключена («${data.title}», ответов сейчас: ${data.total}).\n` +
      `Новые ответы будут приходить в <#${channelId}> в течение 30 секунд.`);
  }
}

/* ---------- для /settings → Система ---------- */
export const listForms = () => db.prepare('SELECT * FROM forms ORDER BY id').all();
export const formLine = (f) => `«${f.name}» → <#${f.channel_id}> — ответов получено: ${f.seen}` +
  (f.last_error ? `\n  ⚠️ ошибка: ${f.last_error}` : '') + ` (с ${msk(f.created_ts)})`;
export const deleteForm = (id) => db.prepare('DELETE FROM forms WHERE id=?').run(id).changes;
