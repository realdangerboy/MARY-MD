// plugins/update.js

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import axios from 'axios'

const execFileAsync = promisify(execFile)

const OWNER = 'realdangerboy'
const REPO = 'MARY-MD'
const BRANCH = 'main'

const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}`
const ZIP_URL = `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/heads/${BRANCH}`

const PROTECTED = [
  'sessions',
  'sessions/',
  'data',
  'data/',
  'tmp',
  'tmp/',
  'node_modules',
  'node_modules/',
  '.env'
]

function isProtected(name) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '')

  return PROTECTED.some(item =>
    clean === item.replace(/\/$/, '') ||
    clean.startsWith(item)
  )
}

async function getLocalPackage() {
  try {
    return JSON.parse(
      await fs.readFile('./package.json', 'utf8')
    )
  } catch {
    return { version: '1.0.0' }
  }
}

async function getRemotePackage() {
  const { data } = await axios.get(
    `${API_URL}/contents/package.json?ref=${BRANCH}`,
    {
      timeout: 15000,
      headers: {
        'User-Agent': 'MARY-MD-Updater'
      }
    }
  )

  const content = Buffer.from(data.content, 'base64').toString('utf8')
  return JSON.parse(content)
}

async function getChangelog() {
  try {
    const { data } = await axios.get(
      `${API_URL}/contents/changelog.json?ref=${BRANCH}`,
      {
        timeout: 15000,
        headers: {
          'User-Agent': 'MARY-MD-Updater'
        }
      }
    )

    return JSON.parse(
      Buffer.from(data.content, 'base64').toString('utf8')
    )
  } catch {
    return null
  }
}

async function getLatestCommits() {
  try {
    const { data } = await axios.get(
      `${API_URL}/commits?sha=${BRANCH}&per_page=10`,
      {
        timeout: 15000,
        headers: {
          'User-Agent': 'MARY-MD-Updater'
        }
      }
    )

    return data.map(commit => ({
      message: commit.commit?.message?.split('\n')[0] || 'Update',
      date: commit.commit?.author?.date || ''
    }))
  } catch {
    return []
  }
}

function compareVersions(a, b) {
  const A = String(a).split('.').map(Number)
  const B = String(b).split('.').map(Number)

  for (let i = 0; i < 3; i++) {
    const x = A[i] || 0
    const y = B[i] || 0

    if (x > y) return 1
    if (x < y) return -1
  }

  return 0
}

async function downloadRepo(tempDir) {
  const archive = path.join(tempDir, 'mary-md.tar.gz')

  const response = await axios.get(ZIP_URL, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  await fs.writeFile(archive, response.data)

  const extractDir = path.join(tempDir, 'extract')
  await fs.mkdir(extractDir, { recursive: true })

  await execFileAsync(
    'tar',
    ['-xzf', archive, '-C', extractDir],
    {
      timeout: 180000
    }
  )

  const entries = await fs.readdir(extractDir)

  if (!entries.length) {
    throw new Error('GitHub archive is empty.')
  }

  return path.join(extractDir, entries[0])
}

async function copyUpdatedFiles(source, destination) {
  const entries = await fs.readdir(source, {
    withFileTypes: true
  })

  for (const entry of entries) {
    const name = entry.name

    if (isProtected(name)) {
      continue
    }

    const src = path.join(source, name)
    const dest = path.join(destination, name)

    if (entry.isDirectory()) {
      await fs.mkdir(dest, { recursive: true })
      await copyUpdatedFiles(src, dest)
    } else {
      await fs.mkdir(path.dirname(dest), {
        recursive: true
      })

      await fs.copyFile(src, dest)
    }
  }
}

async function installDependencies() {
  try {
    await execFileAsync(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund'],
      {
        timeout: 300000,
        cwd: process.cwd()
      }
    )

    return true
  } catch (error) {
    console.error(
      '[MARY MD] npm install error:',
      error.stderr || error.message
    )

    return false
  }
}

async function restartBot() {
  setTimeout(() => {
    process.exit(0)
  }, 2000)
}

const handler = async (m, { conn, command }) => {

  // ═════════════════════════════════════════════
  // CHECK UPDATE
  // ═════════════════════════════════════════════

  if (command === 'checkupdate') {

    const sent = await conn.sendMessage(
      m.chat,
      {
        text: '🔎 Checking for MARY MD updates...'
      },
      { quoted: m }
    )

    try {

      const localPkg = await getLocalPackage()
      const remotePkg = await getRemotePackage()

      const localVersion =
        localPkg.version || '1.0.0'

      const remoteVersion =
        remotePkg.version || localVersion

      const changelog = await getChangelog()
      const commits = await getLatestCommits()

      const versionChanged =
        compareVersions(
          remoteVersion,
          localVersion
        ) > 0

      if (!versionChanged) {

        return await conn.sendMessage(
          m.chat,
          {
            text:
`╭━━━〔 MARY MD 〕━━━
┃
┃ ✅ *Already up to date*
┃
┃ 📦 Version: *${localVersion}*
┃
╰━━━━━━━━━━━━━━`
            ,
            edit: sent.key
          }
        )
      }

      let text =
`╭━━━〔 🆕 UPDATE AVAILABLE 〕━━━
┃
┃ 📦 Current: *${localVersion}*
┃ 📦 New: *${remoteVersion}*
┃
┃ 📝 *CHANGELOG*
┃
`

      if (
        changelog &&
        Array.isArray(changelog.changes)
      ) {

        for (
          const change of changelog.changes.slice(0, 15)
        ) {

          const title =
            change.title ||
            change.description ||
            'Update'

          text += `┃ • ${title}\n`
        }

      } else if (commits.length) {

        for (
          const commit of commits.slice(0, 10)
        ) {

          text += `┃ • ${commit.message}\n`
        }

      } else {

        text +=
          `┃ • New features and fixes\n`
      }

      text +=
`
┃
┃ Use *update* to install.
┃
╰━━━━━━━━━━━━━━━━━━━━`

      return await conn.sendMessage(
        m.chat,
        {
          text,
          edit: sent.key
        }
      )

    } catch (error) {

      console.error(
        '[CHECKUPDATE ERROR]',
        error.message
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

  // ═════════════════════════════════════════════
  // UPDATE
  // ═════════════════════════════════════════════

  if (command === 'update') {

    const sent = await conn.sendMessage(
      m.chat,
      {
        text: '⏳ Downloading MARY MD update...'
      },
      { quoted: m }
    )

    let tempDir = null

    try {

      const localPkg = await getLocalPackage()
      const remotePkg = await getRemotePackage()

      const localVersion =
        localPkg.version || '1.0.0'

      const remoteVersion =
        remotePkg.version || localVersion

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
`⏳ *Updating MARY MD...*

