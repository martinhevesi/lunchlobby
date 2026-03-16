const userTokenKey = "lunch_lobby_user_token";
const adminTokenKey = "lunch_lobby_admin_token";

let userToken = localStorage.getItem(userTokenKey) || null;
let adminToken = localStorage.getItem(adminTokenKey) || null;
let state = null;
let lobbies = [];
let adminLobbies = [];
let adminLobbyState = null;
let mode = "user";

const userArea = document.getElementById("userArea");
const adminArea = document.getElementById("adminArea");
const registerSection = document.getElementById("registerSection");
const appSection = document.getElementById("appSection");

const registerForm = document.getElementById("registerForm");
const lobbySelect = document.getElementById("lobbySelect");
const nameInput = document.getElementById("nameInput");
const codeInput = document.getElementById("codeInput");
const meLabel = document.getElementById("meLabel");

const adminLoginSection = document.getElementById("adminLoginSection");
const adminPanel = document.getElementById("adminPanel");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminCodeInput = document.getElementById("adminCodeInput");
const createLobbyForm = document.getElementById("createLobbyForm");
const adminLobbySelect = document.getElementById("adminLobbySelect");
const adminLobbyInfo = document.getElementById("adminLobbyInfo");
const adminAddUserForm = document.getElementById("adminAddUserForm");

document.getElementById("userModeBtn").onclick = () => switchMode("user");
document.getElementById("adminModeBtn").onclick = () => switchMode("admin");

async function api(path, method = "GET", body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-session-token"] = token;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function userNameById(id) {
  const user = state?.users.find((u) => u.id === id);
  return user ? user.name : "Unknown";
}

function adminUserNameById(id) {
  const user = adminLobbyState?.users.find((u) => u.id === id);
  return user ? user.name : "Unknown";
}

function switchMode(nextMode) {
  mode = nextMode;
  userArea.classList.toggle("hidden", mode !== "user");
  adminArea.classList.toggle("hidden", mode !== "admin");
}

function setUserLoggedIn(loggedIn) {
  registerSection.classList.toggle("hidden", loggedIn);
  appSection.classList.toggle("hidden", !loggedIn);
}

function setAdminLoggedIn(loggedIn) {
  adminLoginSection.classList.toggle("hidden", loggedIn);
  adminPanel.classList.toggle("hidden", !loggedIn);
}

function renderLobbySelect() {
  lobbySelect.innerHTML = "";
  for (const lobby of lobbies) {
    const option = document.createElement("option");
    option.value = lobby.id;
    option.textContent = lobby.name;
    lobbySelect.appendChild(option);
  }
}

function populateUserOptions(selectEl, selectedId) {
  selectEl.innerHTML = "";
  for (const user of state.users) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = user.name;
    option.selected = user.id === selectedId;
    selectEl.appendChild(option);
  }
}

function renderUserState() {
  if (!state) return;
  meLabel.textContent = `Lobby: ${state.lobby.name} | Logged in as: ${state.me.name}`;

  const placesList = document.getElementById("placesList");
  placesList.innerHTML = "";
  const myVote = state.votes.find((v) => v.userId === state.me.id);
  for (const place of state.summary.placesByVotes) {
    const li = document.createElement("li");
    li.textContent = `${place.name} (${place.voteCount} vote${place.voteCount === 1 ? "" : "s"}) `;
    const btn = document.createElement("button");
    btn.textContent = myVote?.placeId === place.id ? "Voted" : "Vote";
    btn.disabled = myVote?.placeId === place.id;
    btn.onclick = async () => {
      try {
        state = await api("/api/votes", "POST", { placeId: place.id }, userToken);
        renderUserState();
      } catch (err) {
        alert(err.message);
      }
    };
    li.appendChild(btn);
    placesList.appendChild(li);
  }

  const ordersList = document.getElementById("ordersList");
  ordersList.innerHTML = "";
  for (const order of state.orders) {
    const li = document.createElement("li");
    li.textContent = `${order.item} - ${order.price.toFixed(2)} | For: ${userNameById(order.userId)} | Paid by: ${userNameById(order.paidByUserId)}`;
    ordersList.appendChild(li);
  }

  const sharedList = document.getElementById("sharedList");
  sharedList.innerHTML = "";
  for (const shared of state.sharedCosts) {
    const splitNames = shared.splitAmong.map(userNameById).join(", ");
    const li = document.createElement("li");
    li.textContent = `${shared.description} - ${shared.amount.toFixed(2)} | Paid by: ${userNameById(shared.paidByUserId)} | Split: ${splitNames}`;
    sharedList.appendChild(li);
  }

  const summaryList = document.getElementById("summaryList");
  summaryList.innerHTML = "";
  for (const row of state.summary.byUser) {
    const li = document.createElement("li");
    const status = row.net > 0 ? "should receive" : row.net < 0 ? "owes" : "settled";
    li.textContent = `${row.name}: ${status} ${Math.abs(row.net).toFixed(2)}`;
    summaryList.appendChild(li);
  }

  populateUserOptions(document.getElementById("orderUserSelect"), state.me.id);
  populateUserOptions(document.getElementById("orderPayerSelect"), state.me.id);
  populateUserOptions(document.getElementById("sharedPayerSelect"), state.me.id);

  const splitUsers = document.getElementById("splitUsers");
  splitUsers.innerHTML = "";
  for (const user of state.users) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = user.id;
    input.checked = true;
    label.appendChild(input);
    label.append(` ${user.name}`);
    splitUsers.appendChild(label);
  }
}

