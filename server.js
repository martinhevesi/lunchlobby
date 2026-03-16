const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_LOBBY_CODE = process.env.LOBBY_CODE || "lunch123";
const ADMIN_CODE = process.env.ADMIN_CODE || "admin123";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const sessions = new Map();

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function createEmptyLobby(name, code) {
  return {
    id: uid("lobby"),
    name,
    code,
    createdAt: new Date().toISOString(),
    users: [],
    places: [],
    votes: [],
    orders: [],
    sharedCosts: []
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

function readData() {
  ensureDataFile();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  if (!Array.isArray(parsed.lobbies)) {
    // Backward compatibility for the original single-lobby structure.
    const migrated = {
      lobbies: [
        {
          ...createEmptyLobby("Main Lobby", DEFAULT_LOBBY_CODE),
          users: Array.isArray(parsed.users) ? parsed.users : [],
          places: Array.isArray(parsed.places) ? parsed.places : [],
          votes: Array.isArray(parsed.votes) ? parsed.votes : [],
          orders: Array.isArray(parsed.orders) ? parsed.orders : [],
          sharedCosts: Array.isArray(parsed.sharedCosts) ? parsed.sharedCosts : []
        }
      ]
    };
    writeData(migrated);
    return migrated;
  }
  return parsed;
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
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
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getToken(req) {
  const token = req.headers["x-session-token"];
  return typeof token === "string" ? token : null;
}

function authLobbyUser(req, data) {
  const token = getToken(req);
  const session = token ? sessions.get(token) : null;
  if (!session || session.type !== "user") return null;

  const lobby = data.lobbies.find((x) => x.id === session.lobbyId);
  if (!lobby) return null;
  const user = lobby.users.find((x) => x.id === session.userId);
  if (!user) return null;
  return { lobby, user };
}

function authAdmin(req) {
  const token = getToken(req);
  const session = token ? sessions.get(token) : null;
  return session && session.type === "admin" ? session : null;
}

function computeSummary(lobby) {
  const balances = new Map();
  for (const user of lobby.users) {
    balances.set(user.id, 0);
  }

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
    .map((p) => ({
      ...p,
      voteCount: lobby.votes.filter((v) => v.placeId === p.id).length
    }))
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
    summary: computeSummary(lobby)
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
    sharedCosts: lobby.sharedCosts
  };
}

function serveStatic(req, res) {
  const filePath = req.url === "/" ? "/index.html" : req.url;
  if (filePath.includes("..")) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  const abs = path.join(PUBLIC_DIR, filePath);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  res.writeHead(200, { "Content-Type": map[ext] || "text/plain; charset=utf-8" });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/lobbies") {
      const data = readData();
      sendJson(
        res,
        200,
        data.lobbies.map((x) => ({ id: x.id, name: x.name }))
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const data = readData();
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      const code = String(body.code || "").trim();
      const lobbyId = String(body.lobbyId || "").trim();
      const lobby = data.lobbies.find((x) => x.id === lobbyId);

      if (!name) {
        sendJson(res, 400, { error: "Name is required." });
        return;
      }
      if (!lobby) {
        sendJson(res, 400, { error: "Please select a valid lobby." });
        return;
      }
      if (code !== lobby.code) {
        sendJson(res, 403, { error: "Invalid lobby code." });
        return;
      }

      let user = lobby.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
      if (!user) {
        user = { id: uid("user"), name, createdAt: new Date().toISOString() };
        lobby.users.push(user);
        writeData(data);
      }

      const token = crypto.randomBytes(16).toString("hex");
      sessions.set(token, { type: "user", lobbyId: lobby.id, userId: user.id });
      sendJson(res, 200, { token, user, lobby: { id: lobby.id, name: lobby.name } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await parseBody(req);
      const code = String(body.code || "").trim();
      if (code !== ADMIN_CODE) {
        sendJson(res, 403, { error: "Invalid admin code." });
        return;
      }
      const token = crypto.randomBytes(16).toString("hex");
      sessions.set(token, { type: "admin", createdAt: Date.now() });
      sendJson(res, 200, { token });
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!authAdmin(req)) {
        sendJson(res, 401, { error: "Unauthorized admin request." });
        return;
      }

      const data = readData();

      if (req.method === "GET" && url.pathname === "/api/admin/lobbies") {
        sendJson(
          res,
          200,
          data.lobbies.map((lobby) => ({
            id: lobby.id,
            name: lobby.name,
            code: lobby.code,
            users: lobby.users.length,
            places: lobby.places.length,
            orders: lobby.orders.length,
            sharedCosts: lobby.sharedCosts.length
          }))
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/lobbies") {
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        const code = String(body.code || "").trim();
        if (!name) {
          sendJson(res, 400, { error: "Lobby name is required." });
          return;
        }
        if (!code) {
          sendJson(res, 400, { error: "Lobby code is required." });
          return;
        }
        const newLobby = createEmptyLobby(name, code);
        data.lobbies.push(newLobby);
        writeData(data);
        sendJson(res, 200, adminLobbyState(newLobby));
        return;
      }

      const viewMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)$/);
      if (req.method === "GET" && viewMatch) {
        const lobbyId = decodeURIComponent(viewMatch[1]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      const addUserMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/users$/);
      if (req.method === "POST" && addUserMatch) {
        const lobbyId = decodeURIComponent(addUserMatch[1]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        if (!name) {
          sendJson(res, 400, { error: "User name is required." });
          return;
        }
        if (!lobby.users.find((u) => u.name.toLowerCase() === name.toLowerCase())) {
          lobby.users.push({ id: uid("user"), name, createdAt: new Date().toISOString() });
          writeData(data);
        }
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      const deleteUserMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/users\/([^/]+)$/);
      if (req.method === "DELETE" && deleteUserMatch) {
        const lobbyId = decodeURIComponent(deleteUserMatch[1]);
        const userId = decodeURIComponent(deleteUserMatch[2]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        lobby.users = lobby.users.filter((u) => u.id !== userId);
        lobby.votes = lobby.votes.filter((v) => v.userId !== userId);
        lobby.orders = lobby.orders.filter((o) => o.userId !== userId && o.paidByUserId !== userId);
        lobby.sharedCosts = lobby.sharedCosts
          .filter((c) => c.paidByUserId !== userId)
          .map((c) => ({ ...c, splitAmong: c.splitAmong.filter((id) => id !== userId) }))
          .filter((c) => c.splitAmong.length > 0);
        writeData(data);
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      const deletePlaceMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/places\/([^/]+)$/);
      if (req.method === "DELETE" && deletePlaceMatch) {
        const lobbyId = decodeURIComponent(deletePlaceMatch[1]);
        const placeId = decodeURIComponent(deletePlaceMatch[2]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        lobby.places = lobby.places.filter((p) => p.id !== placeId);
        lobby.votes = lobby.votes.filter((v) => v.placeId !== placeId);
        writeData(data);
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      const deleteOrderMatch = url.pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/orders\/([^/]+)$/);
      if (req.method === "DELETE" && deleteOrderMatch) {
        const lobbyId = decodeURIComponent(deleteOrderMatch[1]);
        const orderId = decodeURIComponent(deleteOrderMatch[2]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        lobby.orders = lobby.orders.filter((o) => o.id !== orderId);
        writeData(data);
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      const deleteSharedMatch = url.pathname.match(
        /^\/api\/admin\/lobbies\/([^/]+)\/shared-costs\/([^/]+)$/
      );
      if (req.method === "DELETE" && deleteSharedMatch) {
        const lobbyId = decodeURIComponent(deleteSharedMatch[1]);
        const sharedId = decodeURIComponent(deleteSharedMatch[2]);
        const lobby = data.lobbies.find((x) => x.id === lobbyId);
        if (!lobby) {
          sendJson(res, 404, { error: "Lobby not found." });
          return;
        }
        lobby.sharedCosts = lobby.sharedCosts.filter((c) => c.id !== sharedId);
        writeData(data);
        sendJson(res, 200, adminLobbyState(lobby));
        return;
      }

      sendJson(res, 404, { error: "Admin API route not found." });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const data = readData();
      const auth = authLobbyUser(req, data);
      if (!auth) {
        sendJson(res, 401, { error: "Unauthorized. Register first." });
        return;
      }
      const { lobby, user } = auth;

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, publicLobbyState(user, lobby));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/places") {
        const body = await parseBody(req);
        const name = String(body.name || "").trim();
        if (!name) {
          sendJson(res, 400, { error: "Place name is required." });
          return;
        }
        if (!lobby.places.find((p) => p.name.toLowerCase() === name.toLowerCase())) {
          lobby.places.push({
            id: uid("place"),
            name,
            createdByUserId: user.id,
            createdAt: new Date().toISOString()
          });
          writeData(data);
        }
        sendJson(res, 200, publicLobbyState(user, lobby));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/votes") {
        const body = await parseBody(req);
        const placeId = String(body.placeId || "");
        if (!lobby.places.find((p) => p.id === placeId)) {
          sendJson(res, 400, { error: "Invalid place." });
          return;
        }
        lobby.votes = lobby.votes.filter((v) => v.userId !== user.id);
        lobby.votes.push({ userId: user.id, placeId });
        writeData(data);
        sendJson(res, 200, publicLobbyState(user, lobby));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/orders") {
        const body = await parseBody(req);
        const item = String(body.item || "").trim();
        const price = Number(body.price);
        const consumerUserId = String(body.userId || "");
        const paidByUserId = String(body.paidByUserId || "");

        if (!item) {
          sendJson(res, 400, { error: "Food item is required." });
          return;
        }
        if (!Number.isFinite(price) || price < 0) {
          sendJson(res, 400, { error: "Price must be a non-negative number." });
          return;
        }
        if (!lobby.users.find((u) => u.id === consumerUserId)) {
          sendJson(res, 400, { error: "Invalid consumer." });
          return;
        }
        if (!lobby.users.find((u) => u.id === paidByUserId)) {
          sendJson(res, 400, { error: "Invalid payer." });
          return;
        }

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
        sendJson(res, 200, publicLobbyState(user, lobby));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/shared-costs") {
        const body = await parseBody(req);
        const description = String(body.description || "").trim();
        const amount = Number(body.amount);
        const paidByUserId = String(body.paidByUserId || "");
        const splitAmong = Array.isArray(body.splitAmong)
          ? body.splitAmong.map((x) => String(x))
          : [];

        if (!description) {
          sendJson(res, 400, { error: "Description is required." });
          return;
        }
        if (!Number.isFinite(amount) || amount < 0) {
          sendJson(res, 400, { error: "Amount must be a non-negative number." });
          return;
        }
        if (!lobby.users.find((u) => u.id === paidByUserId)) {
          sendJson(res, 400, { error: "Invalid payer." });
          return;
        }
        if (!splitAmong.length) {
          sendJson(res, 400, { error: "Choose at least one user to split with." });
          return;
        }
        for (const userId of splitAmong) {
          if (!lobby.users.find((u) => u.id === userId)) {
            sendJson(res, 400, { error: "Split includes invalid user." });
            return;
          }
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
        sendJson(res, 200, publicLobbyState(user, lobby));
        return;
      }

      sendJson(res, 404, { error: "API route not found." });
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: "Server error", details: err.message });
  }
});

ensureDataFile();
server.listen(PORT, () => {
  console.log(`Lunch Lobby running on http://localhost:${PORT}`);
  console.log(`Default lobby code: ${DEFAULT_LOBBY_CODE}`);
  console.log(`Admin code: ${ADMIN_CODE}`);
});
