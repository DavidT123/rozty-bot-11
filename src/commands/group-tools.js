const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const { getGroupState, updateGroupState } = require("../utils/storage");
const { isGroupAdmin } = require("../utils/permissions");
const { noPermissionMsg } = require("../utils/format");

const GROUP_TOOLS = new Set(["encuesta", "config", "warn", "warns", "unwarn", "marcador",
  "trigger", "comando", "alias", "scrim", "meapunto", "mesalgo", "equipos", "resultado", "tabla", "sorteo", "modo18", "setreglascat"]);
const ADMIN_TOOLS = new Set(["warn", "unwarn", "trigger", "comando", "alias", "resultado", "modo18", "setreglascat"]);
const SAFE_COMMANDS = new Set(["tk", "ig", "instagram", "facebook", "fb", "x", "twitter",
  "play", "yt", "youtube", "ytsearch", "s", "sticker", "ss", "brat", "bratv", "qc", "q",
  "toimg", "tomp3", "meme", "voz", "recortar", "ocr", "transcribir", "retoff", "dado", "moneda", "link"]);
const COMMAND_FAMILY = { tk: "tiktok", ig: "instagram", fb: "facebook", twitter: "x", yt: "youtube", q: "qc", quotly: "qc", sticker: "s", ssr: "ss", ss2: "ss" };

function quotedText(msg) {
  const quote = normalizeMessageContent(normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo?.quotedMessage);
  return quote?.conversation || quote?.extendedTextMessage?.text || quote?.imageMessage?.caption || quote?.videoMessage?.caption || "";
}

