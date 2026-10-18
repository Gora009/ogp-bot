import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { db, setSetting } from './db.js';
import { PERMS, can, trustedUsers } from './access.js';
import { syncPeople } from './people.js';
import { RULES, isVacationRole, norm } from './roles.js';
import { C, EPH, stamp } from './util.js';

/**
 * /autosetup — выдаёт права ролям по их названиям. Сначала показывает план, применяет по кнопке.
 * Права только добавляются (ничего не удаляется); поправить вручную можно через /access.
 */
// названия должностей и права по ним — в roles.js (их же бот применяет сам, без автонастройки)

/** План: какие роли сервера под какие правила подходят */
export function buildPlan(guild) {
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed) // без @everyone и ролей ботов
    .sort((a, b) => b.position - a.position);
  const items = [];
  let vacation = null;
  for (const r of roles) {
    const n = norm(r.name);
    if (!vacation && isVacationRole(n)) { vacation = { id: r.id, name: r.name }; continue; }
    const rule = RULES.find((x) => x.test(n));
    if (rule) items.push({ id: r.id, name: r.name, rule: rule.label, perms: rule.perms });
  }
  return { items, vacation };
}

const pending = new Map(); // user_id → { plan, ts }

function planEmbed(plan, i) {
  const e = new EmbedBuilder().setColor(C.info).setTitle('⚙️ Автонастройка')
    .setDescription(plan.items.length || plan.vacation
      ? 'Нашёл роли по названиям. Вот что будет выдано (права только **добавляются**, ничего не удаляется):'
      : 'Не нашёл ни одной роли с понятным названием (Прокурор, СГП, ЗГП, ГП, Судья, Отпуск). Права можно выдать вручную: `/settings` → Доступ.')
    .setFooter({ text: stamp() });
  for (const it of plan.items.slice(0, 20)) {
    e.addFields({ name: `${it.name} → ${it.rule}`, value: it.perms.map((p) => `• ${PERMS[p][0]}`).join('\n'), inline: true });
  }
  if (plan.vacation) e.addFields({ name: `${plan.vacation.name} → роль «Отпуск»`, value: 'Выдаётся автоматически в день начала отпуска', inline: true });
  // кто останется с доступом к настройке после применения
  const fullRoles = plan.items.filter((x) => x.perms.includes('full')).map((x) => x.id);
  const invokerKeeps = i.guild.ownerId === i.user.id || trustedUsers.has(i.user.id) ||
    fullRoles.some((r) => i.member?.roles?.cache?.has(r));
  if (fullRoles.length && !invokerKeeps) {
    e.addFields({ name: '⚠️ Внимание', value: 'После применения настраивать бота смогут только роли ГП и владелец сервера. У вас такой роли нет — вы потеряете доступ к настройке.' });
  }
  return e;
}

export async function autosetup(client, i) {
  const plan = buildPlan(i.guild);
  pending.set(i.user.id, { plan, ts: Date.now() });
  const has = plan.items.length || plan.vacation;
  return i.reply({
    embeds: [planEmbed(plan, i)],
    components: has ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('auto:ok').setLabel('Применить').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('auto:no').setLabel('Отмена').setEmoji('❌').setStyle(ButtonStyle.Secondary))] : [],
    ...EPH,
  });
}

export async function handleAuto(client, i) {
  const action = i.customId.split(':')[1];
  const saved = pending.get(i.user.id);
  pending.delete(i.user.id);
  if (action === 'no') return i.update({ content: 'Автонастройка отменена.', embeds: [], components: [] });
  if (!can(i, 'full')) return i.reply({ content: '⛔ Применить автонастройку может только полный доступ (ГП или владелец).', ...EPH });
  if (!saved || Date.now() - saved.ts > 10 * 60_000) {
    return i.update({ content: '⚠️ План устарел — запустите автонастройку заново: /settings → Общее.', embeds: [], components: [] });
  }
  const { plan } = saved;
  const ins = db.prepare('INSERT OR IGNORE INTO access(target_id,kind,perm) VALUES(?,?,?)');
  let added = 0;
  for (const it of plan.items) for (const p of it.perms) added += Number(ins.run(it.id, 'role', p).changes);
  if (plan.vacation) setSetting('vacation_role_id', plan.vacation.id);

  await i.update({ content: '⏳ Применяю…', embeds: [], components: [] });
  // база прокуроров: сразу всех, если есть интент участников; иначе прокуроры попадут в неё сами при первом действии
  const r = await syncPeople(client);
  const note = r
    ? `Прокуроров в базе: **${r.prosecutors}** (старший состав: **${r.seniors}**), судей: **${r.judges}**.\nДальше бот следит за ролями сам.`
    : 'Server Members Intent выключен — прокуроры попадут в базу сами, когда воспользуются ботом.';
  return i.editReply({
    content: '',
    embeds: [new EmbedBuilder().setColor(C.success).setTitle('✅ Автонастройка применена')
      .setDescription(`Новых правил доступа: **${added}**` + (plan.vacation ? `\nРоль «Отпуск»: <@&${plan.vacation.id}>` : '') +
        `\n\n${note}\n\nПроверить и поправить: \`/settings\` → Доступ.`)
      .setFooter({ text: stamp() })],
  });
}
