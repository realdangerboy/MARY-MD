import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import axios from 'axios'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ═══════════════════════════════════════════════════════════════════════════════
// MARY MD — UPDATE / RESTART SYSTEM
// Repository: https://github.com/realdangerboy/MARY-MD
// Commands:
//   .checkupdate
//   .update
//   .restart
// ═══════════════════════════════════════════════════════════════════════════════

const REPO_OWNER = 'realdangerboy'
const REPO_NAME = 'MARY-MD'
const BRANCH = 'main'

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}`
const ZIP_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${BRANCH}.tar.gz`

const ROOT = process.cwd()
const PACKAGE_FILE = path.join(ROOT, 'package.json')
const CHANGELOG_FILE = path.join(ROOT, 'changelog.json')

const UPDATE_DIR = path.join(ROOT, 'data', 'updater')
const DOWNLOAD_DIR = path.join(UPDATE_DIR, 'download')
const BACKUP_DIR = path.join(UPDATE_DIR, 'backups')

// These directories/files belong to the running installation and must NOT
// be replaced by GitHub files.
const PROTECTED = new Set([
  '.env',
  '.git',
  'node_modules',
  'sessions',
  'data',
  'tmp',
  'logs',
  'backups'
])

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function getLocalVersion() {
  try {
    const pkg = await readJSON(PACKAGE_FILE)
    return pkg.version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

async function getRemotePackage() {
  const url = `${RAW_BASE}/package.json`

  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  if (!response.data || typeof response.data !== 'object') {
    throw new Error('Invalid remote package.json')
  }

  return response.data
}

async function getRemoteChangelog() {
  try {
    const response = await axios.get(`${RAW_BASE}/changelog.json`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'MARY-MD-Updater'
      }
    })

    return response.data
  } catch {
    return null
  }
}

