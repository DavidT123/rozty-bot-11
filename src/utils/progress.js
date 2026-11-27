const { actionFailedMsg } = require("./format");

async function react(sock, msg, text) {
  try {
    await sock.sendMessage(msg.key.remoteJid, { react: { key: msg.key, text } });
  } catch (error) {
    console.warn("[Reacción]", error.message);
  }
}

async function withProgress(sock, msg, task, delayMs = 0) {
  let loading;
  const start = () => { loading = react(sock, msg, "⏳"); };
  const timer = delayMs ? setTimeout(start, delayMs) : null;
  if (!timer) start();
  let succeeded = false;
  try {
    const result = await task();
    succeeded = result !== false;
    return result;
  } finally {
    clearTimeout(timer);
    if (loading) {
      await loading;
      await react(sock, msg, succeeded ? "✅" : "❌");
    }
  }
}

function downloadStatus(sock, msg) {
  const chatId = msg.key.remoteJid;
  let key;
  let pending = Promise.resolve();
  const update = (text, remove = false) => {
    pending = pending.then(async () => {
      if (remove) {
        if (key) await sock.sendMessage(chatId, { delete: key });
        return;
      }
      if (key) {
        await sock.sendMessage(chatId, { text, edit: key });
      } else {
        const sent = await sock.sendMessage(chatId, { text }, { quoted: msg });
        key = sent?.key;
      }
    }).catch(error => console.warn("[Progreso]", error.message));
  };
  const format = (text, filled) => `Ya voy\n${"█".repeat(filled)}${"░".repeat(10 - filled)}\n${text}`;
  update(format("Preparando la descarga…", 0));
  return {
    stage(text, filled) {
      update(format(text, filled));
    },
    finish(success, message) {
      update(message || actionFailedMsg(), success);
      return pending;
    }
  };
}

module.exports = { withProgress, downloadStatus };
