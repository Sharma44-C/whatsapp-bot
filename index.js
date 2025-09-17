// Core Node.js modules
const fs = require('fs-extra'); // file read/write and extra utilities
const fetch = require('node-fetch'); // for API requests
const express = require('express'); // for web server
const P = require('pino'); // logging

// Baileys WhatsApp library
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// Bot configuration
const PORT = process.env.PORT || 3000;
const SESSION_FILE = './creds.json'; // your uploaded creds.json
const MEMORY_FILE = './memory.json'; // memory per user
const ADMIN_NUMBERS = ['27639412189@s.whatsapp.net']; // your admin number(s)

// Ensure memory file exists
if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {});
function loadMemory() { return fs.readJsonSync(MEMORY_FILE); }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }); }

// Start Express server
const app = express();
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// Main bot function
async function startBot() {
  // Load your Baileys credentials from creds.json
  const stateData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  const state = {
    creds: stateData.creds,
    keys: makeCacheableSignalKeyStore(stateData.keys, P({ level: 'fatal' }).child({ level: 'fatal' }))
  };

  // Fetch the latest WhatsApp Web version
  const { version } = await fetchLatestBaileysVersion();

  // Create the WhatsApp socket
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // no QR needed
    markOnlineOnConnect: true,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 5000,
    maxRetries: 5,
    logger: P({ level: 'silent' })
  });

  // Save creds when updated
  sock.ev.on('creds.update', (newCreds) => {
    state.creds = newCreds;
    fs.writeJsonSync(SESSION_FILE, state, { spaces: 2 });
  });

  // Handle connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') console.log('✅ Connected to WhatsApp!');
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Removing session...');
        fs.removeSync(SESSION_FILE);
      }
      console.log('🔄 Disconnected. Restarting...');
      setTimeout(startBot, 3000); // restart bot
    }
  });

  // Handle incoming messages (DMs & groups)
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return; // ignore empty or self messages

    const sender = m.key.participant || m.key.remoteJid; // sender ID
    const chatId = m.key.remoteJid; // chat ID
    const isGroup = chatId.endsWith('@g.us'); // check if group
    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      m.message.videoMessage?.caption ||
      '';

    // Load memory for user
    let memory = loadMemory();
    if (!memory[sender]) memory[sender] = { groups: {} };

    // ------------------- ADMIN COMMANDS -------------------
    if (ADMIN_NUMBERS.includes(sender)) {
      if (text.toLowerCase() === '/ping') {
        await sock.sendMessage(chatId, { text: '🏓 Pong!' }, { quoted: m });
        return;
      }
      if (text.toLowerCase().startsWith('/broadcast ')) {
        const msg = text.slice(11);
        const allChats = await sock.groupFetchAllParticipating();
        for (const gid of Object.keys(allChats)) {
          await sock.sendMessage(gid, { text: `[Broadcast]\n${msg}` });
        }
        await sock.sendMessage(chatId, { text: '📢 Broadcast sent.' }, { quoted: m });
        return;
      }
      if (text.toLowerCase().startsWith('/shell ')) {
        const exec = require('child_process').exec;
        exec(text.slice(7), (err, stdout, stderr) => {
          sock.sendMessage(
            chatId,
            { text: err ? String(err) : stdout || stderr || 'No output' },
            { quoted: m }
          );
        });
        return;
      }
      if (text.toLowerCase() === '/boost') {
        let before = process.memoryUsage();
        if (global.gc) global.gc();
        let after = process.memoryUsage();
        await sock.sendMessage(
          chatId,
          {
            text:
              `🚀 Bot boosted!\n` +
              `Memory (MB) before: RSS=${(before.rss / 1024 / 1024).toFixed(2)}, Heap=${(before.heapUsed / 1024 / 1024).toFixed(2)}\n` +
              `Memory (MB) after: RSS=${(after.rss / 1024 / 1024).toFixed(2)}, Heap=${(after.heapUsed / 1024 / 1024).toFixed(2)}`
          },
          { quoted: m }
        );
        return;
      }
    }

    // ------------------- GROUP ACTIVATION -------------------
    if (isGroup) {
      if (text.toLowerCase() === 'kai on') {
        memory[sender].groups[chatId] = true;
        saveMemory(memory);
        await sock.sendMessage(chatId, { text: "✅ Kai activated for you in this group." }, { quoted: m });
        return;
      }
      if (text.toLowerCase() === 'kai off') {
        memory[sender].groups[chatId] = false;
        saveMemory(memory);
        await sock.sendMessage(chatId, { text: "❌ Kai deactivated for you in this group." }, { quoted: m });
        return;
      }
      if (memory[sender].groups[chatId] === false) return; // skip if deactivated
    }

    // ------------------- KAI REPLY SYSTEM -------------------
    if (text) {
      try {
        const apiUrl = `https://kai-api-z744.onrender.com?prompt=${encodeURIComponent(text)}&personid=${encodeURIComponent(sender)}`;
        const res = await fetch(apiUrl);
        const json = await res.json();
        const reply = json.reply || "⚠️ No reply from API";
        await sock.sendMessage(chatId, { text: reply }, { quoted: m });
        memory[sender].lastMessage = text;
        memory[sender].lastReply = reply;
        saveMemory(memory);
      } catch (err) {
        await sock.sendMessage(chatId, { text: "⚠️ Error fetching response from API." }, { quoted: m });
      }
    }
  });

  // ------------------- GROUP WELCOME / GOODBYE -------------------
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    if (action === 'add') {
      for (const part of participants) {
        await sock.sendMessage(id, { text: `👋 Welcome <@${part.split('@')[0]}>!` }, { mentions: [part] });
      }
    }
    if (action === 'remove') {
      for (const part of participants) {
        await sock.sendMessage(id, { text: `👋 Goodbye <@${part.split('@')[0]}>!` }, { mentions: [part] });
      }
    }
  });

  console.log('✅ Bot is fully running!');
  return sock;
}

// Start the bot
startBot();