📦 ${localVersion} → ${remoteVersion}

🔐 WhatsApp session will be preserved.`
          ,
          edit: sent.key
        }
      )

      // Temporary directory outside bot files
      tempDir = await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'mary-md-update-'
        )
      )

      // Download GitHub repository
      const source = await downloadRepo(tempDir)

      // Update files.
      // sessions/, data/, tmp/, node_modules and .env
      // are explicitly protected.
      await copyUpdatedFiles(
        source,
        process.cwd()
      )

      // Install new dependencies if package.json changed
      await conn.sendMessage(
        m.chat,
        {
          text:
`📦 Files updated.

⏳ Installing dependencies...`,
          edit: sent.key
        }
      )

      const npmOk = await installDependencies()

      if (!npmOk) {
        console.log(
          '[MARY MD] npm install failed. Continuing restart.'
        )
      }

      await conn.sendMessage(
        m.chat,
        {
          text:
`╭━━━〔 ✅ UPDATE COMPLETE 〕━━━
┃
┃ 📦 Version:
┃ ${localVersion} → ${remoteVersion}
┃
┃ 🔐 Session: PRESERVED
┃
┃ 📁 sessions/: untouched
┃ 📁 data/: untouched
┃ 📁 tmp/: untouched
┃
┃ 🔄 Restarting...
╰━━━━━━━━━━━━━━━━━━━━`
        }
      )

      // Restart process
      await restartBot()

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

    return
  }

  // ═════════════════════════════════════════════
  // RESTART
  // ═════════════════════════════════════════════

  if (command === 'restart') {

    await conn.sendMessage(
      m.chat,
      {
        text:
`🔄 *Restarting MARY MD...*

🔐 WhatsApp session will be preserved.`
      },
      { quoted: m }
    )

    await restartBot()

    return
  }
}

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