function renderAdminLobbyOptions(selectedId) {
  adminLobbySelect.innerHTML = "";
  for (const lobby of adminLobbies) {
    const option = document.createElement("option");
    option.value = lobby.id;
    option.textContent = `${lobby.name} (${lobby.users} users)`;
    option.selected = lobby.id === selectedId;
    adminLobbySelect.appendChild(option);
  }
}

function addDeleteButton(li, title, handler) {
  const btn = document.createElement("button");
  btn.textContent = title;
  btn.className = "danger-btn";
  btn.onclick = handler;
  li.appendChild(btn);
}

function renderAdminState() {
  if (!adminLobbyState) return;

  adminLobbyInfo.textContent = `Lobby code: ${adminLobbyState.code} | Users: ${adminLobbyState.users.length} | Places: ${adminLobbyState.places.length}`;

  const usersList = document.getElementById("adminUsersList");
  usersList.innerHTML = "";
  for (const user of adminLobbyState.users) {
    const li = document.createElement("li");
    li.textContent = user.name + " ";
    addDeleteButton(li, "Remove", async () => {
      if (!confirm(`Remove user "${user.name}" and related records?`)) return;
      try {
        adminLobbyState = await api(
          `/api/admin/lobbies/${adminLobbyState.id}/users/${user.id}`,
          "DELETE",
          null,
          adminToken
        );
        await refreshAdminLobbies(adminLobbyState.id);
        renderAdminState();
      } catch (err) {
        alert(err.message);
      }
    });
    usersList.appendChild(li);
  }

  const placesList = document.getElementById("adminPlacesList");
  placesList.innerHTML = "";
  for (const place of adminLobbyState.places) {
    const li = document.createElement("li");
    const votes = adminLobbyState.votes.filter((v) => v.placeId === place.id).length;
    li.textContent = `${place.name} (${votes} votes) `;
    addDeleteButton(li, "Remove", async () => {
      try {
        adminLobbyState = await api(
          `/api/admin/lobbies/${adminLobbyState.id}/places/${place.id}`,
          "DELETE",
          null,
          adminToken
        );
        await refreshAdminLobbies(adminLobbyState.id);
        renderAdminState();
      } catch (err) {
        alert(err.message);
      }
    });
    placesList.appendChild(li);
  }

  const ordersList = document.getElementById("adminOrdersList");
  ordersList.innerHTML = "";
  for (const order of adminLobbyState.orders) {
    const li = document.createElement("li");
    li.textContent = `${order.item} - ${order.price.toFixed(2)} | For: ${adminUserNameById(order.userId)} | Paid by: ${adminUserNameById(order.paidByUserId)} `;
    addDeleteButton(li, "Remove", async () => {
      try {
        adminLobbyState = await api(
          `/api/admin/lobbies/${adminLobbyState.id}/orders/${order.id}`,
          "DELETE",
          null,
          adminToken
        );
        await refreshAdminLobbies(adminLobbyState.id);
        renderAdminState();
      } catch (err) {
        alert(err.message);
      }
    });
    ordersList.appendChild(li);
  }

  const sharedList = document.getElementById("adminSharedList");
  sharedList.innerHTML = "";
  for (const shared of adminLobbyState.sharedCosts) {
    const splitNames = shared.splitAmong.map(adminUserNameById).join(", ");
    const li = document.createElement("li");
    li.textContent = `${shared.description} - ${shared.amount.toFixed(2)} | Paid by: ${adminUserNameById(shared.paidByUserId)} | Split: ${splitNames} `;
    addDeleteButton(li, "Remove", async () => {
      try {
        adminLobbyState = await api(
          `/api/admin/lobbies/${adminLobbyState.id}/shared-costs/${shared.id}`,
          "DELETE",
          null,
          adminToken
        );
        await refreshAdminLobbies(adminLobbyState.id);
        renderAdminState();
      } catch (err) {
        alert(err.message);
      }
    });
    sharedList.appendChild(li);
  }
}

