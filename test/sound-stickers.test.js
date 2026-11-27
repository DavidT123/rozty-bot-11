const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { Writer } = require("protobufjs/minimal");
const { proto } = require("@whiskeysockets/baileys");
const { createSoundSticker } = require("../src/utils/stickers");
const { installStickerDiagnostic, readStickerDiagnostic, findStickerDiagnostic, recordStickerDiagnostic } =
  require("../src/utils/sticker-diagnostic");

test("un sticker recibido se puede consultar después, citando su mensaje", () => {
  installStickerDiagnostic();
  const nested = (field, payload) => Writer.create().uint32((field << 3) | 2).bytes(payload).finish();
  const audio = proto.Message.AudioMessage.encode({
    mimetype: "audio/ogg; codecs=opus", seconds: 4, streamingSidecar: Buffer.from([1]),
    mediaKey: Buffer.alloc(32), directPath: "/fixture"
  }).finish();
  const wire = nested(134, nested(1, nested(26, nested(26, audio))));
  const chat = "100@s.whatsapp.net";
  readStickerDiagnostic({ key: { remoteJid: chat, id: "sample" }, message: proto.Message.decode(wire) });
  const quoted = { key: { remoteJid: chat }, message: { extendedTextMessage: { contextInfo: { stanzaId: "sample" } } } };
  assert.equal(findStickerDiagnostic(quoted).audio, "audio/ogg; codecs=opus");
  assert.equal(findStickerDiagnostic(quoted).hasSidecar, true);
  const other = { ...quoted, key: { remoteJid: "200@s.whatsapp.net" } };
  assert.equal(findStickerDiagnostic(other), undefined);
  recordStickerDiagnostic(chat, chat, { id: "sent", mode: "TikTok normalizado" });
  assert.equal(findStickerDiagnostic(quoted, chat, true).mode, "TikTok normalizado");
});

test("TikTok normalizado produce audio audible aun con una pista desplazada", async () => {
  const input = execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=96x128:r=15",
    "-itsoffset", "0.7", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-f", "matroska", "pipe:1"
  ]);
  const result = await createSoundSticker(input, false, "normalize");
  assert.ok(result.seconds > 1 && result.seconds <= 2.1);
  assert.ok(result.sticker.length < 500000);
  const pcm = execFileSync("ffmpeg", [
    "-v", "error", "-i", "pipe:0", "-t", "0.3", "-f", "s16le", "pipe:1"
  ], { input: result.audio });
  assert.ok(pcm.some(byte => byte !== 0));
});
