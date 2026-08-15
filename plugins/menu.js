import * as baileysMod from '@whiskeysockets/baileys'
import config from '../config.js'
import { plugins } from '../handler.js'
import { msg } from '../lib/lang.js'

const pkg = baileysMod.default && Object.keys(baileysMod).length === 1 ? baileysMod.default : baileysMod
const { prepareWAMessageMedia, generateWAMessageFromContent } = pkg

const START = Date.now()
const IMAGES = [
  'https://i.ibb.co/gMnzK6Wv/file-00000000973481f5a9c7de038183683a.png',
    
  'https://i.ibb.co/SwJnYBhf/file-000000003d0c8243a631551a98624d8b.png',
  
  'https://i.ibb.co/rfG7rgrX/file-0000000027e481f7b7c6dcd114b8700a.png',
]

const LABELS = () => ({
  info:       msg({ en: 'ℹ️  Information',     es: 'ℹ️  Información' }),
  group:      msg({ en: '👥 Group Mgmt',        es: '👥 Grupos' }),
  tools:      msg({ en: '🔧 Tools',             es: '🔧 Herramientas' }),
  downloads:  msg({ en: '📥 Downloads',         es: '📥 Descargas' }),
  converters: msg({ en: '🔄 Converters',        es: '🔄 Convertidores' }),
  games:      msg({ en: '🎮 Games',             es: '🎮 Juegos' }),
  admin:      msg({ en: '⚙️  Admin',            es: '⚙️  Admin' }),
  settings:   msg({ en: '⚙️  Settings',         es: '⚙️  Ajustes' }),
  other:      msg({ en: '📦 Other',             es: '📦 Otros' }),
})

const getUptime = () => {
  const t = Math.floor((Date.now() - START) / 1000)
  const d = Math.floor(t / 86400), h = Math.floor((t / 3600) % 24)
  const min = Math.floor((t / 60) % 60), s = t % 60
  return `${d > 0 ? d + 'd ' : ''}${h > 0 ? h + 'h ' : ''}${min > 0 ? min + 'm ' : ''}${s}s`
}

const ctxInfo = (conn, m) => ({
  mentionedJid: [m.sender], forwardingScore: 999, isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: '120363433987489893@newsletter',
    newsletterName: `${conn.botname || config.botName}`,
    serverMessageId: Math.floor(Math.random() * 999) + 1,
  }
})

function getCategories(isOwner, groupDb) {
  const cats = {}; let total = 0
  for (const p of Object.values(plugins)) {
    if (!p?.help) continue
    if ((p.owner || p.ownerOnly) && !isOwner) continue
    const tag = (Array.isArray(p.tags) ? p.tags[0] : (p.tags || 'settings')).toLowerCase()
    if (groupDb?.disabledCategories?.includes(tag)) continue
    if (!cats[tag]) cats[tag] = []
    const cmds = Array.isArray(p.help) ? p.help : [p.help]
    // Only show one entry per unique root command — prevents sub-commands flooding the menu
    const seen = new Set()
    for (const c of cmds) {
      const root = c.split(/\s+/)[0]  // e.g. 'antilink' from 'antilink <on/off>'
      if (seen.has(root)) continue
      seen.add(root)
      cats[tag].push(root)
      total++
    }
  }
  return { cats, total }
}

function getOrdered(cats) {
  const ORDER = ['info', 'group', 'downloads', 'converters', 'games', 'tools', 'admin', 'settings']
  return ORDER.filter(k => cats[k]?.length).concat(Object.keys(cats).filter(k => !ORDER.includes(k)))
}

async function sendSubMenu(conn, m, tag, isOwner, prefix, groupDb) {
  const { cats } = getCategories(isOwner, groupDb)
  const cmds = cats[tag]
  if (!cmds?.length) return m.reply(msg({ en: `*『 ❌ 』No active commands in this category.*`, es: `*『 ❌ 』Sin comandos activos en esta categoría.*` }))
  const labels  = LABELS()
  const catName = labels[tag] || labels.other || tag
  const imgUrl  = IMAGES[Math.floor(Math.random() * IMAGES.length)]
  const media   = await prepareWAMessageMedia({ image: { url: imgUrl } }, { upload: conn.waUploadToServer })
  let caption   = `┌─────────────────\n└┐  *${catName.toUpperCase()}*\n┌┤\n`
  for (const c of cmds) caption += `││  ${prefix}${c}\n`
  caption += `│└──⊷\n└─────────────────`
  const out = generateWAMessageFromContent(m.chat, { viewOnceMessage: { message: {
    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
    interactiveMessage: {
      body: { text: caption },
      footer: { text: `© ${new Date().getFullYear()} ${conn.botname || config.botName}` },
      header: { hasMediaAttachment: true, imageMessage: media.imageMessage },
      nativeFlowMessage: { buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: msg({ en: '🔙 Back to Menu', es: '🔙 Volver al Menú' }), id: `${prefix}menu` }) },
        { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: msg({ en: '📢 Channel', es: '📢 Canal' }), url: config.groupLink, merchant_url: config.groupLink }) }
      ]},
      contextInfo: ctxInfo(conn, m)
    }
  }}}, { quoted: m })
  await conn.relayMessage(m.chat, out.message, { messageId: out.key.id })
}

