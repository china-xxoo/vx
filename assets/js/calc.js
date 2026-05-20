(function () {
  "use strict";

  const CONFIG_URL = "vx-config.json";
  const APP_CSS = "assets/css/app.css?v=20260520-unreadcalc1";
  const QR_JS = "assets/js/qrcode.js?v=20260520-unreadcalc1";
  const APP_JS = "assets/js/app.js?v=20260520-unreadcalc1";
  const CONFIG_CACHE_KEY = "vx_fast_config_v1";

  const bootCalc = window.__VX_CALC_BOOT__;
  let expr = bootCalc?.getExpr?.() || "";
  let loadingApp = false;
  let configPromise = null;
  let unreadHintText = "";
  let unreadHintCount = 0;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function syncAppHeight() {
    const visual = window.visualViewport;
    const current = Math.round(window.innerHeight || visual?.height || 0);
    const previous = Math.round(window.__VX_STABLE_APP_HEIGHT__ || current);
    const visualBottom = visual ? Math.round(visual.height + Math.max(0, visual.offsetTop || 0)) : current;
    const keyboardLikely = document.body.classList.contains("room")
      && previous - visualBottom > 80;
    const height = keyboardLikely ? previous : current;
    window.__VX_STABLE_APP_HEIGHT__ = height;
    document.documentElement.style.setProperty("--app-height", height + "px");
  }

  function stableHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function unreadTotal() {
    try {
      const data = JSON.parse(localStorage.getItem("vx_unread_rooms_v1") || "{}");
      return Math.min(999, Object.values(data).reduce((sum, value) => sum + Math.max(0, +value || 0), 0));
    } catch (error) {
      return 0;
    }
  }

  function unreadFormula(total) {
    if (!total) return "0";
    if (total !== unreadHintCount || !unreadHintText) {
      let left = total > 1 ? Math.floor(Math.random() * total) : 0;
      let right = total - left;
      if (total > 1 && left === 0) {
        left = 1;
        right = total - 1;
      }
      unreadHintCount = total;
      unreadHintText = left + "+" + right + "=" + total;
    }
    return unreadHintText;
  }

  function show() {
    $("disp").textContent = (expr || unreadFormula(unreadTotal())).replaceAll("*", "×").replaceAll("/", "÷").slice(-18);
  }

  function number(value) {
    if (expr === "0" || expr === "Error") expr = "";
    expr += value;
    show();
  }

  function operator(value) {
    if (expr === "Error") expr = "";
    if (!expr && value !== "-") return;
    if ("+-*/%".includes(expr.slice(-1))) expr = expr.slice(0, -1);
    expr += value;
    show();
  }

  function dot() {
    const part = expr.split(/[+\-*/%]/).pop();
    if (!part.includes(".")) {
      expr += part ? "." : "0.";
      show();
    }
  }

  function clear() {
    expr = "";
    show();
  }

  function backspace() {
    expr = expr.slice(0, -1);
    show();
  }

  function equals() {
    try {
      if (!expr) return show();
      if (!/^[0-9+\-*/%. ]+$/.test(expr) || "+-*/%.".includes(expr.slice(-1))) throw new Error("bad expression");
      const result = Function("\"use strict\";return(" + expr + ")")();
      expr = Number.isFinite(result) ? String(+result.toFixed(8)) : "Error";
    } catch (error) {
      expr = "Error";
    }
    show();
  }

  function candidates() {
    const match = String(expr || "").match(/(\d+)$/);
    if (!match) return [];
    const tail = match[1].slice(-6);
    const list = [];
    for (let index = 0; index < tail.length; index += 1) list.push(tail.slice(index));
    return list;
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

  async function aesKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iterations || 180000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptConfig(code, payload) {
    const encrypted = payload.encryptedConfig || payload;
    const key = await aesKey(code, base64ToBytes(encrypted.salt), encrypted.iterations || payload.iterations || 180000);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.data)
    );
    return JSON.parse(dec.decode(plain));
  }

  function configValid(config) {
    return !!(config && config.token && config.gistId);
  }

  function configSourceHash(payload) {
    const encrypted = payload?.encryptedConfig || payload || {};
    return stableHash([encrypted.salt, encrypted.iv, encrypted.data, encrypted.iterations].join("|"));
  }

  async function fastCacheKey(code, salt) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode("vx-fast-config:" + code + ":" + bytesToBase64(salt)));
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async function readFastConfig(code) {
    try {
      const cache = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY) || "null");
      if (!cache?.salt || !cache?.iv || !cache?.data) return null;
      const salt = base64ToBytes(cache.salt);
      const key = await fastCacheKey(code, salt);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(cache.iv) }, key, base64ToBytes(cache.data));
      const saved = JSON.parse(dec.decode(plain));
      return configValid(saved.config) ? saved.config : null;
    } catch (error) {
      return null;
    }
  }

  async function writeFastConfig(code, config, sourceHash) {
    try {
      if (!configValid(config)) return;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await fastCacheKey(code, salt);
      const body = enc.encode(JSON.stringify({ config, sourceHash: sourceHash || "", savedAt: now() }));
      const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body);
      localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({
        version: 1,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        data: bytesToBase64(data)
      }));
    } catch (error) {
      console.warn("Unable to save fast config.", error);
    }
  }

  function fetchConfig() {
    if (!configPromise) {
      configPromise = fetch(CONFIG_URL + "?t=" + now(), { cache: "no-store" })
        .then(response => response.json())
        .catch(error => {
          configPromise = null;
          throw error;
        });
    }
    return configPromise;
  }

  async function refreshFastConfig(code) {
    try {
      const payload = await fetchConfig();
      const config = await decryptConfig(code, payload);
      if (configValid(config)) await writeFastConfig(code, config, configSourceHash(payload));
    } catch (error) {
      // Fast unlock should never wait on background cache refresh.
    }
  }

  function loadStylesheet(href) {
    return new Promise((resolve, reject) => {
      if ([...document.styleSheets].some(sheet => sheet.href && sheet.href.includes(href.split("?")[0]))) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  function preloadAsset(href, as) {
    if (document.querySelector(`link[data-vx-preload="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = as;
    link.href = href;
    link.dataset.vxPreload = href;
    document.head.appendChild(link);
  }

  function preloadAppShell() {
    preloadAsset(APP_CSS, "style");
    preloadAsset(QR_JS, "script");
    preloadAsset(APP_JS, "script");
  }

  function ensureInstantShellStyle() {
    if (document.getElementById("vxInstantStyle")) return;
    const style = document.createElement("style");
    style.id = "vxInstantStyle";
    style.textContent = `
      #app.vxInstant{display:block;background:#ededed;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
      #app.vxInstant .top{position:fixed;top:0;right:0;left:0;display:grid;grid-template-columns:78px minmax(0,1fr) 78px;align-items:center;height:calc(54px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 12px 0;border-bottom:1px solid #d9d9d9;background:#ededed}
      #app.vxInstant .left,#app.vxInstant .right{display:flex;min-width:0;align-items:center}
      #app.vxInstant .right{justify-content:flex-end}
      #app.vxInstant .btn{border:0;background:transparent;color:#111;padding:7px 4px;font-size:15px;font-weight:500}
      #app.vxInstant .data{display:flex;min-width:0;align-items:center;justify-content:center;overflow:hidden;border:0;background:transparent;color:#111;padding:0 2px;font-size:14px;font-weight:500;white-space:nowrap}
      #app.vxInstant .dataState{flex:0 0 auto;margin-right:6px;color:#fa5151;font-weight:600}
      #app.vxInstant .dataMeta{min-width:0;overflow:hidden;color:#333;text-overflow:ellipsis;white-space:nowrap}
      #app.vxInstant .main{position:fixed;top:calc(54px + env(safe-area-inset-top));right:0;bottom:calc(58px + env(safe-area-inset-bottom));left:0;overflow:auto;background:#ededed;padding:0}
      #app.vxInstant .search{display:flex;align-items:center;gap:8px;margin:10px 12px}
      #app.vxInstant .search input{width:100%;height:38px;border:0;border-radius:8px;background:#fff;color:#111;padding:0 14px;font-size:16px;text-align:center}
      #app.vxInstant .search .btn{min-width:52px;border-radius:8px;background:#07c160;color:#fff;padding:9px 10px}
      #app.vxInstant .empty{color:#999;padding:56px 10px;text-align:center}
      #app.vxInstant .nav{position:fixed;right:0;bottom:0;left:0;display:grid;grid-template-columns:repeat(3,1fr);height:calc(58px + env(safe-area-inset-bottom));padding:5px 0 env(safe-area-inset-bottom);border-top:1px solid #d8d8d8;background:#f7f7f7}
      #app.vxInstant .nav button{border:0;background:transparent;color:#111;font-size:13px}
      #app.vxInstant .nav button.on{color:#07c160;font-weight:600}
      #app.vxInstant .hide,#app.vxInstant #send{display:none!important}
    `;
    document.head.appendChild(style);
  }

  function showUnlockShell() {
    const appEl = $("app");
    if (!appEl) return;
    ensureInstantShellStyle();
    $("calc").style.display = "none";
    appEl.classList.add("vxInstant");
    appEl.style.display = "block";
    appEl.setAttribute("aria-hidden", "false");
    const time = new Date().toTimeString().slice(0, 5);
    $("dataBtn").innerHTML = `<span class="dataState">数据连接中</span><span class="dataMeta">${time} 在线1</span>`;
    if (!$("main").textContent.trim()) {
      $("main").innerHTML = `<div class="search">
        <input placeholder="搜索" autocomplete="off">
        <button class="btn primary" type="button">搜索</button>
      </div>
      <div class="empty">暂无房间</div>`;
    }
  }

  function hideUnlockShell() {
    const appEl = $("app");
    if (!appEl) return;
    appEl.classList.remove("vxInstant");
    appEl.style.display = "none";
    appEl.setAttribute("aria-hidden", "true");
    $("calc").style.display = "flex";
  }

  async function startApp(config, code) {
    if (loadingApp) return;
    loadingApp = true;
    window.__VX_BOOT_CONFIG__ = config;
    window.__VX_UNLOCK_CODE__ = code || "";
    showUnlockShell();
    try {
      await Promise.all([
        loadStylesheet(APP_CSS),
        loadScript(QR_JS),
        loadScript(APP_JS)
      ]);
    } catch (error) {
      loadingApp = false;
      hideUnlockShell();
      console.warn("Unable to load app shell.", error);
      throw error;
    }
  }

  async function unlock() {
    if (loadingApp) return;
    const list = candidates();
    if (!list.length) return;

    for (const code of list) {
      const cached = await readFastConfig(code);
      if (cached) {
        refreshFastConfig(code);
        await startApp(cached, code);
        return;
      }
    }

    try {
      const payload = await fetchConfig();
      for (const code of list) {
        try {
          const config = await decryptConfig(code, payload);
          if (configValid(config)) {
            await writeFastConfig(code, config, configSourceHash(payload));
            await startApp(config, code);
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

  syncAppHeight();
  fetchConfig().catch(() => {});
  (window.requestIdleCallback || (callback => setTimeout(callback, 300)))(preloadAppShell);
  addEventListener("resize", syncAppHeight);
  addEventListener("orientationchange", () => setTimeout(syncAppHeight, 80));
  if (window.visualViewport) {
    visualViewport.addEventListener("resize", syncAppHeight);
  }

  bootCalc?.stop?.();
  window.__VX_UNLOCK_NOW__ = unlock;
  document.querySelector(".keys").addEventListener("click", event => {
    const button = event.target.closest("button[data-calc]");
    if (!button) return;

    const action = button.dataset.calc;
    const value = button.dataset.value;
    preloadAppShell();

    if (action === "number") number(value);
    else if (action === "operator") operator(value);
    else if (action === "dot") dot();
    else if (action === "clear") clear();
    else if (action === "backspace") backspace();
    else if (action === "equals") equals();
    else if (action === "unlock") unlock();
  });

  show();
  if (window.__VX_PENDING_UNLOCK__) {
    window.__VX_PENDING_UNLOCK__ = false;
    unlock();
  }
})();
