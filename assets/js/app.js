(function () {
  "use strict";

  const VERSION = "2026.05.17-structured-v2";
  const CONFIG_URL = "vx-config.json";
  const GITHUB_API = "https://api.github.com";
  const MQTT_LIB_URL = "https://unpkg.com/mqtt/dist/mqtt.min.js";
  const ROOM_PREFIX = "VX_ROOM_V1:";
  const MSG_PREFIX = "VX_MSG_V1:";
  const BATCH_PREFIX = "VX_MSG_BATCH_V1:";
  const ANN_PREFIX = "VX_ANN_V1:";
  const DEFAULT_ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const ROOM_NO_DIGITS = 4;
  const ROOM_NO_TOTAL = 10 ** ROOM_NO_DIGITS;
  const ROOM_NO_LOW_RATIO = 0.15;

  const app = {
    cfg: null,
    calcExpr: "",
    booted: false,
    admin: false,
    tab: "hall",
    currentRoom: null,
    rooms: [],
    comments: [],
    announcement: null,
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
    activeRoomSubscription: null,
    sending: false,
    busyText: "",
    busyToken: 0,
    deviceId: localStorage.vx_device || ("U" + Math.random().toString(36).slice(2, 10))
  };

  localStorage.vx_device = app.deviceId;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const json = JSON.stringify;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const today = () => new Date().toISOString().slice(0, 10);
  const esc = value => String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
  const formatTime = value => value ? new Date(value).toLocaleString() : "";

  function showCalc() {
    $("disp").textContent = (app.calcExpr || "0").replaceAll("*", "×").replaceAll("/", "÷").slice(-18);
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

  async function aesKey(password, salt, usage) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 180000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      [usage]
    );
  }

  async function decryptConfig(code, payload) {
    const encrypted = payload.encryptedConfig || payload;
    const key = await aesKey(code, base64ToBytes(encrypted.salt), "decrypt");
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
      mqttLibUrl: config.mqttLibUrl || MQTT_LIB_URL
    };
  }

  async function unlock() {
    const candidates = unlockCandidates();
    if (!candidates.length) return;
    try {
      const response = await fetch(CONFIG_URL + "?t=" + now(), { cache: "no-store" });
      const payload = await response.json();
      for (const code of candidates) {
        try {
          const config = normalizeConfig(await decryptConfig(code, payload));
          if (config.token && config.gistId) {
            app.cfg = config;
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
    $("app").setAttribute("aria-hidden", "false");
    boot();
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

  function parseComments() {
    const roomMap = {};
    app.announcement = null;

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
          const announcement = JSON.parse(body.slice(ANN_PREFIX.length));
          announcement.cid = comment.id;
          if (!app.announcement || +announcement.time > +app.announcement.time) app.announcement = announcement;
        }
      } catch (error) {
        console.warn("Skipping invalid gist comment.", error);
      }
    }

    app.rooms = Object.values(roomMap).sort((a, b) => (+(b.updatedAt || b.createdAt || 0)) - (+(a.updatedAt || a.createdAt || 0)));
  }

  async function refresh(label) {
    const busy = label ? beginBusy(label) : null;
    try {
      await loadComments();
      parseComments();
      app.gistOk = true;
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
    publish("presence/all", { id: app.deviceId, time: now(), admin: app.admin });
  }

  function subscribeRoom(no) {
    if (app.mqtt && app.mqttOk) {
      if (app.activeRoomSubscription && app.activeRoomSubscription !== no) {
        app.mqtt.unsubscribe(topic("room/" + app.activeRoomSubscription));
        app.mqtt.unsubscribe(topic("presence/" + app.activeRoomSubscription));
      }
      app.mqtt.subscribe(topic("room/" + no));
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
      app.mqtt.unsubscribe(topic("room/" + app.activeRoomSubscription));
      app.mqtt.unsubscribe(topic("presence/" + app.activeRoomSubscription));
    }
    app.activeRoomSubscription = null;
    app.roomOnline = {};
  }

  function roomBeat() {
    if (!app.currentRoom) return;
    publish("presence/" + app.currentRoom.no, { id: app.deviceId, time: now(), admin: app.admin });
    if (!app.admin) app.roomOnline[app.deviceId] = now();
    tick();
  }

  function onMqtt(name, text) {
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return;
    }

    if (name === topic("all")) {
      if (["rooms", "announcement", "clear", "delete"].includes(payload.type)) refresh();
      if (payload.type === "delete" && app.currentRoom?.no === payload.no) back();
      return;
    }

    if (name === topic("presence/all")) {
      if (payload.id) app.globalOnline[payload.id] = now();
      tick();
      return;
    }

    if (app.currentRoom && name === topic("room/" + app.currentRoom.no)) {
      if (payload.type === "message" && payload.message) {
        addLocalMessage(payload.roomNo, payload.message, false);
        if (payload.roomNo === app.currentRoom.no) renderChat();
      } else if (payload.type === "roomUpdate") {
        if (payload.action === "clear") localStorage.removeItem(messageKey(app.currentRoom.no));
        if (payload.action === "delete") back();
        else renderChat();
      }
      return;
    }

    if (app.currentRoom && name === topic("presence/" + app.currentRoom.no)) {
      if (payload.id && !payload.admin) app.roomOnline[payload.id] = now();
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
    app.globalOnline[app.deviceId] = now();
    return countFresh(app.globalOnline);
  }

  function roomCount() {
    if (!app.admin) app.roomOnline[app.deviceId] = now();
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
    const time = new Date().toTimeString().slice(0, 8);
    const online = app.currentRoom ? roomCount() : allCount();
    const needsMqtt = !!app.cfg?.mqttUrl;
    const good = app.gistOk && (!needsMqtt || app.mqttOk);
    let statusText = `数据 ${time} 在线${online}`;
    if (app.busyText) statusText = app.busyText;
    else if (!good) statusText = "数据正在加载中";
    $("dataBtn").innerHTML = `<span class="dot"></span>${statusText}`;
    updateStatus();
  }

  function updateStatus() {
    const needsMqtt = !!app.cfg?.mqttUrl;
    const good = app.gistOk && (!needsMqtt || app.mqttOk);
    $("dataBtn").classList.toggle("busyStatus", !!app.busyText);
    $("dataBtn").classList.toggle("bad", !app.busyText && !good);
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

  function messageKey(no) {
    return "vx_msgs_" + no;
  }

  function pendingKey() {
    return "vx_pending_msgs";
  }

  function localMessages(no) {
    return localJson(messageKey(no), []);
  }

  function legacyMessageId(message) {
    return [message.sender, message.text, message.time].join("|");
  }

  function saveMessages(no, messages) {
    const map = {};
    for (const message of messages) map[message.id || legacyMessageId(message)] = message;
    const sorted = Object.values(map).sort((a, b) => (+a.time) - (+b.time));
    saveJson(messageKey(no), sorted.slice(-1000));
  }

  function addLocalMessage(no, message, pending) {
    if (!message.id) message.id = legacyMessageId(message);
    const messages = localMessages(no);
    if (!messages.some(item => (item.id || legacyMessageId(item)) === message.id)) {
      messages.push(message);
      saveMessages(no, messages);
    }

    if (pending) {
      const pendingMessages = localJson(pendingKey(), []);
      if (!pendingMessages.some(item => item.id === message.id)) {
        pendingMessages.push({ ...message, roomNo: no });
        saveJson(pendingKey(), pendingMessages);
      }
      scheduleUpload(no);
    }
  }

  async function uploadPending(roomNo) {
    const all = localJson(pendingKey(), []);
    if (!all.length || !app.cfg) return;
    const busy = app.busyText ? null : beginBusy("同步中...");

    const groups = {};
    try {
      for (const message of all) {
        if (roomNo && message.roomNo !== roomNo) continue;
        (groups[message.roomNo] || (groups[message.roomNo] = [])).push(message);
      }

      const done = new Set();
      for (const no of Object.keys(groups)) {
        const messages = groups[no];
        if (!messages.length) continue;
        try {
          await postComment(BATCH_PREFIX + no + ":" + json({
            time: now(),
            messages: messages.map(({ roomNo: ignored, ...message }) => message)
          }));
          messages.forEach(message => done.add(message.id));
        } catch (error) {
          console.warn("Pending upload failed.", error);
        }
      }

      if (done.size) saveJson(pendingKey(), all.filter(message => !done.has(message.id)));
    } finally {
      if (busy) endBusy(busy);
    }
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

  function setMain(html) {
    $("main").innerHTML = html;
  }

  function updateNav() {
    $("nHall").classList.toggle("on", app.tab === "hall");
    $("nAnn").classList.toggle("on", app.tab === "ann");
    $("nMe").classList.toggle("on", app.tab === "me");
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
    $("backBtn").classList.add("hide");
    $("roomTag").classList.add("hide");
    $("newBtn").classList.toggle("hide", name !== "hall");
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
    }
  }

  function roomName(room) {
    return room.name || room.no;
  }

  function verified(no) {
    return localStorage.getItem("vx_verified_" + no) === today();
  }

  function setVerified(no) {
    localStorage.setItem("vx_verified_" + no, today());
  }

  function roomCard(room, isAdmin) {
    return `<div class="card click" data-enter="${esc(room.no)}" data-admin="${isAdmin ? "1" : "0"}">
      <div class="row">
        <div>
          <div class="title">${esc(room.no)}</div>
          <div class="muted">${esc(roomName(room))} · ${formatTime(room.createdAt)}</div>
        </div>
      </div>
      ${isAdmin ? `<div class="actions" data-actions>
        <button class="btn danger" type="button" data-clear-room="${esc(room.no)}">清空聊天记录</button>
        <button class="btn danger" type="button" data-delete-room="${esc(room.no)}">删除房间</button>
      </div>` : ""}
    </div>`;
  }

  function renderHall() {
    const visible = new Set(visibleRooms());
    const list = app.rooms.filter(room => visible.has(room.no));
    setMain(`<div class="search">
      <input id="searchInput" placeholder="请输入房间号" autocomplete="off">
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

  async function requestEnter(no, isAdmin, remember) {
    const room = app.rooms.find(item => item.no === no);
    if (!room) return toast("未找到房间");

    if (!isAdmin && !app.admin && !verified(no)) {
      const password = prompt("请输入房间密码");
      if (!(await verifyRoomPassword(room, password || ""))) return toast("密码错误");
      setVerified(no);
    }

    const busy = beginBusy("进入中...");
    try {
      if (remember) addVisibleRoom(no);
      await uploadPending();
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

    const room = app.rooms.find(item => String(item.no).toUpperCase() === query.toUpperCase());
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
    const roomPassword = await askRoomPassword();
    if (!roomPassword) return;
    const busy = beginBusy("创建中...");
    try {
      const no = generateRoomNo();
      if (!no) {
        toast("房间号已用完，请增加房间号位数");
        return;
      }
      const room = {
        no,
        name: no,
        createdAt: now(),
        updatedAt: now(),
        owner: app.deviceId,
        ...(await makeRoomAuth(roomPassword))
      };
      await postComment(ROOM_PREFIX + json(room));
      addVisibleRoom(no);
      publish("all", { type: "rooms", no, time: now() });
      await refresh();
    } catch (error) {
      console.warn("Create room failed.", error);
      toast("创建失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  function renderAnnouncement() {
    if (app.admin) {
      setMain(`<div class="card">
        <div class="title">公告管理</div>
        <div class="muted">当前在线用户会通过 MQTT 收到刷新通知。</div>
        <input class="inp" id="annTitle" placeholder="公告标题" value="${esc(app.announcement?.title || "系统公告")}" style="margin-top:12px">
        <textarea id="annContent" placeholder="公告内容">${esc(app.announcement?.content || "")}</textarea>
        <div class="actions">
          <button class="btn primary" type="button" id="saveAnnBtn">发布公告</button>
          <button class="btn danger" type="button" id="clearAnnBtn">清空公告</button>
        </div>
      </div>`);
      return;
    }

    setMain(`<div class="card">
      <div class="title">${esc(app.announcement?.title || "公告")}</div>
      <div style="line-height:1.7;margin-top:12px">${app.announcement?.content ? esc(app.announcement.content).replace(/\n/g, "<br>") : "暂无公告，谢谢使用。"}</div>
      <div class="muted">${app.announcement?.time ? formatTime(app.announcement.time) : ""}</div>
    </div>`);
  }

  async function saveAnnouncement() {
    const busy = beginBusy("发布中...");
    try {
      for (const comment of app.comments) {
        if ((comment.body || "").startsWith(ANN_PREFIX)) await deleteComment(comment.id);
      }
      await postComment(ANN_PREFIX + json({
        title: ($("annTitle").value || "系统公告").trim(),
        content: ($("annContent").value || "").trim(),
        time: now()
      }));
      publish("all", { type: "announcement", time: now() });
      await refresh();
    } catch (error) {
      console.warn("Save announcement failed.", error);
      toast("发布失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function clearAnnouncement() {
    if (!confirm("确认清空公告？")) return;
    const busy = beginBusy("清空中...");
    try {
      for (const comment of app.comments) {
        if ((comment.body || "").startsWith(ANN_PREFIX)) await deleteComment(comment.id);
      }
      publish("all", { type: "announcement", time: now() });
      await refresh();
    } catch (error) {
      console.warn("Clear announcement failed.", error);
      toast("清空失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  function renderMe() {
    if (!app.admin) {
      setMain(`<div class="empty">谢谢使用！</div>`);
      return;
    }
    const stats = roomNoStats();
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
    ${lowRoomNoTip}
    ${app.rooms.length ? app.rooms.map(room => roomCard(room, true)).join("") : `<div class="empty">暂无房间</div>`}`);
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
    document.body.classList.add("room");
    fixViewport();
    $("backBtn").classList.remove("hide");
    $("roomTag").classList.remove("hide");
    $("roomTag").textContent = room.no;
    $("newBtn").classList.add("hide");
    $("send").style.display = "flex";
    subscribeRoom(no);
    mergeGistMessages(no);
    renderChat();
    clearInterval(app.uploadTimer);
    app.uploadTimer = setInterval(() => uploadPending(no), 60000);
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 80);
  }

  function renderChat() {
    if (!app.currentRoom) return;
    const list = localMessages(app.currentRoom.no);
    setMain(`<div id="chat">${list.map(message => `<div class="msg ${message.sender === app.deviceId ? "me" : "other"}">
      <div class="meta">${message.sender === app.deviceId ? "我" : "用户"}</div>
      <div class="bubble">${esc(message.text).replace(/\n/g, "<br>")}</div>
    </div>`).join("")}</div>`);
    tick();
  }

  function back() {
    if (app.currentRoom) uploadPending(app.currentRoom.no);
    app.currentRoom = null;
    leaveRoomSubscription();
    clearInterval(app.uploadTimer);
    $("send").style.display = "none";
    $("backBtn").classList.add("hide");
    $("roomTag").classList.add("hide");
    switchTab("hall");
  }

  async function sendMessage() {
    if (app.sending) return;
    const input = $("msg");
    const text = (input.value || "").trim();
    if (!text || !app.currentRoom) return;

    app.sending = true;
    input.value = "";
    const message = {
      id: app.deviceId + "_" + now() + "_" + Math.random().toString(36).slice(2, 6),
      sender: app.deviceId,
      text,
      time: now()
    };
    addLocalMessage(app.currentRoom.no, message, true);
    renderChat();
    publish("room/" + app.currentRoom.no, {
      type: "message",
      roomNo: app.currentRoom.no,
      message,
      time: now()
    });
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 60);
    app.sending = false;
  }

  async function clearRoom(no) {
    if (!confirm("确认清空该房间聊天记录？")) return;
    const busy = beginBusy("清空中...");
    try {
      const prefixes = [MSG_PREFIX + no + ":", BATCH_PREFIX + no + ":"];
      for (const comment of app.comments) {
        const body = comment.body || "";
        if (prefixes.some(prefix => body.startsWith(prefix))) await deleteComment(comment.id);
      }
      localStorage.removeItem(messageKey(no));
      saveJson(pendingKey(), localJson(pendingKey(), []).filter(message => message.roomNo !== no));
      publish("room/" + no, { type: "roomUpdate", action: "clear", time: now() });
      await refresh();
    } catch (error) {
      console.warn("Clear room failed.", error);
      toast("清空失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function deleteRoom(no) {
    const busy = beginBusy("删除中...");
    const oldRooms = app.rooms.slice();
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
    try {
      for (const comment of app.comments) {
        const body = comment.body || "";
        if (prefixes.some(prefix => body.startsWith(prefix))) await deleteComment(comment.id);
        if (body.startsWith(ROOM_PREFIX)) {
          try {
            if (JSON.parse(body.slice(ROOM_PREFIX.length)).no === no) await deleteComment(comment.id);
          } catch (error) {
            console.warn("Invalid room record.", error);
          }
        }
      }
      app.currentRoom = null;
      await refresh();
      if (app.tab === "me") renderMe();
    } catch (error) {
      console.warn("Delete room failed.", error);
      app.rooms = oldRooms;
      saveVisibleRooms(oldVisibleRooms);
      renderCurrentTab();
      toast("删除失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  function toast(text) {
    $("mbox").innerHTML = `<h3>${esc(text)}</h3><div class="actions"><button class="btn primary" type="button" id="toastOkBtn">确定</button></div>`;
    $("modal").style.display = "flex";
  }

  function closeToast() {
    $("modal").style.display = "none";
  }

  function fixViewport() {
    let keyboard = 0;
    let top = 0;
    if (document.body.classList.contains("room") && window.visualViewport) {
      const viewport = visualViewport;
      keyboard = Math.max(0, innerHeight - viewport.height - viewport.offsetTop);
      top = Math.max(0, viewport.offsetTop);
    }
    document.documentElement.style.setProperty("--kb", keyboard + "px");
    document.documentElement.style.setProperty("--vtop", top + "px");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("service-worker.js", { scope: "./" }).catch(error => {
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
    app.refreshTimer = setInterval(() => refresh(), 60000);
    switchTab("hall");

    addEventListener("focusin", fixViewport);
    addEventListener("focusout", () => setTimeout(fixViewport, 120));
    if (visualViewport) {
      visualViewport.addEventListener("resize", fixViewport);
      visualViewport.addEventListener("scroll", fixViewport);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) uploadPending();
    });
    addEventListener("pagehide", () => uploadPending());
  }

  function bindEvents() {
    document.querySelector(".keys").addEventListener("click", event => {
      const button = event.target.closest("button[data-calc]");
      if (!button) return;
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
    $("panicBtn").addEventListener("click", () => location.reload());
    $("send").addEventListener("submit", event => {
      event.preventDefault();
      sendMessage();
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
    });

    $("modal").addEventListener("click", event => {
      if (event.target.id === "modal" || event.target.id === "toastOkBtn") closeToast();
    });
  }

  function startFromBootConfig() {
    if (window.__VX_BOOT_CONFIG__) {
      app.cfg = normalizeConfig(window.__VX_BOOT_CONFIG__);
      delete window.__VX_BOOT_CONFIG__;
      openApp();
      return;
    }
    showCalc();
  }

  bindEvents();
  startFromBootConfig();
})();
