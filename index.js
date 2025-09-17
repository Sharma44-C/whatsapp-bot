import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import fs from 'fs-extra'
import express from 'express'

const app = express()
const PORT = 3000

// memory file to track users
const memoryFile = './memory.json'
if (!fs.existsSync(memoryFile)) fs.writeJsonSync(memoryFile, {})

function loadMemory() {
  return fs.readJsonSync(memoryFile)
}
function saveMemory(data) {
  fs.writeJsonSync(memoryFile, data, { spaces: 2 })
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false // disable QR since we want pairing code
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection } = update

    // 🔹 Generate pairing code on first login
    if (update.pairingCode) {
      console.log(`🔑 Pairing Code: ${update.pairingCode}`)
      console.log(`👉 Open WhatsApp > Linked Devices > Link with Phone Number and enter the code above.`)
    }

    if (connection === 'open') console.log('✅ Connected to WhatsApp!')
    if (connection === 'close') console.log('❌ Connection closed, restarting...')
  })

  // Request pairing code if not registered
  if (!state.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER || 'YOUR_PHONE_NUMBER_HERE' // example: 27831234567
    const code = await sock.requestPairingCode(phoneNumber)
    console.log(`📲 Pair this device using code: ${code}`)
  }

  // 🔹 Message handler
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return

    const sender = m.key.participant || m.key.remoteJid
    const chatId = m.key.remoteJid
    const text = m.message.conversation || m.message.extendedTextMessage?.text
    if (!text) return

    console.log(`[MSG] ${sender}: ${text}`)

    let memory = loadMemory()
    if (!memory[sender]) memory[sender] = { groups: {} }

    const isGroup = chatId.endsWith('@g.us')

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

    // 🔹 Fetch reply from API (always returns { reply: "..." })
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
      console.error('API error:', err)
      await sock.sendMessage(chatId, { text: "⚠️ Error fetching response from API." }, { quoted: m })
    }
  })
}

startBot()
