import {
  AttachmentBuilder, CommandInteraction, EmbedBuilder, Message, MessageComponentInteraction, MessagePayload, ModalSubmitInteraction,
} from 'discord.js';
import { fileURLToPath } from 'node:url';

const NAME = 'logo.webp';
const PATH = fileURLToPath(new URL('../assets/logo.webp', import.meta.url));
const REF = `attachment://${NAME}`;

/** У сообщения уже есть файл герба */
const hasLogo = (msg) => !!msg?.attachments?.some?.((a) => a.name === NAME);
/** Миниатюра — наш герб: ссылка на вложение или его адрес в CDN Discord (embed взяли из старого сообщения) */
const isOurLogo = (url) => !!url && (url === REF || /^https:\/\/(cdn|media)\.discordapp\.(com|net)\/attachments\/.+\/logo\.webp(\?|$)/.test(url));

/**
 * Ставит герб ОГП миниатюрой (справа сверху) в первый embed сообщения, если у него нет своей миниатюры.
 *
 * Герб — вложение сообщения, на которое ссылается embed (attachment://logo.webp). Вложение, на которое никто
 * не ссылается, Discord показывает отдельной большой картинкой над карточкой. Поэтому:
 *  - новое сообщение — файл прикладывается;
 *  - правка, когда герб у сообщения уже есть (keep) — только ссылка, файл не грузится;
 *  - правка, когда неизвестно, есть ли герб (replace: editReply и т.п.) — вложения сообщения заменяются одним новым гербом;
 *  - правка, после которой герб не нужен (своя миниатюра, только текст) — вложения убираются.
 * Режим правки задают обёртки update/editReply ниже (__logo), а для Message.edit — само сообщение.
 */
export function installLogo() {
  const create = MessagePayload.create;
  MessagePayload.create = function (target, options, extra) {
    if (!options || typeof options !== 'object' || options instanceof MessagePayload) return create.call(this, target, options, extra);
    const { __logo, __edit, __noLogo, ...rest } = options;
    let opts = rest;
    // короткие уведомления и свои вложения (__noLogo, кабинет) — как есть
    if (__noLogo) return create.call(this, target, opts, extra);

    const mode = __logo ?? (target instanceof Message ? (hasLogo(target) ? 'keep' : 'replace') : __edit ? 'keep' : 'new');
    const own = 'attachments' in opts || opts.files?.length; // вызывающий сам распоряжается вложениями
    let needs = false;
    if (Array.isArray(opts.embeds) && opts.embeds.length) {
      opts.embeds = opts.embeds.map((e, k) => {
        const json = e.toJSON?.() ?? e;
        if (k > 0 || (json.thumbnail && !isOurLogo(json.thumbnail.url))) return e;
        needs = true;
        return EmbedBuilder.from(json).setThumbnail(REF);
      });
    }
    if (needs) {
      if (mode === 'new') opts.files = [...(opts.files ?? []), new AttachmentBuilder(PATH, { name: NAME })];
      else if (mode === 'replace' && !own) opts = { ...opts, files: [new AttachmentBuilder(PATH, { name: NAME })], attachments: [] };
    } else if (mode !== 'new' && !own && Array.isArray(opts.embeds)) {
      // карточку заменили текстом или embed со своей миниатюрой — старый герб убираем, иначе он останется картинкой
      // (правка только кнопок, без embeds, вложения не трогает)
      opts = { ...opts, attachments: [] };
    }
    return create.call(this, target, opts, extra);
  };

  // interaction.update() правит сообщение с кнопкой — смотрим, есть ли у него герб
  for (const Cls of [MessageComponentInteraction, ModalSubmitInteraction]) {
    const update = Cls.prototype.update;
    Cls.prototype.update = function (options) {
      const mode = hasLogo(this.message) ? 'keep' : 'replace';
      return update.call(this, options && typeof options === 'object' ? { __logo: mode, ...options } : options);
    };
  }
  // editReply правит ответ бота, чьи вложения заранее неизвестны (после «думает…» — пустое сообщение,
  // после deferUpdate — сообщение с кнопкой): вложения заменяются одним гербом
  for (const Cls of [CommandInteraction, MessageComponentInteraction, ModalSubmitInteraction]) {
    const editReply = Cls.prototype.editReply;
    Cls.prototype.editReply = function (options) {
      return editReply.call(this, options && typeof options === 'object' ? { __logo: 'replace', ...options } : options);
    };
  }
}
