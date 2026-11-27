const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "../../data");

function readJSON(filename, fallback = {}) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf-8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[Storage] Error leyendo ${filename}:`, err.message);
    return fallback;
  }
}

function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[Storage] Error guardando ${filename}:`, err.message);
  }
}

function getGroupState(groupId) {
  const all = readJSON("groups_state.json", {});
  return all[groupId] || defaultGroupState();
}

function defaultGroupState() {
    return {
      active: false,
      adminOnly: false,
      antilink: false,
      antitoxic: false,
      antitoxicLastToggle: 0,
      welcome: false,
      bye: false,
      rules: ""
    };
}

function updateGroupState(groupId, patch) {
  const file = path.join(DATA_DIR, "groups_state.json");
  const temp = file + "." + randomUUID() + ".tmp";
  let all;
  try {
    const raw = fs.readFileSync(file, "utf8");
    all = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    all = {};
  }
  const current = all[groupId] || defaultGroupState();
  all[groupId] = { ...current, ...patch };
  try {
    fs.writeFileSync(temp, JSON.stringify(all, null, 2), "utf8");
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return all[groupId];
}

function getAllGroupsState() {
  return readJSON("groups_state.json", {});
}

module.exports = {
  readJSON,
  writeJSON,
  getGroupState,
  updateGroupState,
  getAllGroupsState
};
