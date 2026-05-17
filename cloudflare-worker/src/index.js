const ROOM_NO_DIGITS = 4;
const ROOM_NO_TOTAL = 10 ** ROOM_NO_DIGITS;
const SESSION_DAYS = 90;
const MAX_MESSAGE_LENGTH = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Device-Id",
  "Access-Control-Max-Age": "86400"
};

const enc = new TextEncoder();

function now() {
  return Date.now();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function empty(status = 204) {
  return new Response(null, { status, headers: CORS });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function cleanPhone(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 11);
}

function validPhone(value) {
  return /^1\d{10}$/.test(value);
}

function cleanPassword(value) {
  return String(value || "").trim();
}

function validAccountPassword(value) {
  return cleanPassword(value).length === 6;
}

function validRoomPassword(value) {
  const length = cleanPassword(value).length;
  return length >= 4 && length <= 6;
}

function cleanRoomNo(value) {
  return String(value || "").replace(/\D/g, "").slice(0, ROOM_NO_DIGITS);
}

function cleanDeviceId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anonymous";
}

function guestId(request) {
  const url = new URL(request.url);
  return "G_" + cleanDeviceId(request.headers.get("X-Device-Id") || url.searchParams.get("deviceId"));
}

function cleanNickname(value) {
  return String(value || "").trim().slice(0, 16);
}

function cleanMessage(value) {
  return String(value || "").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function bytesToBase64(bytes) {
  let text = "";
  const data = new Uint8Array(bytes);
  for (let i = 0; i < data.length; i += 1) text += String.fromCharCode(data[i]);
  return btoa(text);
}

function base64ToBytes(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function sha256Base64(text) {
  return bytesToBase64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function passwordHash(password, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: base64ToBytes(salt), iterations: 180000, hash: "SHA-256" },
    base,
    256
  );
  return bytesToBase64(bits);
}

async function makePassword(password) {
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await passwordHash(password, salt) };
}

async function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  return await passwordHash(password, salt) === hash;
}

async function createSession(env, userId, role = "user") {
  const token = "vx_" + crypto.randomUUID() + "_" + crypto.randomUUID();
  const tokenHash = await sha256Base64(token);
  const createdAt = now();
  const expiresAt = createdAt + SESSION_DAYS * 86400000;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(tokenHash, userId, role, expiresAt, createdAt).run();
  return { token, expiresAt };
}

async function authFromRequest(request, env) {
  const url = new URL(request.url);
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : url.searchParams.get("token");
  if (token) {
    const tokenHash = await sha256Base64(token);
    const session = await env.DB.prepare(
      "SELECT token_hash, user_id, role, expires_at FROM sessions WHERE token_hash = ?"
    ).bind(tokenHash).first();
    if (session && +session.expires_at > now()) {
      if (session.role === "admin") return { id: "admin", role: "admin" };
      const user = await env.DB.prepare("SELECT id, phone FROM users WHERE id = ?").bind(session.user_id).first();
      if (user) return { id: user.id, phone: user.phone, role: "user" };
    }
  }
  return { id: guestId(request), role: "guest" };
}

function publicRoom(row) {
  if (!row) return null;
  return {
    no: row.no,
    name: row.name || row.no,
    owner: row.owner_id,
    createdAt: +row.created_at,
    updatedAt: +row.updated_at,
    passUpdatedAt: +row.pass_updated_at,
    ownerDeleted: !!row.owner_deleted,
    ownerDeletedAt: row.owner_deleted_at ? +row.owner_deleted_at : null,
    nickname: row.nickname || "",
    messageCount: row.message_count ? +row.message_count : 0
  };
}

function publicUser(auth) {
  if (auth.role === "admin") return { role: "admin", phone: "admin" };
  if (auth.role === "user") return { role: "user", phone: auth.phone, id: auth.id };
  return { role: "guest" };
}

async function memberRooms(env, auth) {
  if (auth.role === "admin") return [];
  const result = await env.DB.prepare(
    "SELECT r.*, m.nickname FROM rooms r INNER JOIN room_members m ON m.room_no = r.no WHERE m.user_id = ? AND r.owner_deleted = 0 ORDER BY r.updated_at DESC"
  ).bind(auth.id).all();
  return (result.results || []).map(publicRoom);
}

