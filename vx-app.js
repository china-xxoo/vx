
const APP_VERSION = "20260510-v5-complete-logic";
const CONFIG_FILE_NAME = "vx-config.json";
const CONFIG_FILE_URL = "vx-config.json";
const CONFIG_FETCH_CACHE_MS = 30000;
const DEFAULT_ENCRYPTED_CONFIG = null;
const ADMIN_PASSWORD_HASH = "";
const API = "https://api.github.com";
const ROOM_PREFIX = "ENC_ROOM_META_V1:";
const MSG_PREFIX = "ENC_ROOM_MSG_V1:";
const ANNOUNCE_PREFIX = "VX_ANNOUNCEMENT_V1:";
const ACCOUNT_PREFIX = "ENC_ACCOUNT_PROFILE_V1:";
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MQTT_WS_URL = "wss://afa67eee.ala.cn-hangzhou.emqxsl.cn:8084/mqtt";
const MQTT_USERNAME = "vx_user";
const MQTT_PASSWORD = "vx_2026_chat_private_520_xx";
const MQTT_PREFIX = "vx/app/calcchat/v1";
const LOBBY_FALLBACK_MS = 8000;
const ROOM_FALLBACK_MS = 6000;
const GIST_RETRY_MS = 3500;
const MAX_CACHE_MESSAGES = 800;
const PRESENCE_HEARTBEAT_MS = 8000;
const PRESENCE_TTL_MS = 24000;
const TYPING_STOP_MS = 1800;
const DEFAULT_ROOM_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROOM_PURGE_INTERVAL_MS = 60 * 1000;
const DEFAULT_PUBLIC_ROOM = {
type: "room",
roomId: "default-no-password-room-v1",
roomNo: "000001",
roomName: "聊天大厅",
createdBy: "System",
createdAt: 0,
noPassword: true,
commentId: null,
version: 3
};
function isDefaultPublicRoomId(roomId) {
return String(roomId || "") === DEFAULT_PUBLIC_ROOM.roomId;
}
function getTodayStartTime() {
const d = new Date();
d.setHours(0, 0, 0, 0);
return d.getTime();
}
function getDefaultRoomCutoffTime() {
return Math.max(getTodayStartTime(), Date.now() - DEFAULT_ROOM_RETENTION_MS);
}
function isDefaultRoomMessageActive(msgOrWrapper) {
if (!msgOrWrapper || !isDefaultPublicRoomId(msgOrWrapper.roomId)) return true;
const t = Number(msgOrWrapper.time || 0);
return Number.isFinite(t) && t >= getDefaultRoomCutoffTime();
}
function cleanupDefaultRoomLocalCache() {
const roomId = DEFAULT_PUBLIC_ROOM.roomId;
try {
const key = roomCacheKey(roomId);
const arr = JSON.parse(localStorage.getItem(key) || "[]");
if (!Array.isArray(arr)) return;
const kept = arr.filter(isDefaultRoomMessageActive);
if (kept.length !== arr.length) {
localStorage.setItem(key, JSON.stringify(kept));
setLatestRoomCount(roomId, kept.length);
localStorage.setItem(roomLastReadCountKey(roomId), String(Math.min(getStoredNumber(roomLastReadCountKey(roomId), kept.length), kept.length)));
if (state.currentRoom && state.currentRoom.roomId === roomId) {
state.roomSeen = new Set();
kept.forEach(m => state.roomSeen.add(getMessageKey(m)));
renderAllMessages(kept);
markRoomRead(roomId);
}
}
} catch (e) {}
}
function removeExpiredDefaultRoomPendingItems() {
try {
const arr = getPendingGist();
const kept = arr.filter(item => {
if (!item || !isDefaultPublicRoomId(item.roomId)) return true;
return Number(item.time || 0) >= getDefaultRoomCutoffTime();
});
if (kept.length !== arr.length) setPendingGist(kept);
} catch (e) {}
}
async function purgeExpiredDefaultRoomMessages(silent = true) {
if (!appConfig) return;
const roomId = DEFAULT_PUBLIC_ROOM.roomId;
cleanupDefaultRoomLocalCache();
removeExpiredDefaultRoomPendingItems();
try {
const comments = await fetchAllComments();
const ids = [];
for (const c of comments) {
if (typeof c.body !== "string" || !c.body.startsWith(MSG_PREFIX)) continue;
try {
const wrapper = JSON.parse(c.body.slice(MSG_PREFIX.length));
if (wrapper.roomId === roomId && !isDefaultRoomMessageActive(wrapper)) {
ids.push(c.id);
}
} catch (e) {}
}
for (const id of ids) {
try { await deleteGistComment(id); } catch (e) {}
}
if (ids.length) {
localStorage.removeItem(roomLastCommentKey(roomId));
mqttPublishJson(roomTopic(roomId), { type: "defaultRoomExpiredPurged", roomId, time: Date.now() });
mqttPublishJson(roomsTopic(), { type: "roomsUpdate", time: Date.now() });
if (!silent) showToast("大厅过期记录已清理");
}
} catch (e) {
if (!silent) showToast("大厅清理失败");
}
}
function scheduleDefaultRoomMidnightAutoClear() {
clearTimeout(state.defaultRoomPurgeTimer);
const now = new Date();
const next = new Date(now);
next.setHours(24, 0, 5, 0);
const delay = Math.max(5000, next.getTime() - now.getTime());
state.defaultRoomPurgeTimer = setTimeout(async () => {
await purgeExpiredDefaultRoomMessages(true);
scheduleDefaultRoomMidnightAutoClear();
}, delay);
}
let calcExpression = "";
let unlockInput = "";
let secretMode = false;
let isFakeResult = false;
let cTapTime = 0;
let appConfig = null;
let activeUnlockCode = "";
let pendingRoom = null;
let packetId = 1;
let remoteConfigBundleCache = null;
let remoteConfigBundleFetchedAt = 0;
const state = {
senderId: localStorage.getItem("vx_sender_id") || crypto.randomUUID(),
displayName: localStorage.getItem("vx_display_name") || "",
currentRoom: null,
rooms: [],
timer: null,
lobbyTimer: null,
gistRetryTimer: null,
idleTimer: null,
defaultRoomPurgeTimer: null,
lastRoomsHash: "",
roomSeen: new Set(),
onlineClients: {},
typingUsers: {},
typingStopTimer: null,
typingPublishTimer: null,
roomMessageNoticeClock: {},
accountProfile: null,
adminMode: false,
announcement: null,
audio: {
ctx: null,
enabled: false,
lastPlayAt: 0
},
mqtt: {
ws: null,
connected: false,
reconnectTimer: null,
pingTimer: null,
presenceTimer: null,
clientId: "vx_" + Math.random().toString(16).slice(2) + "_" + Date.now(),
activeTopic: null
}
};
localStorage.setItem("vx_sender_id", state.senderId);
const calculator = document.getElementById("calculator");
const chatApp = document.getElementById("chatApp");
const display = document.getElementById("display");
const lobbyScreen = document.getElementById("lobbyScreen");
const roomList = document.getElementById("roomList");
const nicknameLine = document.getElementById("nicknameLine");
const chatShell = document.getElementById("chatShell");
const chatBox = document.getElementById("chatBox");
const sendArea = document.getElementById("sendArea");
const messageInput = document.getElementById("messageInput");
const dataStatus = document.getElementById("dataStatus");
const dataStatusText = document.getElementById("dataStatusText");
const headerLogo = document.getElementById("headerLogo");
const logoUnreadBadge = document.getElementById("logoUnreadBadge");
const announcementBtn = document.getElementById("announcementBtn");
const roomSearchInput = document.getElementById("roomSearchInput");
const adminScreen = document.getElementById("adminScreen");
const adminRoomList = document.getElementById("adminRoomList");
const adminOnlineStats = document.getElementById("adminOnlineStats");
const adminVersionInfo = document.getElementById("adminVersionInfo");
const adminVersionFooter = document.getElementById("adminVersionFooter");
const roomBackBtn = document.getElementById("roomBackBtn");
const roomTitleBtn = document.getElementById("roomTitleBtn");
const lobbyActions = document.getElementById("lobbyActions");
const roomActions = document.getElementById("roomActions");
const roomInfoText = document.getElementById("roomInfoText");
const historyTip = document.getElementById("historyTip");
const typingTip = document.getElementById("typingTip");
const emergencyBar = document.getElementById("emergencyBar");
const toastEl = document.getElementById("toast");
function updateAppHeight() {
const root = document.documentElement;
if (window.visualViewport) {
const vv = window.visualViewport;
const visibleHeight = Math.max(320, Math.round(vv.height));
const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - (vv.offsetTop || 0)));
root.style.setProperty("--app-height", window.innerHeight + "px");
root.style.setProperty("--visible-height", visibleHeight + "px");
root.style.setProperty("--vv-top", "0px");
root.style.setProperty("--keyboard-offset", keyboard + "px");
} else {
root.style.setProperty("--app-height", window.innerHeight + "px");
root.style.setProperty("--visible-height", window.innerHeight + "px");
root.style.setProperty("--vv-top", "0px");
root.style.setProperty("--keyboard-offset", "0px");
}
}
updateAppHeight();
window.addEventListener("resize", updateAppHeight);
if (window.visualViewport) {
window.visualViewport.addEventListener("resize", updateAppHeight);
window.visualViewport.addEventListener("scroll", updateAppHeight);
}
window.addEventListener("orientationchange", () => setTimeout(updateAppHeight, 250));
document.addEventListener("focusin", () => setTimeout(updateAppHeight, 80));
document.addEventListener("focusout", () => setTimeout(updateAppHeight, 180));
document.addEventListener("touchmove", function(e) {
const scrollable = e.target.closest(".screen, .chat-box, .modal");
if (!scrollable) e.preventDefault();
}, { passive: false });
function updateDisplay() {
if (secretMode) {
display.textContent = unlockInput || "0";
return;
}
const showText = (calcExpression || "0").replaceAll("*", "×").replaceAll("/", "÷");
display.textContent = showText;
}
function resetSecretMode() {
secretMode = false;
unlockInput = "";
}
function enterSecretMode() {
secretMode = true;
unlockInput = "";
calcExpression = "";
isFakeResult = false;
updateDisplay();
}
function showRandomFakeCalculation() {
const examples = ["128+256=384","96÷3=32","45×7=315","980-275=705","36×12=432","720÷8=90","58+349=407","1500-680=820"];
calcExpression = examples[Math.floor(Math.random() * examples.length)].replaceAll("×", "*").replaceAll("÷", "/");
resetSecretMode();
isFakeResult = true;
updateDisplay();
}
function triggerHardReload() {
try {
localStorage.setItem("vx_auto_update_applied_at", String(Date.now()));
if ("caches" in window) {
caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).finally(() => {
location.replace(location.pathname + "?v=" + Date.now());
});
} else {
location.replace(location.pathname + "?v=" + Date.now());
}
} catch (e) {
location.replace(location.pathname + "?v=" + Date.now());
}
}
function appendNumber(num) {
if (secretMode) {
if (unlockInput.length >= 6) return;
unlockInput += String(num);
updateDisplay();
return;
}
if (isFakeResult) {
calcExpression = "";
isFakeResult = false;
}
calcExpression = (calcExpression === "0" || calcExpression === "Error") ? String(num) : calcExpression + String(num);
updateDisplay();
}
async function confirmSecretUnlock() {
if (!/^\d{1,6}$/.test(unlockInput)) {
updateDisplay();
return;
}
const unlocked = await tryUnlock();
if (unlocked) return;
updateDisplay();
}
async function appendOperator(op) {
if (secretMode) {
updateDisplay();
return;
}
if (isFakeResult) {
calcExpression = "";
isFakeResult = false;
}
if (calcExpression === "Error") {
calcExpression = "";
}
const expr = String(calcExpression || "");
if (op === "%") {
const candidates = getTrailingUnlockCandidates(expr);
if (candidates.length) {
await tryUnlockWithCandidates(candidates);
unlockInput = "";
}
updateDisplay();
return;
}
const last = expr.slice(-1);
if (!expr) {
if (op === "-") {
calcExpression = "-";
updateDisplay();
}
return;
}
if ("+-*/%".includes(last)) {
calcExpression = expr.slice(0, -1) + op;
} else {
calcExpression = expr + op;
}
updateDisplay();
}
function appendDot() {
if (secretMode) {
return;
}
if (isFakeResult) {
calcExpression = "";
isFakeResult = false;
}
if (calcExpression === "Error") calcExpression = "";
const parts = String(calcExpression || "").split(/[+\-*/%]/);
const currentPart = parts[parts.length - 1] || "";
if (currentPart.includes(".")) return;
calcExpression += currentPart ? "." : "0.";
updateDisplay();
}
function clearCalc() {
calcExpression = "";
resetSecretMode();
isFakeResult = false;
updateDisplay();
}
function backspaceCalc() {
if (secretMode) {
unlockInput = unlockInput.slice(0, -1);
updateDisplay();
return;
}
if (isFakeResult) {
calcExpression = "";
resetSecretMode();
isFakeResult = false;
updateDisplay();
return;
}
calcExpression = calcExpression.slice(0, -1);
updateDisplay();
}
async function calculateResult() {
try {
if (secretMode) {
updateDisplay();
return;
}
if (isFakeResult) {
calcExpression = "";
resetSecretMode();
isFakeResult = false;
updateDisplay();
return;
}
if (!calcExpression || calcExpression === "0") {
calcExpression = "";
resetSecretMode();
updateDisplay();
return;
}
const expr = String(calcExpression || "").trim();
const last = expr.slice(-1);
if (!/^[0-9+\-*/%. ]+$/.test(expr) || "+-*/%.".includes(last)) {
calcExpression = "Error";
resetSecretMode();
showToast("输入有误");
updateDisplay();
return;
}
const result = Function('"use strict"; return (' + expr + ')')();
if (!Number.isFinite(result)) {
calcExpression = "Error";
} else {
calcExpression = String(Number(result.toFixed(8)));
}
resetSecretMode();
updateDisplay();
} catch (e) {
calcExpression = "Error";
resetSecretMode();
showToast("输入有误");
updateDisplay();
}
}
function toBase64(buffer) {
const bytes = new Uint8Array(buffer);
let binary = "";
for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
return btoa(binary);
}
function fromBase64(base64) {
const binary = atob(base64);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
return bytes;
}
async function deriveKey(password, salt) {
const encoder = new TextEncoder();
const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
return crypto.subtle.deriveKey(
{ name: "PBKDF2", salt: salt, iterations: 180000, hash: "SHA-256" },
baseKey,
{ name: "AES-GCM", length: 256 },
false,
["encrypt", "decrypt"]
);
}
async function deriveKeyFromText(password, saltText) {
return deriveKey(password, new TextEncoder().encode(saltText));
}
async function encryptPayload(obj, password, saltText) {
const encoder = new TextEncoder();
const key = await deriveKeyFromText(password, saltText);
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(obj)));
return { iv: toBase64(iv), data: toBase64(encrypted) };
}
async function decryptPayload(payload, password, saltText) {
const decoder = new TextDecoder();
const key = await deriveKeyFromText(password, saltText);
const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(payload.iv) }, key, fromBase64(payload.data));
return JSON.parse(decoder.decode(decrypted));
}
function getConfigFileUrl() {
const fromQuery = new URLSearchParams(location.search).get("configUrl") || "";
return String(fromQuery || CONFIG_FILE_URL || CONFIG_FILE_NAME).trim();
}
function normalizeRemoteConfigBundle(data) {
if (!data || typeof data !== "object") return null;
if (data.encryptedConfig && data.encryptedConfig.salt && data.encryptedConfig.iv && data.encryptedConfig.data) {
return data;
}
if (data.salt && data.iv && data.data) {
return { type: "VX_REMOTE_CONFIG_V1", encryptedConfig: data };
}
return null;
}
async function fetchRemoteConfigBundle(force = false) {
const now = Date.now();
if (!force && remoteConfigBundleCache && now - remoteConfigBundleFetchedAt < CONFIG_FETCH_CACHE_MS) {
return remoteConfigBundleCache;
}
const configUrl = getConfigFileUrl();
const sep = configUrl.includes("?") ? "&" : "?";
const res = await fetch(configUrl + sep + "t=" + Date.now(), { cache: "no-store" });
if (!res.ok) {
throw new Error("配置文件读取失败：" + res.status);
}
const text = await res.text();
const bundle = normalizeRemoteConfigBundle(JSON.parse(text));
if (!bundle) throw new Error("配置文件格式不正确");
remoteConfigBundleCache = bundle;
remoteConfigBundleFetchedAt = now;
try { renderAdminVersionInfo(); } catch (e) {}
return bundle;
}
async function getEncryptedConfigCandidates(forceRemote = false) {
const list = [];
try {
const remoteBundle = await fetchRemoteConfigBundle(forceRemote);
if (remoteBundle && remoteBundle.encryptedConfig) {
list.push({ type: "remote-gist", config: remoteBundle.encryptedConfig });
}
} catch (e) {
console.warn("remote config load failed", e);
}
const saved = localStorage.getItem("vx_custom_encrypted_config");
if (saved) {
try {
const customConfig = JSON.parse(saved);
if (customConfig && customConfig.salt && customConfig.iv && customConfig.data) {
list.push({ type: "custom-local", config: customConfig });
}
} catch (e) {}
}
if (DEFAULT_ENCRYPTED_CONFIG && DEFAULT_ENCRYPTED_CONFIG.salt && DEFAULT_ENCRYPTED_CONFIG.iv && DEFAULT_ENCRYPTED_CONFIG.data) {
list.push({ type: "default", config: DEFAULT_ENCRYPTED_CONFIG });
}
return list;
}
async function decryptOneConfig(encryptedConfig, unlockCode) {
const decoder = new TextDecoder();
const key = await deriveKey(unlockCode, fromBase64(encryptedConfig.salt));
const decrypted = await crypto.subtle.decrypt(
{ name: "AES-GCM", iv: fromBase64(encryptedConfig.iv) },
key,
fromBase64(encryptedConfig.data)
);
return JSON.parse(decoder.decode(decrypted));
}
function normalizeAppConfig(config) {
const normalized = { ...(config || {}) };
if (!normalized.token && normalized.githubToken) normalized.token = normalized.githubToken;
if (!normalized.token && normalized.github_token) normalized.token = normalized.github_token;
if (!normalized.token && normalized.githubPAT) normalized.token = normalized.githubPAT;
if (!normalized.gistId && normalized.chatGistId) normalized.gistId = normalized.chatGistId;
if (!normalized.gistId && normalized.chatDataGistId) normalized.gistId = normalized.chatDataGistId;
if (!normalized.gistId && normalized.chatDataGistID) normalized.gistId = normalized.chatDataGistID;
if (!normalized.gistId && normalized.dataGistId) normalized.gistId = normalized.dataGistId;
if (!normalized.gistId && normalized.messageGistId) normalized.gistId = normalized.messageGistId;
if (!normalized.gistId && normalized.messagesGistId) normalized.gistId = normalized.messagesGistId;
if (!normalized.gistId && normalized.gist_id) normalized.gistId = normalized.gist_id;
if (!normalized.chatSecret && normalized.chat_secret) normalized.chatSecret = normalized.chat_secret;
if (!normalized.chatSecret && normalized.secret) normalized.chatSecret = normalized.secret;
return normalized;
}
async function decryptConfig(unlockCode) {
const candidates = await getEncryptedConfigCandidates(true);
let lastError = null;
for (const item of candidates) {
try {
const config = normalizeAppConfig(await decryptOneConfig(item.config, unlockCode));
if (!config.token || !config.gistId || !config.chatSecret) {
throw new Error("配置缺少 token / gistId / chatSecret");
}
return { config, type: item.type };
} catch (e) {
lastError = e;
}
}
throw lastError || new Error("密码错误或未找到配置");
}
function normalizeUnlockCode(input) {
return String(input || "").trim().replace(/\D/g, "").slice(0, 6);
}
function getUnlockCodeCandidates(input) {
const canonical = normalizeUnlockCode(input);
if (!/^\d{1,6}$/.test(canonical)) return [];
return [canonical];
}
function getTrailingUnlockCandidates(text) {
const match = String(text || "").match(/(\d+)$/);
if (!match) return [];
const tail = match[1].slice(-6);
const candidates = [];
const seen = new Set();
for (let i = 0; i < tail.length; i++) {
const code = tail.slice(i);
if (/^\d{1,6}$/.test(code) && !seen.has(code)) {
seen.add(code);
candidates.push(code);
}
}
return candidates;
}
async function tryUnlockWithCandidates(candidates) {
const codes = Array.isArray(candidates) ? candidates.filter(code => /^\d{1,6}$/.test(String(code || ""))) : [];
if (!codes.length) return false;
let encryptedCandidates = [];
try {
encryptedCandidates = await getEncryptedConfigCandidates(true);
} catch (e) {
console.warn("config candidates load failed", e);
return false;
}
for (const code of codes) {
for (const item of encryptedCandidates) {
try {
const config = normalizeAppConfig(await decryptOneConfig(item.config, code));
if (!config.token || !config.gistId || !config.chatSecret) {
throw new Error("配置缺少 token / gistId / chatSecret");
}
appConfig = config;
activeUnlockCode = code;
scheduleDefaultRoomMidnightAutoClear();
setTimeout(() => purgeExpiredDefaultRoomMessages(true), 1200);
openApp();
return true;
} catch (e) {
console.warn("unlock candidate failed", e);
}
}
}
return false;
}
async function tryUnlock() {
const candidates = getUnlockCodeCandidates(unlockInput);
return tryUnlockWithCandidates(candidates);
}
function showToast(text, ms = 1500) {
toastEl.textContent = text;
toastEl.style.display = "block";
clearTimeout(showToast._timer);
showToast._timer = setTimeout(() => {
toastEl.style.display = "none";
}, ms);
}
function initNotifyAudio() {
}
function playNotifySound(kind = "message") {
}
function generateRoomNo() {
const chars = ROOM_CODE_CHARS;
let code = "";
do {
code = "";
for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
} while (!/[A-Z]/.test(code) || !/[0-9]/.test(code));
return code;
}
function getRoomNo(room) {
if (room.roomNo) return room.roomNo;
const text = String(room.roomId || "");
let sum = 0;
for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i) * (i + 1)) % 900000;
return String(100000 + sum).slice(0, 6);
}
function getDefaultRoomPassword() {
return String(appConfig.chatSecret || "default") + "::default-no-password-room-v1";
}
function makeRoomSecret() {
const bytes = crypto.getRandomValues(new Uint8Array(32));
return toBase64(bytes) + "::" + crypto.randomUUID();
}
async function encryptRoomMeta(meta) {
return encryptPayload(meta, appConfig.chatSecret, "vx-room-meta-v1");
}
async function decryptRoomMeta(payload) {
return decryptPayload(payload, appConfig.chatSecret, "vx-room-meta-v1");
}
async function encryptAdminRoomSecret(roomId, roomSecret) {
return encryptPayload({ ok: true, roomId, roomSecret, admin: true }, appConfig.chatSecret, "vx-room-admin:" + roomId);
}
async function decryptAdminRoomSecret(room) {
if (!room.adminSecret) return null;
const data = await decryptPayload(room.adminSecret, appConfig.chatSecret, "vx-room-admin:" + room.roomId);
if (!data.ok || data.roomId !== room.roomId || !data.roomSecret) return null;
return data.roomSecret;
}
async function createRoom() {
if (!requireNickname()) return;
const roomPassword = document.getElementById("newRoomPassword").value.trim();
if (roomPassword.length < 4) {
showToast("密码至少4位");
return;
}
await loadRooms(false);
try {
const roomId = crypto.randomUUID();
const roomSecret = makeRoomSecret();
let roomNo = generateRoomNo();
const used = new Set((state.rooms || []).map(r => String(r.roomNo || "").toUpperCase()));
let guard = 0;
while (used.has(roomNo) && guard < 50) {
roomNo = generateRoomNo();
guard++;
}
const roomName = "房间 " + roomNo;
const check = await encryptPayload(
{ ok: true, roomId, roomSecret },
roomPassword,
"vx-room-check:" + roomId
);
const adminSecret = await encryptAdminRoomSecret(roomId, roomSecret);
const meta = {
type: "room",
roomId,
roomNo,
roomName,
createdBy: state.displayName,
ownerAccountId: state.accountProfile && state.accountProfile.accountId,
ownerNicknameNumber: state.displayName,
createdAt: Date.now(),
noPassword: false,
check,
adminSecret,
version: 4
};
const encryptedMeta = await encryptRoomMeta(meta);
const comment = await postGistComment(ROOM_PREFIX + JSON.stringify(encryptedMeta));
meta.commentId = comment.id;
rememberRoomAccess(meta, roomSecret, "created");
closeCreateRoomModal();
await loadRooms(false);
mqttPublishJson(roomsTopic(), {
type: "roomCreated",
room: sanitizeRoomForRealtime(meta),
senderId: state.senderId,
time: Date.now()
});
mqttPublishJson(roomsTopic(), { type: "roomsUpdate", time: Date.now() });
showToast("房间已创建：" + roomNo);
openRoom(meta, roomSecret, { accessType: "owner" });
} catch (e) {
showToast("创建失败");
console.error(e);
}
}
async function confirmJoinRoom() {
const password = document.getElementById("joinRoomPassword").value.trim();
if (!pendingRoom || !password) {
showToast("请输入密码");
return;
}
try {
try {
const check = await decryptPayload(pendingRoom.check, password, "vx-room-check:" + pendingRoom.roomId);
if (check.ok && check.roomId === pendingRoom.roomId) {
const roomSecret = check.roomSecret || password;
const room = pendingRoom;
closeJoinModal();
rememberRoomAccess(room, roomSecret, "joined");
openRoom(room, roomSecret, { accessType: "room" });
return;
}
} catch (e) {}
const isAdmin = await checkAdminPassword(password);
if (isAdmin) {
const roomSecret = await decryptAdminRoomSecret(pendingRoom);
if (!roomSecret) {
showToast("旧房间缺少管理密钥");
return;
}
const room = pendingRoom;
closeJoinModal();
rememberRoomAccess(room, roomSecret, "joined");
openRoom(room, roomSecret, { accessType: "admin", adminMode: true });
return;
}
showToast("密码错误");
} catch (e) {
showToast("进入失败");
}
}
function roomCacheKey(roomId) {
return "vx_room_cache_v4_" + roomId;
}
function roomLastCommentKey(roomId) {
return "vx_room_last_gist_comment_v4_" + roomId;
}
function roomEnteredKey(roomId) {
return "vx_room_entered_v4_" + roomId;
}
function roomLatestCountKey(roomId) {
return "vx_room_latest_count_v4_" + roomId;
}
function roomLastReadCountKey(roomId) {
return "vx_room_last_read_count_v4_" + roomId;
}
function hasEnteredRoom(roomId) {
return localStorage.getItem(roomEnteredKey(roomId)) === "1";
}
function getStoredNumber(key, fallback = 0) {
const n = Number(localStorage.getItem(key));
return Number.isFinite(n) ? n : fallback;
}
function getRoomMessageCount(roomId) {
return loadRoomCache(roomId).length;
}
function getLatestRoomCount(roomId) {
const stored = getStoredNumber(roomLatestCountKey(roomId), 0);
const cached = getRoomMessageCount(roomId);
return Math.max(stored, cached);
}
function setLatestRoomCount(roomId, count) {
localStorage.setItem(roomLatestCountKey(roomId), String(Math.max(0, Number(count) || 0)));
}
function markRoomEntered(roomId) {
localStorage.setItem(roomEnteredKey(roomId), "1");
}
function markRoomRead(roomId) {
markRoomEntered(roomId);
const count = getRoomMessageCount(roomId);
setLatestRoomCount(roomId, count);
localStorage.setItem(roomLastReadCountKey(roomId), String(count));
updateUnreadBadge();
if (!state.currentRoom || state.currentRoom.roomId !== roomId) {
renderRooms();
}
}
function incrementRoomLatest(roomId) {
const next = getLatestRoomCount(roomId) + 1;
setLatestRoomCount(roomId, next);
updateUnreadBadge();
return next;
}
function getRoomUnreadCount(roomId) {
if (!hasEnteredRoom(roomId)) return 0;
const latest = getLatestRoomCount(roomId);
const read = getStoredNumber(roomLastReadCountKey(roomId), latest);
return Math.max(0, latest - read);
}
function getTotalUnreadCount() {
return (state.rooms || []).reduce((sum, room) => sum + getRoomUnreadCount(room.roomId), 0);
}
function updateUnreadBadge() {
const total = getTotalUnreadCount();
if (logoUnreadBadge) {
if (total > 0) {
logoUnreadBadge.style.display = "block";
logoUnreadBadge.textContent = total > 99 ? "99+" : String(total);
} else {
logoUnreadBadge.style.display = "none";
logoUnreadBadge.textContent = "";
}
}
try {
if ("setAppBadge" in navigator && total > 0) navigator.setAppBadge(total);
else if ("clearAppBadge" in navigator) navigator.clearAppBadge();
} catch (e) {}
}
function pendingKey() {
return "vx_pending_gist_v4";
}
function loadRoomCache(roomId) {
try {
const arr = JSON.parse(localStorage.getItem(roomCacheKey(roomId)) || "[]");
if (!Array.isArray(arr)) return [];
if (!isDefaultPublicRoomId(roomId)) return arr;
const kept = arr.filter(isDefaultRoomMessageActive);
if (kept.length !== arr.length) {
localStorage.setItem(roomCacheKey(roomId), JSON.stringify(kept));
setLatestRoomCount(roomId, kept.length);
localStorage.setItem(roomLastReadCountKey(roomId), String(Math.min(getStoredNumber(roomLastReadCountKey(roomId), kept.length), kept.length)));
}
return kept;
} catch (e) {
return [];
}
}
function saveRoomCache(roomId, messages) {
const sorted = [...messages].sort((a, b) => a.time - b.time);
const unique = [];
const seen = new Set();
for (const msg of sorted) {
if (isDefaultPublicRoomId(roomId) && !isDefaultRoomMessageActive(msg)) continue;
const id = getMessageKey(msg);
if (seen.has(id)) continue;
seen.add(id);
unique.push(msg);
}
const clipped = unique.slice(-MAX_CACHE_MESSAGES);
localStorage.setItem(roomCacheKey(roomId), JSON.stringify(clipped));
if (isDefaultPublicRoomId(roomId)) {
setLatestRoomCount(roomId, clipped.length);
} else {
setLatestRoomCount(roomId, Math.max(getLatestRoomCount(roomId), clipped.length));
}
}
function getMessageKey(msg) {
if (msg.messageId) return msg.messageId;
return [msg.roomId || "", msg.senderId || "", msg.senderName || "", msg.text || "", msg.time || ""].join("_");
}
function initSeenFromCache(roomId) {
state.roomSeen = new Set();
const cached = loadRoomCache(roomId);
cached.forEach(m => state.roomSeen.add(getMessageKey(m)));
}
function addMessageToCache(roomId, msg) {
const cached = loadRoomCache(roomId);
const id = getMessageKey(msg);
if (cached.some(m => getMessageKey(m) === id)) return;
cached.push(msg);
saveRoomCache(roomId, cached);
}
function renderAllMessages(messages) {
chatBox.innerHTML = "";
const sorted = [...messages].sort((a, b) => a.time - b.time);
sorted.forEach(renderMessage);
chatBox.scrollTop = chatBox.scrollHeight;
}
function renderMessage(msg) {
const id = getMessageKey(msg);
const isMe = msg.senderId === state.senderId;
const wrap = document.createElement("div");
wrap.className = "msg-wrap " + (isMe ? "me" : "other");
wrap.dataset.messageId = id;
const meta = document.createElement("div");
meta.className = "meta";
const time = new Date(msg.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
meta.textContent = (msg.senderName || "未命名") + " · " + time;
const bubble = document.createElement("div");
bubble.className = "bubble";
bubble.textContent = msg.text || "";
wrap.appendChild(meta);
wrap.appendChild(bubble);
chatBox.appendChild(wrap);
}
function appendMessageIfNew(msg, source) {
if (!state.currentRoom || msg.roomId !== state.currentRoom.roomId) return false;
if (isDefaultPublicRoomId(msg.roomId) && !isDefaultRoomMessageActive(msg)) return false;
const id = getMessageKey(msg);
if (state.roomSeen.has(id)) return false;
state.roomSeen.add(id);
addMessageToCache(msg.roomId, msg);
renderMessage(msg);
chatBox.scrollTop = chatBox.scrollHeight;
if (state.currentRoom && state.currentRoom.roomId === msg.roomId) {
markRoomRead(msg.roomId);
}
if (source === "mqtt" && msg.senderId !== state.senderId) {
showToast("新消息1条");
playNotifySound("message");
}
return true;
}
async function openRoom(room, roomSecret, options = {}) {
showChat();
clearInterval(state.lobbyTimer);
clearInterval(state.timer);
state.currentRoom = {
roomId: room.roomId,
roomNo: getRoomNo(room),
roomName: room.roomName,
roomSecret,
noPassword: !!room.noPassword,
commentId: room.commentId || null,
adminMode: !!options.adminMode,
accessType: options.accessType || "room",
isDm: !!room.isDm,
isService: !!room.isService
};
roomInfoText.textContent = (room.roomName || getRoomNo(room)) + " · 建立者：" + (room.createdBy || "System");
roomTitleBtn.textContent = "【" + (room.roomName || getRoomNo(room)) + "】";
if (isDefaultPublicRoomId(room.roomId)) {
cleanupDefaultRoomLocalCache();
setTimeout(() => purgeExpiredDefaultRoomMessages(true), 300);
}
initSeenFromCache(room.roomId);
const cached = loadRoomCache(room.roomId);
renderAllMessages(cached);
markRoomEntered(room.roomId);
markRoomRead(room.roomId);
clearTypingIndicator();
subscribeRoomTopic(room.roomId);
try { publishPresence("online"); } catch (e) {}
historyTip.style.display = "inline";
historyTip.textContent = "正在检查历史记录...";
requestIdleCallbackSafe(async () => {
await syncRoomHistoryFromGist(room.roomId, roomSecret);
});
clearInterval(state.timer);
state.timer = setInterval(() => {
if (!state.mqtt.connected && state.currentRoom) {
syncRoomHistoryFromGist(state.currentRoom.roomId, state.currentRoom.roomSecret);
}
}, ROOM_FALLBACK_MS);
}
async function syncRoomHistoryFromGist(roomId, roomSecret) {
try {
const comments = await fetchAllComments();
const items = [];
for (const c of comments) {
if (typeof c.body !== "string" || !c.body.startsWith(MSG_PREFIX)) continue;
try {
const raw = c.body.slice(MSG_PREFIX.length);
const wrapper = JSON.parse(raw);
if (wrapper.roomId !== roomId) continue;
if (isDefaultPublicRoomId(roomId) && !isDefaultRoomMessageActive(wrapper)) {
setTimeout(() => deleteGistComment(c.id).catch(() => {}), 0);
continue;
}
items.push({ commentId: c.id, updatedAt: c.updated_at, wrapper });
} catch (e) {}
}
items.sort((a, b) => Number(a.commentId) - Number(b.commentId));
const lastId = localStorage.getItem(roomLastCommentKey(roomId));
let slice = items;
if (lastId) {
const idx = items.findIndex(item => String(item.commentId) === String(lastId));
if (idx >= 0) {
slice = items.slice(idx + 1);
}
}
if (slice.length > 0) {
historyTip.style.display = "inline";
historyTip.textContent = "发现历史记录 " + slice.length + " 条，加载中...";
}
let added = 0;
for (const item of slice) {
try {
const msg = await decryptPayload(item.wrapper.payload, roomSecret, "vx-room-msg:" + roomId);
if (appendMessageIfNew(msg, "gist")) added++;
} catch (e) {}
}
if (items.length) {
localStorage.setItem(roomLastCommentKey(roomId), String(items[items.length - 1].commentId));
}
if (state.currentRoom && state.currentRoom.roomId === roomId) {
markRoomRead(roomId);
}
if (added > 0) {
showToast("补充历史" + added + "条");
}
historyTip.style.display = "none";
historyTip.textContent = "";
} catch (e) {
historyTip.style.display = "none";
}
}
async function sendMessage() {
const text = messageInput.value.trim();
if (!text || !state.currentRoom) return;
if (!requireNickname()) return;
const msg = {
type: "message",
messageId: state.currentRoom.roomId + "_" + state.senderId + "_" + Date.now() + "_" + Math.random().toString(16).slice(2),
roomId: state.currentRoom.roomId,
senderId: state.senderId,
senderName: state.displayName,
text,
time: Date.now()
};
messageInput.value = "";
publishTyping(false);
appendMessageIfNew(msg, "local");
try {
const encrypted = await encryptPayload(msg, state.currentRoom.roomSecret, "vx-room-msg:" + state.currentRoom.roomId);
const wrapper = {
type: "message",
roomId: state.currentRoom.roomId,
messageId: msg.messageId,
payload: encrypted,
time: msg.time
};
mqttPublishJson(roomTopic(state.currentRoom.roomId), wrapper);
mqttPublishJson(roomsTopic(), {
type: "roomMessageNotice",
roomId: state.currentRoom.roomId,
messageId: msg.messageId,
senderId: state.senderId,
senderClientId: state.mqtt.clientId,
time: msg.time
});
enqueuePendingGist({
id: msg.messageId,
roomId: state.currentRoom.roomId,
body: MSG_PREFIX + JSON.stringify(wrapper),
time: msg.time,
attempts: 0
});
flushPendingGistMessages();
showToast("发送成功");
} catch (e) {
showToast("发送失败");
}
}
function getPendingGist() {
try {
const arr = JSON.parse(localStorage.getItem(pendingKey()) || "[]");
return Array.isArray(arr) ? arr : [];
} catch (e) {
return [];
}
}
function setPendingGist(arr) {
localStorage.setItem(pendingKey(), JSON.stringify(arr.slice(-300)));
}
function enqueuePendingGist(item) {
const arr = getPendingGist();
if (!arr.some(x => x.id === item.id)) {
arr.push(item);
setPendingGist(arr);
}
}
async function flushPendingGistMessages() {
if (!appConfig) return;
let arr = getPendingGist();
if (!arr.length) return;
const remain = [];
for (const item of arr) {
if (item && isDefaultPublicRoomId(item.roomId) && Number(item.time || 0) < getDefaultRoomCutoffTime()) {
continue;
}
try {
const res = await postGistComment(item.body);
localStorage.setItem(roomLastCommentKey(item.roomId), String(res.id));
} catch (e) {
item.attempts = (item.attempts || 0) + 1;
remain.push(item);
}
}
setPendingGist(remain);
}
function startGistRetryLoop() {
clearInterval(state.gistRetryTimer);
state.gistRetryTimer = setInterval(flushPendingGistMessages, GIST_RETRY_MS);
}
async function githubFetch(path, options = {}) {
const headers = {
"Accept": "application/vnd.github+json",
"Authorization": "Bearer " + appConfig.token,
"X-GitHub-Api-Version": "2022-11-28",
...(options.headers || {})
};
return fetch(API + path, { ...options, headers });
}
async function postGistComment(body) {
const res = await githubFetch(`/gists/${appConfig.gistId}/comments`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ body })
});
if (!res.ok) throw new Error("写入失败：" + res.status);
return res.json();
}
function parseLastPage(linkHeader) {
if (!linkHeader) return null;
const parts = linkHeader.split(",");
for (const part of parts) {
if (part.includes('rel="last"')) {
const match = part.match(/[?&]page=(\d+)/);
if (match) return Number(match[1]);
}
}
return null;
}
async function fetchCommentsPage(page) {
const res = await githubFetch(`/gists/${appConfig.gistId}/comments?per_page=100&page=${page}`);
if (!res.ok) throw new Error("读取失败：" + res.status);
return { data: await res.json(), link: res.headers.get("link") };
}
async function fetchAllComments() {
const first = await fetchCommentsPage(1);
const lastPage = parseLastPage(first.link);
let all = first.data;
if (lastPage && lastPage > 1) {
for (let p = 2; p <= lastPage; p++) {
const page = await fetchCommentsPage(p);
all = all.concat(page.data);
}
}
return all;
}
async function loadRooms(silent = false) {
if (!appConfig) return;
try {
const comments = await fetchAllComments();
const roomComments = comments.filter(c => typeof c.body === "string" && c.body.startsWith(ROOM_PREFIX));
const roomsHash = roomComments.map(c => c.id + ":" + c.updated_at).join("|");
if (roomsHash === state.lastRoomsHash && state.rooms.length) {
renderRooms();
if (state.adminMode) renderAdminRooms();
return;
}
state.lastRoomsHash = roomsHash;
const rooms = [{ ...DEFAULT_PUBLIC_ROOM }];
for (const c of roomComments) {
try {
const raw = c.body.slice(ROOM_PREFIX.length);
const payload = JSON.parse(raw);
const room = await decryptRoomMeta(payload);
if (room && room.type === "room" && room.roomId) {
room.commentId = c.id;
rooms.push(room);
}
} catch (e) {}
}
const defaultRoom = rooms.shift();
rooms.sort((a, b) => b.createdAt - a.createdAt);
state.rooms = [defaultRoom].concat(rooms);
renderRooms();
if (state.adminMode) renderAdminRooms();
} catch (e) {
if (!silent) showToast("房间加载失败");
}
}
function getVisibleRooms() {
const all = state.rooms || [];
if (state.adminMode) return all;
return all.filter(room => isRoomVisibleToCurrentAccount(room));
}
function isRoomVisibleToCurrentAccount(room) {
if (!room) return false;
if (isDefaultPublicRoomId(room.roomId)) return true;
if (hasStoredRoomAccess(room.roomId)) return true;
const profile = state.accountProfile || loadLocalAccountProfile();
if (!profile) return false;
const created = Array.isArray(profile.createdRooms) ? profile.createdRooms : [];
const joined = Array.isArray(profile.joinedRooms) ? profile.joinedRooms : [];
return created.includes(room.roomId) || joined.includes(room.roomId);
}
function renderRooms() {
roomList.innerHTML = "";
const rooms = getVisibleRooms();
rooms.forEach(room => {
const div = document.createElement("div");
div.className = "room-row";
div.onclick = () => openJoinModal(room.roomId);
const main = document.createElement("div");
main.className = "room-main";
const name = document.createElement("div");
name.className = "room-name";
name.textContent = "【" + (room.roomName || getRoomNo(room)) + "】";
const meta = document.createElement("div");
meta.className = "room-meta";
meta.style.display = "block";
meta.textContent = isDefaultPublicRoomId(room.roomId) ? "公共大厅" : ("房间号：" + getRoomNo(room));
const side = document.createElement("div");
side.className = "room-side";
const badge = document.createElement("div");
badge.className = "room-badge";
badge.textContent = room.noPassword ? "大厅" : getRoomNo(room);
side.appendChild(badge);
const unreadCount = getRoomUnreadCount(room.roomId);
if (unreadCount > 0) {
const unread = document.createElement("div");
unread.className = "room-unread";
unread.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
side.appendChild(unread);
}
main.appendChild(name);
main.appendChild(meta);
div.appendChild(main);
div.appendChild(side);
roomList.appendChild(div);
});
}
async function sha256Text(text) {
const encoder = new TextEncoder();
const data = encoder.encode(text);
const hashBuffer = await crypto.subtle.digest("SHA-256", data);
return Array.from(new Uint8Array(hashBuffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function checkAdminPassword(password) {
const hash = await sha256Text(password);
const adminHash = (appConfig && appConfig.adminHash) || ADMIN_PASSWORD_HASH;
return !!adminHash && hash === adminHash;
}
async function requireAdminPassword() {
const password = document.getElementById("adminPassword").value.trim();
if (!password) {
showToast("请输入管理密码");
return false;
}
const ok = await checkAdminPassword(password);
if (!ok) showToast("管理密码错误");
return ok;
}
async function deleteGistComment(commentId) {
const res = await githubFetch(`/gists/${appConfig.gistId}/comments/${commentId}`, { method: "DELETE" });
if (!res.ok && res.status !== 204) throw new Error("删除失败：" + res.status);
}
async function getCommentIdsForRoom(roomId, includeRoomMeta) {
const comments = await fetchAllComments();
const ids = [];
for (const c of comments) {
if (typeof c.body !== "string") continue;
if (includeRoomMeta && c.body.startsWith(ROOM_PREFIX)) {
try {
const raw = c.body.slice(ROOM_PREFIX.length);
const payload = JSON.parse(raw);
const room = await decryptRoomMeta(payload);
if (room.roomId === roomId) ids.push(c.id);
} catch (e) {}
}
if (c.body.startsWith(MSG_PREFIX)) {
try {
const raw = c.body.slice(MSG_PREFIX.length);
const wrapper = JSON.parse(raw);
if (wrapper.roomId === roomId) ids.push(c.id);
} catch (e) {}
}
}
return [...new Set(ids)];
}
async function clearCurrentRoomMessagesWithAdmin() {
const ok = await requireAdminPassword();
if (!ok || !state.currentRoom) return;
const confirmed = confirm("确定清空当前房间聊天记录吗？会删除该房间对应的 Gist 记录。");
if (!confirmed) return;
try {
showToast("正在清空...");
const ids = await getCommentIdsForRoom(state.currentRoom.roomId, false);
for (const id of ids) await deleteGistComment(id);
localStorage.removeItem(roomCacheKey(state.currentRoom.roomId));
localStorage.removeItem(roomLastCommentKey(state.currentRoom.roomId));
setLatestRoomCount(state.currentRoom.roomId, 0);
localStorage.setItem(roomLastReadCountKey(state.currentRoom.roomId), "0");
state.roomSeen = new Set();
chatBox.innerHTML = "";
mqttPublishJson(roomTopic(state.currentRoom.roomId), {
type: "roomCleared",
roomId: state.currentRoom.roomId,
time: Date.now()
});
closeAdminModal();
showToast("已清空");
} catch (e) {
showToast("清空失败");
}
}
async function deleteCurrentRoomWithAdmin() {
const ok = await requireAdminPassword();
if (!ok || !state.currentRoom) return;
if (state.currentRoom.noPassword) {
showToast("大厅不可删除");
return;
}
const confirmed = confirm("确定删除当前房间吗？会删除房间和该房间所有 Gist 聊天记录。");
if (!confirmed) return;
try {
showToast("正在删除...");
const roomId = state.currentRoom.roomId;
const ids = await getCommentIdsForRoom(roomId, true);
for (const id of ids) await deleteGistComment(id);
localStorage.removeItem(roomCacheKey(roomId));
localStorage.removeItem(roomLastCommentKey(roomId));
localStorage.removeItem(roomEnteredKey(roomId));
localStorage.removeItem(roomLatestCountKey(roomId));
localStorage.removeItem(roomLastReadCountKey(roomId));
mqttPublishJson(roomsTopic(), { type: "roomDeleted", roomId, time: Date.now() });
mqttPublishJson(roomsTopic(), { type: "roomsUpdate", time: Date.now() });
closeAdminModal();
showToast("房间已删除");
showLobby();
await loadRooms(false);
} catch (e) {
showToast("删除失败");
}
}
function encodeString(str) {
const encoder = new TextEncoder();
const bytes = encoder.encode(str);
return [bytes.length >> 8, bytes.length & 255, ...bytes];
}
function encodeLength(length) {
const encoded = [];
do {
let digit = length % 128;
length = Math.floor(length / 128);
if (length > 0) digit = digit | 128;
encoded.push(digit);
} while (length > 0);
return encoded;
}
function makePacket(type, body) {
return new Uint8Array([type, ...encodeLength(body.length), ...body]);
}
function mqttSendPacket(type, body) {
const ws = state.mqtt.ws;
if (!ws || ws.readyState !== WebSocket.OPEN) return false;
ws.send(makePacket(type, body));
return true;
}
function mqttSendConnect() {
const variableHeader = [...encodeString("MQTT"), 4, 0xC2, 0, 35];
const payload = [
...encodeString(state.mqtt.clientId),
...encodeString(MQTT_USERNAME),
...encodeString(MQTT_PASSWORD)
];
mqttSendPacket(0x10, [...variableHeader, ...payload]);
}
function mqttSubscribe(topic) {
const id = packetId++;
mqttSendPacket(0x82, [id >> 8, id & 255, ...encodeString(topic), 0]);
}
function mqttUnsubscribe(topic) {
if (!topic) return;
const id = packetId++;
mqttSendPacket(0xA2, [id >> 8, id & 255, ...encodeString(topic)]);
}
function mqttPing() {
mqttSendPacket(0xC0, []);
}
function mqttPublishJson(topic, obj) {
if (!state.mqtt.connected) return false;
const payload = new TextEncoder().encode(JSON.stringify(obj));
mqttSendPacket(0x30, [...encodeString(topic), ...payload]);
return true;
}
function parseRemainingLength(bytes, index) {
let multiplier = 1;
let value = 0;
let encodedByte;
let pos = index;
do {
encodedByte = bytes[pos++];
value += (encodedByte & 127) * multiplier;
multiplier *= 128;
} while ((encodedByte & 128) !== 0);
return { value, nextIndex: pos };
}
function decodeString(bytes, index) {
const len = (bytes[index] << 8) + bytes[index + 1];
const start = index + 2;
const end = start + len;
return { value: new TextDecoder().decode(bytes.slice(start, end)), nextIndex: end };
}
function roomsTopic() {
return MQTT_PREFIX + "/rooms/update";
}
function presenceTopic() {
return MQTT_PREFIX + "/presence/all";
}
function roomTopic(roomId) {
return MQTT_PREFIX + "/room/" + roomId + "/live";
}
function connectMQTT() {
if (state.mqtt.ws && state.mqtt.ws.readyState === WebSocket.OPEN) return;
clearTimeout(state.mqtt.reconnectTimer);
clearInterval(state.mqtt.pingTimer);
setDataStatus("connecting");
try {
const ws = new WebSocket(MQTT_WS_URL, "mqtt");
ws.binaryType = "arraybuffer";
state.mqtt.ws = ws;
ws.onopen = () => {
mqttSendConnect();
};
ws.onmessage = (event) => {
handleMQTTPacket(event.data);
};
ws.onerror = () => {
state.mqtt.connected = false;
setDataStatus("disconnected");
};
ws.onclose = () => {
state.mqtt.connected = false;
setDataStatus("disconnected");
clearInterval(state.mqtt.pingTimer);
state.mqtt.reconnectTimer = setTimeout(connectMQTT, 3000);
};
} catch (e) {
state.mqtt.connected = false;
setDataStatus("disconnected");
state.mqtt.reconnectTimer = setTimeout(connectMQTT, 3000);
}
}
function disconnectMQTT() {
clearTimeout(state.mqtt.reconnectTimer);
clearInterval(state.mqtt.pingTimer);
clearInterval(state.mqtt.presenceTimer);
publishPresence("offline");
try {
if (state.mqtt.ws) state.mqtt.ws.close();
} catch (e) {}
state.mqtt.ws = null;
state.mqtt.connected = false;
state.mqtt.activeTopic = null;
delete state.onlineClients[state.mqtt.clientId];
setDataStatus("disconnected");
}
function publishPresence(status = "online") {
if (!state.mqtt.connected && status === "online") return;
const payload = {
type: "presence",
status,
clientId: state.mqtt.clientId,
senderId: state.senderId,
senderName: state.displayName || "未命名",
roomId: state.currentRoom ? state.currentRoom.roomId : "",
isAdmin: !!state.adminMode,
time: Date.now()
};
mqttPublishJson(presenceTopic(), payload);
if (status === "online") {
state.onlineClients[state.mqtt.clientId] = payload;
recordDailyOnlineClient(payload);
} else {
delete state.onlineClients[state.mqtt.clientId];
}
renderAdminOnlineStats();
setDataStatus(state.mqtt.connected ? "connected" : "disconnected");
}
function startPresenceHeartbeat() {
clearInterval(state.mqtt.presenceTimer);
publishPresence("online");
state.mqtt.presenceTimer = setInterval(() => {
pruneOnlineClients();
publishPresence("online");
setDataStatus(state.mqtt.connected ? "connected" : "disconnected");
}, PRESENCE_HEARTBEAT_MS);
}
function handlePresence(obj) {
if (!obj || obj.type !== "presence" || !obj.clientId) return;
if (obj.status === "offline") {
delete state.onlineClients[obj.clientId];
} else {
state.onlineClients[obj.clientId] = {
clientId: obj.clientId,
senderId: obj.senderId || "",
senderName: obj.senderName || "未命名",
roomId: obj.roomId || "",
isAdmin: !!obj.isAdmin,
time: Number(obj.time || Date.now())
};
recordDailyOnlineClient(state.onlineClients[obj.clientId]);
}
renderAdminOnlineStats();
setDataStatus(state.mqtt.connected ? "connected" : "disconnected");
}
function publishTyping(isTyping) {
if (!state.currentRoom || !state.mqtt.connected) return;
mqttPublishJson(roomTopic(state.currentRoom.roomId), {
type: "typing",
roomId: state.currentRoom.roomId,
senderId: state.senderId,
senderName: state.displayName || "未命名",
isTyping: !!isTyping,
time: Date.now()
});
}
function clearTypingIndicator() {
state.typingUsers = {};
if (typingTip) {
typingTip.textContent = "";
typingTip.classList.remove("show");
}
}
function renderTypingIndicator() {
if (!typingTip) return;
const now = Date.now();
const names = Object.keys(state.typingUsers || {})
.map(id => state.typingUsers[id])
.filter(item => item && now - Number(item.time || 0) < 3000)
.map(item => item.senderName || "有人");
Object.keys(state.typingUsers || {}).forEach(id => {
const item = state.typingUsers[id];
if (!item || now - Number(item.time || 0) >= 3000) delete state.typingUsers[id];
});
if (!names.length) {
typingTip.textContent = "";
typingTip.classList.remove("show");
return;
}
const unique = [...new Set(names)].slice(0, 2);
typingTip.textContent = unique.join("、") + " 正在输入...";
typingTip.classList.add("show");
}
function handleTyping(obj) {
if (!state.currentRoom || !obj || obj.roomId !== state.currentRoom.roomId) return;
if (obj.senderId === state.senderId) return;
if (obj.isTyping) {
state.typingUsers[obj.senderId || obj.senderName || "unknown"] = {
senderName: obj.senderName || "有人",
time: Date.now()
};
} else if (obj.senderId) {
delete state.typingUsers[obj.senderId];
}
renderTypingIndicator();
clearTimeout(handleTyping._timer);
handleTyping._timer = setTimeout(renderTypingIndicator, 3200);
}
function notifyTypingInput() {
if (!state.currentRoom || !hasNickname()) return;
clearTimeout(state.typingPublishTimer);
publishTyping(true);
state.typingPublishTimer = setTimeout(() => publishTyping(false), TYPING_STOP_MS);
}
function handleMQTTPacket(arrayBuffer) {
const bytes = new Uint8Array(arrayBuffer);
const type = bytes[0] >> 4;
const rem = parseRemainingLength(bytes, 1);
let index = rem.nextIndex;
if (type === 2) {
const returnCode = bytes[index + 1];
if (returnCode === 0) {
state.mqtt.connected = true;
setDataStatus("connected");
mqttSubscribe(roomsTopic());
mqttSubscribe(presenceTopic());
startPresenceHeartbeat();
clearInterval(state.mqtt.pingTimer);
state.mqtt.pingTimer = setInterval(mqttPing, 15000);
if (state.currentRoom) subscribeRoomTopic(state.currentRoom.roomId);
} else {
state.mqtt.connected = false;
setDataStatus("disconnected");
}
return;
}
if (type === 3) {
const topicInfo = decodeString(bytes, index);
const topic = topicInfo.value;
index = topicInfo.nextIndex;
const message = new TextDecoder().decode(bytes.slice(index));
try {
const obj = JSON.parse(message);
handleMQTTMessage(topic, obj);
} catch (e) {}
return;
}
if (type === 13) {
setDataStatus("connected");
}
}
function subscribeRoomTopic(roomId) {
const topic = roomTopic(roomId);
if (state.mqtt.activeTopic === topic) return;
if (state.mqtt.activeTopic) mqttUnsubscribe(state.mqtt.activeTopic);
state.mqtt.activeTopic = topic;
if (state.mqtt.connected) mqttSubscribe(topic);
}
function unsubscribeActiveRoomTopic() {
if (state.mqtt.activeTopic && state.mqtt.connected) {
mqttUnsubscribe(state.mqtt.activeTopic);
}
state.mqtt.activeTopic = null;
}
async function handleMQTTMessage(topic, obj) {
if (topic === presenceTopic()) {
handlePresence(obj);
return;
}
if (topic === roomsTopic()) {
if (obj.type === "roomCreated" && obj.room) {
upsertRoomRealtime(obj.room);
requestIdleCallbackSafe(() => loadRooms(true));
} else if (obj.type === "roomDeleted" && obj.roomId) {
removeRoomRealtime(obj.roomId);
requestIdleCallbackSafe(() => loadRooms(true));
} else if (obj.type === "roomMessageNotice" && obj.roomId) {
if (obj.senderClientId === state.mqtt.clientId) return;
if (state.currentRoom && state.currentRoom.roomId === obj.roomId) {
markRoomRead(obj.roomId);
return;
}
if (hasEnteredRoom(obj.roomId)) {
incrementRoomLatest(obj.roomId);
renderRooms();
playNotifySound("room");
}
} else if (obj.type === "roomsUpdate") {
loadRooms(true);
}
return;
}
if (!state.currentRoom) return;
if (topic !== roomTopic(state.currentRoom.roomId)) return;
if (obj.type === "typing") {
handleTyping(obj);
return;
}
if ((obj.type === "roomCleared" || obj.type === "defaultRoomExpiredPurged") && obj.roomId === state.currentRoom.roomId) {
localStorage.removeItem(roomCacheKey(obj.roomId));
localStorage.removeItem(roomLastCommentKey(obj.roomId));
setLatestRoomCount(obj.roomId, 0);
localStorage.setItem(roomLastReadCountKey(obj.roomId), "0");
updateUnreadBadge();
state.roomSeen = new Set();
chatBox.innerHTML = "";
clearTypingIndicator();
showToast("当前房间已清空");
return;
}
if (obj.type === "message" && obj.roomId === state.currentRoom.roomId && obj.payload) {
try {
const msg = await decryptPayload(obj.payload, state.currentRoom.roomSecret, "vx-room-msg:" + obj.roomId);
appendMessageIfNew(msg, "mqtt");
} catch (e) {}
}
}
function requestIdleCallbackSafe(callback) {
if (typeof window.requestIdleCallback === "function") {
return window.requestIdleCallback(callback, { timeout: 1200 });
}
return setTimeout(callback, 0);
}
function setDataStatus(status) {
pruneOnlineClients(false);
dataStatus.classList.remove("connected", "connecting");
if (status === "connected") {
dataStatus.classList.add("connected");
setStatusBaseText("数据已连接");
} else if (status === "connecting") {
dataStatus.classList.add("connecting");
setStatusBaseText("连接中...");
} else {
setStatusBaseText("数据已断开");
}
}
function getTodayKey() {
const d = new Date();
return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function dailyOnlineStorageKey() {
return "vx_daily_online_users_" + getTodayKey();
}
function recordDailyOnlineClient(item) {
if (!item || item.isAdmin) return;
const id = item.senderId || item.clientId;
if (!id) return;
try {
const key = dailyOnlineStorageKey();
const arr = JSON.parse(localStorage.getItem(key) || "[]");
const list = Array.isArray(arr) ? arr : [];
if (!list.includes(id)) {
list.push(id);
localStorage.setItem(key, JSON.stringify(list.slice(-1000)));
}
} catch (e) {}
}
function getDailyOnlineCount() {
try {
const arr = JSON.parse(localStorage.getItem(dailyOnlineStorageKey()) || "[]");
return Array.isArray(arr) ? arr.length : 0;
} catch (e) {
return 0;
}
}
function formatDateTimeForAdmin(value) {
if (!value) return "未知";
const d = new Date(value);
if (Number.isNaN(d.getTime())) return String(value);
return d.getFullYear() + "-" +
String(d.getMonth() + 1).padStart(2, "0") + "-" +
String(d.getDate()).padStart(2, "0") + " " +
String(d.getHours()).padStart(2, "0") + ":" +
String(d.getMinutes()).padStart(2, "0");
}
function getConfigUpdatedAtText() {
const bundle = remoteConfigBundleCache || {};
return formatDateTimeForAdmin(bundle.updatedAt || bundle.savedAt || bundle.configUpdatedAt || bundle.generatedAt || "");
}
function renderAdminVersionInfo() {
const text = "当前版本：" + APP_VERSION + " · 配置更新时间：" + getConfigUpdatedAtText();
if (adminVersionInfo) adminVersionInfo.textContent = text;
if (adminVersionFooter) adminVersionFooter.textContent = text;
}
function renderAdminOnlineStats() {
if (!adminOnlineStats) return;
const now = Date.now();
const currentOnline = Object.values(state.onlineClients || {}).filter(item => item && !item.isAdmin && now - Number(item.time || 0) <= PRESENCE_TTL_MS).length;
adminOnlineStats.textContent = "今日在线人数：" + getDailyOnlineCount() + " · 当前在线：" + currentOnline;
renderAdminVersionInfo();
}
function getCurrentRoomOnlineCount() {
if (!state.currentRoom || state.adminMode) return null;
pruneOnlineClients(false);
const roomId = state.currentRoom.roomId;
const now = Date.now();
let count = Object.values(state.onlineClients || {}).filter(item => item && !item.isAdmin && item.roomId === roomId && now - Number(item.time || 0) <= PRESENCE_TTL_MS).length;
return Math.max(1, count);
}
function pruneOnlineClients(updateText = true) {
const now = Date.now();
const clients = state.onlineClients || {};
Object.keys(clients).forEach(id => {
const item = clients[id];
if (!item || now - Number(item.time || 0) > PRESENCE_TTL_MS) delete clients[id];
});
if (updateText) {
renderAdminOnlineStats();
setDataStatus(state.mqtt.connected ? "connected" : "disconnected");
}
return Object.keys(clients).length;
}
function sanitizeRoomForRealtime(room) {
return {
type: "room",
roomId: room.roomId,
roomNo: room.roomNo || getRoomNo(room),
roomName: room.roomName,
createdBy: room.createdBy,
createdAt: room.createdAt || Date.now(),
noPassword: !!room.noPassword,
check: room.check || null,
adminSecret: room.adminSecret || null,
commentId: room.commentId || null,
version: room.version || 3
};
}
function upsertRoomRealtime(room) {
if (!room || !room.roomId) return;
const safeRoom = sanitizeRoomForRealtime(room);
const idx = state.rooms.findIndex(r => r.roomId === safeRoom.roomId);
if (idx >= 0) {
state.rooms[idx] = { ...state.rooms[idx], ...safeRoom };
} else {
const defaultRoom = state.rooms.find(r => isDefaultPublicRoomId(r.roomId)) || { ...DEFAULT_PUBLIC_ROOM };
const others = state.rooms.filter(r => !isDefaultPublicRoomId(r.roomId));
others.unshift(safeRoom);
others.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
state.rooms = [defaultRoom].concat(others);
}
renderRooms();
updateUnreadBadge();
}
function removeRoomRealtime(roomId) {
if (!roomId || isDefaultPublicRoomId(roomId)) return;
state.rooms = state.rooms.filter(room => room.roomId !== roomId);
localStorage.removeItem(roomCacheKey(roomId));
localStorage.removeItem(roomLastCommentKey(roomId));
localStorage.removeItem(roomEnteredKey(roomId));
localStorage.removeItem(roomLatestCountKey(roomId));
localStorage.removeItem(roomLastReadCountKey(roomId));
if (state.currentRoom && state.currentRoom.roomId === roomId) {
showLobby();
} else {
renderRooms();
updateUnreadBadge();
}
}
function normalizeEmail(email) {
return String(email || "").trim().toLowerCase();
}
function maskEmail(email) {
const e = normalizeEmail(email);
const parts = e.split("@");
if (parts.length !== 2) return e ? e.slice(0, 2) + "****" : "";
const name = parts[0];
return (name.slice(0, 2) || "**") + "****@" + parts[1];
}
function normalizeSafeCode(code) {
return String(code || "").replace(/\D/g, "").slice(0, 6);
}
function accountLocalKey() {
return "vx_account_profile_v1";
}
function loadLocalAccountProfile() {
try {
const raw = localStorage.getItem(accountLocalKey());
if (!raw) return null;
const profile = JSON.parse(raw);
if (!profile || !profile.accountId || !profile.nicknameNumber) return null;
state.accountProfile = profile;
return profile;
} catch (e) {
return null;
}
}
function saveLocalAccountProfile(profile) {
if (!profile) return;
profile.updatedAt = Date.now();
state.accountProfile = profile;
state.displayName = String(profile.nicknameNumber || "");
localStorage.setItem(accountLocalKey(), JSON.stringify(profile));
localStorage.setItem("vx_display_name", state.displayName);
if (nicknameLine) nicknameLine.textContent = "当前账号：" + state.displayName;
}
function getRecoveryPassword(email, safeCode) {
return normalizeEmail(email) + "::" + normalizeSafeCode(safeCode);
}
function generateNicknameNumber() {
return String(Math.floor(1000000 + Math.random() * 9000000));
}
async function createAccountProfileRemote(profile, email, safeCode) {
try {
const payload = await encryptPayload(profile, getRecoveryPassword(email, safeCode), "vx-account-profile-v1");
await postGistComment(ACCOUNT_PREFIX + JSON.stringify(payload));
} catch (e) {
console.warn("account profile save failed", e);
}
}
async function updateAccountProfileRemoteQuiet() {
const profile = state.accountProfile;
const email = localStorage.getItem("vx_account_email_plain") || "";
const safe = localStorage.getItem("vx_account_safe_plain") || "";
if (!profile || !email || !safe) return;
await createAccountProfileRemote(profile, email, safe);
}
function showAutoAccountPane() {
document.getElementById("autoAccountPane").style.display = "block";
document.getElementById("recoverAccountPane").style.display = "none";
}
function showRecoverAccountPane() {
document.getElementById("autoAccountPane").style.display = "none";
document.getElementById("recoverAccountPane").style.display = "block";
}
function openAccountModal() {
openModal("accountModal");
showAutoAccountPane();
}
function closeAccountModal() {
closeModal("accountModal");
}
async function createAutoAccount() {
const email = normalizeEmail(document.getElementById("autoEmailInput").value);
const safe = normalizeSafeCode(document.getElementById("autoSafeCodeInput").value);
if (!email || !email.includes("@")) return showToast("请输入正确邮箱");
if (!/^\d{1,6}$/.test(safe)) return showToast("安全码需1-6位数字");
const profile = {
accountId: crypto.randomUUID(),
nicknameNumber: generateNicknameNumber(),
emailMasked: maskEmail(email),
createdRooms: [],
joinedRooms: [],
createdAt: Date.now(),
updatedAt: Date.now()
};
localStorage.setItem("vx_account_email_plain", email);
localStorage.setItem("vx_account_safe_plain", safe);
saveLocalAccountProfile(profile);
await createAccountProfileRemote(profile, email, safe);
closeAccountModal();
showToast("账号已分配：" + profile.nicknameNumber);
renderRooms();
}
async function recoverAccount() {
const email = normalizeEmail(document.getElementById("recoverEmailInput").value);
const safe = normalizeSafeCode(document.getElementById("recoverSafeCodeInput").value);
if (!email || !email.includes("@")) return showToast("请输入正确邮箱");
if (!/^\d{1,6}$/.test(safe)) return showToast("安全码需1-6位数字");
try {
const comments = await fetchAllComments();
const items = comments.filter(c => typeof c.body === "string" && c.body.startsWith(ACCOUNT_PREFIX));
let recovered = null;
for (const c of items) {
try {
const payload = JSON.parse(c.body.slice(ACCOUNT_PREFIX.length));
const profile = await decryptPayload(payload, getRecoveryPassword(email, safe), "vx-account-profile-v1");
if (profile && profile.accountId && profile.nicknameNumber) recovered = profile;
} catch (e) {}
}
if (!recovered) {
showToast("找回失败");
return;
}
localStorage.setItem("vx_account_email_plain", email);
localStorage.setItem("vx_account_safe_plain", safe);
saveLocalAccountProfile(recovered);
closeAccountModal();
showToast("账号已恢复：" + recovered.nicknameNumber);
await loadRooms(false);
} catch (e) {
showToast("找回失败");
}
}
function roomSecretKey(roomId) {
return "vx_room_secret_v5_" + roomId;
}
function hasStoredRoomAccess(roomId) {
return !!localStorage.getItem(roomSecretKey(roomId));
}
function getStoredRoomSecret(roomId) {
return localStorage.getItem(roomSecretKey(roomId)) || "";
}
function rememberRoomAccess(room, roomSecret, type = "joined") {
if (!room || !room.roomId || !roomSecret) return;
localStorage.setItem(roomSecretKey(room.roomId), roomSecret);
const profile = state.accountProfile || loadLocalAccountProfile();
if (!profile) return;
const key = type === "created" ? "createdRooms" : "joinedRooms";
profile.createdRooms = Array.isArray(profile.createdRooms) ? profile.createdRooms : [];
profile.joinedRooms = Array.isArray(profile.joinedRooms) ? profile.joinedRooms : [];
if (!profile[key].includes(room.roomId)) profile[key].push(room.roomId);
saveLocalAccountProfile(profile);
updateAccountProfileRemoteQuiet();
}
function formatClockTime() {
const d = new Date();
return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function getStatusExtraText() {
const roomOnline = getCurrentRoomOnlineCount();
if (roomOnline === null) return "";
return " · 在线" + roomOnline;
}
function withClock(text) {
return text + " · " + formatClockTime() + getStatusExtraText();
}
function updateClockLabel() {
if (!dataStatusText) return;
const raw = dataStatusText.dataset.baseText || "数据已断开";
dataStatusText.textContent = withClock(raw);
renderAdminOnlineStats();
}
function setStatusBaseText(text) {
dataStatusText.dataset.baseText = text;
dataStatusText.textContent = withClock(text);
}
async function encryptConfigObjectForLocal(configObject, unlockCode) {
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await deriveKey(unlockCode, salt);
const plaintext = new TextEncoder().encode(JSON.stringify(configObject));
const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
return { salt: toBase64(salt), iv: toBase64(iv), data: toBase64(encrypted) };
}
async function saveLocalUnlockCode() {
const input = document.getElementById("localUnlockCodeInput");
const code = normalizeSafeCode(input && input.value);
if (!/^\d{1,6}$/.test(code)) return showToast("请输入1-6位数字");
if (!appConfig) return showToast("配置未加载");
try {
const encrypted = await encryptConfigObjectForLocal(appConfig, code);
localStorage.setItem("vx_custom_encrypted_config", JSON.stringify(encrypted));
closeSettingsModal();
showToast("本机暗语已保存，系统默认暗语仍然有效");
} catch (e) {
showToast("保存失败");
}
}
async function fetchAnnouncement() {
try {
const comments = await fetchAllComments();
const items = comments.filter(c => typeof c.body === "string" && c.body.startsWith(ANNOUNCE_PREFIX));
let latest = null;
for (const c of items) {
try {
const data = JSON.parse(c.body.slice(ANNOUNCE_PREFIX.length));
data.commentId = c.id;
data.updatedAtRaw = c.updated_at;
if (!latest || new Date(c.updated_at).getTime() > new Date(latest.updatedAtRaw || 0).getTime()) latest = data;
} catch (e) {}
}
state.announcement = latest;
return latest;
} catch (e) {
return state.announcement || null;
}
}
async function openAnnouncementModal() {
const ann = await fetchAnnouncement();
const titleEl = document.getElementById("announcementModalTitle");
const contentEl = document.getElementById("announcementModalContent");
if (ann && ann.enabled !== false && String(ann.content || "").trim()) {
titleEl.textContent = ann.title || "系统公告";
contentEl.textContent = String(ann.content || "").trim();
} else {
titleEl.textContent = "公告";
contentEl.textContent = "暂无公告，谢谢使用。";
}
openModal("announcementModal");
}
function closeAnnouncementModal() {
closeModal("announcementModal");
}
async function saveAnnouncementFromAdmin() {
const title = String(document.getElementById("announcementTitleInput").value || "系统公告").trim() || "系统公告";
const content = String(document.getElementById("announcementContentInput").value || "").trim();
const enabled = !!document.getElementById("announcementEnabledInput").checked;
const ann = { type: "announcement", enabled, title, content, updatedAt: Date.now(), updatedBy: state.displayName || "admin" };
try {
const comments = await fetchAllComments();
const old = comments.filter(c => typeof c.body === "string" && c.body.startsWith(ANNOUNCE_PREFIX));
for (const c of old) {
try { await deleteGistComment(c.id); } catch (e) {}
}
await postGistComment(ANNOUNCE_PREFIX + JSON.stringify(ann));
state.announcement = ann;
document.getElementById("announcementAdminTip").textContent = "公告已保存";
showToast("公告已保存");
} catch (e) {
showToast("公告保存失败");
}
}
async function handleLobbySearch() {
const input = document.getElementById("roomSearchInput");
const value = String(input && input.value || "").trim();
if (!value) return;
if (/^[A-Za-z0-9]{6}$/.test(value)) {
await loadRooms(true);
const code = value.toUpperCase();
const room = (state.rooms || []).find(r => String(getRoomNo(r) || "").toUpperCase() === code);
if (!room) return showToast("未找到房间");
openJoinModal(room.roomId);
return;
}
const ok = await checkAdminPassword(value);
if (ok) {
input.value = "";
await openAdminPage();
} else {
showToast("未找到房间");
}
}
async function openAdminPage() {
state.adminMode = true;
state.currentRoom = null;
clearInterval(state.timer);
unsubscribeActiveRoomTopic();
clearTypingIndicator();
await loadRooms(false);
lobbyScreen.style.display = "none";
chatShell.style.display = "none";
adminScreen.style.display = "block";
sendArea.style.display = "none";
emergencyBar.style.display = "none";
if (announcementBtn) announcementBtn.style.display = "none";
roomBackBtn.style.display = "inline-flex";
roomBackBtn.textContent = "返回";
roomTitleBtn.style.display = "inline-flex";
roomTitleBtn.textContent = "【管理后台】";
lobbyActions.style.display = "none";
roomActions.style.display = "none";
const ann = await fetchAnnouncement();
document.getElementById("announcementTitleInput").value = (ann && ann.title) || "系统公告";
document.getElementById("announcementContentInput").value = (ann && ann.content) || "";
document.getElementById("announcementEnabledInput").checked = !ann || ann.enabled !== false;
try { publishPresence("online"); } catch (e) {}
renderAdminOnlineStats();
renderAdminVersionInfo();
renderAdminRooms();
}
function renderAdminRooms() {
if (!adminRoomList) return;
adminRoomList.innerHTML = "";
const rooms = (state.rooms || []).filter(r => !isDefaultPublicRoomId(r.roomId));
if (!rooms.length) {
adminRoomList.innerHTML = '<div class="admin-small">暂无房间</div>';
return;
}
rooms.forEach(room => {
const row = document.createElement("div");
row.className = "admin-row";
const name = document.createElement("div");
name.className = "admin-room-name";
name.textContent = room.roomName || getRoomNo(room);
const meta = document.createElement("div");
meta.className = "admin-room-meta";
meta.textContent = "房间号：" + getRoomNo(room) + "\n创建者：" + (room.ownerNicknameNumber || room.createdBy || "未知") + "\n创建时间：" + (room.createdAt ? new Date(room.createdAt).toLocaleString() : "未知");
const actions = document.createElement("div");
actions.className = "admin-actions";
const enter = document.createElement("button");
enter.className = "mini-btn";
enter.textContent = "免密进入";
enter.onclick = () => adminEnterRoom(room.roomId);
const clear = document.createElement("button");
clear.className = "mini-btn danger";
clear.textContent = "清空记录";
clear.onclick = () => adminClearRoomMessages(room.roomId);
const del = document.createElement("button");
del.className = "mini-btn danger";
del.textContent = "删除房间";
del.onclick = () => adminDeleteRoom(room.roomId);
actions.appendChild(enter); actions.appendChild(clear); actions.appendChild(del);
row.appendChild(name); row.appendChild(meta); row.appendChild(actions);
adminRoomList.appendChild(row);
});
}
async function adminEnterRoom(roomId) {
const room = (state.rooms || []).find(r => r.roomId === roomId);
if (!room) return showToast("房间不存在");
try {
const secret = await decryptAdminRoomSecret(room);
if (!secret) return showToast("无法进入");
rememberRoomAccess(room, secret, "joined");
openRoom(room, secret, { accessType: "admin", adminMode: true });
} catch (e) {
showToast("无法进入");
}
}
async function adminClearRoomMessages(roomId) {
const room = (state.rooms || []).find(r => r.roomId === roomId);
if (!room) return;
const roomNo = getRoomNo(room);
if (!confirm("确定清空房间 " + roomNo + " 的聊天记录？")) return;
if (!confirm("请再次确认：清空后不可恢复。")) return;
try {
const ids = await getCommentIdsForRoom(roomId, false);
for (const id of ids) await deleteGistComment(id);
localStorage.removeItem(roomCacheKey(roomId));
localStorage.removeItem(roomLastCommentKey(roomId));
setLatestRoomCount(roomId, 0);
mqttPublishJson(roomTopic(roomId), { type: "roomCleared", roomId, time: Date.now() });
showToast("已清空");
} catch (e) {
showToast("清空失败");
}
}
async function adminDeleteRoom(roomId) {
const room = (state.rooms || []).find(r => r.roomId === roomId);
if (!room) return;
const roomNo = getRoomNo(room);
if (!confirm("确定删除房间 " + roomNo + "？此操作不可恢复。")) return;
const typed = prompt("二次确认：请输入房间号 " + roomNo + " 才能删除");
if (String(typed || "").trim().toUpperCase() !== String(roomNo).toUpperCase()) {
showToast("已取消删除");
return;
}
try {
const ids = await getCommentIdsForRoom(roomId, true);
for (const id of ids) await deleteGistComment(id);
localStorage.removeItem(roomCacheKey(roomId));
localStorage.removeItem(roomLastCommentKey(roomId));
localStorage.removeItem(roomSecretKey(roomId));
state.rooms = (state.rooms || []).filter(r => r.roomId !== roomId);
mqttPublishJson(roomsTopic(), { type: "roomDeleted", roomId, time: Date.now() });
renderAdminRooms();
renderRooms();
showToast("房间已删除");
} catch (e) {
showToast("删除失败");
}
}
function hasNickname() {
return !!String(state.displayName || "").trim();
}
function requireNickname() {
if (getSelfProfile()) return true;
showToast("请先到我的创建账号");
try { switchMainTab("mine"); } catch (e) {}
return false;
}
function validateRoomName(roomName) {
return true;
}
function isDuplicateRoomName(roomName) {
return false;
}
function openModal(id) {
const modal = document.getElementById(id);
if (modal) modal.style.display = "flex";
}
function closeModal(id) {
const modal = document.getElementById(id);
if (modal) modal.style.display = "none";
}
function openSettingsModal() {
const input = document.getElementById("localUnlockCodeInput");
const tip = document.getElementById("currentAccountTip");
if (tip) tip.textContent = "当前账号：" + (state.displayName || "未初始化");
if (input) {
input.value = "";
setTimeout(() => input.focus(), 80);
}
openModal("settingsModal");
}
function closeSettingsModal() {
closeModal("settingsModal");
}
function saveName() {
saveLocalUnlockCode();
}
function openCreateRoomModal() {
if (!requireNickname()) return;
const passInput = document.getElementById("newRoomPassword");
if (passInput) passInput.value = "";
openModal("createRoomModal");
setTimeout(() => passInput && passInput.focus(), 80);
}
function closeCreateRoomModal() {
closeModal("createRoomModal");
}
function openJoinModal(roomId) {
const room = (state.rooms || []).find(item => item.roomId === roomId);
if (!room) return;
if (room.noPassword || isDefaultPublicRoomId(room.roomId)) {
openRoom(room, getDefaultRoomPassword(), { accessType: "public" });
return;
}
const storedSecret = getStoredRoomSecret(room.roomId);
if (storedSecret) {
openRoom(room, storedSecret, { accessType: "saved" });
return;
}
pendingRoom = room;
const input = document.getElementById("joinRoomPassword");
if (input) {
input.value = "";
setTimeout(() => input.focus(), 80);
}
openModal("joinModal");
}
function closeJoinModal() {
closeModal("joinModal");
pendingRoom = null;
}
function openAdminModal() {
const input = document.getElementById("adminPassword");
if (input) {
input.value = "";
setTimeout(() => input.focus(), 80);
}
openModal("adminModal");
}
function closeAdminModal() {
closeModal("adminModal");
}
function showLobby() {
state.currentRoom = null;
state.adminMode = false;
clearInterval(state.timer);
unsubscribeActiveRoomTopic();
clearTypingIndicator();
chatShell.style.display = "none";
adminScreen.style.display = "none";
lobbyScreen.style.display = "block";
sendArea.style.display = "none";
emergencyBar.style.display = "none";
if (announcementBtn) announcementBtn.style.display = "inline-flex";
roomBackBtn.style.display = "none";
roomTitleBtn.style.display = "none";
lobbyActions.style.display = "flex";
roomActions.style.display = "none";
if (nicknameLine) nicknameLine.textContent = state.displayName ? "当前账号：" + state.displayName : "";
try { publishPresence("online"); } catch (e) {}
renderRooms();
updateUnreadBadge();
clearInterval(state.lobbyTimer);
state.lobbyTimer = setInterval(() => loadRooms(true), LOBBY_FALLBACK_MS);
}
function showChat() {
lobbyScreen.style.display = "none";
adminScreen.style.display = "none";
chatShell.style.display = "flex";
sendArea.style.display = "flex";
emergencyBar.style.display = "block";
if (announcementBtn) announcementBtn.style.display = "none";
roomBackBtn.style.display = "inline-flex";
roomBackBtn.textContent = "返回";
roomTitleBtn.style.display = "inline-flex";
lobbyActions.style.display = "none";
roomActions.style.display = "flex";
updateAppHeight();
setTimeout(() => {
updateAppHeight();
chatBox.scrollTop = chatBox.scrollHeight;
}, 80);
}
async function backToLobby() {
try { publishTyping(false); } catch (e) {}
showLobby();
await loadRooms(true);
}
async function openApp() {
calculator.style.display = "none";
chatApp.style.display = "flex";
state.accountProfile = loadLocalAccountProfile();
state.displayName = (state.accountProfile && state.accountProfile.nicknameNumber) || localStorage.getItem("vx_display_name") || state.displayName || "";
if (nicknameLine) nicknameLine.textContent = state.displayName ? "当前账号：" + state.displayName : "";
resetSecretMode();
calcExpression = "";
unlockInput = "";
isFakeResult = false;
showLobby();
initNotifyAudio();
connectMQTT();
startGistRetryLoop();
flushPendingGistMessages();
await loadRooms(false);
fetchAnnouncement();
updateUnreadBadge();
updateClockLabel();
if (!window.__vxClockTimer) window.__vxClockTimer = setInterval(updateClockLabel, 30000);
}
function emergencyClose() {
try {
publishTyping(false);
publishPresence("offline");
unsubscribeActiveRoomTopic();
} catch (e) {}
state.currentRoom = null;
clearInterval(state.timer);
clearInterval(state.lobbyTimer);
clearTypingIndicator();
chatApp.style.display = "none";
calculator.style.display = "flex";
emergencyBar.style.display = "none";
if (adminScreen) adminScreen.style.display = "none";
calcExpression = "";
resetSecretMode();
isFakeResult = false;
updateDisplay();
}
function hasUnsentMessageDraft() {
return !!(messageInput && String(messageInput.value || "").trim());
}
function isAutoUpdateSafeNow() {
if (state.currentRoom) return false;
if (state.adminMode) return false;
if (hasUnsentMessageDraft()) return false;
if (messageInput && document.activeElement === messageInput) return false;
return true;
}
function deferAutoUpdate(onlineVersion) {
try {
localStorage.setItem("vx_pending_update_version", onlineVersion || "pending");
} catch (e) {}
if (!window.__vxDeferredUpdateNoticeShown) {
window.__vxDeferredUpdateNoticeShown = true;
showToast("检测到新版本，空闲时自动更新", 1800);
}
if (window.__vxDeferredUpdateTimer) return;
window.__vxDeferredUpdateTimer = setInterval(() => {
if (isAutoUpdateSafeNow()) {
clearInterval(window.__vxDeferredUpdateTimer);
window.__vxDeferredUpdateTimer = null;
triggerHardReload();
}
}, 15000);
}
function maybeApplyDeferredAutoUpdate() {
let pending = "";
try { pending = localStorage.getItem("vx_pending_update_version") || ""; } catch (e) {}
if (!pending) return;
if (isAutoUpdateSafeNow()) {
try { localStorage.removeItem("vx_pending_update_version"); } catch (e) {}
setTimeout(triggerHardReload, 1200);
} else {
deferAutoUpdate(pending);
}
}
function extractAppVersionFromHtml(html) {
const match = String(html || "").match(/const\s+APP_VERSION\s*=\s*["']([^"']+)["']/);
return match ? match[1] : "";
}
async function checkForNewAppVersion() {
try {
const sep = location.pathname.includes("?") ? "&" : "?";
const res = await fetch(location.pathname + sep + "auto_update_check=" + Date.now(), { cache: "no-store" });
if (!res.ok) return;
const html = await res.text();
const onlineVersion = extractAppVersionFromHtml(html);
if (onlineVersion && onlineVersion !== APP_VERSION) {
if (isAutoUpdateSafeNow()) {
triggerHardReload();
} else {
deferAutoUpdate(onlineVersion);
}
}
} catch (e) {}
}
function scheduleDailyAutoUpdateCheck() {
try {
const key = "vx_auto_update_checked_date";
const today = getTodayKey();
if (localStorage.getItem(key) === today) return;
localStorage.setItem(key, today);
setTimeout(checkForNewAppVersion, 60 * 1000);
} catch (e) {
setTimeout(checkForNewAppVersion, 60 * 1000);
}
}
function manualUpdateApp() {
showToast("正在拉取最新页面...", 900);
try {
localStorage.setItem("vx_manual_update_requested_at", String(Date.now()));
} catch (e) {}
setTimeout(() => {
triggerHardReload();
}, 450);
}
messageInput.addEventListener("focus", function() {
updateAppHeight();
setTimeout(function() {
updateAppHeight();
chatBox.scrollTop = chatBox.scrollHeight;
}, 80);
setTimeout(function() {
updateAppHeight();
chatBox.scrollTop = chatBox.scrollHeight;
}, 280);
});
messageInput.addEventListener("blur", function() {
setTimeout(updateAppHeight, 120);
});
messageInput.addEventListener("keydown", function(e) {
if (e.key === "Enter") sendMessage();
});
(function(){
const localUnlockInput = document.getElementById("localUnlockCodeInput");
if (localUnlockInput) localUnlockInput.addEventListener("keydown", function(e) {
if (e.key === "Enter") saveLocalUnlockCode();
});
const searchInput = document.getElementById("roomSearchInput");
if (searchInput) searchInput.addEventListener("keydown", function(e) {
if (e.key === "Enter") handleLobbySearch();
});
})();
document.getElementById("joinRoomPassword").addEventListener("keydown", function(e) {
if (e.key === "Enter") confirmJoinRoom();
});
document.getElementById("adminPassword").addEventListener("keydown", function(e) {
if (e.key === "Enter") clearCurrentRoomMessagesWithAdmin();
});
window.addEventListener("beforeunload", () => {
try {
publishPresence("offline");
publishTyping(false);
} catch (e) {}
});
window.addEventListener("online", () => {
if (appConfig) {
connectMQTT();
flushPendingGistMessages();
}
});
document.addEventListener("visibilitychange", () => {
if (!document.hidden && appConfig) {
connectMQTT();
flushPendingGistMessages();
if (isDefaultPublicRoomId(DEFAULT_PUBLIC_ROOM.roomId)) cleanupDefaultRoomLocalCache();
if (state.currentRoom && isDefaultPublicRoomId(state.currentRoom.roomId)) setTimeout(() => purgeExpiredDefaultRoomMessages(true), 300);
if (state.currentRoom) syncRoomHistoryFromGist(state.currentRoom.roomId, state.currentRoom.roomSecret);
else loadRooms(true);
}
});
function registerAndroidPWAServiceWorker() {
if (!("serviceWorker" in navigator)) return;
const run = function() {
navigator.serviceWorker.register("/vx/service-worker.js?v=tech-config-fixed-20260510", {
scope: "/vx/"
}).then(function(reg) {
if (reg && reg.update) reg.update();
}).catch(function(err) {
console.log("Service Worker 注册失败", err);
});
};
if (document.readyState === "complete") run();
else window.addEventListener("load", run, { once: true });
}
const USER_PREFIX = "VX_PUBLIC_ACCOUNT_V1:";
const FRIEND_PREFIX = "VX_FRIEND_REQUEST_V1:";
const DM_PREFIX = "dm_";
const friendsScreen = document.getElementById("friendsScreen");
const announcementScreen = document.getElementById("announcementScreen");
const mineScreen = document.getElementById("mineScreen");
const bottomNav = document.getElementById("bottomNav");
const roomContextBtn = document.getElementById("roomContextBtn");
function profileNickname(profile) {
return String((profile && profile.nickname) || "").trim();
}
function profileNumber(profile) {
return String((profile && profile.nicknameNumber) || "").trim();
}
function formatAccountName(profile, withNumber = true) {
const nick = profileNickname(profile);
const num = profileNumber(profile);
if (nick && num && withNumber) return nick + "（" + num + "）";
if (nick) return nick;
return num || "未初始化";
}
function getSelfProfile() {
return state.accountProfile || loadLocalAccountProfile();
}
function getSelfDisplayName(withNumber = false) {
return formatAccountName(getSelfProfile(), withNumber);
}
function getSelfSenderName() {
return formatAccountName(getSelfProfile(), false);
}
const oldSaveLocalAccountProfile = saveLocalAccountProfile;
saveLocalAccountProfile = function(profile) {
if (!profile) return;
profile.nickname = String(profile.nickname || "").trim();
profile.friends = Array.isArray(profile.friends) ? profile.friends : [];
profile.dmConversations = Array.isArray(profile.dmConversations) ? profile.dmConversations : [];
profile.updatedAt = Date.now();
state.accountProfile = profile;
state.displayName = formatAccountName(profile, false);
localStorage.setItem(accountLocalKey(), JSON.stringify(profile));
localStorage.setItem("vx_display_name", state.displayName);
if (nicknameLine) nicknameLine.textContent = state.displayName ? "当前账号：" + state.displayName : "";
try { publishPresence("online"); } catch (e) {}
};
function friendLocalKey() {
const p = getSelfProfile();
return "vx_friends_v1_" + (p && p.accountId ? p.accountId : "guest");
}
function loadLocalFriends() {
try {
const arr = JSON.parse(localStorage.getItem(friendLocalKey()) || "[]");
return Array.isArray(arr) ? arr : [];
} catch (e) { return []; }
}
function saveLocalFriends(list) {
const uniq = [];
const seen = new Set();
(Array.isArray(list) ? list : []).forEach(f => {
if (!f || !f.accountId) return;
if (seen.has(f.accountId)) return;
seen.add(f.accountId);
uniq.push(f);
});
localStorage.setItem(friendLocalKey(), JSON.stringify(uniq));
const profile = getSelfProfile();
if (profile) {
profile.friends = uniq.map(f => f.accountId);
profile.dmConversations = uniq.map(f => getDmRoomId(profile.accountId, f.accountId));
saveLocalAccountProfile(profile);
updateAccountProfileRemoteQuiet();
}
}
function addLocalFriend(friend) {
if (!friend || !friend.accountId) return;
const list = loadLocalFriends();
const idx = list.findIndex(f => f.accountId === friend.accountId);
if (idx >= 0) list[idx] = { ...list[idx], ...friend, updatedAt: Date.now() };
else list.push({ ...friend, addedAt: Date.now(), updatedAt: Date.now() });
saveLocalFriends(list);
}
function getDmRoomId(a, b) {
const ids = [String(a || ""), String(b || "")].sort();
return DM_PREFIX + ids.join("_");
}
function getDmSecret(a, b) {
const ids = [String(a || ""), String(b || "")].sort();
return String(appConfig && appConfig.chatSecret || "") + "::dm::" + ids.join("::");
}
function makeDmRoom(friend) {
const me = getSelfProfile();
const roomId = getDmRoomId(me.accountId, friend.accountId);
return {
type: "dm",
roomId,
roomNo: friend.nicknameNumber || friend.accountId,
roomName: formatAccountName(friend, false),
friend,
noPassword: true,
isDm: true,
createdAt: friend.addedAt || Date.now()
};
}
async function publishPublicProfileQuiet() {
const p = getSelfProfile();
if (!appConfig || !p || !p.accountId || !p.nicknameNumber) return;
try {
const publicProfile = {
type: "publicProfile",
accountId: p.accountId,
nicknameNumber: p.nicknameNumber,
nickname: String(p.nickname || "").trim(),
emailMasked: p.emailMasked || "",
updatedAt: Date.now()
};
await postGistComment(USER_PREFIX + JSON.stringify(publicProfile));
} catch (e) { console.warn("public profile save failed", e); }
}
async function fetchPublicProfiles() {
const comments = await fetchAllComments();
const map = {};
comments.forEach(c => {
if (typeof c.body !== "string" || !c.body.startsWith(USER_PREFIX)) return;
try {
const p = JSON.parse(c.body.slice(USER_PREFIX.length));
if (!p || !p.accountId || !p.nicknameNumber) return;
const old = map[p.accountId];
if (!old || Number(p.updatedAt || 0) >= Number(old.updatedAt || 0)) map[p.accountId] = p;
} catch (e) {}
});
return Object.values(map);
}
async function findPublicProfileByNumber(number) {
const num = String(number || "").trim();
const all = await fetchPublicProfiles();
return all.find(p => String(p.nicknameNumber) === num) || null;
}
async function fetchFriendRequests() {
const me = getSelfProfile();
if (!me) return { incoming: [], outgoing: [], accepted: [] };
const comments = await fetchAllComments();
const latest = {};
comments.forEach(c => {
if (typeof c.body !== "string" || !c.body.startsWith(FRIEND_PREFIX)) return;
try {
const r = JSON.parse(c.body.slice(FRIEND_PREFIX.length));
if (!r || !r.requestId) return;
const old = latest[r.requestId];
if (!old || Number(r.updatedAt || r.createdAt || 0) >= Number(old.updatedAt || old.createdAt || 0)) latest[r.requestId] = r;
} catch (e) {}
});
const arr = Object.values(latest);
const incoming = arr.filter(r => r.status === "pending" && r.toAccountId === me.accountId);
const outgoing = arr.filter(r => r.status === "pending" && r.fromAccountId === me.accountId);
const accepted = arr.filter(r => r.status === "accepted" && (r.fromAccountId === me.accountId || r.toAccountId === me.accountId));
return { incoming, outgoing, accepted };
}
async function syncAcceptedFriendsQuiet() {
const me = getSelfProfile();
if (!me || !appConfig) return;
try {
const reqs = await fetchFriendRequests();
reqs.accepted.forEach(r => {
const other = r.fromAccountId === me.accountId
? { accountId: r.toAccountId, nicknameNumber: r.toNumber, nickname: r.toNickname || "" }
: { accountId: r.fromAccountId, nicknameNumber: r.fromNumber, nickname: r.fromNickname || "" };
addLocalFriend(other);
});
} catch (e) {}
}
async function sendFriendRequestToNumber(number) {
const me = getSelfProfile();
if (!me) return showToast("请先初始化账号");
const num = String(number || "").trim();
if (!/^\d{7}$/.test(num)) return showToast("请输入7位好友编号");
if (num === me.nicknameNumber) return showToast("不能添加自己");
const target = await findPublicProfileByNumber(num);
if (!target) return showToast("未找到用户");
const request = {
type: "friendRequest",
requestId: crypto.randomUUID(),
status: "pending",
fromAccountId: me.accountId,
fromNumber: me.nicknameNumber,
fromNickname: profileNickname(me),
toAccountId: target.accountId,
toNumber: target.nicknameNumber,
toNickname: profileNickname(target),
createdAt: Date.now(),
updatedAt: Date.now()
};
await postGistComment(FRIEND_PREFIX + JSON.stringify(request));
showToast("好友申请已发送");
closeAddFriendModal();
renderFriendsPage();
}
async function acceptFriendRequest(requestId) {
const reqs = await fetchFriendRequests();
const req = reqs.incoming.find(r => r.requestId === requestId);
if (!req) return showToast("申请不存在");
const accepted = { ...req, status: "accepted", updatedAt: Date.now() };
await postGistComment(FRIEND_PREFIX + JSON.stringify(accepted));
addLocalFriend({ accountId: req.fromAccountId, nicknameNumber: req.fromNumber, nickname: req.fromNickname || "", addedAt: Date.now() });
showToast("已添加好友");
renderFriendsPage();
renderRooms();
}
async function rejectFriendRequest(requestId) {
const reqs = await fetchFriendRequests();
const req = reqs.incoming.find(r => r.requestId === requestId);
if (!req) return;
await postGistComment(FRIEND_PREFIX + JSON.stringify({ ...req, status: "rejected", updatedAt: Date.now() }));
showToast("已拒绝");
renderFriendsPage();
}
function openAddFriendModal() {
if (!requireNickname()) return;
const input = document.getElementById("addFriendNumberInput");
if (input) input.value = "";
openModal("addFriendModal");
setTimeout(() => input && input.focus(), 80);
}
function closeAddFriendModal() { closeModal("addFriendModal"); }
async function sendFriendRequestFromModal() {
const input = document.getElementById("addFriendNumberInput");
await sendFriendRequestToNumber(input && input.value);
}
function getConversationLastTime(roomId, fallback = 0) {
const cached = loadRoomCache(roomId);
if (cached.length) return Math.max(...cached.map(m => Number(m.time || 0)));
return Number(fallback || 0);
}
function getRoomDisplayTitle(room) {
if (!room) return "群｜未知房间";
if (room.isDm) return "私｜" + formatAccountName(room.friend, true);
const title = String(room.roomName || "").trim() || ((room.ownerNickname || room.ownerNicknameNumber || room.createdBy || getRoomNo(room)) + "的房间");
return "群｜" + title;
}
function buildConversationItems() {
const rooms = getVisibleRooms().filter(room => !isDefaultPublicRoomId(room.roomId));
const groupItems = rooms.map(room => ({
kind: "group",
room,
title: getRoomDisplayTitle(room),
meta: "房间号：" + getRoomNo(room),
lastTime: getConversationLastTime(room.roomId, room.createdAt),
unread: getRoomUnreadCount(room.roomId)
}));
const friendItems = loadLocalFriends().map(friend => {
const room = makeDmRoom(friend);
return {
kind: "dm",
room,
friend,
title: "私｜" + formatAccountName(friend, true),
meta: "好友编号：" + friend.nicknameNumber,
lastTime: getConversationLastTime(room.roomId, friend.addedAt),
unread: getRoomUnreadCount(room.roomId)
};
});
return groupItems.concat(friendItems).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
}
renderRooms = function() {
roomList.innerHTML = "";
if (!getSelfProfile()) {
roomList.innerHTML = '<div class="empty-tip">账号未初始化<br/>请前往「我的」创建账号或找回账号。</div>';
return;
}
const items = buildConversationItems();
if (!items.length) {
roomList.innerHTML = '<div class="empty-tip">暂无聊天<br/>点击右上角 ＋ 添加好友，或搜索房间号加入群聊。</div>';
return;
}
const privateItems = items.filter(i => i.kind === "dm");
const groupItems = items.filter(i => i.kind === "group");
function renderSection(label, arr) {
if (!arr.length) return;
const h = document.createElement("div");
h.className = "section-label";
h.textContent = label;
roomList.appendChild(h);
arr.forEach(item => {
const div = document.createElement("div");
div.className = "room-row";
div.onclick = () => item.kind === "dm" ? openDmConversation(item.friend) : openJoinModal(item.room.roomId);
const main = document.createElement("div");
main.className = "room-main";
const name = document.createElement("div");
name.className = "room-name";
name.textContent = item.title;
const meta = document.createElement("div");
meta.className = "room-meta";
meta.style.display = "block";
const t = item.lastTime ? new Date(item.lastTime).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "无消息";
meta.textContent = item.meta + " · " + t;
main.appendChild(name);
main.appendChild(meta);
const side = document.createElement("div");
side.className = "room-side";
const badge = document.createElement("div");
badge.className = "room-badge";
badge.textContent = item.kind === "dm" ? "私" : getRoomNo(item.room);
side.appendChild(badge);
if (item.unread > 0) {
const unread = document.createElement("div");
unread.className = "room-unread";
unread.textContent = item.unread > 99 ? "99+" : String(item.unread);
side.appendChild(unread);
}
div.appendChild(main);
div.appendChild(side);
roomList.appendChild(div);
});
}
renderSection("私聊", privateItems);
renderSection("群聊", groupItems);
};
async function openDmConversation(friend) {
if (!requireNickname()) return;
const me = getSelfProfile();
if (!me || !friend) return;
addLocalFriend(friend);
const room = makeDmRoom(friend);
const secret = getDmSecret(me.accountId, friend.accountId);
openRoom(room, secret, { accessType: "friend", isDm: true });
}
async function renderFriendsPage() {
const reqBox = document.getElementById("friendRequestList");
const listBox = document.getElementById("friendList");
if (!reqBox || !listBox) return;
if (!getSelfProfile()) {
reqBox.innerHTML = '<div class="empty-tip">账号未初始化<br/>请先到「我的」创建账号或找回账号。</div>';
listBox.innerHTML = '';
return;
}
reqBox.innerHTML = '<div class="empty-tip">正在加载好友申请...</div>';
listBox.innerHTML = "";
await syncAcceptedFriendsQuiet();
try {
const reqs = await fetchFriendRequests();
reqBox.innerHTML = "";
if (!reqs.incoming.length && !reqs.outgoing.length) {
reqBox.innerHTML = '<div class="empty-tip">暂无好友申请</div>';
} else {
reqs.incoming.forEach(r => {
const row = document.createElement("div");
row.className = "friend-row";
row.innerHTML = '<div class="friend-name">' + (r.fromNickname ? r.fromNickname + '（' + r.fromNumber + '）' : r.fromNumber) + '</div><div class="friend-meta">请求添加你为好友</div>';
const actions = document.createElement("div");
actions.className = "row-actions";
const ok = document.createElement("button"); ok.className = "mini-btn"; ok.textContent = "同意"; ok.onclick = () => acceptFriendRequest(r.requestId);
const no = document.createElement("button"); no.className = "mini-btn danger"; no.textContent = "拒绝"; no.onclick = () => rejectFriendRequest(r.requestId);
actions.appendChild(ok); actions.appendChild(no); row.appendChild(actions); reqBox.appendChild(row);
});
reqs.outgoing.forEach(r => {
const row = document.createElement("div");
row.className = "friend-row";
row.innerHTML = '<div class="friend-name">' + (r.toNickname ? r.toNickname + '（' + r.toNumber + '）' : r.toNumber) + '</div><div class="friend-meta">等待对方确认</div>';
reqBox.appendChild(row);
});
}
} catch (e) {
reqBox.innerHTML = '<div class="empty-tip">好友申请加载失败</div>';
}
const friends = loadLocalFriends();
listBox.innerHTML = "";
if (!friends.length) {
listBox.innerHTML = '<div class="empty-tip">暂无好友<br/>点击右上角 ＋ 添加好友。</div>';
} else {
friends.forEach(f => {
const row = document.createElement("div");
row.className = "friend-row";
row.onclick = () => openDmConversation(f);
row.innerHTML = '<div class="friend-name">' + formatAccountName(f, true) + '</div><div class="friend-meta">点击进入私聊</div>';
listBox.appendChild(row);
});
}
}
async function renderAnnouncementPage() {
const ann = await fetchAnnouncement();
const titleEl = document.getElementById("announcementPageTitle");
const contentEl = document.getElementById("announcementPageContent");
if (ann && ann.enabled !== false && String(ann.content || "").trim()) {
titleEl.textContent = ann.title || "公告";
contentEl.textContent = String(ann.content || "").trim() + (ann.updatedAt ? "\n\n更新时间：" + new Date(ann.updatedAt).toLocaleString() : "");
} else {
titleEl.textContent = "公告";
contentEl.textContent = "暂无公告，谢谢使用。";
}
}
function renderMinePage() {
const box = document.getElementById("mineContent");
if (!box) return;
const p = getSelfProfile();
if (!p) {
box.innerHTML = `
<div class="mine-card"><div class="mine-title">账号未初始化</div><div class="mine-line">请先创建账号或找回账号，完成后才能添加好友、新建房间和恢复聊天记录。</div><div class="mine-line">当前版本：${APP_VERSION}</div><div class="mine-line">配置更新时间：${getConfigUpdatedAtText()}</div><div class="mine-actions"><button class="confirm-btn mini-btn" onclick="openAccountModal()">创建账号 / 找回账号</button><button class="confirm-btn mini-btn" onclick="manualUpdateApp()">手动更新</button></div></div>`;
return;
}
const localSet = !!localStorage.getItem("vx_custom_encrypted_config");
box.innerHTML = `
<div class="mine-card"><div class="mine-title">我的信息</div><div class="mine-line">我的编号：${p.nicknameNumber || "--"}</div><div class="mine-line">我的昵称：${profileNickname(p) || "未设置昵称"}</div><div class="mine-line">我的邮箱：${p.emailMasked || "--"}</div><div class="mine-line">安全码：已设置</div><div class="mine-line">系统默认暗语：仍然有效</div><div class="mine-line">本机暗语：${localSet ? "已设置" : "未设置"}</div><div class="mine-line">当前版本：${APP_VERSION}</div><div class="mine-line">配置更新时间：${getConfigUpdatedAtText()}</div><div class="mine-actions"><button class="confirm-btn mini-btn" onclick="openEditNicknameModal()">修改昵称</button><button class="confirm-btn mini-btn" onclick="openSettingsModal()">修改本机暗语</button><button class="confirm-btn mini-btn" onclick="openEditSafeCodeModal()">修改安全码</button><button class="confirm-btn mini-btn" onclick="manualUpdateApp()">手动更新</button></div></div>`;
}
function updateMainTabHeaderAction(tab) {
if (!lobbyActions) return;
if (tab === "lobby") {
lobbyActions.style.display = "flex";
lobbyActions.innerHTML = '<button class="header-btn" onclick="openCreateRoomModal()">新建房间</button>';
return;
}
if (tab === "friends") {
lobbyActions.style.display = "flex";
lobbyActions.innerHTML = '<button class="header-btn" onclick="openAddFriendModal()">加好友</button>';
return;
}
lobbyActions.innerHTML = "";
lobbyActions.style.display = "none";
}
function switchMainTab(tab) {
if (state.currentRoom || state.adminMode) return;
const tabs = { lobby: lobbyScreen, friends: friendsScreen, announcement: announcementScreen, mine: mineScreen };
Object.keys(tabs).forEach(k => {
if (tabs[k]) tabs[k].style.display = k === tab ? "block" : "none";
const btn = document.getElementById("nav" + k.charAt(0).toUpperCase() + k.slice(1));
if (btn) btn.classList.toggle("active", k === tab);
});
localStorage.setItem("vx_active_tab", tab);
updateMainTabHeaderAction(tab);
if (tab === "lobby") renderRooms();
if (tab === "friends") renderFriendsPage();
if (tab === "announcement") renderAnnouncementPage();
if (tab === "mine") renderMinePage();
}
function openEditNicknameModal() {
const p = getSelfProfile();
const input = document.getElementById("nicknameEditInput");
if (input) input.value = p && p.nickname ? p.nickname : "";
openModal("editNicknameModal");
}
function closeEditNicknameModal() { closeModal("editNicknameModal"); }
async function saveNicknameEdit() {
const p = getSelfProfile();
if (!p) return showToast("账号未初始化");
const input = document.getElementById("nicknameEditInput");
p.nickname = String(input && input.value || "").trim().slice(0, 12);
saveLocalAccountProfile(p);
await updateAccountProfileRemoteQuiet();
await publishPublicProfileQuiet();
closeEditNicknameModal();
showToast("昵称已保存");
renderMinePage();
renderRooms();
}
function openEditSafeCodeModal() {
["oldSafeCodeInput","newSafeCodeInput","newSafeCodeConfirmInput"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
openModal("editSafeCodeModal");
}
function closeEditSafeCodeModal() { closeModal("editSafeCodeModal"); }
async function saveSafeCodeEdit() {
const oldCode = normalizeSafeCode(document.getElementById("oldSafeCodeInput").value);
const newCode = normalizeSafeCode(document.getElementById("newSafeCodeInput").value);
const confirmCode = normalizeSafeCode(document.getElementById("newSafeCodeConfirmInput").value);
const saved = localStorage.getItem("vx_account_safe_plain") || "";
const email = localStorage.getItem("vx_account_email_plain") || "";
if (!saved || !email) return showToast("当前设备缺少找回信息");
if (oldCode !== saved) return showToast("当前安全码不正确");
if (!/^\d{1,6}$/.test(newCode)) return showToast("新安全码需1-6位数字");
if (newCode !== confirmCode) return showToast("两次新安全码不一致");
localStorage.setItem("vx_account_safe_plain", newCode);
await updateAccountProfileRemoteQuiet();
closeEditSafeCodeModal();
showToast("安全码已修改");
}
const oldCreateAutoAccount = createAutoAccount;
createAutoAccount = async function() {
await oldCreateAutoAccount();
await publishPublicProfileQuiet();
renderMinePage();
renderRooms();
try { switchMainTab("mine"); } catch (e) {}
};
const oldRecoverAccount = recoverAccount;
recoverAccount = async function() {
await oldRecoverAccount();
await publishPublicProfileQuiet();
renderMinePage();
renderRooms();
try { switchMainTab("mine"); } catch (e) {}
};
createRoom = async function() {
if (!requireNickname()) return;
const roomPassword = document.getElementById("newRoomPassword").value.trim();
if (roomPassword.length < 4) return showToast("密码至少4位");
await loadRooms(false);
try {
const roomId = crypto.randomUUID();
const roomSecret = makeRoomSecret();
let roomNo = generateRoomNo();
const used = new Set((state.rooms || []).map(r => String(r.roomNo || "").toUpperCase()));
let guard = 0;
while (used.has(roomNo) && guard < 50) { roomNo = generateRoomNo(); guard++; }
const self = getSelfProfile();
const ownerDisplay = getSelfDisplayName(false);
const roomName = ownerDisplay + "的房间";
const check = await encryptPayload({ ok: true, roomId, roomSecret }, roomPassword, "vx-room-check:" + roomId);
const adminSecret = await encryptAdminRoomSecret(roomId, roomSecret);
const meta = {
type: "room", roomId, roomNo, roomName,
createdBy: ownerDisplay,
ownerAccountId: self && self.accountId,
ownerNicknameNumber: self && self.nicknameNumber,
ownerNickname: self && self.nickname || "",
createdAt: Date.now(), noPassword: false, check, adminSecret, version: 5
};
const encryptedMeta = await encryptRoomMeta(meta);
const comment = await postGistComment(ROOM_PREFIX + JSON.stringify(encryptedMeta));
meta.commentId = comment.id;
rememberRoomAccess(meta, roomSecret, "created");
closeCreateRoomModal();
await loadRooms(false);
mqttPublishJson(roomsTopic(), { type: "roomCreated", room: sanitizeRoomForRealtime(meta), senderId: state.senderId, time: Date.now() });
mqttPublishJson(roomsTopic(), { type: "roomsUpdate", time: Date.now() });
showToast("房间已创建：" + roomNo);
openRoom(meta, roomSecret, { accessType: "owner" });
} catch (e) { showToast("创建失败"); console.error(e); }
};
const oldSendMessage = sendMessage;
sendMessage = async function() {
const old = state.displayName;
state.displayName = getSelfSenderName();
try { await oldSendMessage(); }
finally { state.displayName = getSelfSenderName(); renderRooms(); }
};
const oldRenderMessage = renderMessage;
renderMessage = function(msg) {
const id = getMessageKey(msg);
const isMe = msg.senderId === state.senderId;
const wrap = document.createElement("div");
wrap.className = "msg-wrap " + (isMe ? "me" : "other");
wrap.dataset.messageId = id;
const meta = document.createElement("div");
meta.className = "meta";
const time = new Date(msg.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
meta.textContent = (msg.senderName || "未命名") + " · " + time;
const bubble = document.createElement("div");
bubble.className = "bubble";
bubble.textContent = msg.text || "";
wrap.appendChild(meta); wrap.appendChild(bubble); chatBox.appendChild(wrap);
};
function getCurrentChatContextText() {
if (!state.currentRoom) return "--";
if (state.currentRoom.isDm) return formatAccountName(state.currentRoom.friend, false);
return state.currentRoom.roomName || getRoomNo(state.currentRoom);
}
const oldOpenRoom = openRoom;
openRoom = async function(room, roomSecret, options = {}) {
await oldOpenRoom(room, roomSecret, options);
if (options && options.isDm && state.currentRoom) {
state.currentRoom.isDm = true;
state.currentRoom.friend = room.friend;
}
markRoomEntered(room.roomId);
if (roomSecret) localStorage.setItem(roomSecretKey(room.roomId), roomSecret);
if (roomContextBtn) roomContextBtn.textContent = getCurrentChatContextText();
renderRooms();
};
function openCurrentChatInfo() {
if (!state.currentRoom) return;
const title = document.getElementById("chatInfoTitle");
const content = document.getElementById("chatInfoContent");
const input = document.getElementById("roomNameEditInput");
const save = document.getElementById("saveRoomNameBtn");
if (state.currentRoom.isDm) {
title.textContent = "好友信息";
content.textContent = "好友：" + formatAccountName(state.currentRoom.friend, true);
input.style.display = "none"; save.style.display = "none";
} else {
title.textContent = "群信息";
content.textContent = "房间号：" + getRoomNo(state.currentRoom) + "\n群名称：" + (state.currentRoom.roomName || "未命名");
const me = getSelfProfile();
const canEdit = me && state.currentRoom.ownerAccountId && me.accountId === state.currentRoom.ownerAccountId;
input.style.display = canEdit ? "block" : "none";
save.style.display = canEdit ? "block" : "none";
input.value = state.currentRoom.roomName || "";
}
openModal("chatInfoModal");
}
function closeChatInfoModal() { closeModal("chatInfoModal"); }
async function saveCurrentRoomName() {
if (!state.currentRoom || state.currentRoom.isDm) return;
const me = getSelfProfile();
if (!me || me.accountId !== state.currentRoom.ownerAccountId) return showToast("只有建立者可以修改群名称");
const input = document.getElementById("roomNameEditInput");
const newName = String(input && input.value || "").trim().slice(0, 24);
if (!newName) return showToast("请输入群名称");
try {
const oldId = state.currentRoom.commentId;
const room = (state.rooms || []).find(r => r.roomId === state.currentRoom.roomId) || state.currentRoom;
room.roomName = newName;
room.ownerNickname = me.nickname || "";
const encryptedMeta = await encryptRoomMeta(room);
if (oldId) { try { await deleteGistComment(oldId); } catch (e) {} }
const c = await postGistComment(ROOM_PREFIX + JSON.stringify(encryptedMeta));
room.commentId = c.id;
state.currentRoom.roomName = newName;
closeChatInfoModal();
if (roomContextBtn) roomContextBtn.textContent = getCurrentChatContextText();
mqttPublishJson(roomsTopic(), { type: "roomsUpdate", time: Date.now() });
await loadRooms(false);
showToast("群名称已修改");
} catch (e) { showToast("修改失败"); }
}
handleLobbySearch = async function() {
const input = document.getElementById("roomSearchInput");
const value = String(input && input.value || "").trim();
if (!value) return;
const adminOk = await checkAdminPassword(value);
if (adminOk) { input.value = ""; await openAdminPage(); return; }
if (/^[A-Za-z0-9]{6}$/.test(value)) {
await loadRooms(true);
const code = value.toUpperCase();
const room = (state.rooms || []).find(r => String(getRoomNo(r) || "").toUpperCase() === code);
if (!room) return showToast("未找到房间");
openJoinModal(room.roomId); return;
}
if (/^\d{7}$/.test(value)) {
try {
const user = await findPublicProfileByNumber(value);
if (!user) return showToast("未找到用户");
await sendFriendRequestToNumber(value);
} catch (e) { showToast("未找到用户"); }
return;
}
const items = buildConversationItems().filter(item => item.title.includes(value) || item.meta.includes(value));
if (items.length === 1) {
const item = items[0];
item.kind === "dm" ? openDmConversation(item.friend) : openJoinModal(item.room.roomId);
} else if (items.length > 1) {
roomList.innerHTML = "";
items.forEach(item => {
const row = document.createElement("div"); row.className = "room-row";
row.onclick = () => item.kind === "dm" ? openDmConversation(item.friend) : openJoinModal(item.room.roomId);
row.innerHTML = '<div class="room-main"><div class="room-name">' + item.title + '</div><div class="room-meta" style="display:block">' + item.meta + '</div></div>';
roomList.appendChild(row);
});
} else showToast("未找到");
};
formatClockTime = function() {
const d = new Date();
return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
};
getStatusExtraText = function() {
const roomOnline = getCurrentRoomOnlineCount();
if (roomOnline === null) return "";
return " 在线" + roomOnline;
};
withClock = function(text) { return "数据 " + formatClockTime() + getStatusExtraText(); };
setDataStatus = function(status) {
pruneOnlineClients(false);
dataStatus.classList.remove("connected", "connecting");
if (status === "connected") dataStatus.classList.add("connected");
dataStatusText.dataset.baseText = "数据";
dataStatusText.textContent = withClock("数据");
renderAdminOnlineStats();
};
function showDataStatusMini() { showToast(dataStatus.classList.contains("connected") ? "数据正常" : "数据异常"); }
function startRuntimeClock() {
updateClockLabel();
if (!window.__vxClockSecondTimer) {
window.__vxClockSecondTimer = setInterval(updateClockLabel, 1000);
}
}
const oldShowLobby = showLobby;
showLobby = function() {
state.currentRoom = null;
state.adminMode = false;
clearInterval(state.timer);
unsubscribeActiveRoomTopic();
clearTypingIndicator();
chatShell.style.display = "none";
adminScreen.style.display = "none";
if (friendsScreen) friendsScreen.style.display = "none";
if (announcementScreen) announcementScreen.style.display = "none";
if (mineScreen) mineScreen.style.display = "none";
sendArea.style.display = "none";
emergencyBar.style.display = "none";
if (announcementBtn) announcementBtn.style.display = "none";
roomBackBtn.style.display = "none";
roomTitleBtn.style.display = "none";
lobbyActions.style.display = "flex";
roomActions.style.display = "none";
if (bottomNav) bottomNav.classList.add("show");
try { publishPresence("online"); } catch (e) {}
const tab = localStorage.getItem("vx_active_tab") || "lobby";
switchMainTab(tab);
updateUnreadBadge();
clearInterval(state.lobbyTimer);
state.lobbyTimer = setInterval(() => { loadRooms(true); syncAcceptedFriendsQuiet().then(renderRooms); }, LOBBY_FALLBACK_MS);
};
showChat = function() {
lobbyScreen.style.display = "none";
if (friendsScreen) friendsScreen.style.display = "none";
if (announcementScreen) announcementScreen.style.display = "none";
if (mineScreen) mineScreen.style.display = "none";
adminScreen.style.display = "none";
chatShell.style.display = "flex";
sendArea.style.display = "flex";
emergencyBar.style.display = "block";
if (bottomNav) bottomNav.classList.remove("show");
if (announcementBtn) announcementBtn.style.display = "none";
roomBackBtn.style.display = "inline-flex";
roomBackBtn.textContent = "返回";
roomTitleBtn.style.display = "none";
lobbyActions.style.display = "none";
roomActions.style.display = "flex";
if (roomContextBtn) roomContextBtn.textContent = getCurrentChatContextText();
updateAppHeight();
setTimeout(() => { updateAppHeight(); chatBox.scrollTop = chatBox.scrollHeight; }, 80);
};
const oldOpenAdminPage = openAdminPage;
openAdminPage = async function() {
state.adminMode = true;
state.currentRoom = null;
clearInterval(state.timer);
unsubscribeActiveRoomTopic();
clearTypingIndicator();
await loadRooms(false);
lobbyScreen.style.display = "none";
if (friendsScreen) friendsScreen.style.display = "none";
if (announcementScreen) announcementScreen.style.display = "none";
if (mineScreen) mineScreen.style.display = "none";
chatShell.style.display = "none";
adminScreen.style.display = "block";
sendArea.style.display = "none";
emergencyBar.style.display = "none";
if (bottomNav) bottomNav.classList.remove("show");
if (announcementBtn) announcementBtn.style.display = "none";
roomBackBtn.style.display = "inline-flex";
roomBackBtn.textContent = "返回";
roomTitleBtn.style.display = "inline-flex";
roomTitleBtn.textContent = "管理后台";
lobbyActions.style.display = "none";
roomActions.style.display = "none";
const ann = await fetchAnnouncement();
document.getElementById("announcementTitleInput").value = (ann && ann.title) || "系统公告";
document.getElementById("announcementContentInput").value = (ann && ann.content) || "";
document.getElementById("announcementEnabledInput").checked = !ann || ann.enabled !== false;
try { publishPresence("online"); } catch (e) {}
renderAdminOnlineStats(); renderAdminVersionInfo(); renderAdminRooms();
};
let appBootStarted = false;
const oldOpenApp = openApp;
openApp = async function() {
calculator.style.display = "none";
chatApp.style.display = "flex";
state.accountProfile = loadLocalAccountProfile();
state.displayName = getSelfSenderName();
if (nicknameLine) nicknameLine.textContent = state.displayName ? "当前账号：" + state.displayName : "";
resetSecretMode();
calcExpression = "";
unlockInput = "";
isFakeResult = false;
startRuntimeClock();
showLobby();
setDataStatus("connecting");
if (!appBootStarted) {
appBootStarted = true;
setTimeout(startDeferredAppBoot, 120);
}
};
async function startDeferredAppBoot() {
try { initNotifyAudio(); } catch (e) {}
setTimeout(() => {
try { connectMQTT(); } catch (e) {}
try { registerAndroidPWAServiceWorker(); } catch (e) {}
}, 0);
setTimeout(async () => {
try { await syncAcceptedFriendsQuiet(); } catch (e) {}
try { await publishPublicProfileQuiet(); } catch (e) {}
try { renderRooms(); } catch (e) {}
}, 180);
setTimeout(async () => {
try { startGistRetryLoop(); } catch (e) {}
try { flushPendingGistMessages(); } catch (e) {}
try { await loadRooms(false); } catch (e) {}
try { await fetchAnnouncement(); } catch (e) {}
try { updateUnreadBadge(); } catch (e) {}
try { renderRooms(); } catch (e) {}
}, 360);
setTimeout(() => {
try { scheduleDefaultRoomMidnightAutoClear(); } catch (e) {}
try { purgeExpiredDefaultRoomMessages(true); } catch (e) {}
}, 1200);
}
function upgradeAccountProfileShape() {
const p = loadLocalAccountProfile();
if (!p) return;
p.nickname = String(p.nickname || "").trim();
p.friends = Array.isArray(p.friends) ? p.friends : [];
p.dmConversations = Array.isArray(p.dmConversations) ? p.dmConversations : [];
saveLocalAccountProfile(p);
}
upgradeAccountProfileShape();
const EMAIL_CLAIM_PREFIX = "VX_EMAIL_CLAIM_V1:";
function setEmergencyVisible(visible) {
if (!emergencyBar) return;
emergencyBar.style.display = visible ? "block" : "none";
}
function normalizeEmailStrict(email) {
return String(email || "").trim().toLowerCase();
}
async function emailHashValue(email) {
return sha256Text("vx-email-unique:" + normalizeEmailStrict(email));
}
async function getUsedEmailHashes() {
const set = new Set();
try {
const comments = await fetchAllComments();
for (const c of comments) {
if (typeof c.body !== "string") continue;
if (c.body.startsWith(EMAIL_CLAIM_PREFIX)) {
try {
const item = JSON.parse(c.body.slice(EMAIL_CLAIM_PREFIX.length));
if (item && item.emailHash) set.add(String(item.emailHash));
} catch (e) {}
}
if (c.body.startsWith(USER_PREFIX)) {
try {
const p = JSON.parse(c.body.slice(USER_PREFIX.length));
if (p && p.emailHash) set.add(String(p.emailHash));
} catch (e) {}
}
}
} catch (e) {}
return set;
}
async function isEmailAlreadyUsed(email) {
const hash = await emailHashValue(email);
const used = await getUsedEmailHashes();
return used.has(hash);
}
async function postEmailClaimQuiet(profile, email) {
try {
if (!appConfig || !profile || !profile.accountId || !email) return;
const emailHash = await emailHashValue(email);
const claim = {
type: "emailClaim",
accountId: profile.accountId,
nicknameNumber: profile.nicknameNumber || "",
emailHash,
emailMasked: maskEmail(email),
createdAt: Date.now(),
updatedAt: Date.now()
};
await postGistComment(EMAIL_CLAIM_PREFIX + JSON.stringify(claim));
} catch (e) { console.warn("email claim save failed", e); }
}
const oldPublishPublicProfileQuiet_v41 = publishPublicProfileQuiet;
publishPublicProfileQuiet = async function() {
const p = getSelfProfile();
if (!appConfig || !p || !p.accountId || !p.nicknameNumber) return;
try {
const email = localStorage.getItem("vx_account_email_plain") || "";
const publicProfile = {
type: "publicProfile",
accountId: p.accountId,
nicknameNumber: p.nicknameNumber,
nickname: String(p.nickname || "").trim(),
emailMasked: p.emailMasked || (email ? maskEmail(email) : ""),
emailHash: email ? await emailHashValue(email) : (p.emailHash || ""),
updatedAt: Date.now()
};
await postGistComment(USER_PREFIX + JSON.stringify(publicProfile));
if (email) await postEmailClaimQuiet(p, email);
} catch (e) { console.warn("public profile save failed", e); }
};
createAutoAccount = async function() {
const email = normalizeEmailStrict(document.getElementById("autoEmailInput").value);
const safe = normalizeSafeCode(document.getElementById("autoSafeCodeInput").value);
if (!email || !email.includes("@")) return showToast("请输入正确邮箱");
if (!/^\d{1,6}$/.test(safe)) return showToast("安全码需1-6位数字");
try {
const exists = await isEmailAlreadyUsed(email);
if (exists) return showToast("该邮箱已使用，请更换邮箱");
} catch (e) {
return showToast("邮箱核对失败，请稍后再试");
}
const emailHash = await emailHashValue(email);
const profile = {
accountId: crypto.randomUUID(),
nicknameNumber: generateNicknameNumber(),
nickname: "",
emailMasked: maskEmail(email),
emailHash,
createdRooms: [],
joinedRooms: [],
friends: [],
dmConversations: [],
createdAt: Date.now(),
updatedAt: Date.now()
};
localStorage.setItem("vx_account_email_plain", email);
localStorage.setItem("vx_account_safe_plain", safe);
saveLocalAccountProfile(profile);
await createAccountProfileRemote(profile, email, safe);
await postEmailClaimQuiet(profile, email);
await publishPublicProfileQuiet();
closeAccountModal();
showToast("账号已分配：" + profile.nicknameNumber);
renderRooms();
renderMinePage();
};
function getPairKey(a, b) {
return [String(a || ""), String(b || "")].sort().join("__");
}
fetchFriendRequests = async function() {
const me = getSelfProfile();
if (!me) return { incoming: [], outgoing: [], accepted: [] };
const comments = await fetchAllComments();
const latestByRequest = {};
comments.forEach(c => {
if (typeof c.body !== "string" || !c.body.startsWith(FRIEND_PREFIX)) return;
try {
const r = JSON.parse(c.body.slice(FRIEND_PREFIX.length));
if (!r || !r.requestId) return;
const old = latestByRequest[r.requestId];
if (!old || Number(r.updatedAt || r.createdAt || 0) >= Number(old.updatedAt || old.createdAt || 0)) latestByRequest[r.requestId] = r;
} catch (e) {}
});
const all = Object.values(latestByRequest);
const acceptedMap = {};
all.forEach(r => {
if (r.status !== "accepted") return;
if (r.fromAccountId !== me.accountId && r.toAccountId !== me.accountId) return;
const otherId = r.fromAccountId === me.accountId ? r.toAccountId : r.fromAccountId;
const key = getPairKey(me.accountId, otherId);
const old = acceptedMap[key];
if (!old || Number(r.updatedAt || r.createdAt || 0) >= Number(old.updatedAt || old.createdAt || 0)) acceptedMap[key] = r;
});
const pendingMap = {};
all.forEach(r => {
if (r.status !== "pending") return;
if (r.fromAccountId !== me.accountId && r.toAccountId !== me.accountId) return;
const otherId = r.fromAccountId === me.accountId ? r.toAccountId : r.fromAccountId;
const key = getPairKey(me.accountId, otherId);
if (acceptedMap[key]) return;
const old = pendingMap[key];
if (!old || Number(r.updatedAt || r.createdAt || 0) >= Number(old.updatedAt || old.createdAt || 0)) pendingMap[key] = r;
});
const pending = Object.values(pendingMap);
return {
incoming: pending.filter(r => r.toAccountId === me.accountId),
outgoing: pending.filter(r => r.fromAccountId === me.accountId),
accepted: Object.values(acceptedMap)
};
};
async function getFriendRelationState(targetAccountId) {
const me = getSelfProfile();
if (!me || !targetAccountId) return "none";
const local = loadLocalFriends().some(f => f.accountId === targetAccountId);
if (local) return "accepted";
const reqs = await fetchFriendRequests();
const accepted = reqs.accepted.some(r => r.fromAccountId === targetAccountId || r.toAccountId === targetAccountId);
if (accepted) return "accepted";
const incoming = reqs.incoming.some(r => r.fromAccountId === targetAccountId);
if (incoming) return "pending_incoming";
const outgoing = reqs.outgoing.some(r => r.toAccountId === targetAccountId);
if (outgoing) return "pending_outgoing";
return "none";
}
sendFriendRequestToNumber = async function(number) {
const me = getSelfProfile();
if (!me) return showToast("请先初始化账号");
const num = String(number || "").trim();
if (!/^\d{7}$/.test(num)) return showToast("请输入7位好友编号");
if (num === me.nicknameNumber) return showToast("不能添加自己");
const target = await findPublicProfileByNumber(num);
if (!target) return showToast("未找到用户");
const relation = await getFriendRelationState(target.accountId);
if (relation === "accepted") return showToast("已经是好友");
if (relation === "pending_outgoing") return showToast("好友申请已发送，等待对方确认");
if (relation === "pending_incoming") return showToast("对方已申请添加你，请到好友页处理");
const request = {
type: "friendRequest",
requestId: crypto.randomUUID(),
status: "pending",
fromAccountId: me.accountId,
fromNumber: me.nicknameNumber,
fromNickname: profileNickname(me),
toAccountId: target.accountId,
toNumber: target.nicknameNumber,
toNickname: profileNickname(target),
createdAt: Date.now(),
updatedAt: Date.now()
};
await postGistComment(FRIEND_PREFIX + JSON.stringify(request));
showToast("好友申请已发送");
closeAddFriendModal();
renderFriendsPage();
};
const oldAcceptFriendRequest_v41 = acceptFriendRequest;
acceptFriendRequest = async function(requestId) {
const reqs = await fetchFriendRequests();
const req = reqs.incoming.find(r => r.requestId === requestId);
if (!req) return showToast("申请不存在");
const accepted = { ...req, status: "accepted", updatedAt: Date.now() };
await postGistComment(FRIEND_PREFIX + JSON.stringify(accepted));
addLocalFriend({ accountId: req.fromAccountId, nicknameNumber: req.fromNumber, nickname: req.fromNickname || "", addedAt: Date.now() });
showToast("已添加好友");
renderFriendsPage();
renderRooms();
};
rejectFriendRequest = async function(requestId) {
const reqs = await fetchFriendRequests();
const req = reqs.incoming.find(r => r.requestId === requestId);
if (!req) return;
await postGistComment(FRIEND_PREFIX + JSON.stringify({ ...req, status: "rejected", updatedAt: Date.now() }));
showToast("已拒绝");
renderFriendsPage();
};
updateAppHeight = function() {
const root = document.documentElement;
const baseHeight = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 0);
let keyboard = 0;
if (window.visualViewport) {
const vv = window.visualViewport;
keyboard = Math.max(0, Math.round(baseHeight - vv.height - Math.max(0, vv.offsetTop || 0)));
if (keyboard < 80) keyboard = 0;
}
root.style.setProperty("--app-height", baseHeight + "px");
root.style.setProperty("--visible-height", baseHeight + "px");
root.style.setProperty("--vv-top", "0px");
root.style.setProperty("--keyboard-offset", keyboard + "px");
document.body.classList.toggle("keyboard-open", keyboard > 0 || /^(INPUT|TEXTAREA)$/.test((document.activeElement && document.activeElement.tagName) || ""));
};
window.addEventListener("resize", () => setTimeout(updateAppHeight, 30));
if (window.visualViewport) {
window.visualViewport.addEventListener("resize", () => setTimeout(updateAppHeight, 30));
window.visualViewport.addEventListener("scroll", () => setTimeout(updateAppHeight, 30));
}
document.addEventListener("focusin", () => setTimeout(updateAppHeight, 80));
document.addEventListener("focusout", () => setTimeout(updateAppHeight, 220));
updateAppHeight();
const oldShowLobby_v41 = showLobby;
showLobby = function() {
oldShowLobby_v41();
setEmergencyVisible(true);
};
const oldSwitchMainTab_v41 = switchMainTab;
switchMainTab = function(tab) {
oldSwitchMainTab_v41(tab);
setEmergencyVisible(true);
};
const oldOpenAdminPage_v41 = openAdminPage;
openAdminPage = async function() {
await oldOpenAdminPage_v41();
setEmergencyVisible(true);
};
const oldShowChat_v41 = showChat;
showChat = function() {
oldShowChat_v41();
setEmergencyVisible(true);
};
const oldOpenApp_v41 = openApp;
openApp = async function() {
await oldOpenApp_v41();
setEmergencyVisible(true);
};
const oldEmergencyClose_v41 = emergencyClose;
emergencyClose = function() {
oldEmergencyClose_v41();
setEmergencyVisible(false);
};
(function installAdminUsersPanel(){
function unique(arr){ return Array.from(new Set((arr || []).filter(Boolean).map(String))); }
function htmlEscape(s){
return String(s == null ? "" : s).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
}
function publicName(p, withNumber){
const nick = String((p && p.nickname) || "").trim();
const num = String((p && p.nicknameNumber) || "").trim();
if (nick && withNumber && num) return nick + "（" + num + "）";
return nick || num || "未知用户";
}
function currentAccountIndex(){
const p = getSelfProfile && getSelfProfile();
if (!p) return null;
const friends = loadLocalFriends ? loadLocalFriends() : [];
p.createdRooms = unique(p.createdRooms);
p.joinedRooms = unique(p.joinedRooms);
p.dmConversations = unique((p.dmConversations || []).concat(friends.map(f => getDmRoomId(p.accountId, f.accountId))));
p.friends = unique((p.friends || []).concat(friends.map(f => f.accountId)));
return p;
}
const previousPublishPublicProfile = window.publishPublicProfileQuiet || publishPublicProfileQuiet;
publishPublicProfileQuiet = async function(){
const p = currentAccountIndex();
if (!appConfig || !p || !p.accountId || !p.nicknameNumber) return;
try {
const email = localStorage.getItem("vx_account_email_plain") || "";
const publicProfile = {
type: "publicProfile",
accountId: p.accountId,
nicknameNumber: p.nicknameNumber,
nickname: String(p.nickname || "").trim(),
emailMasked: p.emailMasked || (email && typeof maskEmail === "function" ? maskEmail(email) : ""),
emailHash: email && typeof emailHashValue === "function" ? await emailHashValue(email) : (p.emailHash || ""),
createdRooms: unique(p.createdRooms),
joinedRooms: unique(p.joinedRooms),
friends: unique(p.friends),
dmConversations: unique(p.dmConversations),
serviceChats: unique(p.serviceChats),
lastActiveAt: Date.now(),
updatedAt: Date.now()
};
await postGistComment(USER_PREFIX + JSON.stringify(publicProfile));
if (email && typeof postEmailClaimQuiet === "function") await postEmailClaimQuiet(p, email);
} catch (e) {
try { await previousPublishPublicProfile(); } catch (_) {}
}
};
const previousRememberRoomAccess = rememberRoomAccess;
rememberRoomAccess = function(room, roomSecret, type){
previousRememberRoomAccess(room, roomSecret, type);
const p = currentAccountIndex();
if (p) { saveLocalAccountProfile(p); setTimeout(() => publishPublicProfileQuiet(), 50); }
};
const previousAddLocalFriend = addLocalFriend;
addLocalFriend = function(friend){
previousAddLocalFriend(friend);
const p = currentAccountIndex();
if (p) { saveLocalAccountProfile(p); setTimeout(() => publishPublicProfileQuiet(), 50); }
};
function profileMap(list){
const m = {};
(list || []).forEach(p => { if (p && p.accountId) m[p.accountId] = p; });
return m;
}
function roomById(roomId){ return (state.rooms || []).find(r => r.roomId === roomId) || null; }
function makeAdminDmRoom(owner, friend){
const roomId = getDmRoomId(owner.accountId, friend.accountId);
return { type:"dm", isDm:true, roomId, roomNo: friend.nicknameNumber || friend.accountId, roomName: publicName(friend, false), friend, noPassword:true, createdAt: Date.now() };
}
async function adminEnterDm(ownerId, friendId){
const all = await fetchPublicProfiles();
const map = profileMap(all);
const owner = map[ownerId];
const friend = map[friendId] || { accountId: friendId, nicknameNumber: friendId, nickname:"" };
if (!owner || !friend) return showToast("无法进入");
const room = makeAdminDmRoom(owner, friend);
const secret = getDmSecret(owner.accountId, friend.accountId);
openRoom(room, secret, { accessType:"admin", adminMode:true, isDm:true });
}
async function renderAdminUserDetail(user){
const box = document.getElementById("adminUserDetail");
if (!box || !user) return;
await loadRooms(true);
const allProfiles = await fetchPublicProfiles();
const map = profileMap(allProfiles);
const groupIds = unique((user.createdRooms || []).concat(user.joinedRooms || []));
const friendIds = unique(user.friends || []);
const dmIds = unique((user.dmConversations || []).concat(friendIds.map(fid => getDmRoomId(user.accountId, fid))));
const serviceIds = unique(user.serviceChats || []);
box.innerHTML = '<div class="admin-title" style="font-size:15px;margin-top:8px;">' + htmlEscape(publicName(user, true)) + ' 的聊天窗口</div>';
const addLine = (title, meta, onEnter) => {
const row = document.createElement("div");
row.className = "admin-row";
const name = document.createElement("div"); name.className = "admin-room-name"; name.textContent = title;
const info = document.createElement("div"); info.className = "admin-room-meta"; info.textContent = meta || "";
const actions = document.createElement("div"); actions.className = "admin-actions";
const btn = document.createElement("button"); btn.className = "mini-btn"; btn.textContent = "免密进入"; btn.onclick = onEnter;
actions.appendChild(btn); row.appendChild(name); row.appendChild(info); row.appendChild(actions); box.appendChild(row);
};
let count = 0;
groupIds.forEach(id => {
const room = roomById(id);
if (!room || isDefaultPublicRoomId(room.roomId)) return;
count++;
addLine("群｜" + (room.roomName || getRoomNo(room)), "房间号：" + getRoomNo(room), () => adminEnterRoom(room.roomId));
});
dmIds.forEach(roomId => {
const parts = String(roomId).replace(/^dm_/, "").split("_");
const friendId = parts.find(x => x && x !== user.accountId) || "";
const friend = map[friendId] || { accountId: friendId, nicknameNumber: friendId, nickname:"" };
count++;
addLine("私｜" + publicName(friend, true), "会话ID：" + roomId, () => adminEnterDm(user.accountId, friendId));
});
serviceIds.forEach(id => {
count++;
addLine("客服｜" + publicName(user, true), "客服会话：" + id, () => adminEnterServiceChat(id, user));
});
if (!count) box.innerHTML += '<div class="admin-small">该用户暂无可查询聊天窗口；用户需使用新版登录一次后才会自动同步索引。</div>';
}
async function renderAdminUsers(){
const list = document.getElementById("adminUserList");
const detail = document.getElementById("adminUserDetail");
if (!list) return;
list.innerHTML = '<div class="admin-small">正在加载用户...</div>';
if (detail) detail.innerHTML = "";
try {
const users = (await fetchPublicProfiles()).sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
if (!users.length) { list.innerHTML = '<div class="admin-small">暂无注册用户。用户使用新版创建/登录一次后会显示在这里。</div>'; return; }
list.innerHTML = "";
users.forEach(u => {
const row = document.createElement("div");
row.className = "admin-row";
row.onclick = () => renderAdminUserDetail(u);
const name = document.createElement("div"); name.className = "admin-room-name"; name.textContent = publicName(u, true);
const meta = document.createElement("div"); meta.className = "admin-room-meta";
meta.textContent = "邮箱：" + (u.emailMasked || "--") + "\n最后同步：" + (u.updatedAt ? new Date(u.updatedAt).toLocaleString() : "未知");
row.appendChild(name); row.appendChild(meta); list.appendChild(row);
});
} catch (e) { list.innerHTML = '<div class="admin-small">用户加载失败</div>'; }
}
window.renderAdminUsers = renderAdminUsers;
const previousOpenAdminPage = openAdminPage;
openAdminPage = async function(){
await previousOpenAdminPage();
renderAdminUsers();
};
})();
(function installStrongViewportLock(){
const root = document.documentElement;
function px(n){ return Math.max(0, Math.round(Number(n) || 0)) + "px"; }
window.updateAppHeight = function updateAppHeightStrong(){
const vv = window.visualViewport;
const layoutH = Math.max(320, window.innerHeight || document.documentElement.clientHeight || screen.height || 0);
const top = vv ? Math.max(0, vv.offsetTop || 0) : 0;
const height = vv ? Math.max(320, vv.height || layoutH) : layoutH;
const bottomGap = Math.max(0, layoutH - top - height);
const focused = document.activeElement;
const isTyping = !!focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName || "");
root.style.setProperty("--app-height", px(layoutH));
root.style.setProperty("--visible-height", px(height));
root.style.setProperty("--vv-top", px(top));
root.style.setProperty("--keyboard-offset", px(bottomGap));
root.style.setProperty("--vx-vv-top", px(top));
root.style.setProperty("--vx-vv-height", px(height));
root.style.setProperty("--vx-keyboard-bottom", px(bottomGap));
document.body.classList.toggle("keyboard-open", isTyping || bottomGap > 80 || height < layoutH - 80);
};
const runSoon = () => setTimeout(window.updateAppHeight, 30);
window.updateAppHeight();
window.addEventListener("resize", runSoon, { passive: true });
window.addEventListener("orientationchange", () => setTimeout(window.updateAppHeight, 260), { passive: true });
if (window.visualViewport) {
window.visualViewport.addEventListener("resize", runSoon, { passive: true });
window.visualViewport.addEventListener("scroll", runSoon, { passive: true });
}
document.addEventListener("focusin", () => setTimeout(window.updateAppHeight, 80));
document.addEventListener("focusout", () => setTimeout(window.updateAppHeight, 180));
})();


/* VX_V5_SUPPORT_AND_STABILITY_PATCH */
(function(){
  const SERVICE_ACCOUNT_ID="VX_CUSTOMER_SERVICE";
  const SERVICE_NAME="客服";
  const SERVICE_REPLY="客服上线后会及时回复您，请耐心等待！";
  const SERVICE_LIMIT_TEXT="1分钟只能咨询10次客服，请等待时效";
  function now(){return Date.now()}
  function p(){try{return getSelfProfile&&getSelfProfile()}catch(e){return null}}
  function serviceRoomId(accountId){return "CS_"+String(accountId||"")}
  function serviceSecret(accountId){return String((appConfig&&appConfig.chatSecret)||"vx")+"::service::"+String(accountId||"")}
  function serviceRoomFor(profile){return{type:"service",roomId:serviceRoomId(profile.accountId),roomNo:"客服",roomName:"客服",friend:{accountId:SERVICE_ACCOUNT_ID,nicknameNumber:"客服",nickname:"客服"},noPassword:true,isDm:true,isService:true,createdAt:profile.createdAt||now()}}
  function touchServiceProfile(profile){if(!profile)return;profile.serviceChats=Array.isArray(profile.serviceChats)?profile.serviceChats:[];const id=serviceRoomId(profile.accountId);if(!profile.serviceChats.includes(id))profile.serviceChats.push(id);saveLocalAccountProfile(profile);try{updateAccountProfileRemoteQuiet&&updateAccountProfileRemoteQuiet()}catch(e){}try{publishPublicProfileQuiet&&publishPublicProfileQuiet()}catch(e){}}
  window.openServiceConversation=async function(){const profile=p();if(!profile){showToast("请先到我的创建账号");return}touchServiceProfile(profile);const room=serviceRoomFor(profile);await openRoom(room,serviceSecret(profile.accountId),{accessType:"service"})};
  const oldRenderFriendsPage=window.renderFriendsPage||renderFriendsPage;
  window.renderFriendsPage=renderFriendsPage=async function(){await oldRenderFriendsPage();const list=document.getElementById("friendList");if(!list||document.getElementById("serviceFriendRow"))return;const row=document.createElement("div");row.id="serviceFriendRow";row.className="friend-row";row.onclick=()=>openServiceConversation();row.innerHTML='<div class="friend-name">客服</div><div class="friend-meta">点击进入客服咨询</div>';list.insertBefore(row,list.firstChild)};
  function serviceTimesKey(){const profile=p();return "vx_service_times_"+(profile&&profile.accountId||"guest")}
  function serviceLimitOk(){const key=serviceTimesKey();let arr=[];try{arr=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){}const t=now();arr=arr.filter(x=>t-Number(x)<60000);if(arr.length>=10){localStorage.setItem(key,JSON.stringify(arr));showToast(SERVICE_LIMIT_TEXT,2200);return false}arr.push(t);localStorage.setItem(key,JSON.stringify(arr));return true}
  function showTempServiceReply(roomId){const msg={type:"message",messageId:"service_temp_"+now()+"_"+Math.random().toString(16).slice(2),roomId:roomId,senderId:"vx_service_bot",senderName:SERVICE_NAME,text:SERVICE_REPLY,time:now(),temp:true};try{renderMessage(msg);chatBox.scrollTop=chatBox.scrollHeight;setTimeout(()=>{const el=chatBox.querySelector('[data-message-id="'+CSS.escape(getMessageKey(msg))+'"]');if(el)el.remove()},60000)}catch(e){showToast(SERVICE_REPLY,60000)}}
  const oldSendMessage=window.sendMessage||sendMessage;
  window.sendMessage=sendMessage=async function(){const room=state&&state.currentRoom;const txt=messageInput&&messageInput.value&&messageInput.value.trim();if(room&&room.isService&&!room.adminMode){if(!txt)return;if(!serviceLimitOk())return;await oldSendMessage();showTempServiceReply(room.roomId);return}return oldSendMessage()};
  window.adminEnterServiceChat=async function(id,user){if(!user||!user.accountId)return showToast("未找到用户");const room={type:"service",roomId:id||serviceRoomId(user.accountId),roomNo:"客服",roomName:"客服｜"+publicName(user,true),friend:user,noPassword:true,isDm:true,isService:true,createdAt:now()};await openRoom(room,serviceSecret(user.accountId),{adminMode:true,accessType:"service"})};
})();

