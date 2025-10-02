/*

kai-bot-fixed.js

Improved single-file WhatsApp bot (Baileys) with fixes and improvements:

Reliable sender detection in groups and inbox (fixes personid / profile issues)


Robust command parsing with triggers/aliases


Proper owner / groupAdmin / member permission checks


Help works with or without prefix (typing "help" shows menu)


Welcome / Goodbye messages improved (mentions + group subject + rules)


Kai API call sends the correct personid (user JID) and includes group id when relevant


Better extraction of text from many message types (buttons, lists, captions)


JSON storage and defensive reads/writes


Debug-friendly logs


Replace your existing kai-bot.js with this file and run: node kai-bot-fixed.js */


const fs = require('fs') const path = require('path') const chalk = require('chalk') const axios = require('axios') const NodeCache = require('node-cache') const pino = require('pino') const PhoneNumber = require('awesome-phonenumber') const express = require('express') const qrcode = require('qrcode') const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode } = require('baileys')

/** ------------- CONFIG & DATA ------------- */ const DATA_DIR = './data' if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json') const BOTCONFIG_FILE = path.join(DATA_DIR, 'botConfig.json') const LOGS_FILE = path.join(DATA_DIR, 'logs.json') const KAI_FILE = path.join(DATA_DIR, 'kaiSettings.json')

const defaultGroups = {} const defaultBotConfig = { owners: ["27639412189@s.whatsapp.net"], // replace with your owner JID(s) prefix: "!", version: "1.0.0", globalBans: [] } const defaultLogs = [] const defaultKai = { groups: {} }

function readJSON(file, def) { try { if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)) } return JSON.parse(fs.readFileSync(file, 'utf8') || 'null') || def } catch (e) { console.error('JSON read error', file, e); return def } } function writeJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)) } catch (e) { console.error('JSON write error', file, e) } }

let groupsDB = readJSON(GROUPS_FILE, defaultGroups) let botConfig = readJSON(BOTCONFIG_FILE, defaultBotConfig) let logsDB = readJSON(LOGS_FILE, defaultLogs) let kaiDB = readJSON(KAI_FILE, defaultKai)

/** ------------- META ------------- */ global.botname = "Kai Bot" global.themeemoji = "•" const OWNER_NUMBERS = (botConfig.owners || []).map(j => jidNormalize(j))

/** ------------- EXPRESS SERVER ------------- */ const PORT = process.env.PORT || 3000 const app = express() let lastQR = null app.get('/', (_req, res) => res.send('Kai Bot running.')) app.get('/qr', (_req, res) => { if (!lastQR) return res.send('No QR generated yet.') res.type('png') res.send(Buffer.from(lastQR.split(',')[1], 'base64')) }) app.listen(PORT, () => console.log(chalk.green(Express server running on port ${PORT})))

/** ------------- LIGHT STORE ------------- */ const store = { messages: {}, contacts: {}, chats: {}, groupMetadata: async (jid) => ({}), bind(ev) { ev.on('messages.upsert', ({ messages }) => { messages.forEach(msg => { if (msg.key?.remoteJid) { this.messages[msg.key.remoteJid] = this.messages[msg.key.remoteJid] || {} this.messages[msg.key.remoteJid][msg.key.id] = msg } }) }) ev.on('contacts.update', (contacts) => { contacts.forEach(c => { if (c.id) this.contacts[c.id] = c }) }) ev.on('chats.set', (chats) => { this.chats = chats }) }, loadMessage(jid, id) { return this.messages[jid]?.[id] || null } }

/** ------------- UTILITIES ------------- */ function safeLog(evt, info) { logsDB.push({ t: Date.now(), evt, info }) if (logsDB.length > 2000) logsDB.shift() writeJSON(LOGS_FILE, logsDB) }

function jidNormalize(jid) { if (!jid) return jid return String(jid).split(':')[0] }

