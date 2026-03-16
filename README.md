# Lunch Lobby

Lightweight webapp to:

- register users by name + lobby secret code
- support multiple lobbies
- vote where to eat/order
- enter food orders with payer tracking
- add shared costs (example: delivery fee) split across selected users
- see live net balances (`owes` vs `should receive`)
- admin panel for lobby creation and moderation (add/remove users, remove places/orders/shared costs)

## Run

```powershell
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

## Config

- `PORT` (default: `3000`)
- `LOBBY_CODE` (default code for auto-created initial lobby: `lunch123`)
- `ADMIN_CODE` (default: `admin123`)

Example:

```powershell
$env:LOBBY_CODE="team42"; $env:ADMIN_CODE="myadminsecret"; npm start
```

## Docker

Build image:

```powershell
docker build -t lunch-lobby:latest .
```

Run container:

```powershell
docker run -d --name lunch-lobby -p 3000:3000 -e LOBBY_CODE=team42 -e ADMIN_CODE=myadminsecret lunch-lobby:latest
```

Open: `http://localhost:3000`

Notes:

- App data is stored in `/app/data/store.json` inside the container.
- For persistent data on a server, mount a volume:

```powershell
docker run -d --name lunch-lobby -p 3000:3000 -e LOBBY_CODE=team42 -e ADMIN_CODE=myadminsecret -v lunch_lobby_data:/app/data lunch-lobby:latest
```

## Data

State is persisted in:

- `data/store.json`
