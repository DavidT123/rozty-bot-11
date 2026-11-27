const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { SIGNATURE, badSyntaxMsg, actionFailedMsg } = require("../utils/format");
const { withProgress, downloadStatus } = require("../utils/progress");

const exec = promisify(execFile);
const sessions = new Map();
const searchResults = new Map();
const SESSION_MS = 120000;
const MAX_BYTES = 24 * 1024 * 1024;
let searches = 0;
let downloads = 0;
const sourceErrors = new Map();
const waitingDownloads = [];
const downloadsPerUser = new Map();
const SOCIAL_HOSTS = {
  tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  instagram: ["instagram.com", "www.instagram.com", "m.instagram.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"],
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]
};

async function runExtractor(args, timeout) {
  const options = { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 };
  const flags = ["--ignore-config", "--no-playlist", "--socket-timeout", "10",
    "--retries", "1", "--js-runtimes", "node", ...args];
  try {
    return await exec(process.env.YT_DLP_PATH || "yt-dlp", flags, options);
  } catch (error) {
    if (error.code !== "ENOENT" || process.env.YT_DLP_PATH || process.platform !== "win32") throw error;
    return exec("python", ["-m", "yt_dlp", ...flags], options);
  }
}

function youtubeInput(query) {
  if (!/^(?:https?:\/\/|www\.|(?:(?:m|music)\.)?youtube\.com\/|youtu\.be\/)/i.test(query)) {
    return "ytsearch1:" + query;
  }
  const url = /^https?:\/\//i.test(query) ? query : "https://" + query;
  let link;
  try {
    link = new URL(url);
  } catch {
    return null;
  }
  const host = link.hostname.toLowerCase();
  let id;
  if (host === "youtu.be") id = link.pathname.split("/")[1];
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    id = link.pathname === "/watch" ? link.searchParams.get("v")
      : /^\/(?:shorts|live|embed)\/([\w-]+)/u.exec(link.pathname)?.[1];
  }
  return /^[\w-]{11}$/u.test(id || "") ? "https://www.youtube.com/watch?v=" + id : null;
}

