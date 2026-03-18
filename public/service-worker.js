self.addEventListener("push", (event) => {
  let payload = { title: "Lunch Lobby", body: "New lobby update." };
  try {
    payload = event.data ? JSON.parse(event.data.text()) : payload;
  } catch {
    payload = { title: "Lunch Lobby", body: event.data ? event.data.text() : "New update." };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Lunch Lobby", {
      body: payload.body || "New update.",
      tag: payload.type || "lunch-lobby",
      data: payload,
      renotify: true
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