function getTextFromMessage(message) { if (!message) return '' if (typeof message === 'string') return message if (message.conversation) return message.conversation if (message.extendedTextMessage?.text) return message.extendedTextMessage.text if (message.imageMessage?.caption) return message.imageMessage.caption if (message.videoMessage?.caption) return message.videoMessage.caption if (message.buttonsResponseMessage?.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId if (message.templateButtonReplyMessage?.selectedId) return message.templateButtonReplyMessage.selectedId if (message.listResponseMessage?.singleSelectReply?.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId // fallback to JSON string (useful for debugging) return '' }

/** ------------- START BOT ------------- */ async function startBot() { const { version } = await fetchLatestBaileysVersion() const { state, saveCreds } = await useMultiFileAuthState(./session) const msgRetryCounterCache = new NodeCache()

const sock = makeWASocket({ version, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ["KaiBot", "Chrome", "1.0.0"], auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })), }, markOnlineOnConnect: true, defaultQueryTimeoutMs: 60000, msgRetryCounterCache })

store.bind(sock.ev)

sock.ev.on('connection.update', async (update) => { const { connection, qr, lastDisconnect } = update if (qr) { lastQR = await qrcode.toDataURL(qr) console.log(chalk.green('📱 QR code generated. Visit /qr to scan it.')) } if (connection === 'open') { console.log(chalk.green('✅ Connected to WhatsApp!')) safeLog('connected', { version }) } if (connection === 'close') { const reason = lastDisconnect?.error?.output?.statusCode safeLog('disconnected', { reason }) if (reason === DisconnectReason.loggedOut) { fs.rmSync('./session', { recursive: true, force: true }) console.log(chalk.red('Logged out; session removed.')) } console.log('🔄 Reconnecting...') setTimeout(startBot, 3000) } }) sock.ev.on('creds.update', saveCreds)

// utilities attached to sock sock.decodeJid = (jid) => { if (!jid) return jid if (/:\d+@/gi.test(jid)) { const decode = jidDecode(jid) || {} return decode.user && decode.server ? decode.user + '@' + decode.server : jid } return jid }

sock.getName = async (jid) => { jid = sock.decodeJid(jid) let v = store.contacts[jid] || {} if (jid.endsWith('@g.us')) { try { v = await sock.groupMetadata(jid) || {} } catch { v = await store.groupMetadata(jid) || {} } } try { return v.name || v.subject || PhoneNumber('+' + jid.replace('@s.whatsapp.net','')).getNumber('international') } catch { return jid } }

// Role checks function isOwner(jid) { if (!jid) return false const n = jidNormalize(jid) return (botConfig.owners || []).map(x => jidNormalize(x)).includes(n) }