function reply(sock, msg, text) {
  return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function fail(sock, msg, text) {
  await reply(sock, msg, text);
  return false;
}

function reportError(sock, msg, error, respond = true) {
  const missing = error.code === "ENOENT" || /No module named yt_dlp/i.test(error.stderr || "");
  const detail = error.stderr?.trim().split(/\r?\n/u).pop();
  console.error("[Play]", detail || error.code || error.message);
  if (!respond) return false;
  if (/failed to resolve|getaddrinfo|ENOTFOUND|EAI_AGAIN/iu.test(error.stderr || "") ||
      ["ENOTFOUND", "EAI_AGAIN"].includes(error.cause?.code || error.code)) {
    return fail(sock, msg, "❌ La conexión del bot no pudo resolver el dominio del video o de la fuente de descarga.");
  }
  return fail(sock, msg, missing
    ? "❌ Falta instalar yt-dlp en el equipo donde corre el bot."
    : actionFailedMsg());
}

function tiktokLink(value) {
  let link;
  try { link = new URL(value); } catch { return null; }
  if (link.protocol !== "https:" || link.username || link.password || link.port ||
      !SOCIAL_HOSTS.tiktok.includes(link.hostname)) return null;
  const short = ["vm.tiktok.com", "vt.tiktok.com"].includes(link.hostname);
  if (!(short ? /^\/[\w-]+\/?$/u : /^\/(?:@[^/]+\/video\/\d+|t\/[\w-]+)\/?$/u).test(link.pathname)) return null;
  link.search = "";
  link.hash = "";
  return link.href;
}

async function downloadTikwm(url, output, audioSeconds) {
  const signal = AbortSignal.timeout(20000);
  const api = new URL("https://www.tikwm.com/api/");
  api.searchParams.set("url", url);
  const response = await fetchTikwm(api, signal);
  if (!response.ok) throw new Error("TikWM HTTP " + response.status);
  const { data } = await response.json();
  if ((!data?.play && !data?.hdplay) || !(Number(data.duration) > 0 && Number(data.duration) <= 600)) {
    throw new Error("TikWM no devolvió un video válido");
  }
  let lastError;
  for (const candidate of new Set([data.play, data.hdplay].filter(value => typeof value === "string" && value.trim()))) {
    try {
      const mediaUrl = new URL(candidate.trim(), api.origin);
      if (mediaUrl.protocol === "http:") mediaUrl.protocol = "https:";
      const media = await fetchTikwm(mediaUrl, signal, true);
      await saveTikTokVideo(media, output, signal);
      return await validateTikTokVideo(output, audioSeconds);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("TikWM no devolvió un enlace utilizable");
}

async function downloadTikMate(url, output, audioSeconds) {
  const signal = AbortSignal.timeout(18000);
  const response = await fetch("https://api.tikmate.app/api/lookup", {
    method: "POST",
    body: new URLSearchParams({ url }),
    redirect: "error",
    signal
  });
  if (!response.ok) throw new Error("TikMate HTTP " + response.status);
  const { success, token, id } = await response.json();
  if (!success || typeof token !== "string" || !/^[\w-]{1,512}$/u.test(token) ||
      !/^\d{1,25}$/u.test(String(id))) {
    throw new Error("TikMate no devolvió un video");
  }
  const media = await fetch(`https://tikmate.app/download/${token}/${id}.mp4`, {
    redirect: "error",
    signal
  });
  await saveTikTokVideo(media, output, signal);
  return validateTikTokVideo(output, audioSeconds);
}

async function validateTikTokVideo(output, audioSeconds) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,channels,sample_rate,start_time",
    "-of", "json", output
  ], { timeout: 5000, windowsHide: true });
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration);
  if (!info.streams?.some(stream => stream.codec_type === "video") || !(duration > 0 && duration <= 600)) {
    throw new Error("La fuente no devolvió un video de hasta 10 minutos");
  }
  if (audioSeconds) {
    if (!info.streams.some(stream => stream.codec_type === "audio")) {
      throw new Error("El video de TikTok llegó sin pista de audio.");
    }
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", output, "-map", "0:a:0",
      "-af", "asetpts=N/SR/TB,aformat=channel_layouts=mono,volumedetect",
      "-t", String(audioSeconds), "-f", "null", "-"
    ], { timeout: 15000, windowsHide: true });
    const peak = /max_volume:\s*(-?[\d.]+) dB/u.exec(stderr);
    if (!peak || Number(peak[1]) <= -90) throw new Error("El video de TikTok no tiene sonido audible en el fragmento del sticker.");
  }
  const video = info.streams.find(stream => stream.codec_type === "video");
  const audio = info.streams.find(stream => stream.codec_type === "audio");
  return { videoCodec: video.codec_name, audioCodec: audio?.codec_name, channels: audio?.channels,
    sampleRate: audio?.sample_rate, audioStart: audio?.start_time, videoStart: video.start_time, duration };
}

async function saveTikTokVideo(media, output, signal) {
  if (!media.ok || !media.body || Number(media.headers.get("content-length")) > MAX_BYTES ||
      !/^(video\/mp4|application\/octet-stream)\b/i.test(media.headers.get("content-type") || "")) {
    await media.body?.cancel();
    throw new Error("La fuente no devolvió un MP4 válido de hasta 24 MB");
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return callback(new Error("El video supera los 24 MB"));
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(media.body), limit, createWriteStream(output), { signal });
}

