const { randomInt } = require("node:crypto");
const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const { getGroupState } = require("../utils/storage");

const SOCIAL_GAMES = new Set(["ttt", "ahorcado", "retoff", "dilema", "dilema18", "bingo", "bingo18",
  "redflag", "yonunca18", "ruleta18", "impostor", "roast", "duelo", "juicio", "premios", "match18", "confesion18"]);
const INVITE_GAMES = new Set(["roast", "duelo", "juicio", "match18"]);
const WORDS = ["escopeta", "granada", "mochila", "tormenta", "diamante", "pelicula", "futbol"];
const WIN = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const games = new Map();
const confessions = new Map();
const pick = values => values[randomInt(values.length)];
const tag = jid => "@" + jid.split("@")[0].split(":")[0];

async function handleSocialGame(sock, msg, cmd, args, sender, settings) {
  const chat = msg.key.remoteJid;
  const reply = (text, mentions = []) => sock.sendMessage(chat, { text, mentions }, { quoted: msg });
  const poll = (name, values) => sock.sendMessage(chat, { poll: { name, values, selectableCount: 1 } }, { quoted: msg });
  const input = args.join(" ").trim();
  if (cmd === "confesion18") {
    const now = Date.now();
    for (const [key, session] of confessions) if (session.expires <= now) confessions.delete(key);
    if (chat.endsWith("@g.us")) {
      if (!settings.adultMode) return reply("El modo +18 está apagado en este grupo.");
      if (input || (confessions.size >= 200 && !confessions.has(sender))) {
        return reply("Escribí .confesion18 sin texto en el grupo para abrir el borrador privado.");
      }
      confessions.set(sender, { chat, expires: now + 300000 });
      return sock.sendMessage(sender, { text: "Escribí .confesion18 [tu texto] acá en privado. Después podrás confirmar o cancelar." });
    }
    const session = confessions.get(sender);
    if (!session) return reply("Abrí un borrador con .confesion18 dentro del grupo.");
    if (input === "cancelar") {
      confessions.delete(sender);
      return reply("Confesión cancelada.");
    }
    if (input === "confirmar") {
      if (!session.text) return reply("Todavía no hay un borrador para publicar.");
      const target = getGroupState(session.chat);
      if (!target.active || !target.adultMode) {
        confessions.delete(sender);
        return reply("El grupo ya no admite confesiones.");
      }
      const group = await sock.groupMetadata(session.chat);
      if (!group.participants.some(person => [person.id, person.lid, person.phoneNumber].includes(sender))) {
        confessions.delete(sender);
        return reply("El borrador solo se puede publicar mientras sigás en ese grupo.");
      }
      if (confessions.get(sender) !== session) return;
      confessions.delete(sender);
      await sock.sendMessage(session.chat, { text: `Confesión de ${tag(sender)}\n\n${session.text}`, mentions: [sender] });
      return reply("Confesión publicada.");
    }
    if (!input || input.length > 500) return reply("Escribí .confesion18 seguido de tu texto (hasta 500 caracteres).");
    confessions.set(sender, { ...session, text: input });
    return reply("Borrador guardado. .confesion18 confirmar publica tu texto con tu mención. .confesion18 cancelar lo borra.");
  }
  if (cmd.endsWith("18") && !settings.adultMode) return reply("El modo +18 está apagado en este grupo.");
  switch (cmd) {
    case "premios": {
      const [title, ...nominees] = input.split("|").map(value => value.trim());
      if (!title || title.length > 150 || nominees.length < 2 || nominees.length > 8 ||
          nominees.some(value => !value || value.length > 80) || new Set(nominees).size !== nominees.length) {
        return reply("Usá .premios El que siempre llega tarde | Ana | David.");
      }
      return poll("🏆 " + title, nominees);
    }
    case "retoff":
      return reply(pick(["Solo escopetas hasta el primer derribo.", "Cambien de arma después de cada derribo.", "Lleguen juntos al final sin separarse."]));
    case "yonunca18":
      return reply("Yo nunca… " + pick(["le mandé una indirecta a alguien del grupo.", "me puse nervioso en una cita.", "me enamoré de alguien con quien jugaba."]) + "\nPodés pasar.");
    case "ruleta18":
      return reply(pick(["Verdad: ¿quién te ha hecho sonrojar últimamente?", "Reto: mandá tu mejor frase para ligar.", "Comodín: podés pasar."]));
    case "dilema":
      return poll("¿Qué preferís?", ["Quedarte sin música una semana", "Quedarte sin juegos una semana"]);
    case "dilema18":
      return poll("¿Qué preferís en una cita?", ["Dar el primer paso", "Que la otra persona lo dé"]);
    case "bingo":
      return reply("Bingo del grupo\n☐ Dije «ya voy» y seguía en cama\n☐ Perdí el primer duelo\n☐ Llegué tarde a la partida\n☐ Olvidé silenciar el micro");
    case "bingo18":
      return reply("Bingo +18\n☐ Tiré una indirecta\n☐ Me dio pena invitar a salir\n☐ Ensayé un mensaje antes de enviarlo\n☐ Me puse nervioso en una cita");
    case "redflag":
      return input && input.length <= 200 ? poll(input, ["🚩 Red flag", "💚 Green flag"]) : reply("Usá .redflag y escribí la situación.");
  }

  if (!chat.endsWith("@g.us")) return reply("Usá este juego dentro de un grupo.");
  const now = Date.now();
  for (const [key, game] of games) if (game.expires <= now) games.delete(key);
  const key = chat + ":" + cmd;
  const game = games.get(key);
  if (!game && games.size >= 200) return reply("Hay muchas partidas activas. Probá más tarde.");
  if (INVITE_GAMES.has(cmd)) {
    if (!game) {
      const rival = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!rival || rival === sender) return reply(`Usá .${cmd} @usuario para invitar a otra persona.`);
      games.set(key, { players: [sender, rival], expires: now + 300000, accepted: false, entries: new Map() });
      return reply(`${tag(rival)}, escribí .${cmd} aceptar o .${cmd} pasar.`, [rival]);
    }
    if (!game.players.includes(sender)) return reply("Esta invitación es entre las dos personas que participan.");
    if (input === "pasar") {
      games.delete(key);
      return reply("Dinámica cancelada.");
    }
    if (!game.accepted) {
      if (input !== "aceptar" || sender !== game.players[1]) return reply("La invitación sigue pendiente.");
      if (cmd === "roast") {
        games.delete(key);
        return reply(`${tag(sender)}, ${pick(["decís «ya voy» con tanta confianza que hasta el reloj te cree.", "tu WiFi tiene más suspenso que el cierre de la partida.", "si esperar turno diera puntos, ya serías leyenda."])}`, [sender]);
      }
      game.accepted = true;
      game.expires = now + 300000;
      const instruction = cmd === "juicio" ? "Uno escribe una acusación absurda y el otro responde con su defensa." :
        cmd === "match18" ? "¿Cuál es tu plan ideal para una primera cita? Sólo escribí si querés que el grupo vea tu respuesta." :
          "Cada persona escribe una indirecta de broma.";
      return reply(`${instruction}\nMandá .${cmd} [texto] o .${cmd} pasar.`);
    }
    if (!input || input.length > 180 || input === "aceptar") return reply(`Mandá .${cmd} [texto] de hasta 180 caracteres.`);
    game.entries.set(sender, input);
    if (game.entries.size < 2) return reply("Respuesta recibida. Falta la de la otra persona.");
    games.delete(key);
    const lines = game.players.map((jid, i) => `${i + 1}. ${tag(jid)}: ${game.entries.get(jid)}`).join("\n\n");
    await reply(lines, game.players);
    if (cmd === "juicio") return poll("⚖️ Veredicto de broma", ["Culpable", "Inocente"]);
    if (cmd === "duelo") return poll("¿Quién ganó el duelo?", ["Primera indirecta", "Segunda indirecta"]);
    return;
  }
  if (cmd === "impostor") {
    const [verb] = args;
    if (!game) {
      if (verb !== "crear") return reply("Usá .impostor crear, entrar o empezar.");
      games.set(key, { host: sender, people: new Set([sender]), expires: now + 600000 });
      return reply("🕵️ Escribí .impostor entrar para recibir un rol por privado al iniciar.");
    }
    if (verb === "entrar") {
      if (game.people.size >= 12) return reply("La partida está llena.");
      game.people.add(sender);
      return reply(`Inscritos: ${game.people.size}.`);
    }
    if (verb !== "empezar" || game.host !== sender || game.people.size < 3) {
      return reply("Quien creó la partida puede iniciarla cuando haya al menos 3 personas.");
    }
    games.delete(key);
    const players = [...game.people];
    const impostor = pick(players);
    const word = pick(WORDS);
    const deliveries = await Promise.allSettled(players.map(jid => sock.sendMessage(jid, {
      text: `🕵️ Impostor · ${chat.split("@")[0]}\n` + (jid === impostor ? "Sos el impostor." : "Tu palabra: " + word)
    })));
    return reply(deliveries.every(result => result.status === "fulfilled")
      ? "Ya envié los roles. Den una pista por turno." : "No pude entregar todos los roles. Creá otra partida.");
  }
  if (cmd === "ahorcado") {
    if (!game) {
      const word = pick(WORDS);
      games.set(key, { word, letters: new Set(), misses: 0, expires: now + 600000 });
      return reply(`Palabra: ${Array.from(word, () => "_").join(" ")}\nJugá con .ahorcado letra.`);
    }
    const letter = input.toLowerCase();
    if (!/^[a-z]$/u.test(letter) || game.letters.has(letter)) return reply("Probá con una letra que todavía no se haya usado.");
    game.letters.add(letter);
    if (!game.word.includes(letter)) game.misses++;
    const shown = Array.from(game.word, char => game.letters.has(char) ? char : "_");
    if (!shown.includes("_") || game.misses >= 6) {
      games.delete(key);
      return reply(`Fin de la partida. La palabra era: ${game.word}.`);
    }
    return reply(`${shown.join(" ")}\nErrores: ${game.misses}/6`);
  }
  if (!game) {
    const rival = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!rival || rival === sender) return reply("Usá .ttt @usuario para invitar a otra persona.");
    games.set(key, { players: [sender, rival], board: Array(9).fill(""), turn: 0, accepted: false, expires: now + 600000 });
    return reply(`${tag(rival)}, escribí .ttt aceptar para jugar.`, [rival]);
  }
  if (!game.accepted) {
    if (input !== "aceptar" || sender !== game.players[1]) return reply("La partida espera a la persona invitada.");
    game.accepted = true;
  } else {
    const place = /^[1-9]$/u.test(input) ? Number(input) - 1 : -1;
    if (game.players[game.turn] !== sender || place < 0 || game.board[place]) return reply("Esperá tu turno y elegí una casilla libre del 1 al 9.");
    const mark = game.turn ? "⭕" : "❌";
    game.board[place] = mark;
    if (WIN.some(line => line.every(i => game.board[i] === mark)) || game.board.every(Boolean)) {
      games.delete(key);
      return WIN.some(line => line.every(i => game.board[i] === mark)) ? reply(`Ganó ${tag(sender)}.`, [sender]) : reply("Empate.");
    }
    game.turn = 1 - game.turn;
  }
  const board = game.board.map((value, i) => value || String(i + 1));
  const text = [board.slice(0, 3), board.slice(3, 6), board.slice(6)].map(row => row.join(" | ")).join("\n");
  return reply(`${text}\nTurno de ${tag(game.players[game.turn])}. Usá .ttt número.`, [game.players[game.turn]]);
}

module.exports = { SOCIAL_GAMES, handleSocialGame };