async function isGroupAdmin(chatId, jid) { try { const meta = await sock.groupMetadata(chatId) const adminJids = (meta.participants || []) .filter(p => !!p.admin) .map(p => jidNormalize(p.id)) return adminJids.includes(jidNormalize(jid)) } catch { // fallback false return false } }

async function isBotAdmin(chatId) { try { const meta = await sock.groupMetadata(chatId) const botJ = jidNormalize(sock.user.id) const botPart = (meta.participants || []).find(p => jidNormalize(p.id) === botJ) || {} return Boolean(botPart.admin) } catch { return false } }

function mentionMeCheck(m) { try { const botJid = jidNormalize(sock.user?.id) const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [] if (mentioned.some(x => jidNormalize(x) === botJid)) return true const qsender = m.message?.extendedTextMessage?.contextInfo?.participant if (qsender && jidNormalize(qsender) === botJid) return true } catch (e) { /* ignore */ } return false }

sock.public = true sock.serializeM = (m) => m

/** ------------- COMMANDS ------------- */ const commands = { general: [], groupAdmin: [], owner: [] } function register(list, cmd) { cmd.triggers = cmd.triggers || [cmd.name]; list.push(cmd) }

register(commands.general, { name: 'help', triggers: ['help'], desc: 'Show this help menu', run: async ({ m, chatId, sender, role }) => { const p = botConfig.prefix || '!' const generalList = commands.general.map(c => c.triggers[0]).filter(Boolean) const adminList = commands.groupAdmin.map(c => c.triggers[0]).filter(Boolean) const ownerList = commands.owner.map(c => c.triggers[0]).filter(Boolean) let text = *${global.themeemoji} Kai Bot Help Menu*\nPrefix: \${p}`\n\ntext += '*👤 General (everyone)*\n' commands.general.forEach(cmd => text += • ${p}${cmd.triggers[0]} - ${cmd.desc || ''}\n) if (role === 'groupAdmin' || role === 'owner') { text += '\n*🛡️ Group Admin*\n' commands.groupAdmin.forEach(cmd => text +=  • ${p}${cmd.triggers[0]} - ${cmd.desc || ''}\n) } if (role === 'owner') { text += '\n*👑 Owner*\n' commands.owner.forEach(cmd => text +=  • ${p}${cmd.triggers[0]} - ${cmd.desc || ''}\n) } text += \n_Type commands with the prefix_ ${p}` await sock.sendMessage(chatId, { text }, { quoted: m }) } })

register(commands.general, { name: 'profile', triggers: ['profile', 'me'], desc: 'Show your (or mentioned) contact info', run: async ({ m, chatId, sender, mentions }) => { let target = (mentions && mentions[0]) ? mentions[0] : sender target = sock.decodeJid(target) const name = await sock.getName(target) await sock.sendMessage(chatId, { text: 👤 Profile\nName: ${name}\nJID: ${target} }, { quoted: m }) } })

register(commands.general, { name: 'ping', triggers: ['ping'], desc: 'Pong/ping', run: async ({ m, chatId }) => { await sock.sendMessage(chatId, { text: '🏓 Pong!' }, { quoted: m }) } })

register(commands.general, { name: 'uptime', triggers: ['uptime'], desc: 'Bot uptime', run: async ({ m, chatId, startTime }) => { const uptime = Date.now() - startTime const s = Math.floor(uptime/1000)%60 const mns = Math.floor(uptime/60000)%60 const hrs = Math.floor(uptime/3600000) await sock.sendMessage(chatId, { text: Uptime: ${hrs}h ${mns}m ${s}s }, { quoted: m }) } })

register(commands.general, { name: 'version', triggers: ['version'], desc: 'Bot version', run: async ({ m, chatId }) => { await sock.sendMessage(chatId, { text: Kai Bot v${botConfig.version} }, { quoted: m }) } })

register(commands.general, { name: 'kaion', triggers: ['kaion'], desc: 'Enable Kai replies for you in this group', run: async ({ m, chatId, sender, isGroup }) => { if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m }) kaiDB.groups[chatId] = kaiDB.groups[chatId] || { members: {} } kaiDB.groups[chatId].members = kaiDB.groups[chatId].members || {} kaiDB.groups[chatId].members[jidNormalize(sender)] = true writeJSON(KAI_FILE, kaiDB) await sock.sendMessage(chatId, { text: '✅ Kai ON for you in this group.' }, { quoted: m }) } })

register(commands.general, { name: 'kaioff', triggers: ['kaioff'], desc: 'Disable Kai replies for you in this group', run: async ({ m, chatId, sender, isGroup }) => { if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m }) kaiDB.groups[chatId] = kaiDB.groups[chatId] || { members: {} } kaiDB.groups[chatId].members = kaiDB.groups[chatId].members || {} kaiDB.groups[chatId].members[jidNormalize(sender)] = false writeJSON(KAI_FILE, kaiDB) await sock.sendMessage(chatId, { text: '⛔ Kai OFF for you in this group.' }, { quoted: m }) } })

register(commands.general, { name: 'kaistatus', triggers: ['kaistatus','kai','kstatus'], desc: 'Show whether Kai is ON/OFF for you in this group', run: async ({ m, chatId, sender, isGroup }) => { if (!isGroup) return await sock.sendMessage(chatId, { text: 'This command works in groups only.' }, { quoted: m }) const val = kaiDB.groups[chatId]?.members?.[jidNormalize(sender)] const state = (typeof val === 'undefined') ? 'ON (default)' : (val ? 'ON' : 'OFF') await sock.sendMessage(chatId, { text: Kai for you in this group: ${state} }, { quoted: m }) } })