async function getRoom(env, no) {
  return env.DB.prepare("SELECT * FROM rooms WHERE no = ?").bind(no).first();
}

async function getMember(env, roomNo, userId) {
  return env.DB.prepare("SELECT * FROM room_members WHERE room_no = ? AND user_id = ?").bind(roomNo, userId).first();
}

async function addMember(env, roomNo, userId, nickname = "") {
  const stamp = now();
  await env.DB.prepare(
    "INSERT INTO room_members (room_no, user_id, nickname, joined_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_no, user_id) DO UPDATE SET nickname = COALESCE(excluded.nickname, room_members.nickname), updated_at = excluded.updated_at"
  ).bind(roomNo, userId, nickname || null, stamp, stamp).run();
}

async function canOpenRoom(env, room, auth) {
  if (!room) return false;
  if (auth.role === "admin") return true;
  if (room.owner_deleted) return false;
  return !!(await getMember(env, room.no, auth.id));
}

function isOwner(room, auth) {
  return auth.role === "admin" || room?.owner_id === auth.id;
}

async function roomMessages(env, roomNo, limit = 100, after = 0) {
  const safeLimit = Math.min(Math.max(+limit || 100, 1), 200);
  const result = after
    ? await env.DB.prepare(
      "SELECT * FROM messages WHERE room_no = ? AND deleted_at IS NULL AND created_at > ? ORDER BY created_at ASC LIMIT ?"
    ).bind(roomNo, +after, safeLimit).all()
    : await env.DB.prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE room_no = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC"
    ).bind(roomNo, safeLimit).all();
  return (result.results || []).map(row => ({
    id: row.id,
    roomNo: row.room_no,
    sender: row.sender_id,
    nick: row.sender_name || "",
    text: row.text || "",
    type: row.type || "text",
    time: +row.created_at
  }));
}

async function broadcastRoom(env, roomNo, payload) {
  const id = env.ROOMS.idFromName(roomNo);
  await env.ROOMS.get(id).fetch("https://room.internal/broadcast", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function handleMe(request, env, auth) {
  return json({ user: publicUser(auth), rooms: await memberRooms(env, auth) });
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  const phone = cleanPhone(body.phone);
  const password = cleanPassword(body.password);
  if (!validPhone(phone)) return json({ error: "请输入正确手机号" }, 400);
  if (!validAccountPassword(password)) return json({ error: "密码需要6位" }, 400);

  const exists = await env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
  if (exists) return json({ error: "账号已存在，请登录" }, 409);

  const userId = "U_" + crypto.randomUUID();
  const stamp = now();
  const auth = await makePassword(password);
  const oldGuestId = guestId(request);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, phone, pass_salt, pass_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, phone, auth.salt, auth.hash, stamp, stamp),
    env.DB.prepare("UPDATE rooms SET owner_id = ?, updated_at = ? WHERE owner_id = ?")
      .bind(userId, stamp, oldGuestId),
    env.DB.prepare("UPDATE OR IGNORE room_members SET user_id = ?, updated_at = ? WHERE user_id = ?")
      .bind(userId, stamp, oldGuestId)
  ]);

  const nicknames = body.nicknames && typeof body.nicknames === "object" ? body.nicknames : {};
  for (const [roomNo, nick] of Object.entries(nicknames)) {
    const room = cleanRoomNo(roomNo);
    if (room.length === ROOM_NO_DIGITS) await addMember(env, room, userId, cleanNickname(nick));
  }

  const session = await createSession(env, userId, "user");
  const user = { id: userId, phone, role: "user" };
  return json({ token: session.token, expiresAt: session.expiresAt, user, rooms: await memberRooms(env, user) });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const phone = cleanPhone(body.phone);
  const password = cleanPassword(body.password);
  if (!validPhone(phone)) return json({ error: "请输入正确手机号" }, 400);
  if (!validAccountPassword(password)) return json({ error: "密码需要6位" }, 400);

  const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
  if (!user || !(await verifyPassword(password, user.pass_salt, user.pass_hash))) {
    return json({ error: "账号或密码错误" }, 401);
  }

  const session = await createSession(env, user.id, "user");
  const auth = { id: user.id, phone: user.phone, role: "user" };
  return json({ token: session.token, expiresAt: session.expiresAt, user: publicUser(auth), rooms: await memberRooms(env, auth) });
}

