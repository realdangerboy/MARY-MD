import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'
import config from './config.js'
import GroupDb from './lib/database/GroupDb.js'
import BotDb from './lib/database/BotDb.js'
import { spamCache, warnCache, groupCache, groupDbCache, msgRetryCache } from './lib/caches.js'
import { serializeMsg } from './lib/serializer.js'
import { T } from './lib/i18n.js'

const execFileAsync = promisify(execFile)

export const plugins = {}
const cmdMap       = new Map()
const regexCmds    = []
const watchDebounce = new Map()
const PLUGINS_DIR  = path.resolve('./plugins')

// ─── Startup: ensure runtime folders exist ───────────────────────────────────
//
// A fresh deploy (cloned or downloaded from GitHub) never has these
// folders — they only get created the first time the bot writes to
// them. Creating them explicitly at startup means they always exist
// from the very first run, without needing any command.
// ─────────────────────────────────────────────────────────────────────────────

const RUNTIME_DIRS = ['sessions', 'data', 'tmp']

function ensureRuntimeDirs() {
  for (const dir of RUNTIME_DIRS) {
    const full = path.resolve(`./${dir}`)
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true })
  }
}

// ─── Startup: ensure .git repo exists ────────────────────────────────────────
//
// If the bot was deployed by extracting a downloaded archive (zip/tar.gz)
// instead of `git clone`, there is no .git folder at all — `git status`,
// `git pull`, `git log` etc. won't work. This creates one pointing at the
// bot's own repo, without touching any tracked files (git init never
// modifies the working directory), so it's safe to run on every boot.
// Runs in the background — it never blocks or delays startup.
// ─────────────────────────────────────────────────────────────────────────────

const GIT_REMOTE_URL = 'https://github.com/realdangerboy/MARY-MD.git'
const GIT_BRANCH     = 'main'

async function ensureGitRepo() {
  const gitDir = path.resolve('./.git')
  if (fs.existsSync(gitDir)) return

  try {
    await execFileAsync('git', ['--version'], { timeout: 10000 })
  } catch {
    // git not installed on this host — skip silently, bot works fine without it
    return
  }

  try {
    await execFileAsync('git', ['init'], { cwd: process.cwd(), timeout: 30000 })
    await execFileAsync('git', ['remote', 'add', 'origin', GIT_REMOTE_URL], { cwd: process.cwd(), timeout: 30000 }).catch(() => {})
    await execFileAsync('git', ['branch', '-M', GIT_BRANCH], { cwd: process.cwd(), timeout: 30000 }).catch(() => {})
  } catch (e) {
    console.error(chalk.red('[GIT INIT ERROR]'), e.stderr || e.message)
  }
}

ensureRuntimeDirs()
ensureGitRepo()

// ─── Index ───────────────────────────────────────────────────────────────────
function rebuildIndex() {
  cmdMap.clear()
  regexCmds.length = 0
  for (const plugin of Object.values(plugins)) {
    if (!plugin?.command) continue
    if (plugin.command instanceof RegExp) {
      regexCmds.push({ regex: plugin.command, plugin })
    } else {
      const cmds = Array.isArray(plugin.command) ? plugin.command : [plugin.command]
      cmds.forEach(c => cmdMap.set(c, plugin))
    }
  }
}

// ─── Plugin Loader ───────────────────────────────────────────────────────────
function getFilesRecursively(dir) {
  let results = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) results = results.concat(getFilesRecursively(full))
    else if (item.isFile() && item.name.endsWith('.js')) results.push(full)
  }
  return results
}

export async function loadPlugin(relPath, silent = false) {
  try {
    const full = path.join(PLUGINS_DIR, relPath)
    if (!fs.existsSync(full)) { delete plugins[relPath]; rebuildIndex(); return }
    const url = pathToFileURL(full).href + `?v=${Date.now()}`
    const mod  = await import(url)
    const plugin = mod.default ?? mod

    if (plugin && (plugin.command || plugin.all || plugin.before || plugin.onButton || mod.onButton || typeof plugin === 'function')) {
      if (mod.onParticipant) plugin.onParticipant = mod.onParticipant
      // A plugin can export `onButton(m, ctx)` either as a named export
      // or directly on the default object. It gets called for every
      // interactive button/list response before normal command
      // resolution runs — see the `isButton` branch in handler().
      // It must return `true` if it handled the button, so the
      // dispatcher knows not to fall through to command resolution.
      if (mod.onButton) plugin.onButton = mod.onButton
      plugins[relPath] = plugin
      rebuildIndex()
      if (!silent) console.log(chalk.bold.cyanBright(T().pluginLoaded(relPath)))
    } else {
      delete plugins[relPath]; rebuildIndex()
    }
  } catch (e) {
    console.error(chalk.bold.bgRed.white(` [PLUGIN ERROR] ${relPath} `), chalk.bold.redBright(e.stack || e.message))
  }
}