async function fetchTikwm(url, signal, media = false) {
  const allowedDomains = media
    ? ["tikwm.com", "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "muscdn.com"]
    : ["tikwm.com"];
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !allowedDomains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) {
      throw new Error("TikWM devolvió un dominio no admitido: " + url.hostname);
    }
    const response = await fetch(url, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error("Demasiadas redirecciones de TikWM");
}

function downloadQueueCommand(sock, msg, sender, cancel) {
  const index = waitingDownloads.findIndex(job => job.chatId === msg.key.remoteJid && job.sender === sender);
  if (cancel && index >= 0) {
    waitingDownloads.splice(index, 1)[0].resolve(false);
    return reply(sock, msg, "Cancelaste tu descarga pendiente.");
  }
  if (cancel) return reply(sock, msg, "No tenés una descarga pendiente para cancelar.");
  return reply(sock, msg, `Descargas activas: ${downloads}. En espera: ${waitingDownloads.length}.` +
    (index >= 0 ? ` Tu descarga está en el puesto ${index + 1}.` : ""));
}

async function prepareInstagramVideo(input, directory) {
  const options = { timeout: 8000, windowsHide: true };
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-show_entries", "stream=index,codec_type,codec_name,pix_fmt",
    "-of", "json", input
  ], options);
  const { streams = [] } = JSON.parse(stdout);
  const video = streams.find(stream => stream.codec_type === "video");
  if (!video) throw new Error("El archivo de Instagram no contiene video");
  const tracks = streams.filter(stream => stream.codec_type === "audio");
  let audio;
  for (const track of tracks) {
    const analysis = await exec("ffmpeg", [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", input,
      "-map", "0:" + track.index, "-af", "volumedetect", "-f", "null", "-"
    ], { ...options, timeout: 30000 });
    const peak = /max_volume:\s*(-?[\d.]+) dB/u.exec(analysis.stderr);
    if (peak && Number(peak[1]) > -90) {
      audio = track;
      break;
    }
  }
  if (!audio) return { error: "❌ Instagram no entregó una pista de audio audible para este video." };
  const compatibleVideo = video.codec_name === "h264" && video.pix_fmt === "yuv420p";
  if (compatibleVideo && audio.codec_name === "aac" && tracks.length === 1) return { file: input };
  const output = join(directory, "compatible.mp4");
  await exec("ffmpeg", [
    "-v", "error", "-nostdin", "-y", "-i", input, "-map", "0:v:0", "-map", "0:" + audio.index,
    ...(compatibleVideo ? ["-c:v", "copy"] :
      ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p"]),
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output
  ], { ...options, timeout: 90000 });
  return { file: output };
}

