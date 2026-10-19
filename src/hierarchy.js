import { db, getSetting, setSetting } from './db.js';

/**
 * Иерархия ОГП: кто рассматривает жалобы на кого. Должностей сколько угодно, у каждой:
 *  • ключевые слова — по ним бот узнаёт должность и в названиях ролей Discord, и в пункте жалобы «Сведения о нарушителе»;
 *  • список должностей, жалобы на которые она рассматривает.
 * Жалоба на должность из списка достаётся только тем, кто её рассматривает (ЗГП → прокуроров и т.д.).
 * Жалоба не на сотрудника ОГП (LSPD, EMS…) — любому прокурору, как обычно. Настраивается в /settings → Иерархия.
 */
db.exec(`CREATE TABLE IF NOT EXISTS ranks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, keywords TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rank_reviews (reviewer INTEGER NOT NULL, target INTEGER NOT NULL, PRIMARY KEY (reviewer, target));`);

/** Начальная иерархия — как описано руководством; меняется в /settings */
const DEFAULTS = [
  ['ГП', ['генеральный прокурор', 'гп'], ['Первый ЗГП', 'ЗГП', 'СГП', 'Прокурор', 'Помощник прокурора']],
  ['Первый ЗГП', ['первый заместитель', 'первый згп', '1 згп', '1 й згп', '1 ый заместитель', '1 й заместитель', '1 заместитель'], ['ЗГП', 'СГП', 'Прокурор', 'Помощник прокурора']],
  ['ЗГП', ['заместитель генерального', 'заместитель гп', 'згп'], ['СГП', 'Прокурор', 'Помощник прокурора']],
  ['СГП', ['советник генерального', 'советник гп', 'сгп', 'советник'], ['Прокурор', 'Помощник прокурора']],
  ['Прокурор', ['прокурор'], []],
  ['Помощник прокурора', ['помощник прокурора', 'помощник'], []],
];

export function resetHierarchy() {
  db.exec('DELETE FROM rank_reviews; DELETE FROM ranks;');
  const ins = db.prepare('INSERT INTO ranks(name,keywords,sort) VALUES(?,?,?)');
  DEFAULTS.forEach(([name, kw], k) => ins.run(name, kw.join('\n'), k + 1));
  for (const [name, , targets] of DEFAULTS) setReviews(name, targets);
}

/* ---------- чтение ---------- */
export const ranks = () => db.prepare('SELECT * FROM ranks ORDER BY sort, id').all()
  .map((r) => ({ ...r, keywords: r.keywords.split('\n').map((s) => s.trim()).filter(Boolean) }));
export const rankById = (id) => ranks().find((r) => r.id === id) ?? null;
/** Должность по названию (без учёта регистра) */
export const rankByName = (name) => ranks().find((r) => r.name.toLowerCase() === String(name).trim().toLowerCase()) ?? null;
/** Кого рассматривает должность / кто рассматривает жалобы на должность */
export const targetsOf = (id) => db.prepare('SELECT target FROM rank_reviews WHERE reviewer=?').all(id).map((r) => r.target);
export const reviewersOf = (id) => db.prepare('SELECT reviewer FROM rank_reviews WHERE target=?').all(id).map((r) => r.reviewer);

/* ---------- распознавание ---------- */
const words = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** Основа слова для сравнения в любом падеже: «прокурор» → «прокуро» (подходит «прокурора», но не «прокуратуры») */
const stem = (w) => (w.length <= 3 ? null : w.slice(0, w.length <= 6 ? w.length - 2 : w.length <= 8 ? w.length - 1 : w.length - 2));
const wordFits = (tw, kw) => (kw.length <= 3 ? tw === kw : tw.startsWith(stem(kw)));
/**
 * Должность по тексту (название роли или «Сведения о нарушителе»). Ключевые слова ищутся целыми словами в любом
 * падеже («заместителя генерального прокурора»). Если подошло несколько должностей — берётся та, что названа раньше
 * («Первый заместитель Генерального прокурора» → Первый ЗГП, а не ЗГП), при равенстве — более длинная фраза
 * («помощник прокурора» точнее, чем «прокурор»).
 */
export function rankOfText(text) {
  if (!text) return null;
  const t = words(text);
  let best = null;
  for (const r of ranks()) {
    for (const kw of r.keywords) {
      const k = words(kw);
      if (!k.length) continue;
      for (let at = 0; at + k.length <= t.length; at++) {
        if (!k.every((w, j) => wordFits(t[at + j], w))) continue;
        const len = k.join(' ').length;
        if (!best || at < best.at || (at === best.at && len > best.len)) best = { rank: r, at, len };
        break;
      }
    }
  }
  return best?.rank ?? null;
}
/** Роли-отделы — не должность: «Офис Генерального прокурора», «Сотрудник ОГП», «Руководство ОГП» */
const DEPARTMENT = /офис|огп|отдел|департамент|сотрудник|руководств|состав|owner|владел/i;
/** Должность участника — самая высокая из его ролей */
export function rankOfMember(member) {
  let best = null;
  for (const role of member?.roles?.cache?.values?.() ?? []) {
    if (DEPARTMENT.test(role.name)) continue;
    const r = rankOfText(role.name);
    if (r && (!best || r.sort < best.sort)) best = r;
  }
  return best;
}

