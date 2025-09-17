const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const P = require('pino');
const { exec } = require('child_process');

const makeWASocket = baileys.default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

const PORT = process.env.PORT || 3000;
const SESSION_FILE = './creds.json';
const MEMORY_FILE = './memory.json';
const ADMIN_NUMBERS = ['27639412189@s.whatsapp.net'];

if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {});
function loadMemory() { return fs.readJsonSync(MEMORY_FILE); }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }); }

// Load your creds file
function loadAuth() {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const authState = JSON.parse(raw);
    return {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, P({ level: 'fatal' }))
    };
  } else {
    console.error('❌ creds.json not found! You need a valid session.');
    process.exit(1);
  }
}

const app = express();
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

async function startBot() {
  const auth = loadAuth();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth,
    printQRInTerminal: false, // No QR scanning
    markOnlineOnConnect: true,
    logger: P({ level: 'silent' }),
  });

  // Update creds.json if keys change
  sock.ev.on('creds.update', () => {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ creds: auth.creds, keys: auth.keys }, null, 2));
  });

  // Connection events
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') console.log('✅ Connected to WhatsApp!');
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Removing session and restarting...');
        fs.removeSync(SESSION_FILE);
      }
      console.log('🔄 Disconnected. Restarting...');
      setTimeout(startBot, 3000);
    }
  });

  // Message events
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

    // Admin commands
    if (ADMIN_NUMBERS.includes(sender)) {
      if (text.toLowerCase() === '/ping') {
        await sock.sendMessage(chatId, { text: '🏓 Pong!' }, { quoted: m });
        return;
      }
      if (text.toLowerCase().startsWith('/shell ')) {
        exec(text.slice(7), (err, stdout, stderr) => {
          sock.sendMessage(chatId, { text: err ? String(err) : stdout || stderr || 'No output' }, { quoted: m });
        });
        return;
      }
    }

    // Group activation
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

    // Kai AI API
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
}

startBot();
