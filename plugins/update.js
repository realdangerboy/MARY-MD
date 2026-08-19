import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import crypto from 'crypto'
import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const ROOT = process.cwd()

const OWNER = 'realdangerboy'
const REPO = 'MARY-MD'
const BRANCH = 'main'

const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`

const UPDATE_LOCK = path.join(ROOT, '.mary-update.lock')

// Files/directories that MUST NEVER be overwritten by the updater.
const PROTECTED = new Set([
  '.env',
  '.git',
  'sessions',
  'data',
  'tmp',
  'node_modules',
  'backups',
  '.mary-update.lock'
])

// Local configuration should remain yours.
// Remove 'config.js' from this list if you want GitHub updates
// to overwrite your local config automatically.
const PRESERVE_FILES = new Set([
  'config.js'
])

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isProtected(file) {
  const clean = normalizePath(file)
  const first = clean.split('/')[0]

  if (PROTECTED.has(first)) return true
  if (PROTECTED.has(clean)) return true

  return false
}

function shouldUpdate(file) {
  const clean = normalizePath(file)

  if (!clean) return false
  if (isProtected(clean)) return false
  if (PRESERVE_FILES.has(clean)) return false

  // Don't download GitHub metadata or unnecessary files.
  if (clean.startsWith('.github/')) return false
  if (clean.startsWith('.git/')) return false

  // Don't overwrite runtime/session/config data.
  if (
    clean.startsWith('sessions/') ||
    clean.startsWith('data/') ||
    clean.startsWith('tmp/') ||
    clean.startsWith('node_modules/')
  ) return false

  return true
}

function languageOf(conn) {
  return String(conn?.language || 'en').toLowerCase().startsWith('es')
    ? 'es'
    : 'en'
}

function text(lang, en, es) {
  return lang === 'es' ? es : en
}

function versionParts(version) {
  return String(version || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map(x => parseInt(x, 10) || 0)
}

function compareVersions(a, b) {
  const A = versionParts(a)
  const B = versionParts(b)

  for (let i = 0; i < 3; i++) {
    if (A[i] > B[i]) return 1
    if (A[i] < B[i]) return -1
  }

  return 0
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function getLocalVersion() {
  const pkg = await readJson(path.join(ROOT, 'package.json'))
  return pkg?.version || '0.0.0'
}

async function fetchJson(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  return response.data
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    responseType: 'text',
    transformResponse: [data => data],
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  return response.data
}

// ------------------------------------------------------------
// GitHub repository information
// ------------------------------------------------------------

async function getRemotePackage() {
  return await fetchJson(
    `${RAW_BASE}/package.json?cache=${Date.now()}`
  )
}

async function getRemoteTree() {
  const data = await fetchJson(
    `${API_BASE}/git/trees/${BRANCH}?recursive=1&cache=${Date.now()}`
  )

  if (!data?.tree) {
    throw new Error('GitHub repository tree could not be read.')
  }

  return data.tree.filter(item => item.type === 'blob')
}

// ------------------------------------------------------------
// CHANGELOG
// ------------------------------------------------------------

function extractLatestChangelog(raw) {
  if (!raw) return null

  const lines = String(raw).split(/\r?\n/)

  let start = -1

  // First "## " section is the newest section.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) {
      start = i
      break
    }
  }

  if (start === -1) return null

  let end = lines.length

  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) {
      end = i
      break
    }
  }

  return lines.slice(start, end).join('\n').trim()
}

async function getRemoteChangelog() {
  try {
    const raw = await fetchText(
      `${RAW_BASE}/CHANGELOG.md?cache=${Date.now()}`
    )

    return extractLatestChangelog(raw)
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// Local SHA calculation
//
// GitHub tree gives Git blob SHA values.
// This calculates the same SHA locally without requiring Git.
// ------------------------------------------------------------

async function gitBlobSha(file) {
  try {
    const data = await fs.readFile(file)

    const header = Buffer.from(`blob ${data.length}\0`)
    const hash = crypto.createHash('sha1')

    hash.update(header)
    hash.update(data)

    return hash.digest('hex')
  } catch {
    return null
  }
}

async function getUpdateInfo() {
  const [localVersion, remotePackage, tree] = await Promise.all([
    getLocalVersion(),
    getRemotePackage(),
    getRemoteTree()
  ])

  const remoteVersion = remotePackage?.version || '0.0.0'

  const changedFiles = []

  for (const item of tree) {
    const file = normalizePath(item.path)

    if (!shouldUpdate(file)) continue

    const localPath = path.join(ROOT, ...file.split('/'))
    const localSha = await gitBlobSha(localPath)

    if (localSha !== item.sha) {
      changedFiles.push({
        path: file,
        sha: item.sha
      })
    }
  }

  const versionChanged =
    compareVersions(remoteVersion, localVersion) !== 0

  return {
    localVersion,
    remoteVersion,
    versionChanged,
    changedFiles,
    available: versionChanged || changedFiles.length > 0
  }
}

// ------------------------------------------------------------
// Safe directory creation
// ------------------------------------------------------------

async function ensureParent(file) {
  await fs.mkdir(path.dirname(file), {
    recursive: true
  })
}

// ------------------------------------------------------------
// Download a single file
// ------------------------------------------------------------

async function downloadFile(relativePath) {
  const clean = normalizePath(relativePath)

  if (!shouldUpdate(clean)) {
    return false
  }

  const destination = path.join(
    ROOT,
    ...clean.split('/')
  )

  const url =
    `${RAW_BASE}/${clean.split('/').map(encodeURIComponent).join('/')}` +
    `?cache=${Date.now()}`

  const response = await axios.get(url, {
    timeout: 60000,
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  await ensureParent(destination)

  // Write atomically.
  const tempFile = `${destination}.marytmp`

  await fs.writeFile(tempFile, response.data)
  await fs.rename(tempFile, destination)

  return true
}

// ------------------------------------------------------------
// Remove files that exist locally but no longer exist remotely.
//
// IMPORTANT:
// Only removes files inside source directories that the updater
// controls. Sessions/data/config/etc. are never touched.
// ------------------------------------------------------------

async function getLocalSourceFiles(dir, relative = '') {
  const result = []

  if (!fsSync.existsSync(dir)) return result

  const entries = await fs.readdir(dir, {
    withFileTypes: true
  })

  for (const entry of entries) {
    const rel = relative
      ? `${relative}/${entry.name}`
      : entry.name

    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'sessions' ||
        entry.name === 'data' ||
        entry.name === 'tmp'
      ) {
        continue
      }

      result.push(
        ...(await getLocalSourceFiles(full, rel))
      )
    } else {
      result.push(normalizePath(rel))
    }
  }

  return result
}

async function removeDeletedFiles(remotePaths) {
  const remoteSet = new Set(remotePaths)

  // Only clean plugins and lib.
  for (const rootDir of ['plugins', 'lib']) {
    const dir = path.join(ROOT, rootDir)

    if (!fsSync.existsSync(dir)) continue

    const localFiles = await getLocalSourceFiles(
      dir,
      rootDir
    )

    for (const file of localFiles) {
      if (!remoteSet.has(file)) {
        const full = path.join(
          ROOT,
          ...file.split('/')
        )

        try {
          await fs.unlink(full)
        } catch {}
      }
    }
  }
}

// ------------------------------------------------------------
// npm dependency update
// ------------------------------------------------------------

async function installDependencies() {
  try {
    const packageManagerFiles = [
      'package-lock.json',
      'npm-shrinkwrap.json'
    ]

    const hasLock = packageManagerFiles.some(file =>
      fsSync.existsSync(path.join(ROOT, file))
    )

    const command = hasLock
      ? 'npm install --omit=dev'
      : 'npm install --omit=dev'

    await execAsync(command, {
      cwd: ROOT,
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 10
    })

    return true
  } catch (error) {
    console.error(
      '[MARY UPDATE] npm install failed:',
      error.message
    )

    return false
  }
}

// ------------------------------------------------------------
// Restart
// ------------------------------------------------------------

function restartBot() {
  setTimeout(() => {
    process.exit(1)
  }, 1200)
}

// ------------------------------------------------------------
// RESTART COMMAND
// ------------------------------------------------------------

const restart = async (m, { conn }) => {
  const lang = languageOf(conn)

  const msg = text(
    lang,
    '🔄 *Restarting MARY MD...*\n\nPlease wait a moment.',
    '🔄 *Reiniciando MARY MD...*\n\nEspera un momento.'
  )

  await conn.sendMessage(
    m.chat,
    { text: msg },
    { quoted: m }
  )

  restartBot()
}

restart.help = ['restart']
restart.tags = ['system']
restart.command = ['restart']
restart.ownerOnly = true

// ------------------------------------------------------------
// CHECKUPDATE COMMAND
// ------------------------------------------------------------

const checkupdate = async (m, { conn }) => {
  const lang = languageOf(conn)

  await conn.sendMessage(
    m.chat,
    {
      react: {
        text: '🔎',
        key: m.key
      }
    }
  )

  const processing = await conn.sendMessage(
    m.chat,
    {
      text: text(
        lang,
        '🔎 *Checking for updates...*',
        '🔎 *Comprobando actualizaciones...*'
      )
    },
    { quoted: m }
  )

  try {
    const info = await getUpdateInfo()

    if (!info.available) {
      await conn.sendMessage(
        m.chat,
        {
          text: text(
            lang,
            `✅ *MARY MD is up to date!*\n\n📦 Version: *${info.localVersion}*`,
            `✅ *¡MARY MD está actualizado!*\n\n📦 Versión: *${info.localVersion}*`
          ),
          edit: processing.key
        }
      )

      await conn.sendMessage(
        m.chat,
        {
          react: {
            text: '✅',
            key: m.key
          }
        }
      )

      return
    }

    const changelog = await getRemoteChangelog()

    let output = text(
      lang,
      `🆕 *MARY MD UPDATE AVAILABLE*\n\n`,
      `🆕 *ACTUALIZACIÓN DE MARY MD DISPONIBLE*\n\n`
    )

    output +=
      `📦 Current: *${info.localVersion}*\n` +
      `📦 New: *${info.remoteVersion}*\n`

    if (info.changedFiles.length) {
      output +=
        `📁 Changed files: *${info.changedFiles.length}*\n`
    }

    if (changelog) {
      output += `\n📝 *CHANGELOG*\n\n${changelog}\n`
    }

    output += '\n'

    output += text(
      lang,
      `Use *${conn?.prefix || '.'}update* to install the update.`,
      `Usa *${conn?.prefix || '.'}update* para instalar la actualización.`
    )

    await conn.sendMessage(
      m.chat,
      {
        text: output,
        edit: processing.key
      }
    )

    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '✅',
          key: m.key
        }
      }
    )
  } catch (error) {
    console.error('[CHECKUPDATE]', error)

    await conn.sendMessage(
      m.chat,
      {
        text: text(
          lang,
          `❌ *Update check failed*\n\n${error.message}`,
          `❌ *No se pudo comprobar la actualización*\n\n${error.message}`
        ),
        edit: processing.key
      }
    )

    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '❌',
          key: m.key
        }
      }
    )
  }
}

checkupdate.help = ['checkupdate']
checkupdate.tags = ['system']
checkupdate.command = ['checkupdate', 'checkupdates']
checkupdate.ownerOnly = true

// ------------------------------------------------------------
// UPDATE COMMAND
// ------------------------------------------------------------

const update = async (m, { conn }) => {
  const lang = languageOf(conn)

  if (fsSync.existsSync(UPDATE_LOCK)) {
    return conn.sendMessage(
      m.chat,
      {
        text: text(
          lang,
          '⚠️ An update is already running.',
          '⚠️ Ya hay una actualización en proceso.'
        )
      },
      { quoted: m }
    )
  }

  await fs.writeFile(
    UPDATE_LOCK,
    JSON.stringify({
      startedAt: new Date().toISOString()
    })
  )

  try {
    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '⬇️',
          key: m.key
        }
      }
    )

    const status = await conn.sendMessage(
      m.chat,
      {
        text: text(
          lang,
          '⏳ *Checking latest MARY MD version...*',
          '⏳ *Comprobando la última versión de MARY MD...*'
        )
      },
      { quoted: m }
    )

    const info = await getUpdateInfo()

    if (!info.available) {
      await conn.sendMessage(
        m.chat,
        {
          text: text(
            lang,
            `✅ *Already up to date!*\n\n📦 Version: *${info.localVersion}*`,
            `✅ *Ya está actualizado!*\n\n📦 Versión: *${info.localVersion}*`
          ),
          edit: status.key
        }
      )

      await conn.sendMessage(
        m.chat,
        {
          react: {
            text: '✅',
            key: m.key
          }
        }
      )

      return
    }

    await conn.sendMessage(
      m.chat,
      {
        text: text(
          lang,
          `⬇️ *Downloading update...*\n\n📦 ${info.localVersion} → ${info.remoteVersion}\n📁 ${info.changedFiles.length} files`,
          `⬇️ *Descargando actualización...*\n\n📦 ${info.localVersion} → ${info.remoteVersion}\n📁 ${info.changedFiles.length} archivos`
        ),
        edit: status.key
      }
    )

    // Fetch tree again so we have complete remote file list.
    const tree = await getRemoteTree()

    const remotePaths = tree
      .map(x => normalizePath(x.path))
      .filter(shouldUpdate)

    let downloaded = 0
    let failed = 0

    // Download sequentially to reduce RAM/CPU usage on Pterodactyl.
    for (const file of remotePaths) {
      try {
        const didDownload = await downloadFile(file)

        if (didDownload) {
          downloaded++
        }
      } catch (error) {
        failed++

        console.error(
          `[MARY UPDATE] Failed: ${file}`,
          error.message
        )
      }
    }

    if (failed > 0) {
      throw new Error(
        `${failed} file(s) failed to download.`
      )
    }

    // Remove deleted plugins/lib files.
    await removeDeletedFiles(remotePaths)

    // Update npm packages if package.json changed.
    const packageChanged = info.changedFiles.some(
      x => x.path === 'package.json'
    )

    let npmStatus = ''

    if (packageChanged) {
      await conn.sendMessage(
        m.chat,
        {
          text: text(
            lang,
            '📦 Installing updated dependencies...',
            '📦 Instalando las dependencias actualizadas...'
          ),
          edit: status.key
        }
      )

      const npmOK = await installDependencies()

      npmStatus = npmOK
        ? text(
            lang,
            '\n📦 Dependencies installed.',
            '\n📦 Dependencias instaladas.'
          )
        : text(
            lang,
            '\n⚠️ Dependencies could not be installed automatically.',
            '\n⚠️ No se pudieron instalar automáticamente las dependencias.'
          )
    }

    const newChangelog = await getRemoteChangelog()

    let finalMessage = text(
      lang,
      `✅ *MARY MD UPDATED SUCCESSFULLY!*\n\n📦 Version: *${info.remoteVersion}*\n📁 Files updated: *${downloaded}*${npmStatus}\n\n🔄 *Restarting bot...*`,
      `✅ *¡MARY MD SE ACTUALIZÓ CORRECTAMENTE!*\n\n📦 Versión: *${info.remoteVersion}*\n📁 Archivos actualizados: *${downloaded}*${npmStatus}\n\n🔄 *Reiniciando bot...*`
    )

    if (newChangelog) {
      finalMessage += `\n\n📝 *CHANGELOG*\n\n${newChangelog}`
    }

    await conn.sendMessage(
      m.chat,
      {
        text: finalMessage,
        edit: status.key
      }
    )

    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '✅',
          key: m.key
        }
      }
    )

    // Give WhatsApp a moment to send the message.
    setTimeout(() => {
      restartBot()
    }, 1500)

  } catch (error) {
    console.error('[MARY UPDATE]', error)

    await conn.sendMessage(
      m.chat,
      {
        text: text(
          lang,
          `❌ *UPDATE FAILED*\n\n${error.message}\n\nYour session and personal data were not touched.`,
          `❌ *ACTUALIZACIÓN FALLIDA*\n\n${error.message}\n\nTu sesión y datos personales no fueron modificados.`
        )
      },
      { quoted: m }
    )

    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '❌',
          key: m.key
        }
      }
    )
  } finally {
    try {
      await fs.unlink(UPDATE_LOCK)
    } catch {}
  }
}

update.help = ['update']
update.tags = ['system']
update.command = ['update']
update.ownerOnly = true

// ------------------------------------------------------------
// EXPORT
// ------------------------------------------------------------

export {
  restart,
  checkupdate,
  update
}

export default update
