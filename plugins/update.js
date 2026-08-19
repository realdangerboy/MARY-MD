import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import axios from 'axios'
import crypto from 'crypto'

const ROOT = process.cwd()

const OWNER = 'realdangerboy'
const REPO = 'MARY-MD'
const BRANCH = 'main'

const API_BASE =
  `https://api.github.com/repos/${OWNER}/${REPO}`

const RAW_BASE =
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`

// ─────────────────────────────────────────────────────────────
// PROTECTED FILES / DIRECTORIES
// ─────────────────────────────────────────────────────────────

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

// Local configuration must stay untouched.
const PRESERVE = new Set([
  'config.js'
])

const LOCK_FILE =
  path.join(ROOT, '.mary-update.lock')

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function cleanPath(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function isProtected(file) {
  const clean = cleanPath(file)
  const first = clean.split('/')[0]

  return (
    PROTECTED.has(clean) ||
    PROTECTED.has(first)
  )
}

function canUpdate(file) {
  const clean = cleanPath(file)

  if (!clean) return false

  if (isProtected(clean)) {
    return false
  }

  if (PRESERVE.has(clean)) {
    return false
  }

  if (clean.startsWith('.github/')) {
    return false
  }

  if (clean.startsWith('.git/')) {
    return false
  }

  if (clean.startsWith('sessions/')) {
    return false
  }

  if (clean.startsWith('data/')) {
    return false
  }

  if (clean.startsWith('tmp/')) {
    return false
  }

  if (clean.startsWith('node_modules/')) {
    return false
  }

  return true
}

function langOf(conn) {
  return String(conn?.language || 'en')
    .toLowerCase()
    .startsWith('es')
    ? 'es'
    : 'en'
}

function t(lang, en, es) {
  return lang === 'es' ? es : en
}

function getVersionNumber(version) {
  return String(version || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map(x => Number.parseInt(x, 10) || 0)
}

function compareVersions(a, b) {
  const A = getVersionNumber(a)
  const B = getVersionNumber(b)

  for (let i = 0; i < 3; i++) {
    if (A[i] > B[i]) return 1
    if (A[i] < B[i]) return -1
  }

  return 0
}

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────

async function getJSON(url) {
  const response = await axios.get(url, {
    timeout: 15000,

    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  return response.data
}

async function getText(url) {
  const response = await axios.get(url, {
    timeout: 15000,

    responseType: 'text',

    transformResponse: [
      data => data
    ],

    headers: {
      'User-Agent': 'MARY-MD-Updater',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  })

  return response.data
}

// ─────────────────────────────────────────────────────────────
// LOCAL VERSION
// ─────────────────────────────────────────────────────────────

async function getLocalVersion() {
  try {
    const raw = await fs.readFile(
      path.join(ROOT, 'package.json'),
      'utf8'
    )

    const pkg = JSON.parse(raw)

    return pkg.version || '0.0.0'

  } catch {
    return '0.0.0'
  }
}

// ─────────────────────────────────────────────────────────────
// REMOTE PACKAGE
// ─────────────────────────────────────────────────────────────

async function getRemotePackage() {
  return getJSON(
    `${RAW_BASE}/package.json?ref=${BRANCH}&_=${Date.now()}`
  )
}

// ─────────────────────────────────────────────────────────────
// CHANGELOG PARSER
// ─────────────────────────────────────────────────────────────

function latestChangelog(raw) {
  if (!raw) return null

  const lines =
    String(raw).split(/\r?\n/)

  let start = -1

  // First ## section = latest changelog
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i]
        .trim()
        .startsWith('## ')
    ) {
      start = i
      break
    }
  }

  if (start === -1) {
    return null
  }

  let end = lines.length

  for (
    let i = start + 1;
    i < lines.length;
    i++
  ) {
    if (
      lines[i]
        .trim()
        .startsWith('## ')
    ) {
      end = i
      break
    }
  }

  return lines
    .slice(start, end)
    .join('\n')
    .trim()
}

// ─────────────────────────────────────────────────────────────
// REMOTE CHANGELOG
// IMPORTANT:
// Uses GitHub Contents API instead of local CHANGELOG.
// This prevents showing the old local changelog.
// ─────────────────────────────────────────────────────────────

async function getRemoteChangelog() {
  try {
    const data = await getJSON(
      `${API_BASE}/contents/CHANGELOG.md?ref=${encodeURIComponent(BRANCH)}&_=${Date.now()}`
    )

    if (!data?.content) {
      return null
    }

    const raw = Buffer
      .from(
        data.content,
        'base64'
      )
      .toString('utf8')

    return latestChangelog(raw)

  } catch (error) {

    console.error(
      '[MARY UPDATE] Remote changelog:',
      error.message
    )

    // Fallback to raw GitHub file
    try {
      const raw = await getText(
        `${RAW_BASE}/CHANGELOG.md?ref=${encodeURIComponent(BRANCH)}&_=${Date.now()}`
      )

      return latestChangelog(raw)

    } catch {
      return null
    }
  }
}

// ─────────────────────────────────────────────────────────────
// GITHUB TREE
// ─────────────────────────────────────────────────────────────

async function getRemoteTree() {
  const data = await getJSON(
    `${API_BASE}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1&_=${Date.now()}`
  )

  if (!data?.tree) {
    throw new Error(
      'Could not read GitHub repository.'
    )
  }

  return data.tree.filter(
    item => item.type === 'blob'
  )
}

// ─────────────────────────────────────────────────────────────
// LOCAL GIT BLOB SHA
// ─────────────────────────────────────────────────────────────

async function localBlobSha(file) {
  try {
    const data =
      await fs.readFile(file)

    const header =
      Buffer.from(
        `blob ${data.length}\0`
      )

    const hash =
      crypto.createHash('sha1')

    hash.update(header)
    hash.update(data)

    return hash.digest('hex')

  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// CHECK UPDATE
// ─────────────────────────────────────────────────────────────

async function checkForUpdate() {
  const localVersion =
    await getLocalVersion()

  const [
    remotePackage,
    remoteTree
  ] = await Promise.all([
    getRemotePackage(),
    getRemoteTree()
  ])

  const remoteVersion =
    remotePackage?.version || '0.0.0'

  const changedFiles = []

  for (const item of remoteTree) {

    const file =
      cleanPath(item.path)

    if (!canUpdate(file)) {
      continue
    }

    const localPath =
      path.join(
        ROOT,
        ...file.split('/')
      )

    const localSha =
      await localBlobSha(localPath)

    if (localSha !== item.sha) {
      changedFiles.push(file)
    }
  }

  const versionChanged =
    compareVersions(
      remoteVersion,
      localVersion
    ) !== 0

  return {
    localVersion,
    remoteVersion,
    changedFiles,

    available:
      versionChanged ||
      changedFiles.length > 0
  }
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD FILE
// ─────────────────────────────────────────────────────────────

async function downloadFile(file) {
  const clean =
    cleanPath(file)

  if (!canUpdate(clean)) {
    return false
  }

  const destination =
    path.join(
      ROOT,
      ...clean.split('/')
    )

  const encodedPath =
    clean
      .split('/')
      .map(
        encodeURIComponent
      )
      .join('/')

  const url =
    `${RAW_BASE}/${encodedPath}?ref=${encodeURIComponent(BRANCH)}&_=${Date.now()}`

  const response =
    await axios.get(url, {
      timeout: 60000,
      responseType: 'arraybuffer',

      headers: {
        'User-Agent':
          'MARY-MD-Updater',
        'Cache-Control':
          'no-cache',
        'Pragma':
          'no-cache'
      }
    })

  await fs.mkdir(
    path.dirname(destination),
    {
      recursive: true
    }
  )

  const temporary =
    `${destination}.marytmp`

  await fs.writeFile(
    temporary,
    response.data
  )

  await fs.rename(
    temporary,
    destination
  )

  return true
}

// ─────────────────────────────────────────────────────────────
// NPM INSTALL
// ─────────────────────────────────────────────────────────────

async function installDependencies() {
  try {

    const {
      exec
    } = await import(
      'child_process'
    )

    const {
      promisify
    } = await import(
      'util'
    )

    const execAsync =
      promisify(exec)

    await execAsync(
      'npm install --omit=dev',
      {
        cwd: ROOT,
        timeout: 180000,
        maxBuffer:
          10 * 1024 * 1024
      }
    )

    return true

  } catch (error) {

    console.error(
      '[MARY UPDATE] npm install:',
      error.message
    )

    return false
  }
}

// ─────────────────────────────────────────────────────────────
// RESTART
// ─────────────────────────────────────────────────────────────

function restartProcess() {
  setTimeout(
    () => {
      process.exit(1)
    },
    1500
  )
}

// ─────────────────────────────────────────────────────────────
// COMMAND DETECTION
// ─────────────────────────────────────────────────────────────

function getCommand(m) {
  let body =
    String(m?.body || '').trim()

  if (!body) {
    return ''
  }

  // Handles:
  // .checkupdate
  // . checkupdate
  // !checkupdate
  // ! checkupdate
  // #update
  // /restart
  // $ update

  body =
    body.replace(
      /^[.!#$\/]+\s*/,
      ''
    )

  return body
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────

const handler = async (
  m,
  { conn }
) => {

  const lang =
    langOf(conn)

  const command =
    getCommand(m)

  // ───────────────────────────────────────────────────────────
  // RESTART
  // ───────────────────────────────────────────────────────────

  if (command === 'restart') {

    await conn.sendMessage(
      m.chat,
      {
        text: t(
          lang,

          '🔄 *Restarting MARY MD...*\n\nPlease wait...',

          '🔄 *Reiniciando MARY MD...*\n\nEspera...'
        )
      },
      {
        quoted: m
      }
    )

    restartProcess()

    return
  }

  // ───────────────────────────────────────────────────────────
  // CHECKUPDATE
  // ───────────────────────────────────────────────────────────

  if (
    command === 'checkupdate' ||
    command === 'checkupdates'
  ) {

    await conn.sendMessage(
      m.chat,
      {
        react: {
          text: '🔎',
          key: m.key
        }
      }
    )

    const status =
      await conn.sendMessage(
        m.chat,
        {
          text: t(
            lang,

            '🔎 *Checking for updates...*',

            '🔎 *Comprobando actualizaciones...*'
          )
        },
        {
          quoted: m
        }
      )

    try {

      const info =
        await checkForUpdate()

      // ─────────────────────────────────────────────
      // NO UPDATE
      // ─────────────────────────────────────────────

      if (!info.available) {

        await conn.sendMessage(
          m.chat,
          {
            text: t(
              lang,

              `✅ *MARY MD is up to date!*\n\n📦 Version: *${info.localVersion}*`,

              `✅ *¡MARY MD está actualizado!*\n\n📦 Versión: *${info.localVersion}*`
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

      // ─────────────────────────────────────────────
      // FETCH LATEST CHANGELOG FROM GITHUB
      // ─────────────────────────────────────────────

      const changelog =
        await getRemoteChangelog()

      let message =
        t(
          lang,

          `🆕 *UPDATE AVAILABLE*\n\n📦 Current version: *${info.localVersion}*\n📦 New version: *${info.remoteVersion}*`,

          `🆕 *ACTUALIZACIÓN DISPONIBLE*\n\n📦 Versión actual: *${info.localVersion}*\n📦 Nueva versión: *${info.remoteVersion}*`
        )

      if (changelog) {

        message +=
          `\n\n📝 *CHANGELOG*\n\n${changelog}`

      } else {

        message +=
          t(
            lang,

            `\n\n📁 *${info.changedFiles.length} file(s) changed.*`,

            `\n\n📁 *${info.changedFiles.length} archivo(s) cambiaron.*`
          )
      }

      message +=
        t(
          lang,

          '\n\nUse *.update* to install the update.',

          '\n\nUsa *.update* para instalar la actualización.'
        )

      await conn.sendMessage(
        m.chat,
        {
          text: message,
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

    } catch (error) {

      console.error(
        '[CHECKUPDATE]',
        error
      )

      await conn.sendMessage(
        m.chat,
        {
          text: t(
            lang,

            `❌ *Update check failed*\n\n${error.message}`,

            `❌ *Error al comprobar actualización*\n\n${error.message}`
          ),

          edit: status.key
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

    return
  }

  // ───────────────────────────────────────────────────────────
  // UPDATE
  // ───────────────────────────────────────────────────────────

  if (command === 'update') {

    if (
      fsSync.existsSync(
        LOCK_FILE
      )
    ) {

      return conn.sendMessage(
        m.chat,
        {
          text: t(
            lang,

            '⚠️ An update is already running.',

            '⚠️ Ya hay una actualización en proceso.'
          )
        },
        {
          quoted: m
        }
      )
    }

    await fs.writeFile(
      LOCK_FILE,
      new Date().toISOString()
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

      const status =
        await conn.sendMessage(
          m.chat,
          {
            text: t(
              lang,

              '⏳ *Checking latest version...*',

              '⏳ *Comprobando la última versión...*'
            )
          },
          {
            quoted: m
          }
        )

      const info =
        await checkForUpdate()

      // ─────────────────────────────────────────────
      // ALREADY UPDATED
      // ─────────────────────────────────────────────

      if (!info.available) {

        await conn.sendMessage(
          m.chat,
          {
            text: t(
              lang,

              `✅ *Already up to date!*\n\n📦 Version: *${info.localVersion}*`,

              `✅ *¡Ya está actualizado!*\n\n📦 Versión: *${info.localVersion}*`
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

      // ─────────────────────────────────────────────
      // UPDATE START
      // ─────────────────────────────────────────────

      await conn.sendMessage(
        m.chat,
        {
          text: t(
            lang,

            `⬇️ *Updating MARY MD...*\n\n📦 ${info.localVersion} → ${info.remoteVersion}\n📁 Updating ${info.changedFiles.length} file(s)...`,

            `⬇️ *Actualizando MARY MD...*\n\n📦 ${info.localVersion} → ${info.remoteVersion}\n📁 Actualizando ${info.changedFiles.length} archivo(s)...`
          ),

          edit: status.key
        }
      )

      const tree =
        await getRemoteTree()

      let downloaded = 0
      let failed = 0

      // ─────────────────────────────────────────────
      // DOWNLOAD ALL REMOTE FILES
      // ─────────────────────────────────────────────

      for (
        const item of tree
      ) {

        const file =
          cleanPath(item.path)

        if (!canUpdate(file)) {
          continue
        }

        try {

          if (
            await downloadFile(file)
          ) {
            downloaded++
          }

        } catch (error) {

          failed++

          console.error(
            `[MARY UPDATE] ${file}:`,
            error.message
          )
        }
      }

      if (failed > 0) {

        throw new Error(
          `${failed} file(s) failed to download.`
        )
      }

      // ─────────────────────────────────────────────
      // NPM INSTALL IF PACKAGE CHANGED
      // ─────────────────────────────────────────────

      const packageChanged =
        info.changedFiles.includes(
          'package.json'
        )

      let dependencyText = ''

      if (packageChanged) {

        await conn.sendMessage(
          m.chat,
          {
            text: t(
              lang,

              '📦 *Installing dependencies...*',

              '📦 *Instalando dependencias...*'
            ),

            edit: status.key
          }
        )

        const npmOK =
          await installDependencies()

        if (npmOK) {

          dependencyText =
            t(
              lang,

              '\n📦 Dependencies installed.',

              '\n📦 Dependencias instaladas.'
            )

        } else {

          dependencyText =
            t(
              lang,

              '\n⚠️ npm install failed. Run `npm install` manually.',

              '\n⚠️ npm install falló. Ejecuta `npm install` manualmente.'
            )
        }
      }

      // ─────────────────────────────────────────────
      // FETCH NEW CHANGELOG
      // ─────────────────────────────────────────────

      const changelog =
        await getRemoteChangelog()

      let finalMessage =
        t(
          lang,

          `✅ *MARY MD UPDATED SUCCESSFULLY!*\n\n📦 Version: *${info.remoteVersion}*\n📁 Files updated: *${downloaded}*${dependencyText}`,

          `✅ *¡MARY MD SE ACTUALIZÓ CORRECTAMENTE!*\n\n📦 Versión: *${info.remoteVersion}*\n📁 Archivos actualizados: *${downloaded}*${dependencyText}`
        )

      if (changelog) {

        finalMessage +=
          `\n\n📝 *CHANGELOG*\n\n${changelog}`
      }

      finalMessage +=
        t(
          lang,

          '\n\n🔄 *Restarting...*',

          '\n\n🔄 *Reiniciando...*'
        )

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

      // IMPORTANT:
      // Session is NOT deleted.
      // sessions/main is never touched.
      restartProcess()

    } catch (error) {

      console.error(
        '[MARY UPDATE]',
        error
      )

      await conn.sendMessage(
        m.chat,
        {
          text: t(
            lang,

            `❌ *UPDATE FAILED*\n\n${error.message}\n\n🔐 Your WhatsApp session was not touched.`,

            `❌ *ACTUALIZACIÓN FALLIDA*\n\n${error.message}\n\n🔐 Tu sesión de WhatsApp no fue modificada.`
          )
        },
        {
          quoted: m
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

    } finally {

      try {
        await fs.unlink(
          LOCK_FILE
        )
      } catch {}

    }

    return
  }
}

// ─────────────────────────────────────────────────────────────
// MENU
// ─────────────────────────────────────────────────────────────

handler.help = [
  'checkupdate',
  'update',
  'restart'
]

handler.tags = [
  'system'
]

handler.command = [
  'checkupdate',
  'checkupdates',
  'update',
  'restart'
]

handler.ownerOnly = true

export default handler
