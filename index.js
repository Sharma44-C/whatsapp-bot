const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('✅ Kai WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));

// 🧠 Memory: last 10 messages per group
const groupHistory = {};
// 🔘 Kai toggle per group
const groupToggle = {};

async function startSock() {
  const authFolder = './auth_info_baileys';
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // We’ll use browser-friendly QR
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
          console.log('📲 Open this URL in a browser to scan the QR code:');
          console.log(url);
        }
      });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log('🔌 Disconnected. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(startSock, 5000); // 5s delay
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
      groupHistory[chatId].push({ sender: senderId, text: messageContent });
      if (groupHistory[chatId].length > 10) groupHistory[chatId].shift();
    }

    const lower = messageContent.trim().toLowerCase();

    // ✅ Kai ON/OFF toggle
    if (isGroup) {
      if (lower === 'kai on') {
        groupToggle[chatId] = true;
        await sock.sendMessage(chatId, { text: '✅ Kai is now ACTIVE in this group!' }, { quoted: msg });
        return;
      }
      if (lower === 'kai off') {
        groupToggle[chatId] = false;
        await sock.sendMessage(chatId, { text: '❌ Kai is now INACTIVE in this group!' }, { quoted: msg });
        return;
      }
    }

    // If in group and Kai is OFF, ignore unless explicitly called
    if (isGroup && !groupToggle[chatId] && !lower.startsWith('kai')) return;

    let strippedMessage = lower.startsWith('kai') ? messageContent.trim().slice(3).trim() : messageContent;

    // Special "what's going on" command
    if (isGroup && strippedMessage.toLowerCase().includes("what's going on")) {
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

    // 🔁 Send message to Kai API
    try {
      const apiUrl = `https://kai-api-rsmn.onrender.com/chat?sessionId=${encodeURIComponent(senderId)}&query=${encodeURIComponent(strippedMessage)}`;
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
