const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { readJSON, writeJSON } = require("../utils/storage");
const { SIGNATURE, badSyntaxMsg, noPermissionMsg } = require("../utils/format");

// Sesiones interactivas de creación por respuesta: senderJid -> step state
const creationFlows = new Map();

const PRESETS = {
  "1": "basico",
  "2": "juegos",
  "3": "admin",
  "4": "completo",
  basico: "basico",
  juegos: "juegos",
  admin: "admin",
  completo: "completo"
};

async function startSubbotWizard(sock, msg, owner) {
  const chatId = msg.key.remoteJid;
  if (!owner) {
    await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
    return;
  }

  const promptText = `🤖 𝙲𝚁𝙴𝙰𝙲𝙸𝙾́𝙽 𝙳𝙴 𝚂𝚄𝙱-𝙱𝙾𝚃 (𝙿𝚊𝚜𝚘 𝟷/𝟹)
𝙿𝚘𝚗 𝚕𝚘𝚜 𝚍𝚊𝚝𝚘𝚜 𝚙𝚊𝚛𝚊 𝚕𝚊 𝚌𝚛𝚎𝚊𝚌𝚒𝚘́𝚗.
𝚂𝚎𝚕𝚎𝚌𝚌𝚒𝚘𝚗𝚊 𝚞𝚗𝚊 𝚌𝚊𝚝𝚎𝚐𝚘𝚛𝚒𝚊 𝚍𝚎 𝚋𝚘𝚝 𝚛𝚎𝚜𝚙𝚘𝚗𝚍𝚒𝚎𝚗𝚍𝚘 𝚊 𝚎𝚜𝚝𝚎 𝚖𝚎𝚗𝚜𝚊𝚓𝚎 𝚌𝚘𝚗 𝚞𝚗 𝚗𝚞́𝚖𝚎𝚛𝚘:

𝟷. 𝙱𝚊́𝚜𝚒𝚌𝚘
𝟸. 𝙹𝚞𝚎𝚐𝚘𝚜 𝚢 𝚁𝚞𝚕𝚎𝚝𝚊𝚜
𝟹. 𝙰𝚍𝚖𝚒𝚗 𝚢 𝙼𝚘𝚍𝚎𝚛𝚊𝚌𝚒𝚘́𝚗
𝟺. 𝙲𝚘𝚖𝚙𝚕𝚎𝚝𝚘

${SIGNATURE}`;

  const sent = await sock.sendMessage(chatId, { text: promptText }, { quoted: msg });
  creationFlows.set(owner, {
    step: 1,
    botMsgId: sent.key.id,
    chatId
  });
}

