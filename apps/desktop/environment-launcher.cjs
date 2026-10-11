'use strict'
const { execFile } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, unlink, writeFile } = require('node:fs/promises')
const { dirname, posix } = require('node:path')
const { EventEmitter } = require('node:events')
const { createInterface } = require('node:readline')

const PREFIX = 'HYDRA_DESKTOP_BRIDGE:'
const native = () => ({ value: 'native' })
const quote = value => "'" + value.replace(/'/gu, "'\\''") + "'"
const runCommand = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
    if (error) reject(new Error('Node or a compatible Hydra installation is unavailable in this WSL distro', { cause: error }))
    else resolve(stdout.includes(0) ? stdout.toString('utf16le').replace(/^\uFEFF/u, '') : stdout.toString('utf8'))
  })
})
const probeCode = `const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const binary=fs.realpathSync(process.argv[1]); const req=createRequire(binary); const bridge=req.resolve('@hydraharness/harness-native-command/desktop-bridge');
import(require('node:url').pathToFileURL(bridge).href).then(module=>{if(module.DESKTOP_BRIDGE_VERSION!==1)throw Error('incompatible bridge');
console.log('HYDRA_PREFLIGHT:'+JSON.stringify({node:process.execPath,nodeVersion:process.versions.node,entry:binary,home:require('node:os').homedir()+'/.hydra/desktop-host',bridgeVersion:module.DESKTOP_BRIDGE_VERSION}));});`
const bootstrapCode = `const readline=require('node:readline');const input=readline.createInterface({input:process.stdin});input.once('line',line=>{input.close();
const spec=JSON.parse(line);if(typeof spec.entry!=='string'||!spec.entry.startsWith('/')||typeof spec.home!=='string'||!spec.home.startsWith('/')||!/^[a-f0-9]{64}$/.test(spec.token))throw Error('Invalid Desktop launch');
process.env.HYDRA_HOME=spec.home;process.env.HYDRA_DESKTOP_BROWSER_BRIDGE='stdio';process.env.HYDRA_DESKTOP_BRIDGE_TOKEN=spec.token;
process.argv=[process.execPath,spec.entry,'web','--no-open','--host','127.0.0.1','--port','0'];import(require('node:url').pathToFileURL(spec.entry).href).catch(error=>{console.error(error.message);process.exit(1)});});`

