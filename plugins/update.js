// plugins/update.js

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import axios from 'axios'

const execFileAsync = promisify(execFile)

// ─────────────────────────────────────────────
// GITHUB CONFIG
// ─────────────────────────────────────────────

const OWNER = 'realdangerboy'
const REPO = 'MARY-MD'
const BRANCH = 'main'

const RAW_BASE =
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`

const API_BASE =
  `https://api.github.com/repos/${OWNER}/${REPO}`

const ZIP_URL =
  `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/heads/${BRANCH}`

// ─────────────────────────────────────────────
// PROTECTED FILES / DIRECTORIES
// ─────────────────────────────────────────────
//
// These are NEVER replaced by the updater.
//
// sessions = WhatsApp login/session
// data     = bot database/settings
// tmp      = temporary files
// .env     = environment variables
// node_modules = installed modules
// ─────────────────────────────────────────────

const PROTECTED = [
  'sessions',
  'data',
  'tmp',
  'node_modules',
  '.env'
]

function isProtected(name) {
  const clean = name
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  return PROTECTED.some(item =>
    clean === item ||
    clean.startsWith(`${item}/`)
  )
}

// ─────────────────────────────────────────────
// LOCAL PACKAGE
// ─────────────────────────────────────────────

async function getLocalPackage() {
  try {
    return JSON.parse(
      await fs.readFile('./package.json', 'utf8')
    )
  } catch {
    return {
      version: '1.0.0'
    }
  }
}

// ─────────────────────────────────────────────
// REMOTE PACKAGE
// ─────────────────────────────────────────────

async function getRemotePackage() {
  const url = `${RAW_BASE}/package.json`

  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  return response.data
}

// ─────────────────────────────────────────────
// GET CHANGELOG.MD
// ─────────────────────────────────────────────

async function getRemoteChangelog() {
  const url = `${RAW_BASE}/CHANGELOG.md`

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: {
        'User-Agent': 'MARY-MD-Updater'
      }
    })

    return response.data
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────
// VERSION COMPARISON
// ─────────────────────────────────────────────

function compareVersions(a, b) {
  const A = String(a)
    .replace(/^v/i, '')
    .split('.')
    .map(Number)

  const B = String(b)
    .replace(/^v/i, '')
    .split('.')
    .map(Number)

  for (let i = 0; i < 3; i++) {
    const x = A[i] || 0
    const y = B[i] || 0

    if (x > y) return 1
    if (x < y) return -1
  }

  return 0
}

// ─────────────────────────────────────────────
// EXTRACT VERSION SECTION FROM CHANGELOG
// ─────────────────────────────────────────────

function getVersionChangelog(markdown, version) {
  if (!markdown) return null

  const cleanVersion = String(version)
    .replace(/^v/i, '')
    .trim()

  const lines = markdown.split(/\r?\n/)

  const startRegex = new RegExp(
    `^##\\s+\\[?v?${cleanVersion.replace(/\./g, '\\.')}\\]?\\s*$`,
    'i'
  )

  let start = -1

  for (let i = 0; i < lines.length; i++) {
    if (startRegex.test(lines[i].trim())) {
      start = i
      break
    }
  }

  // Version section not found
  if (start === -1) {
    return null
  }

  const result = []

  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/i.test(lines[i].trim())) {
      break
    }

    result.push(lines[i])
  }

  return result
    .join('\n')
    .trim()
}

// ─────────────────────────────────────────────
// CLEAN MARKDOWN FOR WHATSAPP
// ─────────────────────────────────────────────