// group admin register(commands.groupAdmin, { name: 'setrules', triggers: ['setrules'], desc: 'Set group rules: !setrules <text>', run: async ({ m, chatId, args }) => { const txt = args.join(' ') if (!txt) return await sock.sendMessage(chatId, { text: 'Usage: setrules <rules text>' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || { rules: '', warnThreshold: 2, automod: { badwords: true, antilink: false, antispam: true }, warns: {} } groupsDB[chatId].rules = txt writeJSON(GROUPS_FILE, groupsDB) await sock.sendMessage(chatId, { text: ✅ Rules set for this group. }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'rules', triggers: ['rules'], desc: 'Show group rules', run: async ({ m, chatId }) => { const rules = groupsDB[chatId]?.rules || 'No rules set.' await sock.sendMessage(chatId, { text: 📜 Rules:\n${rules} }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'warn', triggers: ['warn'], desc: 'Warn a user: !warn @user [reason]', run: async ({ m, chatId, args, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : (args[0] ? jidNormalize(args[0]) : null) if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !warn @user [reason]' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || { warnThreshold: 2, warns: {} } groupsDB[chatId].warns = groupsDB[chatId].warns || {} groupsDB[chatId].warns[target] = (groupsDB[chatId].warns[target] || 0) + 1 writeJSON(GROUPS_FILE, groupsDB) const count = groupsDB[chatId].warns[target] await sock.sendMessage(chatId, { text: ⚠️ <@${target.split('@')[0]}> warned. (${count}/${groupsDB[chatId].warnThreshold || 2}), mentions: [target] }, { quoted: m }) if (count >= (groupsDB[chatId].warnThreshold || 2)) { const botIsAdmin = await isBotAdmin(chatId) if (botIsAdmin) { try { await sock.groupRemove(chatId, [target]) await sock.sendMessage(chatId, { text: 🚫 <@${target.split('@')[0]}> was removed after reaching warn threshold., mentions: [target] }) safeLog('autokick', { chatId, target }) } catch (e) { await sock.sendMessage(chatId, { text: ⚠️ Couldn't remove <@${target.split('@')[0]}> — check bot admin status or permissions., mentions: [target] }) } } else { await sock.sendMessage(chatId, { text: ⚠️ <@${target.split('@')[0]}> reached warns but bot is not admin. Owner notified., mentions: [target] }) for (const o of (botConfig.owners || [])) { await sock.sendMessage(o, { text: ⚠️ User ${target} in group ${chatId} reached warn threshold but bot missing admin — manual action needed. }) } } groupsDB[chatId].warns[target] = 0 writeJSON(GROUPS_FILE, groupsDB) } } })

register(commands.groupAdmin, { name: 'warns', triggers: ['warns'], desc: 'Show warns for a user: !warns @user', run: async ({ m, chatId, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !warns @user' }, { quoted: m }) const count = (groupsDB[chatId]?.warns?.[target]) || 0 await sock.sendMessage(chatId, { text: ⚠️ <@${target.split('@')[0]}> has ${count} warns., mentions: [target] }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'setwarnsthreshold', triggers: ['setwarnsthreshold'], desc: 'Set warns needed for action: !setwarnsthreshold <n>', run: async ({ m, chatId, args }) => { const n = parseInt(args[0]) if (!n || n < 1) return await sock.sendMessage(chatId, { text: 'Usage: !setwarnsthreshold <n>' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || {} groupsDB[chatId].warnThreshold = n writeJSON(GROUPS_FILE, groupsDB) await sock.sendMessage(chatId, { text: ✅ Warn threshold set to ${n} }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'kick', triggers: ['kick'], desc: 'Kick a user: !kick @user (bot needs admin)', run: async ({ m, chatId, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !kick @user' }, { quoted: m }) const botIsAdmin = await isBotAdmin(chatId) if (!botIsAdmin) return await sock.sendMessage(chatId, { text: 'I need admin to kick. Owner has been notified.' }, { quoted: m }) try { await sock.groupRemove(chatId, [target]) await sock.sendMessage(chatId, { text: 🚫 <@${target.split('@')[0]}> kicked., mentions: [target] }) } catch (e) { await sock.sendMessage(chatId, { text: '⚠️ Kick failed.' }, { quoted: m }) } } })

