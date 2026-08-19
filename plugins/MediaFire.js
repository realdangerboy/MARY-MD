// plugins/mediafire.js

import axios from 'axios'
import { T } from '../lib/i18n.js'

const API_URL = 'https://luxinfinity.vercel.app/api/mediafire'

const MEDIAFIRE_LINK_REGEX = /https?:\/\/(www\.)?mediafire\.com\/\S+/i

function extractLink(text) {
  const match = text?.match(MEDIAFIRE_LINK_REGEX)
  return match ? match[0] : null
}

async function fetchMediaFire(url) {
  const { data } = await axios.get(API_URL, {
    params: { url },
    timeout: 30000
  })
  return data
}

const handler = async (m, { conn, text }) => {
  let link = extractLink(text)

  if (!link && m.quoted) {
    const quotedText = m.quoted.text || m.quoted.body || m.quoted.caption || ''
    link = extractLink(quotedText)
  }

  if (!link) {
    return m.reply(T().mediafireUsage)
  }

  const sent = await conn.sendMessage(
    m.chat,
    { text: T().mediafireFetching },
    { quoted: m }
  )

  try {
    const res = await fetchMediaFire(link)

    if (!res?.status || !res.data?.download) {
      return conn.sendMessage(
        m.chat,
        { text: T().mediafireNotFound, edit: sent.key }
      )
    }

    const file = res.data

    await conn.sendMessage(
      m.chat,
      {
        document: { url: file.download },
        fileName: file.name || 'mediafire-file',
        caption: `✅ *${file.name}*\n📦 ${file.size || ''}`
      },
      { quoted: m }
    )

    await conn.sendMessage(m.chat, { delete: sent.key }).catch(() => {})
  } catch (error) {
    console.error('[MEDIAFIRE ERROR]', error.message)
    await conn.sendMessage(
      m.chat,
      { text: T().dlFailed, edit: sent.key }
    )
  }
}

handler.help    = ['mediafire']
handler.tags    = ['downloader']
handler.command = ['mediafire', 'mf']

export default handler
