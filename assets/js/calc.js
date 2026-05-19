(function () {
  "use strict";

  const CONFIG_URL = "vx-config.json";
  const APP_CSS = "assets/css/app.css?v=20260520-fastunlock1";
  const QR_JS = "assets/js/qrcode.js?v=20260520-fastunlock1";
  const APP_JS = "assets/js/app.js?v=20260520-fastunlock1";
  const CONFIG_CACHE_KEY = "vx_fast_config_v1";

  let expr = "";
  let loadingApp = false;
  let configPromise = null;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function syncAppHeight() {
    document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
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

  function show() {
    $("disp").textContent = (expr || "0").replaceAll("*", "×").replaceAll("/", "÷").slice(-18);
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

  async function startApp(config, code) {
    if (loadingApp) return;
    loadingApp = true;
    window.__VX_BOOT_CONFIG__ = config;
    window.__VX_UNLOCK_CODE__ = code || "";
    try {
      await Promise.all([
        loadStylesheet(APP_CSS),
        loadScript(QR_JS),
        loadScript(APP_JS)
      ]);
    } catch (error) {
      loadingApp = false;
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
  addEventListener("resize", syncAppHeight);
  addEventListener("orientationchange", () => setTimeout(syncAppHeight, 80));
  if (window.visualViewport) {
    visualViewport.addEventListener("resize", syncAppHeight);
  }

  document.querySelector(".keys").addEventListener("click", event => {
    const button = event.target.closest("button[data-calc]");
    if (!button) return;

    const action = button.dataset.calc;
    const value = button.dataset.value;

    if (action === "number") number(value);
    else if (action === "operator") operator(value);
    else if (action === "dot") dot();
    else if (action === "clear") clear();
    else if (action === "backspace") backspace();
    else if (action === "equals") equals();
    else if (action === "unlock") unlock();
  });

  show();
})();