async function sendMedia(sock, msg, video, mode, source = "youtube", sender, sendDownloaded, audioSeconds = 10) {
  const instagramSource = source === "instagram";
  const maxSeconds = 600;
  if (video.is_live || (!instagramSource && video.duration > maxSeconds)) {
    return fail(sock, msg, instagramSource
      ? "❌ Elegí un video grabado de Instagram."
      : "❌ Elegí un video grabado de hasta 10 minutos.");
  }
  if (downloads >= 3 && waitingDownloads.length >= 12) {
    return fail(sock, msg, "⏳ La cola de descargas está llena. Probá en un momento.");
  }
  const user = sender || msg.key.participant || msg.key.remoteJid;
  const jobs = downloadsPerUser.get(user) || 0;
  if (jobs >= 2) return fail(sock, msg, "Ya tenés dos descargas activas o pendientes.");
  downloadsPerUser.set(user, jobs + 1);
  const releaseUser = () => {
    const remaining = downloadsPerUser.get(user) - 1;
    if (remaining) downloadsPerUser.set(user, remaining);
    else downloadsPerUser.delete(user);
  };
  const audio = mode === "1";
  const progress = audio ? downloadStatus(sock, msg) : null;
  if (downloads >= 3) {
    const admitted = await new Promise(resolve => waitingDownloads.push({ chatId: msg.key.remoteJid, sender, resolve }));
    if (!admitted) {
      releaseUser();
      await progress?.finish(false, "Descarga cancelada.");
      return false;
    }
  } else {
    downloads++;
  }
  let directory;
  let sent = false;
  try {
    progress?.stage("Descargando el archivo…", 3);
    directory = await fs.mkdtemp(join(tmpdir(), "rozty-play-"));
    let output = join(directory, audio ? "media.mp3" : "media.mp4");
    const format = audio
      ? ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "128K"]
      : source === "tiktok"
        ? ["-f", "best[ext=mp4][format_id!*=download][format_note!?*=watermarked][format_note!?*=UNPLAYABLE]"]
        : source === "instagram"
          ? ["-f", "b[ext=mp4][acodec^=mp4a]/b[ext=mp4][acodec=aac]/bv[ext=mp4]+ba[ext=m4a]/b/bv+ba/bv", "--merge-output-format", "mp4", "--remux-video", "mp4"]
        : source !== "youtube"
          ? ["-f", "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]", "--merge-output-format", "mp4"]
          : ["-f", "bestvideo[height<=480][vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[height<=480][vcodec^=avc1][ext=mp4]", "--merge-output-format", "mp4"];
    let sourceInfo;
    try {
      await runExtractor(["--no-progress", "--max-filesize", "24M", "--match-filter",
      instagramSource ? "!is_live" : "!is_live & duration <= " + maxSeconds, "-o", join(directory, "media.%(ext)s"),
        ...format, "--", source === "youtube" ? "https://www.youtube.com/watch?v=" + video.id : video.url], source === "tiktok" ? 25000 : 90000);
      if (source === "tiktok") {
        if (sendDownloaded) sourceInfo = { ...(await validateTikTokVideo(output, audioSeconds)), provider: "yt-dlp" };
        else await fs.access(output);
      }
    } catch (error) {
      if (source !== "tiktok") throw error;
      progress?.stage("Probando otra fuente…", 5);
      console.warn("[TikTok yt-dlp]", error.stderr?.trim().split(/\r?\n/u).at(-1) || error.code || error.message.split("\n")[0]);
      try {
        sourceInfo = { ...(await downloadTikwm(video.url, output, sendDownloaded ? audioSeconds : 0)), provider: "TikWM" };
      } catch (backupError) {
        console.warn("[TikTok TikWM]", backupError.cause?.code || backupError.message);
        progress?.stage("Probando con TikMate…", 6);
        sourceInfo = { ...(await downloadTikMate(video.url, output, sendDownloaded ? audioSeconds : 0)), provider: "TikMate" };
      }
    }
    if (source === "instagram") {
      try {
        await fs.access(output);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return await fail(sock, msg, "❌ Instagram no entregó un archivo de video de hasta 24 MB.");
      }
      let instagram = await prepareInstagramVideo(output, directory);
      if (instagram.error) {
        try {
          await runExtractor([
            "--no-progress", "--max-filesize", "24M", "--match-filter", "!is_live",
            "-o", join(directory, "alternate.%(ext)s"), "-f", "bv[ext=mp4]+ba[ext=m4a]/bv+ba/b.2",
            "--merge-output-format", "mp4", "--remux-video", "mp4", "--", video.url
          ], 90000);
          instagram = await prepareInstagramVideo(join(directory, "alternate.mp4"), directory);
        } catch (error) {
          console.warn("[Instagram audio alternativo]", error.code || error.message.split("\n")[0]);
        }
      }
      if (instagram.error) return await fail(sock, msg, instagram.error);
      output = instagram.file;
    }
    const file = await fs.stat(output).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file || !file.size) throw new Error("No se generó un archivo de salida");
    if (file.size > MAX_BYTES) throw new Error("El archivo supera los 24 MB");
    const chatId = msg.key.remoteJid;
    const media = { url: output };
    progress?.stage("Enviando a WhatsApp…", 8);
    if (sendDownloaded) {
      await sendDownloaded(await fs.readFile(output), sourceInfo);
    } else {
      await sock.sendMessage(chatId, audio
        ? { audio: media, mimetype: "audio/mpeg" }
        : { video: media, mimetype: "video/mp4" }, { quoted: msg });
    }
    sent = true;
  } catch (error) {
    sourceErrors.set(source, new Date().toISOString());
    if (sendDownloaded) throw error;
    reportError(sock, msg, error, false);
    return progress ? false : await fail(sock, msg, actionFailedMsg());
  } finally {
    progress?.finish(sent);
    if (directory) {
      try {
        const files = await fs.readdir(directory);
        await Promise.all(files.map(file => fs.rm(join(directory, file), { force: true })));
        await fs.rmdir(directory);
      } catch (error) {
        console.warn("[Play cleanup]", error.message);
      }
    }
    releaseUser();
    const next = waitingDownloads.shift();
    if (next) next.resolve(true);
    else downloads--;
  }
}

