# Radiant Helper Bot

Standalone Discord bot for Radiant Archive development: polls Supabase and/or a local claim feed, DMs claimants their key, and posts masked claim logs to a channel. Includes slash commands for status, menu, announce, clear, and clear-dm.

## Quick start

1. Create a `.env` file next to `package.json` (do not commit it):

```
BOT_TOKEN=<discord-bot-token>
OWNER_ID=<your-discord-id>
ANNOUNCE_CHANNEL_ID=<channel-id>
POLL_INTERVAL=10
ALLOW_MESSAGE_CONTENT=false
OWNER_STARTUP_DM=true

# Supabase (optional; for direct polling)
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<service-key>

# Local feed (optional; when website exposes claim feed)
FEED_URL=http://localhost:3000/api/bot/claim-feed
MARK_URL=http://localhost:3000/api/bot/claim-feed/mark
```

2. Install and run:

```

npm start
```

## Commands

- `/status` — shows announce channel, poll interval, and whether Supabase/feed are enabled
- `/announce <channel_id>` — set the announce channel (owner only)
- `/menu` — displays an interactive menu in the current channel
- `/clear [count]` — clears recent messages in the current channel (best-effort) and auto-deletes the final confirmation after 10 seconds
- `/clear-dm [count]` — clears the bot's recent messages in the DM and auto-deletes the final confirmation after 10 seconds

## Notes

- The bot never logs full tokens; channel logs are masked.
- `.env` is intentionally ignored by `.gitignore` to avoid leaking secrets.
- For DMs: the user must share a server with the bot and have DMs enabled for server members.
  - Title: `RadiantArchive`
