import express from 'express';
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import P from 'pino';
import { exec } from 'child_process';

const PORT = process.env.PORT || 3000;
const SESSION_FILE = './creds.json';
const MEMORY_FILE = './memory.json';
const ADMIN_NUMBERS = ['27639412189@s.whatsapp.net'];

// Ensure memory file exists
if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {});
function loadMemory() { return fs.readJsonSync(MEMORY_FILE); }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }); }

// Express server
const app = express();
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));
console.log(`Bot running on port ${PORT}`);

// Load existing session or create empty
let state = { creds: {}, keys: {} };
if (fs.existsSync(SESSION_FILE)) state = fs.readJsonSync(SESSION_FILE);

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' }))
    },
    printQRInTerminal: true,
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: true,
  });

  // Save updated credentials
  sock.ev.on('creds.update', () => {
    fs.writeJsonSync(SESSION_FILE, state, { spaces: 2 });
  });

  // Connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) console.log('Scan this QR to login:', qr);
    if (connection === 'open') console.log('✅ Connected to WhatsApp!');
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Removing session...');
        fs.removeSync(SESSION_FILE);
      }
      console.log('🔄 Disconnected. Restarting...');
      setTimeout(startBot, 3000);
    }
  });

  // Messages handler
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.participant || m.key.remoteJid;
    const chatId = m.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const text = m.message.conversation
      || m.message.extendedTextMessage?.text
      || m.message.imageMessage?.caption
      || m.message.videoMessage?.caption
      || '';

    let memory = loadMemory();
    if (!memory[sender]) memory[sender] = { groups: {} };

    // Admin commands
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
        await sock.sendMessage(chatId, {
          text:
            `🚀 Bot boosted!\n` +
            `Memory (MB) before: RSS=${(before.rss/1024/1024).toFixed(2)}, Heap=${(before.heapUsed/1024/1024).toFixed(2)}\n` +
            `Memory (MB) after: RSS=${(after.rss/1024/1024).toFixed(2)}, Heap=${(after.heapUsed/1024/1024).toFixed(2)}`
        }, { quoted: m });
        return;
      }
    }

    // Group Kai toggle
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

    // Kai API reply
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

  // Group participants welcome/goodbye
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    for (const part of participants) {
      if (action === 'add') await sock.sendMessage(id, { text: `👋 Welcome <@${part.split('@')[0]}>!` }, { mentions: [part] });
      if (action === 'remove') await sock.sendMessage(id, { text: `👋 Goodbye <@${part.split('@')[0]}>!` }, { mentions: [part] });
    }
  });

  // Simple reacts
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const chatId = m.key.remoteJid;
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
    if (/^(hi|hello|hey)$/i.test(text)) await sock.sendMessage(chatId, { react: { text: "👋", key: m.key } });
  });
}

// Start bot
startBot();
