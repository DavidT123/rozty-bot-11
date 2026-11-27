const { readJSON, getGroupState, updateGroupState } = require("./storage");
const { isSupremeOwner } = require("./permissions");
const { SIGNATURE, formatDuration } = require("./format");
const { tiktokLink } = require("../commands/play");

const blocklistObj = readJSON("blocklist.json", {});
const bannedWords = Object.values(blocklistObj).flat();

// Estado por grupo y usuario: `${groupId}:${userId}`
const userStrikes = new Map();
const mutedUsers = new Map(); // key -> { until: timestamp, level: number (1 = 5m, 2 = 10m...) }

function normalizarTexto(texto) {
  return String(texto)
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/@|4/g, "a")
    .replace(/3|€/g, "e")
    .replace(/1|!|\|/g, "i")
    .replace(/0/g, "o")
    .replace(/\$|5/g, "s")
    .replace(/7|\+/g, "t")
    .replace(/(.)\1+/g, "$1");
}

function analizarMensaje(mensaje) {
  const limpio = normalizarTexto(mensaje).replace(/[^a-z0-9\s]/g, " ");
  const sinEspacios = limpio.replace(/\s+/g, "");

  for (const palabra of bannedWords) {
    const base = normalizarTexto(palabra).trim();
    if (!base) continue;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}(s|es)?\\b`, "i");
    if (regex.test(limpio) || (base.length >= 5 && sinEspacios.includes(base.replace(/\s+/g, "")))) {
      return { ofensivo: true, palabraDetectada: base };
    }
  }
  return { ofensivo: false };
}

function getKey(groupId, userId) {
  return `${groupId}:${userId.split("@")[0]}`;
}

function isUserMuted(groupId, userId) {
  if (isSupremeOwner(userId)) return false;
  const key = getKey(groupId, userId);
  const info = mutedUsers.get(key);
  if (!info) return false;
  if (Date.now() >= info.until) {
    // Mute cumplido: conserva level para que reincidencia sea 1 strike directo (+5 min)
    mutedUsers.set(key, { until: 0, level: info.level });
    return false;
  }
  return info.until > Date.now();
}

function manualMute(groupId, userId, minutes = 5) {
  if (isSupremeOwner(userId)) return false;
  const key = getKey(groupId, userId);
  const prev = mutedUsers.get(key) || { until: 0, level: 0 };
  mutedUsers.set(key, {
    until: Date.now() + minutes * 60 * 1000,
    level: Math.max(1, prev.level)
  });
  return true;
}

function manualUnmute(groupId, userId) {
  const key = getKey(groupId, userId);
  mutedUsers.delete(key);
  userStrikes.delete(key);
}

function listMutedInGroup(groupId) {
  const prefix = `${groupId}:`;
  const list = [];
  for (const [key, info] of mutedUsers.entries()) {
    if (key.startsWith(prefix) && info.until > Date.now()) {
      list.push({
        user: key.slice(prefix.length),
        remainingMs: info.until - Date.now()
      });
    }
  }
  return list;
}

async function handleModerationMiddleware(sock, msg, text, groupState) {
  const chatId = msg.key.remoteJid;
  if (!chatId || !chatId.endsWith("@g.us")) return false;
  const sender = msg.key.participant || msg.participant;
  if (!sender || isSupremeOwner(sender)) return false; // Líder supremo inmune a todo

  // Si está silenciado, borrar cualquier mensaje inmediatamente
  if (isUserMuted(chatId, sender)) {
    try {
      await sock.sendMessage(chatId, { delete: msg.key });
    } catch {}
    return true;
  }

  const gState = groupState || getGroupState(chatId);
  if (!text) return false;

  // Antilink (admins tampoco son inmunes, solo el líder supremo)
  const tiktokCommand = /^[!.]\s*(?:tk|ss[2r]?|ss\s+raw)\s+(\S+)\s*$/iu.exec(text);
  if (gState.antilink && !(tiktokCommand && tiktokLink(tiktokCommand[1])) &&
      /(https?:\/\/|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/)/i.test(text)) {
    try {
      await sock.sendMessage(chatId, { delete: msg.key });
      await sock.sendMessage(chatId, {
        text: `🚫 𝙴𝚗𝚕𝚊𝚌𝚎 𝚎𝚕𝚒𝚖𝚒𝚗𝚊𝚍𝚘 @${sender.split("@")[0]}, 𝚎𝚕 𝚊𝚗𝚝𝚒𝚕𝚒𝚗𝚔 𝚎𝚜𝚝𝚊 𝚊𝚌𝚝𝚒𝚟𝚘.\n\n${SIGNATURE}`,
        mentions: [sender]
      });
    } catch {}
    return true;
  }

  // Antitoxic (admins tampoco son inmunes, solo el líder supremo)
  if (gState.antitoxic) {
    const res = analizarMensaje(text);
    if (res.ofensivo) {
      try {
        await sock.sendMessage(chatId, { delete: msg.key });
      } catch {}

      const key = getKey(chatId, sender);
      const muteRecord = mutedUsers.get(key) || { until: 0, level: 0 };
      const tag = `@${sender.split("@")[0]}`;

      // Ya cumplió mute previo -> reincidencia directa de 1 strike y +5 min acumulativos
      if (muteRecord.level >= 1) {
        const nextLevel = muteRecord.level + 1;
        const minutes = nextLevel * 5;
        mutedUsers.set(key, {
          until: Date.now() + minutes * 60 * 1000,
          level: nextLevel
        });
        await sock.sendMessage(chatId, {
          text: `🔇 𝟷 𝚜𝚝𝚛𝚒𝚔𝚎 𝚍𝚒𝚛𝚎𝚌𝚝𝚘 ${tag}, 𝚝𝚎 𝚟𝚊𝚜 𝚖𝚞𝚝𝚎 𝚙𝚘𝚛 ${minutes} 𝚖𝚒𝚗𝚞𝚝𝚘𝚜, 𝚊𝚜𝚒 𝚚𝚞𝚎 𝚛𝚎𝚐𝚞𝚕𝚎𝚜𝚎 𝚘 𝚕𝚘 𝚛𝚎𝚐𝚞𝚕𝚊𝚖𝚘𝚜 𝚋𝚋.\n\n${SIGNATURE}`,
          mentions: [sender]
        });
        return true;
      }

      // Primer ciclo de 3 strikes
      const strikes = (userStrikes.get(key) || 0) + 1;
      userStrikes.set(key, strikes);

      if (strikes === 1) {
        await sock.sendMessage(chatId, {
          text: `⚠️ 𝟷 𝚜𝚝𝚛𝚒𝚔𝚎 ${tag}, 𝚝𝚎 𝚚𝚞𝚎𝚍𝚊𝚗 𝟸 𝚢 𝚝𝚎 𝚟𝚊𝚜 𝚖𝚞𝚝𝚎 𝚙𝚘𝚛 𝟻 𝚖𝚒𝚗𝚞𝚝𝚘𝚜 𝚌𝚘𝚖𝚙𝚊.\n\n${SIGNATURE}`,
          mentions: [sender]
        });
      } else if (strikes === 2) {
        await sock.sendMessage(chatId, {
          text: `⚠️ 𝟸 𝚜𝚝𝚛𝚒𝚔𝚎𝚜 ${tag}, 𝚝𝚎 𝚚𝚞𝚎𝚍𝚊 𝟷 𝚢 𝚝𝚎 𝚟𝚊𝚜 𝚖𝚞𝚝𝚎 𝚙𝚘𝚛 𝟻 𝚖𝚒𝚗𝚞𝚝𝚘𝚜, 𝚊𝚜𝚒 𝚚𝚞𝚎 𝚛𝚎𝚐𝚞𝚕𝚎𝚜𝚎 𝚘 𝚕𝚘 𝚛𝚎𝚐𝚞𝚕𝚊𝚖𝚘𝚜 𝚋𝚋.\n\n${SIGNATURE}`,
          mentions: [sender]
        });
      } else {
        userStrikes.delete(key);
        mutedUsers.set(key, {
          until: Date.now() + 5 * 60 * 1000,
          level: 1
        });
        await sock.sendMessage(chatId, {
          text: `🔇 𝟹 𝚜𝚝𝚛𝚒𝚔𝚎𝚜 ${tag}, 𝚝𝚎 𝚏𝚞𝚒𝚜𝚝𝚎 𝚖𝚞𝚝𝚎 𝚙𝚘𝚛 𝟻 𝚖𝚒𝚗𝚞𝚝𝚘𝚜. 𝙻𝚊 𝚙𝚛𝚘𝚡𝚒𝚖𝚊 𝚌𝚘𝚗 𝚞𝚗 𝚜𝚘𝚕𝚘 𝚜𝚝𝚛𝚒𝚔𝚎 𝚟𝚊 𝚍𝚎 𝚗𝚞𝚎𝚟𝚘.\n\n${SIGNATURE}`,
          mentions: [sender]
        });
      }
      return true;
    }
  }

  return false;
}

function toggleAntitoxicWithCooldown(groupId, senderJid, turnOn) {
  const gState = getGroupState(groupId);
  const now = Date.now();
  const COOLDOWN_MS = 2 * 60 * 1000;

  if (!isSupremeOwner(senderJid) && !turnOn) {
    const elapsed = now - (gState.antitoxicLastToggle || 0);
    if (elapsed < COOLDOWN_MS) {
      const rem = formatDuration(COOLDOWN_MS - elapsed);
      return {
        ok: false,
        message: `⏳ 𝙰𝚞𝚗 𝚗𝚘 𝚜𝚎 𝚙𝚞𝚎𝚍𝚎 𝚊𝚙𝚊𝚐𝚊𝚛 𝚎𝚕 𝚊𝚗𝚝𝚒𝚝𝚘𝚡𝚒𝚌, 𝚚𝚞𝚎𝚍𝚊𝚗 ${rem} 𝚍𝚎 𝚌𝚘𝚘𝚕𝚍𝚘𝚠𝚗 𝚍𝚎 𝟸 𝚖𝚒𝚗𝚞𝚝𝚘𝚜.\n\n${SIGNATURE}`
      };
    }
  }

  updateGroupState(groupId, {
    antitoxic: turnOn,
    antitoxicLastToggle: now
  });

  return {
    ok: true,
    message: `${turnOn ? "🛡️ 𝙰𝚗𝚝𝚒𝚝𝚘𝚡𝚒𝚌 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘." : "🌑 𝙰𝚗𝚝𝚒𝚝𝚘𝚡𝚒𝚌 𝚍𝚎𝚜𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘."}\n\n${SIGNATURE}`
  };
}

module.exports = {
  handleModerationMiddleware,
  toggleAntitoxicWithCooldown,
  manualMute,
  manualUnmute,
  listMutedInGroup
};