async function handleSubbotWizardReply(sock, msg, text, owner) {
  if (!owner) return false;

  const flow = creationFlows.get(owner);
  if (!flow) return false;

  const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  if (!quotedId || quotedId !== flow.botMsgId) return false;

  const chatId = msg.key.remoteJid;

  if (flow.step === 1) {
    const preset = PRESETS[text.trim().toLowerCase()];
    if (!preset) {
      await sock.sendMessage(chatId, { text: badSyntaxMsg("Responde con 1, 2, 3 o 4") }, { quoted: msg });
      return true;
    }

    const step2Text = `🎨 𝙿𝙴𝚁𝚂𝙾𝙽𝙰𝙻𝙸𝚉𝙰𝙲𝙸𝙾́𝙽 (𝙿𝚊𝚜𝚘 𝟸/𝟹)
𝙲𝚊𝚝𝚎𝚐𝚘𝚛𝚒𝚊 𝚎𝚕𝚎𝚐𝚒𝚍𝚊: *${preset.toUpperCase()}*
𝚂𝚎𝚕𝚎𝚌𝚌𝚒𝚘𝚗𝚊 𝚛𝚎𝚜𝚙𝚘𝚗𝚍𝚒𝚎𝚗𝚍𝚘 𝚊 𝚎𝚜𝚝𝚎 𝚖𝚎𝚗𝚜𝚊𝚓𝚎 𝚌𝚘𝚗 𝚞𝚗 𝚗𝚞́𝚖𝚎𝚛𝚘. 𝙴𝚓𝚎𝚖𝚙𝚕𝚘: 2

𝟷. 𝙽𝚘𝚖𝚋𝚛𝚎 + 𝚏𝚘𝚝𝚘
𝟸. 𝚂𝚘𝚕𝚘 𝚗𝚘𝚖𝚋𝚛𝚎

${SIGNATURE}`;

    const sent = await sock.sendMessage(chatId, { text: step2Text }, { quoted: msg });
    creationFlows.set(owner, {
      ...flow,
      step: 2,
      preset,
      botMsgId: sent.key.id
    });
    return true;
  }

  if (flow.step === 2) {
    const choice = text.trim();
    if (choice !== "1" && choice !== "2") {
      await sock.sendMessage(chatId, { text: badSyntaxMsg("Responde con 1 o 2") }, { quoted: msg });
      return true;
    }

    const askData = choice === "1"
      ? `📸 𝙳𝙰𝚃𝙾𝚂 𝙳𝙴𝙻 𝚂𝚄𝙱-𝙱𝙾𝚃 (𝙿𝚊𝚜𝚘 𝟹/𝟹)
𝙼𝚊𝚗𝚍𝚊 𝚕𝚊 *𝚏𝚘𝚝𝚘* 𝚌𝚘𝚗 𝚎𝚕 *𝚗𝚘𝚖𝚋𝚛𝚎* 𝚎𝚗 𝚕𝚊 𝚖𝚒𝚜𝚖𝚊 𝚏𝚘𝚝𝚘 𝚛𝚎𝚜𝚙𝚘𝚗𝚍𝚒𝚎𝚗𝚍𝚘 𝚊 𝚎𝚜𝚝𝚎 𝚖𝚎𝚗𝚜𝚊𝚓𝚎 (𝚙𝚞𝚎𝚍𝚎𝚜 𝚒𝚗𝚌𝚕𝚞𝚒𝚛 𝚎𝚕 𝚗𝚞́𝚖𝚎𝚛𝚘 𝚘𝚙𝚌𝚒𝚘𝚗𝚊𝚕).

${SIGNATURE}`
      : `✏️ 𝙳𝙰𝚃𝙾𝚂 𝙳𝙴𝙻 𝚂𝚄𝙱-𝙱𝙾𝚃 (𝙿𝚊𝚜𝚘 𝟹/𝟹)
𝙴𝚜𝚌𝚛𝚒𝚋𝚎 𝚎𝚕 *𝚗𝚘𝚖𝚋𝚛𝚎* 𝚍𝚎𝚕 𝚜𝚞𝚋-𝚋𝚘𝚝 𝚛𝚎𝚜𝚙𝚘𝚗𝚍𝚒𝚎𝚗𝚍𝚘 𝚊 𝚎𝚜𝚝𝚎 𝚖𝚎𝚗𝚜𝚊𝚓𝚎 (𝚎𝚓𝚎𝚖𝚙𝚕𝚘: \`PolloJr 50688888888\`).

${SIGNATURE}`;

    const sent = await sock.sendMessage(chatId, { text: askData }, { quoted: msg });
    creationFlows.set(owner, {
      ...flow,
      step: 3,
      mode: choice,
      botMsgId: sent.key.id
    });
    return true;
  }

  if (flow.step === 3) {
    const imgMsg = msg.message?.imageMessage;
    const rawCaption = imgMsg?.caption || text || "";
    if (flow.mode === "1" && !imgMsg) {
      await sock.sendMessage(chatId, {
        text: badSyntaxMsg("Manda una foto con el nombre escrito respondiendo al mensaje")
      }, { quoted: msg });
      return true;
    }
    if (!rawCaption.trim()) {
      await sock.sendMessage(chatId, {
        text: badSyntaxMsg("Escribe el nombre del sub-bot")
      }, { quoted: msg });
      return true;
    }

    const tokens = rawCaption.trim().split(/\s+/);
    const possibleNum = normalizeNumber(tokens[tokens.length - 1]);
    const hasPhone = possibleNum.length >= 8;
    const phone = hasPhone ? possibleNum : "";
    const botName = hasPhone ? tokens.slice(0, -1).join(" ") || "SubBot" : rawCaption.trim();
    const id = `sb_${Date.now().toString().slice(-5)}`;

    const subbots = readJSON("subbots.json", {});
    subbots[id] = {
      id,
      name: botName,
      phone,
      preset: flow.preset,
      mode: flow.mode === "1" ? "nombre+foto" : "solo_nombre",
      prefixes: ["!", "."],
      active: true,
      createdAt: new Date().toISOString()
    };
    writeJSON("subbots.json", subbots);
    creationFlows.delete(owner);

    const ownerPriv = `${owner}@s.whatsapp.net`;
    const summary = `✅ 𝚂𝚄𝙱-𝙱𝙾𝚃 𝙲𝚁𝙴𝙰𝙳𝙾
🆔 𝙸𝙳: \`${id}\`
🤖 𝙽𝚘𝚖𝚋𝚛𝚎: *${botName}*
📦 𝙲𝚊𝚝𝚎𝚐𝚘𝚛𝚒𝚊: *${flow.preset}*
🔑 𝙿𝚛𝚎𝚏𝚒𝚓𝚘𝚜: \`!\` 𝚢 \`.\`
📲 𝚅𝚒𝚗𝚌𝚞𝚕𝚊𝚌𝚒𝚘́𝚗: 𝚝𝚎 𝚎𝚗𝚟𝚒́𝚘 𝚕𝚘𝚜 𝚍𝚊𝚝𝚘𝚜 𝚙𝚘𝚛 𝚙𝚛𝚒𝚟𝚊𝚍𝚘 𝚙𝚊𝚛𝚊 𝚚𝚞𝚎 𝚙𝚊𝚜𝚎𝚜 𝚎𝚕 𝚌𝚘́𝚍𝚒𝚐𝚘/𝚀𝚁.

${SIGNATURE}`;

    await sock.sendMessage(chatId, { text: summary }, { quoted: msg });

    // Enviar QR de vinculación por privado al creador
    const qrPayload = `ROZTYPOLLO-SUBBOT:${id}:${botName}:${phone || "SIN_NUMERO"}`;
    const qrBuffer = await QRCode.toBuffer(qrPayload, { width: 420 });
    await sock.sendMessage(ownerPriv, {
      image: qrBuffer,
      caption: `🔐 𝚅𝙸𝙽𝙲𝚄𝙻𝙰𝙲𝙸𝙾́𝙽 𝙿𝚁𝙸𝚅𝙰𝙳𝙰
𝙸𝙳: \`${id}\`
𝙽𝚘𝚖𝚋𝚛𝚎: *${botName}*
𝚄𝚜𝚊 \`.vinculacion ${id}\` 𝚌𝚞𝚊𝚗𝚍𝚘 𝚕𝚘 𝚟𝚊𝚢𝚊𝚜 𝚊 𝚌𝚘𝚗𝚎𝚌𝚝𝚊𝚛.

${SIGNATURE}`
    });

    return true;
  }

  return false;
}

