const fs = require("node:fs/promises");
const path = require("path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const ffmpeg = require("fluent-ffmpeg");
const sharp = require("sharp");
const { downloadContentFromMessage, prepareWAMessageMedia, generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys");

const configuredDuration = Number(process.env.MAX_STICKER_SECONDS);
const MAX_STICKER_SECONDS = configuredDuration > 0 ? Math.min(10, configuredDuration) : 10;
const MAX_SOUND_STICKER_SECONDS = 10;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

function addStickerMetadata(webp, author, width = 512, height = 512, soundHash) {
  const metadata = Buffer.from(JSON.stringify({
    "sticker-pack-id": "rozty-bot",
    "sticker-pack-name": author ?? "Rozty Bot",
    "sticker-pack-publisher": author === undefined ? "@davhzzz" : "",
    ...(soundHash ? { "sound-sha256": soundHash } : {})
  }), "utf8");
  const headerSize = soundHash ? 26 : 22;
  const exif = Buffer.alloc(headerSize + metadata.length);
  if (soundHash) {
    exif.write("MM");
    exif.writeUInt16BE(42, 2);
    exif.writeUInt32BE(8, 4);
    exif.writeUInt16BE(1, 8);
    exif.writeUInt16BE(0x5741, 10);
    exif.writeUInt16BE(7, 12);
    exif.writeUInt32BE(metadata.length, 14);
    exif.writeUInt32BE(headerSize, 18);
  } else {
    Buffer.from("49492a00080000000100415707000000000016000000", "hex").copy(exif);
    exif.writeUInt32LE(metadata.length, 14);
  }
  metadata.copy(exif, headerSize);

  const exifChunk = Buffer.alloc(8 + exif.length + (exif.length % 2));
  exifChunk.write("EXIF");
  exifChunk.writeUInt32LE(exif.length, 4);
  exif.copy(exifChunk, 8);

  const hasExtendedHeader = webp.toString("ascii", 12, 16) === "VP8X";
  const header = Buffer.from(webp.subarray(0, hasExtendedHeader ? 30 : 12));
  const extended = hasExtendedHeader ? header.subarray(12) : Buffer.alloc(18);
  if (!hasExtendedHeader) {
    extended.write("VP8X");
    extended.writeUInt32LE(10, 4);
    // The static sticker encoders in this module produce 512×512 images.
    extended.writeUIntLE(width - 1, 12, 3);
    extended.writeUIntLE(height - 1, 15, 3);
  }
  extended[8] |= 0x08;

  const chunks = [header.subarray(0, 12), extended];
  for (let offset = hasExtendedHeader ? 30 : 12; offset < webp.length;) {
    if (offset + 8 > webp.length) throw new Error("WebP incompleto");
    const size = webp.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > webp.length) throw new Error("WebP incompleto");
    if (webp.toString("ascii", offset, offset + 4) !== "EXIF") chunks.push(webp.subarray(offset, end));
    offset = end;
  }
  chunks.push(exifChunk);
  header.writeUInt32LE(chunks.reduce((size, chunk) => size + chunk.length, -8), 4);
  return Buffer.concat(chunks);
}

async function downloadMediaBuffer(mediaMsg, mediaType) {
  if (Number(mediaMsg.fileLength) > MAX_MEDIA_BYTES) {
    throw new Error("El archivo supera el límite de 24 MB.");
  }
  const stream = await downloadContentFromMessage(mediaMsg, mediaType, {
    options: { signal: AbortSignal.timeout(20000) }
  });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_MEDIA_BYTES) throw new Error("El archivo supera el límite de 24 MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function convertVideo(inputBuffer, extension, maxDuration, options, inputOptions = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rozty-sticker-"));
  const input = path.join(dir, "input.mp4");
  const output = path.join(dir, `output.${extension}`);
  try {
    await fs.writeFile(input, inputBuffer);
    await new Promise((resolve, reject) => {
      ffmpeg(input, { timeout: 25 })
        .inputOptions(["-threads 2", ...inputOptions])
        .duration(maxDuration)
        .outputOptions(["-filter_threads 1", "-threads 2", ...options])
        .on("end", resolve)
        .on("error", reject)
        .save(output);
    });
    return await fs.readFile(output);
  } finally {
    await Promise.all([input, output].map(file => fs.rm(file, { force: true })));
    await fs.rmdir(dir);
  }
}

