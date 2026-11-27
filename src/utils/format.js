const MONO_MAP = {
  a: "𝚊", b: "𝚋", c: "𝚌", d: "𝚍", e: "𝚎", f: "𝚏", g: "𝚐", h: "𝚑", i: "𝚒",
  j: "𝚓", k: "𝚔", l: "𝚕", m: "𝚖", n: "𝚗", o: "𝚘", p: "𝚙", q: "𝚚", r: "𝚛",
  s: "𝚜", t: "𝚝", u: "𝚞", v: "𝚟", w: "𝚠", x: "𝚡", y: "𝚢", z: "𝚣",
  A: "𝙰", B: "𝙱", C: "𝙲", D: "𝙳", E: "𝙴", F: "𝙵", G: "𝙶", H: "𝙷", I: "𝙸",
  J: "𝙹", K: "𝙺", L: "𝙻", M: "𝙼", N: "𝙽", O: "𝙾", P: "𝙿", Q: "𝚀", R: "𝚁",
  S: "𝚂", T: "𝚃", U: "𝚄", V: "𝚅", W: "𝚆", X: "𝚇", Y: "𝚈", Z: "𝚉",
  "0": "𝟶", "1": "𝟷", "2": "𝟸", "3": "𝟹", "4": "𝟺",
  "5": "𝟻", "6": "𝟼", "7": "𝟽", "8": "𝟾", "9": "𝟿"
};

const SIGNATURE = "> ᴮʸ ᴰᴬⱽᴵᴰ";

function toMono(text) {
  return String(text)
    .split("")
    .map((ch) => MONO_MAP[ch] || ch)
    .join("");
}

function withSignature(text) {
  return `${text}\n\n${SIGNATURE}`;
}

function formatBotMsg(text) {
  return withSignature(toMono(text));
}

function badSyntaxMsg(example) {
  return `❌ 𝙴𝚜𝚘 𝚎𝚜𝚝𝚊 𝚖𝚊𝚕 𝚎𝚜𝚌𝚛𝚒𝚝𝚘 𝚘 𝚏𝚊𝚕𝚝𝚊 𝚞𝚗 𝚍𝚊𝚝𝚘. 𝚄𝚜𝚊: \`${example}\`\n\n${SIGNATURE}`;
}

function actionFailedMsg() {
  return "Di no amiko, falle, losientopidoperdon.";
}

function noPermissionMsg() {
  return `🚫 𝙽𝚘 𝚝𝚒𝚎𝚗𝚎𝚜 𝚙𝚎𝚛𝚖𝚒𝚜𝚘 𝚙𝚊𝚛𝚊 𝚞𝚜𝚊𝚛 𝚎𝚜𝚝𝚘 compaire.\n\n${SIGNATURE}`;
}

function formatDuration(ms) {
  const sec = Math.max(1, Math.floor(ms / 1000));
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  if (hrs > 0) return `${hrs}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

module.exports = {
  SIGNATURE,
  toMono,
  withSignature,
  formatBotMsg,
  badSyntaxMsg,
  actionFailedMsg,
  noPermissionMsg,
  formatDuration
};
