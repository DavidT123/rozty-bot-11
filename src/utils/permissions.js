require("dotenv").config();

const pendingMetadata = new WeakMap();

function getGroupMetadata(sock, groupId) {
  if (!pendingMetadata.has(sock)) pendingMetadata.set(sock, new Map());
  const requests = pendingMetadata.get(sock);
  if (!requests.has(groupId)) {
    requests.set(groupId, sock.groupMetadata(groupId).finally(() => requests.delete(groupId)));
  }
  return requests.get(groupId);
}

function normalizeNumber(jidOrNum = "") {
  return String(jidOrNum)
    .split("@")[0]
    .split(":")[0]
    .replace(/[^0-9]/g, "");
}

function getOwnerNumbers() {
  const raw = process.env.OWNER_NUMBERS || "50683678160";
  return raw
    .split(",")
    .map((n) => normalizeNumber(n))
    .filter(Boolean);
}

function ownerNumber(value) {
  if (typeof value !== "string") return "";
  if (value.includes("@") && !/@(?:s\.whatsapp\.net|c\.us)$/i.test(value)) return "";
  const number = normalizeNumber(value);
  return number === "83678160" ? "50683678160" : number;
}

function isSupremeOwner(senderJid) {
  const number = ownerNumber(senderJid);
  return Boolean(number && getOwnerNumbers().map(ownerNumber).includes(number));
}

async function getMessageOwner(sock, msg, sender, checkGroup = false) {
  const { key } = msg;
  const isGroup = key.remoteJid.endsWith("@g.us");
  const candidates = key.fromMe
    ? [sock.user?.id]
    : isGroup
      ? [sender, key.participantPn, key.senderPn, key.participantAlt]
      : [sender, key.senderPn, key.remoteJidAlt];
  const direct = candidates.find(isSupremeOwner);
  if (direct) return ownerNumber(direct);

  if (checkGroup && isGroup && !key.fromMe && sender?.endsWith("@lid")) {
    try {
      const { participants } = await getGroupMetadata(sock, key.remoteJid);
      const lid = sender.replace(/:\d+@/, "@");
      const participant = participants.find(p =>
        [p.id, p.lid].some(id => id?.replace(/:\d+@/, "@") === lid)
      );
      const phone = [participant?.jid, participant?.phoneNumber, participant?.id].find(isSupremeOwner);
      if (phone) return ownerNumber(phone);
    } catch {
      // A message without a verified phone stays unprivileged.
    }
  }
  return "";
}

async function isGroupAdmin(sock, groupId, userJid) {
  if (isSupremeOwner(userJid)) return true;
  try {
    const meta = await getGroupMetadata(sock, groupId);
    const targetNum = normalizeNumber(userJid);
    const participant = meta.participants.find(
      (p) => normalizeNumber(p.id) === targetNum
    );
    return Boolean(participant && (participant.admin === "admin" || participant.admin === "superadmin"));
  } catch {
    return false;
  }
}

module.exports = {
  normalizeNumber,
  getOwnerNumbers,
  isSupremeOwner,
  getMessageOwner,
  isGroupAdmin
};