async function handleSubbotCommand(sock, msg, subCmd, args, owner) {
  const chatId = msg.key.remoteJid;
  if (!owner) {
    await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
    return true;
  }

  const subbots = readJSON("subbots.json", {});

  switch (subCmd) {
    case "crear": {
      await startSubbotWizard(sock, msg, owner);
      return true;
    }

    case "listar": {
      const list = Object.values(subbots);
      if (!list.length) {
        await sock.sendMessage(chatId, {
          text: `🌑 𝙽𝚘 𝚑𝚊𝚢 𝚜𝚞𝚋-𝚋𝚘𝚝𝚜 𝚌𝚛𝚎𝚊𝚍𝚘𝚜 𝚝𝚘𝚍𝚊𝚟𝚒𝚊.\n\n${SIGNATURE}`
        }, { quoted: msg });
        return true;
      }
      const rows = list
        .map((s) => `➥ \`${s.id}\` • *${s.name}* [${s.preset}] (${s.active ? "ON ⚡" : "OFF 🌑"})`)
        .join("\n");
      await sock.sendMessage(chatId, {
        text: `🤖 𝚂𝚄𝙱-𝙱𝙾𝚃𝚂 𝚁𝙴𝙶𝙸𝚂𝚃𝚁𝙰𝙳𝙾𝚂:\n\n${rows}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "preset": {
      const [id, rawPreset] = args;
      const preset = PRESETS[(rawPreset || "").toLowerCase()];
      if (!id || !subbots[id] || !preset) {
        await sock.sendMessage(chatId, {
          text: badSyntaxMsg(".subbot preset sb_12345 juegos")
        }, { quoted: msg });
        return true;
      }
      subbots[id].preset = preset;
      writeJSON("subbots.json", subbots);
      await sock.sendMessage(chatId, {
        text: `⚡ 𝙿𝚛𝚎𝚜𝚎𝚝 𝚍𝚎 \`${id}\` 𝚌𝚊𝚖𝚋𝚒𝚊𝚍𝚘 𝚊 *${preset}*.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "apagar": {
      const [id] = args;
      if (!id || !subbots[id]) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".subbot apagar sb_12345") }, { quoted: msg });
        return true;
      }
      subbots[id].active = false;
      writeJSON("subbots.json", subbots);
      await sock.sendMessage(chatId, {
        text: `🌑 𝚂𝚞𝚋-𝚋𝚘𝚝 \`${id}\` 𝚊𝚙𝚊𝚐𝚊𝚍𝚘.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "borrar": {
      const [id] = args;
      if (!id || !subbots[id]) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".subbot borrar sb_12345") }, { quoted: msg });
        return true;
      }
      delete subbots[id];
      writeJSON("subbots.json", subbots);
      await sock.sendMessage(chatId, {
        text: `🗑️ 𝚂𝚞𝚋-𝚋𝚘𝚝 \`${id}\` 𝚎𝚕𝚒𝚖𝚒𝚗𝚊𝚍𝚘.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    default:
      await sock.sendMessage(chatId, { text: badSyntaxMsg(".subbot crear") }, { quoted: msg });
      return true;
  }
}

async function handleVinculacion(sock, msg, args, owner) {
  const chatId = msg.key.remoteJid;
  if (!owner) {
    await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
    return true;
  }

  const [id] = args;
  const subbots = readJSON("subbots.json", {});
  if (!id || !subbots[id]) {
    await sock.sendMessage(chatId, { text: badSyntaxMsg(".vinculacion sb_12345") }, { quoted: msg });
    return true;
  }

  const sb = subbots[id];
  const ownerPriv = `${owner}@s.whatsapp.net`;
  const pairCode = Math.random().toString(36).substring(2, 10).toUpperCase();
  const qrBuffer = await QRCode.toBuffer(`PAIR:${id}:${pairCode}`, { width: 420 });

  await sock.sendMessage(ownerPriv, {
    image: qrBuffer,
    caption: `🔐 𝙳𝙰𝚃𝙾𝚂 𝙳𝙴 𝚅𝙸𝙽𝙲𝚄𝙻𝙰𝙲𝙸𝙾́𝙽 (𝙿𝚛𝚒𝚟𝚊𝚍𝚘)
🆔 𝙸𝙳: \`${id}\`
🤖 𝙽𝚘𝚖𝚋𝚛𝚎: *${sb.name}*
🔢 𝙲𝚘́𝚍𝚒𝚐𝚘 𝚛𝚎𝚏𝚎𝚛𝚎𝚗𝚌𝚒𝚊: \`${pairCode}\`

${SIGNATURE}`
  });

  if (chatId !== ownerPriv) {
    await sock.sendMessage(chatId, {
      text: `📩 𝚃𝚎 𝚖𝚊𝚗𝚍𝚎́ 𝚕𝚘𝚜 𝚍𝚊𝚝𝚘𝚜 𝚍𝚎 𝚟𝚒𝚗𝚌𝚞𝚕𝚊𝚌𝚒𝚘́𝚗 𝚍𝚎 \`${id}\` 𝚙𝚘𝚛 𝚙𝚛𝚒𝚟𝚊𝚍𝚘.\n\n${SIGNATURE}`
    }, { quoted: msg });
  }
  return true;
}

module.exports = {
  handleSubbotWizardReply,
  handleSubbotCommand,
  handleVinculacion
};
