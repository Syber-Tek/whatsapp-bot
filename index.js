/**
 * WhatsApp + Gemini personal bot
 * -------------------------------
 * - Logs into YOUR WhatsApp account via QR code (uses whatsapp-web.js, an UNOFFICIAL
 *   library that automates WhatsApp Web — see README for the terms-of-service caveat).
 * - You control it by messaging commands to yourself ("Message yourself" / "Note to self"
 *   chat), so you don't need a separate UI.
 * - Once you "activate" a contact, incoming messages from them are sent to Gemini to
 *   generate a natural reply, with per-contact conversation memory kept in memory (RAM).
 *
 * Commands (send these to your OWN number in WhatsApp):
 *   /greet <number> <message>   -> sends <message> to <number> and activates AI chat mode
 *   /activate <number>          -> activates AI chat mode without sending anything first
 *   /stop <number>              -> deactivates AI chat mode for that contact
 *   /list                       -> lists currently active contacts
 *
 * <number> should be in international format without symbols, e.g. 233241234567
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------- Config ----------
const SYSTEM_PROMPT = process.env.BOT_PERSONA ||
  "You are a friendly, casual texter. Keep replies short (1-3 sentences), " +
  "warm, and natural, like a real friend texting on WhatsApp. Don't mention " +
  "that you are an AI unless directly asked.";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// gemini-2.5-flash was retired early for new API keys (July 2026); the current
// stable flash model is gemini-3.5-flash. Override with GEMINI_MODEL if needed.
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  systemInstruction: SYSTEM_PROMPT,
});

// contactId (e.g. "233241234567@c.us") -> array of {role, parts}
const conversations = new Map();
// set of contactIds currently allowed to chat with the AI
const activeContacts = new Set();

// ---------- WhatsApp client ----------
const client = new Client({
  authStrategy: new LocalAuth(), // persists session so you don't re-scan QR every run
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  // Note: this pinned URL currently 404s upstream (the wa-version repo only
  // carries newer builds); RemoteWebCache then falls back to serving WhatsApp's
  // live version, which is the behavior this bot relies on.
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023950358.html',
  },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp (Linked Devices > Link a Device):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp bot is ready.');
  console.log('Message yourself with /greet, /activate, /stop, /list to control it.');
});

client.on('auth_failure', (msg) => console.error('Auth failure:', msg));
client.on('disconnected', (reason) => console.log('Client disconnected:', reason));

// ---------- Helpers ----------
function toChatId(number) {
  let digits = number.replace(/\D/g, '');

  // Auto-fix the most common mistake: pasting a Ghana number in local format
  // (starts with 0, e.g. 0241234567) instead of international format.
  // Ghana's country code is 233, and local numbers are 9 digits after the 0.
  if (digits.length === 10 && digits.startsWith('0')) {
    digits = '233' + digits.slice(1);
  }

  return `${digits}@c.us`;
}

// WhatsApp is migrating contacts to opaque "LID" ids (e.g. 40445723844675@lid)
// that are NOT the phone number. Sending to a @c.us id still works (WhatsApp
// maps it internally), but INCOMING messages from such contacts arrive with
// the @lid id, so `activeContacts.has(msg.from)` misses them. When we see a
// @lid id we resolve the contact's phone number via msg.getContact() (a light
// store lookup, unlike the fragile getChat()) and match against the phone id.
// lidId -> phoneId (e.g. "40445723844675@lid" -> "233544158953@c.us")
const lidToPhone = new Map();

function normalizePhoneDigits(digits) {
  digits = String(digits).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) {
    digits = '233' + digits.slice(1);
  }
  return digits;
}

// Returns the canonical phone-based chat id for an incoming message, or null
// if it can't be resolved (e.g. not a contact with a known phone number).
async function resolveSenderChatId(msg) {
  if (msg.from.endsWith('@c.us')) return msg.from;
  if (!msg.from.endsWith('@lid')) return null;

  if (lidToPhone.has(msg.from)) return lidToPhone.get(msg.from);

  try {
    const contact = await msg.getContact();
    let phoneId = null;

    // The lib's getContactModel remaps the id of LID contacts to their phone
    // WID when the phone is known (Injected/Utils.js getContactModel), so the
    // contact's id._serialized is usually already the phone-based id.
    if (
      contact.id &&
      typeof contact.id._serialized === 'string' &&
      contact.id._serialized.endsWith('@c.us')
    ) {
      phoneId = contact.id._serialized;
    } else {
      const digits = normalizePhoneDigits(contact.number || '');
      if (digits.length >= 10) phoneId = `${digits}@c.us`;
    }

    if (phoneId) {
      lidToPhone.set(msg.from, phoneId);
      console.log(`[lid] mapped ${msg.from} -> ${phoneId}`);
      return phoneId;
    }
    console.log(
      `[lid] could not resolve phone for ${msg.from} (id="${contact.id && contact.id._serialized}" number="${contact.number}")`
    );
  } catch (err) {
    console.log(`[lid] getContact() failed for ${msg.from}: ${err.message}`);
  }
  return null;
}

async function sendGreeting(chatId, message) {
  await client.sendMessage(chatId, message);
  activeContacts.add(chatId);
  // Gemini requires the FIRST history turn to have role "user", so seed with a
  // neutral opener and then record the greeting as the bot's (model) turn.
  conversations.set(chatId, [
    { role: 'user', parts: [{ text: '[Conversation started]' }] },
    { role: 'model', parts: [{ text: message }] },
  ]);
  console.log(`Sent greeting to ${chatId} and activated AI chat.`);
}

async function generateReply(chatId, incomingText) {
  const history = conversations.get(chatId) || [];

  // 503 (high demand) and 429 (rate limit) are transient — retry with backoff.
  let replyText;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(incomingText);
      replyText = result.response.text().trim();
      break;
    } catch (err) {
      if (attempt === 3 || !(err.status === 503 || err.status === 429)) throw err;
      console.log(`Gemini busy (${err.status}), retrying in ${attempt * 3}s (${attempt}/3)...`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }

  history.push({ role: 'user', parts: [{ text: incomingText }] });
  history.push({ role: 'model', parts: [{ text: replyText }] });
  // keep last 20 turns so the history doesn't grow forever
  conversations.set(chatId, history.slice(-20));

  return replyText;
}

// A WhatsApp id ending in "@g.us" is a group; "@c.us" is a normal 1:1 contact.
// Checking the id string directly avoids calling msg.getChat(), which does an
// extra round-trip into the WhatsApp Web page and can throw on certain
// message types (reactions, status updates, system messages, etc).
function isGroupId(id) {
  return typeof id === 'string' && id.endsWith('@g.us');
}

// ---------- Message handling ----------

// TEMP DIAGNOSTIC: log EVERY message that fires any event, to see whether
// the contact's reply is reaching the bot at all. Remove after debugging.
client.on('message_create', async (msg) => {
  console.log(
    `[ALL-MSG] from=${msg.from} fromMe=${msg.fromMe} type=${msg.type} hasMedia=${msg.hasMedia} body="${msg.body}"`
  );
});

// IMPORTANT: WhatsApp Web's "message" event mainly fires for messages from
// OTHER people — it often does not fire for messages you send to yourself
// (the self-chat used here as the command channel). "message_create" fires
// for every message you send (and receive), so it's the reliable one to use
// for picking up your own /greet, /activate, /stop, /list commands.
client.on('message_create', async (msg) => {
  try {
    if (!msg.fromMe) return; // this listener only handles commands YOU send
    if (!msg.body || typeof msg.body !== 'string') return;
    if (!msg.body.startsWith('/')) return; // not a command, ignore (e.g. normal chats)

    const [cmd, ...rest] = msg.body.trim().split(' ');

    if (cmd === '/greet') {
      const number = rest[0];
      const text = rest.slice(1).join(' ');
      if (!number || !text) {
        return client.sendMessage(msg.from, 'Usage: /greet <number> <message>');
      }
      const chatId = toChatId(number);
      await sendGreeting(chatId, text);
      return;
    }

    if (cmd === '/activate') {
      const number = rest[0];
      if (!number) return client.sendMessage(msg.from, 'Usage: /activate <number>');
      const chatId = toChatId(number);
      activeContacts.add(chatId);
      if (!conversations.has(chatId)) conversations.set(chatId, []);
      return client.sendMessage(msg.from, `Activated AI chat for ${chatId}`);
    }

    if (cmd === '/stop') {
      const number = rest[0];
      if (!number) return client.sendMessage(msg.from, 'Usage: /stop <number>');
      const chatId = toChatId(number);
      activeContacts.delete(chatId);
      return client.sendMessage(msg.from, `Deactivated AI chat for ${chatId}`);
    }

    if (cmd === '/list') {
      const list = [...activeContacts].join('\n') || '(none active)';
      return client.sendMessage(msg.from, `Active contacts:\n${list}`);
    }
  } catch (err) {
    console.error('Error handling command:', err);
  }
});

// Handles incoming replies from contacts you've activated.
client.on('message', async (msg) => {
  try {
    console.log(
      `[incoming] from=${msg.from} fromMe=${msg.fromMe} type=${msg.type} body="${msg.body}"`
    );

    if (!msg.body || typeof msg.body !== 'string') return; // ignore non-text events
    if (msg.fromMe || isGroupId(msg.from)) return;

    // Incoming messages may arrive with a @lid id instead of the phone-based
    // @c.us id (WhatsApp's LID migration) — resolve to the canonical phone id.
    const senderId = await resolveSenderChatId(msg);
    if (!senderId) return;

    if (!activeContacts.has(senderId)) {
      console.log(`[skip] ${msg.from} (${senderId}) is not in activeContacts:`, [...activeContacts]);
      return;
    }

    console.log(`[replying] generating Gemini reply for ${senderId}...`);
    const reply = await generateReply(senderId, msg.body);
    await client.sendMessage(senderId, reply);
    console.log(`[sent] reply to ${senderId}`);
  } catch (err) {
    // Never let a single bad message crash the whole bot.
    console.error('Error handling message:', err);
  }
});

// Extra safety net: log unexpected errors instead of letting them crash the process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.initialize();