const express = require('express');
const { default: makeWASocket, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const P = require('pino');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const SESSION_FILE = './creds.json'; // <--- your session file
const MEMORY_FILE = './memory.json';
const ADMIN_NUMBERS = ['27639412189@s.whatsapp.net'];

// ---------------- Memory functions ----------------
if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {});
function loadMemory() { return fs.readJsonSync(MEMORY_FILE); }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }); }

// ---------------- Auth functions ----------------
async function loadAuthState() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
    return { creds: {}, keys: {} };
  } catch (err) {
    return { creds: {}, keys: {} };
  }
}

function saveAuthState(authState) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(authState, null, 2));
}

// ---------------- Express ----------------
const app = express();
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));
console.log(`Bot running on port ${PORT}`);

// ---------------- Bot ----------------
async function startBot() {
  const state = await loadAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "fatal" }).child({ level: "fatal" }))
    },
    printQRInTerminal: true,
    browser: Browsers.linux('Chrome'),
    markOnlineOnConnect: true,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 5000,
    maxRetries: 5,
    logger: P({ level: "silent" })
  });

  // Save auth updates
  sock.ev.on('creds.update', (creds) => {
    state.creds = creds;
    saveAuthState(state);
  });

  // Connection events
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) console.log('Scan this QR with your WhatsApp:', qr);
    if (connection === 'open') console.log('✅ Connected to WhatsApp!');
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Removing session...');
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      }
      console.log('🔄 Disconnected. Restarting...');
      setTimeout(startBot, 3000);
    }
  });

  // Messages & Kai API
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.participant || m.key.remoteJid;
    const chatId = m.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      m.message.videoMessage?.caption ||
      '';

    let memory = loadMemory();
    if (!memory[sender]) memory[sender] = { groups: {} };

    // ---------- Admin Commands ----------
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
        exec(text.slice(7), (err, stdout, stderr) => {
          sock.sendMessage(chatId, { text: err ? String(err) : stdout || stderr || 'No output' }, { quoted: m });
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

    // ---------- Group Commands ----------
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
      if (memory[sender].groups[chatId] === false) return;
    }

    // ---------- Kai API ----------
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

    // ---------- Auto React to greetings ----------
    if (/^(hi|hello|hey)$/i.test(text)) {
      await sock.sendMessage(chatId, { react: { text: "👋", key: m.key } });
    }
  });

  // ---------- Group participants join/leave ----------
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
}

if (require.main === module) {
  startBot();
}

module.exports = { startBot };
