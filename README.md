# Lunch Lobby

Lightweight webapp to:

- register users by name + lobby secret code
- support multiple lobbies
- vote where to eat/order (multi-vote per user)
- enter food orders with payer tracking
- add shared costs (example: delivery fee) split across selected users
- see live net balances (`owes` vs `should receive`)
- suggest places from your cross-lobby history:
  - recently voted places
  - favourite places
- admin panel for lobby creation and moderation (add/remove users, remove places/orders/shared costs)
- real-time lobby notifications:
  - voting started
  - voting ending soon (automatic)
  - food ordered
  - food arrived
- real-time lobby state sync via SSE (no manual refresh needed)
- Web Push support for installed/permission-granted browsers (Android + iOS PWA)

## Run

```powershell
npm install
npm start
```

Open: `http://localhost:3000`

## Using Admin UI

1. Open the app and switch to `Admin Mode`.
2. Log in with `ADMIN_CODE` (default: `admin123`).
3. Create new lobbies (name + lobby secret code).
4. Select a lobby to manage existing data:
   - add users
   - remove users
   - remove places
   - remove orders
   - remove shared costs

## Notifications

- In user mode, use `Voting & Alerts`:
  - start voting with a duration
  - trigger `Food Ordered`
  - trigger `Food Arrived`
- Click `Enable Push Notifications` to subscribe this device/browser.
- Real-time delivery uses:
  - SSE while the page is open
  - Web Push for background notifications (if browser supports it)
- Times are shown in local 24-hour format (no AM/PM).

## Lobby UX

- Use `Back To Home / Switch Lobby` in user mode to leave the current lobby and join another one.
- Vote buttons are `Vote` / `Unvote`, so each user can keep multiple votes at once.
- Suggestions are cross-lobby and one-click actionable in the current lobby.

## Web Push Setup

1. Generate VAPID keys:

```powershell
npx web-push generate-vapid-keys
```

2. Set these env vars on the server/container:

- `WEB_PUSH_PUBLIC_KEY`
- `WEB_PUSH_PRIVATE_KEY`
- `WEB_PUSH_SUBJECT` (example: `mailto:you@example.com`)

Example (PowerShell):

```powershell
$env:WEB_PUSH_PUBLIC_KEY="YOUR_PUBLIC_KEY"
$env:WEB_PUSH_PRIVATE_KEY="YOUR_PRIVATE_KEY"
$env:WEB_PUSH_SUBJECT="mailto:you@example.com"
npm start
```

## Config

- `PORT` (default: `3000`)
- `LOBBY_CODE` (default code for auto-created initial lobby: `lunch123`)
- `ADMIN_CODE` (default: `admin123`)
- `WEB_PUSH_PUBLIC_KEY` (required for Web Push)
- `WEB_PUSH_PRIVATE_KEY` (required for Web Push)
- `WEB_PUSH_SUBJECT` (optional; default: `mailto:admin@example.com`)

Example:

```powershell
$env:LOBBY_CODE="team42"; $env:ADMIN_CODE="myadminsecret"; $env:WEB_PUSH_PUBLIC_KEY="..."; $env:WEB_PUSH_PRIVATE_KEY="..."; $env:WEB_PUSH_SUBJECT="mailto:you@example.com"; npm start
```

## Docker

Build image:

```powershell
docker build -t lunch-lobby:latest .
```

Run container:

```powershell
docker run -d --name lunch-lobby -p 3000:3000 -e LOBBY_CODE=team42 -e ADMIN_CODE=myadminsecret -e WEB_PUSH_PUBLIC_KEY=... -e WEB_PUSH_PRIVATE_KEY=... -e WEB_PUSH_SUBJECT=mailto:you@example.com lunch-lobby:latest
```

Open: `http://localhost:3000`

Notes:

- App data is stored in `/app/data/store.json` inside the container.
- HTTP responses are served with no-cache headers to reduce stale client assets.
- For persistent data on a server, mount a volume:

```powershell
docker run -d --name lunch-lobby -p 3000:3000 -e LOBBY_CODE=team42 -e ADMIN_CODE=myadminsecret -e WEB_PUSH_PUBLIC_KEY=... -e WEB_PUSH_PRIVATE_KEY=... -e WEB_PUSH_SUBJECT=mailto:you@example.com -v lunch_lobby_data:/app/data lunch-lobby:latest
```

## Data

State is persisted in:

- `data/store.json`
