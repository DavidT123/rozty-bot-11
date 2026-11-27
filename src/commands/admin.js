const { getGroupState, updateGroupState } = require("../utils/storage");
const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const { withProgress } = require("../utils/progress");
const { renderGreeting } = require("../utils/greetings");
const { isSupremeOwner, isGroupAdmin } = require("../utils/permissions");
const {
  toggleAntitoxicWithCooldown,
  manualMute,
  manualUnmute,
  listMutedInGroup
} = require("../utils/moderation");
const {
  SIGNATURE,
  badSyntaxMsg,
  actionFailedMsg,
  noPermissionMsg
} = require("../utils/format");

function parseDurationMs(token = "") {
  const m = String(token).toLowerCase().match(/^(\d+)(s|m|h)$/);
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = m[2];
  if (unit === "s") return val * 1000;
  if (unit === "m") return val * 60 * 1000;
  if (unit === "h") return val * 3600 * 1000;
  return 0;
}

const ADMIN_COMMANDS = new Set([
  "admins", "usuarios", "del", "mute", "unmute", "muteados", "kick", "promote",
  "demote", "n", "todos", "cerrar", "abrir", "link", "resetlink", "setname",
  "setreglas", "on-admin", "off-admin", "antilink", "antitoxic", "set welcome",
  "set bye", "welcome", "bye"
]);
const PUBLIC_GROUP_COMMANDS = new Set(["admins", "usuarios", "n"]);

