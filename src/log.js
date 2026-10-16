import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { format } from 'node:util';

/**
 * Журнал бота на сервере: data/logs/bot-ГГГГ-ММ-ДД.log (день по Москве).
 * Всё, что бот пишет в консоль (сообщения, предупреждения, ошибки), дублируется в файл, плюс действия людей
 * (кто какую команду вызвал и какую кнопку нажал). Прошлые дни сжимаются в .gz (~в 10 раз меньше),
 * хранятся 30 дней и не больше 50 МБ всего — самое старое удаляется само.
 */
export const LOG_DIR = 'data/logs';
const KEEP_DAYS = 30;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_LINE = 2000;

const msk = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const today = () => msk().slice(0, 10);
export const logFile = (day = today()) => path.join(LOG_DIR, `bot-${day}.log`);

let day = null;
let stream = null;

/** Сжать файл прошлого дня и удалить исходник */
async function compress(file) {
  try {
    await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 9 }), fs.createWriteStream(`${file}.gz`));
    fs.unlinkSync(file);
  } catch { /* файл занят или уже сжат — попробуем при следующей смене дня */ }
}

/** Старше 30 дней — удалить; если всё вместе больше 50 МБ — удалять самые старые */
function cleanup() {
  let files;
  try { files = fs.readdirSync(LOG_DIR).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log(\.gz)?$/.test(f)).sort(); } catch { return; }
  const cutoff = new Date(Date.now() + 3 * 3600_000 - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  const keep = [];
  for (const f of files) {
    if (f.slice(4, 14) < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
    else keep.push(f);
  }
  let total = keep.reduce((s, f) => s + (fs.statSync(path.join(LOG_DIR, f), { throwIfNoEntry: false })?.size ?? 0), 0);
  for (const f of keep) {
    if (total <= MAX_TOTAL || f.slice(4, 14) === day) break;
    total -= fs.statSync(path.join(LOG_DIR, f)).size;
    fs.rmSync(path.join(LOG_DIR, f), { force: true });
  }
}

/** Файл текущего дня; при смене дня старый сжимается */
function current() {
  const d = today();
  if (d === day && stream) return stream;
  stream?.end();
  day = d;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  stream = fs.createWriteStream(logFile(d), { flags: 'a' });
  stream.on('error', () => { stream = null; });
  // все несжатые файлы прошлых дней (в том числе оставшиеся после перезапуска) — в .gz
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f) && f !== path.basename(logFile(d))) compress(path.join(LOG_DIR, f)).then(cleanup);
  }
  cleanup();
  return stream;
}

function write(level, text) {
  try {
    const line = text.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, MAX_LINE);
    current()?.write(`${msk().slice(11, 19)} ${level} ${line}\n`);
  } catch { /* журнал не должен ронять бота */ }
}

/** Дублировать консоль в файл. Вызывается один раз при старте. */
export function installLog() {
  for (const [method, level] of [['log', 'INFO '], ['info', 'INFO '], ['warn', 'WARN '], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { orig(...args); write(level, format(...args)); };
  }
}

/**
 * Действие человека: «ОГП | Gora (1012…) → /setup panel=complaints channel=#жалобы» или «→ кнопка c:acc:3425» .
 * Текст из форм не пишем — только что за форма: в журнале не должно быть лишних личных данных.
 */
export function logAction(i) {
  try {
    if (i.isAutocomplete?.()) return;
    const who = `${i.member?.displayName ?? i.user?.globalName ?? i.user?.username ?? '?'} (${i.user?.id})`;
    const where = i.guild?.name ?? 'ЛС';
    let what;
    if (i.isChatInputCommand?.()) {
      const opts = (i.options?.data ?? []).flatMap((o) => (o.options ? [o.name, ...o.options] : [o]))
        .map((o) => (typeof o === 'string' ? o : `${o.name}=${o.channel ? `#${o.channel.name}` : o.user ? `@${o.user.username}` : o.role ? `@${o.role.name}` : String(o.value ?? '').slice(0, 80)}`));
      what = `/${i.commandName}${opts.length ? ` ${opts.join(' ')}` : ''}`;
    } else if (i.isModalSubmit?.()) {
      what = `форма ${i.customId}`;
    } else if (i.isAnySelectMenu?.()) {
      what = `список ${i.customId} = ${(i.values ?? []).join(',').slice(0, 120)}`;
    } else {
      what = `кнопка ${i.customId}`;
    }
    write('ACT  ', `${where} | ${who} → ${what}`);
  } catch { /* не мешаем обработке */ }
}
