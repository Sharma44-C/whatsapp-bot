/**
 * kai-bot.js
 * Single-file WhatsApp bot (Baileys) with:
 * - Owner / Group Admin / Member role system
 * - Dynamic help menu (role-sorted)
 * - Group management commands (rules, warns, kick, promote, etc.)
 * - Automod (badwords, link, spam) with toggles
 * - Kai ON/OFF per-person in groups (simple)
 * - Owner notifications when the bot is added to a group
 * - Persistent JSON storage (groups.json, botConfig.json, logs.json, kaiSettings.json)
 *
 * Run: node kai-bot.js
 */

const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const axios = require('axios')
const NodeCache = require("node-cache")
const pino = require("pino")
const PhoneNumber = require('awesome-phonenumber')
const express = require('express')
const { exec } = require('child_process')
const qrcode = require('qrcode')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidDecode
} = require('baileys')

/** ------------- CONFIG ------------- */
const DATA_DIR = './data'
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')
const BOTCONFIG_FILE = path.join(DATA_DIR, 'botConfig.json')
const LOGS_FILE = path.join(DATA_DIR, 'logs.json')
const KAI_FILE = path.join(DATA_DIR, 'kaiSettings.json')

// Default data
const defaultGroups = {}
const defaultBotConfig = {
    owners: ["27639412189@s.whatsapp.net"],    // replace with your owner JID(s)
    prefix: "!",
    version: "1.0.0",
    globalBans: []
}
const defaultLogs = []
const defaultKai = { groups: {} }

// Helpers to read/write JSON
function readJSON(file, def) {
    try {
        if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)) }
        return JSON.parse(fs.readFileSync(file, 'utf8') || 'null') || def
    } catch (e) { console.error('JSON read error', file, e); return def }
}
function writeJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)) } catch (e) { console.error('JSON write error', file, e) }
}

let groupsDB = readJSON(GROUPS_FILE, defaultGroups)
let botConfig = readJSON(BOTCONFIG_FILE, defaultBotConfig)
let logsDB = readJSON(LOGS_FILE, defaultLogs)
let kaiDB = readJSON(KAI_FILE, defaultKai)

/** ------------- BOT META ------------- */
global.botname = "Kai Bot"
global.themeemoji = "•"
const OWNER_NUMBERS = botConfig.owners // JIDs
const ADMIN_NUMBERS = botConfig.owners // for backwards compatibility; owner(s) are bot admins

/** ------------- EXPRESS SERVER ------------- */
const PORT = process.env.PORT || 3000
const app = express()
let lastQR = null
app.get('/', (_req, res) => res.send('Kai Bot running.'))
app.get('/qr', (_req, res) => {
    if (!lastQR) return res.send('No QR generated yet.')
    res.type('png')
    res.send(Buffer.from(lastQR.split(',')[1], 'base64'))
})
app.listen(PORT, () => console.log(chalk.green(`Express server running on port ${PORT}`)))

/** ------------- STORE (light) ------------- */
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

/** ------------- UTILITIES ------------- */
function safeLog(evt, info) {
    logsDB.push({ t: Date.now(), evt, info })
    if (logsDB.length > 2000) logsDB.shift()
    writeJSON(LOGS_FILE, logsDB)
}

function jidNormalize(jid) {
    if (!jid) return jid
    return String(jid).split(':')[0]
}

function mentionMeCheck(m, sock) {
    // returns true if message mentions the bot or is a reply to bot, otherwise false
    try {
        const botJid = sock.user?.id?.split(':')[0] || sock.user?.id
        const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
        if (mentioned.includes(botJid)) return true
        // also if message is a reply and the quoted message is from bot
        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
        const qsender = m.message?.extendedTextMessage?.contextInfo?.participant
        if (qsender && jidNormalize(qsender) === jidNormalize(botJid)) return true
    } catch {}
    return false
}

