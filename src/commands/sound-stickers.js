const { handleSocialDownload } = require("./play");
const { actionFailedMsg, badSyntaxMsg } = require("../utils/format");
const { runStickerJob, failStickerCommand } = require("../utils/sticker-jobs");
const { convertVideo, createSoundSticker, downloadMediaBuffer, sendSoundSticker, soundStickerDuration } = require("../utils/stickers");
const { recordStickerDiagnostic } = require("../utils/sticker-diagnostic");

const SOUND_STICKER_COMMANDS = new Set(["ss", "ss2", "ssr", "sspruebas"]);

function handleSoundSticker(sock, msg, cmd, args, sender, settings, video) {
  const chatId = msg.key.remoteJid;
  const raw = cmd === "ss" && args[0]?.toLowerCase() === "raw";
  const sourceArgs = raw ? args.slice(1) : args;
  const linked = sourceArgs.length > 0;
  if (linked && settings.disabledCommands?.tiktok === true) {
    return failStickerCommand(sock, msg, "Las descargas de TikTok están desactivadas en este grupo.");
  }
  if ((!video && !linked) || (raw && !linked)) {
    return failStickerCommand(sock, msg, badSyntaxMsg(`.${cmd} <enlace de TikTok> o .${cmd} respondiendo a un video con audio`));
  }
  const mode = linked ? (raw ? "raw" : "normalize") : "quoted";
  const extended = cmd === "ss2";
  const sendVariant = async (input, sourceInfo, budget) => {
    const media = await createSoundSticker(input, extended, mode, budget);
    if (cmd === "ssr") {
      media.audio = await convertVideo(media.audio, "mp3", media.seconds, [
        "-vn", "-c:a libmp3lame", "-ar 44100", "-ac 1", "-b:a 96k"
      ]);
      media.audioMimeType = "audio/mpeg";
    }
    const report = await sendSoundSticker(sock, chatId, media, msg);
    recordStickerDiagnostic(chatId, sender, {
      ...report, sourceInfo, actualSeconds: media.seconds,
      mode: { normalize: "TikTok normalizado (H.264/AAC)", raw: "TikTok sin normalizar", quoted: "video citado de WhatsApp" }[mode]
    });
    return { ...report, fps: media.fps };
  };
  const sendSticker = async (input, sourceInfo) => {
    if (cmd !== "sspruebas") return sendVariant(input, sourceInfo);
    const lines = [];
    let sent = 0;
    let lastError;
    for (const budget of [500000, 750000, 1000000]) {
      try {
        const result = await sendVariant(input, sourceInfo, budget);
        sent++;
        lines.push(`${sent}. Tope ${budget / 1000} KB · ${(result.stickerBytes / 1000).toFixed(1)} KB · ${result.fps.toFixed(1)} FPS`);
      } catch (error) {
        lastError = error;
        console.warn("[sspruebas]", budget, error.message);
        lines.push(`Tope ${budget / 1000} KB · no se pudo enviar`);
      }
    }
    if (!sent) throw lastError;
    await sock.sendMessage(chatId, {
      text: ["Comparación de stickers (en orden de envío)", ...lines].join("\n")
    }, { quoted: msg });
  };
  return runStickerJob(sock, msg, async () => {
    if (linked) return handleSocialDownload(sock, msg, sourceArgs, "tiktok", sender, sendSticker, soundStickerDuration(extended));
    return sendSticker(await downloadMediaBuffer(video, "video"));
  }, error => /^El (video|archivo)/u.test(error.message) ? error.message : actionFailedMsg());
}

module.exports = { SOUND_STICKER_COMMANDS, handleSoundSticker };
