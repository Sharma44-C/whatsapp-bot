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

// 🧠 Group message history storage
const groupHistory = {};

// Run Express server to keep Render app alive
app.get('/', (req, res) => res.send('✅ Kai WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Server live at http://localhost:${PORT}`));

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

    const senderId = msg.key.remoteJid;
    const isGroup = senderId.endsWith('@g.us');

    const messageContent =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      '';

    if (!messageContent) return;

    // 👤 Info
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || '';
    const botId = sock.user.id;

    const isMentioned = mentionedJids.includes(botId);
    const isRepliedToBot = quotedParticipant === botId;

    // 🧠 Store last 10 messages per group
    if (isGroup) {
      if (!groupHistory[senderId]) groupHistory[senderId] = [];

      groupHistory[senderId].push({
        sender: msg.key.participant || msg.key.remoteJid,
        text: messageContent,
      });

      if (groupHistory[senderId].length > 10) {
        groupHistory[senderId].shift(); // remove oldest
      }
    }

    // 👂 Ignore if in group and not mentioned or replied
    if (isGroup && !(isMentioned || isRepliedToBot)) return;

    // 🤔 Special command: "what's going on"
    const lowerMsg = messageContent.toLowerCase();
    if (isGroup && lowerMsg.includes("what's going on")) {
      const history = groupHistory[senderId] || [];
      if (history.length === 0) {
        await sock.sendMessage(senderId, { text: '📝 Nothing has happened here yet.' }, { quoted: msg });
        return;
      }

      const summary = history
        .map((h, i) => `${i + 1}. ${h.sender.split('@')[0]}: ${h.text}`)
        .join('\n');

      const kaiStyleIntro = '🧠 Here’s what’s been going on recently:\n\n';
      await sock.sendMessage(senderId, { text: kaiStyleIntro + summary }, { quoted: msg });
      return;
    }

    // 🧠 Talk to Kai API
    try {
      const apiUrl = `https://kai-api-rsmn.onrender.com/chat?sessionId=${encodeURIComponent(senderId)}&query=${encodeURIComponent(messageContent)}`;
      const response = await axios.get(apiUrl);
      const reply = response.data?.message || '🤖 Kai has no reply.';
      await sock.sendMessage(senderId, { text: reply }, { quoted: msg });
    } catch (err) {
      console.error('❌ API error:', err.message);
      await sock.sendMessage(senderId, { text: '❌ Error talking to Kai server.' }, { quoted: msg });
    }
  });
}

startSock();