const handler = async (m, { conn, usedPrefix, isOwner, command, groupDb }) => {
  const { cats, total } = getCategories(isOwner, groupDb)
  const ordered = getOrdered(cats)
  const numMatch = command.match(/^menu(\d+)$/)
  if (numMatch) {
    const tag = ordered[parseInt(numMatch[1]) - 1]
    return tag ? sendSubMenu(conn, m, tag, isOwner, usedPrefix || '.', groupDb)
               : m.reply(msg({ en: `*『 ❌ 』Category not found.*`, es: `*『 ❌ 』Categoría no encontrada.*` }))
  }
  const labels   = LABELS()
  const userName = m.pushName || msg({ en: 'User', es: 'Usuario' })
  const prefix   = usedPrefix || '.'
  const botName  = conn.botname || config.botName
  const rows = ordered.map((tag, i) => ({
    header: (labels[tag] || labels.other || tag).toUpperCase(),
    title:  msg({ en: 'View commands', es: 'Ver comandos' }),
    description: `${cats[tag]?.length || 0} ${msg({ en: 'cmds · Type', es: 'cmds · Escribe' })} ${prefix}menu${i + 1}`,
    id: `menu_cat_${tag}`
  }))
  const text = msg({
    en: `*┏━━•❈ 🤖 ${botName} ❈•━━┓*\n\n> 👋 *Hello, ${userName}*\n\n*『 📊 STATISTICS 』*\n▢ 👑 *Owner:* ${config.ownerName}\n▢ ⚙️ *Prefix:* [ *${prefix}* ]\n▢ ⏱️ *Uptime:* ${getUptime()}\n▢ 📦 *Commands:* ${total}\n\n> Tap the button to see commands.\n*┗━━━━•❅•°•❈•°•❅•━━━━┛*`,
    es: `*┏━━•❈ 🤖 ${botName} ❈•━━┓*\n\n> 👋 *Hola, ${userName}*\n\n*『 📊 ESTADÍSTICAS 』*\n▢ 👑 *Dueño:* ${config.ownerName}\n▢ ⚙️ *Prefijo:* [ *${prefix}* ]\n▢ ⏱️ *Activo:* ${getUptime()}\n▢ 📦 *Comandos:* ${total}\n\n> Tocá el botón para ver comandos.\n*┗━━━━•❅•°•❈•°•❅•━━━━┛*`
  })
  const imgUrl = IMAGES[Math.floor(Math.random() * IMAGES.length)]
  const media  = await prepareWAMessageMedia({ image: { url: imgUrl } }, { upload: conn.waUploadToServer })
  const out = generateWAMessageFromContent(m.chat, { viewOnceMessage: { message: {
    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
    interactiveMessage: {
      body: { text }, footer: { text: `© ${new Date().getFullYear()} ${botName}` },
      header: { hasMediaAttachment: true, imageMessage: media.imageMessage },
      nativeFlowMessage: { buttons: [
        { name: 'single_select', buttonParamsJson: JSON.stringify({
          title: msg({ en: '📁 SELECT MENU', es: '📁 SELECCIONAR MENÚ' }),
          sections: [{ title: msg({ en: '🌟 CATEGORIES', es: '🌟 CATEGORÍAS' }), rows }]
        })},
        { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: msg({ en: '📢 Channel', es: '📢 Canal' }), url: config.groupLink, merchant_url: config.groupLink }) }
      ]},
      contextInfo: ctxInfo(conn, m)
    }
  }}}, { quoted: m })
  await conn.relayMessage(m.chat, out.message, { messageId: out.key.id })
}

handler.all = async (m, { conn, isOwner, usedPrefix, groupDb }) => {
  if (!m.responseId?.startsWith('menu_cat_')) return
  const tag = m.responseId.replace('menu_cat_', '')
  await sendSubMenu(conn, m, tag, isOwner, usedPrefix || '.', groupDb)
}

handler.help = ['menu']
handler.tags = ['info']
handler.command = ['menu', 'help', 'ayuda', 'menú', ...Array.from({ length: 20 }, (_, i) => `menu${i + 1}`)]
export default handler