async function handleAdminCommand(sock, msg, cmd, args, owner) {
  if (!ADMIN_COMMANDS.has(cmd)) return false;
  const chatId = msg.key.remoteJid;
  if (!chatId || !chatId.endsWith("@g.us")) return false;
  const sender = msg.key.participant || msg.participant;

  if (!PUBLIC_GROUP_COMMANDS.has(cmd) && !owner && !(await isGroupAdmin(sock, chatId, sender))) {
    await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
    return true;
  }

  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  const target = mentioned[0] || quotedParticipant;

  try {
    switch (cmd) {
      case "admins": {
        const meta = await sock.groupMetadata(chatId);
        const admins = meta.participants.filter((p) => p.admin);
        const list = admins.map((a) => `➥ @${a.id.split("@")[0]}`).join("\n");
        await sock.sendMessage(chatId, {
          text: `👑 𝙰𝙳𝙼𝙸𝙽𝚂 𝙳𝙴𝙻 𝙶𝚁𝚄𝙿𝙾 (${admins.length}):\n\n${list}\n\n${SIGNATURE}`,
          mentions: admins.map((a) => a.id)
        }, { quoted: msg });
        return true;
      }

      case "usuarios": {
        const meta = await sock.groupMetadata(chatId);
        await sock.sendMessage(chatId, {
          text: `👥 𝚃𝚘𝚝𝚊𝚕 𝚍𝚎 𝚖𝚒𝚎𝚖𝚋𝚛𝚘𝚜: *${meta.participants.length}*\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "del": {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".del (respondiendo a un mensaje)") }, { quoted: msg });
          return true;
        }
        await sock.sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            fromMe: false,
            id: ctx.stanzaId,
            participant: ctx.participant
          }
        });
        return true;
      }

      case "mute": {
        if (!target) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".mute @usuario") }, { quoted: msg });
          return true;
        }
        if (isSupremeOwner(target)) {
          await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
          return true;
        }
        manualMute(chatId, target, 5);
        await sock.sendMessage(chatId, {
          text: `🔇 @${target.split("@")[0]} 𝚏𝚞𝚎 𝚜𝚒𝚕𝚎𝚗𝚌𝚒𝚊𝚍𝚘 𝚙𝚘𝚛 𝟻 𝚖𝚒𝚗𝚞𝚝𝚘𝚜.\n\n${SIGNATURE}`,
          mentions: [target]
        }, { quoted: msg });
        return true;
      }

      case "unmute": {
        if (!target) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".unmute @usuario") }, { quoted: msg });
          return true;
        }
        manualUnmute(chatId, target);
        await sock.sendMessage(chatId, {
          text: `🔈 @${target.split("@")[0]} 𝚢𝚊 𝚙𝚞𝚎𝚍𝚎 𝚑𝚊𝚋𝚕𝚊𝚛 𝚍𝚎 𝚗𝚞𝚎𝚟𝚘.\n\n${SIGNATURE}`,
          mentions: [target]
        }, { quoted: msg });
        return true;
      }

      case "muteados": {
        const list = listMutedInGroup(chatId);
        if (!list.length) {
          await sock.sendMessage(chatId, {
            text: `🔈 𝙽𝚘 𝚑𝚊𝚢 𝚗𝚊𝚍𝚒𝚎 𝚜𝚒𝚕𝚎𝚗𝚌𝚒𝚊𝚍𝚘 𝚊𝚑𝚘𝚛𝚊.\n\n${SIGNATURE}`
          }, { quoted: msg });
          return true;
        }
        const lines = list.map((m) => `➥ @${m.user} (${Math.ceil(m.remainingMs / 60000)}m)`).join("\n");
        await sock.sendMessage(chatId, {
          text: `🔇 𝙼𝚄𝚃𝙴𝙰𝙳𝙾𝚂 𝙰𝙲𝚃𝙸𝚅𝙾𝚂:\n\n${lines}\n\n${SIGNATURE}`,
          mentions: list.map((m) => `${m.user}@s.whatsapp.net`)
        }, { quoted: msg });
        return true;
      }

      case "kick": {
        if (!target || isSupremeOwner(target)) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".kick @usuario") }, { quoted: msg });
          return true;
        }
        const results = await sock.groupParticipantsUpdate(chatId, [target], "remove");
        if (!results?.some(result => String(result.status) === "200")) {
          await sock.sendMessage(chatId, { text: actionFailedMsg() }, { quoted: msg });
          return false;
        }
        const state = getGroupState(chatId);
        if (state.active && state.bye) return true;
        await sock.sendMessage(chatId, {
          text: renderGreeting(state, "remove", "@" + target.split("@")[0].split(":")[0]),
          mentions: [target]
        }, { quoted: msg });
        return true;
      }

      case "promote": {
        if (!target) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".promote @usuario") }, { quoted: msg });
          return true;
        }
        await sock.groupParticipantsUpdate(chatId, [target], "promote");
        await sock.sendMessage(chatId, {
          text: `⚡ @${target.split("@")[0]} 𝚊𝚑𝚘𝚛𝚊 𝚎𝚜 𝚊𝚍𝚖𝚒𝚗.\n\n${SIGNATURE}`,
          mentions: [target]
        }, { quoted: msg });
        return true;
      }

      case "demote": {
        if (!target || isSupremeOwner(target)) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".demote @usuario") }, { quoted: msg });
          return true;
        }
        await sock.groupParticipantsUpdate(chatId, [target], "demote");
        await sock.sendMessage(chatId, {
          text: `🌑 @${target.split("@")[0]} 𝚢𝚊 𝚗𝚘 𝚎𝚜 𝚊𝚍𝚖𝚒𝚗.\n\n${SIGNATURE}`,
          mentions: [target]
        }, { quoted: msg });
        return true;
      }

      case "n": {
        const original = normalizeMessageContent(msg.message);
        const quoted = normalizeMessageContent(original?.extendedTextMessage?.contextInfo?.quotedMessage);
        const text = args.join(" ").trim() || quoted?.conversation || quoted?.extendedTextMessage?.text ||
          quoted?.imageMessage?.caption || quoted?.videoMessage?.caption;
        if (!text?.trim()) {
          await sock.sendMessage(chatId, { text: "Usá .n Hola o respondé con .n al mensaje que querés anunciar." }, { quoted: msg });
          return true;
        }
        await withProgress(sock, msg, async () => {
          const meta = await sock.groupMetadata(chatId);
          await sock.sendMessage(chatId, {
            text: "Atención pipol\n\n" + text.trim(),
            mentions: meta.participants.map(p => p.id)
          });
        });
        return true;
      }

      case "todos": {
        const meta = await sock.groupMetadata(chatId);
        const ids = meta.participants.map((p) => p.id);
        const text = args.join(" ") || "Atención al grupo ⚡";
        const tags = ids.map((id) => `@${id.split("@")[0]}`).join(" ");
        await sock.sendMessage(chatId, { text: `📣 ${text}\n\n${tags}\n\n${SIGNATURE}`, mentions: ids });
        return true;
      }

      case "cerrar": {
        await sock.groupSettingUpdate(chatId, "announcement");
        const ms = parseDurationMs(args[0]);
        await sock.sendMessage(chatId, {
          text: `🔒 𝙶𝚛𝚞𝚙𝚘 𝚌𝚎𝚛𝚛𝚊𝚍𝚘. 𝚂𝚘𝚕𝚘 𝚊𝚍𝚖𝚒𝚗𝚜 𝚙𝚞𝚎𝚍𝚎𝚗 𝚎𝚜𝚌𝚛𝚒𝚋𝚒𝚛${ms ? ` (${args[0]})` : ""}.\n\n${SIGNATURE}`
        }, { quoted: msg });
        if (ms > 0) {
          setTimeout(async () => {
            try {
              await sock.groupSettingUpdate(chatId, "not_announcement");
              await sock.sendMessage(chatId, { text: `🔓 𝙶𝚛𝚞𝚙𝚘 𝚊𝚋𝚒𝚎𝚛𝚝𝚘 𝚊𝚞𝚝𝚘𝚖𝚊𝚝𝚒𝚌𝚊𝚖𝚎𝚗𝚝𝚎.\n\n${SIGNATURE}` });
            } catch {}
          }, ms);
        }
        return true;
      }

      case "abrir": {
        await sock.groupSettingUpdate(chatId, "not_announcement");
        const ms = parseDurationMs(args[0]);
        await sock.sendMessage(chatId, {
          text: `🔓 𝙶𝚛𝚞𝚙𝚘 𝚊𝚋𝚒𝚎𝚛𝚝𝚘. 𝚃𝚘𝚍𝚘𝚜 𝚙𝚞𝚎𝚍𝚎𝚗 𝚎𝚜𝚌𝚛𝚒𝚋𝚒𝚛${ms ? ` (${args[0]})` : ""}.\n\n${SIGNATURE}`
        }, { quoted: msg });
        if (ms > 0) {
          setTimeout(async () => {
            try {
              await sock.groupSettingUpdate(chatId, "announcement");
              await sock.sendMessage(chatId, { text: `🔒 𝙶𝚛𝚞𝚙𝚘 𝚌𝚎𝚛𝚛𝚊𝚍𝚘 𝚊𝚞𝚝𝚘𝚖𝚊𝚝𝚒𝚌𝚊𝚖𝚎𝚗𝚝𝚎.\n\n${SIGNATURE}` });
            } catch {}
          }, ms);
        }
        return true;
      }

      case "link": {
        const code = await sock.groupInviteCode(chatId);
        await sock.sendMessage(chatId, {
          text: `🔗 https://chat.whatsapp.com/${code}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "resetlink": {
        const code = await sock.groupRevokeInvite(chatId);
        await sock.sendMessage(chatId, {
          text: `🔄 𝙴𝚗𝚕𝚊𝚌𝚎 𝚛𝚎𝚗𝚘𝚟𝚊𝚍𝚘: https://chat.whatsapp.com/${code}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "setname": {
        const name = args.join(" ").trim();
        if (!name) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".setname Nuevo Nombre") }, { quoted: msg });
          return true;
        }
        await sock.groupUpdateSubject(chatId, name);
        await sock.sendMessage(chatId, {
          text: `✏️ 𝙽𝚘𝚖𝚋𝚛𝚎 𝚍𝚎𝚕 𝚐𝚛𝚞𝚙𝚘 𝚊𝚌𝚝𝚞𝚊𝚕𝚒𝚣𝚊𝚍𝚘.\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "setreglas": {
        const desc = args.join(" ").trim();
        if (!desc) {
          await sock.sendMessage(chatId, { text: badSyntaxMsg(".setreglas Respeta a todos...") }, { quoted: msg });
          return true;
        }
        await sock.groupUpdateDescription(chatId, desc);
        updateGroupState(chatId, { rules: desc });
        await sock.sendMessage(chatId, {
          text: `📜 𝚁𝚎𝚐𝚕𝚊𝚜 𝚢 𝚍𝚎𝚜𝚌𝚛𝚒𝚙𝚌𝚒𝚘𝚗 𝚍𝚎𝚕 𝚐𝚛𝚞𝚙𝚘 𝚊𝚌𝚝𝚞𝚊𝚕𝚒𝚣𝚊𝚍𝚊𝚜.\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "on-admin":
      case "off-admin": {
        const adminOnly = cmd === "on-admin";
        updateGroupState(chatId, { adminOnly });
        await sock.sendMessage(chatId, {
          text: `${adminOnly ? "🛡️ 𝙼𝚘𝚍𝚘 𝚜𝚘𝚕𝚘 𝚊𝚍𝚖𝚒𝚗𝚜 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘." : "⚡ 𝙼𝚘𝚍𝚘 𝚕𝚒𝚋𝚛𝚎 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘."}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "antilink": {
        const g = getGroupState(chatId);
        const next = args[0] ? args[0].toLowerCase() === "on" : !g.antilink;
        updateGroupState(chatId, { antilink: next });
        await sock.sendMessage(chatId, {
          text: `${next ? "🔗 𝙰𝚗𝚝𝚒𝚕𝚒𝚗𝚔 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘." : "🌑 𝙰𝚗𝚝𝚒𝚕𝚒𝚗𝚔 𝚍𝚎𝚜𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘."}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "antitoxic": {
        const g = getGroupState(chatId);
        const next = args[0] ? args[0].toLowerCase() === "on" : !g.antitoxic;
        const res = toggleAntitoxicWithCooldown(chatId, sender, next);
        await sock.sendMessage(chatId, { text: res.message }, { quoted: msg });
        return true;
      }

      case "set welcome":
      case "set bye": {
        const isWelcome = cmd === "set welcome";
        const label = isWelcome ? "bienvenida" : "despedida";
        const template = args[0].trim();
        if (!template || Array.from(template).length > 700) {
          await sock.sendMessage(chatId, {
            text: `Pon el mensaje que quieras agregar después del .${cmd}\nUsá {usuario} para mencionar a quien ${isWelcome ? "entra" : "sale"}. Máximo 700 caracteres.\nPara recuperar el mensaje original, usá .${cmd} reset.`
          }, { quoted: msg });
          return true;
        }
        const reset = template.toLowerCase() === "reset";
        const message = reset ? "" : template;
        updateGroupState(chatId, isWelcome ? { welcome: true, welcomeMessage: message } : { bye: true, byeMessage: message });
        await sock.sendMessage(chatId, {
          text: `✅ Se activó la ${label} ${reset ? "original" : "personalizada"} en este grupo.`
        }, { quoted: msg });
        return true;
      }

      case "welcome": {
        const g = getGroupState(chatId);
        const next = args[0] ? args[0].toLowerCase() === "on" : !g.welcome;
        updateGroupState(chatId, { welcome: next });
        await sock.sendMessage(chatId, {
          text: `${next ? "👋 𝙱𝚒𝚎𝚗𝚟𝚎𝚗𝚒𝚍𝚊𝚜 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚊𝚜." : "🌑 𝙱𝚒𝚎𝚗𝚟𝚎𝚗𝚒𝚍𝚊𝚜 𝚍𝚎𝚜𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚊𝚜."}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      case "bye": {
        const g = getGroupState(chatId);
        const next = args[0] ? args[0].toLowerCase() === "on" : !g.bye;
        updateGroupState(chatId, { bye: next });
        await sock.sendMessage(chatId, {
          text: `${next ? "🚪 𝙳𝚎𝚜𝚙𝚎𝚍𝚒𝚍𝚊𝚜 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚊𝚜." : "🌑 𝙳𝚎𝚜𝚙𝚎𝚍𝚒𝚍𝚊𝚜 𝚍𝚎𝚜𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚊𝚜."}\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    console.error(`[AdminCmd:${cmd}]`, err.message);
    await sock.sendMessage(chatId, { text: actionFailedMsg() }, { quoted: msg });
    return false;
  }
}

module.exports = { handleAdminCommand };
