import { msg } from '../lib/lang.js'
import BotDb from '../lib/database/BotDb.js'
import NodeCache from 'node-cache'
import * as pkg from '@whiskeysockets/baileys'

const { downloadContentFromMessage } = pkg

// ─── Message cache (5 min TTL) ────────────────────────────────────────────────
const msgCache = new NodeCache({ stdTTL: 300, checkperiod: 60 })

// ─── Helpers ──────────────────────────────────────────────────────────────────
const extractNum  = jid => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const MEDIA_TYPES = ['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage','pttMessage']

const getSettings = () => ({
  enabled:  BotDb.get('antidelete_enabled') ?? false,
  sendTo:   BotDb.get('antidelete_sendTo')  || 'chat',   // chat | private
})

// ─── Download media buffer ────────────────────────────────────────────────────
const downloadBuffer = async (msg, mtype) => {
  try {
    const stream = await downloadContentFromMessage(msg, mtype.replace('Message',''))
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
  } catch { return null }
}

// ─── Command handler ──────────────────────────────────────────────────────────
const handler = async (m, { conn, args, usedPrefix, command }) => {
  const sub = args[0]?.toLowerCase()
  const val = args[1]?.toLowerCase()
  const s   = getSettings()

  if (!sub) return m.reply(buildStatus(s, usedPrefix, command))

  if (['on','off'].includes(sub)) {
    BotDb.set('antidelete_enabled', sub === 'on')
    return m.reply(msg({
      en: `*『 🗑️ 』ANTIDELETE ${sub.toUpperCase()}.*`,
      es: `*『 🗑️ 』ANTIDELETE ${sub === 'on' ? 'ACTIVADO' : 'DESACTIVADO'}.*`
    }))
  }

  if (sub === 'set') {
    if (!['private','chat'].includes(val)) return m.reply(msg({
      en: `*『 ✙ 』USAGE.*\n> ${usedPrefix}${command} set private\n> ${usedPrefix}${command} set chat`,
      es: `*『 ✙ 』USO.*\n> ${usedPrefix}${command} set private\n> ${usedPrefix}${command} set chat`
    }))
    BotDb.set('antidelete_sendTo', val)
    const desc = val === 'private'
      ? msg({ en: `Deleted messages sent to your DM.`, es: `Mensajes eliminados enviados a tu DM.` })
      : msg({ en: `Deleted messages sent back to the same chat.`, es: `Mensajes eliminados enviados al mismo chat.` })
    return m.reply(msg({
      en: `*『 🗑️ 』ANTIDELETE SET: ${val.toUpperCase()}.*\n> ${desc}`,
      es: `*『 🗑️ 』ANTIDELETE: ${val.toUpperCase()}.*\n> ${desc}`
    }))
  }

  if (sub === 'status') return m.reply(buildStatus(s, usedPrefix, command))

  if (sub === 'reset') {
    BotDb.set('antidelete_enabled', false)
    BotDb.set('antidelete_sendTo', 'chat')
    return m.reply(msg({
      en: `*『 🔄 』ANTIDELETE RESET.*\n> Disabled, send mode back to chat.`,
      es: `*『 🔄 』ANTIDELETE REINICIADO.*`
    }))
  }

  return m.reply(buildStatus(s, usedPrefix, command))
}

function buildStatus(s, usedPrefix, command) {
  return msg({
    en: `*『 🗑️ 』ANTIDELETE*\n\n> Status: ${s.enabled ? '✅ ON' : '❌ OFF'}\n> Send to: *${s.sendTo === 'private' ? 'Owner DM (private)' : 'Same chat'}*\n\n> *Usage:*\n> ${usedPrefix}${command} on/off\n> ${usedPrefix}${command} set private\n> ${usedPrefix}${command} set chat\n> ${usedPrefix}${command} status\n> ${usedPrefix}${command} reset`,
    es: `*『 🗑️ 』ANTIDELETE*\n\n> Estado: ${s.enabled ? '✅ ON' : '❌ OFF'}\n> Enviar a: *${s.sendTo === 'private' ? 'DM del owner (privado)' : 'Mismo chat'}*\n\n> *Uso:*\n> ${usedPrefix}${command} on/off\n> ${usedPrefix}${command} set private\n> ${usedPrefix}${command} set chat\n> ${usedPrefix}${command} status\n> ${usedPrefix}${command} reset`
  })
}

// ─── Store incoming messages + download media immediately ─────────────────────
handler.before = async (m) => {
  if (!m?.key?.id || m.fromMe) return false
  try {
    const mtype   = m.mtype || ''
    const msgObj  = m.message?.[mtype]
    let mediaBuffer = null

    // Download media immediately so URL doesn't expire
    if (MEDIA_TYPES.includes(mtype) && msgObj) {
      mediaBuffer = await downloadBuffer(msgObj, mtype).catch(() => null)
    }

    msgCache.set(m.key.id, {
      key:         m.key,
      message:     m.message,
      sender:      m.sender || m.key?.participant || m.key?.remoteJid,
      chat:        m.chat,
      pushName:    m.pushName || '',
      mtype,
      msgObj,
      mediaBuffer,
      text:        m.body || m.text || msgObj?.caption || '',
    })
  } catch {}
  return false
}