function compareVersions(remote, local) {
  const r = String(remote || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map(x => parseInt(x, 10) || 0)

  const l = String(local || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map(x => parseInt(x, 10) || 0)

  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return 1
    if ((r[i] || 0) < (l[i] || 0)) return -1
  }

  return 0
}

function formatChangelog(changelog) {
  if (!changelog) {
    return '📝 *Changelog:* Not available'
  }

  let output = '📝 *CHANGELOG*\n\n'

  if (changelog.releaseDate) {
    output += `📅 *Release:* ${changelog.releaseDate}\n\n`
  }

  const changes = Array.isArray(changelog.changes)
    ? changelog.changes
    : []

  if (!changes.length) {
    output += '• No detailed changes listed.\n'
    return output
  }

  const icons = {
    new: '✨',
    fix: '🔧',
    improve: '📈',
    improved: '📈',
    security: '🔐',
    deprecated: '⚠️',
    remove: '🗑️',
    breaking: '⚠️'
  }

  for (const change of changes) {
    const type = String(change.type || 'improve').toLowerCase()
    const icon = icons[type] || '•'

    output += `${icon} *${change.title || 'Update'}*\n`

    if (change.description) {
      output += `   ${change.description}\n`
    }

    if (change.category) {
      output += `   _[${change.category}]_\n`
    }

    output += '\n'
  }

  return output.trim()
}

async function send(conn, m, text) {
  return conn.sendMessage(
    m.chat,
    { text },
    { quoted: m }
  )
}

async function getUpdateInfo() {
  const localVersion = await getLocalVersion()
  const remotePackage = await getRemotePackage()
  const remoteVersion = remotePackage.version || '0.0.0'

  const comparison = compareVersions(remoteVersion, localVersion)
  const changelog = await getRemoteChangelog()

  return {
    localVersion,
    remoteVersion,
    changelog,
    updateAvailable: comparison > 0,
    remotePackage
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove directory
// ─────────────────────────────────────────────────────────────────────────────

async function removeDirectory(dir) {
  if (!(await exists(dir))) return

  await fs.rm(dir, {
    recursive: true,
    force: true
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Download GitHub repository
// ─────────────────────────────────────────────────────────────────────────────

async function downloadRepository() {
  await removeDirectory(DOWNLOAD_DIR)
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })

  const archive = path.join(DOWNLOAD_DIR, 'mary-md.tar.gz')

  const response = await axios.get(ZIP_URL, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      'User-Agent': 'MARY-MD-Updater'
    }
  })

  await fs.writeFile(archive, response.data)

  const extractDir = path.join(DOWNLOAD_DIR, 'extract')
  await fs.mkdir(extractDir, { recursive: true })

  // GitHub tarball contains:
  // MARY-MD-main/
  //
  // Extract it into our temporary updater directory.
  await execFileAsync(
    'tar',
    ['-xzf', archive, '-C', extractDir],
    {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    }
  )

  const entries = await fs.readdir(extractDir)

  if (!entries.length) {
    throw new Error('GitHub archive is empty')
  }

  const rootFolder = entries.find(async () => true)

  let sourceRoot = null

  for (const entry of entries) {
    const candidate = path.join(extractDir, entry)

    try {
      const stat = await fs.stat(candidate)

      if (stat.isDirectory()) {
        sourceRoot = candidate
        break
      }
    } catch {}
  }

  if (!sourceRoot) {
    throw new Error('Could not find extracted repository')
  }

  return sourceRoot
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup current installation
// ─────────────────────────────────────────────────────────────────────────────

async function createBackup(version) {
  await fs.mkdir(BACKUP_DIR, { recursive: true })

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')

  const backupPath = path.join(
    BACKUP_DIR,
    `v${version}-${timestamp}`
  )

  await fs.mkdir(backupPath, { recursive: true })

  const entries = await fs.readdir(ROOT, {
    withFileTypes: true
  })

  for (const entry of entries) {
    if (PROTECTED.has(entry.name)) continue
    if (entry.name === 'data') continue

    const source = path.join(ROOT, entry.name)
    const destination = path.join(backupPath, entry.name)

    try {
      await fs.cp(source, destination, {
        recursive: true,
        force: true
      })
    } catch (error) {
      console.warn(
        `[UPDATER] Backup skipped ${entry.name}: ${error.message}`
      )
    }
  }

  await fs.writeFile(
    path.join(backupPath, 'backup-info.json'),
    JSON.stringify(
      {
        version,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  )

  return backupPath
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy repository files into bot
// ─────────────────────────────────────────────────────────────────────────────

async function installRepository(sourceRoot) {
  const entries = await fs.readdir(sourceRoot, {
    withFileTypes: true
  })

  let copied = 0

  for (const entry of entries) {
    const name = entry.name

    // Never overwrite runtime/local data.
    if (PROTECTED.has(name)) continue

    const source = path.join(sourceRoot, name)
    const destination = path.join(ROOT, name)

    await fs.cp(source, destination, {
      recursive: true,
      force: true
    })

    copied++
  }

  return copied
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove files that were deleted from GitHub
//
// This keeps the installation synced with the repository while still
// preserving protected runtime files.
// ─────────────────────────────────────────────────────────────────────────────

async function removeDeletedFiles(sourceRoot) {
  const remoteEntries = new Set(
    await fs.readdir(sourceRoot)
  )

  const localEntries = await fs.readdir(ROOT)

  let removed = 0

  for (const name of localEntries) {
    if (PROTECTED.has(name)) continue

    // updater itself is allowed to be replaced by the repository.
    if (!remoteEntries.has(name)) {
      const target = path.join(ROOT, name)

      try {
        await fs.rm(target, {
          recursive: true,
          force: true
        })

        removed++
      } catch {}
    }
  }

  return removed
}

// ─────────────────────────────────────────────────────────────────────────────
// Install/update npm dependencies
// ─────────────────────────────────────────────────────────────────────────────

async function installDependencies() {
  const packageManager = await detectPackageManager()

  if (!packageManager) {
    return {
      installed: false,
      message: 'No package manager detected'
    }
  }

  try {
    if (packageManager === 'npm') {
      await execFileAsync(
        'npm',
        ['install', '--omit=dev'],
        {
          cwd: ROOT,
          timeout: 600000,
          maxBuffer: 20 * 1024 * 1024
        }
      )

      return {
        installed: true,
        message: 'npm dependencies installed'
      }
    }

    if (packageManager === 'pnpm') {
      await execFileAsync(
        'pnpm',
        ['install', '--prod'],
        {
          cwd: ROOT,
          timeout: 600000,
          maxBuffer: 20 * 1024 * 1024
        }
      )

      return {
        installed: true,
        message: 'pnpm dependencies installed'
      }
    }

    if (packageManager === 'yarn') {
      await execFileAsync(
        'yarn',
        ['install', '--production=true'],
        {
          cwd: ROOT,
          timeout: 600000,
          maxBuffer: 20 * 1024 * 1024
        }
      )

      return {
        installed: true,
        message: 'yarn dependencies installed'
      }
    }
  } catch (error) {
    return {
      installed: false,
      message: error.message
    }
  }

  return {
    installed: false,
    message: 'Dependency installation skipped'
  }
}

async function detectPackageManager() {
  if (await exists(path.join(ROOT, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  if (await exists(path.join(ROOT, 'yarn.lock'))) {
    return 'yarn'
  }

  if (await exists(path.join(ROOT, 'package-lock.json'))) {
    return 'npm'
  }

  if (await exists(PACKAGE_FILE)) {
    return 'npm'
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Clean old backups
// ─────────────────────────────────────────────────────────────────────────────

async function cleanupBackups(keep = 3) {
  if (!(await exists(BACKUP_DIR))) return

  const backups = await fs.readdir(BACKUP_DIR)

  const sorted = backups.sort().reverse()

  for (const old of sorted.slice(keep)) {
    await removeDirectory(
      path.join(BACKUP_DIR, old)
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Restart bot
// ─────────────────────────────────────────────────────────────────────────────

async function restartBot() {
  // Give WhatsApp/socket operations a moment to finish.
  setTimeout(() => {
    process.exit(0)
  }, 1500)
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────

async function performUpdate(conn, m) {
  let backupPath = null

  try {
    await send(
      conn,
      m,
      '⏳ *MARY MD UPDATE*\n\nChecking latest version...'
    )

    const info = await getUpdateInfo()

    if (!info.updateAvailable) {
      return send(
        conn,
        m,
        `✅ *MARY MD IS UP TO DATE*\n\n` +
        `📦 Current version: *${info.localVersion}*\n` +
        `📦 Latest version: *${info.remoteVersion}*`
      )
    }

    await send(
      conn,
      m,
      `🆕 *UPDATE AVAILABLE*\n\n` +
      `📦 Current: *${info.localVersion}*\n` +
      `📦 New: *${info.remoteVersion}*\n\n` +
      `📥 Downloading update...`
    )

    // Download before touching the current installation.
    const sourceRoot = await downloadRepository()

    // Verify package.json from downloaded repository.
    const downloadedPackage = path.join(
      sourceRoot,
      'package.json'
    )

    if (!(await exists(downloadedPackage))) {
      throw new Error(
        'Downloaded repository does not contain package.json'
      )
    }

    const downloadedPkg = await readJSON(downloadedPackage)

    if (
      compareVersions(
        downloadedPkg.version,
        info.remoteVersion
      ) !== 0
    ) {
      throw new Error(
        'Downloaded package version does not match remote version'
      )
    }

    await send(
      conn,
      m,
      `💾 Creating backup of version *${info.localVersion}*...`
    )

    backupPath = await createBackup(
      info.localVersion
    )

    await send(
      conn,
      m,
      `📦 Installing MARY MD *${info.remoteVersion}*...`
    )

    const copied = await installRepository(
      sourceRoot
    )

    await removeDeletedFiles(sourceRoot)

    // Check installed package.
    const installedPackage = await readJSON(
      PACKAGE_FILE
    )

    if (
      compareVersions(
        installedPackage.version,
        info.remoteVersion
      ) !== 0
    ) {
      throw new Error(
        'Update verification failed: package version mismatch'
      )
    }

    let dependencyInfo = null

    // Install dependencies only when package dependencies changed.
    const oldPackagePath = path.join(
      backupPath,
      'package.json'
    )

    if (await exists(oldPackagePath)) {
      const oldPackage = await readJSON(oldPackagePath)

      const oldDeps = JSON.stringify({
        dependencies: oldPackage.dependencies || {},
        devDependencies: oldPackage.devDependencies || {}
      })

      const newDeps = JSON.stringify({
        dependencies: installedPackage.dependencies || {},
        devDependencies: installedPackage.devDependencies || {}
      })

      if (oldDeps !== newDeps) {
        await send(
          conn,
          m,
          '📦 Installing updated dependencies...'
        )

        dependencyInfo = await installDependencies()
      }
    }

    await cleanupBackups(3)

    const dependencyMessage = dependencyInfo
      ? dependencyInfo.installed
        ? '\n📦 Dependencies: Updated'
        : `\n⚠️ Dependencies: ${dependencyInfo.message}`
      : ''

    await send(
      conn,
      m,
      `✅ *UPDATE COMPLETED*\n\n` +
      `📦 Previous: *${info.localVersion}*\n` +
      `🆕 Current: *${info.remoteVersion}*\n` +
      `📁 Files updated: *${copied}*` +
      dependencyMessage +
      `\n\n` +
      `🔄 *Restarting MARY MD...*`
    )

    // Remove temporary downloaded archive.
    await removeDirectory(DOWNLOAD_DIR)

    await restartBot()

    return true
  } catch (error) {
    console.error(
      '[MARY MD UPDATER ERROR]',
      error.stack || error.message
    )

    await removeDirectory(DOWNLOAD_DIR)

    await send(
      conn,
      m,
      `❌ *UPDATE FAILED*\n\n` +
      `⚠️ ${error.message}\n\n` +
      (
        backupPath
          ? '💾 A backup was created before the update.'
          : 'No backup was created.'
      )
    )

    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK UPDATE
// ─────────────────────────────────────────────────────────────────────────────

async function checkUpdate(conn, m) {
  try {
    await send(
      conn,
      m,
      '🔎 *Checking for MARY MD updates...*'
    )

    const info = await getUpdateInfo()

    if (!info.updateAvailable) {
      return send(
        conn,
        m,
        `╭━━━〔 *MARY MD* 〕━━━╮\n` +
        `\n` +
        `✅ *BOT IS UP TO DATE*\n\n` +
        `📦 Current version: *${info.localVersion}*\n` +
        `📦 Latest version: *${info.remoteVersion}*\n` +
        `\n` +
        `╰━━━━━━━━━━━━━━━━━━╯`
      )
    }

    let text =
      `╭━━━〔 *UPDATE AVAILABLE* 〕━━━╮\n` +
      `\n` +
      `📦 Current version: *${info.localVersion}*\n` +
      `🆕 New version: *${info.remoteVersion}*\n\n`

    text += formatChangelog(info.changelog)

    text +=
      `\n\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯\n` +
      `\n` +
      `🚀 Use *.update* to install the update.`

    return send(conn, m, text)
  } catch (error) {
    console.error(
      '[CHECKUPDATE ERROR]',
      error.stack || error.message
    )

    return send(
      conn,
      m,
      `❌ *UPDATE CHECK FAILED*\n\n` +
      `⚠️ ${error.message}`
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTART
// ─────────────────────────────────────────────────────────────────────────────

async function restart(conn, m) {
  try {
    await send(
      conn,
      m,
      `🔄 *MARY MD RESTARTING...*\n\n` +
      `Please wait a few seconds.`
    )

    await restartBot()
  } catch (error) {
    console.error(
      '[RESTART ERROR]',
      error.stack || error.message
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

const handler = async (m, { conn, command }) => {
  const cmd = String(command || '').toLowerCase()

  if (cmd === 'checkupdate') {
    return checkUpdate(conn, m)
  }

  if (cmd === 'update') {
    return performUpdate(conn, m)
  }

  if (cmd === 'restart') {
    return restart(conn, m)
  }
}

// Menu / help
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

// Only owner can use updater/restart commands.
handler.ownerOnly = true

export default handler