async function handleSocialDownload(sock, msg, args, source, sender, sendDownloaded, audioSeconds) {
  if (source === "tiktok") {
    const url = tiktokLink(args[0]);
    if (!url) return fail(sock, msg, "❌ Enviá un enlace público con .tk <enlace>.");
    return sendMedia(sock, msg, { url }, "2", source, sender, sendDownloaded, audioSeconds);
  }
  let link;
  try {
    link = new URL(args[0]);
  } catch {
    return fail(sock, msg, badSyntaxMsg("." + source + " https://..."));
  }
  if (link.protocol !== "https:" || link.username || link.password || link.port ||
      !SOCIAL_HOSTS[source]?.includes(link.hostname) ||
      (source === "x" && !/^\/[\w]+\/status\/\d+\/?$/u.test(link.pathname)) ||
      (source === "facebook" && !(link.hostname === "fb.watch" ? /^\/[\w-]+\/?$/u :
        /^\/(?:watch\/?|reel\/\d+\/?|share\/[vr]\/[\w-]+\/?|[^/]+\/videos\/\d+\/?)$/u).test(link.pathname)) ||
      (source === "instagram" && !/^\/(?:p|reels?|tv)\/[\w-]+\/?$/u.test(link.pathname))) {
    return fail(sock, msg, "❌ Enviá el enlace público de un video de " + source + ".");
  }
  const facebookId = source === "facebook" && link.searchParams.get("v");
  link.search = "";
  if (facebookId && /^\d+$/u.test(facebookId)) link.searchParams.set("v", facebookId);
  link.hash = "";
  if (searches >= 8) return fail(sock, msg, "⏳ Hay varias búsquedas en curso. Probá en un momento.");
  let video;
  searches++;
  try {
    const { stdout } = await runExtractor(["--dump-single-json", "--", link.href], 25000);
    const info = JSON.parse(stdout);
    if (info.entries) return fail(sock, msg, "❌ Enviá un enlace a un solo video.");
    video = info;
  } catch (error) {
    return reportError(sock, msg, error);
  } finally {
    searches--;
  }
  return sendMedia(sock, msg, { title: video.title, duration: video.duration, is_live: video.is_live, url: link.href }, "2", source, sender);
}

async function handleYouTubeSearch(sock, msg, query, sender) {
  if (!query || query.length > 300) return fail(sock, msg, badSyntaxMsg(".ytsearch nombre"));
  const key = msg.key.remoteJid + ":" + sender;
  const now = Date.now();
  for (const [id, result] of searchResults) if (result.expires <= now) searchResults.delete(id);
  if (/^[1-5]$/u.test(query)) {
    const selected = searchResults.get(key)?.entries[Number(query) - 1];
    if (!selected) return fail(sock, msg, "Esa opción no está disponible. Hacé otra búsqueda con .ytsearch.");
    return handlePlayCommand(sock, msg, ["https://www.youtube.com/watch?v=" + selected.id], sender);
  }
  if (searches >= 8) return fail(sock, msg, "⏳ Hay varias búsquedas en curso. Probá en un momento.");
  searches++;
  try {
    const { stdout } = await runExtractor(["--flat-playlist", "--dump-single-json", "--", "ytsearch5:" + query], 25000);
    const entries = JSON.parse(stdout).entries?.filter(video => /^[\w-]{11}$/u.test(video?.id || "")) || [];
    if (!entries.length) return fail(sock, msg, "❌ No encontré resultados para esa búsqueda.");
    if (searchResults.size >= 256) searchResults.delete(searchResults.keys().next().value);
    searchResults.set(key, { entries, expires: Date.now() + SESSION_MS });
    return reply(sock, msg, entries.map((video, i) => `${i + 1}. ${video.title}`).join("\n") +
      "\n\nElegí con .ytsearch número.");
  } catch (error) {
    return reportError(sock, msg, error);
  } finally {
    searches--;
  }
}

