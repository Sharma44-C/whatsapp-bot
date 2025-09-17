import express from 'express'
import makeWASocket, { useSingleFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys'
import fetch from 'node-fetch'
import fs from 'fs-extra'

const PORT = process.env.PORT || 3000
const SESSION_FILE = './creds.json'
const MEMORY_FILE = './memory.json'
const ADMIN_NUMBERS = ['123456789@s.whatsapp.net']

if (!fs.existsSync(MEMORY_FILE)) fs.writeJsonSync(MEMORY_FILE, {})
function loadMemory() { return fs.readJsonSync(MEMORY_FILE) }
function saveMemory(data) { fs.writeJsonSync(MEMORY_FILE, data, { spaces: 2 }) }

const app = express()
app.get('/', (req, res) => res.send('WhatsApp Bot is running.'))
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`))

console.log(`Bot running on port ${PORT}`)

async function startBot() {
  const { state, saveCreds } = useSingleFileAuthState(SESSION_FILE)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'open') console.log('✅ Connected to WhatsApp!')
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Removing session and restarting...')
        fs.removeSync(SESSION_FILE)
      }
      console.log('🔄 Disconnected. Restarting...')
      setTimeout(startBot, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return

    const sender = m.key.participant || m.key.remoteJid
    const chatId = m.key.remoteJid
    const isGroup = chatId.endsWith('@g.us')
    const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || ''

    let memory = loadMemory()
    if (!memory[sender]) memory[sender] = { groups: {} }

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
        const exec = require('child_process').exec
        exec(text.slice(7), (err, stdout, stderr) => {
          sock.sendMessage(chatId, { text: err ? String(err) : stdout || stderr || 'No output' }, { quoted: m })
        })
        return
      }
    }

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

    if (text) {
      try {
        const apiUrl = `https://kai-api-z744.onrender.com?prompt=${encodeURIComponent(text)}&personid=${encodeURIComponent(sender)}`
        const res = await fetch(apiUrl)
        const json = await res.json()
        const reply = json.reply || "⚠️ No reply from API"
        await sock.sendMessage(chatId, { text: reply }, { quoted: m })
        memory[sender].lastMessage = text
        memory[sender].lastReply = reply
        saveMemory(memory)
      } catch (err) {
        await sock.sendMessage(chatId, { text: "⚠️ Error fetching response from API." }, { quoted: m })
      }
    }
  })

  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update
    if (action === 'add') {
      for (const part of participants) {
        await sock.sendMessage(id, { text: `👋 Welcome <@${part.split('@')[0]}>!` }, { mentions: [part] })
      }
    }
    if (action === 'remove') {
      for (const part of participants) {
        await sock.sendMessage(id, { text: `👋 Goodbye <@${part.split('@')[0]}>!` }, { mentions: [part] })
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const chatId = m.key.remoteJid
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ''
    if (/^(hi|hello|hey)$/i.test(text)) {
      await sock.sendMessage(chatId, { react: { text: "👋", key: m.key } })
    }
  })
}

startBot()
