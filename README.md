# WhatsApp + Gemini Personal Bot

Sends a greeting to a contact you choose, then holds a natural back-and-forth chat with them using Google Gemini.

> **Disclaimer:** This project is for **educational purposes only**. It demonstrates how WhatsApp Web automation libraries and LLM APIs can be combined. Use it responsibly — at your own risk — and not for spam, deception, or anything that could violate WhatsApp's Terms of Service.

## ⚠️ Read this first

This uses **whatsapp-web.js**, an *unofficial* library that automates your real WhatsApp Web session. It is **not** an approved integration with WhatsApp/Meta, and using it technically violates WhatsApp's Terms of Service. For light personal use (a handful of contacts, human-like pacing) the practical risk is generally low, but WhatsApp can flag or ban accounts that behave in bot-like ways — especially at higher volume or frequency. Use a secondary number if you're worried about your main account.

Also: only use this with people who know they might be talking to a bot, or for clearly-scripted things like birthday/holiday greetings. Having someone believe they're texting *you* when they're actually texting an AI is deceptive and can damage trust — better to be upfront ("heads up, this is Claude helping me out" or similar) if the conversation goes past a simple greeting.

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/Syber-Tek/whatsapp-bot.git
   cd whatsapp-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Add your Gemini API key**
   ```bash
   cp .env.example .env
   # then edit .env and paste your key from https://aistudio.google.com/apikey
   ```
   The default model is `gemini-3.1-flash-lite` (generous free tier, ~1000 requests/day).
   Override with `GEMINI_MODEL=...` in `.env` if you prefer a different model — but
   note that `gemini-3.5-flash` is capped at ~20 requests/day on the free tier
   unless you enable billing on the AI Studio project.

3. **Run it**
   ```bash
   npm start
   ```

4. **Scan the QR code** that appears in your terminal:
   WhatsApp app → Settings → Linked Devices → Link a Device → scan.

   Your session is saved locally (in a `.wwebjs_auth` folder) so you won't need to re-scan every time you restart.

## How to use it

Once it says `✅ WhatsApp bot is ready`, control it by messaging **yourself** on WhatsApp (the "Note to self" / your own chat) with these commands:

| Command | What it does |
|---|---|
| `/greet <number> <message>` | Sends `<message>` to `<number>` and turns on AI auto-chat for them |
| `/activate <number>` | Turns on AI auto-chat for a contact without sending a first message |
| `/stop <number>` | Turns off AI auto-chat for a contact |
| `/list` | Shows which contacts currently have AI auto-chat on |

Numbers go in international format, digits only — no `+`, spaces, or dashes. For **Ghana numbers**: drop the leading `0` and prefix `233`. So a number saved as `024 123 4567` becomes `233241234567`.

(The bot also auto-corrects if you paste the local `0XX XXX XXXX` form by mistake — it'll convert it to `233...` for you.)

**Example:**
```
/greet 233241234567 Hey! Just thinking of you, how's your week going?
```
The bot sends that message, then any reply from that contact gets sent to Gemini, which writes a natural response and sends it back automatically — and the conversation keeps going from there.

## Customizing the bot's personality

Edit `BOT_PERSONA` in your `.env` file to change tone — e.g. make it more formal, funnier, or specific to how you actually text.

Note: `BOT_PERSONA` is a single value — wrap it in backticks (`` ` ``) if it spans multiple lines, and don't put a `BOT_PERSONA=` prefix on continuation lines, or only the first line will be used.

## How it handles WhatsApp's LID migration

WhatsApp has been migrating accounts to opaque "LID" identifiers. Incoming messages from some contacts arrive with ids like `40445723844675@lid` instead of `233544158953@c.us`. The bot detects `@lid` ids and resolves the contact's real phone number via `getContact()` before matching against your activated list — so `/activate` and `/greet` keep working with normal phone numbers regardless.

## Troubleshooting

**Crash like `r: r` at `ExecutionContext.evaluate` / `Client.getChatById`**
This is a known whatsapp-web.js issue — it happens when WhatsApp's web client version has drifted from what the library expects, or when it tries to inspect a non-standard message (reaction, status, system event). The current code:
- Pins a known-compatible WhatsApp Web version (`webVersionCache` in `index.js`). Note: if the pinned URL 404s upstream, the library silently falls back to WhatsApp's live version, which is fine.
- Wraps the whole message handler in try/catch so a single bad event logs an error instead of killing the process.
- Never calls `msg.getChat()` in handlers (the fragile call that triggers the crash) — group detection uses `msg.from.endsWith('@g.us')` instead.

If you still hit crashes, first delete the `.wwebjs_auth` folder and re-scan the QR code (a stale session is a common trigger), then try again.

**Gemini returns 429 "quota exceeded"**
You've hit the daily request cap for the configured model on the free tier (each model has its own per-project quota). Switch `GEMINI_MODEL` to a model with a higher free limit (e.g. `gemini-3.1-flash-lite`), or enable billing on the AI Studio project. Quotas reset at midnight Pacific time.

**Use Node.js LTS if problems persist**
Puppeteer (which whatsapp-web.js runs on) is tested against Node LTS releases (20.x, 22.x) — very new non-LTS versions (like 24.x/25.x) occasionally cause odd Chromium/Puppeteer issues. If you're on a non-LTS version and still seeing crashes, installing Node 22 LTS from https://nodejs.org and re-running `npm install` is worth trying.

## Notes on the current setup

- Conversation history is kept **in memory only** — it resets if you restart the bot. If you want it to persist, that's a small addition (e.g. writing to a JSON file or a small database) — just ask.
- Only 1:1 chats are handled; group chats are ignored.
- There's no allowlist beyond the `/activate`-based one — the bot will only auto-reply to contacts you've explicitly turned on.
