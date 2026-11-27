require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  normalizeMessageContent,
  jidNormalizedUser,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

const { readJSON, getGroupState, updateGroupState, getAllGroupsState } = require("./src/utils/storage");
const { getMessageOwner, isGroupAdmin } = require("./src/utils/permissions");
const {
  SIGNATURE,
  badSyntaxMsg,
  actionFailedMsg,
  noPermissionMsg,
  formatDuration
} = require("./src/utils/format");
const { handleModerationMiddleware, listMutedInGroup } = require("./src/utils/moderation");
const {
  downloadMediaBuffer,
  createWebpSticker,
  createBratSticker,
  createQuoteSticker
} = require("./src/utils/stickers");
const { runStickerJob, failStickerCommand } = require("./src/utils/sticker-jobs");
const { installStickerDiagnostic, armStickerDiagnostic, readStickerDiagnostic, findStickerDiagnostic, formatStickerDiagnostic } = require("./src/utils/sticker-diagnostic");
const { SOUND_STICKER_COMMANDS, handleSoundSticker } = require("./src/commands/sound-stickers");
const { getMainMenu, MENU_1, MENU_2, MENU_3, MENU_4, MENU_5, getMenuAll } = require("./src/commands/menus");
const { handleGamesCommand } = require("./src/commands/games");
const { handlePlayCommand, handlePlayChoiceReply, handleSocialDownload, handleYouTubeSearch, downloadQueueCommand, downloadHealth } = require("./src/commands/play");
const { GROUP_TOOLS, COMMAND_FAMILY, handleGroupTool, quotedText } = require("./src/commands/group-tools");
const { MEDIA_TOOLS, handleMediaTool } = require("./src/commands/media-tools");
const { SOCIAL_GAMES, handleSocialGame } = require("./src/commands/social-games");
const { withProgress } = require("./src/utils/progress");
const { renderGreeting } = require("./src/utils/greetings");
const { handleAdminCommand } = require("./src/commands/admin");
const { handleKickAll } = require("./src/commands/kickall");
const { handleSubbotWizardReply, handleSubbotCommand, handleVinculacion } = require("./src/commands/subbots");

const startTime = Date.now();
installStickerDiagnostic();
let privateMode = false;
const quoteNames = new Map();
const afkMap = new Map(); // userNum -> { reason, since }
const content = readJSON("content.json", {});

function pickRandom(arr = []) {
  if (!arr.length) return "Sin contenido.";
  return arr[Math.floor(Math.random() * arr.length)];
}

function extractText(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

async function getQuoteAvatar(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, "preview", 3500);
    if (!url || new URL(url).protocol !== "https:") return;
    const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch {
    // Profile pictures can be private or unavailable.
  }
}

