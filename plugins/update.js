import { msg } from '../lib/lang.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const ROOT      = process.cwd()

// ─── Helpers ──────────────────────────────────────────────────────────────────
const hasGit = () => existsSync(join(ROOT, '.git'))

const run = async (cmd) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: ROOT, timeout: 30000 })
    return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), err: null }
  } catch (e) {
    return { stdout: '', stderr: '', err: e.message }
  }
}

// ─── Read latest section from CHANGELOG.md ────────────────────────────────────
const extractLatestSection = (raw) => {
  if (!raw) return null
  const lines = raw.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) { start = i; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) { end = i; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

// Local CHANGELOG.md
const readLocalChangelog = () => {
  try {
    const raw = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
    return extractLatestSection(raw)
  } catch { return null }
}

// Remote CHANGELOG.md (from fetched ref — not yet pulled)
const readRemoteChangelog = async () => {
  const { stdout, err } = await run('git show @{u}:CHANGELOG.md')
  if (err || !stdout) return null
  return extractLatestSection(stdout)
}

// ─── Handler ─────────────────────────────────────────────────────────────────
const handler = async (m, { command, usedPrefix }) => {

  // ── .checkupdate ─────────────────────────────────────────────────────────────
  if (command === 'checkupdate') {

    if (!hasGit()) return m.reply(msg({
      en: `*『 ❌ 』NO GIT REPO.*\n> This bot is not running from a git repository.`,
      es: `*『 ❌ 』SIN REPOSITORIO GIT.*`
    }))

    await m.react('🔎')

    // Fetch remote silently
    await run('git fetch')

    const local  = (await run('git rev-parse HEAD')).stdout
    const remote = (await run('git rev-parse @{u}')).stdout

    if (!local || !remote) {
      await m.react('❌')
      return m.reply(msg({
        en: `*『 ❌ 』COULD NOT CHECK UPDATES.*\n> Make sure the remote is configured correctly.`,
        es: `*『 ❌ 』NO SE PUDO VERIFICAR.*`
      }))
    }

    if (local === remote) {
      await m.react('✅')
      return m.reply(msg({
        en: `*『 ✅ 』UP TO DATE.*\n> You are on the latest version.`,
        es: `*『 ✅ 』ACTUALIZADO.*\n> Estás en la última versión.`
      }))
    }

    // Get commit count
    const { stdout: log } = await run('git log HEAD..@{u} --oneline')
    const count     = log ? log.split('\n').filter(Boolean).length : 0
    const changelog = await readRemoteChangelog()

    await m.react('🆕')
    return m.reply(msg({
      en: `*『 🔄 』UPDATE AVAILABLE!*\n> *${count}* new commit${count > 1 ? 's' : ''} ahead.\n\n${changelog || '> No changelog found.'}\n\n> Run *${usedPrefix}update* to install.`,
      es: `*『 🔄 』¡ACTUALIZACIÓN DISPONIBLE!*\n> *${count}* commit${count > 1 ? 's' : ''} nuevo${count > 1 ? 's' : ''}.\n\n${changelog || '> Sin changelog.'}\n\n> Ejecuta *${usedPrefix}update* para instalar.`
    }))
  }

  // ── .update ──────────────────────────────────────────────────────────────────
  if (command === 'update') {

    if (!hasGit()) return m.reply(msg({
      en: `*『 ❌ 』NO GIT REPO.*\n> This bot is not running from a git repository.`,
      es: `*『 ❌ 』SIN REPOSITORIO GIT.*`
    }))

    await m.react('⬇️')

    // Check if update available
    await run('git fetch')
    const local  = (await run('git rev-parse HEAD')).stdout
    const remote = (await run('git rev-parse @{u}')).stdout

    if (local === remote) {
      await m.react('✅')
      return m.reply(msg({
        en: `*『 ✅ 』ALREADY UP TO DATE.*`,
        es: `*『 ✅ 』YA ESTÁ ACTUALIZADO.*`
      }))
    }

    await m.reply(msg({
      en: `*『 🔄 』UPDATING...*\n> Pulling latest files from repo...\n> Bot will restart automatically. 👋`,
      es: `*『 🔄 』ACTUALIZANDO...*\n> Descargando últimos archivos...\n> El bot se reiniciará automáticamente. 👋`
    }))

    setTimeout(async () => {
      try {
        await run('git pull')
        await execAsync('npm install --legacy-peer-deps', { cwd: ROOT, stdio: 'inherit' }).catch(() => {})
        console.log('[UPDATE] ✅ Done. Restarting...')
        process.exit(0)
      } catch (e) {
        console.error('[UPDATE] ❌', e.message)
      }
    }, 2000)
  }

  // ── .restart ──────────────────────────────────────────────────────────────────
  if (command === 'restart') {
    await m.reply(msg({
      en: `*『 🔄 』RESTARTING...*\n> See you in a sec! 👋`,
      es: `*『 🔄 』REINICIANDO...*\n> ¡Hasta ahora! 👋`
    }))
    setTimeout(() => process.exit(0), 1500)
  }
}

handler.help = ['checkupdate', 'update', 'restart']
handler.tags = ['owner']
handler.command = ['checkupdate', 'update', 'restart']
handler.ownerOnly = true
export default handler
