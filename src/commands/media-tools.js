const sharp = require("sharp");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { normalizeMessageContent } = require("@whiskeysockets/baileys");
const { runStickerJob } = require("../utils/sticker-jobs");
const { actionFailedMsg } = require("../utils/format");
const { downloadMediaBuffer, convertVideo, escapeXml, createAnimatedBratSticker, addStickerMetadata } = require("../utils/stickers");

const exec = promisify(execFile);
const MEDIA_TOOLS = new Set(["aw", "toimg", "tomp3", "voz", "recortar", "meme", "bratv", "ocr", "transcribir"]);
const VOICE_FILTERS = new Map([
  ["robot", "tremolo=f=30:d=0.9"], ["ardilla", "asetrate=72000,aresample=48000"],
  ["grave", "asetrate=36000,aresample=48000"], ["radio", "highpass=f=400,lowpass=f=3000"],
  ["eco", "aecho=0.8:0.7:90:0.4"]
]);

function parseTime(value = "") {
  if (!/^\d{1,3}(?::[0-5]\d)?$/u.test(value)) return NaN;
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

async function extractLocalText(cmd, input) {
  const directory = await fs.mkdtemp(join(tmpdir(), "rozty-text-"));
  const file = join(directory, cmd === "ocr" ? "image.png" : "audio.wav");
  const result = join(directory, "transcript");
  try {
    if (cmd === "ocr") {
      await sharp(input, { limitInputPixels: 25000000 }).rotate().png().toFile(file);
      const { stdout } = await exec(process.env.TESSERACT_PATH || "tesseract", [
        file, "stdout", "-l", process.env.TESSERACT_LANG || "spa"
      ], { timeout: 45000, windowsHide: true, maxBuffer: 128 * 1024 });
      return stdout.trim();
    }
    const audio = await convertVideo(input, "wav", 180, ["-vn", "-ar 16000", "-ac 1", "-c:a pcm_s16le"]);
    await fs.writeFile(file, audio);
    await exec(process.env.WHISPER_PATH || "whisper-cli", [
      "-m", process.env.WHISPER_MODEL, "-f", file, "-l", "es", "-otxt", "-of", result
    ], { timeout: 180000, windowsHide: true, maxBuffer: 256 * 1024 });
    return (await fs.readFile(result + ".txt", "utf8")).trim();
  } finally {
    await Promise.all([file, result + ".txt"].map(path => fs.rm(path, { force: true })));
    await fs.rmdir(directory);
  }
}

async function handleMediaTool(sock, msg, cmd, args) {
  const chat = msg.key.remoteJid;
  const reply = payload => sock.sendMessage(chat, payload, { quoted: msg });
  const original = normalizeMessageContent(msg.message);
  const context = original?.extendedTextMessage?.contextInfo || original?.imageMessage?.contextInfo || original?.videoMessage?.contextInfo;
  const quoted = normalizeMessageContent(context?.quotedMessage);
  const type = ["aw", "toimg"].includes(cmd) ? "sticker" : ["meme", "ocr"].includes(cmd) ? "image" : cmd === "recortar" ? "video" :
    quoted?.audioMessage ? "audio" : "video";
  const media = original?.[type + "Message"] || quoted?.[type + "Message"];
  const text = args.join(" ").trim();
  if (cmd === "aw" && (!media || !text || [...text].length > 80)) {
    return reply({ text: "Respondé a un sticker con .aw David333. Máximo 80 caracteres." });
  }
  if (cmd !== "bratv" && !media) return reply({ text: `Respondé a un archivo compatible con .${cmd}.` });
  if (cmd === "transcribir" && !process.env.WHISPER_MODEL) {
    return reply({ text: "Todavía falta configurar el modelo local de Whisper en el bot." });
  }
  if (cmd === "bratv" && (!text || text.length > 160)) return reply({ text: "Usá .bratv texto (hasta 160 caracteres)." });
  if (cmd === "voz" && !VOICE_FILTERS.has(args[0])) return reply({ text: "Usá .voz robot, ardilla, grave, radio o eco." });
  const start = parseTime(args[0]);
  const end = parseTime(args[1]);
  if (cmd === "recortar" && !(start >= 0 && end > start && end - start <= 120)) {
    return reply({ text: "Usá .recortar 0:12 0:24. El fragmento puede durar hasta 2 minutos." });
  }
  if (cmd === "meme" && (!text || text.length > 140)) return reply({ text: "Usá .meme arriba | abajo (hasta 140 caracteres)." });

  return runStickerJob(sock, msg, async () => {
    if (cmd === "bratv") {
      const sticker = await createAnimatedBratSticker(text);
      return reply({ sticker, isAnimated: true });
    }
    const input = await downloadMediaBuffer(media, type);
    if (cmd === "aw") {
      const { format, width, height, pageHeight, pages } = await sharp(input, { animated: true }).metadata();
      if (format !== "webp") throw new Error("El sticker no usa formato WebP");
      return reply({ sticker: addStickerMetadata(input, text, width, pageHeight || height), isAnimated: pages > 1 });
    }
    if (cmd === "ocr" || cmd === "transcribir") {
      try {
        const result = await extractLocalText(cmd, input);
        return reply({ text: result.slice(0, 3500) || "No se detectó texto." });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await reply({ text: cmd === "ocr" ? "Falta instalar Tesseract en el bot." : "Falta instalar whisper-cli o configurar el modelo." });
        return false;
      }
    }
    if (cmd === "toimg") {
      return reply({ image: await sharp(input).png().toBuffer() });
    }
    if (cmd === "meme") {
      const [top, ...bottom] = text.split("|");
      const base = await sharp(input, { limitInputPixels: 25000000 }).rotate().resize(960, 960, { fit: "inside" }).png().toBuffer();
      const { width, height } = await sharp(base).metadata();
      const labels = [top, bottom.join("|")].map((line, i) => {
        const value = line.trim();
        const size = Math.max(10, Math.min(height * 0.12, width * 1.4 / Math.max(1, [...value].length)));
        return `<text x="${width / 2}" y="${i ? height - size * 0.45 : size * 1.2}" font-size="${size}" stroke-width="${size * 0.09}">${escapeXml(value)}</text>`;
      });
      const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g text-anchor="middle" fill="white" stroke="black" paint-order="stroke" font-family="sans-serif" font-weight="bold">${labels.join("")}</g></svg>`);
      return reply({ image: await sharp(base).composite([{ input: overlay }]).jpeg().toBuffer() });
    }
    if (cmd === "recortar") {
      const video = await convertVideo(input, "mp4", end - start, [
        "-ss " + start, "-c:v libx264", "-preset veryfast", "-c:a aac", "-movflags +faststart"
      ]);
      if (video.length > 24 * 1024 * 1024) throw new Error("Video demasiado grande");
      return reply({ video, mimetype: "video/mp4" });
    }
    const filters = cmd === "voz" ? ["-af aresample=48000," + VOICE_FILTERS.get(args[0])] : [];
    const audio = await convertVideo(input, "mp3", 180, ["-vn", "-c:a libmp3lame", "-b:a 128k", ...filters]);
    return reply({ audio, mimetype: "audio/mpeg" });
  }, actionFailedMsg);
}

module.exports = { MEDIA_TOOLS, handleMediaTool };