async function handlePlayCommand(sock, msg, args, sender) {
  const mode = args.length > 1 && /^[12]$/u.test(args[0]) ? args[0] : null;
  const query = (mode ? args.slice(1) : args).join(" ").trim();
  if (!query || query.length > 300) return fail(sock, msg, badSyntaxMsg(".play nombre o enlace de YouTube"));
  const input = youtubeInput(query);
  if (!input) return fail(sock, msg, "❌ Enviá un enlace de un video de YouTube.");
  if (searches >= 8) return fail(sock, msg, "⏳ Hay varias búsquedas en curso. Probá en un momento.");

  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now >= session.expiresAt) sessions.delete(key);
  }
  const key = msg.key.remoteJid + ":" + sender;
  if (sessions.size >= 256 && !sessions.has(key)) return fail(sock, msg, "⏳ Hay demasiadas selecciones pendientes.");
  const session = { expiresAt: now + SESSION_MS };
  sessions.set(key, session);
  let video;
  searches++;
  try {
    const { stdout } = await runExtractor(["--flat-playlist", "--dump-single-json", "--", input], 25000);
    const result = JSON.parse(stdout);
    video = result.entries?.[0] || result;
  } catch (error) {
    if (sessions.get(key) === session) sessions.delete(key);
    return reportError(sock, msg, error);
  } finally {
    searches--;
  }
  if (sessions.get(key) !== session) return;
  if (!/^[\w-]{11}$/u.test(video.id || "")) {
    sessions.delete(key);
    return fail(sock, msg, "❌ No encontré resultados para esa búsqueda.");
  }
  if (mode) {
    sessions.delete(key);
    return sendMedia(sock, msg, video, mode, "youtube", sender);
  }

  const seconds = Math.floor(video.duration || 0);
  const duration = seconds ? Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") : "Sin datos";
  const views = Number.isFinite(video.view_count) ? video.view_count.toLocaleString("es-CR") : "Sin datos";
  try {
    const sent = await reply(sock, msg, `🎶 *${video.title}*
⏱️ Duración: ${duration}
👁️ Vistas: ${views}

Respondé con un número:
1 › Audio 🎵
2 › Video 🎬

${SIGNATURE}`);
    Object.assign(session, { video, promptId: sent.key.id, expiresAt: Date.now() + SESSION_MS });
  } catch (error) {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  }
}

async function handlePlayChoiceReply(sock, msg, text, sender) {
  if (!/^[12]$/u.test(text)) return;
  const key = msg.key.remoteJid + ":" + sender;
  const session = sessions.get(key);
  if (!session?.video) return;
  if (Date.now() >= session.expiresAt) {
    sessions.delete(key);
    return;
  }
  const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  if (quotedId && quotedId !== session.promptId) return;
  sessions.delete(key);
  return withProgress(sock, msg, () => sendMedia(sock, msg, session.video, text, "youtube", sender));
}

async function downloadHealth(sock, msg) {
  const options = { timeout: 5000, windowsHide: true };
  const results = await Promise.allSettled([
    runExtractor(["--version"], 5000), exec("ffmpeg", ["-version"], options), exec("ffprobe", ["-version"], options)
  ]);
  const tools = ["yt-dlp", "FFmpeg", "ffprobe"].map((name, i) =>
    name + ": " + (results[i].status === "fulfilled" ? "disponible" : "no disponible"));
  const errors = [...sourceErrors].map(([source, date]) => source + ": " + date);
  return reply(sock, msg, ["Estado de descargas", ...tools, `Activas: ${downloads} | En espera: ${waitingDownloads.length}`,
    "Últimos fallos por plataforma: " + (errors.join(", ") || "ninguno desde que arrancó el bot")].join("\n"));
}

module.exports = { handlePlayCommand, handlePlayChoiceReply, handleSocialDownload, handleYouTubeSearch, downloadQueueCommand, downloadHealth, tiktokLink };