async function handleGroupTool(sock, msg, cmd, args, sender, owner) {
  const chatId = msg.key.remoteJid;
  const reply = text => sock.sendMessage(chatId, { text }, { quoted: msg });
  if (!chatId.endsWith("@g.us")) return reply("Usá este comando dentro de un grupo.");
  const [verb = "", ...rest] = args;
  const input = args.join(" ");
  const needsAdmin = ADMIN_TOOLS.has(cmd) || (cmd === "scrim" && !!verb) || (cmd === "sorteo" && verb !== "entrar") ||
    (cmd === "marcador" && ["guarda", "borrar"].includes(verb));
  if (needsAdmin && !owner && !(await isGroupAdmin(sock, chatId, sender))) return reply(noPermissionMsg());
  const state = getGroupState(chatId);
  switch (cmd) {
    case "encuesta": {
      const [name, ...values] = input.split("|").map(value => value.trim());
      if (!name || name.length > 255 || values.length < 2 || values.length > 12 ||
          values.some(value => !value || value.length > 100) || new Set(values).size !== values.length) {
        return reply("Usá .encuesta Pregunta | Opción A | Opción B (2 a 12 opciones distintas).");
      }
      return sock.sendMessage(chatId, { poll: { name, values, selectableCount: 1 } }, { quoted: msg });
    }
    case "config": {
      const flags = [["Bienvenida", "welcome"], ["Despedida", "bye"], ["Antilink", "antilink"],
        ["Antitoxic", "antitoxic"], ["Solo admins", "adminOnly"], ["Modo +18", "adultMode"]];
      const disabled = Object.keys(state.disabledCommands || {}).filter(key => state.disabledCommands[key])
        .map(key => key === "tiktok" ? "tk" : key);
      return reply("⚙️ Configuración del grupo\n\n" + flags.map(([label, key]) =>
        `${label}: ${state[key] ? "ON" : "OFF"}`).join("\n") + "\nComandos desactivados: " + (disabled.join(", ") || "ninguno"));
    }
    case "setreglascat": {
      const category = verb.toLowerCase();
      const rules = rest.join(" ") || quotedText(msg);
      if (!["vv2", "clk", "ios", "android", "pc"].includes(category) || !rules.trim() || rules.length > 2000) {
        return reply("Usá .setreglascat vv2 texto de las reglas.");
      }
      updateGroupState(chatId, { rulesByCategory: { ...state.rulesByCategory, [category]: rules } });
      return reply(`Reglas de ${category} guardadas para este grupo.`);
    }
    case "modo18":
      if (!["on", "off"].includes(verb)) return reply("Usá .modo18 on u off.");
      updateGroupState(chatId, { adultMode: verb === "on" });
      return reply(verb === "on" ? "Modo +18 activado en este grupo de adultos." : "Modo +18 desactivado.");
    case "warn":
    case "warns":
    case "unwarn": {
      const ctx = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo;
      const who = ctx?.mentionedJid?.[0] || ctx?.participant || (cmd === "warns" ? sender : "");
      if (!who) return reply("Mencioná a alguien o respondé a su mensaje.");
      if (cmd === "warns" && who !== sender && !owner && !(await isGroupAdmin(sock, chatId, sender))) {
        return reply(noPermissionMsg());
      }
      const warnings = { ...state.warnings };
      const current = warnings[who] || [];
      if (cmd === "warns") return reply(current.length
        ? current.map((entry, index) => `${index + 1}. ${entry}`).join("\n") : "No hay advertencias para esa persona.");
      if (cmd === "warn" && current.length >= 30) return reply("Esta persona ya tiene 30 advertencias.");
      if (cmd === "unwarn" && !current.length) return reply("No hay advertencias para quitar.");
      warnings[who] = cmd === "warn"
        ? [...current, (input.replace(/^@\d+\s*/u, "").trim() || "Sin motivo").slice(0, 250)] : current.slice(0, -1);
      updateGroupState(chatId, { warnings });
      return reply(`Advertencias guardadas: ${warnings[who].length}.`);
    }
    case "comando": {
      const requested = rest[0]?.toLowerCase().replace(/^[!.]/u, "");
      const key = COMMAND_FAMILY[requested] || requested;
      if (!["on", "off"].includes(verb) || !(SAFE_COMMANDS.has(key) || requested === "tk")) {
        return reply("Usá .comando off tk o .comando on tk.");
      }
      updateGroupState(chatId, { disabledCommands: { ...state.disabledCommands, [key]: verb === "off" } });
      return reply(`.${key === "tiktok" ? "tk" : key} quedó ${verb} en este grupo.`);
    }
    case "alias": {
      const [alias, target] = rest.map(value => value.toLowerCase());
      const aliases = { ...state.aliases };
      const safe = /^[a-z][a-z0-9-]{0,15}$/u.test(alias || "") && !SAFE_COMMANDS.has(alias) && !GROUP_TOOLS.has(alias);
      if (verb === "borrar" && safe) delete aliases[alias];
      else if (verb === "agregar" && safe && SAFE_COMMANDS.has(target) && Object.keys(aliases).length < 30) aliases[alias] = target;
      else return reply("Usá .alias agregar l link o .alias borrar l.");
      updateGroupState(chatId, { aliases });
      return reply("Atajo actualizado para este grupo.");
    }
    case "marcador":
    case "trigger": {
      const field = cmd === "marcador" ? "bookmarks" : "triggers";
      const items = { ...state[field] };
      if (verb === "lista") return reply(Object.keys(items).join(", ") || "Todavía no hay entradas.");
      if (cmd === "marcador" && !["guarda", "borrar"].includes(verb)) {
        return reply(Object.hasOwn(items, verb) ? items[verb] : "No encontré ese marcador.");
      }
      const [raw, ...values] = rest.join(" ").split("|");
      const key = raw?.trim().toLowerCase();
      if (!key || !/^[\p{L}\p{N} _-]{1,36}$/u.test(key)) return reply("Indicá un nombre válido.");
      if (verb === "borrar") delete items[key];
      else if (verb === (cmd === "marcador" ? "guarda" : "agregar")) {
        const value = (values.join("|").trim() || quotedText(msg)).slice(0, 1000);
        if (!value.trim() || (!Object.hasOwn(items, key) && Object.keys(items).length >= 30)) {
          return reply("Falta texto o ya alcanzaste el límite de 30 entradas.");
        }
        items[key] = value;
      } else return reply("Usá .trigger agregar palabra | respuesta, .trigger borrar palabra o .trigger lista.");
      updateGroupState(chatId, { [field]: items });
      return reply("Guardado para este grupo.");
    }
    case "scrim":
    case "meapunto":
    case "mesalgo":
    case "equipos": {
      let scrim = state.scrim;
      if (cmd === "scrim" && verb === "crear") {
        const [title, count] = rest.join(" ").split("|").map(value => value.trim());
        const slots = Number(/^([1-9]\d?)\s*(?:cupos)?$/iu.exec(count || "4")?.[1]);
        if (!title || !slots || slots > 64) return reply("Usá .scrim crear 8pm | 4 cupos.");
        scrim = { title: title.slice(0, 100), slots, members: [] };
        updateGroupState(chatId, { scrim });
      }
      if (!scrim) return reply("Todavía no hay una scrim abierta.");
      if (cmd === "meapunto" || cmd === "mesalgo") {
        const members = new Set(scrim.members);
        if (cmd === "meapunto") {
          if (members.size >= 100 && !members.has(sender)) return reply("La lista de inscritos está llena.");
          members.add(sender);
        } else members.delete(sender);
        scrim = { ...scrim, members: [...members] };
        updateGroupState(chatId, { scrim });
      }
      if (cmd === "equipos") {
        const size = Number(verb || 4);
        if (!Number.isInteger(size) || size < 2 || size > 10) return reply("Elegí un tamaño de equipo entre 2 y 10.");
        const members = shuffle(scrim.members);
        const groups = [];
        for (let i = 0; i < members.length; i += size) groups.push(`Equipo ${groups.length + 1}: ${members.slice(i, i + size).map(tag).join(" ")}`);
        return mention(sock, chatId, groups.join("\n") || "Todavía no hay inscritos.", members, msg);
      }
      const list = scrim.members.map((jid, i) => `${i < scrim.slots ? "Titular" : "Suplente"} · ${tag(jid)}`).join("\n");
      return mention(sock, chatId, `🎮 ${scrim.title} · ${scrim.slots} cupos\n${list || "Sin inscritos."}\n\n.meapunto / .mesalgo`, scrim.members, msg);
    }
    case "resultado": {
      const result = /^(.{1,32})\s*\|\s*(\d{1,2})-(\d{1,2})\s*\|\s*(.{1,32})$/u.exec(input);
      if (!result || result[1].trim().toLowerCase() === result[4].trim().toLowerCase()) return reply("Usá .resultado Equipo A | 2-1 | Equipo B.");
      const results = [...(state.results || []), [result[1].trim(), Number(result[2]), Number(result[3]), result[4].trim()]].slice(-100);
      updateGroupState(chatId, { results });
      return reply("Marcador guardado. Usá .tabla para ver las posiciones.");
    }
    case "tabla": {
      const points = new Map();
      for (const [left, a, b, right] of state.results || []) {
        points.set(left, (points.get(left) || 0) + (a === b ? 1 : a > b ? 3 : 0));
        points.set(right, (points.get(right) || 0) + (a === b ? 1 : b > a ? 3 : 0));
      }
      return reply([...points].sort((a, b) => b[1] - a[1]).map(([team, score]) => `${team} · ${score} pts`).join("\n") || "Todavía no hay resultados.");
    }
    case "sorteo": {
      const current = state.draw;
      if (verb === "entrar" && current) {
        if (current.members.length >= 200) return reply("El sorteo está lleno.");
        updateGroupState(chatId, { draw: { ...current, members: [...new Set([...current.members, sender])] } });
        return reply("Te anotaste al sorteo.");
      }
      if (verb === "cerrar" && current) {
        const winners = shuffle(current.members).slice(0, current.count);
        updateGroupState(chatId, { draw: null });
        return mention(sock, chatId, winners.length ? "Ganadores: " + winners.map(tag).join(", ") : "El sorteo quedó sin participantes.", winners, msg);
      }
      const count = Number(verb);
      if (!Number.isInteger(count) || count < 1 || count > 20 || current) return reply("Usá .sorteo 2 cupos, .sorteo entrar o .sorteo cerrar.");
      updateGroupState(chatId, { draw: { count, members: [] } });
      return reply(`🎟️ Sorteo de ${count} cupos. Escribí .sorteo entrar para participar.`);
    }
  }
}

function tag(jid) {
  return "@" + jid.split("@")[0].split(":")[0];
}

function mention(sock, chat, text, mentions, msg) {
  return sock.sendMessage(chat, { text, mentions }, { quoted: msg });
}

function shuffle(input) {
  const values = [...input];
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

module.exports = { GROUP_TOOLS, COMMAND_FAMILY, handleGroupTool, quotedText };
