const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { isSupremeOwner } = require("../utils/permissions");

const running = new Set();
const batchSize = 20;

function identities(participant) {
  return [participant.id, participant.lid, participant.jid, participant.phoneNumber]
    .filter(Boolean);
}

const creatorPhone = /^(?:506)?83678160(?::\d+)?(?:@(?:s\.whatsapp\.net|c\.us))?$/i;
const isCreatorPhone = value => typeof value === "string" && creatorPhone.test(value);

async function isCreatorMessage(sock, msg) {
  const { key } = msg;
  if (key.fromMe) return isCreatorPhone(sock.user?.id);

  const sender = key.participant || msg.participant;
  if (isCreatorPhone(sender)) return true;
  if (!sender?.endsWith("@lid")) return false;

  try {
    const { participants } = await sock.groupMetadata(key.remoteJid);
    const senderId = jidNormalizedUser(sender);
    const participant = participants.find(p =>
      [p.id, p.lid].some(id => id && jidNormalizedUser(id) === senderId)
    );
    return Boolean(participant && identities(participant).some(isCreatorPhone));
  } catch {
    return false;
  }
}

async function getTargets(sock, chatId, msg) {
  const { participants } = await sock.groupMetadata(chatId);
  const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const matches = (participant, ids) =>
    identities(participant).some(id => ids.includes(jidNormalizedUser(id)));
  const bot = participants.find(participant => matches(participant, botIds));
  if (!bot || !["admin", "superadmin"].includes(bot.admin)) {
    throw new Error("El bot necesita ser administrador de este grupo.");
  }

  const senderIds = [msg.key.participant, msg.participant, msg.key.participantAlt,
    msg.key.participantPn, msg.key.senderPn].filter(Boolean).map(jidNormalizedUser);
  return participants.filter(participant =>
    participant.id && participant !== bot
    && participant.admin !== "superadmin"
    && !matches(participant, senderIds)
    && !identities(participant).some(id => isCreatorPhone(id) || isSupremeOwner(id))
  ).map(participant => participant.id);
}

async function handleKickAll(sock, msg) {
  const chatId = msg.key.remoteJid;
  const reply = text => sock.sendMessage(chatId, { text }, { quoted: msg });
  if (!chatId.endsWith("@g.us")) return reply("Usá .kickall1 dentro del grupo que querés vaciar.");
  if (!(await isCreatorMessage(sock, msg))) return reply("Solo el creador de Roztypollo puede usar .kickall1.");
  if (running.has(chatId)) return reply("Ya hay una limpieza en curso en este grupo.");

  running.add(chatId);
  try {
    const targets = await getTargets(sock, chatId, msg);
    if (!targets.length) return await reply("No hay miembros que sacar de este grupo.");
    let removed = 0;
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      const batch = targets.slice(offset, offset + batchSize);
      try {
        const results = await sock.groupParticipantsUpdate(chatId, batch, "remove");
        removed += results.filter(result => String(result.status) === "200").length;
      } catch (error) {
        console.error("[KickAll] Lote:", error.message);
      }
    }
    const remaining = targets.length - removed;
    return await reply(`WhatsApp confirmó ${removed} expulsión(es).${remaining ? ` Sin confirmar: ${remaining}.` : ""}`);
  } catch (error) {
    console.error("[KickAll]", error.message);
    return reply("No pude completar la limpieza. Revisá que el bot siga siendo administrador.");
  } finally {
    running.delete(chatId);
  }
}

module.exports = { handleKickAll };
