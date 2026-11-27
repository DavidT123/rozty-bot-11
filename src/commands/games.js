const { readJSON } = require("../utils/storage");
const { SIGNATURE, badSyntaxMsg } = require("../utils/format");

const content = readJSON("content.json", {});

function pickRandom(arr = []) {
  if (!arr.length) return "Sin datos disponibles.";
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildBar(pct) {
  const filled = Math.round(pct / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

function shipVerdict(pct) {
  if (pct >= 85) return "Puro fuego, ya casi boda.";
  if (pct >= 60) return "Buena química, hay futuro ahí.";
  if (pct >= 35) return "Puede funcionar si le ponen ganas.";
  return "Mejor quédense como compas.";
}

async function handleGamesCommand(sock, msg, cmd, args) {
  const chatId = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  switch (cmd) {
    case "dado": {
      const n = Math.floor(Math.random() * 6) + 1;
      await sock.sendMessage(chatId, {
        text: `🎲 𝚂𝚊𝚕𝚒𝚘 𝚎𝚕 𝚗𝚞𝚖𝚎𝚛𝚘 *${n}*\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "moneda": {
      const choice = (args[0] || "").toLowerCase();
      if (choice && choice !== "cara" && choice !== "cruz") {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".moneda cara") }, { quoted: msg });
        return true;
      }
      const res = Math.random() < 0.5 ? "cara" : "cruz";
      const extra = choice
        ? (choice === res ? "\n✅ 𝙶𝚊𝚗𝚊𝚜𝚝𝚎, 𝚊𝚌𝚎𝚛𝚝𝚊𝚜𝚝𝚎." : "\n❌ 𝙿𝚎𝚛𝚍𝚒𝚜𝚝𝚎 𝚌𝚘𝚖𝚙𝚊.")
        : "";
      await sock.sendMessage(chatId, {
        text: `🪙 𝙲𝚊𝚢𝚘 *${res.toUpperCase()}*${extra}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "ppt":
    case "piedra": {
      const userMove = (args[0] || "").toLowerCase();
      const valid = ["piedra", "papel", "tijera"];
      if (!valid.includes(userMove)) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".ppt piedra") }, { quoted: msg });
        return true;
      }
      const botMove = pickRandom(valid);
      let outcome = "🤝 𝙴𝚖𝚙𝚊𝚝𝚎.";
      if (
        (userMove === "piedra" && botMove === "tijera") ||
        (userMove === "papel" && botMove === "piedra") ||
        (userMove === "tijera" && botMove === "papel")
      ) {
        outcome = "🏆 𝙼𝚎 𝚐𝚊𝚗𝚊𝚜𝚝𝚎 𝚎𝚜𝚝𝚊 𝚟𝚎𝚣.";
      } else if (userMove !== botMove) {
        outcome = "💀 𝚃𝚎 𝚐𝚊𝚗𝚎 𝚢𝚘.";
      }
      await sock.sendMessage(chatId, {
        text: `✂️ 𝚃𝚞: *${userMove}* | 𝙱𝚘𝚝: *${botMove}*\n${outcome}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "numero": {
      const guess = Number(args[0]);
      if (!guess || guess < 1 || guess > 10) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".numero 7") }, { quoted: msg });
        return true;
      }
      const secret = Math.floor(Math.random() * 10) + 1;
      const win = guess === secret;
      await sock.sendMessage(chatId, {
        text: `🔢 𝙴𝚕 𝚗𝚞𝚖𝚎𝚛𝚘 𝚎𝚛𝚊 *${secret}*. ${win ? "🎯 𝙻𝚎 𝚙𝚎𝚐𝚊𝚜𝚝𝚎 𝚍𝚎 𝚞𝚗𝚊." : "❌ 𝙽𝚘 𝚎𝚛𝚊 𝚎𝚜𝚎, 𝚒𝚗𝚝𝚎𝚗𝚝𝚊 𝚘𝚝𝚛𝚊 𝚟𝚎𝚣."}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "8ball": {
      if (!args.length) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".8ball ¿hoy coronamos?") }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(chatId, {
        text: `🔮 ${pickRandom(content["8ball"])}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "ruleta": {
      const shot = Math.floor(Math.random() * 6) + 1;
      const boom = shot === 1;
      await sock.sendMessage(chatId, {
        text: boom
          ? `🎡 💥 ¡𝙿𝚄𝙼! 𝚃𝚎 𝚝𝚘𝚌𝚘 𝚕𝚊 𝚋𝚊𝚕𝚊, 𝚌𝚊𝚒𝚜𝚝𝚎.\n\n${SIGNATURE}`
          : `🎡 𝙲𝚕𝚒𝚌𝚔... 𝚃𝚎 𝚜𝚊𝚕𝚟𝚊𝚜𝚝𝚎 𝚎𝚜𝚝𝚊 𝚛𝚘𝚗𝚍𝚊.\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "ruletareto": {
      await sock.sendMessage(chatId, {
        text: `🎯 𝚁𝚄𝙻𝙴𝚃𝙰 𝙳𝙴 𝚁𝙴𝚃𝙾:\n${pickRandom(content.ruleta_retos)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "suerte":
    case "caja": {
      const prizes = [
        "Te tocó suerte máxima hoy 🔥",
        "Caja vacía... puro humo 💨",
        "Hoy nadie te gana en nada ⚡",
        "Cuidado hoy, andas salado 💀"
      ];
      await sock.sendMessage(chatId, {
        text: `🎁 ${pickRandom(prizes)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "elige": {
      const joined = args.join(" ");
      const options = joined.split("|").map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".elige dormir | jugar") }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(chatId, {
        text: `⚖️ 𝙴𝚕𝚒𝚓𝚘: *${pickRandom(options)}*\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "ship": {
      if (mentioned.length < 2) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".ship @persona1 @persona2") }, { quoted: msg });
        return true;
      }
      const [u1, u2] = mentioned;
      const pct = Math.floor(Math.random() * 101);
      await sock.sendMessage(chatId, {
        text: `💘 𝙼𝙴𝙳𝙸𝙳𝙾𝚁 𝙳𝙴 𝚂𝙷𝙸𝙿\n@${u1.split("@")[0]} ❤️ @${u2.split("@")[0]}\n𝙲𝚘𝚖𝚙𝚊𝚝𝚒𝚋𝚒𝚕𝚒𝚍𝚊𝚍: *${pct}%* ${buildBar(pct)}\n${shipVerdict(pct)}\n\n${SIGNATURE}`,
        mentions: [u1, u2]
      }, { quoted: msg });
      return true;
    }

    case "shiprandom": {
      if (!chatId.endsWith("@g.us")) return false;
      const meta = await sock.groupMetadata(chatId);
      const members = meta.participants.map((p) => p.id);
      if (members.length < 2) return false;
      const u1 = pickRandom(members);
      let u2 = pickRandom(members);
      while (u2 === u1 && members.length > 1) u2 = pickRandom(members);
      const pct = Math.floor(Math.random() * 101);
      await sock.sendMessage(chatId, {
        text: `💘 𝚂𝙷𝙸𝙿 𝚁𝙰𝙽𝙳𝙾𝙼\n@${u1.split("@")[0]} ❤️ @${u2.split("@")[0]}\n𝙲𝚘𝚖𝚙𝚊𝚝𝚒𝚋𝚒𝚕𝚒𝚍𝚊𝚍: *${pct}%* ${buildBar(pct)}\n${shipVerdict(pct)}\n\n${SIGNATURE}`,
        mentions: [u1, u2]
      }, { quoted: msg });
      return true;
    }

    case "shipde": {
      if (!chatId.endsWith("@g.us") || mentioned.length < 1) {
        await sock.sendMessage(chatId, { text: badSyntaxMsg(".shipde @persona") }, { quoted: msg });
        return true;
      }
      const u1 = mentioned[0];
      const meta = await sock.groupMetadata(chatId);
      const members = meta.participants.map((p) => p.id).filter((id) => id !== u1);
      if (!members.length) return false;
      const u2 = pickRandom(members);
      const pct = Math.floor(Math.random() * 101);
      await sock.sendMessage(chatId, {
        text: `💘 𝚂𝙷𝙸𝙿 𝙳𝙴 @${u1.split("@")[0]}\n@${u1.split("@")[0]} ❤️ @${u2.split("@")[0]}\n𝙲𝚘𝚖𝚙𝚊𝚝𝚒𝚋𝚒𝚕𝚒𝚍𝚊𝚍: *${pct}%* ${buildBar(pct)}\n${shipVerdict(pct)}\n\n${SIGNATURE}`,
        mentions: [u1, u2]
      }, { quoted: msg });
      return true;
    }

    case "verdad": {
      await sock.sendMessage(chatId, {
        text: `🎭 𝚅𝙴𝚁𝙳𝙰𝙳:\n${pickRandom(content.verdades)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "verdad18": {
      await sock.sendMessage(chatId, {
        text: `🎭 𝚅𝙴𝚁𝙳𝙰𝙳 +𝟷𝟾:\n${pickRandom(content.verdades18)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "reto": {
      await sock.sendMessage(chatId, {
        text: `🔥 𝚁𝙴𝚃𝙾:\n${pickRandom(content.retos)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "reto18": {
      await sock.sendMessage(chatId, {
        text: `🔥 𝚁𝙴𝚃𝙾 +𝟷𝟾:\n${pickRandom(content.retos18)}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    case "preguntas": {
      const lvl = args[0] && ["1", "2", "3", "4"].includes(args[0])
        ? args[0]
        : pickRandom(["1", "2", "3"]);
      await sock.sendMessage(chatId, {
        text: `❓ 𝙿𝚁𝙴𝙶𝚄𝙽𝚃𝙰 (𝙽𝚒𝚟𝚎𝚕 ${lvl}):\n${pickRandom(content.preguntas[lvl])}\n\n${SIGNATURE}`
      }, { quoted: msg });
      return true;
    }

    default:
      return false;
  }
}

module.exports = { handleGamesCommand };
