const { availableParallelism } = require("node:os");

const defaultWorkers = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3)));
const configuredWorkers = Number(process.env.STICKER_WORKERS);
const MAX_ACTIVE_JOBS = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? Math.min(8, configuredWorkers)
  : defaultWorkers;
const MAX_TOTAL_JOBS = Math.max(12, MAX_ACTIVE_JOBS * 4);
const MAX_JOBS_PER_CHAT = Math.max(2, Math.ceil(MAX_ACTIVE_JOBS / 2) + 1);
const pending = [];
const jobsPerChat = new Map();
const jobsPerUser = new Map();
let active = 0;

function drain() {
  while (active < MAX_ACTIVE_JOBS && pending.length) {
    const { chatId, user, task, resolve, reject } = pending.shift();
    active++;
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active--;
      const remaining = jobsPerChat.get(chatId) - 1;
      if (remaining) jobsPerChat.set(chatId, remaining);
      else jobsPerChat.delete(chatId);
      const userRemaining = jobsPerUser.get(user) - 1;
      if (userRemaining) jobsPerUser.set(user, userRemaining);
      else jobsPerUser.delete(user);
      drain();
    });
  }
}

function reactToStickerCommand(sock, msg, text) {
  return sock.sendMessage(msg.key.remoteJid, { react: { key: msg.key, text } })
    .catch(error => console.warn("[Sticker reaction]", error.message));
}

async function failStickerCommand(sock, msg, text) {
  await reactToStickerCommand(sock, msg, "❌");
  return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function runStickerJob(sock, msg, task, errorMessage) {
  const chatId = msg.key.remoteJid;
  const chatJobs = jobsPerChat.get(chatId) || 0;
  const user = msg.key.fromMe ? sock.user?.id || chatId : msg.key.participant || msg.participant || chatId;
  const userJobs = jobsPerUser.get(user) || 0;
  if (userJobs >= 2) return failStickerCommand(sock, msg, "Ya tenés dos trabajos de medios pendientes.");
  if (active + pending.length >= MAX_TOTAL_JOBS || chatJobs >= MAX_JOBS_PER_CHAT) {
    return failStickerCommand(sock, msg, "Hay varias solicitudes de stickers en proceso. Intentá de nuevo en un momento.");
  }

  jobsPerChat.set(chatId, chatJobs + 1);
  jobsPerUser.set(user, userJobs + 1);
  const loading = reactToStickerCommand(sock, msg, "⏳");
  try {
    const result = await new Promise((resolve, reject) => {
      pending.push({ chatId, user, task, resolve, reject });
      drain();
    });
    if (result === false) {
      await loading;
      await reactToStickerCommand(sock, msg, "❌");
      return false;
    }
  } catch (error) {
    console.error("[Sticker]", error.message);
    await loading;
    return failStickerCommand(sock, msg, errorMessage(error));
  }
  await loading;
  await reactToStickerCommand(sock, msg, "✅");
}

module.exports = { runStickerJob, failStickerCommand };
