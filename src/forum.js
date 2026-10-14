import * as cheerio from 'cheerio';
import { pathToFileURL } from 'node:url';

const BASE = 'https://forum.gta5rp.com';

/**
 * Гостям форум отдаёт страницу из кеша, который обновляется раз в 5 минут (X-XF-Cache-Status: HIT) —
 * из-за этого новые жалобы приходили с опозданием до 5 минут. Уникальный параметр в адресе обходит кеш.
 */
const fresh = (url) => `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;

async function fetchHtml(url) {
  const res = await fetch(fresh(url), {
    headers: { 'User-Agent': 'Mozilla/5.0 (TurgovBot)', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Forum HTTP ${res.status}`);
  return res.text();
}

/** Одна страница раздела (1 — первая) */
export const fetchPage = async (url, p) =>
  parseThreads(await fetchHtml(p === 1 ? url : `${url.replace(/\/?$/, '/')}page-${p}`));

/** Убирает повторы: при новых темах во время листания одна и та же тема попадает на две страницы */
export const uniqueThreads = (list) => [...new Map(list.map((t) => [t.id, t])).values()];

/** Темы раздела; pages > 1 — захватывает и следующие страницы. */
export async function fetchThreads(url, pages = 1) {
  const all = [];
  for (let p = 1; p <= pages; p++) all.push(...await fetchPage(url, p));
  return uniqueThreads(all);
}

/**
 * Пункт «2. Сведения о нарушителе (...): <текст>» из первого сообщения жалобы.
 * null — если пункт не найден (другой шаблон).
 */
export async function fetchViolator(url) {
  return (await fetchComplaintDetails(url)).violator;
}

/**
 * Пункты шаблона жалобы из первого сообщения темы:
 *  violator  — «2. Сведения о нарушителе»;
 *  applicant — имя из «1. Сведения о заявителе (имя, фамилия, номер паспорта)» без номера паспорта.
 * Аккаунт на форуме часто не совпадает с именем персонажа, поэтому заявителя берём из текста жалобы.
 */
export async function fetchComplaintDetails(url) {
  const $ = cheerio.load(await fetchHtml(url));
  const text = $('.message-body .bbWrapper').first().text();
  const v = /Сведения о нарушителе[^:\n]*:\s*([\s\S]*?)(?=\n\s*3\s*[.)]|\s3\s*[.)]\s*Подроб|$)/i.exec(text);
  // шаблоны разные: «1. Сведения о заявителе (…):», «1. Ваше Имя и Фамилия:», «1. ФИО:»
  const a = /Сведения о заявителе[^:\n]*:\s*([^\n]*)/i.exec(text)
    ?? /(?:^|\n)\s*1\s*[.)][^:\n]*(?:заявител|имя|фамили|фио)[^:\n]*:\s*([^\n]*)/i.exec(text);
  return {
    violator: v ? v[1].replace(/\s+/g, ' ').trim().slice(0, 400) || null : null,
    applicant: a ? applicantName(a[1]) : null,
  };
}

/** Полный текст первого сообщения темы (для кнопки «Подробно» в жалобе) */
export async function fetchFirstPost(url) {
  const $ = cheerio.load(await fetchHtml(url));
  const body = $('.message-body .bbWrapper').first();
  body.find('br').replaceWith('\n');
  return body.text().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** «Robby Blanc | 269587» → «Robby Blanc»: отрезаем паспорт и разделители */
export function applicantName(s) {
  const name = String(s).split(/[|,;/#]|\s[-–—]\s|\s№|\d{3,}/)[0].replace(/[\s.:-]+$/, '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 ? name.slice(0, 60) : null;
}

/** Запасной вариант — имя из названия темы: «… №328 ГР-А Robby Blanc» → «Robby Blanc» */
export function applicantFromTitle(title) {
  // «ГР-А Robby Blanc», «ГР-КИ Kikimora Povelitel», «от гражданина Narek Salfetkin», «от гражданки …»
  const m = /(?:граждан\S*|ГР[-\s.]*[А-ЯA-Z]{0,3}\.?)\s+([^\d№|]{3,60})$/i.exec(String(title).trim());
  return m ? m[1].replace(/[\s.]+$/, '').trim() : null;
}

/**
 * Состояние одной темы прямо со страницы — для жалоб, которые уже ушли дальше 3-й страницы раздела.
 * replies — сколько ответов видно на первой странице темы (если страниц несколько, считаем «есть ответы»).
 */
export async function fetchThreadState(url) {
  const $ = cheerio.load(await fetchHtml(url));
  const posts = $('article.message--post').length;
  if (!posts) throw new Error('тема не найдена или недоступна');
  return {
    locked: $('.blockStatus-message--locked').length > 0,
    replies: Math.max(0, posts - 1) + ($('.pageNav-page').length ? 1 : 0),
  };
}

export function parseThreads(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.structItem--thread').each((_, el) => {
    const $el = $(el);
    // закреплённые темы (правила) пропускаем
    if ($el.closest('.structItemContainer-group--sticky').length) return;
    const id = Number(($el.attr('class').match(/js-threadListItem-(\d+)/) || [])[1]);
    const a = $el.find('.structItem-title a').last();
    const title = a.text().replace(/\s+/g, ' ').trim();
    const ts = Number($el.find('.structItem-startDate time').attr('data-timestamp'));
    if (!id || !title || !ts) return;
    out.push({
      id,
      title,
      number: (title.match(/[№N]\s*o?\s*(\d{1,6})/i) || [])[1] ?? null,
      author: $el.attr('data-author') || '',
      url: BASE + a.attr('href'),
      createdTs: ts,
      replies: parseInt($el.find('.structItem-cell--meta dd').first().text().replace(/\D/g, ''), 10) || 0,
      locked: $el.hasClass('is-locked'),
    });
  });
  return out;
}

// запуск файла напрямую (npm run test-parse) — показать свежие темы
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t = await fetchThreads('https://forum.gta5rp.com/forums/zhaloby-v-prokuraturu.2142/');
  console.table(t.slice(0, 10).map(({ id, number, author, replies, locked }) => ({ id, number, author, replies, locked })));
}
