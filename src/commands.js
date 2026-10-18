import { ApplicationCommandOptionType as O, ChannelType } from 'discord.js';

const str = (name, description, required = true, extra = {}) => ({ name, description, type: O.String, required, ...extra });

/** Панели /setup: [тип, название]. Встроенный список Discord — открывается мгновенно, без запроса к боту */
export const SETUP_PANELS = [
  // [тип, название в списке /setup, что появится в канале (для справки в коде)]
  ['complaints', 'Жалобы', 'новые жалобы с форума, выбор прокурора'],
  ['cases', 'Уголовные дела', 'кнопка «Зарегистрировать дело» для прокуроров'],
  ['case_review', 'Дела на проверку', 'новые дела для решения ЗГП/ГП и судей'],
  ['case_req_cards', 'Запросы дел', 'запросы доступа к чужим делам (одобрить / отклонить)'],
  ['vacations', 'Отпуска и увольнения', 'кнопки заявок и сами заявки руководству'],
  ['cases_gov', 'Дела (Правительство)', 'кнопка «Запросить дело» для сотрудников Правительства'],
  ['mentoring', 'Кураторство', 'панель кураторов и карточки кураторств'],
  ['overdue', 'Просроченные дедлайны', 'уведомления о просрочках с тегом ответственных'],
  ['dm_blocked', 'Закрытые ЛС', 'кому бот не смог написать в личку'],
  ['gform', 'Google Форма', 'ответы любой Google Формы в этот канал'],
  ['all', 'Все панели сразу', 'жалобы, дела, отпуска, кураторство — в один канал'],
];
/** Типы записей панелей для /panel_delete */
const PANEL_TYPES = [
  ['complaints', 'Жалобы'], ['case_register', 'Уголовные дела (регистрация)'], ['case_review', 'Дела на проверку'],
  ['case_req_cards', 'Запросы дел'], ['case_request', 'Дела (Правительство)'], ['vacations', 'Отпуска и увольнения'], ['requests', 'Заявки руководству'],
  ['mentoring', 'Кураторство'], ['mentoring_cards', 'Кураторство (карточки)'], ['overdue', 'Просроченные дедлайны'], ['dm_blocked', 'Закрытые ЛС'],
].map(([value, name]) => ({ name, value }));
const panelChoices = SETUP_PANELS.map(([value, name]) => ({ name, value })); // коротко, без пояснений — так читается легче


const list = [
  {
    name: 'setup', description: 'Настройка панелей бота',
    options: [
      str('panel', 'Панель', true, { choices: panelChoices }),
      { name: 'channel', description: 'Канал для панели', type: O.Channel, channel_types: [ChannelType.GuildText], required: true },
    ],
  },
  { name: 'panels_list', description: 'Показать все зарегистрированные панели' },
  {
    name: 'panel_delete', description: 'Удалить запись панели из базы данных',
    options: [
      str('panel_type', 'Какую панель удалить', true, { choices: PANEL_TYPES }),
      { name: 'channel', description: 'Канал (если таких панелей несколько)', type: O.Channel, channel_types: [ChannelType.GuildText], required: false },
    ],
  },
  { name: 'check_members', description: 'Проверить кто из прокуроров Правительства отсутствует в ДС Прокуратуры' },
  { name: 'invite_missing', description: 'Отправить приглашения в ДС Прокуратуры всем отсутствующим прокурорам' },
  {
    name: 'broadcast', description: 'Рассылка сообщения всем прокурорам в ЛС',
    options: [
      str('message', 'Текст рассылки', true, { max_length: 1900 }),
      { name: 'role', description: 'Только участникам этой роли (по умолчанию — всем прокурорам)', type: O.Role, required: false },
      { name: 'image', description: 'Картинка или гифка к рассылке', type: O.Attachment, required: false },
    ],
  },
  { name: 'clear_all_dm', description: 'Удалить все ЛС сообщения, которые бот когда-либо отправлял' },
  {
    name: 'force_parse', description: 'Принудительный парсинг форума',
    options: [str('number', 'Опубликовать пропущенную жалобу по номеру (необязательно)', false, { max_length: 10 })],
  },
  { name: 'debug_forum', description: 'Отладка парсера форума' },
  { name: 'check_deadlines', description: 'Принудительная проверка просроченных дедлайнов' },
  { name: 'check_responsible', description: 'Проверить ответственных за дедлайны' },
  {
    name: 'sync', description: 'Синхронизация: команды, панели и карточки на всех серверах',
    options: [{ name: 'global', description: 'Глобально (необязательно)', type: O.Boolean, required: false }],
  },
  {
    name: 'cancel_vacation', description: 'Отменить отпуск сотрудника',
    options: [{ name: 'user', description: 'Сотрудник', type: O.User, required: true }],
  },
  { name: 'complaints', description: 'Статистика жалоб' },
  {
    name: 'find_complaint', description: 'Поиск жалобы по номеру',
    options: [str('number', 'Номер жалобы')],
  },
  { name: 'cabinet', description: 'Открыть личный кабинет' },
  { name: 'vacation', description: 'Подать заявку на отпуск' },
  { name: 'vacations', description: 'Активные отпуска' },
  {
    name: 'register_case', description: 'Зарегистрировать уголовное дело',
    options: [
      str('document', 'Ссылка на Google Docs'),
      str('accused', 'ФИО обвиняемого'),
      str('date', 'Дата возбуждения, ДД.ММ.ГГГГ'),
      str('number', 'Номер дела (если есть), например DJR-1123', false),
      str('passport', 'Паспорт обвиняемого', false),
      { name: 'prosecutor', description: 'Прокурор (только для администрации)', type: O.User, required: false },
    ],
  },
  {
    name: 'case', description: 'Информация о деле по УИН',
    options: [str('uin', '7-значный уникальный идентификатор дела', true, { min_length: 7, max_length: 7 })],
  },
  { name: 'cases', description: 'Статистика уголовных дел' },
  { name: 'my_cases', description: 'Мои уголовные дела' },
  { name: 'request_case', description: 'Запросить доступ к делу' },
  {
    name: 'distribution', description: 'Включить / выключить распределение жалоб сотруднику',
    options: [
      { name: 'off', description: 'Не распределять жалобы этому сотруднику', type: O.Subcommand, options: [{ name: 'user', description: 'Сотрудник', type: O.User, required: true }] },
      { name: 'on', description: 'Снова распределять жалобы сотруднику', type: O.Subcommand, options: [{ name: 'user', description: 'Сотрудник', type: O.User, required: true }] },
      { name: 'list', description: 'Кому распределение выключено', type: O.Subcommand },
    ],
  },
  { name: 'curators', description: 'Действующие кураторства' },
  { name: 'faq', description: 'FAQ и справка по боту' },
  { name: 'settings', description: 'Все настройки бота в одном окне' },
];

/**
 * Все команды — только на сервере: в ЛС с ботом их нет, даже если команды сделать глобальными
 * (contexts: 0 — сервер; integration_types: 0 — бот установлен на сервер).
 */
export const commands = list.map((c) => ({ ...c, contexts: [0], integration_types: [0] }));