/* ---------- изменение (/settings → Иерархия) ---------- */
export function setReviews(name, targetNames) {
  const r = rankByName(name);
  if (!r) return { error: `Нет должности «${name}».` };
  const ids = [];
  const bad = [];
  for (const t of targetNames.map((s) => s.trim()).filter(Boolean)) {
    const x = rankByName(t);
    if (x) ids.push(x.id); else bad.push(t);
  }
  if (bad.length) return { error: `Нет должностей: ${bad.map((b) => `«${b}»`).join(', ')}.` };
  db.prepare('DELETE FROM rank_reviews WHERE reviewer=?').run(r.id);
  const ins = db.prepare('INSERT OR IGNORE INTO rank_reviews(reviewer,target) VALUES(?,?)');
  for (const id of ids) if (id !== r.id) ins.run(r.id, id);
  return { ok: true };
}
export function addRank(name, keywords, before = null) {
  if (rankByName(name)) return { error: `Должность «${name}» уже есть.` };
  const list = ranks();
  const at = before ? list.find((r) => r.name.toLowerCase() === before.trim().toLowerCase()) : null;
  if (before && !at) return { error: `Нет должности «${before}».` };
  if (at) db.prepare('UPDATE ranks SET sort=sort+1 WHERE sort>=?').run(at.sort);
  db.prepare('INSERT INTO ranks(name,keywords,sort) VALUES(?,?,?)')
    .run(name.trim(), keywords.join('\n'), at ? at.sort : (list.at(-1)?.sort ?? 0) + 1);
  return { ok: true };
}
export function removeRank(name) {
  const r = rankByName(name);
  if (!r) return { error: `Нет должности «${name}».` };
  db.prepare('DELETE FROM rank_reviews WHERE reviewer=? OR target=?').run(r.id, r.id);
  db.prepare('DELETE FROM ranks WHERE id=?').run(r.id);
  return { ok: true };
}
export function setKeywordsOf(name, keywords) {
  const r = rankByName(name);
  if (!r) return { error: `Нет должности «${name}».` };
  db.prepare('UPDATE ranks SET keywords=? WHERE id=?').run(keywords.join('\n'), r.id);
  return { ok: true };
}

/** Текст иерархии списком */
export function hierarchyLines() {
  const all = ranks();
  const nameOf = (id) => all.find((r) => r.id === id)?.name ?? '?';
  return all.map((r, k) => {
    const t = targetsOf(r.id).map(nameOf);
    return `**${k + 1}. ${r.name}** — рассматривает жалобы на: ${t.length ? t.join(', ') : '—'}\n-# слова: ${r.keywords.join(', ') || '—'}`;
  });
}

// первый запуск — начальная иерархия (в конце модуля: функции выше уже объявлены)
if (getSetting('hierarchy_seeded') === null) { resetHierarchy(); setSetting('hierarchy_seeded', '1'); }
// одноразово: в уже созданную иерархию — формы «1-ый / 1-й заместитель» для Первого ЗГП
if (getSetting('hierarchy_kw_v2') === null) {
  const r = rankByName('Первый ЗГП');
  if (r) setKeywordsOf(r.name, [...new Set([...r.keywords, '1 ый заместитель', '1 й заместитель', '1 заместитель'])]);
  setSetting('hierarchy_kw_v2', '1');
}
// одноразово: ЗГП рассматривает и жалобы на СГП
if (getSetting('hierarchy_zgp_sgp') === null) {
  const z = rankByName('ЗГП');
  const sg = rankByName('СГП');
  if (z && sg) db.prepare('INSERT OR IGNORE INTO rank_reviews(reviewer,target) VALUES(?,?)').run(z.id, sg.id);
  setSetting('hierarchy_zgp_sgp', '1');
}

/** Поднять / опустить должность в списке (выше — старше: при нескольких ролях берётся самая высокая) */
export function moveRank(id, dir) {
  const list = ranks();
  const k = list.findIndex((r) => r.id === id);
  const j = k + (dir === 'up' ? -1 : 1);
  if (k < 0 || j < 0 || j >= list.length) return;
  [list[k], list[j]] = [list[j], list[k]];
  const upd = db.prepare('UPDATE ranks SET sort=? WHERE id=?');
  list.forEach((r, n) => upd.run(n + 1, r.id));
}
