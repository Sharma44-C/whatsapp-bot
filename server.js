const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const axios = require('axios');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('✅ Kai WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));

// 🧠 Message memory: last 10 messages per group
const groupHistory = {};

async function startSock() {
  const authFolder = './auth_info_baileys';
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('📱 Scan this QR code with WhatsApp to log in!');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log('🔌 Disconnected. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderId = msg.key.participant || msg.key.remoteJid;
    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');

    const messageContent =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      '';

    if (!messageContent) return;

    // 🧠 Store last 10 messages per group
    if (isGroup) {
      if (!groupHistory[chatId]) groupHistory[chatId] = [];
      groupHistory[chatId].push({
        sender: senderId,
        text: messageContent,
      });
      if (groupHistory[chatId].length > 10) {
        groupHistory[chatId].shift();
      }
    }

    if (isGroup) {
      const lower = messageContent.trim().toLowerCase();
      if (!lower.startsWith('kai')) return;

      const strippedMessage = messageContent.trim().slice(3).trim();

      if (strippedMessage.toLowerCase().includes("what's going on")) {
        const history = groupHistory[chatId] || [];
        if (history.length === 0) {
          await sock.sendMessage(chatId, { text: '📝 Nothing has happened in this group yet.' }, { quoted: msg });
        } else {
          const summary = history
            .map((item, i) => `${i + 1}. ${item.sender.split('@')[0]}: ${item.text}`)
            .join('\n');
          await sock.sendMessage(chatId, { text: `📜 Here's what's going on:\n\n${summary}` }, { quoted: msg });
        }
        return;
      }

      // 🔁 Send to API using senderId as sessionId
      try {
        const apiUrl = `https://kai-api-rsmn.onrender.com/chat?sessionId=${encodeURIComponent(senderId)}&query=${encodeURIComponent(strippedMessage)}`;
        const response = await axios.get(apiUrl);
        const reply = response.data?.message || '🤖 Kai has no reply.';
        await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
      } catch (err) {
        console.error('❌ API error:', err.message);
        await sock.sendMessage(chatId, { text: '❌ Error talking to Kai server.' }, { quoted: msg });
      }
      return;
    }

    // ✅ Inbox: always respond
    try {
      const apiUrl = `https://kai-api-rsmn.onrender.com/chat?sessionId=${encodeURIComponent(senderId)}&query=${encodeURIComponent(messageContent)}`;
      const response = await axios.get(apiUrl);
      const reply = response.data?.message || '🤖 Kai has no reply.';
      await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
    } catch (err) {
      console.error('❌ API error:', err.message);
      await sock.sendMessage(chatId, { text: '❌ Error talking to Kai server.' }, { quoted: msg });
    }
  });
}

startSock();
