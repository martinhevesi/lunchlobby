const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let webpush = null;
try {
  webpush = require("web-push");
} catch {
  webpush = null;
}

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_LOBBY_CODE = process.env.LOBBY_CODE || "lunch123";
const ADMIN_CODE = process.env.ADMIN_CODE || "admin123";
const WEB_PUSH_SUBJECT = process.env.WEB_PUSH_SUBJECT || "mailto:admin@example.com";
const WEB_PUSH_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || "";
const WEB_PUSH_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || "";
const PUSH_ENABLED = Boolean(webpush && WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY);

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const VOTING_ENDING_SOON_MINUTES = 5;

const sessions = new Map();
const sseClientsByLobby = new Map();

if (PUSH_ENABLED) {
  webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY);
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function normalizeSubscription(item) {
  if (!item || typeof item !== "object") return null;
  const endpoint = item.endpoint || item.subscription?.endpoint;
  const keys = item.keys || item.subscription?.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return null;
  return {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userId: item.userId || null,
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function createEmptyLobby(name, code) {
  return normalizeLobby({
    id: uid("lobby"),
    name,
    code,
    createdAt: new Date().toISOString(),
    users: [],
    places: [],
    votes: [],
    orders: [],
    sharedCosts: [],
    notifications: [],
    voting: null,
    pushSubscriptions: []
  });
}

function normalizeLobby(lobby) {
  return {
    id: lobby.id || uid("lobby"),
    name: lobby.name || "Lobby",
    code: lobby.code || DEFAULT_LOBBY_CODE,
    createdAt: lobby.createdAt || new Date().toISOString(),
    users: Array.isArray(lobby.users) ? lobby.users : [],
    places: Array.isArray(lobby.places) ? lobby.places : [],
    votes: Array.isArray(lobby.votes) ? lobby.votes : [],
    orders: Array.isArray(lobby.orders) ? lobby.orders : [],
    sharedCosts: Array.isArray(lobby.sharedCosts) ? lobby.sharedCosts : [],
    notifications: Array.isArray(lobby.notifications) ? lobby.notifications : [],
    voting: lobby.voting && typeof lobby.voting === "object"
      ? {
          startedAt: lobby.voting.startedAt || null,
          endsAt: lobby.voting.endsAt || null,
          endingSoonNotified: Boolean(lobby.voting.endingSoonNotified),
          endedNotified: Boolean(lobby.voting.endedNotified),
          closed: Boolean(lobby.voting.closed)
        }
      : null,
    pushSubscriptions: Array.isArray(lobby.pushSubscriptions)
      ? lobby.pushSubscriptions.map(normalizeSubscription).filter(Boolean)
      : []
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { lobbies: [createEmptyLobby("Main Lobby", DEFAULT_LOBBY_CODE)] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readData() {
  ensureDataFile();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  if (!Array.isArray(parsed.lobbies)) {
    const migrated = {
      lobbies: [
        normalizeLobby({
          ...createEmptyLobby("Main Lobby", DEFAULT_LOBBY_CODE),
          users: Array.isArray(parsed.users) ? parsed.users : [],
          places: Array.isArray(parsed.places) ? parsed.places : [],
          votes: Array.isArray(parsed.votes) ? parsed.votes : [],
          orders: Array.isArray(parsed.orders) ? parsed.orders : [],
          sharedCosts: Array.isArray(parsed.sharedCosts) ? parsed.sharedCosts : []
        })
      ]
    };
    writeData(migrated);
    return migrated;
  }

  const normalized = { lobbies: parsed.lobbies.map(normalizeLobby) };
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    writeData(normalized);
  }
  return normalized;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getToken(req, url) {
  const headerToken = req.headers["x-session-token"];
  if (headerToken && typeof headerToken === "string") return headerToken;
  return url.searchParams.get("token") || null;
}

function authLobbyUser(req, data, url) {
  const token = getToken(req, url);
  const session = token ? sessions.get(token) : null;
  if (!session || session.type !== "user") return null;

  const lobby = data.lobbies.find((x) => x.id === session.lobbyId);
  if (!lobby) return null;
  const user = lobby.users.find((x) => x.id === session.userId);
  if (!user) return null;
  return { lobby, user };
}

function authAdmin(req, url) {
  const token = getToken(req, url);
  const session = token ? sessions.get(token) : null;
  return session && session.type === "admin" ? session : null;
}

function computeSummary(lobby) {
  const balances = new Map();
  for (const user of lobby.users) balances.set(user.id, 0);

  for (const order of lobby.orders) {
    const amount = Number(order.price || 0);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (balances.has(order.paidByUserId)) {
      balances.set(order.paidByUserId, balances.get(order.paidByUserId) + amount);
    }
    if (balances.has(order.userId)) {
      balances.set(order.userId, balances.get(order.userId) - amount);
    }
  }

  for (const cost of lobby.sharedCosts) {
    const amount = Number(cost.amount || 0);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const splitAmong = Array.isArray(cost.splitAmong) ? cost.splitAmong : [];
    const unique = [...new Set(splitAmong)].filter((id) => balances.has(id));
    if (!unique.length) continue;
    const share = amount / unique.length;
    if (balances.has(cost.paidByUserId)) {
      balances.set(cost.paidByUserId, balances.get(cost.paidByUserId) + amount);
    }
    for (const userId of unique) {
      balances.set(userId, balances.get(userId) - share);
    }
  }

  const byUser = lobby.users.map((u) => ({
    userId: u.id,
    name: u.name,
    net: Number((balances.get(u.id) || 0).toFixed(2))
  }));

  const placesByVotes = lobby.places
    .map((p) => ({ ...p, voteCount: lobby.votes.filter((v) => v.placeId === p.id).length }))
    .sort((a, b) => b.voteCount - a.voteCount || a.name.localeCompare(b.name));

  return { byUser, placesByVotes };
}

function publicLobbyState(user, lobby) {
  return {
    lobby: { id: lobby.id, name: lobby.name },
    me: user,
    users: lobby.users,
    places: lobby.places,
    votes: lobby.votes,
    orders: lobby.orders,
    sharedCosts: lobby.sharedCosts,
    voting: lobby.voting,
    notifications: lobby.notifications.slice(-30),
    summary: computeSummary(lobby),
    push: { enabled: PUSH_ENABLED, supported: Boolean(webpush) }
  };
}

function adminLobbyState(lobby) {
  return {
    id: lobby.id,
    name: lobby.name,
    code: lobby.code,
    createdAt: lobby.createdAt,
    users: lobby.users,
    places: lobby.places,
    votes: lobby.votes,
    orders: lobby.orders,
    sharedCosts: lobby.sharedCosts,
    voting: lobby.voting,
    notifications: lobby.notifications.slice(-50),
    pushSubscriptionCount: lobby.pushSubscriptions.length
  };
}

function addNotification(lobby, event) {
  const payload = {
    id: uid("notif"),
    type: event.type,
    title: event.title || "",
    message: event.message || "",
    createdAt: new Date().toISOString(),
    byUserId: event.byUserId || null,
    meta: event.meta || {}
  };
  lobby.notifications.push(payload);
  if (lobby.notifications.length > 200) {
    lobby.notifications = lobby.notifications.slice(-200);
  }
  return payload;
}

function broadcastLobbyEvent(lobbyId, event) {
  const clients = sseClientsByLobby.get(lobbyId);
  if (!clients || clients.size === 0) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

async function sendPushToLobby(data, lobby, event) {
  if (!PUSH_ENABLED || !lobby.pushSubscriptions.length) return;
  const payload = JSON.stringify({
    title: event.title || "Lunch Lobby",
    body: event.message || "",
    type: event.type,
    createdAt: event.createdAt,
    meta: event.meta || {},
    lobbyId: lobby.id
  });

  const keep = [];
  let changed = false;
  for (const sub of lobby.pushSubscriptions) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      keep.push(sub);
    } catch (err) {
      const status = Number(err && err.statusCode);
      if (status !== 404 && status !== 410) keep.push(sub);
      if (status === 404 || status === 410) changed = true;
    }
  }
  if (changed) {
    lobby.pushSubscriptions = keep;
    writeData(data);
  }
}

function emitNotification(data, lobby, event) {
  const notification = addNotification(lobby, event);
  writeData(data);
  broadcastLobbyEvent(lobby.id, notification);
  sendPushToLobby(data, lobby, notification).catch(() => {});
  return notification;
}

function isVotingOpen(lobby) {
  if (!lobby.voting) return true;
  if (lobby.voting.closed) return false;
  if (!lobby.voting.endsAt) return true;
  return Date.now() < Date.parse(lobby.voting.endsAt);
}

function checkVotingMilestones() {
  const data = readData();
  const now = Date.now();

  for (const lobby of data.lobbies) {
    if (!lobby.voting || !lobby.voting.endsAt || lobby.voting.closed) continue;
    const endTs = Date.parse(lobby.voting.endsAt);
    const msLeft = endTs - now;
    const soonThresholdMs = VOTING_ENDING_SOON_MINUTES * 60 * 1000;

    if (msLeft > 0 && msLeft <= soonThresholdMs && !lobby.voting.endingSoonNotified) {
      lobby.voting.endingSoonNotified = true;
      emitNotification(data, lobby, {
        type: "voting_ending_soon",
        title: "Voting Ending Soon",
        message: `Voting is ending in less than ${VOTING_ENDING_SOON_MINUTES} minutes.`
      });
    }

    if (msLeft <= 0 && !lobby.voting.closed) {
      lobby.voting.closed = true;
      if (!lobby.voting.endedNotified) {
        lobby.voting.endedNotified = true;
        emitNotification(data, lobby, {
          type: "voting_ended",
          title: "Voting Ended",
          message: "Voting window has ended."
        });
      } else {
        writeData(data);
      }
    }
  }
}

function serveStatic(req, res) {
  const filePath = req.url === "/" ? "/index.html" : req.url;
  if (filePath.includes("..")) return sendJson(res, 400, { error: "Invalid path" });
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  const ext = path.extname(abs).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  };
  res.writeHead(200, { "Content-Type": map[ext] || "text/plain; charset=utf-8" });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/stream") {
      const data = readData();
      const auth = authLobbyUser(req, data, url);
      if (!auth) return sendJson(res, 401, { error: "Unauthorized stream request." });
      const { lobby } = auth;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`data: ${JSON.stringify({ type: "stream_ready", message: "connected" })}\n\n`);

      const set = sseClientsByLobby.get(lobby.id) || new Set();
      set.add(res);
      sseClientsByLobby.set(lobby.id, set);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

      req.on("close", () => {
        clearInterval(heartbeat);
        set.delete(res);
        if (!set.size) sseClientsByLobby.delete(lobby.id);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/lobbies") {
      const data = readData();
      return sendJson(
        res,
        200,
        data.lobbies.map((x) => ({ id: x.id, name: x.name }))
      );
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const data = readData();
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      const code = String(body.code || "").trim();
      const lobbyId = String(body.lobbyId || "").trim();
      const lobby = data.lobbies.find((x) => x.id === lobbyId);

      if (!name) return sendJson(res, 400, { error: "Name is required." });
      if (!lobby) return sendJson(res, 400, { error: "Please select a valid lobby." });
      if (code !== lobby.code) return sendJson(res, 403, { error: "Invalid lobby code." });

      let user = lobby.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
      if (!user) {
        user = { id: uid("user"), name, createdAt: new Date().toISOString() };
        lobby.users.push(user);
        writeData(data);
      }

      const token = crypto.randomBytes(16).toString("hex");
      sessions.set(token, { type: "user", lobbyId: lobby.id, userId: user.id });
      return sendJson(res, 200, { token, user, lobby: { id: lobby.id, name: lobby.name } });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await parseBody(req);
      const code = String(body.code || "").trim();
      if (code !== ADMIN_CODE) return sendJson(res, 403, { error: "Invalid admin code." });
      const token = crypto.randomBytes(16).toString("hex");
      sessions.set(token, { type: "admin", createdAt: Date.now() });
      return sendJson(res, 200, { token });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!authAdmin(req, url)) return sendJson(res, 401, { error: "Unauthorized admin request." });
      const data = readData();

      if (req.method === "GET" && url.pathname === "/api/admin/lobbies") {
        return sendJson(
          res,
          200,
          data.lobbies.map((lobby) => ({
            id: lobby.id,
            name: lobby.name,
            code: lobby.code,
            users: lobby.users.length,
            places: lobby.places.length,
            orders: lobby.orders.length,
            sharedCosts: lobby.sharedCosts.length,
            pushSubscriptions: lobby.pushSubscriptions.length
          }))
        );
      }

      if (req.method === "POST" && url.pathname === "/api/admin/lobbies") {
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        const code = String(body.code || "").trim();
        if (!name) return sendJson(res, 400, { error: "Lobby name is required." });
        if (!code) return sendJson(res, 400, { error: "Lobby code is required." });
        const newLobby = createEmptyLobby(name, code);
        data.lobbies.push(newLobby);
        writeData(data);
        return sendJson(res, 200, adminLobbyState(newLobby));
      }

      const viewMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)$/);
      if (req.method === "GET" && viewMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(viewMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      const addUserMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/users$/);
      if (req.method === "POST" && addUserMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(addUserMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        if (!name) return sendJson(res, 400, { error: "User name is required." });
        if (!lobby.users.find((u) => u.name.toLowerCase() === name.toLowerCase())) {
          lobby.users.push({ id: uid("user"), name, createdAt: new Date().toISOString() });
          writeData(data);
        }
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      const deleteUserMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/users\/([^/]+)$/);
      if (req.method === "DELETE" && deleteUserMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(deleteUserMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        const userId = decodeURIComponent(deleteUserMatch[2]);
        lobby.users = lobby.users.filter((u) => u.id !== userId);
        lobby.votes = lobby.votes.filter((v) => v.userId !== userId);
        lobby.orders = lobby.orders.filter((o) => o.userId !== userId && o.paidByUserId !== userId);
        lobby.sharedCosts = lobby.sharedCosts
          .filter((c) => c.paidByUserId !== userId)
          .map((c) => ({ ...c, splitAmong: c.splitAmong.filter((id) => id !== userId) }))
          .filter((c) => c.splitAmong.length > 0);
        lobby.pushSubscriptions = lobby.pushSubscriptions.filter((s) => s.userId !== userId);
        writeData(data);
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      const deletePlaceMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/places\/([^/]+)$/);
      if (req.method === "DELETE" && deletePlaceMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(deletePlaceMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        const placeId = decodeURIComponent(deletePlaceMatch[2]);
        lobby.places = lobby.places.filter((p) => p.id !== placeId);
        lobby.votes = lobby.votes.filter((v) => v.placeId !== placeId);
        writeData(data);
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      const deleteOrderMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/orders\/([^/]+)$/);
      if (req.method === "DELETE" && deleteOrderMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(deleteOrderMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        const orderId = decodeURIComponent(deleteOrderMatch[2]);
        lobby.orders = lobby.orders.filter((o) => o.id !== orderId);
        writeData(data);
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      const deleteSharedMatch = url.pathname.match(
        /^\/api\/admin\/lobbies\/([^/]+)\/shared-costs\/([^/]+)$/
      );
      if (req.method === "DELETE" && deleteSharedMatch) {
        const lobby = data.lobbies.find((x) => x.id === decodeURIComponent(deleteSharedMatch[1]));
        if (!lobby) return sendJson(res, 404, { error: "Lobby not found." });
        const sharedId = decodeURIComponent(deleteSharedMatch[2]);
        lobby.sharedCosts = lobby.sharedCosts.filter((c) => c.id !== sharedId);
        writeData(data);
        return sendJson(res, 200, adminLobbyState(lobby));
      }

      return sendJson(res, 404, { error: "Admin API route not found." });
    }

    if (url.pathname.startsWith("/api/")) {
      const data = readData();
      const auth = authLobbyUser(req, data, url);
      if (!auth) return sendJson(res, 401, { error: "Unauthorized. Register first." });
      const { lobby, user } = auth;

      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "GET" && url.pathname === "/api/push/public-key") {
        return sendJson(res, 200, {
          enabled: PUSH_ENABLED,
          publicKey: PUSH_ENABLED ? WEB_PUSH_PUBLIC_KEY : null
        });
      }

      if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
        if (!PUSH_ENABLED) return sendJson(res, 400, { error: "Web Push is not configured on server." });
        const body = await parseBody(req);
        const subscription = normalizeSubscription(body.subscription || body);
        if (!subscription) return sendJson(res, 400, { error: "Invalid push subscription payload." });
        const existingIndex = lobby.pushSubscriptions.findIndex((x) => x.endpoint === subscription.endpoint);
        const next = { ...subscription, userId: user.id, createdAt: new Date().toISOString() };
        if (existingIndex >= 0) lobby.pushSubscriptions[existingIndex] = next;
        else lobby.pushSubscriptions.push(next);
        writeData(data);
        return sendJson(res, 200, { ok: true, count: lobby.pushSubscriptions.length });
      }

      if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
        const body = await parseBody(req);
        const endpoint = String(body.endpoint || "").trim();
        if (!endpoint) return sendJson(res, 400, { error: "Endpoint is required." });
        lobby.pushSubscriptions = lobby.pushSubscriptions.filter((x) => x.endpoint !== endpoint);
        writeData(data);
        return sendJson(res, 200, { ok: true, count: lobby.pushSubscriptions.length });
      }

      if (req.method === "POST" && url.pathname === "/api/places") {
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        if (!name) return sendJson(res, 400, { error: "Place name is required." });
        if (!lobby.places.find((p) => p.name.toLowerCase() === name.toLowerCase())) {
          lobby.places.push({
            id: uid("place"),
            name,
            createdByUserId: user.id,
            createdAt: new Date().toISOString()
          });
          writeData(data);
        }
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/votes") {
        if (!isVotingOpen(lobby)) return sendJson(res, 400, { error: "Voting is closed." });
        const body = await parseBody(req);
        const placeId = String(body.placeId || "");
        if (!lobby.places.find((p) => p.id === placeId)) return sendJson(res, 400, { error: "Invalid place." });
        lobby.votes = lobby.votes.filter((v) => v.userId !== user.id);
        lobby.votes.push({ userId: user.id, placeId });
        writeData(data);
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/orders") {
        const body = await parseBody(req);
        const item = String(body.item || "").trim();
        const price = Number(body.price);
        const consumerUserId = String(body.userId || "");
        const paidByUserId = String(body.paidByUserId || "");
        if (!item) return sendJson(res, 400, { error: "Food item is required." });
        if (!Number.isFinite(price) || price < 0) return sendJson(res, 400, { error: "Price must be a non-negative number." });
        if (!lobby.users.find((u) => u.id === consumerUserId)) return sendJson(res, 400, { error: "Invalid consumer." });
        if (!lobby.users.find((u) => u.id === paidByUserId)) return sendJson(res, 400, { error: "Invalid payer." });
        lobby.orders.push({
          id: uid("order"),
          item,
          price: Number(price.toFixed(2)),
          userId: consumerUserId,
          paidByUserId,
          createdByUserId: user.id,
          createdAt: new Date().toISOString()
        });
        writeData(data);
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/shared-costs") {
        const body = await parseBody(req);
        const description = String(body.description || "").trim();
        const amount = Number(body.amount);
        const paidByUserId = String(body.paidByUserId || "");
        const splitAmong = Array.isArray(body.splitAmong) ? body.splitAmong.map((x) => String(x)) : [];
        if (!description) return sendJson(res, 400, { error: "Description is required." });
        if (!Number.isFinite(amount) || amount < 0) return sendJson(res, 400, { error: "Amount must be a non-negative number." });
        if (!lobby.users.find((u) => u.id === paidByUserId)) return sendJson(res, 400, { error: "Invalid payer." });
        if (!splitAmong.length) return sendJson(res, 400, { error: "Choose at least one user to split with." });
        for (const userId of splitAmong) {
          if (!lobby.users.find((u) => u.id === userId)) return sendJson(res, 400, { error: "Split includes invalid user." });
        }
        lobby.sharedCosts.push({
          id: uid("shared"),
          description,
          amount: Number(amount.toFixed(2)),
          paidByUserId,
          splitAmong,
          createdByUserId: user.id,
          createdAt: new Date().toISOString()
        });
        writeData(data);
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/voting/start") {
        const body = await parseBody(req);
        const minutesRaw = Number(body.durationMinutes);
        const durationMinutes = Number.isFinite(minutesRaw) ? minutesRaw : 30;
        if (durationMinutes <= 0 || durationMinutes > 300) {
          return sendJson(res, 400, { error: "Duration must be between 1 and 300 minutes." });
        }
        const startedAt = new Date();
        const endsAt = new Date(startedAt.getTime() + durationMinutes * 60 * 1000);
        lobby.voting = {
          startedAt: startedAt.toISOString(),
          endsAt: endsAt.toISOString(),
          endingSoonNotified: false,
          endedNotified: false,
          closed: false
        };
        emitNotification(data, lobby, {
          type: "voting_started",
          title: "Voting Started",
          message: `${user.name} started voting.`,
          byUserId: user.id,
          meta: { endsAt: endsAt.toISOString() }
        });
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/notify/ordered") {
        const body = await parseBody(req);
        const message = String(body.message || "").trim() || `${user.name} marked: food has been ordered.`;
        emitNotification(data, lobby, {
          type: "food_ordered",
          title: "Food Ordered",
          message,
          byUserId: user.id
        });
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      if (req.method === "POST" && url.pathname === "/api/notify/arrived") {
        const body = await parseBody(req);
        const message = String(body.message || "").trim() || `${user.name} marked: food has arrived.`;
        emitNotification(data, lobby, {
          type: "food_arrived",
          title: "Food Arrived",
          message,
          byUserId: user.id
        });
        return sendJson(res, 200, publicLobbyState(user, lobby));
      }

      return sendJson(res, 404, { error: "API route not found." });
    }

    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: "Server error", details: err.message });
  }
});

ensureDataFile();
setInterval(checkVotingMilestones, 15_000);
server.listen(PORT, () => {
  console.log(`Lunch Lobby running on http://localhost:${PORT}`);
  console.log(`Default lobby code: ${DEFAULT_LOBBY_CODE}`);
  console.log(`Admin code: ${ADMIN_CODE}`);
  console.log(`Web Push: ${PUSH_ENABLED ? "enabled" : "disabled"}`);
});