export async function loadPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })
  const files = getFilesRecursively(PLUGINS_DIR)
  console.log(chalk.bold.blueBright(T().pluginsLoading(files.length)))
  for (const full of files) {
    const rel = path.relative(PLUGINS_DIR, full).replace(/\\/g, '/')
    await loadPlugin(rel, true)
  }
  console.log(chalk.bold.greenBright(T().pluginsReady))
}

export function setupWatchers(conn) {
  const watcher = fs.watch(PLUGINS_DIR, { recursive: true }, async (event, filename) => {
    if (!filename?.endsWith('.js')) return
    const rel = filename.replace(/\\/g, '/')
    if (watchDebounce.has(rel)) clearTimeout(watchDebounce.get(rel))
    watchDebounce.set(rel, setTimeout(async () => {
      watchDebounce.delete(rel)
      await loadPlugin(rel)
    }, 300))
  })
  process.on('SIGINT', () => { watcher.close(); process.exit(0) })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const normNum = n => {
  n = String(n || '').replace(/\D/g, '')
  if (n.startsWith('549')) n = '54' + n.slice(3)
  if (n.startsWith('521')) n = '52' + n.slice(3)
  return n
}
const extractNum = jid => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const jidNorm    = jid => (jid || '').replace(/:\d+@/, '@').trim()

function isAdmin(participants, jid) {
  if (!jid || !participants?.length) return false
  const clean = jidNorm(jid)
  return participants.some(p => {
    // Participants can be @lid objects — check phoneNumber (@s.whatsapp.net) first
    const pPhone = typeof p === 'object' ? p.phoneNumber : null
    const pId    = typeof p === 'object' ? p.id : p
    const pLid   = typeof p === 'object' ? p.lid : null
    const matched = (pPhone && jidNorm(pPhone) === clean)
                 || jidNorm(pId) === clean
                 || (pLid  && jidNorm(pLid)   === clean)
    return matched && (p.admin === 'admin' || p.admin === 'superadmin' || p.isCommunityAdmin)
  })
}

// ─── Anti-Spam ────────────────────────────────────────────────────────────────
const spamMap = new Map()
function checkSpam(jid) {
  if (!config.antiSpam?.enabled) return false
  const { maxCmds, windowMs, muteMs } = config.antiSpam
  const now = Date.now()
  let e = spamMap.get(jid) || { count: 0, first: now, muted: false, muteUntil: 0 }
  if (e.muted) {
    if (now < e.muteUntil) return true
    e = { count: 0, first: now, muted: false, muteUntil: 0 }
  }
  if (now - e.first > windowMs) e = { count: 1, first: now, muted: false, muteUntil: 0 }
  else e.count++
  if (e.count > maxCmds) { e.muted = true; e.muteUntil = now + muteMs }
  spamMap.set(jid, e)
  return e.muted
}

// ─── Owner Detection ─────────────────────────────────────────────────────────
function getOwners(botNum) {
  // Config owners
  const configOwners = (Array.isArray(config.ownerNumber) ? config.ownerNumber : [config.ownerNumber])
    .filter(Boolean)
    .map(o => normNum(extractNum(o)))

  // DB owner (auto-detected)
  const dbOwner = BotDb.getOwner()
  if (dbOwner) configOwners.push(normNum(dbOwner))

  // Bot's own number is always owner
  if (botNum) configOwners.push(normNum(botNum))

  return [...new Set(configOwners)]
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
export async function handler(conn, m) {
  m = serializeMsg(conn, m)
  if (!m?.mtype) return

  const botNum    = conn.user?.id?.split('@')[0]?.split(':')[0]
  const numSender = normNum(extractNum(m.sender))
  const owners    = getOwners(botNum)
  const isOwner   = owners.includes(numSender)

  // Detect interactive button responses
  const isButton = !!(
    m.message?.buttonsResponseMessage?.selectedButtonId ||
    m.message?.templateButtonReplyMessage?.selectedId ||
    m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    m.responseId
  )

  const prefixMatch = m.body.match(config.prefix)
  const isCmd       = !!prefixMatch && m.body.indexOf(prefixMatch[0]) === 0

  // ─── Group context ───────────────────────────────────────────────────────
  let userIsAdmin = false, botIsAdmin = false, participants = [], groupMeta = null, groupDb = null

  if (m.isGroup) {
    groupMeta = groupCache.get(m.chat)
    if (!groupMeta?.participants) {
      groupMeta = await conn.groupMetadata(m.chat).catch(() => null) || {}
      if (groupMeta.id) groupCache.set(m.chat, groupMeta)
    }
    participants = groupMeta.participants || []
    userIsAdmin  = isAdmin(participants, m.sender) || isAdmin(participants, m.author)
    const botIds = [conn.user?.id, conn.user?.lid].filter(Boolean)
    botIsAdmin   = botIds.some(id => isAdmin(participants, id))

    groupDb = groupDbCache.get(m.chat)
    if (!groupDb) {
      groupDb = await GroupDb.findOrCreate(m.chat)
      groupDbCache.set(m.chat, groupDb)
    }
  }

  m.isOwner    = isOwner
  m.isAdmin    = userIsAdmin
  m.isBotAdmin = botIsAdmin

  const prefix = isCmd ? prefixMatch[0] : ''

  // Extract whichever id/selection the button type carries, so plugins
  // don't each have to know about every WhatsApp button message shape.
  const buttonId =
    m.message?.buttonsResponseMessage?.selectedButtonId ||
    m.message?.templateButtonReplyMessage?.selectedId ||
    m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.responseId ||
    null

  const ctx = {
    conn, args: [], text: '', command: '', usedPrefix: prefix,
    participants, groupMetadata: groupMeta, groupDb,
    isOwner, isAdmin: userIsAdmin, isBotAdmin: botIsAdmin,
    config, buttonId
  }

  const autoReadDb = BotDb.getAutoRead()
  const autoRead   = autoReadDb === null || autoReadDb === undefined ? config.autoRead : autoReadDb
  if (autoRead) conn.readMessages([m.key]).catch(() => {})

  // ─── Run .all + alwaysBefore for ALL messages (including plain replies) ──
  for (const [name, plug] of Object.entries(plugins)) {
    if (typeof plug.all === 'function') {
      try { await plug.all.call(conn, m, ctx) } catch (e) { console.error(chalk.red(`[ALL:${name}]`), e.message) }
    }
    if (typeof plug.before === 'function' && plug.alwaysBefore) {
      try { await plug.before(m, ctx) } catch (e) { console.error(chalk.red(`[BEFORE:${name}]`), e.message) }
    }
  }

  // ─── Stop here if not a command or button ────────────────────────────────
  if (m.fromMe && !isCmd && !isButton) return
  if (!isCmd && !isButton) return

  // ─── Interactive button dispatch ──────────────────────────────────────────
  //
  // Buttons don't map to a command name, so they never go through the
  // cmdMap/regexCmds resolution below. Instead, every loaded plugin that
  // exports `onButton(m, ctx)` gets a chance to claim the button (by
  // returning a truthy value). The first plugin to claim it stops the
  // dispatch — this lets any plugin add interactive buttons without
  // touching this file again.
  // ───────────────────────────────────────────────────────────────────────
  if (isButton) {
    for (const [name, plug] of Object.entries(plugins)) {
      if (typeof plug.onButton !== 'function') continue
      try {
        const handled = await plug.onButton(m, ctx)
        if (handled) return
      } catch (e) {
        console.error(chalk.bold.bgRed.white(` [BUTTON ERROR] ${name} `), chalk.bold.redBright(e.stack || e.message))
        return
      }
    }
    // No plugin claimed this button and it isn't also a command — nothing to do.
    if (!isCmd) return
  }

  // ─── OnlyAdmin mode ──────────────────────────────────────────────────────
  if (m.isGroup && groupDb) {
    const rawCmd = isCmd ? m.body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : ''
    const bypass = ['onlyadmin', 'adminonly'].includes(rawCmd)
    if (!bypass && groupDb.onlyadmin && !userIsAdmin && !isOwner) return
  }

  // ─── Resolve command ─────────────────────────────────────────────────────
  const bodyWithoutPrefix = isCmd ? m.body.slice(prefix.length).trim() : m.body.trim()
  let [cmd, ...args] = bodyWithoutPrefix.split(/\s+/)
  cmd = (cmd || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  let plugin = cmdMap.get(cmd)
  if (!plugin) {
    const rx = regexCmds.find(c => c.regex.test(cmd))
    if (rx) plugin = rx.plugin
  }
  if (!plugin) return

  const userTag = numSender

  // ─── Anti-spam ───────────────────────────────────────────────────────────
  if (!isOwner && checkSpam(m.sender)) {
    if (!warnCache.has(m.sender)) {
      warnCache.set(m.sender, true)
      await m.reply(T().spam(userTag))
    }
    return
  }

  // ─── Private mode ────────────────────────────────────────────────────────
  if (config.MODE === 'private' && !isOwner) return

  // ─── Disabled commands/categories ────────────────────────────────────────
  if (m.isGroup && groupDb && !isOwner && !userIsAdmin) {
    const tag = (Array.isArray(plugin.tags) ? plugin.tags[0] : (plugin.tags || 'otros')).toLowerCase()
    if (groupDb.disabledCategories?.includes(tag) || groupDb.disabledCmds?.includes(cmd)) {
      return m.reply(T().blocked)
    }
  }

  // ─── Re-fetch admin status if needed ─────────────────────────────────────
  if (m.isGroup && (plugin.adminOnly || plugin.botAdminOnly)) {
    const fresh = await conn.groupMetadata(m.chat).catch(() => null)
    if (fresh?.participants) {
      groupCache.set(m.chat, fresh)
      participants = fresh.participants
      if (plugin.adminOnly && !isOwner) userIsAdmin = isAdmin(participants, m.sender) || isAdmin(participants, m.author)
      if (plugin.botAdminOnly) {
        const botIds = [conn.user?.id, conn.user?.lid].filter(Boolean)
        botIsAdmin = botIds.some(id => isAdmin(participants, id))
      }
    }
  }

  // ─── Permission gates ─────────────────────────────────────────────────────
  if (plugin.ownerOnly  && !isOwner)                return conn.sendMessage(m.chat, { text: T().ownerOnly(userTag),   mentions: [m.sender] }, { quoted: m })
  if (plugin.groupOnly  && !m.isGroup)              return conn.sendMessage(m.chat, { text: T().groupOnly(userTag),   mentions: [m.sender] }, { quoted: m })
  if (plugin.adminOnly  && !userIsAdmin && !isOwner) return conn.sendMessage(m.chat, { text: T().adminOnly(userTag),   mentions: [m.sender] }, { quoted: m })
  if (plugin.botAdminOnly && !botIsAdmin)            return conn.sendMessage(m.chat, { text: T().botNoPerms(userTag),  mentions: [m.sender] }, { quoted: m })

  // ─── Console log ─────────────────────────────────────────────────────────
  const time    = new Date().toLocaleTimeString('en', { hour12: false })
  const chat    = m.isGroup ? `👥 ${groupMeta?.subject || m.chat}` : `👤 ${m.chat.split('@')[0]}`
  const ownerBadge = isOwner ? chalk.bold.redBright(' [👑 OWNER]') : ''
  console.log(`\n${chalk.bold.magentaBright('╭━━━')} ${chalk.bold.cyanBright(time)} ${chalk.bold.magentaBright('━━━')}`)
  console.log(`${chalk.bold.magentaBright('┃')} ${chalk.bold.white('💬')} ${chalk.bold.cyanBright(chat)}`)
  console.log(`${chalk.bold.magentaBright('┃')} ${chalk.bold.white('👤')} ${chalk.bold.yellowBright(m.pushName)} ${chalk.green(`(+${numSender})`)}${ownerBadge}`)
  console.log(`${chalk.bold.magentaBright('┃')} ${chalk.bold.white('🚀')} ${chalk.bold.whiteBright(m.body.substring(0, 60))}`)
  console.log(`${chalk.bold.magentaBright('╰━━━━━━━━━━━━━━━━━━━━━━━━━ ✧')}\n`)

  ctx.args    = args
  ctx.text    = args.join(' ')
  ctx.command = cmd

  // ─── Execute ─────────────────────────────────────────────────────────────
  try {
    if (typeof plugin.before === 'function' && !plugin.alwaysBefore) {
      if (await plugin.before(m, ctx)) return
    }
    if (typeof plugin === 'function') {
      await plugin(m, ctx)
    } else if (typeof plugin.execute === 'function') {
      await plugin.execute(m, ctx)
    }
    if (typeof plugin.after === 'function') await plugin.after(m, ctx)
  } catch (e) {
    console.error(chalk.bold.bgRed.white(` [ERROR: ${cmd}] `), chalk.bold.redBright(e.stack || e.message))
    await m.reply(T().unknownError).catch(() => {})
  }
}