async function handleAdminLogin(request, env) {
  const body = await readJson(request);
  if (!env.ADMIN_PASSWORD || cleanPassword(body.password) !== env.ADMIN_PASSWORD) {
    return json({ error: "密码错误" }, 401);
  }
  const session = await createSession(env, "admin", "admin");
  return json({ token: session.token, expiresAt: session.expiresAt, user: { role: "admin", phone: "admin" } });
}

async function handleLogout(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    const tokenHash = await sha256Base64(match[1]);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return empty();
}

async function generateRoomNo(env) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] % ROOM_NO_TOTAL;
    const no = String(value).padStart(ROOM_NO_DIGITS, "0");
    if (!(await getRoom(env, no))) return no;
  }
  for (let value = 0; value < ROOM_NO_TOTAL; value += 1) {
    const no = String(value).padStart(ROOM_NO_DIGITS, "0");
    if (!(await getRoom(env, no))) return no;
  }
  return "";
}

async function handleCreateRoom(request, env, auth) {
  const body = await readJson(request);
  const password = cleanPassword(body.password);
  if (!validRoomPassword(password)) return json({ error: "房间密码需要4-6位" }, 400);
  const no = await generateRoomNo(env);
  if (!no) return json({ error: "房间号已用完，请增加房间号位数" }, 409);
  const pass = await makePassword(password);
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rooms (no, name, owner_id, pass_salt, pass_hash, created_at, updated_at, pass_updated_at, owner_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"
    ).bind(no, no, auth.id, pass.salt, pass.hash, stamp, stamp, stamp),
    env.DB.prepare(
      "INSERT INTO room_members (room_no, user_id, nickname, joined_at, updated_at) VALUES (?, ?, NULL, ?, ?)"
    ).bind(no, auth.id, stamp, stamp)
  ]);
  return json({ room: publicRoom(await getRoom(env, no)) });
}

async function handleJoinRoom(request, env, auth, no) {
  const room = await getRoom(env, no);
  if (!room || (room.owner_deleted && auth.role !== "admin")) return json({ error: "未找到房间" }, 404);
  const member = await getMember(env, no, auth.id);
  if (!member && auth.role !== "admin") {
    const body = await readJson(request);
    if (!(await verifyPassword(cleanPassword(body.password), room.pass_salt, room.pass_hash))) {
      return json({ error: "密码错误" }, 401);
    }
  }
  if (auth.role !== "admin") await addMember(env, no, auth.id);
  const payload = publicRoom({ ...room, nickname: member?.nickname || "" });
  return json({ room: payload, messages: await roomMessages(env, no) });
}

async function handleGetMessages(env, auth, no, url) {
  const room = await getRoom(env, no);
  if (!(await canOpenRoom(env, room, auth))) return json({ error: "未找到房间" }, 404);
  return json({
    messages: await roomMessages(
      env,
      no,
      url.searchParams.get("limit") || 100,
      url.searchParams.get("after") || 0
    )
  });
}

async function handleNickname(request, env, auth, no) {
  const room = await getRoom(env, no);
  if (!(await canOpenRoom(env, room, auth))) return json({ error: "未找到房间" }, 404);
  const body = await readJson(request);
  const nick = cleanNickname(body.nick);
  if (!nick) return json({ error: "请输入昵称" }, 400);
  if (auth.role !== "admin") await addMember(env, no, auth.id, nick);
  await broadcastRoom(env, no, { type: "profile", id: auth.id, nick, time: now() });
  return json({ ok: true, nick });
}

