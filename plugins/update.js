// plugins/update.js

import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import axios from 'axios'

const execAsync = promisify(exec)

const REPO = 'https://github.com/realdangerboy/MARY-MD.git'
const BRANCH = 'main'
const RAW = 'https://raw.githubusercontent.com/realdangerboy/MARY-MD/main'

async function getLocalVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile('./package.json', 'utf8'))
    return pkg.version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

async function getRemotePackage() {
  const { data } = await axios.get(`${RAW}/package.json`, {
    timeout: 15000,
    headers: { 'User-Agent': 'MARY-MD-Updater' }
  })
  return data
}

function compareVersions(remote, local) {
  const r = String(remote).split('.').map(Number)
  const l = String(local).split('.').map(Number)

  for (let i = 0; i < 3; i++) {
    const rv = r[i] || 0
    const lv = l[i] || 0

    if (rv > lv) return 1
    if (rv < lv) return -1
  }

  return 0
}

async function getGitCommits() {
  try {
    await execAsync('git fetch origin main --quiet', {
      timeout: 60000
    })

    const { stdout } = await execAsync(
      'git log HEAD..origin/main --pretty=format:%s',
      { timeout: 30000 }
    )

    return stdout
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function isGitRepo() {
  try {
    await execAsync('git rev-parse --is-inside-work-tree')
    return true
  } catch {
    return false
  }
}

async function updateBot() {
  /*
   * IMPORTANT:
   * sessions/ is NEVER deleted or modified here.
   *
   * The updater only performs git pull.
   * Existing WhatsApp authentication remains untouched.
   */

  await execAsync('git fetch origin main', {
    timeout: 120000
  })

  await execAsync('git pull --ff-only origin main', {
    timeout: 180000
  })
}

const handler = async (m, { conn, command }) => {
  const cmd = String(command || '').toLowerCase()

  // ─────────────────────────────────────────────
  // CHECK UPDATE
  // ─────────────────────────────────────────────
  if (cmd === 'checkupdate') {
    const sent = await conn.sendMessage(
      m.chat,
      {
        text: '🔎 Checking for MARY MD updates...'
      },
      { quoted: m }
    )

    try {
      if (!(await isGitRepo())) {
        return await conn.sendMessage(
          m.chat,
          {
            text: '❌ This bot is not running from a Git repository.',
            edit: sent.key
          }
        )
      }

      const localVersion = await getLocalVersion()
      const remotePackage = await getRemotePackage()
      const remoteVersion = remotePackage.version || localVersion

      const commits = await getGitCommits()
      const versionStatus = compareVersions(remoteVersion, localVersion)

      if (versionStatus <= 0 && commits.length === 0) {
        return await conn.sendMessage(
          m.chat,
          {
            text:
`╭━━━〔 MARY MD UPDATE 〕━━━
┃
┃ ✅ *Bot is up to date*
┃
┃ 📦 Version: *${localVersion}*
┃
╰━━━━━━━━━━━━━━━━━━━━`
            ,
            edit: sent.key
          }
        )
      }

      let text =
`╭━━━〔 🆕 UPDATE AVAILABLE 〕━━━
┃
┃ 📦 Current: *${localVersion}*
┃ 📦 Latest: *${remoteVersion}*
┃
┃ 📝 *CHANGELOG*
┃`

      if (commits.length) {
        commits.slice(0, 15).forEach((commit, i) => {
          text += `┃ ${i + 1}. ${commit}\n`
        })
      } else {
        text += `┃ • New MARY MD release available\n`
      }

      text +=
`┃
┃ Use *update* to install it.
┃
╰━━━━━━━━━━━━━━━━━━━━`

      return await conn.sendMessage(
        m.chat,
        { text, edit: sent.key }
      )

    } catch (error) {
      console.error('[UPDATE CHECK ERROR]', error)

      return await conn.sendMessage(
        m.chat,
        {
          text:
`❌ *Update check failed.*

${error.message || 'Unable to contact GitHub.'}`,
          edit: sent.key
        }
      )
    }
  }

  // ─────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────
  if (cmd === 'update') {
    const sent = await conn.sendMessage(
      m.chat,
      {
        text: '⏳ Updating MARY MD...'
      },
      { quoted: m }
    )

    try {
      if (!(await isGitRepo())) {
        return await conn.sendMessage(
          m.chat,
          {
            text:
              '❌ This bot is not running from a Git repository.',
            edit: sent.key
          }
        )
      }

      const localVersion = await getLocalVersion()
      const remotePackage = await getRemotePackage()
      const remoteVersion = remotePackage.version || localVersion

      const commits = await getGitCommits()

      if (
        compareVersions(remoteVersion, localVersion) <= 0 &&
        commits.length === 0
      ) {
        return await conn.sendMessage(
          m.chat,
          {
            text:
`✅ *MARY MD is already up to date.*

📦 Version: *${localVersion}*`,
            edit: sent.key
          }
        )
      }

      await conn.sendMessage(
        m.chat,
        {
          text:
`⏳ *Installing update...*

📦 ${localVersion} → ${remoteVersion}

🔐 WhatsApp session will NOT be touched.`,
          edit: sent.key
        }
      )

      // Update repository.
      // sessions/ is intentionally never deleted.
      await updateBot()

      await conn.sendMessage(
        m.chat,
        {
          text:
`╭━━━〔 ✅ UPDATE COMPLETE 〕━━━
┃
┃ 📦 Version: *${remoteVersion}*
┃
┃ 🔐 Session preserved
┃
┃ 🔄 Restarting bot...
╰━━━━━━━━━━━━━━━━━━━━`
        }
      )

      setTimeout(() => {
        process.exit(0)
      }, 2000)

    } catch (error) {
      console.error('[UPDATE ERROR]', error)

      return await conn.sendMessage(
        m.chat,
        {
          text:
`❌ *Update failed.*

${error.message || 'Unknown error'}

🔐 Your WhatsApp session was not intentionally removed.`
        }
      )
    }

    return
  }

  // ─────────────────────────────────────────────
  // RESTART
  // ─────────────────────────────────────────────
  if (cmd === 'restart') {
    const sent = await conn.sendMessage(
      m.chat,
      {
        text:
`🔄 *Restarting MARY MD...*

Please wait...`
      },
      { quoted: m }
    )

    setTimeout(() => {
      process.exit(0)
    }, 1500)

    return sent
  }
}

handler.help = [
  'checkupdate',
  'update',
  'restart'
]

handler.tags = ['owner']

handler.command = [
  'checkupdate',
  'update',
  'restart'
]

handler.ownerOnly = true

export default handler