async function createWebpSticker(inputBuffer, isVideo = false, maxDuration = MAX_STICKER_SECONDS, withSound = false, testBudget) {
  if (!isVideo) {
    const webp = await sharp(inputBuffer, { limitInputPixels: 25000000 })
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality: 85 })
      .toBuffer();
    return addStickerMetadata(webp);
  }
  const profiles = testBudget
    ? [[512, 20, 46], [448, 20, 35], [352, 20, 24], [288, 15, 18], [224, 12, 14], [192, 5, 12]]
    : withSound
    ? [[512, 15, 46], [448, 12, 32], [352, 10, 22], [288, 8, 14], [192, 5, 12]]
    : [[512, 12, 65], [512, 10, 40], [288, 8, 24], [192, 5, 12]];
  for (const [size, fps, quality] of profiles) {
    // Reduce raster detail when needed, then restore its display size before padding.
    const scale = `scale=${size}:${size}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const restore = size === 512 ? "" : ",scale=512:512:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear";
    const webp = await convertVideo(inputBuffer, "webp", Math.min(withSound ? 20 : 10, maxDuration), [
      "-c:v libwebp",
      "-compression_level " + (withSound ? 4 : 2),
      `-vf fps=${fps},${scale}${restore},setsar=1,format=yuva420p,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      "-loop 0", "-an", "-q:v " + quality
    ]);
    const sticker = addStickerMetadata(webp);
    if (sticker.length <= (testBudget ? testBudget - 100 : withSound ? 499900 : 500000)) return sticker;
  }
  throw new Error("El video es demasiado complejo para crear un sticker de hasta " + (testBudget || 500000) / 1000 + " KB.");
}

function soundStickerDuration(extended = false) {
  const configured = Number(process.env.MAX_SOUND_STICKER_SECONDS);
  return extended ? 20 : configured > 0
    ? Math.min(MAX_SOUND_STICKER_SECONDS, configured)
    : MAX_SOUND_STICKER_SECONDS;
}

async function createSoundSticker(inputBuffer, extended = false, sourceMode = "quoted", testBudget) {
  const duration = soundStickerDuration(extended);
  if (sourceMode === "normalize") {
    inputBuffer = await convertVideo(inputBuffer, "mp4", duration, [
      "-map 0:v:0", "-map 0:a:0", "-vf scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      "-c:v libx264", "-pix_fmt yuv420p", "-preset veryfast", "-crf 20",
      "-af asetpts=N/SR/TB", "-c:a aac", "-ar 48000", "-b:a 160k", "-movflags +faststart"
    ]);
  }
  const sticker = await createWebpSticker(inputBuffer, true, duration, true, testBudget);
  const { delay, width, pageHeight } = await sharp(sticker, { animated: true }).metadata();
  if (!delay?.length || width !== 512 || pageHeight !== 512) {
    throw new Error("El video es demasiado corto o complejo para crear el sticker.");
  }
  const seconds = Math.min(duration, delay.reduce((total, ms) => total + ms, 0) / 1000);
  const timing = sourceMode === "raw" ? "asetpts=N/SR/TB,aresample=48000" : "aresample=48000:async=1:first_pts=0";
  const audio = await convertVideo(inputBuffer, "ogg", seconds, [
    "-map 0:a:0", "-vn", `-af ${timing},alimiter=limit=0.95:level=false:latency=true,apad`,
    "-c:a libopus", "-ar 48000", "-ac 1", "-application audio", "-vbr on", "-b:a 64k"
  ]).catch(error => {
    if (/matches no streams/i.test(error.message)) throw new Error("El video debe tener una pista de audio.");
    throw error;
  });
  const fps = delay.length * 1000 / delay.reduce((total, ms) => total + ms, 0);
  return { sticker, audio, seconds, fps };
}

const stickerAudio = new WeakMap();
const nativeStickerFields = new WeakSet();
const wrappedSoundStickers = new WeakMap();
let soundEnvelopePatched = false;

function wrapSoundSticker(message) {
  const messageContextInfo = { messageSecret: randomBytes(32) };
  if ("audioStickerMessage" in proto.Message.prototype) {
    return proto.Message.create({ audioStickerMessage: { message }, messageContextInfo });
  }
  if (!soundEnvelopePatched) {
    const encode = proto.Message.encode;
    proto.Message.encode = function (value, writer) {
      const inner = wrappedSoundStickers.get(value);
      if (!inner) return encode.call(this, value, writer);
      const envelope = proto.Message.FutureProofMessage.encode({ message: inner }).finish();
      // Keep the sticker shape for Baileys routing, but send only the sound wrapper on the wire.
      return encode.call(this, { messageContextInfo: value.messageContextInfo }, writer)
        .uint32((134 << 3) | 2).bytes(envelope);
    };
    soundEnvelopePatched = true;
  }
  const outer = proto.Message.create({ stickerMessage: message.stickerMessage, messageContextInfo });
  wrappedSoundStickers.set(outer, message);
  return outer;
}