async function handleChangeRoomPassword(request, env, auth, no) {
  const room = await getRoom(env, no);
  if (!room || !isOwner(room, auth)) return json({ error: "无权限" }, 403);
  const body = await readJson(request);
  const password = cleanPassword(body.password);
  if (!validRoomPassword(password)) return json({ error: "房间密码需要4-6位" }, 400);
  const pass = await makePassword(password);
  const stamp = now();
  await env.DB.prepare(
    "UPDATE rooms SET pass_salt = ?, pass_hash = ?, pass_updated_at = ?, updated_at = ? WHERE no = ?"
  ).bind(pass.salt, pass.hash, stamp, stamp, no).run();
  await broadcastRoom(env, no, { type: "roomUpdate", action: "password", time: stamp });
  return json({ room: publicRoom(await getRoom(env, no)) });
}

async function handleOwnerDelete(env, auth, no) {
  const room = await getRoom(env, no);
  if (!room || !isOwner(room, auth)) return json({ error: "无权限" }, 403);
  const stamp = now();
  await env.DB.prepare(
    "UPDATE rooms SET owner_deleted = 1, owner_deleted_at = ?, updated_at = ? WHERE no = ?"
  ).bind(stamp, stamp, no).run();
  await broadcastRoom(env, no, { type: "roomUpdate", action: "ownerDelete", time: stamp });
  return json({ room: publicRoom(await getRoom(env, no)) });
}

async function handleClearMessages(env, auth, no) {
  if (auth.role !== "admin") return json({ error: "无权限" }, 403);
  await env.DB.prepare("DELETE FROM messages WHERE room_no = ?").bind(no).run();
  await broadcastRoom(env, no, { type: "roomUpdate", action: "clear", time: now() });
  return json({ ok: true });
}

async function handleDeleteRoom(env, auth, no) {
  if (auth.role !== "admin") return json({ error: "无权限" }, 403);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE room_no = ?").bind(no),
    env.DB.prepare("DELETE FROM room_members WHERE room_no = ?").bind(no),
    env.DB.prepare("DELETE FROM rooms WHERE no = ?").bind(no)
  ]);
  await broadcastRoom(env, no, { type: "roomUpdate", action: "delete", time: now() });
  return json({ ok: true });
}

async function handleAdminRooms(env, auth, url) {
  if (auth.role !== "admin") return json({ error: "无权限" }, 403);
  const q = String(url.searchParams.get("search") || "").trim();
  let result;
  if (q) {
    const like = "%" + q + "%";
    result = await env.DB.prepare(
      "SELECT r.*, (SELECT COUNT(*) FROM messages m WHERE m.room_no = r.no) AS message_count FROM rooms r WHERE r.no LIKE ? OR r.name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.room_no = r.no AND m.text LIKE ? LIMIT 1) ORDER BY r.updated_at DESC LIMIT 500"
    ).bind(like, like, like).all();
  } else {
    result = await env.DB.prepare(
      "SELECT r.*, (SELECT COUNT(*) FROM messages m WHERE m.room_no = r.no) AS message_count FROM rooms r ORDER BY r.updated_at DESC LIMIT 500"
    ).all();
  }
  const used = await env.DB.prepare("SELECT COUNT(*) AS count FROM rooms WHERE length(no) = 4").first();
  return json({
    rooms: (result.results || []).map(publicRoom),
    stats: {
      used: +used.count,
      total: ROOM_NO_TOTAL,
      available: Math.max(0, ROOM_NO_TOTAL - +used.count)
    }
  });
}

async function handleWs(request, env, auth, no) {
  const room = await getRoom(env, no);
  if (!(await canOpenRoom(env, room, auth))) return json({ error: "未找到房间" }, 404);
  const member = auth.role === "admin" ? null : await getMember(env, no, auth.id);
  const url = new URL("https://room.internal/connect");
  url.searchParams.set("room", no);
  url.searchParams.set("user", auth.id);
  url.searchParams.set("role", auth.role);
  url.searchParams.set("nick", member?.nickname || "");
  const id = env.ROOMS.idFromName(no);
  return env.ROOMS.get(id).fetch(new Request(url, request));
}

