(function () {
  "use strict";

  const CONFIG_URL = "vx-config.json";
  const APP_CSS = "assets/css/app.css?v=20260517-feedback1";
  const APP_JS = "assets/js/app.js?v=20260517-feedback1";

  let expr = "";
  let loadingApp = false;

  const $ = id => document.getElementById(id);
  const now = () => Date.now();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

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

  async function aesKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 180000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptConfig(code, payload) {
    const encrypted = payload.encryptedConfig || payload;
    const key = await aesKey(code, base64ToBytes(encrypted.salt));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
      key,
      base64ToBytes(encrypted.data)
    );
    return JSON.parse(dec.decode(plain));
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

  async function startApp(config) {
    if (loadingApp) return;
    loadingApp = true;
    window.__VX_BOOT_CONFIG__ = config;
    try {
      await loadStylesheet(APP_CSS);
      await loadScript(APP_JS);
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
    try {
      const response = await fetch(CONFIG_URL + "?t=" + now(), { cache: "no-store" });
      const payload = await response.json();
      for (const code of list) {
        try {
          const config = await decryptConfig(code, payload);
          if (config.token && config.gistId) {
            await startApp(config);
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
