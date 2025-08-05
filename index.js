const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const axios = require('axios');
const qrcode = require('qrcode-terminal');

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

    // Group-specific logic
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || '';
    const botId = sock.user.id;

    const isMentioned = mentionedJids.includes(botId);
    const isRepliedToBot = quotedParticipant === botId;

    if (isGroup && !(isMentioned || isRepliedToBot)) return;

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