function getStickerMedia(msg, videoOnly = false) {
  const message = normalizeMessageContent(msg.message);
  const context = message?.extendedTextMessage?.contextInfo
    || message?.imageMessage?.contextInfo
    || message?.videoMessage?.contextInfo;
  const quoted = normalizeMessageContent(context?.quotedMessage);
  return [message, quoted].find(media => media?.videoMessage || (!videoOnly && media?.imageMessage));
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions/main");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: process.env.LOG_LEVEL || "silent" }),
    auth: state,
    printQRInTerminal: false,
    browser: ["Roztypollo", "Chrome", "6.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  // Pairing code opcional o QR en consola
  if (process.env.USE_PAIRING_CODE === "true" && !sock.authState.creds.registered) {
    const num = (process.env.PAIRING_NUMBER || "50683678160").replace(/[^0-9]/g, "");
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(num);
        console.log("\n========================================");
        console.log("CÓDIGO DE VINCULACIÓN DE 8 DÍGITOS:", code);
        console.log("========================================\n");
      } catch (e) {
        console.error("Error generando código de vinculación:", e.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && process.env.USE_PAIRING_CODE !== "true") {
      console.log("\nEscanea este QR con WhatsApp (Dispositivos vinculados):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.message || "motivo desconocido";
      console.error("Conexion cerrada:", reason, "| Reconectando:", shouldReconnect);
      if (shouldReconnect) setTimeout(runBot, 5000);
    } else if (connection === "open") {
      console.log("⚡ Roztypollo Bot conectado y listo.");
    }
  });

  // Bienvenida y despedida por grupo
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    const state = getGroupState(id);
    if (!state.active || !((action === "add" && state.welcome) || (action === "remove" && state.bye))) return;
    const results = await Promise.allSettled(participants.map(async participant => {
      const jid = typeof participant === "string" ? participant : participant?.id;
      if (!jid) return;
      const tag = "@" + jid.split("@")[0].split(":")[0];
      const caption = renderGreeting(state, action, tag);
      if (action === "remove") {
        await sock.sendMessage(id, { text: caption, mentions: [jid] });
        return;
      }
      const image = await getQuoteAvatar(sock, jid);
      await sock.sendMessage(id, image ? { image, caption, mentions: [jid] } : { text: caption, mentions: [jid] });
    }));
    for (const result of results) {
      if (result.status === "rejected") console.error("[Participante]", result.reason?.message);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const msg of messages) {
      handleMessage(msg, type).catch(error => console.error("[Message]", error.message));
    }
  });

  async function handleMessage(msg, type) {
    if (!msg?.message || !msg.key?.remoteJid) return;

    const chatId = msg.key.remoteJid;
    const receivedAt = Number(msg.messageTimestamp || 0);
    const stickerInfo = type === "notify" || receivedAt >= Date.now() / 1000 - 120
      ? readStickerDiagnostic(msg) : null;
    if (stickerInfo) return sock.sendMessage(chatId, { text: formatStickerDiagnostic(stickerInfo) });
    if (type !== "notify") return;
    const isGroup = chatId.endsWith("@g.us");
    const sender = msg.key.fromMe
      ? sock.user?.id
      : isGroup ? msg.key.participant || msg.participant : chatId;
    if (!sender) return;
    const senderNum = sender.split("@")[0];
    const text = extractText(msg);
    if (/^[!.]\s*kickall1$/i.test(text)) {
      await withProgress(sock, msg, () => handleKickAll(sock, msg), 1000);
      return;
    }
    const owner = await getMessageOwner(sock, msg, sender, /^[!.]/.test(text));
    const diagnostic = /^[!.]ssdiag(?:\s+(ultimo|último))?$/iu.exec(text);
    if (diagnostic) {
      if (isGroup) return sock.sendMessage(chatId, { text: "Usá .ssdiag en un chat privado con el bot." }, { quoted: msg });
      const report = findStickerDiagnostic(msg, sender, Boolean(diagnostic[1]));
      if (report) return sock.sendMessage(chatId, { text: formatStickerDiagnostic(report) }, { quoted: msg });
      if (diagnostic[1]) return sock.sendMessage(chatId, { text: "Todavía no hay un sticker generado por vos en este chat desde que arrancó el bot." }, { quoted: msg });
      armStickerDiagnostic(chatId, () => {
        sock.sendMessage(chatId, { text: "No detecté un sticker en los últimos 2 minutos. Escribí .ssdiag y reenviá el sticker como mensaje de WhatsApp." })
          .catch(error => console.warn("[Sticker diagnóstico]", error.message));
      });
      return sock.sendMessage(chatId, { text: "Diagnóstico activo por 2 minutos. Ahora reenviá un sticker en este chat." }, { quoted: msg });
    }
    if (msg.key.fromMe && !owner) return;
    if (msg.pushName) {
      const key = jidNormalizedUser(sender);
      quoteNames.delete(key);
      quoteNames.set(key, msg.pushName);
      if (quoteNames.size > 500) quoteNames.delete(quoteNames.keys().next().value);
    }

    // 1. Flujo interactivo de sub-bots por respuesta (solo creador)
    if (owner && await withProgress(sock, msg, () => handleSubbotWizardReply(sock, msg, text, owner), 1000)) return;

    // 2. AFK: Si el usuario estaba AFK y vuelve a hablar
    if (afkMap.has(senderNum) && !/^[!.]afk\b/i.test(text)) {
      const afkInfo = afkMap.get(senderNum);
      afkMap.delete(senderNum);
      await sock.sendMessage(chatId, {
        text: `⚡ 𝚅𝚘𝚕𝚟𝚒𝚜𝚝𝚎 @${senderNum}, 𝚎𝚜𝚝𝚞𝚟𝚒𝚜𝚝𝚎 𝙰𝙵𝙺 ${formatDuration(Date.now() - afkInfo.since)}.\n\n${SIGNATURE}`,
        mentions: [sender]
      }, { quoted: msg });
    }

    // 3. AFK: Si mencionan o responden a alguien que está AFK
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedUser = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const targetsToCheck = [...new Set([...mentioned, ...(quotedUser ? [quotedUser] : [])])];
    for (const targetJid of targetsToCheck) {
      const tNum = targetJid.split("@")[0];
      if (tNum !== senderNum && afkMap.has(tNum)) {
        const info = afkMap.get(tNum);
        await sock.sendMessage(chatId, {
          text: `⏳ 𝙴𝚜𝚙𝚎𝚛𝚊 𝚞𝚗 𝚝𝚘𝚚𝚞𝚎, @${tNum} 𝚎𝚜𝚝𝚊 𝙰𝙵𝙺 𝚍𝚎𝚜𝚍𝚎 𝚑𝚊𝚌𝚎 ${formatDuration(Date.now() - info.since)}.\n𝙼𝚘𝚝𝚒𝚟𝚘: ${info.reason}\n\n${SIGNATURE}`,
          mentions: [targetJid]
        }, { quoted: msg });
      }
    }

    // 4. Moderación automática (antilink, antitoxic, mutes activos)
    const settings = isGroup ? getGroupState(chatId) : {};
    if (!msg.key.fromMe && isGroup && settings.active) {
      const blocked = await handleModerationMiddleware(sock, msg, text, settings);
      if (blocked) return;
    }

    // 5. Detección de prefijos (! y .)
    const hasPrefix = /^[!.]/.test(text);
    const isPlayChoice = /^[12]$/u.test(text);
    const commandAliases = settings.aliases || {};
    const typed = text.toLowerCase();
    if (!hasPrefix && !/^s$/i.test(text) && !isPlayChoice && !Object.hasOwn(commandAliases, typed)) {
      const triggers = settings.triggers || {};
      if (settings.active && !msg.key.fromMe && Object.hasOwn(triggers, typed) &&
          (!settings.adminOnly || owner || await isGroupAdmin(sock, chatId, sender))) {
        await sock.sendMessage(chatId, { text: triggers[typed] }, { quoted: msg });
      }
      return;
    }
    const parts = (hasPrefix ? text.slice(1).trim() : text).split(/\s+/);
    const requested = (parts.shift() || "").toLowerCase();
    const resolved = !hasPrefix && requested !== "s" && Object.hasOwn(commandAliases, requested) ? commandAliases[requested] : requested;
    const cmd = resolved === "frases" ? "frase" : resolved;
    const args = parts;
    if (!cmd) return;

    const managesProgress = /^(?:s|sticker|brat|qc|q|qmulti|quotly|play|yt|youtube|ytsearch|tk|ig|instagram|fb|facebook|x|twitter|n)$/u.test(cmd)
      || isPlayChoice || MEDIA_TOOLS.has(cmd) || SOUND_STICKER_COMMANDS.has(cmd);
    const run = () => runCommand(cmd, args, isPlayChoice);
    try {
      return await (managesProgress ? run() : withProgress(sock, msg, run, 1000));
    } catch (error) {
      console.error("[Comando]", cmd, error.message);
      return sock.sendMessage(chatId, { text: actionFailedMsg() }, { quoted: msg });
    }

    async function runCommand(cmd, args, isPlayChoice) {
    // Comandos exclusivos del líder supremo (+506 8367 8160)
    if (cmd === "activacion3") {
      if (!owner) {
        await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
        return;
      }
      if (!isGroup) return;
      updateGroupState(chatId, { active: true });
      await sock.sendMessage(chatId, {
        text: `⚡ 𝙻𝚒𝚜𝚝𝚘 𝚙𝚊, 𝚁𝚘𝚣𝚝𝚢𝚙𝚘𝚕𝚕𝚘 𝚢𝚊 𝚚𝚞𝚎𝚍𝚘 𝚊𝚌𝚝𝚒𝚟𝚘 𝚎𝚗 𝚎𝚜𝚝𝚎 𝚐𝚛𝚞𝚙𝚘.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return;
    }

    if (cmd === "desactivacion3") {
      if (!owner) {
        await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
        return;
      }
      if (!isGroup) return;
      updateGroupState(chatId, { active: false });
      await sock.sendMessage(chatId, {
        text: `🌑 𝚁𝚘𝚣𝚝𝚢𝚙𝚘𝚕𝚕𝚘 𝚍𝚎𝚜𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘 𝚎𝚗 𝚎𝚜𝚝𝚎 𝚐𝚛𝚞𝚙𝚘.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return;
    }

    if (cmd === "privado0304") {
      if (!owner) {
        await sock.sendMessage(chatId, { text: noPermissionMsg() }, { quoted: msg });
        return;
      }
      privateMode = !privateMode;
      await sock.sendMessage(chatId, {
        text: `${privateMode ? "🖤 𝙼𝚘𝚍𝚘 𝚙𝚛𝚒𝚟𝚊𝚍𝚘 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘 𝚙𝚊𝚛𝚊 𝚙𝚛𝚞𝚎𝚋𝚊𝚜." : "🌑 𝙼𝚘𝚍𝚘 𝚙𝚛𝚒𝚟𝚊𝚍𝚘 𝚊𝚙𝚊𝚐𝚊𝚍𝚘."}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return;
    }

    if (cmd === "subbot") {
      await handleSubbotCommand(sock, msg, (args[0] || "").toLowerCase(), args.slice(1), owner);
      return;
    }

    if (cmd === "vinculacion") {
      await handleVinculacion(sock, msg, args, owner);
      return;
    }

    // Verificar modo privado y llave del grupo (el líder supremo siempre pasa)
    if (!owner) {
      if (privateMode && !isGroup) return;
      if (isGroup) {
        if (!settings.active) return;
        if (settings.adminOnly && !(await isGroupAdmin(sock, chatId, sender))) return;
      }
    }

    const family = COMMAND_FAMILY;
    if (settings.disabledCommands?.[cmd] === true || settings.disabledCommands?.[family[cmd]] === true) {
      return sock.sendMessage(chatId, { text: "Ese comando está desactivado en este grupo." }, { quoted: msg });
    }
    if (GROUP_TOOLS.has(cmd)) return handleGroupTool(sock, msg, cmd, args, sender, owner);
    if (MEDIA_TOOLS.has(cmd)) return handleMediaTool(sock, msg, cmd, args);
    if (SOCIAL_GAMES.has(cmd)) return handleSocialGame(sock, msg, cmd, args, sender, settings);
    if (["verdad18", "reto18"].includes(cmd) && !settings.adultMode) {
      return sock.sendMessage(chatId, { text: "El modo +18 está apagado en este grupo." }, { quoted: msg });
    }
    if (cmd === "cola" || cmd === "cancelar") return downloadQueueCommand(sock, msg, sender, cmd === "cancelar");
    if (cmd === "health") return downloadHealth(sock, msg);
    if (cmd === "resumen") {
      const input = (text.replace(/^[!.]\s*resumen\b\s*/iu, "") || quotedText(msg)).slice(0, 10000);
      const lines = [...new Set(input.split(/\n+|(?<=[.!?])\s+/u).map(line => line.trim()).filter(Boolean))];
      return sock.sendMessage(chatId, {
        text: lines.length ? "Resumen rápido\n\n" + lines.slice(0, 5).map(line => "• " + line.slice(0, 250)).join("\n")
          : "Respondé al texto que querés resumir o escribilo después de .resumen."
      }, { quoted: msg });
    }
    if (cmd === "ytsearch") return withProgress(sock, msg, () => handleYouTubeSearch(sock, msg, args.join(" "), sender));
    if (isPlayChoice) {
      if (settings.disabledCommands?.play) return;
      return handlePlayChoiceReply(sock, msg, text, sender);
    }
    if (cmd === "play") return withProgress(sock, msg, () => handlePlayCommand(sock, msg, args, sender));
    if (["tk", "ig", "instagram", "fb", "facebook", "x", "twitter"].includes(cmd)) {
      return withProgress(sock, msg, () => handleSocialDownload(sock, msg, args, family[cmd] || cmd, sender));
    }
    if (cmd === "youtube" || cmd === "yt") {
      return withProgress(sock, msg, () => handlePlayCommand(sock, msg, args.length ? ["2", ...args] : [], sender));
    }

    // Menús
    if (cmd === "menu") {
      const caption = getMainMenu(`@${senderNum}`);
      const options = { quoted: msg };
      try {
        const image = await readFile(join(__dirname, "data", "image(6).png"));
        await sock.sendMessage(chatId, { image, caption, mentions: [sender] }, options);
      } catch (error) {
        console.error("[Menu]", error.message);
        await sock.sendMessage(chatId, { text: caption, mentions: [sender] }, options);
      }
      return;
    }

    if (cmd === "menu1") return sock.sendMessage(chatId, { text: MENU_1 }, { quoted: msg });
    if (cmd === "menu2") return sock.sendMessage(chatId, { text: MENU_2 }, { quoted: msg });
    if (cmd === "menu3") return sock.sendMessage(chatId, { text: MENU_3 }, { quoted: msg });
    if (cmd === "menu4") return sock.sendMessage(chatId, { text: MENU_4 }, { quoted: msg });
    if (cmd === "menu5") return sock.sendMessage(chatId, { text: MENU_5 }, { quoted: msg });
    if (cmd === "menuall") return sock.sendMessage(chatId, { text: getMenuAll() }, { quoted: msg });

    // Básicos y diversión
    if (cmd === "yo") {
      return sock.sendMessage(chatId, {
        text: `🖤 𝙰𝚚𝚞𝚒 𝚜𝚒𝚐𝚘 𝚏𝚒𝚛𝚖𝚎, 𝚜𝚒𝚗 𝚌𝚊𝚎𝚛𝚖𝚎.\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    if (cmd === "rozty" || cmd === "roztypollo") {
      await sock.sendMessage(chatId, { text: "Que me dice saic@, como esta?" }, { quoted: msg });
      return;
    }

    if (cmd === "info") {
      await sock.sendMessage(chatId, {
        text: "Roztypollo Bot • Creado por David\nInstagram: https://www.instagram.com/davhzzz/"
      }, { quoted: msg });
      return;
    }

    if (cmd === "version") {
      return sock.sendMessage(chatId, {
        text: `⚡ 𝚁𝚘𝚣𝚝𝚢𝚙𝚘𝚕𝚕𝚘 𝚟𝟼.𝟶 • 𝙱𝚊𝚒𝚕𝚎𝚢𝚜 𝙼𝚞𝚕𝚝𝚒-𝙳𝚎𝚟𝚒𝚌𝚎\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    if (cmd === "estado") {
      const allGroups = getAllGroupsState();
      const activeCount = Object.values(allGroups).filter((g) => g.active).length;
      const mutedCount = isGroup ? listMutedInGroup(chatId).length : 0;
      const gMode = isGroup ? (getGroupState(chatId).adminOnly ? "ON" : "OFF") : "N/A";
      return sock.sendMessage(chatId, {
        text: `🌑 𝙴𝚂𝚃𝙰𝙳𝙾 𝙳𝙴 𝚁𝙾𝚉𝚃𝚈𝙿𝙾𝙻𝙻𝙾 ⚡\n\n♠️ 𝚃𝚒𝚎𝚖𝚙𝚘 𝚊𝚌𝚝𝚒𝚟𝚘: ${formatDuration(Date.now() - startTime)}\n🖤 𝙶𝚛𝚞𝚙𝚘𝚜 𝚊𝚌𝚝𝚒𝚟𝚘𝚜: ${activeCount}\n🔇 𝙼𝚞𝚝𝚎𝚊𝚍𝚘𝚜 𝚊𝚚𝚞𝚒: ${mutedCount}\n🛡️ 𝙼𝚘𝚍𝚘 𝚊𝚍𝚖𝚒𝚗: ${gMode}\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    if (cmd === "guia") {
      return sock.sendMessage(chatId, {
        text: `🌿 𝙶𝚄𝙸𝙰 𝚁𝙰𝙿𝙸𝙳𝙰 𝙳𝙴 𝚁𝙾𝚉𝚃𝚈𝙿𝙾𝙻𝙻𝙾 ⚡\n\n𝟷. 𝚄𝚜𝚊 \`.menu\` 𝚘 𝚟𝚎 𝚍𝚒𝚛𝚎𝚌𝚝𝚘 𝚊 \`.menu1\`, \`.menu2\`, \`.menu3\` 𝚘 \`.menu4\`.\n𝟸. 𝙿𝚛𝚎𝚏𝚒𝚓𝚘𝚜 𝚍𝚒𝚜𝚙𝚘𝚗𝚒𝚋𝚕𝚎𝚜: \`！\` 𝚢 \`．\` (𝚎𝚓𝚎𝚖𝚙𝚕𝚘: \`.dado\`, \`.ship\`, \`.afk\`).\n𝟹. 𝙻𝚘𝚜 𝚓𝚞𝚎𝚐𝚘𝚜 𝚜𝚘𝚗 𝚍𝚒𝚛𝚎𝚌𝚝𝚘 𝚌𝚘𝚗𝚝𝚛𝚊 𝚎𝚕 𝚋𝚘𝚝\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    if (cmd === "reglas") {
      if (!isGroup) return;
      const category = args[0]?.toLowerCase();
      if (category && ["vv2", "clk", "ios", "android", "pc"].includes(category)) {
        return sock.sendMessage(chatId, {
          text: settings.rulesByCategory?.[category] || `Todavía no hay reglas guardadas para ${category}.`
        }, { quoted: msg });
      }
      const meta = await sock.groupMetadata(chatId);
      const rules = meta.desc || getGroupState(chatId).rules || "Este grupo aún no tiene reglas puestas.";
      return sock.sendMessage(chatId, {
        text: `📜 𝚁𝙴𝙶𝙻𝙰𝚂 𝙳𝙴𝙻 𝙶𝚁𝚄𝙿𝙾:\n\n${rules}\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    if (cmd === "afk") {
      const reason = args.join(" ") || "Sin motivo";
      afkMap.set(senderNum, { reason, since: Date.now() });
      return sock.sendMessage(chatId, {
        text: `💤 𝙰𝙵𝙺 𝚊𝚌𝚝𝚒𝚟𝚊𝚍𝚘 𝚙𝚊𝚛𝚊 @${senderNum}.\n𝙼𝚘𝚝𝚒𝚟𝚘: ${reason}\n\n${SIGNATURE}`,
        mentions: [sender]
      }, { quoted: msg });
    }

    const funMap = {
      chiste: ["😂", content.chistes],
      frase: ["💭", content.frases],
      curiosidad: ["🧠", content.curiosidades],
      adivinanza: ["🧩", content.adivinanzas],
      consejo: ["💡", content.consejos],
      sabia: ["🌟", content.sabias],
      chisme: ["👀", content.chismes]
    };

    if (funMap[cmd]) {
      const [icon, list] = funMap[cmd];
      return sock.sendMessage(chatId, {
        text: `${icon} ${pickRandom(list)}\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    // Stickers (.s / .sticker / .ss / .brat / .qc)
    if (cmd === "s" || cmd === "sticker") {
      const media = getStickerMedia(msg);
      const img = media?.imageMessage;
      const vid = media?.videoMessage;
      if (!img && !vid) {
        return failStickerCommand(sock, msg, badSyntaxMsg(".s (enviando o respondiendo a una foto o video)"));
      }
      return runStickerJob(sock, msg, async () => {
        const buf = await downloadMediaBuffer(img || vid, img ? "image" : "video");
        const webp = await createWebpSticker(buf, !img);
        await sock.sendMessage(chatId, { sticker: webp }, { quoted: msg });
      }, error => error.message.startsWith("El archivo") ? error.message : actionFailedMsg());
    }

    if (SOUND_STICKER_COMMANDS.has(cmd)) {
      return handleSoundSticker(sock, msg, cmd, args, sender, settings, getStickerMedia(msg, true)?.videoMessage);
    }

    if (cmd === "brat") {
      const txt = hasPrefix && requested === "brat" ? text.replace(/^[!.]\s*brat\b\s*/iu, "") : args.join(" ").trim();
      if (!txt) {
        return failStickerCommand(sock, msg, badSyntaxMsg(".brat hola compa"));
      }
      return runStickerJob(sock, msg, async () => {
        const webp = await createBratSticker(txt);
        await sock.sendMessage(chatId, { sticker: webp }, { quoted: msg });
      }, actionFailedMsg);
    }

    if (cmd === "qc" || cmd === "quotly" || cmd === "q" || cmd === "qmulti") {
      const ctx = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo;
      const quoted = normalizeMessageContent(ctx?.quotedMessage);
      const subject = (quoted && ctx.participant) || ctx?.mentionedJid?.[0] || sender;
      let quoteText = args.join(" ");
      if (!quoted && subject !== sender) quoteText = quoteText.replace(/^@\d+\s*/u, "");
      if (!quoteText && quoted) quoteText = extractText({ message: quoted });
      if (cmd === "qmulti") {
        const excerpts = quoteText.split("|").map(part => part.trim()).filter(Boolean);
        if (excerpts.length < 2 || excerpts.length > 8 || excerpts.join(" ").length > 180) {
          return failStickerCommand(sock, msg, "Usá .qmulti Un fragmento | Otro fragmento (hasta 8, con un total de 180 caracteres).");
        }
        quoteText = excerpts.join("\n");
      }

      const quotedPhoto = quoted?.imageMessage;
      if (!quoteText.trim() && !quotedPhoto) {
        return failStickerCommand(sock, msg, "Usá .qc hola o respondé a un mensaje con .qc.");
      }

      const subjectKey = jidNormalizedUser(subject);
      const author = (subjectKey === jidNormalizedUser(sender) ? msg.pushName : "")
        || quoteNames.get(subjectKey)
        || (subjectKey === jidNormalizedUser(sock.user?.id) ? sock.user?.name : "")
        || (subjectKey.endsWith("@s.whatsapp.net") ? "+" + subjectKey.split("@")[0] : "Usuario");
      return runStickerJob(sock, msg, async () => {
        const [avatar, photo] = await Promise.all([
          getQuoteAvatar(sock, subject),
          quotedPhoto ? downloadMediaBuffer(quotedPhoto, "image") : null
        ]);
        const webp = await createQuoteSticker(author, quoteText, avatar, photo);
        await sock.sendMessage(chatId, { sticker: webp }, { quoted: msg });
      }, actionFailedMsg);
    }

    // Utilidades
    if (cmd === "calc") {
      const expr = args.join("").replace(/[^0-9+\-*/().%]/g, "");
      if (!expr) {
        return sock.sendMessage(chatId, { text: badSyntaxMsg(".calc 25*4+10") }, { quoted: msg });
      }
      try {
        const result = Function(`"use strict"; return (${expr})`)();
        return sock.sendMessage(chatId, {
          text: `🧮 𝚁𝚎𝚜𝚞𝚕𝚝𝚊𝚍𝚘: *${result}*\n\n${SIGNATURE}`
        }, { quoted: msg });
      } catch {
        return sock.sendMessage(chatId, { text: badSyntaxMsg(".calc 25*4") }, { quoted: msg });
      }
    }

    if (cmd === "password") {
      const len = Math.min(32, Math.max(6, Number(args[0]) || 12));
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*";
      let pass = "";
      for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
      return sock.sendMessage(chatId, {
        text: `🔐 \`${pass}\`\n\n${SIGNATURE}`
      }, { quoted: msg });
    }

    // Juegos y dinámicas
    if (await handleGamesCommand(sock, msg, cmd, args)) return;

    // Admin y moderación
    const templateEdit = /^[!.]\s*set\s+(welcome|bye)(?:\s+([\s\S]*))?$/iu.exec(text);
    if (templateEdit) {
      if (isGroup && templateEdit[2]?.trim().toLowerCase() === "ver") {
        return sock.sendMessage(chatId, {
          text: renderGreeting(settings, templateEdit[1].toLowerCase() === "bye" ? "remove" : "add", `@${senderNum}`),
          mentions: [sender]
        }, { quoted: msg });
      }
      return handleAdminCommand(sock, msg, "set " + templateEdit[1].toLowerCase(), [templateEdit[2] || ""], owner);
    }
    const adminArgs = cmd === "n" ? [text.replace(/^[!.]\s*n\b\s*/iu, "")] : args;
    return handleAdminCommand(sock, msg, cmd, adminArgs, owner);

    }
  }
}

function runBot() {
  startBot().catch(error => {
    console.error("Error al iniciar Roztypollo:", error.message);
    process.exitCode = 1;
  });
}

runBot();
