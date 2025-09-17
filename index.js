const fs = require('fs')
const chalk = require('chalk')
const axios = require('axios')
const NodeCache = require("node-cache")
const pino = require("pino")
const PhoneNumber = require('awesome-phonenumber')
const express = require('express')
const { exec } = require('child_process')
const qrcode = require('qrcode') // QR generation
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidDecode
} = require('baileys') // Official Baileys

/** ---------------- BOT SETTINGS ---------------- */
global.botname = "Kai Bot"
global.themeemoji = "•"

const OWNER_NUMBER = "27639412189@s.whatsapp.net"
const BOT_NUMBER = "+27612302989"
const ADMIN_NUMBERS = [OWNER_NUMBER]

/** ---------------- MEMORY ---------------- */
const MEMORY_FILE = './memory.json'
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({}))
function loadMemory() { return JSON.parse(fs.readFileSync(MEMORY_FILE)) }
function saveMemory(data) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2)) }

/** ---------------- EXPRESS SERVER ---------------- */
const PORT = process.env.PORT || 3000
const app = express()

let lastQR = null; // Store last QR code image

app.get('/', (_req, res) => res.send('WhatsApp Bot is running.'))
app.get('/qr', (_req, res) => {
    if (!lastQR) return res.send('No QR generated yet.')
    res.type('png')
    res.send(Buffer.from(lastQR.split(',')[1], 'base64'))
})

app.listen(PORT, () => console.log(`Express server running on port ${PORT}`))

/** ---------------- STORE ---------------- */
const store = {
    messages: {},
    contacts: {},
    chats: {},
    groupMetadata: async (jid) => ({}),
    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            messages.forEach(msg => {
                if (msg.key?.remoteJid) {
                    this.messages[msg.key.remoteJid] = this.messages[msg.key.remoteJid] || {}
                    this.messages[msg.key.remoteJid][msg.key.id] = msg
                }
            })
        })
        ev.on('contacts.update', (contacts) => {
            contacts.forEach(c => { if (c.id) this.contacts[c.id] = c })
        })
        ev.on('chats.set', (chats) => { this.chats = chats })
    },
    loadMessage(jid, id) { return this.messages[jid]?.[id] || null }
}

/** ---------------- START BOT ---------------- */
async function startBot() {
    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState(`./session`)
    const msgRetryCounterCache = new NodeCache()

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "1.0.0"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: 60000,
        msgRetryCounterCache
    })

    store.bind(sock.ev)

    /** ---------------- QR CODE HANDLING ---------------- */
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update

        if (qr) {
            lastQR = await qrcode.toDataURL(qr)
            console.log(chalk.green('QR code generated. Visit /qr to scan it.'))
        }

        if (connection === 'open') console.log('✅ Connected to WhatsApp!')
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            if (reason === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Removing session...')
                fs.rmSync('./session', { recursive: true, force: true })
            }
            console.log('🔄 Reconnecting...')
            setTimeout(startBot, 3000)
        }
    })

    sock.ev.on('creds.update', saveCreds)

    /** ---------------- JID HELPERS ---------------- */
    sock.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {}
            return decode.user && decode.server ? decode.user + '@' + decode.server : jid
        }
        return jid
    }

    sock.getName = async (jid) => {
        jid = sock.decodeJid(jid)
        let v = store.contacts[jid] || {}
        if (jid.endsWith('@g.us')) v = await store.groupMetadata(jid) || {}
        return v.name || v.subject || PhoneNumber('+' + jid.replace('@s.whatsapp.net','')).getNumber('international')
    }

    sock.public = true
    sock.serializeM = (m) => m

    /** ---------------- MESSAGE HANDLER ---------------- */
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0]
        if (!m.message || m.key.fromMe) return

        const chatId = m.key.remoteJid
        const isGroup = chatId.endsWith('@g.us')
        const sender = m.key.participant || m.key.remoteJid // participant in group or inbox
        const text =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption ||
            ''

        let memory = loadMemory()
        if (!memory[sender]) memory[sender] = { global: { lastMessage: '', lastReply: '' }, groups: {} }

        // 🔹 Set default group mode to OFF
        if (isGroup && memory[sender].groups[chatId] === undefined) {
            memory[sender].groups[chatId] = false
            saveMemory(memory)
        }

        /** ---------------- ADMIN COMMANDS ---------------- */
        if (ADMIN_NUMBERS.includes(sender)) {
            if (text.toLowerCase() === '/ping') {
                await sock.sendMessage(chatId, { text: '🏓 Pong!' }, { quoted: m })
                return
            }
            if (text.toLowerCase().startsWith('/broadcast ')) {
                const msg = text.slice(11)
                const allChats = await sock.groupFetchAllParticipating()
                for (const gid of Object.keys(allChats)) {
                    await sock.sendMessage(gid, { text: `[Broadcast]\n${msg}` })
                }
                await sock.sendMessage(chatId, { text: '📢 Broadcast sent.' }, { quoted: m })
                return
            }
            if (text.toLowerCase().startsWith('/shell ')) {
                exec(text.slice(7), (err, stdout, stderr) => {
                    sock.sendMessage(chatId, { text: err ? String(err) : stdout || stderr || 'No output' }, { quoted: m })
                })
                return
            }
        }

        /** ---------------- KAI GROUP COMMANDS ---------------- */
        if (isGroup) {
            if (text.toLowerCase() === 'kai on') {
                memory[sender].groups[chatId] = true
                saveMemory(memory)
                await sock.sendMessage(chatId, { text: "✅ Kai activated for you in this group." }, { quoted: m })
                return
            }
            if (text.toLowerCase() === 'kai off') {
                memory[sender].groups[chatId] = false
                saveMemory(memory)
                await sock.sendMessage(chatId, { text: "❌ Kai deactivated for you in this group." }, { quoted: m })
                return
            }
            if (memory[sender].groups[chatId] === false) return
        }

        /** ---------------- KAI API RESPONSE ---------------- */
        if (text) {
            try {
                const apiUrl = `https://kai-api-z744.onrender.com?prompt=${encodeURIComponent(text)}&personid=${encodeURIComponent(sender)}`
                const res = await axios.get(apiUrl)
                const reply = res.data.reply || "⚠️ No reply from API"

                // Send reply in chat
                await sock.sendMessage(chatId, { text: reply }, { quoted: m })

                // Save globally for inbox & group
                memory[sender].global.lastMessage = text
                memory[sender].global.lastReply = reply
                saveMemory(memory)
            } catch (err) {
                await sock.sendMessage(chatId, { text: "⚠️ Error fetching response from API." }, { quoted: m })
            }
        }

        /** ---------------- GREETING REACTIONS ---------------- */
        if (/^(hi|hello|hey)$/i.test(text)) {
            await sock.sendMessage(chatId, { react: { text: "👋", key: m.key } })
        }
    })

    /** ---------------- GROUP PARTICIPANT EVENTS ---------------- */
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (action === 'add') {
            for (const p of participants) await sock.sendMessage(id, { text: `👋 Welcome <@${p.split('@')[0]}>!` }, { mentions: [p] })
        }
        if (action === 'remove') {
            for (const p of participants) await sock.sendMessage(id, { text: `👋 Goodbye <@${p.split('@')[0]}>!` }, { mentions: [p] })
        }
    })

    return sock
}

/** ---------------- START BOT ---------------- */
startBot().catch(err => console.error(err))
