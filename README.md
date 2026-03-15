# CoListen

A Spicetify extension that lets you listen to music in sync with your friends in real time. Share a 6-character code, everyone joins instantly. No accounts, no setup.

![Preview](preview.png)

## Features

- Real-time sync — track changes and play/pause follow the host automatically
- Works over the internet — no need to be on the same network
- Multiple listeners — as many people as you want
- Queue sync — the host's upcoming tracks are loaded in the background
- Manual sync button — resync to the host's position whenever you want
- Closing the panel never disconnects you — a mini bar keeps the session alive
- Your Spotify display name is used automatically

## How it works

1. The host clicks the CoListen button in the top bar
2. A 6-character room code appears — share it with friends
3. Friends enter the code and join instantly
4. Track changes and play/pause sync automatically
5. Use the **Sync now** button if you drift out of sync

## Installation

### Via Marketplace

Search for **CoListen** in the Spicetify Marketplace and click Install.

### Manual

1. Download `coListen.js`
2. Copy it to your Spicetify extensions folder:
   - **Windows:** `%appdata%\spicetify\Extensions\`
   - **macOS/Linux:** `~/.config/spicetify/Extensions/`
3. Run:
   ```bash
   spicetify config extensions coListen.js
   spicetify apply
   ```
4. Open Spotify — the CoListen button appears in the top bar

## Usage

**Creating a session:**
1. Click the CoListen icon in the top bar
2. Set your name (defaults to your Spotify display name)
3. Click **Create session**
4. Share the 6-character code with your friends
5. Click **Go to session** once someone joins

**Joining a session:**
1. Click the CoListen icon in the top bar
2. Set your name
3. Enter the code from the host
4. Click **Join session** — music starts syncing immediately

**During a session:**
- Track changes sync automatically when the host skips
- Play/pause follows the host
- The room code stays visible so more friends can join at any time
- Click **Sync now** to manually resync your position to the host
- Click **Leave session** to disconnect

## Technical details

- Built with vanilla JavaScript and the Spicetify API
- Uses WebSockets via a Cloudflare Worker for real-time relay — always on, no cold starts, no account needed
- Host broadcasts playback state on every track change and play/pause event
- Network latency is compensated automatically when syncing position
- Queue is synced in the background after the track loads, without interrupting playback

## Author

Made by [@Sermyyy](https://github.com/Sermyyy)

## License

MIT
