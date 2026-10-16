/**
 * Права по названиям ролей — как в оригинальном боте: роль «Генеральный Прокурор» сразу даёт права ГП,
 * «Заместитель Генерального Прокурора» — права ЗГП и т.д. Настраивать ничего не нужно; в /settings → Доступ
 * можно добавить права другим ролям или, наоборот, снять право с роли (тогда название роли его не даёт).
 */
export const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const word = (w) => new RegExp(`(^| )${w}( |$)`);
// роли-«отделы» вроде «Офис Генерального прокурора» или «Сотрудник ОГП» — не должность, высокие права им не даём
const DEPARTMENT = /офис|огп|отдел|департамент|сотрудник|состав|owner|владел/;

/** Порядок важен: срабатывает первое подходящее правило (сначала самые конкретные должности) */
export const RULES = [
  {
    label: 'Генеральный прокурор', short: 'ГП', perms: ['full', 'senior'],
    test: (n) => !DEPARTMENT.test(n) && ((/генеральн\S* прокурор/.test(n) && !/заместител|советник|помощник|старш/.test(n)) || word('гп').test(n)),
  },
  {
    label: 'Заместитель ГП', short: 'ЗГП', perms: ['approve', 'staff', 'monitor', 'assign', 'mentoring', 'senior'],
    test: (n) => !DEPARTMENT.test(n) && (/заместител\S* генеральн/.test(n) || word('згп').test(n)),
  },
  {
    label: 'Советник ГП', short: 'СГП', perms: ['approve', 'senior', 'mentoring'], // переназначать жалобы — от ЗГП
    test: (n) => !DEPARTMENT.test(n) && (/советник\S* генеральн/.test(n) || word('сгп').test(n)),
  },
  { label: 'Помощник прокурора', short: 'Помощник прокурора', perms: ['prosecutor', 'case_register'], test: (n) => /помощник\S* прокурор/.test(n) },
  { label: 'Прокурор', short: 'Прокурор', perms: ['prosecutor', 'case_register'], test: (n) => /прокурор/.test(n) && !DEPARTMENT.test(n) },
  { label: 'Судья', short: 'Судья', perms: ['judge'], test: (n) => /(^| )судь/.test(n) },
];

export const isVacationRole = (n) => n === 'отпуск' || n === 'в отпуске' || /^отпуск /.test(n);

/** Должность по названию роли (или null) */
export const ruleFor = (roleName) => RULES.find((r) => r.test(norm(roleName))) ?? null;
/**
 * Должность участника по его ролям — самая высокая из известных (ГП → ЗГП → СГП → Помощник → Прокурор → Судья).
 * У советника с ролью «Прокурор» будет «Советник ГП», а не ЗГП. null — ни одна роль не похожа на должность.
 */
export const positionOf = (member) => {
  const names = [...(member?.roles?.cache?.values?.() ?? [])].map((r) => norm(r.name));
  // коротко, как принято в ОГП: ГП, ЗГП, СГП, Прокурор…
  return RULES.find((rule) => names.some((n) => rule.test(n)))?.short ?? null;
};
/** Права, которые даёт само название роли */
export const namePerms = (roleName) => ruleFor(roleName)?.perms ?? [];
