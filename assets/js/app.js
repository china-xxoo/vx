(function () {
  "use strict";

  const VERSION = "2026.05.20-unreadcalc-v1";
  const CONFIG_URL = "vx-config.json";
  const GITHUB_API = "https://api.github.com";
  const MQTT_LIB_URL = "https://unpkg.com/mqtt/dist/mqtt.min.js";
  const ROOM_PREFIX = "VX_ROOM_V1:";
  const MSG_PREFIX = "VX_MSG_V1:";
  const BATCH_PREFIX = "VX_MSG_BATCH_V1:";
  const ANN_PREFIX = "VX_ANN_V1:";
  const ACCOUNT_PREFIX = "VX_ACCOUNT_V1:";
  const FEEDBACK_PREFIX = "VX_FEEDBACK_V1:";
  const GIST_QUEUE_KEY = "vx_gist_queue_v1";
  const GIST_QUEUE_LIMIT = 800;
  const DEFAULT_ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const ROOM_NO_DIGITS = 4;
  const ROOM_NO_TOTAL = 10 ** ROOM_NO_DIGITS;
  const ROOM_NO_LOW_RATIO = 0.15;
  const FEEDBACK_DAILY_LIMIT = 10;
  const FEEDBACK_MAX_LENGTH = 300;
  const CALL_STUN_SERVERS = [
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302"
  ];

  const app = {
    cfg: null,
    unlockCode: "",
    calcExpr: "",
    booted: false,
    admin: false,
    tab: "hall",
    currentRoom: null,
    rooms: [],
    comments: [],
    announcement: null,
    announcements: [],
    activeAnnouncementId: "",
    editingAnnouncementId: "",
    feedback: [],
    activeFeedbackId: "",
    accounts: {},
    account: null,
    mqtt: null,
    mqttOk: false,
    gistOk: false,
    globalOnline: {},
    roomOnline: {},
    globalHeartbeat: null,
    roomHeartbeat: null,
    refreshTimer: null,
    uploadTimer: null,
    uploadSoon: null,
    gistQueueBusy: false,
    gistQueueSoon: null,
    gistQueueTimer: null,
    activeRoomSubscription: null,
    roomSubscriptions: new Set(),
    sending: false,
    feedbackSending: false,
    pushBusy: false,
    audioCtx: null,
    calcUnreadHint: "",
    calcUnreadCount: 0,
    call: null,
    incomingCall: null,
    busyText: "",
    busyToken: 0,
    chatSearch: "",
    adminSearch: "",
    accountSyncSoon: null,
    deviceId: localStorage.vx_device || ("U" + Math.random().toString(36).slice(2, 10))
  };

  localStorage.vx_device = app.deviceId;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const json = JSON.stringify;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const today = () => new Date().toISOString().slice(0, 10);
  const localDay = value => {
    const date = value ? new Date(value) : new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  };
  const esc = value => String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
  const formatTime = value => value ? new Date(value).toLocaleString() : "";

  function stableHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function unreadTotalForCalc() {
    try {
      const data = JSON.parse(localStorage.getItem("vx_unread_rooms_v1") || "{}");
      return Math.min(999, Object.values(data).reduce((sum, value) => sum + Math.max(0, +value || 0), 0));
    } catch (error) {
      return 0;
    }
  }

  function unreadCalcText(total) {
    if (!total) return "0";
    if (total !== app.calcUnreadCount || !app.calcUnreadHint) {
      let left = total > 1 ? Math.floor(Math.random() * total) : 0;
      let right = total - left;
      if (total > 1 && left === 0) {
        left = 1;
        right = total - 1;
      }
      app.calcUnreadCount = total;
      app.calcUnreadHint = left + "+" + right + "=" + total;
    }
    return app.calcUnreadHint;
  }

  function calcVisible() {
    return $("calc") && $("calc").style.display !== "none";
  }

  function refreshCalcUnreadDisplay() {
    if (!app.calcExpr && calcVisible()) showCalc();
  }

  function showCalc() {
    $("disp").textContent = (app.calcExpr || unreadCalcText(unreadTotalForCalc())).replaceAll("*", "×").replaceAll("/", "÷").slice(-18);
  }

  function addNumber(value) {
    if (app.calcExpr === "0" || app.calcExpr === "Error") app.calcExpr = "";
    app.calcExpr += value;
    showCalc();
  }

  function addOperator(value) {
    if (app.calcExpr === "Error") app.calcExpr = "";
    if (!app.calcExpr && value !== "-") return;
    if ("+-*/%".includes(app.calcExpr.slice(-1))) app.calcExpr = app.calcExpr.slice(0, -1);
    app.calcExpr += value;
    showCalc();
  }

  function addDot() {
    const part = app.calcExpr.split(/[+\-*/%]/).pop();
    if (!part.includes(".")) {
      app.calcExpr += part ? "." : "0.";
      showCalc();
    }
  }

  function clearCalc() {
    app.calcExpr = "";
    showCalc();
  }

  function backspaceCalc() {
    app.calcExpr = app.calcExpr.slice(0, -1);
    showCalc();
  }

  function calculate() {
    try {
      if (!app.calcExpr) return showCalc();
      if (!/^[0-9+\-*/%. ]+$/.test(app.calcExpr) || "+-*/%.".includes(app.calcExpr.slice(-1))) throw new Error("bad expression");
      const result = Function("\"use strict\";return(" + app.calcExpr + ")")();
      app.calcExpr = Number.isFinite(result) ? String(+result.toFixed(8)) : "Error";
    } catch (error) {
      app.calcExpr = "Error";
    }
    showCalc();
  }

  function unlockCandidates() {
    const match = String(app.calcExpr || "").match(/(\d+)$/);
    if (!match) return [];
    const tail = match[1].slice(-6);
    const values = [];
    for (let index = 0; index < tail.length; index += 1) values.push(tail.slice(index));
    return values;
  }

  function base64ToBytes(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let text = "";
    const data = new Uint8Array(bytes);
    for (let index = 0; index < data.length; index += 1) text += String.fromCharCode(data[index]);
    return btoa(text);
  }

  async function aesKey(password, salt, usage, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iterations || 180000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      [usage]
    );
  }

  async function decryptConfig(code, payload) {
    const encrypted = payload.encryptedConfig || payload;
    const key = await aesKey(code, base64ToBytes(encrypted.salt), "decrypt", encrypted.iterations || payload.iterations || 180000);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.data)
    );
    return JSON.parse(dec.decode(plain));
  }

  function normalizeConfig(config) {
    return {
      token: config.token || "",
      gistId: config.gistId || "",
      adminPassword: config.adminPassword || "",
      roomChars: config.roomChars || DEFAULT_ROOM_CHARS,
      mqttUrl: config.mqttUrl || "",
      mqttUser: config.mqttUser || "",
      mqttPass: config.mqttPass || "",
      mqttPrefix: (config.mqttPrefix || "vx/app/calcchat/v1").replace(/\/+$/, ""),
      mqttLibUrl: config.mqttLibUrl || MQTT_LIB_URL,
      pushUrl: (config.pushUrl || "").replace(/\/+$/, ""),
      pushVapidPublicKey: config.pushVapidPublicKey || "",
      pushSecret: config.pushSecret || ""
    };
  }

  async function unlock() {
    const candidates = unlockCandidates();
    if (!candidates.length) return;
    if (app.cfg && app.unlockCode && candidates.includes(app.unlockCode)) {
      openApp();
      return;
    }
    try {
      const response = await fetch(CONFIG_URL + "?t=" + now(), { cache: "no-store" });
      const payload = await response.json();
      for (const code of candidates) {
        try {
          const config = normalizeConfig(await decryptConfig(code, payload));
          if (config.token && config.gistId) {
            app.cfg = config;
            app.unlockCode = code;
            openApp();
            return;
          }
        } catch (error) {
          // Try the next suffix without revealing which part failed.
        }
      }
    } catch (error) {
      console.warn("Unable to load encrypted config.", error);
    }
  }

  function openApp() {
    $("calc").style.display = "none";
    $("app").style.display = "block";
    $("app").classList.remove("vxInstant");
    $("app").setAttribute("aria-hidden", "false");
    boot();
  }

  function panicClose() {
    $("calc").style.display = "flex";
    $("app").style.display = "none";
    $("app").setAttribute("aria-hidden", "true");
    $("modal").style.display = "none";
    app.calcExpr = "";
    showCalc();

    setTimeout(() => {
      closeMediaMenu();
      endCall({ immediate: true });
      app.incomingCall = null;
      document.body.classList.remove("room");
      app.currentRoom = null;
      app.tab = "hall";
      app.chatSearch = "";
      app.activeAnnouncementId = "";
      app.editingAnnouncementId = "";
      app.activeFeedbackId = "";
      clearInterval(app.uploadTimer);
      app.uploadTimer = null;
      leaveRoomSubscription();
      $("send").style.display = "none";
      $("backBtn").classList.add("hide");
      $("roomTag").classList.add("hide");
      $("roomTag").textContent = "";
      $("roomTag").removeAttribute("title");
      $("roomTag").removeAttribute("role");
      $("roomTag").removeAttribute("tabindex");
      $("roomTag").style.cursor = "";
      $("newBtn").classList.remove("hide");
      updateTopControls();
      fixViewport();
    }, 0);
  }

  function headers(extra) {
    return {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + app.cfg.token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(extra || {})
    };
  }

  async function api(path, options) {
    const init = options || {};
    const response = await fetch(GITHUB_API + path, {
      ...init,
      headers: headers(init.headers)
    });
    if (!response.ok) throw new Error("GitHub API " + response.status);
    return response.status === 204 ? null : response.json();
  }

  function pushConfigured() {
    return !!(app.cfg?.pushUrl && app.cfg?.pushVapidPublicKey && app.cfg?.pushSecret);
  }

  function pushSupported() {
    return location.protocol !== "file:" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function pushEnabled() {
    return localStorage.getItem("vx_push_enabled") === "1";
  }

  function pushStatusText() {
    if (!pushSupported()) return "当前浏览器不支持系统通知";
    if (!pushConfigured()) return "未配置系统通知";
    if (Notification.permission === "denied") return "系统通知已被浏览器禁止";
    return pushEnabled() ? "系统通知已开启" : "系统通知未开启";
  }

  function urlBase64ToBytes(value) {
    const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(text + "=".repeat((4 - (text.length % 4)) % 4));
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  async function pushApi(path, body) {
    if (!pushConfigured()) return null;
    const response = await fetch(app.cfg.pushUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Push-Secret": app.cfg.pushSecret
      },
      body: json(body || {})
    });
    if (!response.ok) throw new Error("Push API " + response.status);
    return response.json();
  }

  function pushRoomList() {
    const valid = new Set(app.rooms.filter(room => !isOwnerDeleted(room)).map(room => room.no));
    return visibleRooms().filter(no => valid.has(no) && !isRoomMuted(no));
  }

  async function serviceWorkerReady() {
    registerServiceWorker();
    return navigator.serviceWorker.ready;
  }

  async function syncPushSubscription(forceSubscribe = false) {
    if (!pushEnabled() || !pushConfigured() || !pushSupported()) return;
    if (Notification.permission === "denied") return;
    const registration = await serviceWorkerReady();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription && forceSubscribe) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(app.cfg.pushVapidPublicKey)
      });
    }
    if (!subscription) return;
    await pushApi("/push/subscribe", {
      subscription,
      rooms: pushRoomList(),
      userId: currentUserId(),
      deviceId: app.deviceId
    });
  }

  async function enablePushNotifications() {
    if (app.pushBusy) return;
    if (!pushSupported()) return toast("当前浏览器不支持系统通知");
    if (!pushConfigured()) return toast("系统通知未配置");
    app.pushBusy = true;
    try {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        localStorage.removeItem("vx_push_enabled");
        renderAccountPage();
        return;
      }
      localStorage.setItem("vx_push_enabled", "1");
      await syncPushSubscription(true);
      renderAccountPage();
    } catch (error) {
      console.warn("Enable push failed.", error);
      toast("开启失败，请稍后重试");
    } finally {
      app.pushBusy = false;
    }
  }

  async function disablePushNotifications() {
    if (app.pushBusy) return;
    app.pushBusy = true;
    try {
      if (pushSupported()) {
        const registration = await serviceWorkerReady();
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await pushApi("/push/unsubscribe", { endpoint: subscription.endpoint, subscription }).catch(() => {});
          await subscription.unsubscribe();
        }
      }
      localStorage.removeItem("vx_push_enabled");
      renderAccountPage();
    } catch (error) {
      console.warn("Disable push failed.", error);
      localStorage.removeItem("vx_push_enabled");
      renderAccountPage();
    } finally {
      app.pushBusy = false;
    }
  }

  function togglePushNotifications() {
    if (pushEnabled()) disablePushNotifications();
    else enablePushNotifications();
  }

  function notifyPush(roomNo, message) {
    if (!pushEnabled() || !pushConfigured()) return;
    pushApi("/push/notify", {
      roomNo,
      sender: message?.sender || currentUserId(),
      messageId: message?.id || ""
    }).catch(error => console.warn("Push notify failed.", error));
  }

  async function loadComments() {
    app.comments = [];
    let page = 1;
    while (true) {
      const comments = await api(`/gists/${encodeURIComponent(app.cfg.gistId)}/comments?per_page=100&page=${page}&t=${now()}`, {
        cache: "no-store"
      });
      app.comments.push(...comments);
      if (comments.length < 100) break;
      page += 1;
    }
  }

  async function postComment(body) {
    return api(`/gists/${encodeURIComponent(app.cfg.gistId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json({ body })
    });
  }

  async function deleteComment(id) {
    return api(`/gists/${encodeURIComponent(app.cfg.gistId)}/comments/${id}`, {
      method: "DELETE"
    });
  }

  function backgroundRun(label, task, retry = true) {
    Promise.resolve()
      .then(task)
      .catch(error => {
        console.warn(label + " failed.", error);
        if (retry) {
          setTimeout(() => {
            Promise.resolve().then(task).catch(retryError => console.warn(label + " retry failed.", retryError));
          }, 3000);
        }
      });
  }

  function gistBodyKey(body) {
    try {
      if (body.startsWith(ROOM_PREFIX)) {
        const room = JSON.parse(body.slice(ROOM_PREFIX.length));
        return "post:room:" + String(room.no || stableHash(body));
      }
      if (body.startsWith(ANN_PREFIX)) {
        const announcement = JSON.parse(body.slice(ANN_PREFIX.length));
        return "post:announcement:" + String(announcement.id || stableHash(body));
      }
      if (body.startsWith(ACCOUNT_PREFIX)) {
        const account = JSON.parse(body.slice(ACCOUNT_PREFIX.length));
        const username = normalizeAccountName(account.username || "");
        return "post:account:" + (username || stableHash(body));
      }
      if (body.startsWith(FEEDBACK_PREFIX)) {
        const item = JSON.parse(body.slice(FEEDBACK_PREFIX.length));
        return "post:feedback:" + String(item.id || stableHash(body));
      }
      if (body.startsWith(BATCH_PREFIX)) {
        const rest = body.slice(BATCH_PREFIX.length);
        const split = rest.indexOf(":");
        const roomNo = split >= 0 ? rest.slice(0, split) : "";
        const pack = split >= 0 ? JSON.parse(rest.slice(split + 1)) : {};
        const messageIds = (pack.messages || []).map(message => message.id || legacyMessageId(message)).filter(Boolean).join(",");
        return "post:batch:" + roomNo + ":" + (messageIds || pack.time || stableHash(body));
      }
      if (body.startsWith(MSG_PREFIX)) {
        const rest = body.slice(MSG_PREFIX.length);
        const split = rest.indexOf(":");
        const roomNo = split >= 0 ? rest.slice(0, split) : "";
        const message = split >= 0 ? JSON.parse(rest.slice(split + 1)) : {};
        return "post:message:" + roomNo + ":" + (message.id || legacyMessageId(message) || stableHash(body));
      }
    } catch (error) {
      console.warn("Unable to key gist body.", error);
    }
    return "post:raw:" + stableHash(body);
  }

  function gistQueue() {
    return localJson(GIST_QUEUE_KEY, []);
  }

  function saveGistQueue(items) {
    saveJson(GIST_QUEUE_KEY, items.slice(-GIST_QUEUE_LIMIT));
  }

  function enqueueGistItem(item) {
    const queue = gistQueue();
    const index = queue.findIndex(old => old.key === item.key);
    if (index >= 0) {
      queue[index] = {
        ...queue[index],
        ...item,
        createdAt: queue[index].createdAt || item.createdAt,
        attempts: queue[index].attempts || 0,
        updatedAt: now()
      };
    } else {
      queue.push({
        id: "GQ_" + now() + "_" + Math.random().toString(36).slice(2, 8),
        createdAt: now(),
        updatedAt: now(),
        attempts: 0,
        ...item
      });
    }
    saveGistQueue(queue);
    scheduleGistQueue();
  }

  function backgroundPostComment(body, label) {
    enqueueGistItem({
      op: "post",
      key: gistBodyKey(body),
      body,
      label: label || "Background post"
    });
  }

  function backgroundDeleteComment(id, label) {
    if (!id) return;
    enqueueGistItem({
      op: "delete",
      key: "delete:" + id,
      cid: id,
      label: label || "Background delete"
    });
  }

  function backgroundDeleteComments(label, match) {
    const comments = app.comments.slice();
    for (const comment of comments) {
      if (match(comment.body || "")) backgroundDeleteComment(comment.id, label || "Background delete comments");
    }
  }

  function applyPostedComment(body, comment) {
    if (!comment?.id) return;
    try {
      if (body.startsWith(ROOM_PREFIX)) {
        updateLocalRoom({ ...JSON.parse(body.slice(ROOM_PREFIX.length)), cid: comment.id });
      } else if (body.startsWith(ANN_PREFIX)) {
        mergeAnnouncement({ ...JSON.parse(body.slice(ANN_PREFIX.length)), cid: comment.id });
      } else if (body.startsWith(ACCOUNT_PREFIX)) {
        const account = JSON.parse(body.slice(ACCOUNT_PREFIX.length));
        account.username = normalizeAccountName(account.username);
        if (account.username) app.accounts[account.username] = { ...account, cid: comment.id };
      } else if (body.startsWith(FEEDBACK_PREFIX)) {
        mergeFeedback({ ...JSON.parse(body.slice(FEEDBACK_PREFIX.length)), cid: comment.id });
      }
    } catch (error) {
      console.warn("Unable to apply posted gist comment.", error);
    }
  }

  function scheduleGistQueue(delay = 300) {
    clearTimeout(app.gistQueueSoon);
    app.gistQueueSoon = setTimeout(() => {
      processGistQueue().catch(error => console.warn("Gist queue sync failed.", error));
    }, delay);
  }

  async function processGistQueue() {
    if (app.gistQueueBusy || !app.cfg?.gistId) return;
    let queue = gistQueue();
    if (!queue.length) return;

    app.gistQueueBusy = true;
    const completed = new Set();
    let shouldStop = false;
    try {
      for (const item of queue.slice(0, 25)) {
        try {
          if (item.op === "delete") {
            await deleteComment(item.cid);
          } else {
            const comment = await postComment(item.body);
            applyPostedComment(item.body, comment);
          }
          completed.add(item.id);
        } catch (error) {
          item.attempts = +(item.attempts || 0) + 1;
          item.updatedAt = now();
          item.lastError = String(error?.message || error).slice(0, 120);
          shouldStop = true;
          console.warn((item.label || "Gist queue item") + " failed.", error);
          break;
        }
      }
    } finally {
      queue = gistQueue().map(item => {
        const changed = queue.find(next => next.id === item.id);
        return changed || item;
      }).filter(item => !completed.has(item.id));
      saveGistQueue(queue);
      app.gistQueueBusy = false;
      if (completed.size) backgroundRefresh();
      if (queue.length) scheduleGistQueue(shouldStop ? 5000 : 300);
    }
  }

  function backgroundRefresh(delay = 900) {
    setTimeout(() => refresh().catch(error => console.warn("Background refresh failed.", error)), delay);
  }

  function normalizeFeedback(item, cid) {
    const createdAt = +(item.createdAt || now());
    const text = cleanFeedbackText(item.text);
    const sender = String(item.sender || item.deviceId || "");
    const role = item.role || (item.sender === "admin" ? "admin" : "user");
    const deviceId = String(item.deviceId || "");
    const username = normalizeAccountName(item.username || "");
    const target = String(item.target || "");
    const targetDeviceId = String(item.targetDeviceId || "");
    const targetUsername = normalizeAccountName(item.targetUsername || "");
    const stableId = [
      role,
      sender,
      deviceId,
      username,
      target,
      targetDeviceId,
      targetUsername,
      text,
      createdAt
    ].join("|");
    if (!item.deletedAt && (!text || !sender)) return null;
    return {
      ...item,
      ...(cid ? { cid } : {}),
      id: String(item.id || ("F_LEGACY_" + stableHash(stableId))),
      role,
      sender,
      deviceId,
      username,
      target,
      targetDeviceId,
      targetUsername,
      text,
      day: item.day || localDay(createdAt),
      createdAt,
      updatedAt: +(item.updatedAt || item.deletedAt || item.createdAt || createdAt),
      deletedAt: item.deletedAt ? +item.deletedAt : 0
    };
  }

  function feedbackFingerprint(item) {
    if (item.id) return "id:" + item.id;
    return [
      item.sender || "",
      item.deviceId || "",
      normalizeAccountName(item.username || ""),
      cleanFeedbackText(item.text),
      Math.floor(+(item.createdAt || 0) / 1000)
    ].join("|");
  }

  function mergeFeedback(item) {
    const normalized = normalizeFeedback(item);
    if (!normalized) return false;
    if (normalized.deletedAt) {
      removeFeedback(normalized.id);
      return true;
    }
    const key = feedbackFingerprint(normalized);
    const index = app.feedback.findIndex(old => old.id === normalized.id || feedbackFingerprint(old) === key);
    if (index >= 0) app.feedback[index] = { ...app.feedback[index], ...normalized };
    else app.feedback.unshift(normalized);
    app.feedback.sort((a, b) => (+(b.createdAt || 0)) - (+(a.createdAt || 0)));
    return index < 0;
  }

  function removeFeedback(id) {
    const before = app.feedback.length;
    app.feedback = app.feedback.filter(item => item.id !== id);
    if (app.activeFeedbackId === id) app.activeFeedbackId = "";
    return app.feedback.length !== before;
  }

  function latestFeedbackItem(old, item) {
    if (!old) return item;
    return +(item.updatedAt || item.deletedAt || item.createdAt || 0) >= +(old.updatedAt || old.deletedAt || old.createdAt || 0)
      ? { ...old, ...item }
      : old;
  }

  function normalizeAnnouncement(item, cid) {
    const createdAt = +(item.createdAt || item.time || now());
    const title = String(item.title || "系统公告").trim().slice(0, 40) || "系统公告";
    const content = String(item.content || "").trim().slice(0, 2000);
    const id = String(item.id || ("A_LEGACY_" + stableHash([title, content, createdAt].join("|"))));
    if (!item.deletedAt && !title && !content) return null;
    return {
      ...item,
      ...(cid ? { cid } : {}),
      id,
      title,
      content,
      time: +(item.time || createdAt),
      createdAt,
      updatedAt: +(item.updatedAt || item.deletedAt || item.time || createdAt),
      deletedAt: item.deletedAt ? +item.deletedAt : 0
    };
  }

  function announcementRecord(item) {
    const copy = { ...item };
    delete copy.cid;
    return copy;
  }

  function sortAnnouncements(items) {
    return items.sort((a, b) => (+(b.time || b.createdAt || 0)) - (+(a.time || a.createdAt || 0)));
  }

  function updateCurrentAnnouncement() {
    sortAnnouncements(app.announcements);
    app.announcement = app.announcements[0] || null;
    if (app.activeAnnouncementId && !app.announcements.some(item => item.id === app.activeAnnouncementId)) {
      app.activeAnnouncementId = "";
    }
  }

  function mergeAnnouncement(item) {
    const normalized = normalizeAnnouncement(item);
    if (!normalized) return false;
    if (normalized.deletedAt) {
      removeAnnouncement(normalized.id);
      return true;
    }
    const index = app.announcements.findIndex(old => old.id === normalized.id);
    if (index >= 0) app.announcements[index] = { ...app.announcements[index], ...normalized };
    else app.announcements.unshift(normalized);
    updateCurrentAnnouncement();
    return index < 0;
  }

  function removeAnnouncement(id) {
    const before = app.announcements.length;
    app.announcements = app.announcements.filter(item => item.id !== id);
    if (app.activeAnnouncementId === id) app.activeAnnouncementId = "";
    if (app.editingAnnouncementId === id) app.editingAnnouncementId = "";
    updateCurrentAnnouncement();
    return app.announcements.length !== before;
  }

  function latestAnnouncementItem(old, item) {
    if (!old) return item;
    return +(item.updatedAt || item.deletedAt || item.time || 0) >= +(old.updatedAt || old.deletedAt || old.time || 0)
      ? { ...old, ...item }
      : old;
  }

  function parseComments() {
    const roomMap = {};
    const accountMap = {};
    const feedbackMap = {};
    const announcementMap = {};
    app.announcement = null;
    app.announcements = [];

    for (const comment of app.comments) {
      const body = comment.body || "";
      try {
        if (body.startsWith(ROOM_PREFIX)) {
          const room = JSON.parse(body.slice(ROOM_PREFIX.length));
          room.cid = comment.id;
          const old = roomMap[room.no];
          const roomTime = +(room.updatedAt || room.createdAt || 0);
          const oldTime = +(old?.updatedAt || old?.createdAt || 0);
          if (!old || roomTime > oldTime) roomMap[room.no] = room;
        } else if (body.startsWith(ANN_PREFIX)) {
          const announcement = normalizeAnnouncement(JSON.parse(body.slice(ANN_PREFIX.length)), comment.id);
          if (announcement) {
            announcementMap[announcement.id] = latestAnnouncementItem(announcementMap[announcement.id], announcement);
          }
        } else if (body.startsWith(ACCOUNT_PREFIX)) {
          const account = JSON.parse(body.slice(ACCOUNT_PREFIX.length));
          account.username = normalizeAccountName(account.username);
          account.cid = comment.id;
          const old = accountMap[account.username];
          const accountTime = +(account.updatedAt || account.createdAt || 0);
          const oldTime = +(old?.updatedAt || old?.createdAt || 0);
          if (account.username && (!old || accountTime > oldTime)) accountMap[account.username] = account;
        } else if (body.startsWith(FEEDBACK_PREFIX)) {
          const item = normalizeFeedback(JSON.parse(body.slice(FEEDBACK_PREFIX.length)), comment.id);
          if (item) {
            const key = feedbackFingerprint(item);
            feedbackMap[key] = latestFeedbackItem(feedbackMap[key], item);
          }
        }
      } catch (error) {
        console.warn("Skipping invalid gist comment.", error);
      }
    }

    app.rooms = sortRooms(Object.values(roomMap));
    app.accounts = accountMap;
    app.announcements = sortAnnouncements(Object.values(announcementMap).filter(item => !item.deletedAt));
    updateCurrentAnnouncement();
    app.feedback = Object.values(feedbackMap)
      .filter(item => !item.deletedAt)
      .sort((a, b) => (+(b.createdAt || 0)) - (+(a.createdAt || 0)));
    restoreAccountSession();
  }

  async function refresh(label) {
    const busy = label ? beginBusy(label) : null;
    try {
      await loadComments();
      parseComments();
      app.gistOk = true;
      syncRoomMessageSubscriptions();
      if (app.currentRoom) {
        const updatedRoom = app.rooms.find(room => room.no === app.currentRoom.no);
        if (!updatedRoom || (isOwnerDeleted(updatedRoom) && !app.admin)) back();
        else app.currentRoom = updatedRoom;
      }
      if (!app.currentRoom) renderCurrentTab();
    } catch (error) {
      app.gistOk = false;
      console.warn("Refresh failed.", error);
    }
    updateStatus();
    if (busy) endBusy(busy);
  }

  function topic(name) {
    return app.cfg.mqttPrefix + "/" + name;
  }

  function publish(name, payload) {
    try {
      if (app.mqtt && app.mqttOk) app.mqtt.publish(topic(name), json(payload), { qos: 0, retain: false });
    } catch (error) {
      console.warn("MQTT publish failed.", error);
    }
  }

  function currentUserId() {
    return app.account?.userId || app.deviceId;
  }

  function ownSender(id) {
    return id === currentUserId() || id === app.deviceId || !!app.account?.deviceIds?.includes(id);
  }

  function noticeAudioContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    if (!app.audioCtx) app.audioCtx = new AudioContext();
    return app.audioCtx;
  }

  function warmNoticeSound() {
    const ctx = noticeAudioContext();
    if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  }

  function playNoticeSound() {
    if (document.hidden) return;
    const ctx = noticeAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().then(playNoticeSound).catch(() => {});
      return;
    }

    const start = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, start);
    master.gain.exponentialRampToValueAtTime(0.06, start + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    master.connect(ctx.destination);

    [[880, 0], [1175, 0.075]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = start + offset;
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.85, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(master);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  }

  function callKindLabel(kind) {
    return kind === "video" ? "视频" : "语音";
  }

  function callPeerName(id, fallback) {
    if (!id) return fallback || "对方";
    if (ownSender(id)) return "我";
    const profiles = app.currentRoom ? roomProfiles(app.currentRoom.no) : {};
    return normalizeNickname(fallback) || profiles[id] || "对方";
  }

  function closeMediaMenu() {
    const menu = $("mediaMenu");
    const button = $("mediaBtn");
    if (menu) menu.classList.add("hide");
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function toggleMediaMenu() {
    if (!app.currentRoom) return;
    const menu = $("mediaMenu");
    const button = $("mediaBtn");
    if (!menu || !button) return;
    const open = menu.classList.toggle("hide");
    button.setAttribute("aria-expanded", open ? "false" : "true");
  }

  function sendCallSignal(signal, extra) {
    const data = extra || {};
    const roomNo = data.roomNo || app.call?.roomNo || app.incomingCall?.roomNo || app.currentRoom?.no;
    if (!roomNo) return;
    const payload = {
      type: "call",
      signal,
      roomNo,
      callId: data.callId || app.call?.id || app.incomingCall?.callId || "",
      kind: data.kind || app.call?.kind || app.incomingCall?.kind || "audio",
      from: currentUserId(),
      fromName: roomNickname(roomNo),
      time: now(),
      ...data
    };
    payload.type = "call";
    payload.signal = signal;
    payload.from = currentUserId();
    publish("room/" + roomNo, payload);
  }

  function ensureCallOverlay() {
    let overlay = $("callOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "callOverlay";
    overlay.className = "callOverlay";
    overlay.addEventListener("click", event => {
      if (event.target.closest("#callHangupBtn")) {
        endCall();
        return;
      }
      if (event.target.closest("#callMuteBtn")) {
        toggleCallAudio();
        return;
      }
      if (event.target.closest("#callCameraBtn")) {
        toggleCallVideo();
      }
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function bindMediaStream(id, stream) {
    const element = $(id);
    if (!element || !stream || element.srcObject === stream) return;
    element.srcObject = stream;
    element.play?.().catch(() => {});
  }

  function renderCallOverlay() {
    const overlay = ensureCallOverlay();
    const call = app.call;
    if (!call) {
      overlay.classList.remove("on");
      overlay.innerHTML = "";
      return;
    }

    const video = call.kind === "video";
    const title = callKindLabel(call.kind) + "聊天";
    const peer = callPeerName(call.peerId, call.peerName);
    overlay.className = "callOverlay on";
    overlay.innerHTML = `<div class="callPanel ${video ? "videoPanel" : "audioPanel"}">
      <div class="callHead">
        <div>
          <div class="callTitle">${esc(title)}</div>
          <div class="callStatus">${esc(call.status || "正在连接")}</div>
        </div>
        <div class="callPeer">${esc(peer)}</div>
      </div>
      <div class="callStage">
        ${video ? `<video id="remoteVideo" class="remoteVideo" autoplay playsinline></video>
          <video id="localVideo" class="localVideo" autoplay muted playsinline></video>` : `<div class="audioAvatar">${esc(peer.slice(0, 2) || "语音")}</div>
          <audio id="remoteAudio" autoplay></audio>`}
      </div>
      <div class="callControls">
        <button class="callBtn" type="button" id="callMuteBtn">${call.audioMuted ? "开麦" : "静音"}</button>
        ${video ? `<button class="callBtn" type="button" id="callCameraBtn">${call.videoOff ? "开摄像头" : "关摄像头"}</button>` : ""}
        <button class="callBtn dangerCall" type="button" id="callHangupBtn">挂断</button>
      </div>
    </div>`;

    if (video) {
      bindMediaStream("localVideo", call.localStream);
      bindMediaStream("remoteVideo", call.remoteStream);
    } else {
      bindMediaStream("remoteAudio", call.remoteStream);
    }
  }

  function cleanupCall() {
    const call = app.call;
    if (!call) return;
    clearTimeout(call.timeout);
    try {
      call.pc?.close();
    } catch (error) {
      console.warn("Close call peer failed.", error);
    }
    for (const stream of [call.localStream, call.remoteStream]) {
      stream?.getTracks?.().forEach(track => track.stop());
    }
    app.call = null;
    renderCallOverlay();
  }

  function finishCall(message, delay = 900) {
    const call = app.call;
    if (!call) return;
    clearTimeout(call.timeout);
    call.status = message;
    renderCallOverlay();
    const callId = call.id;
    setTimeout(() => {
      if (app.call?.id === callId) cleanupCall();
    }, delay);
  }

  function endCall(options) {
    const opts = options || {};
    if (app.incomingCall && !app.call) {
      rejectIncomingCall();
      return;
    }
    const call = app.call;
    if (!call) return;
    if (opts.notify !== false) {
      sendCallSignal("hangup", {
        roomNo: call.roomNo,
        callId: call.id,
        kind: call.kind,
        to: call.peerId || ""
      });
    }
    if (opts.immediate) cleanupCall();
    else finishCall(opts.message || "通话已结束", opts.delay || 300);
  }

  function setCallStatus(text) {
    if (!app.call) return;
    app.call.status = text;
    renderCallOverlay();
  }

  async function prepareCallMedia() {
    if (!app.call) return null;
    if (app.call.localStream) return app.call.localStream;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("media devices unavailable");
    setCallStatus(app.call.kind === "video" ? "正在打开摄像头" : "正在打开麦克风");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: app.call.kind === "video" ? { facingMode: "user" } : false
    });
    if (!app.call) {
      stream.getTracks().forEach(track => track.stop());
      return null;
    }
    app.call.localStream = stream;
    addLocalCallTracks();
    renderCallOverlay();
    return stream;
  }

  function addLocalCallTracks() {
    if (!app.call?.pc || !app.call.localStream || app.call.tracksAdded) return;
    app.call.localStream.getTracks().forEach(track => app.call.pc.addTrack(track, app.call.localStream));
    app.call.tracksAdded = true;
  }

  function ensurePeerConnection() {
    if (!app.call) return null;
    if (app.call.pc) {
      addLocalCallTracks();
      return app.call.pc;
    }
    const callId = app.call.id;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: CALL_STUN_SERVERS }] });
    app.call.pc = pc;
    app.call.pendingIce = app.call.pendingIce || [];

    pc.onicecandidate = event => {
      if (!event.candidate || app.call?.id !== callId) return;
      sendCallSignal("ice", {
        roomNo: app.call.roomNo,
        callId: app.call.id,
        kind: app.call.kind,
        to: app.call.peerId || "",
        candidate: event.candidate
      });
    };
    pc.ontrack = event => {
      if (app.call?.id !== callId) return;
      if (event.streams?.[0]) app.call.remoteStream = event.streams[0];
      else {
        app.call.remoteStream = app.call.remoteStream || new MediaStream();
        app.call.remoteStream.addTrack(event.track);
      }
      app.call.status = "通话中";
      renderCallOverlay();
    };
    pc.onconnectionstatechange = () => updateCallConnection(pc, callId);
    pc.oniceconnectionstatechange = () => updateCallConnection(pc, callId);
    addLocalCallTracks();
    return pc;
  }

  function updateCallConnection(pc, callId) {
    if (app.call?.id !== callId) return;
    const state = pc.connectionState || pc.iceConnectionState || "";
    if (state === "connected" || state === "completed") setCallStatus("通话中");
    else if (state === "checking" || state === "connecting") setCallStatus("正在连接");
    else if (state === "disconnected") setCallStatus("网络不稳定");
    else if (state === "failed") finishCall("连接失败", 1200);
  }

  async function flushCallIce() {
    const call = app.call;
    if (!call?.pc?.remoteDescription) return;
    const pending = call.pendingIce || [];
    call.pendingIce = [];
    for (const candidate of pending) {
      try {
        await call.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("Add buffered ICE failed.", error);
      }
    }
  }

  async function handleCallAccept(payload) {
    if (!app.call || app.call.id !== payload.callId || app.call.direction !== "out") return;
    if (app.call.peerId && app.call.peerId !== payload.from) {
      sendCallSignal("reject", {
        roomNo: payload.roomNo,
        callId: payload.callId,
        kind: payload.kind,
        to: payload.from,
        reason: "busy"
      });
      return;
    }
    clearTimeout(app.call.timeout);
    app.call.peerId = payload.from;
    app.call.peerName = payload.fromName || callPeerName(payload.from);
    setCallStatus("正在连接");
    try {
      await prepareCallMedia();
      const pc = ensurePeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendCallSignal("offer", {
        roomNo: app.call.roomNo,
        callId: app.call.id,
        kind: app.call.kind,
        to: payload.from,
        description: pc.localDescription
      });
    } catch (error) {
      console.warn("Create call offer failed.", error);
      sendCallSignal("hangup", { roomNo: payload.roomNo, callId: payload.callId, kind: payload.kind, to: payload.from });
      finishCall("无法建立通话", 1200);
    }
  }

  async function handleCallOffer(payload) {
    if (!app.call || app.call.id !== payload.callId || app.call.direction !== "in") return;
    if (payload.from !== app.call.peerId) return;
    try {
      await prepareCallMedia();
      const pc = ensurePeerConnection();
      await pc.setRemoteDescription(payload.description);
      await flushCallIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendCallSignal("answer", {
        roomNo: app.call.roomNo,
        callId: app.call.id,
        kind: app.call.kind,
        to: payload.from,
        description: pc.localDescription
      });
      setCallStatus("正在连接");
    } catch (error) {
      console.warn("Handle call offer failed.", error);
      sendCallSignal("hangup", { roomNo: payload.roomNo, callId: payload.callId, kind: payload.kind, to: payload.from });
      finishCall("无法建立通话", 1200);
    }
  }

  async function handleCallAnswer(payload) {
    if (!app.call || app.call.id !== payload.callId || app.call.direction !== "out") return;
    if (payload.from !== app.call.peerId) return;
    try {
      const pc = ensurePeerConnection();
      await pc.setRemoteDescription(payload.description);
      await flushCallIce();
      setCallStatus("正在连接");
    } catch (error) {
      console.warn("Handle call answer failed.", error);
      finishCall("无法建立通话", 1200);
    }
  }

  async function handleCallIce(payload) {
    if (!app.call || app.call.id !== payload.callId) return;
    if (app.call.peerId && payload.from !== app.call.peerId) return;
    if (!payload.candidate) return;
    try {
      const candidate = new RTCIceCandidate(payload.candidate);
      const pc = ensurePeerConnection();
      if (!pc.remoteDescription) {
        app.call.pendingIce = app.call.pendingIce || [];
        app.call.pendingIce.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("Handle call ICE failed.", error);
    }
  }

  function showIncomingCall(payload) {
    const label = callKindLabel(payload.kind);
    const name = callPeerName(payload.from, payload.fromName);
    $("mbox").innerHTML = `<h3>${esc(name)}邀请${esc(label)}聊天</h3>
      <div class="muted">接听后会使用本设备的${payload.kind === "video" ? "摄像头和麦克风" : "麦克风"}</div>
      <div class="actions">
        <button class="btn" type="button" id="callRejectBtn">拒绝</button>
        <button class="btn primary" type="button" id="callAcceptBtn">接听</button>
      </div>`;
    $("modal").style.display = "flex";
    $("callRejectBtn").addEventListener("click", rejectIncomingCall);
    $("callAcceptBtn").addEventListener("click", acceptIncomingCall);
  }

  function handleCallInvite(payload) {
    if (!app.currentRoom || payload.roomNo !== app.currentRoom.no || !payload.callId) return;
    if (!["audio", "video"].includes(payload.kind)) return;
    if (payload.fromName) rememberRoomProfile(payload.roomNo, payload.from, payload.fromName);
    if (app.call || app.incomingCall) {
      sendCallSignal("reject", {
        roomNo: payload.roomNo,
        callId: payload.callId,
        kind: payload.kind,
        to: payload.from,
        reason: "busy"
      });
      return;
    }
    app.incomingCall = { ...payload, receivedAt: now() };
    showIncomingCall(payload);
  }

  async function acceptIncomingCall() {
    const invite = app.incomingCall;
    if (!invite || app.call) return;
    app.incomingCall = null;
    $("modal").style.display = "none";
    app.call = {
      id: invite.callId,
      kind: invite.kind,
      roomNo: invite.roomNo,
      peerId: invite.from,
      peerName: invite.fromName || callPeerName(invite.from),
      direction: "in",
      status: "正在连接",
      pendingIce: [],
      audioMuted: false,
      videoOff: false
    };
    renderCallOverlay();
    try {
      await prepareCallMedia();
      ensurePeerConnection();
      sendCallSignal("accept", { roomNo: invite.roomNo, callId: invite.callId, kind: invite.kind, to: invite.from });
    } catch (error) {
      console.warn("Accept call failed.", error);
      sendCallSignal("reject", { roomNo: invite.roomNo, callId: invite.callId, kind: invite.kind, to: invite.from, reason: "media" });
      finishCall("无法打开设备", 1200);
    }
  }

  function rejectIncomingCall() {
    const invite = app.incomingCall;
    app.incomingCall = null;
    $("modal").style.display = "none";
    if (!invite) return;
    sendCallSignal("reject", { roomNo: invite.roomNo, callId: invite.callId, kind: invite.kind, to: invite.from });
  }

  function handleCallHangup(payload) {
    if (app.incomingCall?.callId === payload.callId) {
      app.incomingCall = null;
      $("modal").style.display = "none";
      return;
    }
    if (!app.call || app.call.id !== payload.callId) return;
    finishCall("对方已挂断", 900);
  }

  function handleCallReject(payload) {
    if (!app.call || app.call.id !== payload.callId || app.call.direction !== "out") return;
    if (app.call.peerId && app.call.peerId !== payload.from) return;
    finishCall(payload.reason === "busy" ? "对方忙线" : "对方已拒绝", 900);
  }

  function handleCallSignal(payload) {
    if (!payload || ownSender(payload.from)) return;
    if (payload.to && !ownSender(payload.to)) return;
    if (!app.currentRoom || (payload.roomNo && payload.roomNo !== app.currentRoom.no)) return;
    if (payload.fromName) rememberRoomProfile(app.currentRoom.no, payload.from, payload.fromName);
    if (payload.signal === "invite") handleCallInvite(payload);
    else if (payload.signal === "accept") handleCallAccept(payload);
    else if (payload.signal === "reject") handleCallReject(payload);
    else if (payload.signal === "hangup") handleCallHangup(payload);
    else if (payload.signal === "offer") handleCallOffer(payload);
    else if (payload.signal === "answer") handleCallAnswer(payload);
    else if (payload.signal === "ice") handleCallIce(payload);
  }

  function startCall(kind) {
    closeMediaMenu();
    if (!app.currentRoom) return;
    if (!app.mqttOk) {
      toast("实时连接还在加载中");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      toast("当前浏览器不支持语音视频");
      return;
    }
    if (app.call || app.incomingCall) return;
    const roomNo = app.currentRoom.no;
    const callId = currentUserId() + "_" + now() + "_" + Math.random().toString(36).slice(2, 6);
    app.call = {
      id: callId,
      kind,
      roomNo,
      peerId: "",
      peerName: "",
      direction: "out",
      status: "正在呼叫",
      pendingIce: [],
      audioMuted: false,
      videoOff: false
    };
    app.call.timeout = setTimeout(() => {
      if (app.call?.id === callId && app.call.status === "正在呼叫") {
        sendCallSignal("hangup", { roomNo, callId, kind });
        finishCall("无人接听", 900);
      }
    }, 45000);
    renderCallOverlay();
    sendCallSignal("invite", { roomNo, callId, kind });
  }

  function toggleCallAudio() {
    if (!app.call?.localStream) return;
    app.call.audioMuted = !app.call.audioMuted;
    app.call.localStream.getAudioTracks().forEach(track => {
      track.enabled = !app.call.audioMuted;
    });
    renderCallOverlay();
  }

  function toggleCallVideo() {
    if (!app.call?.localStream || app.call.kind !== "video") return;
    app.call.videoOff = !app.call.videoOff;
    app.call.localStream.getVideoTracks().forEach(track => {
      track.enabled = !app.call.videoOff;
    });
    renderCallOverlay();
  }

  function loadMqtt() {
    if (!app.cfg.mqttUrl) {
      app.mqttOk = false;
      updateStatus();
      return;
    }
    if (window.mqtt) {
      connectMqtt();
      return;
    }
    const script = document.createElement("script");
    script.src = app.cfg.mqttLibUrl || MQTT_LIB_URL;
    script.async = true;
    script.onload = connectMqtt;
    script.onerror = () => {
      app.mqttOk = false;
      updateStatus();
    };
    document.head.appendChild(script);
  }

  function connectMqtt() {
    if (!window.mqtt || !app.cfg.mqttUrl) return;
    try {
      if (app.mqtt) app.mqtt.end(true);
    } catch (error) {
      console.warn("MQTT cleanup failed.", error);
    }

    app.mqtt = mqtt.connect(app.cfg.mqttUrl, {
      username: app.cfg.mqttUser,
      password: app.cfg.mqttPass,
      clientId: "vx_" + app.deviceId + "_" + now(),
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 8000
    });

    app.mqtt.on("connect", () => {
      app.mqttOk = true;
      updateStatus();
      app.mqtt.subscribe(topic("all"));
      app.mqtt.subscribe(topic("presence/all"));
      startGlobalHeartbeat();
      syncRoomMessageSubscriptions();
      if (app.currentRoom) subscribeRoom(app.currentRoom.no);
    });
    app.mqtt.on("close", () => {
      app.mqttOk = false;
      updateStatus();
    });
    app.mqtt.on("error", () => {
      app.mqttOk = false;
      updateStatus();
    });
    app.mqtt.on("message", (name, message) => onMqtt(name, message.toString()));
  }

  function startGlobalHeartbeat() {
    clearInterval(app.globalHeartbeat);
    globalBeat();
    app.globalHeartbeat = setInterval(globalBeat, 8000);
  }

  function globalBeat() {
    publish("presence/all", { id: currentUserId(), time: now(), admin: app.admin });
  }

  function visibleMessageRooms() {
    const rooms = new Set(visibleRooms());
    if (app.currentRoom?.no) rooms.add(app.currentRoom.no);
    return [...rooms].filter(no => app.rooms.some(room => room.no === no && !isOwnerDeleted(room)));
  }

  function syncRoomMessageSubscriptions() {
    if (!app.mqtt || !app.mqttOk) return;
    const wanted = new Set(visibleMessageRooms());
    for (const no of wanted) {
      if (!app.roomSubscriptions.has(no)) {
        app.mqtt.subscribe(topic("room/" + no));
        app.roomSubscriptions.add(no);
      }
    }
    for (const no of [...app.roomSubscriptions]) {
      if (!wanted.has(no)) {
        app.mqtt.unsubscribe(topic("room/" + no));
        app.roomSubscriptions.delete(no);
      }
    }
  }

  function subscribeRoom(no) {
    syncRoomMessageSubscriptions();
    if (app.mqtt && app.mqttOk) {
      if (app.activeRoomSubscription && app.activeRoomSubscription !== no) {
        app.mqtt.unsubscribe(topic("presence/" + app.activeRoomSubscription));
      }
      app.mqtt.subscribe(topic("presence/" + no));
      app.activeRoomSubscription = no;
    }

    clearInterval(app.roomHeartbeat);
    app.roomOnline = {};
    roomBeat();
    app.roomHeartbeat = setInterval(roomBeat, 8000);
  }

  function leaveRoomSubscription() {
    clearInterval(app.roomHeartbeat);
    app.roomHeartbeat = null;
    if (app.mqtt && app.mqttOk && app.activeRoomSubscription) {
      app.mqtt.unsubscribe(topic("presence/" + app.activeRoomSubscription));
    }
    app.activeRoomSubscription = null;
    app.roomOnline = {};
    syncRoomMessageSubscriptions();
  }

  function roomBeat() {
    if (!app.currentRoom) return;
    const nick = roomNickname(app.currentRoom.no);
    publish("presence/" + app.currentRoom.no, {
      id: currentUserId(),
      time: now(),
      admin: app.admin,
      ...(nick ? { nick } : {})
    });
    if (!app.admin) app.roomOnline[currentUserId()] = now();
    tick();
  }

  function roomTopicNo(name) {
    const prefix = topic("room/");
    return name.startsWith(prefix) ? name.slice(prefix.length) : "";
  }

  function handleRoomTopic(roomNo, payload) {
    const current = app.currentRoom?.no === roomNo;
    if (!current && !visibleRooms().includes(roomNo) && !app.admin) return;

    if (payload.type === "message" && payload.message) {
      const message = payload.message;
      const added = addLocalMessage(roomNo, message, false);
      touchRoom(roomNo, message.time);
      if (added && !ownSender(message.sender)) {
        if (current) clearRoomUnread(roomNo);
        else {
          addRoomUnread(roomNo);
          if (!isRoomMuted(roomNo)) playNoticeSound();
        }
      }
      if (current) renderChat();
      else if (!app.currentRoom && app.tab === "hall") renderHall();
      else if (!app.currentRoom && app.admin && app.tab === "me") renderMe();
      return;
    }

    if (payload.type === "profile" && payload.id && payload.nick) {
      if (rememberRoomProfile(roomNo, payload.id, payload.nick) && current) renderChat();
      return;
    }

    if (payload.type === "call") {
      if (current) handleCallSignal(payload);
      return;
    }

    if (payload.type === "roomUpdate") {
      if (payload.action === "clear") {
        localStorage.removeItem(messageKey(roomNo));
        clearRoomUnread(roomNo);
      }
      if (payload.action === "delete" || payload.action === "ownerDelete") {
        if (current) back();
        else if (!app.currentRoom && app.tab === "hall") renderHall();
      } else if (current) renderChat();
      else if (!app.currentRoom && app.tab === "hall") renderHall();
    }
  }

  function onMqtt(name, text) {
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return;
    }

    if (name === topic("all")) {
      if (payload.type === "feedback") {
        if (payload.removeId) removeFeedback(payload.removeId);
        if (payload.feedback) {
          mergeFeedback(payload.feedback);
        }
        if (app.tab === "ann" && !app.currentRoom) renderAnnouncement();
        backgroundRefresh();
        return;
      }
      if (payload.type === "rooms" && payload.room) {
        updateLocalRoom(payload.room);
        if (app.currentRoom?.no === payload.room.no && isOwnerDeleted(payload.room) && !app.admin) back();
        else if (!app.currentRoom) renderCurrentTab();
        backgroundRefresh();
        return;
      }
      if (payload.type === "announcement") {
        if (payload.announcement) mergeAnnouncement(payload.announcement);
        else {
          app.announcements = [];
          app.announcement = null;
          app.activeAnnouncementId = "";
        }
        if (app.tab === "ann" && !app.currentRoom) renderAnnouncement();
        backgroundRefresh();
        return;
      }
      if (payload.type === "delete" && payload.no) {
        app.rooms = app.rooms.filter(room => room.no !== payload.no);
        removeVisibleRoom(payload.no);
        if (app.currentRoom?.no === payload.no) back();
        else if (!app.currentRoom) renderCurrentTab();
        backgroundRefresh();
        return;
      }
      if (["rooms", "announcement", "clear"].includes(payload.type)) backgroundRefresh(100);
      return;
    }

    if (name === topic("presence/all")) {
      if (payload.id) app.globalOnline[payload.id] = now();
      tick();
      return;
    }

    const roomNo = roomTopicNo(name);
    if (roomNo) {
      handleRoomTopic(roomNo, payload);
      return;
    }

    if (app.currentRoom && name === topic("presence/" + app.currentRoom.no)) {
      if (payload.id && !payload.admin) app.roomOnline[payload.id] = now();
      if (payload.id && payload.nick && rememberRoomProfile(app.currentRoom.no, payload.id, payload.nick)) renderChat();
      tick();
    }
  }

  function countFresh(map) {
    const cutoff = now() - 24000;
    let count = 0;
    for (const key of Object.keys(map)) {
      if (map[key] > cutoff) count += 1;
      else delete map[key];
    }
    return count;
  }

  function allCount() {
    app.globalOnline[currentUserId()] = now();
    return countFresh(app.globalOnline);
  }

  function roomCount() {
    if (!app.admin) app.roomOnline[currentUserId()] = now();
    return countFresh(app.roomOnline) || (!app.admin ? 1 : 0);
  }

  function beginBusy(text) {
    const token = ++app.busyToken;
    app.busyText = text;
    tick();
    return token;
  }

  function endBusy(token) {
    if (token === app.busyToken) {
      app.busyText = "";
      tick();
    }
  }

  function tick() {
    const time = new Date().toTimeString().slice(0, 5);
    const online = app.currentRoom ? roomCount() : allCount();
    const needsMqtt = !!app.cfg?.mqttUrl;
    const good = app.gistOk && (!needsMqtt || app.mqttOk);
    const ok = good && !app.busyText;
    const label = ok ? "数据正常" : "数据连接中";
    $("dataBtn").innerHTML = `<span class="dataState">${label}</span><span class="dataMeta">${time} 在线${online}</span>`;
    updateStatus();
  }

  function updateStatus() {
    const needsMqtt = !!app.cfg?.mqttUrl;
    const good = app.gistOk && (!needsMqtt || app.mqttOk);
    $("dataBtn").classList.toggle("busyStatus", !!app.busyText);
    $("dataBtn").classList.toggle("bad", !!app.busyText || !good);
    $("dataBtn").classList.toggle("goodStatus", !app.busyText && good);
  }

  function localJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || json(fallback));
    } catch (error) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, json(value));
  }

  function mutedKey() {
    return "vx_muted_rooms_v1";
  }

  function mutedRooms() {
    return localJson(mutedKey(), []);
  }

  function isRoomMuted(no) {
    return mutedRooms().includes(String(no));
  }

  function setRoomMuted(no, muted) {
    const roomNo = String(no);
    const rooms = new Set(mutedRooms());
    if (muted) rooms.add(roomNo);
    else rooms.delete(roomNo);
    saveJson(mutedKey(), [...rooms]);
    syncPushSubscription().catch(error => console.warn("Push sync failed.", error));
    if (!app.currentRoom && app.tab === "hall") renderHall();
  }

  function unreadKey() {
    return "vx_unread_rooms_v1";
  }

  function unreadRooms() {
    return localJson(unreadKey(), {});
  }

  function roomUnread(no) {
    return Math.max(0, +(unreadRooms()[String(no)] || 0));
  }

  function addRoomUnread(no) {
    const roomNo = String(no);
    const map = unreadRooms();
    map[roomNo] = Math.min(999, Math.max(0, +(map[roomNo] || 0)) + 1);
    saveJson(unreadKey(), map);
    refreshCalcUnreadDisplay();
  }

  function clearRoomUnread(no) {
    const roomNo = String(no);
    const map = unreadRooms();
    if (!(roomNo in map)) return;
    delete map[roomNo];
    saveJson(unreadKey(), map);
    refreshCalcUnreadDisplay();
  }

  function messageKey(no) {
    return "vx_msgs_" + no;
  }

  function nicknameKey(no) {
    return "vx_nick_" + no;
  }

  function profileKey(no) {
    return "vx_profiles_" + no;
  }

  function pendingKey() {
    return "vx_pending_msgs";
  }

  function normalizeNickname(value) {
    return String(value || "").trim().slice(0, 16);
  }

  function normalizeRoomName(value) {
    return String(value || "").trim().slice(0, 24);
  }

  function roomNickname(no) {
    return normalizeNickname(localStorage.getItem(nicknameKey(no)) || "");
  }

  function roomProfiles(no) {
    return localJson(profileKey(no), {});
  }

  function rememberRoomProfile(no, id, nick) {
    const clean = normalizeNickname(nick);
    if (!no || !id || !clean) return false;
    const profiles = roomProfiles(no);
    if (profiles[id] === clean) return false;
    profiles[id] = clean;
    saveJson(profileKey(no), profiles);
    return true;
  }

  function normalizeAccountName(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 11);
  }

  function accountPhoneOk(value) {
    return /^1\d{10}$/.test(String(value || ""));
  }

  function accountPasswordOk(value) {
    return String(value || "").trim().length === 6;
  }

  function accountTip(text, bad) {
    const tip = $("accountTip");
    if (!tip) return;
    tip.textContent = text;
    tip.style.color = bad ? "#fecaca" : "#bbf7d0";
  }

  function accountFields() {
    return {
      username: normalizeAccountName($("accountName")?.value || ""),
      password: ($("accountPassword")?.value || "").trim()
    };
  }

  async function makeAccountAuth(password) {
    const salt = randomBase64(16);
    return {
      authVersion: 1,
      authSalt: salt,
      authHash: await hashRoomPassword(password, salt)
    };
  }

  async function verifyAccountPassword(account, password) {
    if (!account?.authSalt || !account?.authHash) return false;
    return await hashRoomPassword(password, account.authSalt) === account.authHash;
  }

  function accountRecord(account) {
    const copy = { ...account };
    delete copy.cid;
    return copy;
  }

  function accountNicknames() {
    const rooms = new Set(visibleRooms().concat(app.rooms.map(room => room.no)));
    const nicknames = {};
    for (const no of rooms) {
      const nick = roomNickname(no);
      if (nick) nicknames[no] = nick;
    }
    return nicknames;
  }

  function accountSnapshot(base) {
    return accountRecord({
      ...base,
      username: normalizeAccountName(base.username),
      visibleRooms: [...new Set(visibleRooms())],
      nicknames: { ...(base.nicknames || {}), ...accountNicknames() },
      deviceIds: [...new Set([...(base.deviceIds || []), app.deviceId])],
      updatedAt: now()
    });
  }

  function applyAccountData(account) {
    const mergedRooms = [...new Set([...(account.visibleRooms || []), ...visibleRooms()])];
    saveVisibleRooms(mergedRooms);
    for (const [no, nick] of Object.entries(account.nicknames || {})) {
      const clean = normalizeNickname(nick);
      if (clean) localStorage.setItem(nicknameKey(no), clean);
    }
  }

  function setActiveAccount(account, applyData) {
    app.account = accountRecord(account);
    localStorage.vx_account = app.account.username;
    if (applyData) applyAccountData(app.account);
  }

  function restoreAccountSession() {
    const username = normalizeAccountName(localStorage.vx_account || app.account?.username || "");
    if (!username || !app.accounts?.[username]) return;
    setActiveAccount(app.accounts[username], !app.account);
  }

  function postAccount(account) {
    backgroundPostComment(ACCOUNT_PREFIX + json(accountRecord(account)), "Background account sync");
  }

  async function syncAccountNow() {
    if (!app.account) return;
    const snapshot = accountSnapshot(app.account);
    app.account = snapshot;
    app.accounts[snapshot.username] = snapshot;
    postAccount(snapshot);
  }

  async function migrateOwnedRoomsToAccount(oldId, userId) {
    const owned = app.rooms.filter(room => room.owner === oldId);
    if (!owned.length) return;
    for (const room of owned) {
      const updated = {
        ...roomRecord(room),
        owner: userId,
        updatedAt: now()
      };
      updateLocalRoom(updated);
      publish("all", { type: "rooms", room: roomRecord(updated), no: updated.no, time: now() });
      backgroundPostComment(ROOM_PREFIX + json(roomRecord(updated)), "Background room owner sync");
    }
  }

  function scheduleAccountSync() {
    if (!app.account) return;
    clearTimeout(app.accountSyncSoon);
    app.accountSyncSoon = setTimeout(() => {
      syncAccountNow().catch(error => console.warn("Account sync failed.", error));
    }, 1200);
  }

  function localMessages(no) {
    return localJson(messageKey(no), []);
  }

  function legacyMessageId(message) {
    return [message.sender, message.text, message.time].join("|");
  }

  function saveMessages(no, messages) {
    const map = {};
    for (const message of messages) {
      if (message.sender && message.nick) rememberRoomProfile(no, message.sender, message.nick);
      map[message.id || legacyMessageId(message)] = message;
    }
    const sorted = Object.values(map).sort((a, b) => (+a.time) - (+b.time));
    saveJson(messageKey(no), sorted.slice(-1000));
  }

  function addLocalMessage(no, message, pending) {
    if (!message.id) message.id = legacyMessageId(message);
    if (message.sender && message.nick) rememberRoomProfile(no, message.sender, message.nick);
    const messages = localMessages(no);
    let added = false;
    if (!messages.some(item => (item.id || legacyMessageId(item)) === message.id)) {
      messages.push(message);
      saveMessages(no, messages);
      added = true;
    }

    if (pending) {
      const pendingMessages = localJson(pendingKey(), []);
      if (!pendingMessages.some(item => item.id === message.id)) {
        pendingMessages.push({ ...message, roomNo: no });
        saveJson(pendingKey(), pendingMessages);
      }
      scheduleUpload(no);
    }
    return added;
  }

  async function uploadPending(roomNo) {
    const all = localJson(pendingKey(), []);
    if (!all.length || !app.cfg) return;

    const groups = {};
    for (const message of all) {
      if (roomNo && message.roomNo !== roomNo) continue;
      (groups[message.roomNo] || (groups[message.roomNo] = [])).push(message);
    }

    const done = new Set();
    for (const no of Object.keys(groups)) {
      const messages = groups[no];
      if (!messages.length) continue;
      backgroundPostComment(BATCH_PREFIX + no + ":" + json({
        time: now(),
        messages: messages.map(({ roomNo: ignored, ...message }) => message)
      }), "Background message batch");
      messages.forEach(message => done.add(message.id));
    }

    if (done.size) saveJson(pendingKey(), all.filter(message => !done.has(message.id)));
  }

  function scheduleUpload(roomNo) {
    clearTimeout(app.uploadSoon);
    app.uploadSoon = setTimeout(() => uploadPending(roomNo), 12000);
  }

  function mergeGistMessages(no) {
    const add = [];
    for (const comment of app.comments) {
      const body = comment.body || "";
      try {
        if (body.startsWith(MSG_PREFIX + no + ":")) {
          const message = JSON.parse(body.slice((MSG_PREFIX + no + ":").length));
          if (!message.id) message.id = legacyMessageId(message);
          add.push(message);
        } else if (body.startsWith(BATCH_PREFIX + no + ":")) {
          const pack = JSON.parse(body.slice((BATCH_PREFIX + no + ":").length));
          (pack.messages || []).forEach(message => {
            if (!message.id) message.id = legacyMessageId(message);
            add.push(message);
          });
        }
      } catch (error) {
        console.warn("Skipping invalid message pack.", error);
      }
    }
    saveMessages(no, localMessages(no).concat(add));
  }

  function gistMessages(no) {
    const messages = [];
    for (const comment of app.comments) {
      const body = comment.body || "";
      try {
        if (body.startsWith(MSG_PREFIX + no + ":")) {
          messages.push(JSON.parse(body.slice((MSG_PREFIX + no + ":").length)));
        } else if (body.startsWith(BATCH_PREFIX + no + ":")) {
          const pack = JSON.parse(body.slice((BATCH_PREFIX + no + ":").length));
          messages.push(...(pack.messages || []));
        }
      } catch (error) {
        console.warn("Skipping invalid message pack.", error);
      }
    }
    return messages;
  }

  function roomSearchText(room) {
    const messages = localMessages(room.no).concat(gistMessages(room.no));
    return [
      room.no,
      roomName(room),
      ...messages.flatMap(message => [message.text, message.nick, message.sender])
    ].filter(Boolean).join("\n").toLowerCase();
  }

  function matchesRoomSearch(room, query) {
    const clean = String(query || "").trim().toLowerCase();
    return !clean || roomSearchText(room).includes(clean);
  }

  function setMain(html) {
    $("main").innerHTML = html;
  }

  function updateNav() {
    $("nHall").classList.toggle("on", app.tab === "hall");
    $("nAnn").classList.toggle("on", app.tab === "ann");
    $("nMe").classList.toggle("on", app.tab === "me");
  }

  function updateTopControls() {
    const inRoom = !!app.currentRoom;
    $("backBtn").classList.toggle("hide", !inRoom);
    $("shareBtn").classList.toggle("hide", inRoom || !["hall", "me"].includes(app.tab));
    $("systemMsgBtn").classList.toggle("hide", inRoom || app.tab !== "ann");
    $("newBtn").classList.toggle("hide", inRoom || app.tab !== "hall");
    $("roomTag").classList.toggle("hide", !inRoom);
  }

  function renderCurrentTab() {
    if (app.tab === "hall") renderHall();
    else if (app.tab === "ann") renderAnnouncement();
    else renderMe();
  }

  function switchTab(name) {
    document.body.classList.remove("room");
    fixViewport();
    app.tab = name;
    app.currentRoom = null;
    leaveRoomSubscription();
    clearInterval(app.uploadTimer);
    $("send").style.display = "none";
    updateTopControls();
    updateNav();
    renderCurrentTab();
  }

  function visibleRooms() {
    return localJson("vx_visible_rooms", []);
  }

  function saveVisibleRooms(rooms) {
    saveJson("vx_visible_rooms", [...new Set(rooms)]);
  }

  function addVisibleRoom(no) {
    const rooms = visibleRooms();
    if (!rooms.includes(no)) {
      rooms.push(no);
      saveVisibleRooms(rooms);
      syncRoomMessageSubscriptions();
      scheduleAccountSync();
      syncPushSubscription().catch(error => console.warn("Push sync failed.", error));
    }
  }

  function removeVisibleRoom(no) {
    saveVisibleRooms(visibleRooms().filter(item => item !== no));
    syncRoomMessageSubscriptions();
    scheduleAccountSync();
    syncPushSubscription().catch(error => console.warn("Push sync failed.", error));
  }

  function roomName(room) {
    return room.name || room.no;
  }

  function shortTime(value) {
    if (!value) return "";
    const date = new Date(value);
    const todayText = localDay();
    const dayText = localDay(value);
    if (dayText === todayText) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (dayText === localDay(yesterday.getTime())) return "昨天";
    return (date.getMonth() + 1) + "." + date.getDate();
  }

  function latestRoomMessage(room) {
    const messages = localMessages(room.no)
      .concat(gistMessages(room.no))
      .filter(message => message && !message.deletedAt)
      .sort((a, b) => (+(b.time || 0)) - (+(a.time || 0)));
    const latest = messages[0];
    if (!latest) {
      return {
        text: roomName(room) === room.no ? "暂无消息" : roomName(room),
        time: room.updatedAt || room.createdAt
      };
    }
    return {
      text: latest.text || "[消息]",
      time: latest.time || room.updatedAt || room.createdAt
    };
  }

  function isOwnerDeleted(room) {
    return !!(room?.ownerDeletedAt || room?.ownerDeleted);
  }

  function isRoomOwner(room) {
    return !!room && (room.owner === currentUserId() || room.owner === app.deviceId || !!app.account?.deviceIds?.includes(room.owner));
  }

  function roomRecord(room) {
    const copy = { ...room };
    delete copy.cid;
    return copy;
  }

  function sortRooms(rooms) {
    return rooms.sort((a, b) => (+(b.updatedAt || b.createdAt || 0)) - (+(a.updatedAt || a.createdAt || 0)));
  }

  function updateLocalRoom(room) {
    const next = roomRecord(room);
    const index = app.rooms.findIndex(item => item.no === next.no);
    if (index >= 0) app.rooms[index] = { ...app.rooms[index], ...next };
    else app.rooms.push(next);
    sortRooms(app.rooms);
    if (app.currentRoom?.no === next.no) app.currentRoom = { ...app.currentRoom, ...next };
  }

  function touchRoom(no, time) {
    const room = app.rooms.find(item => item.no === no);
    if (!room) return;
    room.updatedAt = Math.max(+(room.updatedAt || 0), +(time || now()));
    sortRooms(app.rooms);
    if (app.currentRoom?.no === no) app.currentRoom = { ...app.currentRoom, ...room };
  }

  function roomAuthStamp(room) {
    return String(room.passUpdatedAt || room.updatedAt || room.createdAt || "");
  }

  function verified(room) {
    return localStorage.getItem("vx_verified_" + room.no) === today() + ":" + roomAuthStamp(room);
  }

  function setVerified(room) {
    localStorage.setItem("vx_verified_" + room.no, today() + ":" + roomAuthStamp(room));
  }

  function accountCanOpenRoom(room) {
    return !!app.account && (app.account.visibleRooms || []).includes(room.no);
  }

  function roomCard(room, isAdmin) {
    const ownerDeleted = isOwnerDeleted(room);
    const latest = latestRoomMessage(room);
    const unread = roomUnread(room.no);
    const muted = isRoomMuted(room.no);
    return `<div class="card roomItem click ${ownerDeleted ? "ownerDeleted" : ""}" data-enter="${esc(room.no)}" data-admin="${isAdmin ? "1" : "0"}">
      <div class="roomInfo">
        <div class="roomTitleLine">
          <div class="title roomNo"><span>${esc(room.no)}</span>${muted ? `<span class="roomMuteMark">静音</span>` : ""}</div>
          <div class="roomRight">${unread ? `<span class="roomUnread">${unread > 99 ? "99+" : unread}</span>` : ""}<div class="roomTime">${esc(shortTime(latest.time))}</div></div>
        </div>
        <div class="muted roomPreview">${esc(latest.text)}</div>
      </div>
      ${isAdmin ? `<div class="actions" data-actions>
        <button class="btn danger" type="button" data-clear-room="${esc(room.no)}">清空聊天记录</button>
        <button class="btn danger" type="button" data-delete-room="${esc(room.no)}">删除房间</button>
      </div>` : ""}
    </div>`;
  }

  function renderHall() {
    const visible = new Set(visibleRooms());
    const list = app.rooms.filter(room => !isOwnerDeleted(room) && visible.has(room.no));
    setMain(`<div class="search">
      <input id="searchInput" placeholder="搜索" autocomplete="off">
      <button class="btn primary" type="button" id="searchBtn">搜索</button>
    </div>
    ${list.length ? list.map(room => roomCard(room, false)).join("") : `<div class="empty">暂无房间</div>`}`);
  }

  async function digestBase64(text) {
    return bytesToBase64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  }

  async function hashRoomPassword(password, salt) {
    return digestBase64(salt + ":" + password);
  }

  function randomBase64(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return bytesToBase64(bytes);
  }

  async function makeRoomAuth(password) {
    const salt = randomBase64(16);
    return {
      passVersion: 1,
      passSalt: salt,
      passHash: await hashRoomPassword(password, salt)
    };
  }

  async function verifyRoomPassword(room, password) {
    if (room.passHash && room.passSalt) {
      return await hashRoomPassword(password, room.passSalt) === room.passHash;
    }
    return password === room.password;
  }

  function claimRoomOwner(room) {
    if (!room || room.owner || app.admin) return room;
    const stamp = now();
    const updated = {
      ...roomRecord(room),
      owner: currentUserId(),
      ownerClaimedAt: stamp,
      updatedAt: stamp
    };
    updateLocalRoom(updated);
    publish("all", { type: "rooms", room: roomRecord(updated), no: updated.no, time: stamp });
    backgroundPostComment(ROOM_PREFIX + json(roomRecord(updated)), "Background room owner claim");
    return updated;
  }

  async function requestEnter(no, isAdmin, remember) {
    let room = app.rooms.find(item => item.no === no);
    if (!room) return toast("未找到房间");
    if (isOwnerDeleted(room) && !isAdmin && !app.admin) return toast("未找到房间");

    if (!isAdmin && !app.admin && !verified(room) && !accountCanOpenRoom(room)) {
      const password = prompt("请输入房间密码");
      if (!(await verifyRoomPassword(room, password || ""))) return toast("密码错误");
      setVerified(room);
    }

    if (!isAdmin && !app.admin && !room.owner) {
      room = claimRoomOwner(room);
      setVerified(room);
    }

    const busy = beginBusy("进入中...");
    try {
      if (remember) addVisibleRoom(no);
      uploadPending();
      enterRoom(no);
    } finally {
      endBusy(busy);
    }
  }

  async function searchRoom() {
    const input = $("searchInput");
    const query = (input?.value || "").trim();
    if (!query) return;

    if (app.cfg.adminPassword && query === app.cfg.adminPassword) {
      app.admin = true;
      switchTab("me");
      return;
    }

    const room = app.rooms.find(item => !isOwnerDeleted(item) && String(item.no).toUpperCase() === query.toUpperCase());
    if (!room) return toast("未找到房间");
    requestEnter(room.no, false, true);
  }

  function generateRoomNo() {
    const used = new Set(app.rooms.map(room => room.no));
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const value = crypto.getRandomValues(new Uint32Array(1))[0] % ROOM_NO_TOTAL;
      const no = String(value).padStart(ROOM_NO_DIGITS, "0");
      if (!used.has(no)) return no;
    }
    for (let value = 0; value < ROOM_NO_TOTAL; value += 1) {
      const no = String(value).padStart(ROOM_NO_DIGITS, "0");
      if (!used.has(no)) return no;
    }
    return "";
  }

  function roomNoStats() {
    const pattern = new RegExp("^\\d{" + ROOM_NO_DIGITS + "}$");
    const used = new Set(app.rooms.map(room => String(room.no)).filter(no => pattern.test(no)));
    const available = Math.max(0, ROOM_NO_TOTAL - used.size);
    const percent = available / ROOM_NO_TOTAL;
    return {
      available,
      total: ROOM_NO_TOTAL,
      percent,
      low: percent < ROOM_NO_LOW_RATIO
    };
  }

  function roomNoExists(no) {
    return app.rooms.some(room => String(room.no) === String(no));
  }

  function askAdminRoomNo() {
    return new Promise(resolve => {
      $("mbox").innerHTML = `<h3>指定房间号</h3>
        <input class="inp" id="adminRoomNoInput" maxlength="${ROOM_NO_DIGITS}" inputmode="numeric" pattern="[0-9]*" placeholder="请输入新的${ROOM_NO_DIGITS}位房间号">
        <div class="muted" id="adminRoomNoTip">房间号范围 0000-9999；房间号会作为默认密码</div>
        <div class="actions">
          <button class="btn" type="button" id="adminRoomNoCancel">取消</button>
          <button class="btn primary" type="button" id="adminRoomNoOk">创建</button>
        </div>`;
      $("modal").style.display = "flex";

      const input = $("adminRoomNoInput");
      const tip = $("adminRoomNoTip");
      const cleanup = value => {
        $("modal").removeEventListener("click", onBackdrop);
        $("modal").style.display = "none";
        resolve(value);
      };
      const submit = () => {
        const value = input.value.replace(/\D/g, "").slice(0, ROOM_NO_DIGITS);
        input.value = value;
        if (!new RegExp("^\\d{" + ROOM_NO_DIGITS + "}$").test(value)) {
          tip.textContent = "房间号需要" + ROOM_NO_DIGITS + "位数字";
          tip.style.color = "#fecaca";
          input.focus();
          return;
        }
        if (roomNoExists(value)) {
          tip.textContent = "房间号已存在，请换一个";
          tip.style.color = "#fecaca";
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onBackdrop = event => {
        if (event.target.id === "modal") cleanup(null);
      };

      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, ROOM_NO_DIGITS);
      });
      $("adminRoomNoCancel").addEventListener("click", () => cleanup(null));
      $("adminRoomNoOk").addEventListener("click", submit);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") cleanup(null);
      });
      $("modal").addEventListener("click", onBackdrop);
      setTimeout(() => input.focus(), 30);
    });
  }

  function askRoomPassword() {
    return new Promise(resolve => {
      $("mbox").innerHTML = `<h3>新建房间</h3>
        <input class="inp" id="roomPasswordInput" type="password" maxlength="6" placeholder="房间密码需要4-6位">
        <div class="muted" id="roomPasswordTip">请输入4-6位房间密码</div>
        <div class="actions">
          <button class="btn" type="button" id="roomPasswordCancel">取消</button>
          <button class="btn primary" type="button" id="roomPasswordOk">创建</button>
        </div>`;
      $("modal").style.display = "flex";

      const input = $("roomPasswordInput");
      const tip = $("roomPasswordTip");
      const cleanup = value => {
        $("modal").removeEventListener("click", onBackdrop);
        $("modal").style.display = "none";
        resolve(value);
      };
      const submit = () => {
        const value = input.value.trim();
        if (value.length < 4 || value.length > 6) {
          tip.textContent = "房间密码需要4-6位";
          tip.style.color = "#fecaca";
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onBackdrop = event => {
        if (event.target.id === "modal") cleanup(null);
      };

      $("roomPasswordCancel").addEventListener("click", () => cleanup(null));
      $("roomPasswordOk").addEventListener("click", submit);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") cleanup(null);
      });
      $("modal").addEventListener("click", onBackdrop);
      setTimeout(() => input.focus(), 30);
    });
  }

  async function newRoom() {
    const customNo = app.admin ? await askAdminRoomNo() : "";
    if (app.admin && !customNo) return;
    const roomPassword = app.admin ? customNo : await askRoomPassword();
    if (!roomPassword) return;
    try {
      const no = customNo || generateRoomNo();
      if (!no) {
        toast("房间号已用完，请增加房间号位数");
        return;
      }
      if (roomNoExists(no)) {
        toast("房间号已存在，请换一个");
        return;
      }
      const stamp = now();
      const room = {
        no,
        name: no,
        createdAt: stamp,
        updatedAt: stamp,
        passUpdatedAt: stamp,
        owner: app.admin ? "" : currentUserId(),
        ...(app.admin ? { adminPreset: true, autoPassword: true } : {}),
        ...(await makeRoomAuth(roomPassword))
      };
      updateLocalRoom(room);
      setVerified(room);
      addVisibleRoom(no);
      renderHall();
      publish("all", { type: "rooms", room: roomRecord(room), no, time: stamp });
      backgroundPostComment(ROOM_PREFIX + json(roomRecord(room)), "Background room create");
      backgroundRefresh();
    } catch (error) {
      console.warn("Create room failed.", error);
      toast("创建失败，请稍后重试");
    }
  }

  function cleanFeedbackText(value) {
    return String(value || "").trim().slice(0, FEEDBACK_MAX_LENGTH);
  }

  function feedbackRecord(item) {
    const copy = { ...item };
    delete copy.cid;
    return copy;
  }

  function ownFeedback(item) {
    const username = normalizeAccountName(app.account?.username || "");
    const deviceIds = app.account?.deviceIds || [];
    return item.sender === currentUserId()
      || item.sender === app.deviceId
      || item.deviceId === app.deviceId
      || (username && normalizeAccountName(item.username) === username)
      || deviceIds.includes(item.sender)
      || deviceIds.includes(item.deviceId);
  }

  function targetFeedback(item) {
    const username = normalizeAccountName(app.account?.username || "");
    const deviceIds = app.account?.deviceIds || [];
    return item.target === currentUserId()
      || item.target === app.deviceId
      || item.targetDeviceId === app.deviceId
      || (username && normalizeAccountName(item.targetUsername) === username)
      || deviceIds.includes(item.target)
      || deviceIds.includes(item.targetDeviceId);
  }

  function visibleFeedback() {
    return app.admin
      ? app.feedback.filter(item => item.role !== "admin")
      : app.feedback.filter(item => item.role === "admin" ? targetFeedback(item) : ownFeedback(item));
  }

  function feedbackTodayCount() {
    const day = localDay();
    return app.feedback.filter(item => item.role !== "admin" && ownFeedback(item) && localDay(item.createdAt || 0) === day).length;
  }

  function feedbackSenderLabel(item) {
    if (item.username) return "手机号 " + normalizeAccountName(item.username);
    return "设备 " + String(item.deviceId || item.sender || "").slice(0, 16);
  }

  function feedbackTitle(item, isAdmin) {
    if (isAdmin) return feedbackSenderLabel(item);
    return item.role === "admin" ? "系统回复" : "我的留言";
  }

  function feedbackItemHtml(item, isAdmin) {
    const active = app.activeFeedbackId === item.id;
    const canReply = isAdmin ? item.role !== "admin" : item.role === "admin";
    return `<div class="feedbackItem ${active ? "activeFeedback" : ""}" data-feedback-id="${esc(item.id)}">
      <div class="feedbackMeta">
        <span>${esc(feedbackTitle(item, isAdmin))}</span>
        <span>${formatTime(item.createdAt)}</span>
      </div>
      <div class="feedbackText">${esc(item.text).replace(/\n/g, "<br>")}</div>
      ${active ? `<div class="actions feedbackActions" data-actions>
        ${canReply ? `<button class="btn primary" type="button" data-feedback-reply="${esc(item.id)}">回复</button>` : ""}
        <button class="btn danger" type="button" data-feedback-delete="${esc(item.id)}">删除</button>
      </div>` : ""}
    </div>`;
  }

  function backgroundPostFeedback(item) {
    backgroundPostComment(FEEDBACK_PREFIX + json(feedbackRecord(item)), "Background feedback upload");
  }

  function backgroundHideFeedback(item) {
    if (!item?.id) return;
    const stamp = now();
    const hidden = {
      ...feedbackRecord(item),
      deletedAt: stamp,
      updatedAt: stamp
    };
    backgroundPostComment(FEEDBACK_PREFIX + json(hidden), "Background feedback hide");
    backgroundDeleteComment(item.cid, "Background feedback delete original");
  }

  function applyFeedbackChange(item, removeItem) {
    if (removeItem) removeFeedback(removeItem.id);
    mergeFeedback(item);
    if (app.tab === "ann" && !app.currentRoom) renderAnnouncement();
    publish("all", {
      type: "feedback",
      feedback: item,
      ...(removeItem ? { removeId: removeItem.id } : {}),
      time: now()
    });
    backgroundPostFeedback(item);
    if (removeItem) backgroundHideFeedback(removeItem);
  }

  function announcementLabel(item) {
    const title = item?.title || "系统公告";
    if (/公告【.+】/.test(title)) return title;
    const date = new Date(item?.time || item?.createdAt || now());
    return (date.getMonth() + 1) + "." + date.getDate() + "公告【" + title + "】";
  }

  function announcementItemHtml(item) {
    const active = app.activeAnnouncementId === item.id;
    const adminTools = app.admin && active
      ? `<div class="actions announcementActions" data-actions>
        <button class="btn primary" type="button" data-ann-edit="${esc(item.id)}">编辑</button>
      </div>`
      : "";
    return `<div class="announcementItem ${active ? "activeAnnouncement" : ""}" data-ann-id="${esc(item.id)}">
      <div class="announcementHead">
        <span>${esc(announcementLabel(item))}</span>
        <span>${formatTime(item.time || item.createdAt)}</span>
      </div>
      ${active ? `<div class="announcementBody">${item.content ? esc(item.content).replace(/\n/g, "<br>") : "暂无内容"}</div>` : ""}
      ${adminTools}
    </div>`;
  }

  function announcementListHtml() {
    const list = app.announcements;
    return `<div class="card">
      <div class="title">公告</div>
      <div class="announcementList">
        ${list.length ? list.map(announcementItemHtml).join("") : `<div class="empty compactEmpty">暂无公告</div>`}
      </div>
    </div>`;
  }

  function renderAnnouncement() {
    const announcementCard = announcementListHtml();

    if (app.admin) {
      const list = visibleFeedback();
      const editing = app.announcements.find(item => item.id === app.editingAnnouncementId);
      setMain(`<div class="card">
        <div class="title">${editing ? "编辑公告" : "公告管理"}</div>
        <div class="muted">${editing ? "正在修改已发布公告，保存后用户看到的是更新后的内容。" : "发布后会在公告页按时间排列，用户点击标题后才会看到内容。"}</div>
        <input class="inp" id="annTitle" placeholder="公告标题，例如：购买" value="${esc(editing?.title || "")}" style="margin-top:12px">
        <textarea id="annContent" placeholder="公告内容">${esc(editing?.content || "")}</textarea>
        <div class="actions">
          <button class="btn primary" type="button" id="saveAnnBtn">${editing ? "保存修改" : "发布公告"}</button>
          ${editing ? `<button class="btn" type="button" id="cancelAnnEditBtn">取消编辑</button>` : ""}
          <button class="btn danger" type="button" id="clearAnnBtn">清空公告</button>
        </div>
      </div>
      ${announcementCard}
      <div class="card">
        <div class="title">用户留言 <span class="badge dangerBadge">仅后台可见</span></div>
        <div class="muted">点击留言可以回复或删除；回复后这条留言会自动隐藏。</div>
        <div class="feedbackList">
          ${list.length ? list.map(item => feedbackItemHtml(item, true)).join("") : `<div class="empty compactEmpty">暂无留言</div>`}
        </div>
      </div>`);
      return;
    }

    const count = feedbackTodayCount();
    const disabled = count >= FEEDBACK_DAILY_LIMIT || app.feedbackSending;
    const feedbackTip = app.feedbackSending ? "发送中..." : `今天已发送 ${count}/${FEEDBACK_DAILY_LIMIT} 条。`;
    const list = visibleFeedback();
    setMain(`${announcementCard}
    <div class="muted contactHint" id="feedbackTip">${feedbackTip} 左上角系统留言仅你和后台可见。</div>
    <div class="card">
      <div class="title">我的留言</div>
      <div class="muted">这里只显示你自己发给后台的留言和后台给你的系统回复；点击系统回复可以继续回复或删除。</div>
      <div class="feedbackList">
        ${list.length ? list.map(item => feedbackItemHtml(item, false)).join("") : `<div class="empty compactEmpty">暂无留言</div>`}
      </div>
    </div>`);
  }

  function askFeedbackReply(title, placeholder) {
    return new Promise(resolve => {
      $("mbox").innerHTML = `<h3>${esc(title)}</h3>
        <textarea id="feedbackReplyInput" maxlength="${FEEDBACK_MAX_LENGTH}" placeholder="${esc(placeholder)}"></textarea>
        <div class="muted" id="feedbackReplyTip">最多${FEEDBACK_MAX_LENGTH}字</div>
        <div class="actions">
          <button class="btn" type="button" id="feedbackReplyCancel">取消</button>
          <button class="btn primary" type="button" id="feedbackReplyOk">回复</button>
        </div>`;
      $("modal").style.display = "flex";

      const input = $("feedbackReplyInput");
      const tip = $("feedbackReplyTip");
      const cleanup = value => {
        $("modal").removeEventListener("click", onBackdrop);
        $("modal").style.display = "none";
        resolve(value);
      };
      const submit = () => {
        const value = cleanFeedbackText(input.value);
        if (!value) {
          tip.textContent = "回复内容不能为空";
          tip.style.color = "#fecaca";
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onBackdrop = event => {
        if (event.target.id === "modal") cleanup("");
      };

      $("feedbackReplyCancel").addEventListener("click", () => cleanup(""));
      $("feedbackReplyOk").addEventListener("click", submit);
      input.addEventListener("keydown", event => {
        if (event.key === "Escape") cleanup("");
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
      });
      $("modal").addEventListener("click", onBackdrop);
      setTimeout(() => input.focus(), 30);
    });
  }

  function askContactMessage() {
    return new Promise(resolve => {
      const count = feedbackTodayCount();
      $("mbox").innerHTML = `<h3>联系客服</h3>
        <textarea id="contactTextInput" maxlength="${FEEDBACK_MAX_LENGTH}" placeholder="输入要发给后台的内容"></textarea>
        <div class="muted" id="contactTextTip">今天已发送 ${count}/${FEEDBACK_DAILY_LIMIT} 条，仅你和后台可见。</div>
        <div class="actions">
          <button class="btn" type="button" id="contactCancelBtn">取消</button>
          <button class="btn primary" type="button" id="contactSendBtn">发送</button>
        </div>`;
      $("modal").style.display = "flex";

      const input = $("contactTextInput");
      const tip = $("contactTextTip");
      const cleanup = value => {
        $("modal").removeEventListener("click", onBackdrop);
        $("modal").style.display = "none";
        resolve(value);
      };
      const submit = () => {
        const value = cleanFeedbackText(input.value);
        if (!value) {
          tip.textContent = "内容不能为空";
          tip.style.color = "#fecaca";
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onBackdrop = event => {
        if (event.target.id === "modal") cleanup("");
      };

      $("contactCancelBtn").addEventListener("click", () => cleanup(""));
      $("contactSendBtn").addEventListener("click", submit);
      input.addEventListener("keydown", event => {
        if (event.key === "Escape") cleanup("");
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
      });
      $("modal").addEventListener("click", onBackdrop);
      setTimeout(() => input.focus(), 30);
    });
  }

  function makeUserFeedback(text, replyTo) {
    const stamp = now();
    return feedbackRecord({
      id: "F_" + stamp + "_" + Math.random().toString(36).slice(2, 8),
      threadId: replyTo?.threadId || replyTo?.id || "",
      replyTo: replyTo?.id || "",
      role: "user",
      sender: currentUserId(),
      deviceId: app.deviceId,
      username: normalizeAccountName(app.account?.username || ""),
      text,
      day: localDay(stamp),
      createdAt: stamp,
      updatedAt: stamp
    });
  }

  function makeAdminFeedback(text, target) {
    const stamp = now();
    return feedbackRecord({
      id: "F_" + stamp + "_" + Math.random().toString(36).slice(2, 8),
      threadId: target?.threadId || target?.id || "",
      replyTo: target?.id || "",
      role: "admin",
      sender: "admin",
      target: target.sender || "",
      targetDeviceId: target.deviceId || "",
      targetUsername: normalizeAccountName(target.username || ""),
      text,
      day: localDay(stamp),
      createdAt: stamp,
      updatedAt: stamp
    });
  }

  async function sendFeedback(textValue) {
    if (app.feedbackSending) return;
    const rawText = textValue !== undefined ? textValue : ($("feedbackText")?.value || "");
    const text = cleanFeedbackText(rawText);
    const tip = $("feedbackTip");
    if (!text) {
      if (tip) tip.textContent = "留言内容不能为空。";
      return;
    }

    if (feedbackTodayCount() >= FEEDBACK_DAILY_LIMIT) {
      if (tip) tip.textContent = "今天已发送 10/10 条，明天可以继续留言。";
      return;
    }

    const item = makeUserFeedback(text);

    app.feedbackSending = true;
    mergeFeedback(item);
    renderAnnouncement();
    publish("all", { type: "feedback", feedback: item, time: now() });

    const releaseSending = () => {
      app.feedbackSending = false;
      if (app.tab === "ann" && !app.currentRoom) renderAnnouncement();
    };

    try {
      backgroundPostFeedback(item);
    } catch (error) {
      console.warn("Send feedback failed.", error);
      if (tip) tip.textContent = "发送失败，请稍后重试。";
    } finally {
      setTimeout(releaseSending, 500);
    }
  }

  async function openContactSupport() {
    if (app.feedbackSending) return;
    if (feedbackTodayCount() >= FEEDBACK_DAILY_LIMIT) {
      toast("今天已发送 10/10 条，明天可以继续留言。");
      return;
    }
    const text = await askContactMessage();
    if (text) sendFeedback(text);
  }

  async function replyFeedback(id) {
    const item = app.feedback.find(entry => entry.id === id);
    if (!item) return;
    const isAdminReply = app.admin && item.role !== "admin";
    const isUserReply = !app.admin && item.role === "admin" && targetFeedback(item);
    if (!isAdminReply && !isUserReply) return;
    if (isUserReply && feedbackTodayCount() >= FEEDBACK_DAILY_LIMIT) {
      toast("今天已发送 10/10 条，明天可以继续留言。");
      return;
    }

    const text = await askFeedbackReply(isAdminReply ? "回复用户留言" : "回复后台", isAdminReply ? "输入给用户的系统回复" : "输入要继续发给后台的内容");
    if (!text) return;

    const reply = isAdminReply ? makeAdminFeedback(text, item) : makeUserFeedback(text, item);
    applyFeedbackChange(reply, item);
  }

  function deleteFeedback(id) {
    const item = app.feedback.find(entry => entry.id === id);
    if (!item) return;
    removeFeedback(id);
    if (app.tab === "ann" && !app.currentRoom) renderAnnouncement();
    publish("all", { type: "feedback", removeId: id, time: now() });
    backgroundHideFeedback(item);
  }

  function editAnnouncement(id) {
    const item = app.announcements.find(entry => entry.id === id);
    if (!item || !app.admin) return;
    app.editingAnnouncementId = id;
    app.activeAnnouncementId = id;
    renderAnnouncement();
    setTimeout(() => $("annTitle")?.focus(), 30);
  }

  function cancelAnnouncementEdit() {
    app.editingAnnouncementId = "";
    renderAnnouncement();
  }

  function pushSettingsHtml() {
    if (!pushConfigured() && !pushEnabled()) return "";
    const enabled = pushEnabled();
    const disabled = app.pushBusy || !pushConfigured() || !pushSupported() || Notification.permission === "denied";
    return `<div class="card">
      <div class="title">系统通知</div>
      <div class="muted">${esc(pushStatusText())}</div>
      <div class="muted">开启后只显示“有个笑话”，不显示房间号和消息内容。</div>
      <div class="actions">
        <button class="btn ${enabled ? "" : "primary"}" type="button" id="pushToggleBtn" ${disabled ? "disabled" : ""}>${enabled ? "关闭通知" : "开启通知"}</button>
      </div>
    </div>`;
  }

  async function saveAnnouncement() {
    try {
      const stamp = now();
      const existing = app.announcements.find(item => item.id === app.editingAnnouncementId);
      const announcement = {
        ...(existing ? announcementRecord(existing) : {}),
        id: existing?.id || ("A_" + stamp + "_" + Math.random().toString(36).slice(2, 8)),
        title: ($("annTitle").value || "系统公告").trim().slice(0, 40),
        content: ($("annContent").value || "").trim(),
        time: existing?.time || stamp,
        createdAt: existing?.createdAt || stamp,
        updatedAt: stamp
      };
      mergeAnnouncement(announcement);
      app.activeAnnouncementId = announcement.id;
      app.editingAnnouncementId = "";
      renderAnnouncement();
      publish("all", { type: "announcement", announcement, time: announcement.time });
      backgroundPostComment(ANN_PREFIX + json(announcementRecord(announcement)), "Background announcement save");
    } catch (error) {
      console.warn("Save announcement failed.", error);
      toast("发布失败，请稍后重试");
    }
  }

  async function clearAnnouncement() {
    if (!confirm("确认清空公告？")) return;
    try {
      app.announcements = [];
      app.announcement = null;
      app.activeAnnouncementId = "";
      app.editingAnnouncementId = "";
      renderAnnouncement();
      publish("all", { type: "announcement", announcement: null, time: now() });
      backgroundDeleteComments("Background announcement clear", body => body.startsWith(ANN_PREFIX));
    } catch (error) {
      console.warn("Clear announcement failed.", error);
      toast("清空失败，请稍后重试");
    }
  }

  function renderAccountPage() {
    const pushSettings = pushSettingsHtml();
    if (app.account) {
      const rooms = visibleRooms().filter(no => app.rooms.some(room => room.no === no && !isOwnerDeleted(room)));
      setMain(`<div class="card">
        <div class="title">账号</div>
        <div class="muted">当前账号：${esc(app.account.username)}</div>
        <div class="muted">已同步房间：${rooms.length}</div>
        <div class="actions">
          <button class="btn primary" type="button" id="accountSyncBtn">同步账号</button>
          <button class="btn" type="button" id="accountLogoutBtn">退出账号</button>
        </div>
        <div class="muted" id="accountTip">换设备时，用这个账号登录即可恢复房间和昵称。</div>
      </div>${pushSettings}`);
      return;
    }

    setMain(`<div class="card">
      <div class="title">账号</div>
      <div class="muted">不注册也可以正常使用；如果以后需要换设备或转移账号，建议绑定手机号和6位密码。</div>
      <input class="inp stackInput" id="accountName" maxlength="11" placeholder="手机号" inputmode="tel" autocomplete="tel">
      <input class="inp stackInput" id="accountPassword" type="password" maxlength="6" placeholder="6位密码" autocomplete="current-password">
      <div class="actions">
        <button class="btn primary" type="button" id="accountLoginBtn">登录</button>
        <button class="btn" type="button" id="accountRegisterBtn">注册</button>
      </div>
      <div class="muted" id="accountTip">注册后会同步当前设备的房间和昵称，换设备登录后自动恢复。</div>
    </div>${pushSettings}`);
  }

  async function registerAccount() {
    const { username, password } = accountFields();
    if (!accountPhoneOk(username)) return accountTip("请输入正确手机号", true);
    if (!accountPasswordOk(password)) return accountTip("密码需要6位", true);

    const busy = beginBusy("同步中...");
    try {
      await loadComments();
      parseComments();
      if (app.accounts[username]) {
        accountTip("账号已存在，请登录", true);
        return;
      }
      const stamp = now();
      const account = accountSnapshot({
        username,
        userId: "A_" + username,
        createdAt: stamp,
        updatedAt: stamp,
        ...(await makeAccountAuth(password))
      });
      postAccount(account);
      setActiveAccount(account, true);
      migrateOwnedRoomsToAccount(app.deviceId, account.userId);
      syncAccountNow();
      publish("all", { type: "rooms", time: now() });
      renderAccountPage();
    } catch (error) {
      console.warn("Register account failed.", error);
      accountTip("注册失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  async function loginAccount() {
    const { username, password } = accountFields();
    if (!accountPhoneOk(username)) return accountTip("请输入正确手机号", true);
    if (!accountPasswordOk(password)) return accountTip("密码需要6位", true);

    const busy = beginBusy("加载中...");
    try {
      await loadComments();
      parseComments();
      const account = app.accounts[username];
      if (!account || !(await verifyAccountPassword(account, password))) {
        accountTip("账号或密码错误", true);
        return;
      }
      setActiveAccount(account, true);
      syncAccountNow();
      renderAccountPage();
    } catch (error) {
      console.warn("Login account failed.", error);
      accountTip("登录失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  async function manualAccountSync() {
    if (!app.account) return;
    const busy = beginBusy("同步中...");
    try {
      syncAccountNow();
      renderAccountPage();
      accountTip("已开始后台同步", false);
    } catch (error) {
      console.warn("Manual account sync failed.", error);
      accountTip("同步失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  function logoutAccount() {
    app.account = null;
    localStorage.removeItem("vx_account");
    renderAccountPage();
  }

  function renderMe() {
    if (!app.admin) {
      renderAccountPage();
      return;
    }
    const stats = roomNoStats();
    const query = String(app.adminSearch || "").trim();
    const rooms = query ? app.rooms.filter(room => matchesRoomSearch(room, query)) : app.rooms;
    const lowRoomNoTip = stats.low
      ? `<div class="card">
        <div class="title">房间号不足</div>
        <div class="muted">4位数字房间号剩余 ${stats.available}/${stats.total}，低于15%。建议增加房间号位数，例如改为5位数字。</div>
      </div>`
      : "";
    setMain(`<div class="card">
      <div class="title">管理后台</div>
      <div class="muted">当前版本：${VERSION}</div>
      <div class="muted">所有房间：${app.rooms.length}</div>
      <div class="muted">4位房间号剩余：${stats.available}/${stats.total}</div>
      <div class="actions"><button class="btn danger" type="button" id="exitAdminBtn">退出管理</button></div>
    </div>
    <div class="search">
      <input id="adminSearchInput" placeholder="搜索房间号或聊天关键词" autocomplete="off" value="${esc(query)}">
      <button class="btn primary" type="button" id="adminSearchBtn">搜索</button>
      ${query ? `<button class="btn" type="button" id="adminSearchClear">清除</button>` : ""}
    </div>
    ${query ? `<div class="muted searchHint">找到 ${rooms.length}/${app.rooms.length} 个房间</div>` : ""}
    ${lowRoomNoTip}
    ${rooms.length ? rooms.map(room => roomCard(room, true)).join("") : `<div class="empty">暂无房间</div>`}`);
  }

  function exitAdmin() {
    app.admin = false;
    switchTab("me");
  }

  function enterRoom(no) {
    const room = app.rooms.find(item => item.no === no);
    if (!room) return;

    app.currentRoom = room;
    app.tab = "room";
    app.chatSearch = "";
    document.body.classList.add("room");
    fixViewport();
    $("roomTag").textContent = "编辑";
    $("roomTag").title = "编辑本房间昵称";
    $("roomTag").style.cursor = "pointer";
    $("roomTag").setAttribute("role", "button");
    $("roomTag").tabIndex = 0;
    updateTopControls();
    $("send").style.display = "flex";
    subscribeRoom(no);
    mergeGistMessages(no);
    clearRoomUnread(no);
    renderChat();
    clearInterval(app.uploadTimer);
    app.uploadTimer = setInterval(() => uploadPending(no), 60000);
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 80);
  }

  function senderName(message, profiles, ownNick) {
    if (ownSender(message.sender)) return ownNick || "我";
    return profiles[message.sender] || normalizeNickname(message.nick) || "用户";
  }

  function renderChat() {
    if (!app.currentRoom) return;
    const all = localMessages(app.currentRoom.no);
    const profiles = roomProfiles(app.currentRoom.no);
    const ownNick = roomNickname(app.currentRoom.no);
    const muted = isRoomMuted(app.currentRoom.no);
    const query = String(app.chatSearch || "").trim();
    const queryLower = query.toLowerCase();
    const list = query
      ? all.filter(message => [message.text, senderName(message, profiles, ownNick), formatTime(message.time)].join("\n").toLowerCase().includes(queryLower))
      : all;
    setMain(`<div class="search chatSearch">
      <input id="chatSearchInput" placeholder="搜索聊天记录" autocomplete="off" value="${esc(query)}">
      <button class="btn primary" type="button" id="chatSearchBtn">搜索</button>
      <button class="btn roomMuteBtn ${muted ? "active" : ""}" type="button" id="chatMuteBtn">${muted ? "已静音" : "静音"}</button>
      ${query ? `<button class="btn" type="button" id="chatSearchClear">清除</button>` : ""}
    </div>
    ${query ? `<div class="muted searchHint">找到 ${list.length}/${all.length} 条消息</div>` : ""}
    <div id="chat">${list.length ? list.map(message => `<div class="msg ${ownSender(message.sender) ? "me" : "other"}">
      <div class="meta">${esc(senderName(message, profiles, ownNick))}</div>
      <div class="bubble">${esc(message.text).replace(/\n/g, "<br>")}</div>
    </div>`).join("") : `<div class="empty">没有匹配的聊天记录</div>`}</div>`);
    tick();
  }

  function applyChatSearch() {
    app.chatSearch = ($("chatSearchInput")?.value || "").trim();
    renderChat();
  }

  function clearChatSearch() {
    app.chatSearch = "";
    renderChat();
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 30);
  }

  function toggleCurrentRoomMute() {
    if (!app.currentRoom) return false;
    const muted = !isRoomMuted(app.currentRoom.no);
    setRoomMuted(app.currentRoom.no, muted);
    renderChat();
    return muted;
  }

  function applyAdminSearch() {
    app.adminSearch = ($("adminSearchInput")?.value || "").trim();
    renderMe();
  }

  function clearAdminSearch() {
    app.adminSearch = "";
    renderMe();
  }

  function back() {
    if (app.currentRoom) uploadPending(app.currentRoom.no);
    closeMediaMenu();
    endCall({ immediate: true });
    app.incomingCall = null;
    app.currentRoom = null;
    app.chatSearch = "";
    leaveRoomSubscription();
    clearInterval(app.uploadTimer);
    $("send").style.display = "none";
    $("backBtn").classList.add("hide");
    $("roomTag").classList.add("hide");
    $("roomTag").textContent = "";
    $("roomTag").removeAttribute("title");
    $("roomTag").removeAttribute("role");
    $("roomTag").removeAttribute("tabindex");
    $("roomTag").style.cursor = "";
    updateTopControls();
    switchTab("hall");
  }

  function editRoomNickname() {
    if (!app.currentRoom) return;
    const roomNo = app.currentRoom.no;
    const owner = isRoomOwner(app.currentRoom);
    const muted = isRoomMuted(roomNo);
    const roomNameTools = owner
      ? `<div class="settingBlock">
        <div class="title smallTitle">房间名</div>
        <input class="inp" id="ownerRoomNameInput" maxlength="24" placeholder="输入房间名" value="${esc(roomName(app.currentRoom))}">
        <div class="muted" id="ownerRoomNameTip"></div>
        <div class="actions">
          <button class="btn primary" type="button" id="ownerRoomNameOk">保存房间名</button>
        </div>
      </div>`
      : "";
    const roomPasswordTools = owner
      ? `<div class="settingBlock">
        <div class="title smallTitle">房间密码</div>
        <input class="inp" id="ownerPasswordInput" type="password" maxlength="6" placeholder="新房间密码需要4-6位">
        <div class="muted" id="ownerPasswordTip"></div>
        <div class="actions">
          <button class="btn primary" type="button" id="ownerPasswordOk">保存密码</button>
        </div>
      </div>`
      : "";
    const roomDeleteTools = owner
      ? `<div class="settingBlock">
        <div class="actions">
          <button class="btn danger" type="button" id="ownerDeleteRoom">删除本房间</button>
        </div>
      </div>`
      : "";
    const adminTools = app.admin
      ? `<div class="settingBlock">
        <div class="title smallTitle">管理员</div>
        <div class="actions">
          <button class="btn danger" type="button" id="adminClearCurrentRoom">删除聊天记录</button>
        </div>
      </div>`
      : "";
    $("mbox").innerHTML = `<h3>房间设置</h3>
      <div class="title smallTitle">我的昵称</div>
      <input class="inp" id="nickInput" maxlength="16" placeholder="输入本房间昵称" value="${esc(roomNickname(roomNo))}">
      <div class="muted" id="nickTip"></div>
      <div class="actions">
        <button class="btn" type="button" id="nickCancel">取消</button>
        <button class="btn primary" type="button" id="nickOk">保存昵称</button>
      </div>
      <div class="settingBlock">
        <div class="title smallTitle">消息提醒</div>
        <div class="actions">
          <button class="btn ${muted ? "" : "primary"}" type="button" id="roomMuteToggle">${muted ? "取消静音" : "本房间静音"}</button>
        </div>
      </div>
      ${roomNameTools}
      ${roomPasswordTools}
      ${adminTools}
      ${roomDeleteTools}`;
    $("modal").style.display = "flex";

    const input = $("nickInput");
    const tip = $("nickTip");
    const close = () => {
      $("modal").removeEventListener("click", onBackdrop);
      $("modal").style.display = "none";
    };
    const submit = () => {
      const nick = normalizeNickname(input.value);
      if (!nick) {
        tip.textContent = "请输入昵称";
        tip.style.color = "#fecaca";
        input.focus();
        return;
      }
      localStorage.setItem(nicknameKey(roomNo), nick);
      rememberRoomProfile(roomNo, currentUserId(), nick);
      scheduleAccountSync();
      publish("room/" + roomNo, { type: "profile", id: currentUserId(), nick, time: now() });
      renderChat();
      close();
    };
    const changePassword = async () => {
      const passInput = $("ownerPasswordInput");
      const passTip = $("ownerPasswordTip");
      if (!passInput || !passTip || !app.currentRoom) return;
      const value = passInput.value.trim();
      if (value.length < 4 || value.length > 6) {
        passTip.textContent = "房间密码需要4-6位";
        passTip.style.color = "#fecaca";
        passInput.focus();
        return;
      }
      await changeCurrentRoomPassword(value, passTip, passInput);
    };
    const changeRoomName = async () => {
      const nameInput = $("ownerRoomNameInput");
      const nameTip = $("ownerRoomNameTip");
      if (!nameInput || !nameTip || !app.currentRoom) return;
      const value = normalizeRoomName(nameInput.value);
      if (!value) {
        nameTip.textContent = "请输入房间名";
        nameTip.style.color = "#fecaca";
        nameInput.focus();
        return;
      }
      await changeCurrentRoomName(value, nameTip, nameInput);
    };
    const onBackdrop = event => {
      if (event.target.id === "modal") close();
    };

    $("nickCancel").addEventListener("click", close);
    $("nickOk").addEventListener("click", submit);
    $("roomMuteToggle").addEventListener("click", () => {
      const mutedNow = !isRoomMuted(roomNo);
      setRoomMuted(roomNo, mutedNow);
      $("roomMuteToggle").textContent = mutedNow ? "取消静音" : "本房间静音";
      $("roomMuteToggle").classList.toggle("primary", !mutedNow);
      renderChat();
    });
    if ($("ownerRoomNameOk")) $("ownerRoomNameOk").addEventListener("click", changeRoomName);
    if ($("ownerPasswordOk")) $("ownerPasswordOk").addEventListener("click", changePassword);
    if ($("ownerDeleteRoom")) $("ownerDeleteRoom").addEventListener("click", () => {
      close();
      ownerDeleteCurrentRoom();
    });
    if ($("adminClearCurrentRoom")) $("adminClearCurrentRoom").addEventListener("click", () => {
      close();
      clearRoom(roomNo);
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") close();
    });
    if ($("ownerPasswordInput")) {
      $("ownerPasswordInput").addEventListener("keydown", event => {
        if (event.key === "Enter") changePassword();
        if (event.key === "Escape") close();
      });
    }
    if ($("ownerRoomNameInput")) {
      $("ownerRoomNameInput").addEventListener("keydown", event => {
        if (event.key === "Enter") changeRoomName();
        if (event.key === "Escape") close();
      });
    }
    $("modal").addEventListener("click", onBackdrop);
    setTimeout(() => input.focus(), 30);
  }

  async function changeCurrentRoomName(name, tip, input) {
    const room = app.currentRoom;
    if (!room || !isRoomOwner(room)) return;
    try {
      const clean = normalizeRoomName(name);
      const stamp = now();
      const updated = {
        ...roomRecord(room),
        name: clean,
        updatedAt: stamp
      };
      updateLocalRoom(updated);
      publish("room/" + updated.no, { type: "roomUpdate", action: "name", time: stamp });
      publish("all", { type: "rooms", room: roomRecord(updated), no: updated.no, time: stamp });
      backgroundPostComment(ROOM_PREFIX + json(roomRecord(updated)), "Background room name");
      backgroundRefresh();
      if (tip) {
        tip.textContent = "房间名已保存";
        tip.style.color = "#bbf7d0";
      }
      if (input) input.value = clean;
    } catch (error) {
      console.warn("Change room name failed.", error);
      if (tip) {
        tip.textContent = "保存失败，请稍后重试";
        tip.style.color = "#fecaca";
      } else {
        toast("保存失败，请稍后重试");
      }
    }
  }

  async function changeCurrentRoomPassword(password, tip, input) {
    const room = app.currentRoom;
    if (!room || !isRoomOwner(room)) return;
    try {
      const stamp = now();
      const updated = {
        ...roomRecord(room),
        ...(await makeRoomAuth(password)),
        passUpdatedAt: stamp,
        updatedAt: stamp
      };
      delete updated.password;
      delete updated.autoPassword;
      updateLocalRoom(updated);
      setVerified(updated);
      publish("room/" + updated.no, { type: "roomUpdate", action: "password", time: now() });
      publish("all", { type: "rooms", room: roomRecord(updated), no: updated.no, time: stamp });
      backgroundPostComment(ROOM_PREFIX + json(roomRecord(updated)), "Background room password");
      backgroundRefresh();
      if (tip) {
        tip.textContent = "密码已更新";
        tip.style.color = "#bbf7d0";
      }
      if (input) input.value = "";
    } catch (error) {
      console.warn("Change room password failed.", error);
      if (tip) {
        tip.textContent = "修改失败，请稍后重试";
        tip.style.color = "#fecaca";
      } else {
        toast("修改失败，请稍后重试");
      }
    }
  }

  async function ownerDeleteCurrentRoom() {
    const room = app.currentRoom;
    if (!room || !isRoomOwner(room)) return;
    const no = room.no;
    const stamp = now();
    const updated = {
      ...roomRecord(room),
      ownerDeleted: true,
      ownerDeletedAt: stamp,
      updatedAt: stamp
    };

    updateLocalRoom(updated);
    removeVisibleRoom(no);
    publish("room/" + no, { type: "roomUpdate", action: "ownerDelete", time: stamp });
    publish("all", { type: "rooms", room: roomRecord(updated), no, time: stamp });
    back();
    backgroundPostComment(ROOM_PREFIX + json(roomRecord(updated)), "Background owner room delete");
    backgroundRefresh();
  }

  async function sendMessage() {
    if (app.sending) return;
    const input = $("msg");
    const text = (input.value || "").trim();
    if (!text || !app.currentRoom) return;

    app.sending = true;
    input.value = "";
    const nick = roomNickname(app.currentRoom.no);
    const sender = currentUserId();
    const message = {
      id: sender + "_" + now() + "_" + Math.random().toString(36).slice(2, 6),
      sender,
      text,
      time: now(),
      ...(nick ? { nick } : {})
    };
    addLocalMessage(app.currentRoom.no, message, true);
    touchRoom(app.currentRoom.no, message.time);
    clearRoomUnread(app.currentRoom.no);
    renderChat();
    publish("room/" + app.currentRoom.no, {
      type: "message",
      roomNo: app.currentRoom.no,
      message,
      time: now()
    });
    notifyPush(app.currentRoom.no, message);
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 60);
    app.sending = false;
  }

  async function clearRoom(no) {
    try {
      const prefixes = [MSG_PREFIX + no + ":", BATCH_PREFIX + no + ":"];
      localStorage.removeItem(messageKey(no));
      saveJson(pendingKey(), localJson(pendingKey(), []).filter(message => message.roomNo !== no));
      if (app.currentRoom?.no === no) renderChat();
      publish("room/" + no, { type: "roomUpdate", action: "clear", time: now() });
      backgroundDeleteComments("Background room clear", body => prefixes.some(prefix => body.startsWith(prefix)));
      backgroundRefresh();
    } catch (error) {
      console.warn("Clear room failed.", error);
      toast("清空失败，请稍后重试");
    }
  }

  async function deleteRoom(no) {
    const oldVisibleRooms = visibleRooms();

    app.rooms = app.rooms.filter(room => room.no !== no);
    localStorage.removeItem(messageKey(no));
    saveVisibleRooms(oldVisibleRooms.filter(item => item !== no));
    saveJson(pendingKey(), localJson(pendingKey(), []).filter(message => message.roomNo !== no));
    if (app.tab === "me") renderMe();
    else if (app.tab === "hall") renderHall();

    publish("room/" + no, { type: "roomUpdate", action: "delete", time: now() });
    publish("all", { type: "delete", no, time: now() });

    const prefixes = [MSG_PREFIX + no + ":", BATCH_PREFIX + no + ":"];
    backgroundDeleteComments("Background room delete", body => {
      if (prefixes.some(prefix => body.startsWith(prefix))) return true;
      if (!body.startsWith(ROOM_PREFIX)) return false;
      try {
        return JSON.parse(body.slice(ROOM_PREFIX.length)).no === no;
      } catch (error) {
        console.warn("Invalid room record.", error);
        return false;
      }
    });
    backgroundRefresh();
    app.currentRoom = null;
    if (app.tab === "me") renderMe();
  }

  function toast(text) {
    $("mbox").innerHTML = `<h3>${esc(text)}</h3><div class="actions"><button class="btn primary" type="button" id="toastOkBtn">确定</button></div>`;
    $("modal").style.display = "flex";
  }

  function closeToast() {
    $("modal").style.display = "none";
  }

  function siteShareUrl() {
    const url = new URL(location.href);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/index\.html$/i, "");
    return url.toString();
  }

  function shareQrSvg(url) {
    if (typeof qrcode !== "function") {
      return `<div class="shareQrFallback">二维码加载中</div>`;
    }
    try {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return qr.createSvgTag({
        cellSize: 6,
        margin: 14,
        scalable: true,
        title: "网页二维码",
        alt: "网页二维码"
      }).replace("<svg", "<svg class=\"shareQr\"");
    } catch (error) {
      console.warn("QR render failed.", error);
      return `<div class="shareQrFallback">无法生成二维码</div>`;
    }
  }

  function showShareQr() {
    const url = siteShareUrl();
    $("mbox").innerHTML = `<h3>分享网页</h3>
      <div class="shareQrWrap">${shareQrSvg(url)}</div>
      <div class="shareUrl">${esc(url)}</div>
      <div class="actions">
        <button class="btn" type="button" id="copyShareBtn">复制链接</button>
        <button class="btn primary" type="button" id="toastOkBtn">关闭</button>
      </div>`;
    $("modal").style.display = "flex";
    const button = $("copyShareBtn");
    if (button) {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(url);
          button.textContent = "已复制";
          setTimeout(() => {
            if ($("copyShareBtn")) $("copyShareBtn").textContent = "复制链接";
          }, 1200);
        } catch (error) {
          console.warn("Copy share link failed.", error);
          button.textContent = "复制失败";
        }
      });
    }
  }

  function fixViewport() {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const rawHeight = Math.round(window.innerHeight || viewport?.height || 0);
    const previousHeight = Math.round(window.__VX_STABLE_APP_HEIGHT__ || rawHeight);
    const inRoom = document.body.classList.contains("room");
    const viewportTop = viewport ? Math.max(0, viewport.offsetTop || 0) : 0;
    const viewportBottom = viewport ? Math.round(viewport.height + viewportTop) : rawHeight;
    let keyboard = inRoom && viewport ? Math.max(0, previousHeight - viewportBottom) : 0;
    if (keyboard < 80) keyboard = 0;

    const shrinkingDuringKeyboard = inRoom && viewport && rawHeight < previousHeight - 80;
    const stableHeight = keyboard || shrinkingDuringKeyboard ? previousHeight : rawHeight;
    window.__VX_STABLE_APP_HEIGHT__ = stableHeight;
    root.style.setProperty("--app-height", stableHeight + "px");
    root.style.setProperty("--kb", keyboard + "px");
    root.style.setProperty("--vtop", keyboard ? viewportTop + "px" : "0px");

    if (scrollX || scrollY) scrollTo(0, 0);
  }

  function settleViewport() {
    [0, 80, 220, 520].forEach(delay => setTimeout(fixViewport, delay));
  }

  function resetViewportHeight() {
    const viewport = window.visualViewport;
    window.__VX_STABLE_APP_HEIGHT__ = Math.round(window.innerHeight || viewport?.height || 0);
    settleViewport();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    return navigator.serviceWorker.register("service-worker.js", { scope: "./" }).catch(error => {
      console.warn("Service worker registration failed.", error);
    });
  }

  function boot() {
    if (app.booted) return;
    app.booted = true;
    registerServiceWorker();
    tick();
    setInterval(tick, 1000);
    refresh("加载中...");
    loadMqtt();
    syncPushSubscription().catch(error => console.warn("Push sync failed.", error));
    scheduleGistQueue(1200);
    app.refreshTimer = setInterval(() => refresh(), 60000);
    app.gistQueueTimer = setInterval(() => {
      processGistQueue().catch(error => console.warn("Gist queue timer failed.", error));
    }, 15000);
    switchTab("hall");

    addEventListener("focusin", settleViewport);
    addEventListener("focusout", settleViewport);
    addEventListener("resize", settleViewport);
    addEventListener("orientationchange", () => setTimeout(resetViewportHeight, 260));
    if (visualViewport) {
      visualViewport.addEventListener("resize", settleViewport);
      visualViewport.addEventListener("scroll", settleViewport);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        uploadPending();
        syncAccountNow().catch(error => console.warn("Account sync failed.", error));
      }
    });
    addEventListener("pagehide", () => {
      uploadPending();
      syncAccountNow().catch(error => console.warn("Account sync failed.", error));
    });
  }

  function bindEvents() {
    document.addEventListener("pointerdown", warmNoticeSound, { once: true, passive: true });

    document.querySelector(".keys").addEventListener("click", event => {
      const button = event.target.closest("button[data-calc]");
      if (!button) return;
      warmNoticeSound();
      const action = button.dataset.calc;
      const value = button.dataset.value;
      if (action === "number") addNumber(value);
      else if (action === "operator") addOperator(value);
      else if (action === "dot") addDot();
      else if (action === "clear") clearCalc();
      else if (action === "backspace") backspaceCalc();
      else if (action === "equals") calculate();
      else if (action === "unlock") unlock();
    });

    $("backBtn").addEventListener("click", back);
    $("newBtn").addEventListener("click", newRoom);
    $("shareBtn").addEventListener("click", showShareQr);
    $("systemMsgBtn").addEventListener("click", openContactSupport);
    $("roomTag").addEventListener("click", editRoomNickname);
    $("roomTag").addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editRoomNickname();
      }
    });
    $("panicBtn").addEventListener("click", panicClose);
    $("send").addEventListener("submit", event => {
      event.preventDefault();
      sendMessage();
    });
    $("mediaBtn").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      toggleMediaMenu();
    });
    $("mediaMenu").addEventListener("click", event => {
      const button = event.target.closest("[data-call-kind]");
      if (!button) return;
      event.preventDefault();
      startCall(button.dataset.callKind);
    });
    document.addEventListener("click", event => {
      if (!event.target.closest("#send")) closeMediaMenu();
    });

    $("nav").addEventListener("click", event => {
      const button = event.target.closest("button[data-tab]");
      if (button) switchTab(button.dataset.tab);
    });

    $("main").addEventListener("click", event => {
      const search = event.target.closest("#searchBtn");
      if (search) {
        searchRoom();
        return;
      }

      const chatSearch = event.target.closest("#chatSearchBtn");
      if (chatSearch) {
        applyChatSearch();
        return;
      }

      const chatSearchClear = event.target.closest("#chatSearchClear");
      if (chatSearchClear) {
        clearChatSearch();
        return;
      }

      const chatMute = event.target.closest("#chatMuteBtn");
      if (chatMute) {
        toggleCurrentRoomMute();
        return;
      }

      const adminSearch = event.target.closest("#adminSearchBtn");
      if (adminSearch) {
        applyAdminSearch();
        return;
      }

      const adminSearchClear = event.target.closest("#adminSearchClear");
      if (adminSearchClear) {
        clearAdminSearch();
        return;
      }

      const accountLogin = event.target.closest("#accountLoginBtn");
      if (accountLogin) {
        loginAccount();
        return;
      }

      const accountRegister = event.target.closest("#accountRegisterBtn");
      if (accountRegister) {
        registerAccount();
        return;
      }

      const accountSync = event.target.closest("#accountSyncBtn");
      if (accountSync) {
        manualAccountSync();
        return;
      }

      const accountLogout = event.target.closest("#accountLogoutBtn");
      if (accountLogout) {
        logoutAccount();
        return;
      }

      const pushToggle = event.target.closest("#pushToggleBtn");
      if (pushToggle) {
        togglePushNotifications();
        return;
      }

      const saveAnn = event.target.closest("#saveAnnBtn");
      if (saveAnn) {
        saveAnnouncement();
        return;
      }

      const clearAnn = event.target.closest("#clearAnnBtn");
      if (clearAnn) {
        clearAnnouncement();
        return;
      }

      const cancelAnnEdit = event.target.closest("#cancelAnnEditBtn");
      if (cancelAnnEdit) {
        cancelAnnouncementEdit();
        return;
      }

      const annEditButton = event.target.closest("[data-ann-edit]");
      if (annEditButton) {
        editAnnouncement(annEditButton.dataset.annEdit);
        return;
      }

      const contactSupportButton = event.target.closest("#contactSupportBtn");
      if (contactSupportButton) {
        openContactSupport();
        return;
      }

      const sendFeedbackButton = event.target.closest("#sendFeedbackBtn");
      if (sendFeedbackButton) {
        sendFeedback();
        return;
      }

      const announcementCard = event.target.closest("[data-ann-id]");
      if (announcementCard && !event.target.closest("[data-actions]")) {
        app.activeAnnouncementId = app.activeAnnouncementId === announcementCard.dataset.annId ? "" : announcementCard.dataset.annId;
        renderAnnouncement();
        return;
      }

      const feedbackReplyButton = event.target.closest("[data-feedback-reply]");
      if (feedbackReplyButton) {
        replyFeedback(feedbackReplyButton.dataset.feedbackReply);
        return;
      }

      const feedbackDeleteButton = event.target.closest("[data-feedback-delete]");
      if (feedbackDeleteButton) {
        deleteFeedback(feedbackDeleteButton.dataset.feedbackDelete);
        return;
      }

      const feedbackCard = event.target.closest("[data-feedback-id]");
      if (feedbackCard && !event.target.closest("[data-actions]")) {
        app.activeFeedbackId = app.activeFeedbackId === feedbackCard.dataset.feedbackId ? "" : feedbackCard.dataset.feedbackId;
        renderAnnouncement();
        return;
      }

      const exitAdminButton = event.target.closest("#exitAdminBtn");
      if (exitAdminButton) {
        exitAdmin();
        return;
      }

      const clearButton = event.target.closest("[data-clear-room]");
      if (clearButton) {
        clearRoom(clearButton.dataset.clearRoom);
        return;
      }

      const deleteButton = event.target.closest("[data-delete-room]");
      if (deleteButton) {
        deleteRoom(deleteButton.dataset.deleteRoom);
        return;
      }

      const card = event.target.closest("[data-enter]");
      if (card && !event.target.closest("[data-actions]")) {
        requestEnter(card.dataset.enter, card.dataset.admin === "1", false);
      }
    });

    $("main").addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target.id === "searchInput") searchRoom();
      if (event.key === "Enter" && event.target.id === "chatSearchInput") applyChatSearch();
      if (event.key === "Enter" && event.target.id === "adminSearchInput") applyAdminSearch();
      if (event.key === "Enter" && event.target.id === "accountPassword") loginAccount();
    });

    $("modal").addEventListener("click", event => {
      if (app.incomingCall && event.target.id === "modal") {
        rejectIncomingCall();
        return;
      }
      if (event.target.id === "modal" || event.target.id === "toastOkBtn") closeToast();
    });
  }

  function startFromBootConfig() {
    if (window.__VX_BOOT_CONFIG__) {
      app.cfg = normalizeConfig(window.__VX_BOOT_CONFIG__);
      app.unlockCode = String(window.__VX_UNLOCK_CODE__ || "");
      delete window.__VX_BOOT_CONFIG__;
      delete window.__VX_UNLOCK_CODE__;
      openApp();
      return;
    }
    showCalc();
  }

  bindEvents();
  startFromBootConfig();
})();
