(function () {
  "use strict";

  const VERSION = "2026.05.17-cloudflare-v1";
  const CONFIG_URL = "vx-config.json";
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
    adminRooms: [],
    adminStats: null,
    messages: {},
    account: null,
    apiOk: false,
    socket: null,
    socketOk: false,
    socketRoom: null,
    socketTimer: null,
    roomOnlineCount: 1,
    refreshTimer: null,
    sending: false,
    busyText: "",
    busyToken: 0,
    chatSearch: "",
    adminSearch: "",
    deviceId: localStorage.vx_device || ("D" + Math.random().toString(36).slice(2, 12))
  };

  localStorage.vx_device = app.deviceId;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const json = JSON.stringify;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
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
    const apiBase = String(config.apiBase || "").replace(/\/+$/, "");
    const wsBase = String(config.wsBase || apiBase.replace(/^http/i, "ws")).replace(/\/+$/, "");
    return {
      apiBase,
      wsBase,
      appName: config.appName || "VX"
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
          if (config.apiBase) {
            app.cfg = config;
            openApp();
            return;
          }
        } catch (error) {
          // Keep calculator behavior quiet when the suffix is not the secret.
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

  function authHeaders(extra) {
    const token = localStorage.vx_session || "";
    return {
      "Content-Type": "application/json",
      "X-Device-Id": app.deviceId,
      ...(token ? { "Authorization": "Bearer " + token } : {}),
      ...(extra || {})
    };
  }

  async function apiFetch(path, options) {
    const init = options || {};
    const response = await fetch(app.cfg.apiBase + path, {
      ...init,
      headers: authHeaders(init.headers),
      body: init.body && typeof init.body !== "string" ? json(init.body) : init.body
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || ("接口错误 " + response.status));
    app.apiOk = true;
    updateStatus();
    return data;
  }

  function setSession(token) {
    if (token) localStorage.vx_session = token;
  }

  function clearSession() {
    localStorage.removeItem("vx_session");
  }

  function currentUserLabel() {
    if (app.admin) return "管理员";
    if (app.account?.phone) return app.account.phone;
    return "未注册";
  }

  function currentUserId() {
    return app.account?.id || ("G_" + app.deviceId);
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
    const online = app.currentRoom ? app.roomOnlineCount : 1;
    let statusText = `数据 ${time} 在线${online}`;
    if (app.busyText) statusText = app.busyText;
    else if (!app.apiOk || (app.currentRoom && !app.socketOk)) statusText = "数据正在加载中";
    $("dataBtn").innerHTML = `<span class="dot"></span>${statusText}`;
    updateStatus();
  }

  function updateStatus() {
    const bad = !app.apiOk || (app.currentRoom && !app.socketOk);
    $("dataBtn").classList.toggle("busyStatus", !!app.busyText);
    $("dataBtn").classList.toggle("bad", !app.busyText && bad);
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

  function nicknameKey(no) {
    return "vx_nick_" + no;
  }

  function normalizeNickname(value) {
    return String(value || "").trim().slice(0, 16);
  }

  function roomNickname(no) {
    return normalizeNickname(localStorage.getItem(nicknameKey(no)) || "");
  }

  function setRoomNickname(no, nick) {
    const clean = normalizeNickname(nick);
    if (clean) localStorage.setItem(nicknameKey(no), clean);
  }

  function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 11);
  }

  function phoneOk(value) {
    return /^1\d{10}$/.test(value);
  }

  function accountPasswordOk(value) {
    return String(value || "").trim().length === 6;
  }

  function roomPasswordOk(value) {
    const length = String(value || "").trim().length;
    return length >= 4 && length <= 6;
  }

  function localMessages(no) {
    if (app.messages[no]) return app.messages[no];
    app.messages[no] = localJson(messageKey(no), []);
    return app.messages[no];
  }

  function saveMessages(no, messages) {
    const map = {};
    for (const message of messages) map[message.id] = message;
    const sorted = Object.values(map).sort((a, b) => (+a.time) - (+b.time)).slice(-1000);
    app.messages[no] = sorted;
    saveJson(messageKey(no), sorted);
  }

  function addLocalMessage(no, message) {
    if (!message?.id) return;
    const messages = localMessages(no);
    if (!messages.some(item => item.id === message.id)) {
      messages.push(message);
      saveMessages(no, messages);
    }
  }

  function visibleRooms() {
    return app.rooms.map(room => room.no);
  }

  function accountNicknames() {
    const nicknames = {};
    for (const no of visibleRooms()) {
      const nick = roomNickname(no);
      if (nick) nicknames[no] = nick;
    }
    return nicknames;
  }

  function roomName(room) {
    return room?.name || room?.no || "";
  }

  function isOwnerDeleted(room) {
    return !!(room?.ownerDeleted || room?.owner_deleted);
  }

  function isRoomOwner(room) {
    return !!room && (app.admin || room.owner === app.account?.id || room.owner === app.account?.userId);
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

  async function refresh(label) {
    const busy = label ? beginBusy(label) : null;
    try {
      const data = await apiFetch("/me");
      applyMe(data);
      if (app.admin && app.tab === "me") await loadAdminRooms();
      if (!app.currentRoom) renderCurrentTab();
    } catch (error) {
      app.apiOk = false;
      console.warn("Refresh failed.", error);
    } finally {
      if (busy) endBusy(busy);
    }
  }

  function applyMe(data) {
    app.account = data.user?.role === "user" ? data.user : null;
    app.admin = data.user?.role === "admin";
    app.rooms = data.rooms || [];
    for (const room of app.rooms) {
      if (room.nickname) setRoomNickname(room.no, room.nickname);
    }
  }

  async function loadAdminRooms(query) {
    if (!app.admin) return;
    const q = typeof query === "string" ? query : app.adminSearch;
    const data = await apiFetch("/admin/rooms" + (q ? "?search=" + encodeURIComponent(q) : ""));
    app.adminRooms = data.rooms || [];
    app.adminStats = data.stats || null;
  }

  function switchTab(name) {
    document.body.classList.remove("room");
    fixViewport();
    closeRoomSocket();
    app.tab = name;
    app.currentRoom = null;
    app.chatSearch = "";
    $("send").style.display = "none";
    $("backBtn").classList.add("hide");
    $("roomTag").classList.add("hide");
    $("newBtn").classList.toggle("hide", name !== "hall");
    updateNav();
    if (name === "me" && app.admin) {
      loadAdminRooms().then(renderMe).catch(error => {
        console.warn("Admin rooms failed.", error);
        renderMe();
      });
    } else {
      renderCurrentTab();
    }
  }

  function roomCard(room, isAdmin) {
    const ownerDeleted = isOwnerDeleted(room);
    return `<div class="card click ${ownerDeleted ? "ownerDeleted" : ""}" data-enter="${esc(room.no)}" data-admin="${isAdmin ? "1" : "0"}">
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
    const list = app.rooms.filter(room => !isOwnerDeleted(room));
    setMain(`<div class="search">
      <input id="searchInput" placeholder="请输入房间号" inputmode="numeric" maxlength="6" autocomplete="off">
      <button class="btn primary" type="button" id="searchBtn">搜索</button>
    </div>
    ${list.length ? list.map(room => roomCard(room, false)).join("") : `<div class="empty">暂无房间</div>`}`);
  }

  function renderAnnouncement() {
    setMain(`<div class="card">
      <div class="title">公告</div>
      <div class="muted">当前版本：${VERSION}</div>
      <div style="line-height:1.7;margin-top:12px">谢谢使用。</div>
    </div>`);
  }

  function renderAccountPage() {
    if (app.account || app.admin) {
      setMain(`<div class="card">
        <div class="title">账号</div>
        <div class="muted">当前账号：${esc(currentUserLabel())}</div>
        <div class="muted">已同步房间：${app.rooms.length}</div>
        <div class="actions">
          <button class="btn primary" type="button" id="accountSyncBtn">同步账号</button>
          <button class="btn" type="button" id="accountLogoutBtn">退出账号</button>
        </div>
        <div class="muted" id="accountTip">换设备时，用这个账号登录即可恢复房间和昵称。</div>
      </div>`);
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
    </div>`);
  }

  function roomNoStats() {
    const stats = app.adminStats || { available: ROOM_NO_TOTAL, total: ROOM_NO_TOTAL };
    return {
      available: stats.available,
      total: stats.total,
      low: stats.available / stats.total < ROOM_NO_LOW_RATIO
    };
  }

  function renderMe() {
    if (!app.admin) {
      renderAccountPage();
      return;
    }
    const stats = roomNoStats();
    const query = String(app.adminSearch || "").trim();
    const lowRoomNoTip = stats.low
      ? `<div class="card">
        <div class="title">房间号不足</div>
        <div class="muted">4位数字房间号剩余 ${stats.available}/${stats.total}，低于15%。建议增加房间号位数，例如改为5位数字。</div>
      </div>`
      : "";
    setMain(`<div class="card">
      <div class="title">管理后台</div>
      <div class="muted">当前版本：${VERSION}</div>
      <div class="muted">所有房间：${app.adminRooms.length}</div>
      <div class="muted">4位房间号剩余：${stats.available}/${stats.total}</div>
      <div class="actions"><button class="btn danger" type="button" id="exitAdminBtn">退出管理</button></div>
    </div>
    <div class="search">
      <input id="adminSearchInput" placeholder="搜索房间号或聊天关键词" autocomplete="off" value="${esc(query)}">
      <button class="btn primary" type="button" id="adminSearchBtn">搜索</button>
      ${query ? `<button class="btn" type="button" id="adminSearchClear">清除</button>` : ""}
    </div>
    ${query ? `<div class="muted searchHint">找到 ${app.adminRooms.length} 个房间</div>` : ""}
    ${lowRoomNoTip}
    ${app.adminRooms.length ? app.adminRooms.map(room => roomCard(room, true)).join("") : `<div class="empty">暂无房间</div>`}`);
  }

  function accountFields() {
    return {
      phone: normalizePhone($("accountName")?.value || ""),
      password: ($("accountPassword")?.value || "").trim()
    };
  }

  function accountTip(text, bad) {
    const tip = $("accountTip");
    if (!tip) return;
    tip.textContent = text;
    tip.style.color = bad ? "#fecaca" : "#bbf7d0";
  }

  async function registerAccount() {
    const { phone, password } = accountFields();
    if (!phoneOk(phone)) return accountTip("请输入正确手机号", true);
    if (!accountPasswordOk(password)) return accountTip("密码需要6位", true);
    const busy = beginBusy("同步中...");
    try {
      const data = await apiFetch("/auth/register", {
        method: "POST",
        body: { phone, password, nicknames: accountNicknames() }
      });
      setSession(data.token);
      applyMe(data);
      renderAccountPage();
    } catch (error) {
      accountTip(error.message || "注册失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  async function loginAccount() {
    const { phone, password } = accountFields();
    if (!phoneOk(phone)) return accountTip("请输入正确手机号", true);
    if (!accountPasswordOk(password)) return accountTip("密码需要6位", true);
    const busy = beginBusy("加载中...");
    try {
      const data = await apiFetch("/auth/login", { method: "POST", body: { phone, password } });
      setSession(data.token);
      applyMe(data);
      renderAccountPage();
    } catch (error) {
      accountTip(error.message || "登录失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  async function tryAdminLogin(password) {
    try {
      const data = await apiFetch("/auth/admin-login", { method: "POST", body: { password } });
      setSession(data.token);
      app.admin = true;
      app.account = null;
      app.rooms = [];
      app.tab = "me";
      $("newBtn").classList.add("hide");
      updateNav();
      await loadAdminRooms();
      renderMe();
      return true;
    } catch (error) {
      return false;
    }
  }

  async function manualAccountSync() {
    const busy = beginBusy("同步中...");
    try {
      const data = await apiFetch("/me");
      applyMe(data);
      renderAccountPage();
    } catch (error) {
      accountTip("同步失败，请稍后重试", true);
    } finally {
      endBusy(busy);
    }
  }

  async function logoutAccount() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn("Logout failed.", error);
    }
    clearSession();
    app.account = null;
    app.admin = false;
    app.rooms = [];
    switchTab("hall");
  }

  function exitAdmin() {
    logoutAccount();
  }

  function askRoomPassword(title, okLabel) {
    return new Promise(resolve => {
      $("mbox").innerHTML = `<h3>${esc(title)}</h3>
        <input class="inp" id="roomPasswordInput" type="password" maxlength="6" placeholder="房间密码需要4-6位">
        <div class="muted" id="roomPasswordTip">请输入4-6位房间密码</div>
        <div class="actions">
          <button class="btn" type="button" id="roomPasswordCancel">取消</button>
          <button class="btn primary" type="button" id="roomPasswordOk">${esc(okLabel)}</button>
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
        if (!roomPasswordOk(value)) {
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
    const password = await askRoomPassword("新建房间", "创建");
    if (!password) return;
    const busy = beginBusy("创建中...");
    try {
      const data = await apiFetch("/rooms", { method: "POST", body: { password } });
      app.rooms.unshift(data.room);
      enterRoom(data.room, []);
    } catch (error) {
      toast(error.message || "创建失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function searchRoom() {
    const input = $("searchInput");
    const query = (input?.value || "").trim();
    if (!query) return;
    if (await tryAdminLogin(query)) return;
    requestEnter(query.replace(/\D/g, "").slice(0, ROOM_NO_DIGITS), false, true);
  }

  async function requestEnter(no, isAdmin) {
    if (!no) return toast("未找到房间");
    const busy = beginBusy("进入中...");
    try {
      let data;
      try {
        data = await apiFetch("/rooms/" + encodeURIComponent(no) + "/join", { method: "POST", body: {} });
      } catch (error) {
        if (!isAdmin && /密码/.test(error.message)) {
          const password = await askRoomPassword("进入房间", "进入");
          if (!password) return;
          data = await apiFetch("/rooms/" + encodeURIComponent(no) + "/join", { method: "POST", body: { password } });
        } else {
          throw error;
        }
      }
      if (!isAdmin && !app.rooms.some(room => room.no === data.room.no)) app.rooms.unshift(data.room);
      enterRoom(data.room, data.messages || []);
    } catch (error) {
      toast(error.message || "未找到房间");
    } finally {
      endBusy(busy);
    }
  }

  function wsUrl(no) {
    const token = localStorage.vx_session || "";
    return app.cfg.wsBase + "/ws/rooms/" + encodeURIComponent(no)
      + "?token=" + encodeURIComponent(token)
      + "&deviceId=" + encodeURIComponent(app.deviceId);
  }

  function closeRoomSocket() {
    clearTimeout(app.socketTimer);
    app.socketTimer = null;
    if (app.socket) {
      try {
        app.socket.onclose = null;
        app.socket.close();
      } catch (error) {
        console.warn("Socket close failed.", error);
      }
    }
    app.socket = null;
    app.socketOk = false;
    app.socketRoom = null;
    app.roomOnlineCount = 1;
  }

  function connectRoomSocket(no) {
    closeRoomSocket();
    app.socketRoom = no;
    try {
      const socket = new WebSocket(wsUrl(no));
      app.socket = socket;
      socket.onopen = () => {
        app.socketOk = true;
        tick();
      };
      socket.onmessage = event => onSocketMessage(no, event.data);
      socket.onerror = () => {
        app.socketOk = false;
        tick();
      };
      socket.onclose = () => {
        app.socketOk = false;
        tick();
        if (app.currentRoom?.no === no) {
          app.socketTimer = setTimeout(() => connectRoomSocket(no), 1500);
        }
      };
    } catch (error) {
      console.warn("Socket connect failed.", error);
      app.socketOk = false;
      tick();
    }
  }

  function onSocketMessage(no, text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return;
    }

    if (payload.type === "message" && payload.message) {
      addLocalMessage(no, payload.message);
      if (app.currentRoom?.no === no) {
        renderChat();
        setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 30);
      }
      return;
    }

    if (payload.type === "presence") {
      app.roomOnlineCount = Math.max(1, +payload.online || 1);
      tick();
      return;
    }

    if (payload.type === "roomUpdate") {
      if (payload.action === "clear") {
        saveMessages(no, []);
        if (app.currentRoom?.no === no) renderChat();
      } else if (payload.action === "delete" || payload.action === "ownerDelete") {
        app.rooms = app.rooms.filter(room => room.no !== no);
        if (app.currentRoom?.no === no) back();
      }
      return;
    }

    if (payload.type === "profile") {
      renderChat();
    }
  }

  async function enterRoom(room, messages) {
    app.currentRoom = room;
    app.tab = "room";
    app.chatSearch = "";
    app.roomOnlineCount = 1;
    document.body.classList.add("room");
    fixViewport();
    $("backBtn").classList.remove("hide");
    $("roomTag").classList.remove("hide");
    $("roomTag").textContent = "编辑";
    $("roomTag").title = "房间设置";
    $("roomTag").style.cursor = "pointer";
    $("roomTag").setAttribute("role", "button");
    $("roomTag").tabIndex = 0;
    $("newBtn").classList.add("hide");
    $("send").style.display = "flex";
    if (messages?.length) saveMessages(room.no, messages);
    else {
      try {
        const data = await apiFetch("/rooms/" + encodeURIComponent(room.no) + "/messages");
        saveMessages(room.no, data.messages || []);
      } catch (error) {
        console.warn("Load messages failed.", error);
      }
    }
    renderChat();
    connectRoomSocket(room.no);
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 80);
  }

  function senderName(message, ownNick) {
    if (message.sender === currentUserId()) return ownNick || "我";
    return normalizeNickname(message.nick) || "用户";
  }

  function isOwnMessage(message) {
    return message.sender === currentUserId();
  }

  function renderChat() {
    if (!app.currentRoom) return;
    const all = localMessages(app.currentRoom.no);
    const ownNick = roomNickname(app.currentRoom.no);
    const query = String(app.chatSearch || "").trim();
    const queryLower = query.toLowerCase();
    const list = query
      ? all.filter(message => [message.text, senderName(message, ownNick), formatTime(message.time)].join("\n").toLowerCase().includes(queryLower))
      : all;
    setMain(`<div class="search chatSearch">
      <input id="chatSearchInput" placeholder="搜索聊天记录" autocomplete="off" value="${esc(query)}">
      <button class="btn primary" type="button" id="chatSearchBtn">搜索</button>
      ${query ? `<button class="btn" type="button" id="chatSearchClear">清除</button>` : ""}
    </div>
    ${query ? `<div class="muted searchHint">找到 ${list.length}/${all.length} 条消息</div>` : ""}
    <div id="chat">${list.length ? list.map(message => `<div class="msg ${isOwnMessage(message) ? "me" : "other"}">
      <div class="meta">${esc(senderName(message, ownNick))}</div>
      <div class="bubble">${esc(message.text).replace(/\n/g, "<br>")}</div>
    </div>`).join("") : `<div class="empty">${query ? "没有匹配的聊天记录" : "暂无消息"}</div>`}</div>`);
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

  async function applyAdminSearch() {
    app.adminSearch = ($("adminSearchInput")?.value || "").trim();
    const busy = beginBusy("加载中...");
    try {
      await loadAdminRooms(app.adminSearch);
      renderMe();
    } catch (error) {
      toast("搜索失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function clearAdminSearch() {
    app.adminSearch = "";
    await applyAdminSearch();
  }

  function back() {
    closeRoomSocket();
    app.currentRoom = null;
    app.chatSearch = "";
    $("send").style.display = "none";
    $("backBtn").classList.add("hide");
    $("roomTag").classList.add("hide");
    $("roomTag").textContent = "";
    $("roomTag").removeAttribute("title");
    $("roomTag").removeAttribute("role");
    $("roomTag").removeAttribute("tabindex");
    $("roomTag").style.cursor = "";
    switchTab("hall");
  }

  function editRoomSettings() {
    if (!app.currentRoom) return;
    const roomNo = app.currentRoom.no;
    const ownerTools = isRoomOwner(app.currentRoom)
      ? `<div class="settingBlock">
        <div class="title smallTitle">房主设置</div>
        <input class="inp" id="ownerPasswordInput" type="password" maxlength="6" placeholder="新房间密码需要4-6位">
        <div class="muted" id="ownerPasswordTip">修改后，下次进入本房间需要新密码</div>
        <div class="actions">
          <button class="btn primary" type="button" id="ownerPasswordOk">修改密码</button>
          <button class="btn danger" type="button" id="ownerDeleteRoom">删除本房间</button>
        </div>
        <div class="muted">删除后普通用户看不到、搜不到；管理员后台仍可查看。</div>
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
      <input class="inp" id="nickInput" maxlength="16" placeholder="输入本房间昵称" value="${esc(roomNickname(roomNo))}">
      <div class="muted" id="nickTip">只在本房间显示，最多16个字</div>
      <div class="actions">
        <button class="btn" type="button" id="nickCancel">取消</button>
        <button class="btn primary" type="button" id="nickOk">保存</button>
      </div>
      ${ownerTools}
      ${adminTools}`;
    $("modal").style.display = "flex";

    const input = $("nickInput");
    const tip = $("nickTip");
    const close = () => {
      $("modal").removeEventListener("click", onBackdrop);
      $("modal").style.display = "none";
    };
    const saveNick = async () => {
      const nick = normalizeNickname(input.value);
      if (!nick) {
        tip.textContent = "请输入昵称";
        tip.style.color = "#fecaca";
        input.focus();
        return;
      }
      try {
        setRoomNickname(roomNo, nick);
        await apiFetch("/rooms/" + encodeURIComponent(roomNo) + "/nickname", { method: "PATCH", body: { nick } });
        renderChat();
        close();
      } catch (error) {
        tip.textContent = error.message || "保存失败";
        tip.style.color = "#fecaca";
      }
    };
    const changePassword = async () => {
      const passInput = $("ownerPasswordInput");
      const passTip = $("ownerPasswordTip");
      const value = passInput?.value.trim() || "";
      if (!roomPasswordOk(value)) {
        passTip.textContent = "房间密码需要4-6位";
        passTip.style.color = "#fecaca";
        passInput.focus();
        return;
      }
      await changeCurrentRoomPassword(value, passTip, passInput);
    };
    const onBackdrop = event => {
      if (event.target.id === "modal") close();
    };
    $("nickCancel").addEventListener("click", close);
    $("nickOk").addEventListener("click", saveNick);
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
      if (event.key === "Enter") saveNick();
      if (event.key === "Escape") close();
    });
    if ($("ownerPasswordInput")) {
      $("ownerPasswordInput").addEventListener("keydown", event => {
        if (event.key === "Enter") changePassword();
        if (event.key === "Escape") close();
      });
    }
    $("modal").addEventListener("click", onBackdrop);
    setTimeout(() => input.focus(), 30);
  }

  async function changeCurrentRoomPassword(password, tip, input) {
    const room = app.currentRoom;
    if (!room || !isRoomOwner(room)) return;
    const busy = beginBusy("同步中...");
    try {
      const data = await apiFetch("/rooms/" + encodeURIComponent(room.no) + "/password", { method: "PATCH", body: { password } });
      app.currentRoom = data.room;
      const index = app.rooms.findIndex(item => item.no === data.room.no);
      if (index >= 0) app.rooms[index] = data.room;
      if (tip) {
        tip.textContent = "密码已更新";
        tip.style.color = "#bbf7d0";
      }
      if (input) input.value = "";
    } catch (error) {
      if (tip) {
        tip.textContent = error.message || "修改失败，请稍后重试";
        tip.style.color = "#fecaca";
      } else {
        toast("修改失败，请稍后重试");
      }
    } finally {
      endBusy(busy);
    }
  }

  async function ownerDeleteCurrentRoom() {
    const room = app.currentRoom;
    if (!room || !isRoomOwner(room)) return;
    const busy = beginBusy("删除中...");
    try {
      await apiFetch("/rooms/" + encodeURIComponent(room.no) + "/owner-delete", { method: "POST" });
      app.rooms = app.rooms.filter(item => item.no !== room.no);
      back();
    } catch (error) {
      toast(error.message || "删除失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function sendMessage() {
    if (app.sending) return;
    const input = $("msg");
    const text = (input.value || "").trim();
    if (!text || !app.currentRoom) return;
    if (!app.socket || app.socket.readyState !== WebSocket.OPEN) {
      toast("连接中，请稍后再发");
      connectRoomSocket(app.currentRoom.no);
      return;
    }

    app.sending = true;
    input.value = "";
    const message = {
      type: "message",
      id: "M_" + now() + "_" + Math.random().toString(36).slice(2, 8),
      text,
      nick: roomNickname(app.currentRoom.no)
    };
    app.socket.send(json(message));
    setTimeout(() => $("main").scrollTop = $("main").scrollHeight, 60);
    app.sending = false;
  }

  async function clearRoom(no) {
    const busy = beginBusy("清空中...");
    try {
      await apiFetch("/rooms/" + encodeURIComponent(no) + "/messages", { method: "DELETE" });
      saveMessages(no, []);
      if (app.currentRoom?.no === no) renderChat();
    } catch (error) {
      toast(error.message || "清空失败，请稍后重试");
    } finally {
      endBusy(busy);
    }
  }

  async function deleteRoom(no) {
    const busy = beginBusy("删除中...");
    try {
      await apiFetch("/rooms/" + encodeURIComponent(no), { method: "DELETE" });
      app.adminRooms = app.adminRooms.filter(room => room.no !== no);
      app.rooms = app.rooms.filter(room => room.no !== no);
      renderCurrentTab();
    } catch (error) {
      toast(error.message || "删除失败，请稍后重试");
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
    app.refreshTimer = setInterval(() => refresh(), 60000);
    switchTab("hall");

    addEventListener("focusin", fixViewport);
    addEventListener("focusout", () => setTimeout(fixViewport, 120));
    if (visualViewport) {
      visualViewport.addEventListener("resize", fixViewport);
      visualViewport.addEventListener("scroll", fixViewport);
    }
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
    $("roomTag").addEventListener("click", editRoomSettings);
    $("roomTag").addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editRoomSettings();
      }
    });
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
      if (search) return searchRoom();
      const chatSearch = event.target.closest("#chatSearchBtn");
      if (chatSearch) return applyChatSearch();
      const chatSearchClear = event.target.closest("#chatSearchClear");
      if (chatSearchClear) return clearChatSearch();
      const adminSearch = event.target.closest("#adminSearchBtn");
      if (adminSearch) return applyAdminSearch();
      const adminSearchClear = event.target.closest("#adminSearchClear");
      if (adminSearchClear) return clearAdminSearch();
      const accountLogin = event.target.closest("#accountLoginBtn");
      if (accountLogin) return loginAccount();
      const accountRegister = event.target.closest("#accountRegisterBtn");
      if (accountRegister) return registerAccount();
      const accountSync = event.target.closest("#accountSyncBtn");
      if (accountSync) return manualAccountSync();
      const accountLogout = event.target.closest("#accountLogoutBtn");
      if (accountLogout) return logoutAccount();
      const exitAdminButton = event.target.closest("#exitAdminBtn");
      if (exitAdminButton) return exitAdmin();
      const clearButton = event.target.closest("[data-clear-room]");
      if (clearButton) return clearRoom(clearButton.dataset.clearRoom);
      const deleteButton = event.target.closest("[data-delete-room]");
      if (deleteButton) return deleteRoom(deleteButton.dataset.deleteRoom);
      const card = event.target.closest("[data-enter]");
      if (card && !event.target.closest("[data-actions]")) {
        requestEnter(card.dataset.enter, card.dataset.admin === "1");
      }
    });
    $("main").addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target.id === "searchInput") searchRoom();
      if (event.key === "Enter" && event.target.id === "chatSearchInput") applyChatSearch();
      if (event.key === "Enter" && event.target.id === "adminSearchInput") applyAdminSearch();
      if (event.key === "Enter" && event.target.id === "accountPassword") loginAccount();
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