async function refreshLobbies() {
  lobbies = await api("/api/lobbies");
  renderLobbySelect();
}

async function refreshUserState() {
  state = await api("/api/state", "GET", null, userToken);
  setUserLoggedIn(true);
  renderUserState();
}

async function refreshAdminLobbies(selectedId) {
  adminLobbies = await api("/api/admin/lobbies", "GET", null, adminToken);
  if (!adminLobbies.length) {
    adminLobbyState = null;
    renderAdminLobbyOptions(null);
    return;
  }

  const wanted = selectedId && adminLobbies.some((x) => x.id === selectedId)
    ? selectedId
    : adminLobbies[0].id;

  renderAdminLobbyOptions(wanted);
  adminLobbyState = await api(`/api/admin/lobbies/${wanted}`, "GET", null, adminToken);
}

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const result = await api("/api/register", "POST", {
      lobbyId: lobbySelect.value,
      name: nameInput.value.trim(),
      code: codeInput.value.trim()
    });
    userToken = result.token;
    localStorage.setItem(userTokenKey, userToken);
    codeInput.value = "";
    await refreshUserState();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("placeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const placeInput = document.getElementById("placeInput");
  try {
    state = await api("/api/places", "POST", { name: placeInput.value.trim() }, userToken);
    placeInput.value = "";
    renderUserState();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const item = document.getElementById("orderItemInput").value.trim();
    const price = Number(document.getElementById("orderPriceInput").value);
    const userId = document.getElementById("orderUserSelect").value;
    const paidByUserId = document.getElementById("orderPayerSelect").value;
    state = await api("/api/orders", "POST", { item, price, userId, paidByUserId }, userToken);
    document.getElementById("orderItemInput").value = "";
    document.getElementById("orderPriceInput").value = "";
    renderUserState();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("sharedForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const description = document.getElementById("sharedDescInput").value.trim();
    const amount = Number(document.getElementById("sharedAmountInput").value);
    const paidByUserId = document.getElementById("sharedPayerSelect").value;
    const splitAmong = [...document.querySelectorAll("#splitUsers input:checked")].map(
      (x) => x.value
    );
    state = await api(
      "/api/shared-costs",
      "POST",
      { description, amount, paidByUserId, splitAmong },
      userToken
    );
    document.getElementById("sharedDescInput").value = "";
    document.getElementById("sharedAmountInput").value = "";
    renderUserState();
  } catch (err) {
    alert(err.message);
  }
});

adminLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const result = await api("/api/admin/login", "POST", { code: adminCodeInput.value.trim() });
    adminToken = result.token;
    localStorage.setItem(adminTokenKey, adminToken);
    adminCodeInput.value = "";
    setAdminLoggedIn(true);
    await refreshAdminLobbies();
    renderAdminState();
  } catch (err) {
    alert(err.message);
  }
});

createLobbyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const name = document.getElementById("newLobbyName").value.trim();
    const code = document.getElementById("newLobbyCode").value.trim();
    const created = await api("/api/admin/lobbies", "POST", { name, code }, adminToken);
    document.getElementById("newLobbyName").value = "";
    document.getElementById("newLobbyCode").value = "";
    await refreshAdminLobbies(created.id);
    await refreshLobbies();
    renderAdminState();
  } catch (err) {
    alert(err.message);
  }
});

adminLobbySelect.addEventListener("change", async () => {
  try {
    const lobbyId = adminLobbySelect.value;
    adminLobbyState = await api(`/api/admin/lobbies/${lobbyId}`, "GET", null, adminToken);
    renderAdminState();
  } catch (err) {
    alert(err.message);
  }
});

adminAddUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!adminLobbyState) return;
    const name = document.getElementById("adminUserNameInput").value.trim();
    adminLobbyState = await api(
      `/api/admin/lobbies/${adminLobbyState.id}/users`,
      "POST",
      { name },
      adminToken
    );
    document.getElementById("adminUserNameInput").value = "";
    await refreshAdminLobbies(adminLobbyState.id);
    await refreshLobbies();
    renderAdminState();
  } catch (err) {
    alert(err.message);
  }
});

(async () => {
  switchMode("user");
  await refreshLobbies();

  if (userToken) {
    try {
      await refreshUserState();
    } catch {
      localStorage.removeItem(userTokenKey);
      userToken = null;
      setUserLoggedIn(false);
    }
  } else {
    setUserLoggedIn(false);
  }

  if (adminToken) {
    try {
      setAdminLoggedIn(true);
      await refreshAdminLobbies();
      renderAdminState();
    } catch {
      localStorage.removeItem(adminTokenKey);
      adminToken = null;
      setAdminLoggedIn(false);
    }
  } else {
    setAdminLoggedIn(false);
  }
})();
