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
/**
 * Пункты шаблона жалобы из первого сообщения темы:
 *  violator  — «2. Сведения о нарушителе»;
 *  applicant — имя из «1. Сведения о заявителе (имя, фамилия, номер паспорта)» без номера паспорта.
 * Аккаунт на форуме часто не совпадает с именем персонажа, поэтому заявителя берём из текста жалобы.
 */
export async function fetchComplaintDetails(url) {
  const $ = cheerio.load(await fetchHtml(url));
  // с переносами строк (как в «Кратком содержании»), без markdown-звёздочек, которые заявители копируют в шаблон
  const text = postText($, $('.message-body .bbWrapper').first())
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*+/g, '');
  const v = /Сведения о нарушителе[^:\n]*:\s*([\s\S]*?)(?=\n\s*3\s*[.)]|\s3\s*[.)]\s*Подроб|$)/i.exec(text);
  // шаблоны разные: «1. Сведения о заявителе (…):», «1. Ваше Имя и Фамилия:», «1. ФИО:»
  const a = /Сведения о заявителе[^:\n]*:\s*([^\n]*)/i.exec(text)
    ?? /(?:^|\n)\s*1\s*[.)][^:\n]*(?:заявител|имя|фамили|фио)[^:\n]*:\s*([^\n]*)/i.exec(text)
    // не по шаблону (ходатайство, обращение в свободной форме): «От Horhe Velaskes», «Я, Horhe Velaskes, …»
    ?? /(?:^|\n)\s*От\s+([^\n]{3,80})/.exec(text)
    ?? /(?:^|[\s.])Я,\s*([^,\n]{3,60}),/.exec(text);
  return {
    violator: v ? v[1].replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) || null : violatorFromText(text),
    applicant: a ? applicantName(a[1]) : null,
  };
}

/**
 * Нарушитель в тексте не по шаблону: «…проверке законности действий генерального прокурора Nick Rice».
 * Берём начало текста без адресата («в Офис Генерального прокурора штата …»), иначе любое обращение считалось бы жалобой на ГП.
 */
function violatorFromText(text) {
  const intro = text.slice(0, 1000)
    .replace(/офис\S*\s+генеральн\S*\s+прокурор\S*(\s+штата(\s+[А-ЯЁA-Z][\w-]*){1,2})?/gi, ' ').replace(/\bОГП\b/g, ' ');
  const m = /(?:действи\S*|бездействи\S*|жалоб\S*\s+на|нарушени\S*\s+со\s+стороны|в\s+отношении)\s+([^.\n]{3,150})/i.exec(intro);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Полный текст первого сообщения темы (для кнопки «Подробно» в жалобе) */
export async function fetchFirstPost(url) {
  return (await fetchPost(url)).text;
}

/** Тема форума: заголовок и текст первого сообщения (для /analyze по ссылке на форум) */
export async function fetchPost(url) {
  const $ = cheerio.load(await fetchHtml(url));
  const title = $('h1.p-title-value').first().text().replace(/\s+/g, ' ').trim();
  const body = $('.message-body .bbWrapper').first();
  return { title, text: postText($, body) };
}

/**
 * Тема для проверки оснований отказа: заголовок, текст первого сообщения и его оформление.
 * Регламент (ст. 3 ч. 2): шрифт 15, белый, без жирного, курсива, подчёркивания и зачёркивания.
 * Стандартный текст форума так и выглядит — нарушение видно только по тегам в коде страницы.
 */
export async function fetchPostDoc(url) {
  const $ = cheerio.load(await fetchHtml(url));
  const title = $('h1.p-title-value').first().clone().children('.label, .label-append').remove().end().text().replace(/\s+/g, ' ').trim();
  const body = $('.message-body .bbWrapper').first();
  const has = (sel) => body.find(sel).filter((_, e) => $(e).text().trim()).length > 0;
  const styles = body.find('[style]').map((_, e) => $(e).attr('style')).get();
  const colors = styles.map((s) => /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(s)?.[1]?.trim().toLowerCase()).filter(Boolean)
    .filter((c) => !/^(white|#fff(fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/.test(c));
  // картинки в тексте (ксерокопия паспорта вставлена изображением, а не ссылкой); смайлики не считаем
  const images = body.find('img').filter((_, e) => !$(e).hasClass('smilie')).length;
  const sizes = styles.map((s) => /font-size\s*:\s*([^;]+)/i.exec(s)?.[1]?.trim()).filter(Boolean).filter((s) => s !== '15px');
  const format = {
    bold: has('b, strong'), italic: has('i, em'), underline: has('u, ins'), strike: has('s, strike, del'),
    color: colors.length > 0, size: sizes.length > 0,
  };
  return { title, text: postText($, body), format, images };
}

/** Ссылка на тему форума gta5rp.com (только https и только /threads/…), иначе null */
export function forumThreadUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' || u.hostname !== 'forum.gta5rp.com' || !/^\/threads\/[^/]+\.\d+/.test(u.pathname)) return null;
    return `${BASE}${/^\/threads\/[^/]+\.\d+/.exec(u.pathname)[0]}/`;
  } catch { return null; }
}

function postText($, body) {
  body.find('script, style, noscript').remove(); // служебный код форума (окно просмотра картинок) — не текст жалобы
  // список форума ([LIST=1]): номера пунктов «1. … 7.» рисует браузер, в тексте их нет — дописываем
  body.find('ol').each((_, ol) => {
    const start = Number($(ol).attr('start')) || 1;
    $(ol).children('li').each((k, li) => { $(li).prepend(`\n${start + k}. `).append('\n'); });
  });
  body.find('ul').children('li').each((_, li) => { $(li).prepend('\n• ').append('\n'); });
  // ссылки на доказательства сохраняем в виде [текст](адрес) — в «Подробно» они кликабельны
  body.find('a[href]').each((_, a) => {
    let url = null;
    try {
      let u = new URL($(a).attr('href'), BASE);
      // внешние ссылки форум прячет за gta5rp.com/away?to=… — показываем настоящий адрес
      if (u.pathname === '/away' && u.searchParams.get('to')) u = new URL(u.searchParams.get('to'));
      if (/^https?:$/.test(u.protocol)) url = u.href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
    } catch { /* битая ссылка */ }
    const label = $(a).text().replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim() || 'ссылка';
    $(a).replaceWith($('<span>').text(url ? `[${label.slice(0, 120)}](${url})` : label));
  });
  body.find('br').replaceWith('\n');
  return body.text().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** «Robby Blanc | 269587» → «Robby Blanc»: отрезаем паспорт и разделители */
export function applicantName(s) {
  const name = String(s).replace(/[*[\]]/g, '')
    // «гражданин штата Сан-Андреас Марио Бонг», «гр. Марио Бонг» → «Марио Бонг»
    .replace(/^\s*(?:я,?\s*)?(?:граждан\S*|гр\.)\s+(?:штата\s+[^\s,]+\s+)?/i, '')
    .split(/[|,;/#(]|\s[-–—]\s|\s№|\d{3,}|\s(?:id|айди|паспорт|пасспорт|пасп|номер|ном|pass|passport|п\.)(?=[\s.:№-]|$)/i)[0].replace(/[\s.:-]+$/, '').replace(/\s+/g, ' ').trim();
  // текст из образца шаблона («От Имя Фамилия», «Я, *Имя фамилия*, …») — заявитель не указан
  if (/^(имя|фамилия|ф\.?и\.?о\.?|name|surname|nick ?name|ник)([\s_]+(имя|фамилия|отчество|name|surname))*$/i.test(name)) return null;
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