/** ------------- START BOT ------------- */
async function startBot() {
    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState(`./session`)
    const msgRetryCounterCache = new NodeCache()

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["KaiBot", "Chrome", "1.0.0"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: 60000,
        msgRetryCounterCache
    })

    store.bind(sock.ev)

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update
        if (qr) {
            lastQR = await qrcode.toDataURL(qr)
            console.log(chalk.green('📱 QR code generated. Visit /qr to scan it.'))
        }
        if (connection === 'open') {
            console.log(chalk.green('✅ Connected to WhatsApp!'))
            safeLog('connected', { version })
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            safeLog('disconnected', { reason })
            if (reason === DisconnectReason.loggedOut) {
                fs.rmSync('./session', { recursive: true, force: true })
                console.log(chalk.red('Logged out; session removed.'))
            }
            console.log('🔄 Reconnecting...')
            setTimeout(startBot, 3000)
        }
    })
    sock.ev.on('creds.update', saveCreds)

    /** ------------- JID HELPERS ------------- */
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
        if (jid.endsWith('@g.us')) {
            try { v = await sock.groupMetadata(jid) || {} } catch { v = await store.groupMetadata(jid) || {} }
        }
        try {
            return v.name || v.subject || PhoneNumber('+' + jid.replace('@s.whatsapp.net','')).getNumber('international')
        } catch {
            return jid
        }
    }

    // Role checks
    function isOwner(jid) {
        const n = jidNormalize(jid)
        return (botConfig.owners || []).map(x => jidNormalize(x)).includes(n)
    }

    async function isGroupAdmin(chatId, jid) {
        try {
            const meta = await sock.groupMetadata(chatId)
            const adminJids = (meta.participants || []).filter(p => p.admin).map(p => jidNormalize(p.id))
            return adminJids.includes(jidNormalize(jid))
        } catch {
            // fallback false
            return false
        }
    }

    async function isBotAdmin(chatId) {
        try {
            const meta = await sock.groupMetadata(chatId)
            const botJ = jidNormalize(sock.user.id)
            const botPart = (meta.participants || []).find(p => jidNormalize(p.id) === botJ) || {}
            return Boolean(botPart.admin)
        } catch {
            return false
        }
    }

    sock.public = true
    sock.serializeM = (m) => m

    /** ------------- COMMANDS SETUP ------------- */
    const commands = {
        general: [
            {
                name: 'help',
                desc: 'Show this help menu',
                run: async ({m, chatId, sender, isGroup, role}) => {
                    const p = botConfig.prefix || '!'
                    const generalList = [
                        'rules', 'profile', 'report', 'whois', 'stats', 'help', 'kaion', 'kaioff', 'kai status'
                    ]
                    const adminList = [
                        'setrules', 'warn', 'warns', 'setwarnsthreshold', 'kick', 'welcome on/off', 'antilink on/off', 'antispam on/off'
                    ]
                    const ownerList = [
                        'forcekick', 'forceadd', 'forcepromote', 'forcedemote', 'broadcast', 'shutdown', 'setprefix', 'getgroups', 'getgroupinfo'
                    ]
                    let text = `*${global.themeemoji} Kai Bot Help Menu*\nPrefix: \`${p}\`\n\n`
                    text += '*👤 General (everyone)*\n'
                    generalList.forEach(cmd => text += ` • ${p}${cmd}\n`)
                    if (role === 'groupAdmin' || role === 'owner') {
                        text += '\n*🛡️ Group Admin*\n'
                        adminList.forEach(cmd => text += ` • ${p}${cmd}\n`)
                    }
                    if (role === 'owner') {
                        text += '\n*👑 Owner*\n'
                        ownerList.forEach(cmd => text += ` • ${p}${cmd}\n`)
                    }
                    text += `\n_Type commands with the prefix_${p}`
                    await sock.sendMessage(chatId, { text }, { quoted: m })
                }
            },
            {
                name: 'profile',
                desc: 'Show your contact info',
                run: async ({m, chatId, sender}) => {
                    const name = await sock.getName(sender)
                    await sock.sendMessage(chatId, { text: `Profile\nName: ${name}\nJID: ${sender}` }, { quoted: m })
                }
            },
            {
                name: 'ping',
                desc: 'Pong/ping',
                run: async ({m, chatId}) => {
                    await sock.sendMessage(chatId, { text: '🏓 Pong!' }, { quoted: m })
                }
            },
            {
                name: 'uptime',
                desc: 'Bot uptime',
                run: async ({m, chatId, startTime}) => {
                    const uptime = Date.now() - startTime
                    const s = Math.floor(uptime/1000)%60
                    const mns = Math.floor(uptime/60000)%60
                    const hrs = Math.floor(uptime/3600000)
                    await sock.sendMessage(chatId, { text: `Uptime: ${hrs}h ${mns}m ${s}s` }, { quoted: m })
                }
            },
            {
                name: 'version',
                desc: 'Bot version',
                run: async ({m, chatId}) => {
                    await sock.sendMessage(chatId, { text: `Kai Bot v${botConfig.version}` }, { quoted: m })
                }
            },
            {
                name: 'kaion',
                desc: 'Enable Kai replies for you in this group',
                run: async ({m, chatId, sender, isGroup}) => {
                    if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m })
                    kaiDB.groups[chatId] = kaiDB.groups[chatId] || { members: {} }
                    kaiDB.groups[chatId].members = kaiDB.groups[chatId].members || {}
                    kaiDB.groups[chatId].members[jidNormalize(sender)] = true
                    writeJSON(KAI_FILE, kaiDB)
                    await sock.sendMessage(chatId, { text: '✅ Kai ON for you in this group.' }, { quoted: m })
                }
            },
            {
                name: 'kaioff',
                desc: 'Disable Kai replies for you in this group',
                run: async ({m, chatId, sender, isGroup}) => {
                    if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m })
                    kaiDB.groups[chatId] = kaiDB.groups[chatId] || { members: {} }
                    kaiDB.groups[chatId].members = kaiDB.groups[chatId].members || {}
                    kaiDB.groups[chatId].members[jidNormalize(sender)] = false
                    writeJSON(KAI_FILE, kaiDB)
                    await sock.sendMessage(chatId, { text: '⛔ Kai OFF for you in this group.' }, { quoted: m })
                }
            },
            {
                name: 'kai status',
                desc: 'Show whether Kai is ON/OFF for you in this group',
                run: async ({m, chatId, sender, isGroup}) => {
                    if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m })
                    const val = kaiDB.groups[chatId]?.members?.[jidNormalize(sender)]
                    const state = (typeof val === 'undefined') ? 'ON (default)' : (val ? 'ON' : 'OFF')
                    await sock.sendMessage(chatId, { text: `Kai for you in this group: ${state}` }, { quoted: m })
                }
            }
        ],
        groupAdmin: [
            {
                name: 'setrules',
                desc: 'Set group rules: !setrules <text>',
                run: async ({m, chatId, args, sender}) => {
                    const txt = args.join(' ')
                    if (!txt) return await sock.sendMessage(chatId, { text: 'Usage: setrules <rules text>' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || { rules: '', warnThreshold: 2, automod: { badwords: true, antilink: false, antispam: true }, warns: {} }
                    groupsDB[chatId].rules = txt
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `✅ Rules set for this group.` }, { quoted: m })
                }
            },
            {
                name: 'rules',
                desc: 'Show group rules',
                run: async ({m, chatId}) => {
                    const rules = groupsDB[chatId]?.rules || 'No rules set.'
                    await sock.sendMessage(chatId, { text: `📜 Rules:\n${rules}` }, { quoted: m })
                }
            },
            {
                name: 'warn',
                desc: 'Warn a user: !warn @user [reason]',
                run: async ({m, chatId, args, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : args[0]
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !warn @user [reason]' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || { warnThreshold: 2, warns: {} }
                    groupsDB[chatId].warns = groupsDB[chatId].warns || {}
                    groupsDB[chatId].warns[target] = (groupsDB[chatId].warns[target] || 0) + 1
                    writeJSON(GROUPS_FILE, groupsDB)
                    const count = groupsDB[chatId].warns[target]
                    await sock.sendMessage(chatId, { text: `⚠️ <@${target.split('@')[0]}> warned. (${count}/${groupsDB[chatId].warnThreshold || 2})`, mentions: [target] }, { quoted: m })
                    if (count >= (groupsDB[chatId].warnThreshold || 2)) {
                        // attempt kick if bot admin
                        const botIsAdmin = await isBotAdmin(chatId)
                        if (botIsAdmin) {
                            try {
                                await sock.groupRemove(chatId, [target])
                                await sock.sendMessage(chatId, { text: `🚫 <@${target.split('@')[0]}> was removed after reaching warn threshold.`, mentions: [target] })
                                safeLog('autokick', { chatId, target })
                            } catch (e) {
                                await sock.sendMessage(chatId, { text: `⚠️ Couldn't remove <@${target.split('@')[0]}> — check bot admin status or permissions.`, mentions: [target] })
                            }
                        } else {
                            await sock.sendMessage(chatId, { text: `⚠️ <@${target.split('@')[0]}> reached warns but bot is not admin. Owner notified.`, mentions: [target] })
                            // notify owner
                            for (const o of botConfig.owners) {
                                await sock.sendMessage(o, { text: `⚠️ User ${target} in group ${chatId} reached warn threshold but bot missing admin — manual action needed.` })
                            }
                        }
                        // reset warns for that user
                        groupsDB[chatId].warns[target] = 0
                        writeJSON(GROUPS_FILE, groupsDB)
                    }
                }
            },
            {
                name: 'warns',
                desc: 'Show warns for a user: !warns @user',
                run: async ({m, chatId, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !warns @user' }, { quoted: m })
                    const count = (groupsDB[chatId]?.warns?.[target]) || 0
                    await sock.sendMessage(chatId, { text: `⚠️ <@${target.split('@')[0]}> has ${count} warns.`, mentions: [target] }, { quoted: m })
                }
            },
            {
                name: 'setwarnsthreshold',
                desc: 'Set warns needed for action: !setwarnsthreshold <n>',
                run: async ({m, chatId, args}) => {
                    const n = parseInt(args[0])
                    if (!n || n < 1) return await sock.sendMessage(chatId, { text: 'Usage: !setwarnsthreshold <n>' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || {}
                    groupsDB[chatId].warnThreshold = n
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `✅ Warn threshold set to ${n}` }, { quoted: m })
                }
            },
            {
                name: 'kick',
                desc: 'Kick a user: !kick @user (bot needs admin)',
                run: async ({m, chatId, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !kick @user' }, { quoted: m })
                    const botIsAdmin = await isBotAdmin(chatId)
                    if (!botIsAdmin) return await sock.sendMessage(chatId, { text: 'I need admin to kick. Owner has been notified.' }, { quoted: m })
                    try {
                        await sock.groupRemove(chatId, [target])
                        await sock.sendMessage(chatId, { text: `🚫 <@${target.split('@')[0]}> kicked.`, mentions: [target] })
                    } catch (e) {
                        await sock.sendMessage(chatId, { text: '⚠️ Kick failed.' }, { quoted: m })
                    }
                }
            },
            {
                name: 'welcome',
                desc: 'Toggle welcome messages: !welcome on/off',
                run: async ({m, chatId, args}) => {
                    const t = (args[0] || '').toLowerCase()
                    if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !welcome on|off' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || {}
                    groupsDB[chatId].welcome = (t === 'on')
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `✅ Welcome messages ${t.toUpperCase()}` }, { quoted: m })
                }
            },
            {
                name: 'antilink',
                desc: 'Toggle anti-link: !antilink on/off',
                run: async ({m, chatId, args}) => {
                    const t = (args[0] || '').toLowerCase()
                    if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !antilink on|off' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || {}
                    groupsDB[chatId].automod = groupsDB[chatId].automod || {}
                    groupsDB[chatId].automod.antilink = (t === 'on')
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `✅ Antilink ${t.toUpperCase()}` }, { quoted: m })
                }
            },
            {
                name: 'antispam',
                desc: 'Toggle anti-spam: !antispam on/off',
                run: async ({m, chatId, args}) => {
                    const t = (args[0] || '').toLowerCase()
                    if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !antispam on|off' }, { quoted: m })
                    groupsDB[chatId] = groupsDB[chatId] || {}
                    groupsDB[chatId].automod = groupsDB[chatId].automod || {}
                    groupsDB[chatId].automod.antispam = (t === 'on')
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `✅ Antispam ${t.toUpperCase()}` }, { quoted: m })
                }
            }
        ],
        owner: [
            {
                name: 'forcekick',
                desc: 'Owner only: force kick user from group',
                run: async ({m, chatId, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcekick @user' }, { quoted: m })
                    try {
                        await sock.groupRemove(chatId, [target])
                        await sock.sendMessage(chatId, { text: `✅ <@${target.split('@')[0]}> removed by owner.`, mentions: [target] })
                    } catch (e) {
                        await sock.sendMessage(chatId, { text: '⚠️ forcekick failed. Ensure bot is admin.' }, { quoted: m })
                    }
                }
            },
            {
                name: 'forceadd',
                desc: 'Owner only: force add phone number to group (requires bot admin)',
                run: async ({m, chatId, args}) => {
                    const phone = args[0]
                    if (!phone) return await sock.sendMessage(chatId, { text: 'Usage: !forceadd <number_without_plus>' }, { quoted: m })
                    const toJid = `${phone}@s.whatsapp.net`
                    try {
                        await sock.groupAdd(chatId, [toJid])
                        await sock.sendMessage(chatId, { text: `✅ Added ${phone}` })
                    } catch {
                        await sock.sendMessage(chatId, { text: '⚠️ forceadd failed. Ensure bot/admin permissions.' })
                    }
                }
            },
            {
                name: 'forcepromote',
                desc: 'Owner only: promote user',
                run: async ({m, chatId, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcepromote @user' }, { quoted: m })
                    try {
                        await sock.groupParticipantsUpdate(chatId, [target], 'promote')
                        await sock.sendMessage(chatId, { text: `✅ <@${target.split('@')[0]}> promoted.`, mentions: [target] })
                    } catch {
                        await sock.sendMessage(chatId, { text: '⚠️ promote failed.' }, { quoted: m })
                    }
                }
            },
            {
                name: 'forcedemote',
                desc: 'Owner only: demote user',
                run: async ({m, chatId, mentions}) => {
                    const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null
                    if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcedemote @user' }, { quoted: m })
                    try {
                        await sock.groupParticipantsUpdate(chatId, [target], 'demote')
                        await sock.sendMessage(chatId, { text: `✅ <@${target.split('@')[0]}> demoted.`, mentions: [target] })
                    } catch {
                        await sock.sendMessage(chatId, { text: '⚠️ demote failed.' }, { quoted: m })
                    }
                }
            },
            {
                name: 'broadcast',
                desc: 'Owner only: broadcast to all groups',
                run: async ({m, args}) => {
                    const msg = args.join(' ')
                    if (!msg) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !broadcast <text>' }, { quoted: m })
                    const all = await sock.groupFetchAllParticipating()
                    for (const gid of Object.keys(all)) {
                        await sock.sendMessage(gid, { text: `[Broadcast]\n${msg}` })
                    }
                    await sock.sendMessage(OWNER_NUMBERS[0], { text: '📢 Broadcast sent.' })
                }
            },
            {
                name: 'shutdown',
                desc: 'Owner only: shutdown bot',
                run: async ({m}) => {
                    await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Shutting down (owner requested).' })
                    process.exit(0)
                }
            },
            {
                name: 'setprefix',
                desc: 'Owner only: set command prefix: !setprefix <char>',
                run: async ({m, args}) => {
                    const p = args[0]
                    if (!p) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !setprefix <prefix>' }, { quoted: m })
                    botConfig.prefix = p
                    writeJSON(BOTCONFIG_FILE, botConfig)
                    await sock.sendMessage(OWNER_NUMBERS[0], { text: `Prefix changed to ${p}` })
                }
            },
            {
                name: 'getgroups',
                desc: 'Owner only: list groups bot is in',
                run: async ({m}) => {
                    const all = await sock.groupFetchAllParticipating()
                    const list = Object.keys(all).map(gid => `${gid} (${all[gid].subject || 'no-name'})`).join('\n') || 'No groups'
                    await sock.sendMessage(OWNER_NUMBERS[0], { text: `Groups:\n${list}` })
                }
            },
            {
                name: 'getgroupinfo',
                desc: 'Owner only: get group metadata: !getgroupinfo <groupId>',
                run: async ({m, args}) => {
                    const gid = args[0]
                    if (!gid) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !getgroupinfo <groupId>' })
                    try {
                        const meta = await sock.groupMetadata(gid)
                        await sock.sendMessage(OWNER_NUMBERS[0], { text: `Group: ${meta.subject}\nID:${gid}\nMembers:${meta.participants.length}` })
                    } catch {
                        await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Failed to fetch metadata.' })
                    }
                }
            }
        ]
    }

    /** ------------- AUTOMOD & BADWORDS ------------- */
    const globalBadWords = ['badword1','badword2'] // add words you want to block globally
    function containsBadWord(text, groupId) {
        const g = (groupsDB[groupId] && groupsDB[groupId].badWords) || []
        const words = [...globalBadWords, ...g]
        const lower = String(text || '').toLowerCase()
        return words.some(w => w && lower.includes(w))
    }

    /** ------------- MESSAGE HANDLER ------------- */
    const startTime = Date.now()
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0]
        try {
            if (!m.message || m.key.fromMe) return

            const chatId = m.key.remoteJid
            const isGroup = chatId.endsWith('@g.us')
            const sender = sock.decodeJid(m.key.participant || m.key.remoteJid)
            const senderNorm = jidNormalize(sender)
            let text =
                m.message.conversation ||
                m.message.extendedTextMessage?.text ||
                m.message.imageMessage?.caption ||
                m.message.videoMessage?.caption ||
                ''
            text = String(text || '').trim()

            // prefix handling
            const prefix = botConfig.prefix || '!'
            const isCmd = text.startsWith(prefix)
            const bodyNoPrefix = isCmd ? text.slice(prefix.length).trim() : text
            const split = bodyNoPrefix.split(/\s+/)
            const cmdName = split[0] ? split[0].toLowerCase() : ''
            const args = split.slice(1)
            const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || []

            // determine role
            const role = (isOwner(senderNorm) ? 'owner' : (isGroup ? (await isGroupAdmin(chatId, senderNorm) ? 'groupAdmin' : 'member') : 'member'))

            // Check global ban
            if (botConfig.globalBans && botConfig.globalBans.includes(senderNorm)) return

            // If group and kai-off for this user, skip AI reply and ignore non-commands
            const isKaiOnForUser = (() => {
                if (!isGroup) return true
                const g = kaiDB.groups[chatId]
                if (!g || !g.members) return true
                const v = g.members[senderNorm]
                if (typeof v === 'undefined') return true
                return Boolean(v)
            })()

            /** ---------- If it's a command (prefix) handle permission checks ---------- */
            if (isCmd) {
                // route command to appropriate collection
                const findIn = (list) => list.find(c => c.name === cmdName || c.name === `${cmdName}`)
                let executed = false

                // Owner commands
                if (isOwner(senderNorm)) {
                    const c = findIn(commands.owner)
                    if (c) { await c.run({ m, chatId, sender: senderNorm, args, mentions, startTime }); executed = true }
                }

                // Group admin commands
                if (!executed && (role === 'groupAdmin' || role === 'owner')) {
                    const c = findIn(commands.groupAdmin)
                    if (c) {
                        // Enforce policy: if bot is admin in group, only owner may run groupAdmin admin-level actions
                        if (isGroup && await isBotAdmin(chatId) && !isOwner(senderNorm)) {
                            await sock.sendMessage(chatId, { text: '❗ Bot is admin in this group — only the bot owner can run admin-level commands to prevent hijack.' }, { quoted: m })
                            executed = true
                        } else {
                            await c.run({ m, chatId, sender: senderNorm, args, mentions, startTime })
                            executed = true
                        }
                    }
                }

                // General commands
                if (!executed) {
                    const c = findIn(commands.general)
                    if (c) { await c.run({ m, chatId, sender: senderNorm, args, mentions, isGroup, startTime, role }); executed = true }
                }

                if (!executed) {
                    await sock.sendMessage(chatId, { text: `Unknown command. Try ${prefix}help` }, { quoted: m })
                }
                return
            } // end isCmd

            /** ---------- NON-COMMAND MESSAGE: Moderation + Kai reply ---------- */

            // Automod: bad words
            if (isGroup && containsBadWord(text, chatId) && groupsDB[chatId]?.automod?.badwords !== false) {
                // issue warn automatically
                groupsDB[chatId] = groupsDB[chatId] || { warnThreshold: 2, warns: {} }
                groupsDB[chatId].warns = groupsDB[chatId].warns || {}
                groupsDB[chatId].warns[senderNorm] = (groupsDB[chatId].warns[senderNorm] || 0) + 1
                writeJSON(GROUPS_FILE, groupsDB)
                const count = groupsDB[chatId].warns[senderNorm]
                await sock.sendMessage(chatId, { text: `⚠️ <@${senderNorm.split('@')[0]}> watch your language. Warning (${count}/${groupsDB[chatId].warnThreshold || 2})`, mentions: [senderNorm] })
                safeLog('automod_badword', { chatId, sender: senderNorm, text })
                // if over threshold, action handled in warn command logic: here try auto-kick
                if (count >= (groupsDB[chatId].warnThreshold || 2)) {
                    const botIsAdmin = await isBotAdmin(chatId)
                    if (botIsAdmin) {
                        try {
                            await sock.groupRemove(chatId, [senderNorm])
                            await sock.sendMessage(chatId, { text: `🚫 <@${senderNorm.split('@')[0]}> was removed after reaching warns (auto).`, mentions: [senderNorm] })
                        } catch (e) {
                            await sock.sendMessage(chatId, { text: '⚠️ Auto-remove failed.' })
                        }
                    } else {
                        for (const o of botConfig.owners) await sock.sendMessage(o, { text: `⚠️ User ${senderNorm} in ${chatId} reached warn threshold (auto) but bot is not admin.` })
                    }
                    groupsDB[chatId].warns[senderNorm] = 0
                    writeJSON(GROUPS_FILE, groupsDB)
                }
                return
            }

            // Antilink
            if (isGroup && groupsDB[chatId]?.automod?.antilink && /https?:\/\/\S+/i.test(text)) {
                await sock.sendMessage(chatId, { text: `🔗 Links are not allowed in this group.` }, { quoted: m })
                safeLog('antilink', { chatId, sender: senderNorm, text })
                return
            }

            // Antispam (very simple: repeated exact message from same user within short time)
            if (isGroup && groupsDB[chatId]?.automod?.antispam) {
                // quick naive antispam: track last message per user in memory
                store._last = store._last || {}
                const key = `${chatId}:${senderNorm}`
                const last = store._last[key]
                if (last && last.text === text && (Date.now() - last.t) < 5000) {
                    // repeated message within 5s
                    // count as spam -> warn
                    groupsDB[chatId] = groupsDB[chatId] || { warns: {}, warnThreshold: 2 }
                    groupsDB[chatId].warns = groupsDB[chatId].warns || {}
                    groupsDB[chatId].warns[senderNorm] = (groupsDB[chatId].warns[senderNorm] || 0) + 1
                    writeJSON(GROUPS_FILE, groupsDB)
                    await sock.sendMessage(chatId, { text: `⚠️ <@${senderNorm.split('@')[0]}> please stop spamming.`, mentions: [senderNorm] })
                    safeLog('antispam_warn', { chatId, sender: senderNorm, text })
                    store._last[key] = { text, t: Date.now() }
                    return
                }
                store._last[key] = { text, t: Date.now() }
            }

            // KI: Should the bot reply? Check group mode: default behavior: respond only when mentioned or replied to
            let respondInGroup = true
            // default group mode: 'mention' (respond only when mentioned or replied), 'always' respond to all
            const mode = groupsDB[chatId]?.respondMode || 'mention' // allow later set
            if (isGroup) {
                if (mode === 'mention') respondInGroup = mentionMeCheck(m, sock)
                else respondInGroup = true
            }

            // Check per-person Kai ON/OFF
            if (isGroup && !isKaiOnForUser) {
                // user turned off Kai in this group -> skip AI reply entirely
                return
            }

            // Only reply with Kai if not command and if allowed by group respond mode
            if (!isGroup || (isGroup && respondInGroup)) {
                if (text) {
                    // respond via your Kai API
                    try {
                        const apiUrl = `https://kai-api-z744.onrender.com?prompt=${encodeURIComponent(text)}&personid=${encodeURIComponent(sender)}`
                        const res = await axios.get(apiUrl)
                        const reply = res.data.reply || "⚠️ No reply from Kai API"
                        await sock.sendMessage(chatId, { text: reply }, { quoted: m })
                        safeLog('kai_reply', { chatId, sender: senderNorm, text })
                    } catch (err) {
                        await sock.sendMessage(chatId, { text: "⚠️ Error fetching reply from Kai API." }, { quoted: m })
                    }
                }
            }

        } catch (err) {
            console.error('messages.upsert error', err)
        }
    }) // end messages.upsert

    /** ------------- GROUP PARTICIPANTS (welcome/goodbye & owner notify when bot added) ------------- */
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id: chatId, participants, action } = update
            for (const p of participants) {
                const userJid = sock.decodeJid(p)
                const simple = userJid.split('@')[0]
                if (action === 'add') {
                    // if bot was added (our jid in participants), notify owner
                    const me = jidNormalize(sock.user.id)
                    if (userJid === me) {
                        // bot added to group
                        try {
                            const meta = await sock.groupMetadata(chatId)
                            const subject = meta.subject || 'no-subject'
                            const admins = (meta.participants || []).filter(x => x.admin).map(x => x.id)
                            const msg = `🤖 Bot added to group:\nName: ${subject}\nID: ${chatId}\nMembers: ${meta.participants.length}\nAdmins: ${admins.join(', ')}`
                            for (const o of botConfig.owners) await sock.sendMessage(o, { text: msg })
                            safeLog('bot_added', { chatId, subject, by: update.by })
                        } catch (e) {
                            for (const o of botConfig.owners) await sock.sendMessage(o, { text: `🤖 Bot added to ${chatId}` })
                            safeLog('bot_added_fallback', { chatId })
                        }
                    } else {
                        // normal welcome
                        if (groupsDB[chatId]?.welcome !== false) {
                            await sock.sendMessage(chatId, { text: `👋 Welcome @${simple}!`, mentions: [userJid] })
                        }
                    }
                }
                if (action === 'remove' && userJid !== jidNormalize(sock.user.id)) {
                    if (groupsDB[chatId]?.welcome !== false) {
                        await sock.sendMessage(chatId, { text: `👋 Goodbye @${simple}!`, mentions: [userJid] })
                    }
                }
            }
        } catch (e) {
            console.error('group-participants.update error', e)
        }
    })

    /** ------------- LOG / START ------------- */
    console.log(chalk.blue('Kai Bot loaded and running.'))
    return sock
}

startBot().catch(err => console.error('Start bot error', err))
