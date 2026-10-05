import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const thirdPartyDir = resolve(projectRoot, 'third_party')
const lvglDir = resolve(thirdPartyDir, 'lvgl')
const versionFile = resolve(lvglDir, '.lvgl-version')

function normalizeVersion(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed || trimmed === 'latest') {
    return 'latest'
  }

  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

function getRequestedVersion() {
  const args = process.argv.slice(2)
  const versionIndex = args.findIndex((arg) => arg === '--version' || arg === '-v')

  if (versionIndex >= 0) {
    const value = args[versionIndex + 1]
    if (value) return normalizeVersion(value)
  }

  return normalizeVersion(process.env.LVGL_VERSION ?? 'latest')
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'esp-home-visualizer'
    }
  })

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

async function resolveVersion(requestedVersion) {
  if (requestedVersion !== 'latest') {
    return normalizeVersion(requestedVersion)
  }

  const release = await fetchJson('https://api.github.com/repos/lvgl/lvgl/releases/latest')
  const tagName = release?.tag_name || release?.name

  if (!tagName) {
    throw new Error('Could not resolve the latest LVGL release from GitHub.')
  }

  return normalizeVersion(tagName)
}

async function ensureArchiveDir() {
  mkdirSync(thirdPartyDir, { recursive: true })
}

function normalizeThirdPartyLayout() {
  if (!existsSync(thirdPartyDir)) {
    return
  }

  if (!existsSync(lvglDir)) {
    const rootEntries = readdirSync(thirdPartyDir).filter((entry) => entry !== 'lvgl')
    const lookLikeLvglRoot = rootEntries.some((entry) => entry.includes('CMake') || entry === 'src' || entry === 'docs' || entry === 'lvgl')

    if (lookLikeLvglRoot) {
      mkdirSync(lvglDir, { recursive: true })
      for (const entry of rootEntries) {
        const source = resolve(thirdPartyDir, entry)
        const target = resolve(lvglDir, entry)
        if (existsSync(source) && !existsSync(target)) {
          renameSync(source, target)
        }
      }
    }
    return
  }

  const rootEntries = readdirSync(thirdPartyDir).filter((entry) => entry !== 'lvgl')
  for (const entry of rootEntries) {
    rmSync(resolve(thirdPartyDir, entry), { recursive: true, force: true })
  }
}

function removeStaleArchiveFiles() {
  if (!existsSync(thirdPartyDir)) {
    return
  }

  for (const entry of readdirSync(thirdPartyDir)) {
    if (entry.endsWith('.tar.gz')) {
      rmSync(resolve(thirdPartyDir, entry), { force: true })
    }
  }
}

function readInstalledVersion() {
  if (!existsSync(versionFile)) {
    return null
  }

  return readFileSync(versionFile, 'utf8').trim()
}

async function downloadVersion(version) {
  const archiveUrl = `https://github.com/lvgl/lvgl/archive/refs/tags/${version}.tar.gz`
  const archiveName = `${version.replace(/[^a-zA-Z0-9._-]/g, '_')}.tar.gz`
  const archivePath = resolve(thirdPartyDir, archiveName)

  const response = await fetch(archiveUrl)
  if (!response.ok) {
    throw new Error(`Could not download ${archiveUrl}: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  writeFileSync(archivePath, Buffer.from(arrayBuffer))

  return archivePath
}

function extractArchive(archivePath) {
  if (existsSync(lvglDir)) {
    rmSync(lvglDir, { recursive: true, force: true })
  }

  mkdirSync(lvglDir, { recursive: true })

  execFileSync('tar', ['-xzf', archivePath, '-C', lvglDir, '--strip-components=1'], {
    stdio: 'inherit'
  })
  rmSync(archivePath, { force: true })

  if (!existsSync(resolve(lvglDir, 'CMakeLists.txt'))) {
    throw new Error(`LVGL extraction did not produce the expected CMake project in ${lvglDir}.`)
  }
}

async function main() {
  try {
    const requestedVersion = getRequestedVersion()
    const targetVersion = await resolveVersion(requestedVersion)

    await ensureArchiveDir()
    normalizeThirdPartyLayout()
    removeStaleArchiveFiles()

    const installedVersion = readInstalledVersion()
    const shouldUpdate = !existsSync(lvglDir)
      || !existsSync(resolve(lvglDir, 'CMakeLists.txt'))
      || installedVersion !== targetVersion

    if (!shouldUpdate) {
      console.log(`LVGL ${targetVersion} is already installed in ${lvglDir}.`)
      return
    }

    console.log(`Bootstrapping LVGL ${targetVersion} into ${lvglDir}...`)
    const archivePath = await downloadVersion(targetVersion)
    extractArchive(archivePath)
    writeFileSync(versionFile, targetVersion, 'utf8')
    console.log(`LVGL ${targetVersion} is ready in ${lvglDir}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`LVGL bootstrap failed: ${message}`)
    process.exitCode = 1
  }
}

await main()