async function sendSoundSticker(sock, chatId, media, quoted) {
  const upload = { upload: sock.waUploadToServer };
  const legacy = !media.audioMimeType && process.env.SOUND_STICKER_FORMAT === "legacy";
  const stickerBuffer = legacy ? media.sticker : addStickerMetadata(
    media.sticker, undefined, 512, 512, createHash("sha256").update(media.audio).digest("base64")
  );
  const [{ stickerMessage }, { audioMessage }] = await Promise.all([
    prepareWAMessageMedia({ sticker: stickerBuffer, isAnimated: true }, upload),
    prepareWAMessageMedia({
      audio: media.audio, mimetype: media.audioMimeType || "audio/ogg; codecs=opus",
      ptt: false, seconds: Math.ceil(media.seconds)
    }, upload)
  ]);
  const outgoing = generateWAMessageFromContent(chatId, { stickerMessage }, {
    quoted,
    userJid: sock.user.id
  });
  const sticker = outgoing.message.stickerMessage;
  sticker.isAnimated = true;
  sticker.width = 512;
  sticker.height = 512;
  if (!legacy) {
    if ("premium" in proto.Message.StickerMessage.prototype) sticker.premium = 0;
    if ("emojis" in proto.Message.StickerMessage.prototype) sticker.emojis = "🔊";
    nativeStickerFields.add(sticker);
  }
  if ("audioMessage" in proto.Message.StickerMessage.prototype) {
    sticker.audioMessage = audioMessage;
  } else {
    // Baileys 6 lacks field 26. Extend the encoder only for stickers created here.
    if (!stickerAudio.has(proto.Message.StickerMessage)) {
      const encode = proto.Message.StickerMessage.encode;
      proto.Message.StickerMessage.encode = function (message, writer) {
        const result = encode.call(this, message, writer);
        const audio = stickerAudio.get(message);
        if (nativeStickerFields.has(message)) {
          if (!("premium" in this.prototype)) result.uint32(24 << 3).uint32(0);
          if (!("emojis" in this.prototype)) result.uint32((25 << 3) | 2).string("🔊");
        }
        if (audio) result.uint32((26 << 3) | 2).bytes(proto.Message.AudioMessage.encode(audio).finish());
        return result;
      };
      stickerAudio.set(proto.Message.StickerMessage, true);
    }
    stickerAudio.set(sticker, audioMessage);
  }
  const message = legacy ? outgoing.message : wrapSoundSticker(outgoing.message);
  await sock.relayMessage(chatId, message, { messageId: outgoing.key.id });
  return {
    id: outgoing.key.id,
    stickerBytes: stickerBuffer.length,
    format: legacy ? "stickerMessage (26)" : "audioStickerMessage (134)",
    audio: audioMessage.mimetype,
    seconds: audioMessage.seconds,
    voice: audioMessage.ptt === true,
    hasDirectPath: Boolean(audioMessage.directPath),
    hasMediaKey: Boolean(audioMessage.mediaKey?.length),
    hasSidecar: Boolean(audioMessage.streamingSidecar?.length)
  };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapStickerText(text, maxChars, maxLines) {
  const lines = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    const chars = Array.from(word);
    if (line && Array.from(line).length + chars.length + 1 > maxChars) {
      lines.push(line);
      line = "";
    }
    while (chars.length > maxChars) lines.push(chars.splice(0, maxChars).join(""));
    line = line ? line + " " + chars.join("") : chars.join("");
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = Array.from(lines[maxLines - 1]).slice(0, maxChars - 1).join("") + "…";
  }
  return lines;
}

async function createBratSticker(text) {
  const label = await sharp({ text: {
    text: escapeXml(text.trim()), rgba: true, font: "Arial 80",
    width: 336, height: 268, align: "left", wrap: "word-char"
  } }).png().toBuffer();
  const layer = await sharp({
    create: { width: 384, height: 384, channels: 3, background: "#fff" }
  }).composite([{ input: label, left: 24, top: 58 }]).png().toBuffer();
  const lowResolution = await sharp(layer).resize(128, 128).png().toBuffer();
  return addStickerMetadata(await sharp(lowResolution).resize(512, 512, { kernel: "nearest" })
    .webp({ lossless: true }).toBuffer());
}

async function createAnimatedBratSticker(text) {
  const value = text.trim();
  const wordEnds = [0, ...Array.from(value.matchAll(/\S+/gu), word => word.index + word[0].length)];
  const frames = [];
  for (const end of wordEnds) {
    const shown = escapeXml(value.slice(0, end));
    const hidden = escapeXml(value.slice(end));
    const markup = `<span foreground="#000000">${shown}</span><span alpha="1">${hidden}</span>`;
    const label = await sharp({ text: {
      text: markup, rgba: true, font: Array.from(value).length <= 18 ? "Arial 82" : "Arial 28",
      width: 336, height: 288, align: "centre", wrap: "word-char"
    } }).png().toBuffer();
    const frame = await sharp({ create: { width: 384, height: 384, channels: 3, background: "#fff" } })
      .composite([{ input: label, gravity: "centre" }]).png().toBuffer();
    frames.push(frame);
  }
  const fps = Math.max(3, Math.ceil(frames.length / 8));
  const duration = frames.length / fps + 1.3;
  const webp = await convertVideo(Buffer.concat(frames), "webp", duration, [
    "-vf scale=512:512:flags=bicubic,tpad=stop_mode=clone:stop_duration=1.3",
    "-c:v libwebp_anim", "-compression_level 4", "-loop 0", "-lossless 1", "-an"
  ], ["-f image2pipe", "-framerate " + fps, "-c:v png"]);
  const sticker = addStickerMetadata(webp);
  if (sticker.length > 500000) throw new Error("Sticker animado demasiado grande");
  return sticker;
}

