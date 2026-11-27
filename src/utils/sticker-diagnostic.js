const { proto, normalizeMessageContent } = require("@whiskeysockets/baileys");
const { Reader } = require("protobufjs/minimal");

const diagnostic = "roztyStickerDiagnostic";
const pending = new Map();
const recent = new Map();
const latest = new Map();
let installed = false;

function bytesField(buffer, number) {
  const reader = Reader.create(buffer);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === ((number << 3) | 2)) return reader.bytes();
    reader.skipType(tag & 7);
  }
}

function installStickerDiagnostic() {
  if (installed) return;
  installed = true;
  const decode = proto.Message.decode;
  proto.Message.decode = function (input, length, ...args) {
    const start = input instanceof Reader ? input.pos : 0;
    const message = decode.call(this, input, length, ...args);
    try {
      const bytes = input instanceof Reader ? input.buf.subarray(start, input.pos) : input;
      const wrapper = bytesField(bytes, 134);
      const inner = wrapper ? bytesField(wrapper, 1) : bytes;
      const sticker = inner && bytesField(inner, 26);
      if (!sticker && !wrapper) return message;
      const sound = sticker && bytesField(sticker, 26);
      const audio = sound && proto.Message.AudioMessage.decode(sound);
      message[diagnostic] = {
        format: wrapper ? "audioStickerMessage (134)" : "stickerMessage (26)",
        audio: audio?.mimetype || (audio ? "tipo sin declarar" : "sin pista adjunta"),
        seconds: audio?.seconds || 0,
        voice: audio?.ptt === true,
        hasDirectPath: Boolean(audio?.directPath),
        hasMediaKey: Boolean(audio?.mediaKey?.length),
        hasSidecar: Boolean(audio?.streamingSidecar?.length)
      };
    } catch {
      // A diagnostic failure must never prevent normal message delivery.
    }
    return message;
  };
}

function armStickerDiagnostic(chatId, onTimeout) {
  const expires = Date.now() + 120000;
  pending.set(chatId, expires);
  setTimeout(() => {
    if (pending.get(chatId) !== expires) return;
    pending.delete(chatId);
    onTimeout?.();
  }, 120000).unref();
}

function inspectSticker(message) {
  const content = normalizeMessageContent(message);
  return message?.[diagnostic] || content?.[diagnostic] ||
    (content?.stickerMessage && { format: "stickerMessage", audio: "Baileys solo recibió la imagen del sticker", seconds: 0 });
}

function remember(map, key, info) {
  map.delete(key);
  map.set(key, info);
  if (map.size > 250) map.delete(map.keys().next().value);
}

function recordStickerDiagnostic(chat, sender, report) {
  remember(recent, chat + ":" + report.id, report);
  remember(latest, chat + ":" + sender, report);
}

function readStickerDiagnostic(msg) {
  const chat = msg.key.remoteJid;
  if (!chat?.endsWith("@g.us")) {
    const info = inspectSticker(msg.message);
    if (!info) return;
    if (msg.key.id && !recent.has(chat + ":" + msg.key.id)) remember(recent, chat + ":" + msg.key.id, info);
    if (!(pending.get(chat) > Date.now())) return;
    pending.delete(chat);
    return info;
  }
}

function findStickerDiagnostic(msg, sender, last) {
  const chat = msg.key.remoteJid;
  if (last) return latest.get(chat + ":" + sender);
  const ctx = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo;
  return (ctx?.stanzaId && recent.get(chat + ":" + ctx.stanzaId)) || inspectSticker(ctx?.quotedMessage);
}

function formatStickerDiagnostic(info) {
  const yesNo = value => typeof value !== "boolean" ? "sin datos" : value ? "sí" : "no";
  const source = info.sourceInfo;
  return [
    "🔎 Diagnóstico del sticker", info.mode && "Entrada: " + info.mode,
    source?.provider && "Fuente: " + source.provider,
    source && `Entrada original: ${source.videoCodec || "?"} / ${source.audioCodec || "?"}, ${source.channels || "?"} canales, ${source.sampleRate || "?"} Hz`,
    source && `Inicio original: video ${source.videoStart ?? "?"} s / audio ${source.audioStart ?? "?"} s`,
    info.actualSeconds !== undefined && "Duración de la animación: " + info.actualSeconds + " s",
    "Formato: " + info.format, "Audio: " + info.audio,
    "Duración declarada del audio: " + (info.seconds || "sin datos") + (info.seconds ? " s" : ""),
    "Nota de voz: " + yesNo(info.voice), "Ruta de audio: " + yesNo(info.hasDirectPath),
    "Clave de audio: " + yesNo(info.hasMediaKey), "Datos de streaming: " + yesNo(info.hasSidecar)
  ].filter(Boolean).join("\n");
}

module.exports = { installStickerDiagnostic, armStickerDiagnostic, readStickerDiagnostic,
  recordStickerDiagnostic, findStickerDiagnostic, formatStickerDiagnostic };
