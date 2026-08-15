import { msg } from '../lib/lang.js'
import { exec } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

const handler = async (m, { command }) => {
  if (command === 'checkupdate') {
    await m.react('⏳')
    try {
      const { stdout } = await execAsync('git fetch && git status')
      const hasUpdate = stdout.includes('behind')
      if (hasUpdate) {
        m.reply(msg({ en: `*『 ✅ 』UPDATE AVAILABLE.*\n> Run *.update* to install.`, es: `*『 ✅ 』ACTUALIZACIÓN DISPONIBLE.*\n> Ejecutá *.update* para instalar.` }))
      } else {
        m.reply(msg({ en: `*『 ✅ 』UP TO DATE.*\n> Bot is already on the latest version.`, es: `*『 ✅ 』ACTUALIZADO.*\n> El bot ya está en la última versión.` }))
      }
      await m.react('✅')
    } catch {
      await m.react('❌')
      m.reply(msg({ en: `*『 ❌ 』ERROR.*\n> Could not check for updates. Is git configured?`, es: `*『 ❌ 』ERROR.*\n> No se pudo verificar actualizaciones.` }))
    }
    return
  }
  await m.react('⏳')
  try {
    await execAsync('git pull origin main')
    await execAsync('npm install')
    m.reply(msg({ en: `*『 ✅ 』UPDATED.*\n> Restart the bot to apply changes.`, es: `*『 ✅ 』ACTUALIZADO.*\n> Reiniciá el bot para aplicar los cambios.` }))
    await m.react('✅')
    setTimeout(() => process.exit(0), 3000)
  } catch {
    await m.react('❌')
    m.reply(msg({ en: `*『 ❌ 』ERROR.*\n> Could not install update.`, es: `*『 ❌ 』ERROR.*\n> No se pudo instalar la actualización.` }))
  }
}
handler.help = ['checkupdate', 'update']
handler.tags = ['admin']
handler.command = ['checkupdate', 'update']
handler.ownerOnly = true
export default handler