// ─── onDelete — triggered by mary.js messages.update ─────────────────────────
handler.onDelete = async (conn, update) => {
  const s = getSettings()
  if (!s.enabled) return

  const key    = update.key
  const chatId = key?.remoteJid
  if (!chatId) return

  const cached = msgCache.get(key.id)
  if (!cached) return

  // Target: same chat or owner DM
  let targetJid = chatId
  if (s.sendTo === 'private') {
    const ownerRaw = BotDb.getOwner() || conn.user?.id
    targetJid = ownerRaw?.includes('@') ? ownerRaw.split(':')[0] + '@s.whatsapp.net' : ownerRaw + '@s.whatsapp.net'
  }

  const senderNum  = extractNum(cached.sender || '')
  const senderName = cached.pushName || senderNum
  const isGroup    = chatId.endsWith('@g.us')

  const headerText = msg({
    en: `*🗑️ Deleted by ${senderName}*\n> In: ${isGroup ? 'Group' : 'DM'}`,
    es: `*🗑️ Eliminado por ${senderName}*\n> En: ${isGroup ? 'Grupo' : 'DM'}`
  })

  const mentions = cached.sender ? [cached.sender] : []

  try {
    const mtype = cached.mtype || ''

    // Text — header + text in one message
    if (mtype === 'conversation' || mtype === 'extendedTextMessage') {
      const text = cached.text
      await conn.sendMessage(targetJid, {
        text: `${headerText}${text ? `\n\n${text}` : ''}`,
        mentions
      })

    // Image — image with header as caption
    } else if (mtype === 'imageMessage' && cached.mediaBuffer) {
      await conn.sendMessage(targetJid, {
        image: cached.mediaBuffer,
        caption: `${headerText}${cached.text ? `\n\n${cached.text}` : ''}`,
        mentions
      })

    // Video — video with header as caption
    } else if (mtype === 'videoMessage' && cached.mediaBuffer) {
      await conn.sendMessage(targetJid, {
        video: cached.mediaBuffer,
        caption: `${headerText}${cached.text ? `\n\n${cached.text}` : ''}`,
        mentions
      })

    // Audio / Voice note — header then audio quoted to it
    } else if ((mtype === 'audioMessage' || mtype === 'pttMessage') && cached.mediaBuffer) {
      const isPtt = cached.msgObj?.ptt === true || mtype === 'pttMessage'
      const sentH1 = await conn.sendMessage(targetJid, { text: headerText, mentions })
      await conn.sendMessage(targetJid, { audio: cached.mediaBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: isPtt }, { quoted: sentH1 })

    // Sticker — header then sticker quoted to it
    } else if (mtype === 'stickerMessage' && cached.mediaBuffer) {
      const sentH2 = await conn.sendMessage(targetJid, { text: headerText, mentions })
      await conn.sendMessage(targetJid, { sticker: cached.mediaBuffer }, { quoted: sentH2 })

    // Document — document with header as caption
    } else if (mtype === 'documentMessage' && cached.mediaBuffer) {
      await conn.sendMessage(targetJid, {
        document: cached.mediaBuffer,
        mimetype: cached.msgObj?.mimetype || 'application/octet-stream',
        fileName: cached.msgObj?.fileName || 'file',
        caption: headerText,
        mentions
      })

    // Contact — header then contact quoted to it
    } else if (mtype === 'contactMessage') {
      const sentH3 = await conn.sendMessage(targetJid, { text: headerText, mentions })
      await conn.sendMessage(targetJid, { contacts: { displayName: cached.msgObj?.displayName, contacts: [cached.msgObj] } }, { quoted: sentH3 })

    // Location — header then location quoted to it
    } else if (mtype === 'locationMessage') {
      const sentH4 = await conn.sendMessage(targetJid, { text: headerText, mentions })
      await conn.sendMessage(targetJid, {
        location: { degreesLatitude: cached.msgObj?.degreesLatitude, degreesLongitude: cached.msgObj?.degreesLongitude }
      }, { quoted: sentH4 })

    // Text fallback
    } else if (cached.text) {
      await conn.sendMessage(targetJid, { text: `${headerText}\n\n${cached.text}`, mentions })

    // Media expired
    } else {
      await conn.sendMessage(targetJid, {
        text: `${headerText}\n\n${msg({ en: `_(Media expired — could not recover)_`, es: `_(Media expirada — no se pudo recuperar)_` })}`,
        mentions
      })
    }

  } catch (e) {
    console.error('[ANTIDELETE]', e.message)
  }
}

handler.help = ['antidelete <on/off>', 'antidelete set <private/chat>', 'antidelete status', 'antidelete reset']
handler.tags = ['settings']
handler.command = ['antidelete']
handler.ownerOnly = true
handler.alwaysBefore = true
export default handler