async function route(request, env) {
  if (request.method === "OPTIONS") return empty();
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const auth = await authFromRequest(request, env);

  if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "vx-chat-worker" });
  if (request.method === "POST" && url.pathname === "/auth/register") return handleRegister(request, env);
  if (request.method === "POST" && url.pathname === "/auth/login") return handleLogin(request, env);
  if (request.method === "POST" && url.pathname === "/auth/admin-login") return handleAdminLogin(request, env);
  if (request.method === "POST" && url.pathname === "/auth/logout") return handleLogout(request, env);
  if (request.method === "GET" && url.pathname === "/me") return handleMe(request, env, auth);
  if (request.method === "GET" && url.pathname === "/admin/rooms") return handleAdminRooms(env, auth, url);
  if (request.method === "POST" && url.pathname === "/rooms") return handleCreateRoom(request, env, auth);

  if (parts[0] === "ws" && parts[1] === "rooms" && parts[2] && request.headers.get("Upgrade") === "websocket") {
    return handleWs(request, env, auth, cleanRoomNo(parts[2]));
  }

  if (parts[0] === "rooms" && parts[1]) {
    const no = cleanRoomNo(parts[1]);
    if (no.length !== ROOM_NO_DIGITS) return json({ error: "未找到房间" }, 404);
    if (request.method === "POST" && parts[2] === "join") return handleJoinRoom(request, env, auth, no);
    if (request.method === "GET" && parts[2] === "messages") return handleGetMessages(env, auth, no, url);
    if (request.method === "PATCH" && parts[2] === "nickname") return handleNickname(request, env, auth, no);
    if (request.method === "PATCH" && parts[2] === "password") return handleChangeRoomPassword(request, env, auth, no);
    if (request.method === "POST" && parts[2] === "owner-delete") return handleOwnerDelete(env, auth, no);
    if (request.method === "DELETE" && parts[2] === "messages") return handleClearMessages(env, auth, no);
    if (request.method === "DELETE" && parts.length === 2) return handleDeleteRoom(env, auth, no);
  }

  return json({ error: "Not found" }, 404);
}

export class RoomDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.json();
      this.broadcast(payload);
      return empty();
    }

    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected WebSocket" }, 426);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta = {
      roomNo: cleanRoomNo(url.searchParams.get("room")),
      userId: url.searchParams.get("user") || "",
      role: url.searchParams.get("role") || "guest",
      nick: cleanNickname(url.searchParams.get("nick"))
    };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", roomNo: meta.roomNo, time: now() }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let payload;
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    const meta = ws.deserializeAttachment() || {};
    if (payload.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", time: now() }));
      return;
    }

    if (payload.type === "message") {
      const text = cleanMessage(payload.text);
      if (!text || !meta.roomNo || !meta.userId) return;
      const room = await getRoom(this.env, meta.roomNo);
      if (!room || room.owner_deleted) return;
      const id = String(payload.id || crypto.randomUUID()).slice(0, 120);
      const stamp = now();
      const nick = cleanNickname(payload.nick || meta.nick);
      await this.env.DB.prepare(
        "INSERT OR IGNORE INTO messages (id, room_no, sender_id, sender_name, type, text, media_key, created_at) VALUES (?, ?, ?, ?, 'text', ?, NULL, ?)"
      ).bind(id, meta.roomNo, meta.userId, nick || null, text, stamp).run();
      await this.env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE no = ?").bind(stamp, meta.roomNo).run();
      this.broadcast({
        type: "message",
        roomNo: meta.roomNo,
        message: { id, roomNo: meta.roomNo, sender: meta.userId, nick, text, type: "text", time: stamp }
      });
      return;
    }

    if (payload.type === "profile") {
      const nick = cleanNickname(payload.nick);
      if (!nick) return;
      meta.nick = nick;
      ws.serializeAttachment(meta);
      this.broadcast({ type: "profile", id: meta.userId, nick, time: now() });
    }
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        socket.close(1011, "send failed");
      }
    }
  }

  broadcastPresence() {
    this.broadcast({ type: "presence", online: this.ctx.getWebSockets().length, time: now() });
  }
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500);
    }
  }
};
