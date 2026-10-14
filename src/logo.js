import {
  AttachmentBuilder, EmbedBuilder, Message, MessageComponentInteraction, MessagePayload, ModalSubmitInteraction,
} from 'discord.js';
import { fileURLToPath } from 'node:url';

const NAME = 'logo.webp';
const PATH = fileURLToPath(new URL('../assets/logo.webp', import.meta.url));

/**
 * Ставит герб ОГП миниатюрой (справа сверху) в каждый embed, у которого нет своей миниатюры.
 * Файл прикладывается при отправке нового сообщения; при редактировании (Message.edit,
 * interaction.update) он уже есть на сообщении, поэтому повторно не грузится.
 */
export function installLogo() {
  const create = MessagePayload.create;
  MessagePayload.create = function (target, options, extra) {
    // короткие уведомления (__noLogo) идут без герба — он нужен только на панелях и карточках
    if (options && typeof options === 'object' && options.__noLogo) {
      const { __noLogo, __edit, ...rest } = options;
      options = rest;
    } else if (options && typeof options === 'object' && !(options instanceof MessagePayload) && options.embeds?.length) {
      let added = false;
      const embeds = options.embeds.map((e) => {
        const json = e.toJSON?.() ?? e;
        if (json.thumbnail) return e;
        added = true;
        return EmbedBuilder.from(json).setThumbnail(`attachment://${NAME}`);
      });
      const isEdit = target instanceof Message || options.__edit;
      const { __edit, ...rest } = options;
      options = { ...rest, embeds };
      if (added && !isEdit) options.files = [...(options.files ?? []), new AttachmentBuilder(PATH, { name: NAME })];
    }
    return create.call(this, target, options, extra);
  };

  // interaction.update() правит существующее сообщение — файл заново не нужен
  for (const Cls of [MessageComponentInteraction, ModalSubmitInteraction]) {
    const update = Cls.prototype.update;
    Cls.prototype.update = function (options) {
      return update.call(this, options && typeof options === 'object' ? { ...options, __edit: true } : options);
    };
  }
}
