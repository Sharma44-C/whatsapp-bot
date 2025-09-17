const express = require('express');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const P = require('pino');
const { 
    default: makeWASocket, 
    fetchLatestBaileysVersion, 
    DisconnectReason, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const SESSION_FILE = './creds.json';
const MEMORY_FILE = './memory.json';
const ADMIN_NUMBERS = ['27639412189@s.whatsapp.net'];

// Memory handling
if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {});
function loadMemory() { return fs.readJsonSync(MEMORY_FILE); }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }); }

// Express server
const app = express();
app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));
console.log(`Bot running on port ${PORT}`);

// Load saved auth
function loadAuth() {
    if (!fs.existsSync(SESSION_FILE)) return { creds: {}, keys: {} };
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const saved = JSON.parse(raw);
    return {
        creds: saved.creds || saved,
        keys: saved.keys || {}
    };
}

// Save auth updates
function saveAuth(auth) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(auth, null, 2));
}

async function startBot() {
    const auth = loadAuth();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: auth.creds,
            keys: makeCacheableSignalKeyStore(auth.keys, P({ level: "fatal" }))
        },
        printQRInTerminal: false,
        logger: P({ level: "silent" })
    });

    // Save creds updates
    sock.ev.on('creds.update', () => saveAuth({ creds: sock.authState.creds, keys: sock.authState.keys }));

    // Connection updates
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
            setTimeout(startBot, 3000);
        }
    });

    // Message handling
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.participant || m.key.remoteJid;
        const chatId = m.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');
        const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';

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
                const exec = require('child_process').exec;
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

        // Forward to Kai API
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

    // Welcome / goodbye messages
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        for (const part of participants) {
            if (action === 'add') await sock.sendMessage(id, { text: `👋 Welcome <@${part.split('@')[0]}>!` }, { mentions: [part] });
            if (action === 'remove') await sock.sendMessage(id, { text: `👋 Goodbye <@${part.split('@')[0]}>!` }, { mentions: [part] });
        }
    });
}

// Start bot
startBot();