async function createQuoteSticker(authorName, text, avatar, photo) {
  const maxLines = photo ? 4 : 8;
  const lines = text.split(/\r?\n/u).flatMap(line => wrapStickerText(line, 24, maxLines)).slice(0, maxLines);
  const author = wrapStickerText(authorName, 18, 1)[0] || "Usuario";
  const measure = async (line, font) => (await sharp({ text: { text: escapeXml(line), font, rgba: true } }).metadata()).width;
  const [nameWidth, ...lineWidths] = await Promise.all([measure(author, "Arial Bold 40"),
    ...lines.map(line => measure(line, "Arial 40"))]);
  const longest = Math.max(1, ...lineWidths);
  const width = Math.max(192, Math.min(392, Math.ceil(Math.max(longest, nameWidth * 1.25)) + 44));
  const authorSize = Math.min(52, Math.floor((width - 44) * 40 / Math.max(1, nameWidth)));
  const photoHeight = photo ? 150 : 0;
  const maxLineHeight = Math.floor((488 - 60 - authorSize - photoHeight) / Math.max(1, lines.length));
  const fontSize = Math.min(photo ? 40 : 58, Math.floor((width - 44) * 40 / longest), Math.floor(maxLineHeight / 1.24));
  const lineHeight = Math.ceil(fontSize * 1.24);
  const height = 60 + authorSize + lineHeight * lines.length + photoHeight;
  const avatarSize = Math.max(64, Math.min(108, Math.round(height * 0.69)));
  const left = Math.round((512 - width - avatarSize - 12) / 2) + avatarSize + 12;
  const top = Math.round((512 - height) / 2);
  const labels = lines.map((line, i) =>
    `<text x="${left + 22}" y="${top + 34 + authorSize + fontSize + i * lineHeight}">${escapeXml(line)}</text>`
  ).join("");
  const avatarX = left - avatarSize - 12;
  const avatarY = top + Math.round((height - avatarSize) / 2);
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(${avatarX} ${avatarY}) scale(${avatarSize / 108})">
      <circle cx="54" cy="54" r="54" fill="#dedfe1"/>
      <circle cx="54" cy="41" r="18" fill="#fff"/>
      <path d="M23 85a31 26 0 0 1 62 0z" fill="#fff"/>
    </g>
    <rect x="${left}" y="${top}" width="${width}" height="${height}" rx="38" fill="#000"/>
    <text x="${left + 22}" y="${top + 18 + authorSize}" font-family="Arial, sans-serif" font-size="${authorSize}" font-weight="bold" fill="#ffa856">${escapeXml(author)}</text>
    <g font-family="Arial, sans-serif" font-size="${fontSize}" fill="#fff">${labels}</g>
  </svg>`;
  const sticker = sharp(Buffer.from(svg));
  const layers = [];
  if (avatar?.length) {
    try {
      const mask = Buffer.from(`<svg width="${avatarSize}" height="${avatarSize}" viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg"><circle cx="54" cy="54" r="54" fill="white"/></svg>`);
      const picture = await sharp(avatar, { limitInputPixels: 16000000 }).rotate().resize(avatarSize, avatarSize).ensureAlpha().png().toBuffer();
      const circle = await sharp(picture).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
      layers.push({ input: circle, left: avatarX, top: avatarY });
    } catch {
      // Keep the placeholder if WhatsApp's profile picture cannot be decoded.
    }
  }
  if (photo) {
    const image = await sharp(photo, { limitInputPixels: 25000000 }).rotate()
      .resize(width - 44, photoHeight - 12, { fit: "contain", background: "#000" }).png().toBuffer();
    layers.push({ input: image, left: left + 22, top: top + height - photoHeight - 6 });
  }
  if (layers.length) sticker.composite(layers);
  return addStickerMetadata(await sticker.webp({ quality: 85 }).toBuffer());
}

module.exports = {
  convertVideo,
  escapeXml,
  addStickerMetadata,
  downloadMediaBuffer,
  createWebpSticker,
  createSoundSticker,
  soundStickerDuration,
  sendSoundSticker,
  createBratSticker,
  createAnimatedBratSticker,
  createQuoteSticker
};
