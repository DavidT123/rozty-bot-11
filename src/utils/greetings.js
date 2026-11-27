function renderGreeting(state, action, tag) {
  const template = action === "remove" ? state.byeMessage || "𝙰𝚍𝚒ó𝚜, 𝚣𝚘𝚛𝚛𝚒𝚝𝚊. {usuario}" : state.welcomeMessage;
  if (template) return template.includes("{usuario}") ? template.replaceAll("{usuario}", tag) : template + "\n\n" + tag;
  return `❃  𝗕𝗜𝗘𝗡𝗩𝗘𝗡𝗜𝗗@ 𝗔𝗟 𝗚𝗥𝗨𝗣𝗢 ⚡
✦ ${tag} ✦

➥  ʀᴇᴠɪꜱᴀ ʟᴀꜱ ʀᴇɢʟᴀꜱ ᴄᴏɴ \`.reglas\`
➥  ᴀʙʀᴇ ʟᴏꜱ ᴄᴏᴍᴀɴᴅᴏꜱ ᴄᴏɴ \`.menu\` (ᴘʀᴇꜰɪᴊᴏꜱ \`！\` ʏ \`．\`)

> ᴮʸ ᴰᴬⱽᴵᴰ`;
}

module.exports = { renderGreeting };