register(commands.groupAdmin, { name: 'welcome', triggers: ['welcome'], desc: 'Toggle welcome messages: !welcome on/off', run: async ({ m, chatId, args }) => { const t = (args[0] || '').toLowerCase() if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !welcome on|off' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || {} groupsDB[chatId].welcome = (t === 'on') writeJSON(GROUPS_FILE, groupsDB) await sock.sendMessage(chatId, { text: ✅ Welcome messages ${t.toUpperCase()} }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'antilink', triggers: ['antilink'], desc: 'Toggle anti-link: !antilink on/off', run: async ({ m, chatId, args }) => { const t = (args[0] || '').toLowerCase() if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !antilink on|off' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || {} groupsDB[chatId].automod = groupsDB[chatId].automod || {} groupsDB[chatId].automod.antilink = (t === 'on') writeJSON(GROUPS_FILE, groupsDB) await sock.sendMessage(chatId, { text: ✅ Antilink ${t.toUpperCase()} }, { quoted: m }) } })

register(commands.groupAdmin, { name: 'antispam', triggers: ['antispam'], desc: 'Toggle anti-spam: !antispam on/off', run: async ({ m, chatId, args }) => { const t = (args[0] || '').toLowerCase() if (!['on','off'].includes(t)) return await sock.sendMessage(chatId, { text: 'Usage: !antispam on|off' }, { quoted: m }) groupsDB[chatId] = groupsDB[chatId] || {} groupsDB[chatId].automod = groupsDB[chatId].automod || {} groupsDB[chatId].automod.antispam = (t === 'on') writeJSON(GROUPS_FILE, groupsDB) await sock.sendMessage(chatId, { text: ✅ Antispam ${t.toUpperCase()} }, { quoted: m }) } })

// owner commands register(commands.owner, { name: 'forcekick', triggers: ['forcekick'], desc: 'Owner only: force kick user from group', run: async ({ m, chatId, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcekick @user' }, { quoted: m }) try { await sock.groupRemove(chatId, [target]) await sock.sendMessage(chatId, { text: ✅ <@${target.split('@')[0]}> removed by owner., mentions: [target] }) } catch (e) { await sock.sendMessage(chatId, { text: '⚠️ forcekick failed. Ensure bot is admin.' }, { quoted: m }) } } })

register(commands.owner, { name: 'forceadd', triggers: ['forceadd'], desc: 'Owner only: force add phone number to group (requires bot admin)', run: async ({ m, chatId, args }) => { const phone = args[0] if (!phone) return await sock.sendMessage(chatId, { text: 'Usage: !forceadd <number_without_plus>' }, { quoted: m }) const toJid = ${phone}@s.whatsapp.net try { await sock.groupAdd(chatId, [toJid]) await sock.sendMessage(chatId, { text: ✅ Added ${phone} }) } catch { await sock.sendMessage(chatId, { text: '⚠️ forceadd failed. Ensure bot/admin permissions.' }) } } })