/** Electron owns launcher choice; each Host retains its own Hydra home. */
function createEnvironmentLauncher({ storePath, platform = process.platform, run = runCommand }) {
  let record = { active: native(), requested: native(), clean: true }
  let active = native()
  let catalog = []
  let tail = Promise.resolve()
  function choice(value) {
    if (!value || typeof value !== 'object' || typeof value.value !== 'string') throw new Error('Invalid saved agent environment')
    if (value.value === 'native') return native()
    const distro = value.value.slice(4)
    if (!value.value.startsWith('wsl:') || !/^[^\0\r\n\\/:]{1,128}$/u.test(distro)) throw new Error('Invalid saved WSL distro')
    for (const field of ['node', 'entry', 'home']) if (typeof value[field] !== 'string' || !value[field].startsWith('/') || value[field].includes('\0') || posix.normalize(value[field]) !== value[field]) throw new Error('Invalid saved WSL runtime path')
    return { value: value.value, distro, node: value.node, entry: value.entry, home: value.home }
  }
  async function persist(next) {
    await mkdir(dirname(storePath), { recursive: true })
    const temporary = `${storePath}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 }); await rename(temporary, storePath) }
    catch (error) { await unlink(temporary).catch(() => {}); throw error }
    record = next
  }
  async function initialize() {
    let raw
    try { raw = await readFile(storePath, 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (raw !== undefined) {
      const value = JSON.parse(raw)
      if (typeof value.clean !== 'boolean') throw new Error('Invalid environment shutdown state')
      record = { active: choice(value.active), requested: choice(value.requested), clean: value.clean }
    }
    active = record.clean ? record.requested : record.active
    if (active.value !== 'native' && platform !== 'win32') throw new Error('The saved WSL environment requires Windows')
    if (active.value !== 'native') active = await probe(active.distro)
    await persist({ ...record, active, clean: false })
    return { ...active }
  }
  async function probe(distro) {
    if (!/^[^\0\r\n\\/:]{1,128}$/u.test(distro)) throw new Error('Invalid WSL distro')
    const output = await run('wsl.exe', ['--distribution', distro, '--exec', 'sh', '-lc', `node -e ${quote(probeCode)} "$(command -v hydra)"`])
    const line = output.split(/\r?\n/u).find(value => value.startsWith('HYDRA_PREFLIGHT:'))
    if (line === undefined) throw new Error('This distro needs Node and a Hydra artifact with Desktop bridge version 1')
    const details = JSON.parse(line.slice('HYDRA_PREFLIGHT:'.length))
    const [major, minor] = String(details.nodeVersion).split('.').map(Number)
    if (!(major >= 24 || (major === 22 && minor >= 19)) || details.bridgeVersion !== 1) throw new Error('WSL requires Node 22.19 or 24+, and Desktop bridge version 1')
    return choice({ value: `wsl:${distro}`, ...details })
  }
  async function status() {
    catalog = [{ value: 'native', label: 'Native', ready: true }]
    if (platform === 'win32') {
      let output
      try { output = await run('wsl.exe', ['--list', '--quiet']) }
      catch { return { active: active.value, selected: record.requested.value, choices: catalog, reason: 'WSL is unavailable on this machine' } }
      const distros = output.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
      catalog.push(...await Promise.all(distros.map(async distro => {
        try { await probe(distro); return { value: `wsl:${distro}`, label: `WSL · ${distro}`, ready: true } }
        catch (error) { return { value: `wsl:${distro}`, label: `WSL · ${distro}`, ready: false, reason: error.message } }
      })))
    }
    return { active: active.value, selected: record.requested.value, choices: catalog }
  }
  function select(value) {
    const write = tail.then(async () => {
      if (typeof value !== 'string') throw new Error('Invalid agent environment')
      const requested = value === 'native' ? native() : platform === 'win32' && value.startsWith('wsl:') ? await probe(value.slice(4)) : undefined
      if (requested === undefined) throw new Error('Agent environment is unavailable')
      await persist({ ...record, requested })
      return { active: active.value, selected: requested.value, choices: catalog }
    })
    tail = write.catch(() => {})
    return write
  }
  return { initialize, status, select, active: () => ({ ...active }),
    cleanShutdown: () => { const write = tail.then(() => persist({ ...record, clean: true })); tail = write.catch(() => {}); return write },
    nativePath(path) {
      if (active.value === 'native') return path
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || posix.normalize(path) !== path) throw new Error('Invalid Linux filesystem path')
      return `\\\\wsl.localhost\\${active.distro}${path.replace(/\//gu, '\\')}`
    },
    async hostPath(path) {
      if (active.value === 'native') return path
      for (const server of ['wsl.localhost', 'wsl$']) {
        const prefix = `\\\\${server}\\${active.distro}\\`
        if (path.toLowerCase().startsWith(prefix.toLowerCase())) return '/' + path.slice(prefix.length).replace(/\\/gu, '/')
      }
      return (await run('wsl.exe', ['--distribution', active.distro, '--exec', 'wslpath', '-a', '-u', path])).trim()
    },
  }
}

/** Adapt only this owned WSL child's pipes to Electron's utility-process message interface. */
function launchWslHost(selection, spawn, onLine) {
  const token = randomBytes(32).toString('hex')
  const child = spawn('wsl.exe', ['--distribution', selection.distro, '--exec', selection.node, '--expose-internals', '-e', bootstrapCode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = new EventEmitter()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (!line.startsWith(PREFIX)) { onLine(line); return }
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) return
    let frame
    try { frame = JSON.parse(line.slice(PREFIX.length)) } catch { return }
    if (frame?.token === token && typeof frame.message === 'object' && frame.message !== null) messages.emit('message', frame.message)
  })
  child.stdin.write(JSON.stringify({ entry: selection.entry, home: selection.home, token }) + '\n')
  child.postMessage = message => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ token, message }) + '\n') }
  const originalOn = child.on.bind(child)
  child.on = (event, listener) => { if (event === 'message') messages.on(event, listener); else originalOn(event, listener); return child }
  return child
}
module.exports = { createEnvironmentLauncher, launchWslHost }