function formatChangelog(text) {
  if (!text) {
    return 'No changelog available for this version.'
  }

  return text
    .replace(/^###\s+(.+)$/gm, '*$1*')
    .replace(/^####\s+(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .trim()
}

// ─────────────────────────────────────────────
// DOWNLOAD COMPLETE REPOSITORY
// ─────────────────────────────────────────────

async function downloadRepository(tempDir) {
  const archive = path.join(
    tempDir,
    'mary-md-update.tar.gz'
  )

  const response = await axios.get(ZIP_URL, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  await fs.writeFile(
    archive,
    response.data
  )

  const extractDir = path.join(
    tempDir,
    'extract'
  )

  await fs.mkdir(
    extractDir,
    {
      recursive: true
    }
  )

  await execFileAsync(
    'tar',
    [
      '-xzf',
      archive,
      '-C',
      extractDir
    ],
    {
      timeout: 180000
    }
  )

  const folders = await fs.readdir(
    extractDir
  )

  if (!folders.length) {
    throw new Error(
      'GitHub update archive is empty.'
    )
  }

  return path.join(
    extractDir,
    folders[0]
  )
}

// ─────────────────────────────────────────────
// COPY UPDATED FILES
// ─────────────────────────────────────────────

async function copyUpdatedFiles(
  source,
  destination
) {
  const entries = await fs.readdir(
    source,
    {
      withFileTypes: true
    }
  )

  for (const entry of entries) {
    const name = entry.name

    // NEVER TOUCH PROTECTED FILES
    if (isProtected(name)) {
      continue
    }

    const src = path.join(
      source,
      name
    )

    const dest = path.join(
      destination,
      name
    )

    if (entry.isDirectory()) {
      await fs.mkdir(
        dest,
        {
          recursive: true
        }
      )

      await copyUpdatedFiles(
        src,
        dest
      )
    } else {
      await fs.mkdir(
        path.dirname(dest),
        {
          recursive: true
        }
      )

      await fs.copyFile(
        src,
        dest
      )
    }
  }
}

// ─────────────────────────────────────────────
// NPM INSTALL
// ─────────────────────────────────────────────

async function installDependencies() {
  try {
    await execFileAsync(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund'
      ],
      {
        cwd: process.cwd(),
        timeout: 300000
      }
    )

    return true
  } catch (error) {
    console.error(
      '[MARY MD] npm install failed:',
      error.stderr || error.message
    )

    return false
  }
}

// ─────────────────────────────────────────────
// RESTART
// ─────────────────────────────────────────────

function restartBot() {
  setTimeout(() => {
    process.exit(0)
  }, 2000)
}

// ─────────────────────────────────────────────
// CHECK UPDATE
// ─────────────────────────────────────────────

async function checkUpdate(m, conn) {
  const sent = await conn.sendMessage(
    m.chat,
    {
      text: '🔎 Checking for MARY MD updates...'
    },
    {
      quoted: m
    }
  )

  try {
    const localPackage =
      await getLocalPackage()

    const remotePackage =
      await getRemotePackage()

    const localVersion =
      localPackage.version || '1.0.0'

    const remoteVersion =
      remotePackage.version || localVersion

    const updateAvailable =
      compareVersions(
        remoteVersion,
        localVersion
      ) > 0

    if (!updateAvailable) {
      return await conn.sendMessage(
        m.chat,
        {
          text:
`╭━━━〔 MARY MD 〕━━━
┃
┃ ✅ *Bot is up to date*
┃
┃ 📦 Version: *${localVersion}*
┃
╰━━━━━━━━━━━━━━━━`
          ,
          edit: sent.key
        }
      )
    }

    // ONLY CHANGELOG.MD
    // NO GITHUB COMMITS
    const changelog =
      await getRemoteChangelog()

    const versionChangelog =
      getVersionChangelog(
        changelog,
        remoteVersion
      )

    let changelogText

    if (versionChangelog) {
      changelogText =
        formatChangelog(
          versionChangelog
        )
    } else {
      changelogText =
        'No changelog available for this version.'
    }

    const message =
`╭━━━〔 🆕 UPDATE AVAILABLE 〕━━━
┃
┃ 📦 Current: *${localVersion}*
┃ 📦 New: *${remoteVersion}*
┃
┃ 📝 *CHANGELOG*
┃
${changelogText
  .split('\n')
  .map(line => `┃ ${line}`)
  .join('\n')}
┃
┃ Use *update* to install.
┃
╰━━━━━━━━━━━━━━━━━━━━`

    return await conn.sendMessage(
      m.chat,
      {
        text: message,
        edit: sent.key
      }
    )

  } catch (error) {
    console.error(
      '[CHECKUPDATE ERROR]',
      error.stack || error.message
    )

    return await conn.sendMessage(
      m.chat,
      {
        text:
`❌ *Failed to check updates.*

${error.message}`,
        edit: sent.key
      }
    )
  }
}

// ─────────────────────────────────────────────
// UPDATE BOT
// ─────────────────────────────────────────────

async function updateBot(m, conn) {
  const sent = await conn.sendMessage(
    m.chat,
    {
      text:
`⏳ *Starting MARY MD update...*

🔐 WhatsApp session will be preserved.`
    },
    {
      quoted: m
    }
  )

  let tempDir = null

  try {
    const localPackage =
      await getLocalPackage()

    const remotePackage =
      await getRemotePackage()

    const localVersion =
      localPackage.version || '1.0.0'

    const remoteVersion =
      remotePackage.version || localVersion

    // Already latest
    if (
      compareVersions(
        remoteVersion,
        localVersion
      ) <= 0
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
`⏳ *Downloading update...*

📦 ${localVersion} → ${remoteVersion}

🔐 Session protection: *ACTIVE*`,
        edit: sent.key
      }
    )

    // Temporary directory
    tempDir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'mary-md-update-'
      )
    )

    // Download GitHub repository
    const source =
      await downloadRepository(
        tempDir
      )

    await conn.sendMessage(
      m.chat,
      {
        text:
`📥 *Download complete.*

📦 Installing MARY MD ${remoteVersion}...`,
        edit: sent.key
      }
    )

    // Update repository files
    //
    // sessions/
    // data/
    // tmp/
    // node_modules/
    // .env
    //
    // are NOT touched.
    await copyUpdatedFiles(
      source,
      process.cwd()
    )

    await conn.sendMessage(
      m.chat,
      {
        text:
`📦 *Files installed.*

⏳ Installing dependencies...`,
        edit: sent.key
      }
    )

    await installDependencies()

    await conn.sendMessage(
      m.chat,
      {
        text:
`╭━━━〔 ✅ UPDATE COMPLETE 〕━━━
┃
┃ 📦 Version:
┃ *${localVersion}* → *${remoteVersion}*
┃
┃ 🔐 WhatsApp Session:
┃ *PRESERVED*
┃
┃ 📁 sessions/
┃ *NOT TOUCHED*
┃
┃ 📁 data/
┃ *NOT TOUCHED*
┃
┃ 📁 tmp/
┃ *NOT TOUCHED*
┃
┃ 🔄 Restarting bot...
╰━━━━━━━━━━━━━━━━━━━━`
      }
    )

    // Give WhatsApp time to send message
    // then restart process.
    restartBot()

  } catch (error) {
    console.error(
      '[UPDATE ERROR]',
      error.stack || error.message
    )

    return await conn.sendMessage(
      m.chat,
      {
        text:
`❌ *Update failed.*

${error.message}

🔐 Your WhatsApp session was not intentionally modified.`,
        edit: sent.key
      }
    )

  } finally {
    if (tempDir) {
      await fs.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {})
    }
  }
}

// ─────────────────────────────────────────────
// RESTART BOT
// ─────────────────────────────────────────────

async function restartOnly(m, conn) {
  await conn.sendMessage(
    m.chat,
    {
      text:
`🔄 *Restarting MARY MD...*

🔐 WhatsApp session will be preserved.`
    },
    {
      quoted: m
    }
  )

  restartBot()
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────

const handler = async (
  m,
  {
    conn,
    command
  }
) => {

  if (command === 'checkupdate') {
    return checkUpdate(
      m,
      conn
    )
  }

  if (command === 'update') {
    return updateBot(
      m,
      conn
    )
  }

  if (command === 'restart') {
    return restartOnly(
      m,
      conn
    )
  }
}

// ─────────────────────────────────────────────
// MENU
// ─────────────────────────────────────────────

handler.help = [
  'checkupdate',
  'update',
  'restart'
]

handler.tags = [
  'owner'
]

handler.command = [
  'checkupdate',
  'update',
  'restart'
]

handler.ownerOnly = true

export default handler