register(commands.owner, { name: 'forcepromote', triggers: ['forcepromote'], desc: 'Owner only: promote user', run: async ({ m, chatId, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcepromote @user' }, { quoted: m }) try { await sock.groupParticipantsUpdate(chatId, [target], 'promote') await sock.sendMessage(chatId, { text: ✅ <@${target.split('@')[0]}> promoted., mentions: [target] }) } catch { await sock.sendMessage(chatId, { text: '⚠️ promote failed.' }, { quoted: m }) } } })

register(commands.owner, { name: 'forcedemote', triggers: ['forcedemote'], desc: 'Owner only: demote user', run: async ({ m, chatId, mentions }) => { const target = (mentions && mentions[0]) ? jidNormalize(mentions[0]) : null if (!target) return await sock.sendMessage(chatId, { text: 'Usage: !forcedemote @user' }, { quoted: m }) try { await sock.groupParticipantsUpdate(chatId, [target], 'demote') await sock.sendMessage(chatId, { text: ✅ <@${target.split('@')[0]}> demoted., mentions: [target] }) } catch { await sock.sendMessage(chatId, { text: '⚠️ demote failed.' }, { quoted: m }) } } })

register(commands.owner, { name: 'broadcast', triggers: ['broadcast'], desc: 'Owner only: broadcast to all groups', run: async ({ m, args }) => { const msg = args.join(' ') if (!msg) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !broadcast <text>' }, { quoted: m }) const all = await sock.groupFetchAllParticipating() for (const gid of Object.keys(all)) { try { const subject = all[gid].subject || 'this group' await sock.sendMessage(gid, { text: 📢 *Broadcast from Owner*\n\n${msg}\n\n— ${botConfig.owners[0]} }) } catch (e) { console.error('broadcast error for', gid, e?.message || e) } } await sock.sendMessage(OWNER_NUMBERS[0], { text: '📢 Broadcast finished.' }) } })

register(commands.owner, { name: 'shutdown', triggers: ['shutdown'], desc: 'Owner only: shutdown bot', run: async ({ m }) => { await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Shutting down (owner requested).' }) process.exit(0) } })

register(commands.owner, { name: 'setprefix', triggers: ['setprefix'], desc: 'Owner only: set command prefix: !setprefix <char>', run: async ({ m, args }) => { const p = args[0] if (!p) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !setprefix <prefix>' }, { quoted: m }) botConfig.prefix = p writeJSON(BOTCONFIG_FILE, botConfig) await sock.sendMessage(OWNER_NUMBERS[0], { text: Prefix changed to ${p} }) } })

register(commands.owner, { name: 'getgroups', triggers: ['getgroups'], desc: 'Owner only: list groups bot is in', run: async ({ m }) => { const all = await sock.groupFetchAllParticipating() const list = Object.keys(all).map(gid => ${gid} (${all[gid].subject || 'no-name'})).join('\n') || 'No groups' await sock.sendMessage(OWNER_NUMBERS[0], { text: Groups:\n${list} }) } })

register(commands.owner, { name: 'getgroupinfo', triggers: ['getgroupinfo'], desc: 'Owner only: get group metadata: !getgroupinfo <groupId>', run: async ({ m, args }) => { const gid = args[0] if (!gid) return await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Usage: !getgroupinfo <groupId>' }) try { const meta = await sock.groupMetadata(gid) await sock.sendMessage(OWNER_NUMBERS[0], { text: Group: ${meta.subject}\nID:${gid}\nMembers:${meta.participants.length} }) } catch { await sock.sendMessage(OWNER_NUMBERS[0], { text: 'Failed to fetch metadata.' }) } } })

/** ------------- AUTOMOD & BADWORDS ------------- */ const globalBadWords = ['badword1','badword2'] function containsBadWord(text, groupId) { const g = (groupsDB[groupId] && groupsDB[groupId].badWords) || [] const words = [...globalBadWords, ...g] const lower = String(text || '').toLowerCase() return words.some(w => w && lower.includes(w)) }

/** ------------- COMMAND LOOKUP ------------- */ function findCommand(trigger) { for (const cat of ['general','groupAdmin','owner']) { const list = commands[cat] const found = list.find(c => (c.triggers || []).includes(trigger)) if (found) return { cmd: found, category: cat } } return null }

/** ------------- MESSAGE HANDLER ------------- */ const startTime = Date.now() sock.ev.on('messages.upsert', async ({ messages }) => { const m = messages[0] try { if (!m.message) return if (m.key && m.key.remoteJid === 'status@broadcast') return

// chat & sender detection (robust)
  const rawChatId = m.key.remoteJid
  const chatId = sock.decodeJid(rawChatId)
  const isGroup = chatId && chatId.endsWith('@g.us')

  // sender: prefer participant (group), otherwise remoteJid (private). For fromMe fallback to sock.user.id
  let participant = m.key.participant || m.key.remoteJid
  if (m.key.fromMe) participant = sock.user && sock.user.id
  const senderJid = sock.decodeJid(participant)
  const sender = jidNormalize(senderJid)

  // extract text
  let text = getTextFromMessage(m.message).trim()

  // prefix handling
  const prefix = botConfig.prefix || '!'
  const isCmd = text.startsWith(prefix)
  const bodyNoPrefix = isCmd ? text.slice(prefix.length).trim() : text
  const parts = bodyNoPrefix.split(/\s+/).filter(Boolean)
  const cmdName = parts[0] ? parts[0].toLowerCase() : ''
  const args = parts.slice(1)
  const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || []

  // determine role
  let role = 'member'
  if (isOwner(sender)) role = 'owner'
  else if (isGroup && await isGroupAdmin(chatId, sender)) role = 'groupAdmin'

  // Check global ban
  if (botConfig.globalBans && botConfig.globalBans.includes(sender)) return

  // If message is bare 'help' (no prefix), show help
  if (!isCmd && text.toLowerCase() === 'help') {
    const { cmd } = findCommand('help') || {}
    if (cmd) await cmd.run({ m, chatId, sender: senderJid, isGroup, role, startTime })
    return
  }

  // If it's a command: find and execute
  if (isCmd) {
    const fc = findCommand(cmdName)
    if (!fc) {
      await sock.sendMessage(chatId, { text: `Unknown command. Try ${prefix}help` }, { quoted: m })
      return
    }

    const { cmd, category } = fc

    // permission checks
    if (category === 'owner' && role !== 'owner') return await sock.sendMessage(chatId, { text: '🚫 Owner only command.' }, { quoted: m })
    if (category === 'groupAdmin' && !(role === 'groupAdmin' || role === 'owner')) return await sock.sendMessage(chatId, { text: '🚫 Admin only command.' }, { quoted: m })

    // run command
    try {
      await cmd.run({ m, chatId, sender: senderJid, args, mentions, isGroup, startTime, role })
    } catch (e) {
      console.error('Command run error', e)
      await sock.sendMessage(chatId, { text: '⚠️ Command error.' }, { quoted: m })
    }
    return
  }

  /** ---------- NON-COMMAND: Moderation + Kai reply ---------- */

  // Automod: bad words
  if (isGroup && containsBadWord(text, chatId) && groupsDB[chatId]?.automod?.badwords !== false) {
    groupsDB[chatId] = groupsDB[chatId] || { warnThreshold: 2, warns: {} }
    groupsDB[chatId].warns = groupsDB[chatId].warns || {}
    groupsDB[chatId].warns[sender] = (groupsDB[chatId].warns[sender] || 0) + 1
    writeJSON(GROUPS_FILE, groupsDB)
    const count = groupsDB[chatId].warns[sender]
    await sock.sendMessage(chatId, { text: `⚠️ <@${sender.split('@')[0]}> watch your language. Warning (${count}/${groupsDB[chatId].warnThreshold || 2})`, mentions: [sender] })
    safeLog('automod_badword', { chatId, sender, text })
    if (count >= (groupsDB[chatId].warnThreshold || 2)) {
      const botIsAdmin = await isBotAdmin(chatId)
      if (botIsAdmin) {
        try {
          await sock.groupRemove(chatId, [sender])
          await sock.sendMessage(chatId, { text: `🚫 <@${sender.split('@')[0]}> was removed after reaching warns (auto).`, mentions: [sender] })
        } catch (e) {
          await sock.sendMessage(chatId, { text: '⚠️ Auto-remove failed.' })
        }
      } else {
        for (const o of (botConfig.owners || [])) await sock.sendMessage(o, { text: `⚠️ User ${sender} in ${chatId} reached warn threshold (auto) but bot is not admin.` })
      }
      groupsDB[chatId].warns[sender] = 0
      writeJSON(GROUPS_FILE, groupsDB)
    }
    return
  }

  // Antilink
  if (isGroup && groupsDB[chatId]?.automod?.antilink && /https?:\/\/\S+/i.test(text)) {
    await sock.sendMessage(chatId, { text: `🔗 Links are not allowed in this group.` }, { quoted: m })
    safeLog('antilink', { chatId, sender, text })
    return
  }

  // Antispam (very naive)
  if (isGroup && groupsDB[chatId]?.automod?.antispam) {
    store._last = store._last || {}
    const key = `${chatId}:${sender}`
    const last = store._last[key]
    if (last && last.text === text && (Date.now() - last.t) < 5000) {
      groupsDB[chatId] = groupsDB[chatId] || { warns: {}, warnThreshold: 2 }
      groupsDB[chatId].warns = groupsDB[chatId].warns || {}
      groupsDB[chatId].warns[sender] = (groupsDB[chatId].warns[sender] || 0) + 1
      writeJSON(GROUPS_FILE, groupsDB)
      await sock.sendMessage(chatId, { text: `⚠️ <@${sender.split('@')[0]}> please stop spamming.`, mentions: [sender] })
      safeLog('antispam_warn', { chatId, sender, text })
      store._last[key] = { text, t: Date.now() }
      return
    }
    store._last[key] = { text, t: Date.now() }
  }

  // KI (Kai) reply: group mode & per-person Kai ON/OFF
  let respondInGroup = true
  const mode = groupsDB[chatId]?.respondMode || 'mention'
  if (isGroup) {
    if (mode === 'mention') respondInGroup = mentionMeCheck(m)
    else respondInGroup = true
  }

  const isKaiOnForUser = (() => {
    if (!isGroup) return true
    const g = kaiDB.groups[chatId]
    if (!g || !g.members) return true
    const v = g.members[sender]
    if (typeof v === 'undefined') return true
    return Boolean(v)
  })()

  if (isGroup && !isKaiOnForUser) return

  if (!isGroup || (isGroup && respondInGroup)) {
    if (text) {
      try {
        // IMPORTANT: send the actual user JID (senderJid), not the group id
        const apiUrl = `https://kai-api-z744.onrender.com?prompt=${encodeURIComponent(text)}&personid=${encodeURIComponent(senderJid)}${isGroup ? `&groupid=${encodeURIComponent(chatId)}` : ''}`
        const res = await axios.get(apiUrl)
        const reply = res.data?.reply || "⚠️ No reply from Kai API"
        await sock.sendMessage(chatId, { text: reply }, { quoted: m })
        safeLog('kai_reply', { chatId, sender: sender, text })
      } catch (err) {
        console.error('Kai API error', err?.message || err)
        await sock.sendMessage(chatId, { text: "⚠️ Error fetching reply from Kai API." }, { quoted: m })
      }
    }
  }

} catch (err) {
  console.error('messages.upsert error', err)
}

}) // end messages.upsert

/** ------------- GROUP PARTICIPANTS (welcome/goodbye & owner notify when bot added) ------------- */ sock.ev.on('group-participants.update', async (update) => { try { const { id: chatIdRaw, participants, action } = update const chatId = sock.decodeJid(chatIdRaw) const meta = await (async () => { try { return await sock.groupMetadata(chatId) } catch { return {} } })() const subject = meta.subject || 'this group'

for (const p of participants) {
    const userJid = sock.decodeJid(p)
    const simple = userJid.split('@')[0]

    // bot added? compare normalized
    if (jidNormalize(userJid) === jidNormalize(sock.user.id)) {
      // bot added
      try {
        const admins = (meta.participants || []).filter(x => !!x.admin).map(x => x.id)
        const msg = `🤖 *Bot added to group*\nName: ${subject}\nID: ${chatId}\nMembers: ${meta.participants?.length || 0}\nAdmins: ${admins.join(', ')}`
        for (const o of (botConfig.owners || [])) await sock.sendMessage(o, { text: msg })
        safeLog('bot_added', { chatId, subject, by: update.by })
      } catch (e) {
        for (const o of (botConfig.owners || [])) await sock.sendMessage(o, { text: `🤖 Bot added to ${chatId}` })
        safeLog('bot_added_fallback', { chatId })
      }
      continue
    }

    if (action === 'add') {
      if (groupsDB[chatId]?.welcome !== false) {
        const rules = groupsDB[chatId]?.rules || 'No rules set. Ask an admin to set them with !setrules.'
        const name = await sock.getName(userJid)
        const welcome = `👋 Welcome *${name}*!\nYou joined *${subject}*.\n\n${rules}\n\nSay hi and type *!help* to see what I can do.`
        await sock.sendMessage(chatId, { text: welcome, mentions: [userJid] })
      }
    }
    if (action === 'remove') {
      if (groupsDB[chatId]?.welcome !== false) {
        const name = await sock.getName(userJid)
        const goodbye = `👋 *${name}* left *${subject}*. We'll miss you!`
        await sock.sendMessage(chatId, { text: goodbye, mentions: [userJid] })
      }
    }
  }
} catch (e) {
  console.error('group-participants.update error', e)
}

})

console.log(chalk.blue('Kai Bot loaded and running (fixed).')) return sock }

startBot().catch(err => console.error('Start bot error', err))

