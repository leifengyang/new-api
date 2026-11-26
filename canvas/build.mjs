// Copyright (C) 2023-2026 QuantumNous
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const canvasDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryDir = path.dirname(canvasDir)
const upstream = JSON.parse(await readFile(path.join(canvasDir, 'upstream.json'), 'utf8'))
const cacheDir = path.join(repositoryDir, '.cache', 'infinite-canvas')
const sourceDir = path.join(cacheDir, upstream.commit)
const archivePath = path.join(cacheDir, `${upstream.commit}.tar.gz`)
const lockPath = path.join(canvasDir, 'bun.lock')
const prepareOnly = process.argv.includes('--prepare')
const updateLock = process.argv.includes('--update-lock')

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

await mkdir(cacheDir, { recursive: true })
let archive
try {
  archive = await readFile(archivePath)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  const response = await fetch(`https://codeload.github.com/basketikun/infinite-canvas/tar.gz/${upstream.commit}`)
  if (!response.ok) throw new Error(`Cannot download infinite-canvas: HTTP ${response.status}`)
  archive = Buffer.from(await response.arrayBuffer())
}
if (createHash('sha256').update(archive).digest('hex') !== upstream.archiveSha256) {
  throw new Error('infinite-canvas source archive checksum mismatch')
}
await writeFile(archivePath, archive)
await mkdir(sourceDir, { recursive: true })
// Extract the verified source on every invocation; never build from stale patched sources.
run('tar', ['-xzf', archivePath, '--strip-components=1', '-C', sourceDir], repositoryDir)
const manifestPath = path.join(sourceDir, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.workspaces = [
  'apps/web',
  'packages/workbench',
  'packages/shared',
  'packages/model-runtime',
  'packages/plugin-sdk',
]
delete manifest.packageManager
// Only the browser workspace is shipped. CLI, Electron and documentation dependencies are excluded.
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await rm(path.join(sourceDir, 'pnpm-workspace.yaml'))
await rm(path.join(sourceDir, 'pnpm-lock.yaml'))
if (!updateLock) await cp(lockPath, path.join(sourceDir, 'bun.lock'))
const bun = process.versions.bun ? process.execPath : 'bun'
run(bun, ['install', '--ignore-scripts', ...(updateLock ? [] : ['--frozen-lockfile'])], sourceDir)
if (updateLock) await cp(path.join(sourceDir, 'bun.lock'), lockPath)
if (prepareOnly) process.exit(0)

await cp(path.join(canvasDir, 'overlay'), path.join(sourceDir, 'apps/web/src/newapi'), { recursive: true })
const patches = JSON.parse(await readFile(path.join(canvasDir, 'overlay/patches.json'), 'utf8'))
for (const patch of patches) {
  const filename = path.resolve(sourceDir, patch.path)
  if (!filename.startsWith(sourceDir + path.sep)) throw new Error('Invalid canvas patch path')
  const source = await readFile(filename, 'utf8')
  if (source.split(patch.find).length !== 2) throw new Error(`Canvas patch no longer applies: ${patch.path}`)
  await writeFile(filename, source.replace(patch.find, patch.replace))
}
// These upstream assets use absolute paths in JS/CSS strings, which Vite does not rewrite.
const scriptDir = 'packages/model-runtime/src/call-scripts'
const assetSources = [
  'packages/workbench/src/lib/model-utils.ts',
  'packages/workbench/src/layouts/user-layout.tsx',
  'packages/workbench/src/components/agent/agent-beam.tsx',
  ...(await readdir(path.join(sourceDir, scriptDir)))
    .filter((name) => name.endsWith('.ts')).map((name) => `${scriptDir}/${name}`),
]
for (const filename of assetSources) {
  const target = path.join(sourceDir, filename)
  const source = await readFile(target, 'utf8')
  await writeFile(target, source.replaceAll('"/icons/', '"/canvas-app/icons/').replaceAll('url(/logo.svg)', 'url(/canvas-app/logo.svg)'))
}
await writeFile(path.join(sourceDir, 'apps/web/src/main.tsx'), 'import "./newapi/main";\n')
const appDir = path.join(sourceDir, 'apps/web')
run(bun, ['x', '--no-install', 'tsc', '--noEmit'], appDir)
run(bun, ['x', '--no-install', 'vite', 'build'], appDir, { VITE_BASE: '/canvas-app/' })
const destination = path.join(repositoryDir, 'web/dist/canvas-app')
await mkdir(destination, { recursive: true })
await cp(path.join(appDir, 'dist'), destination, { recursive: true })
await cp(path.join(sourceDir, 'LICENSE'), path.join(destination, 'LICENSE.infinite-canvas.txt'))
await cp(path.join(canvasDir, 'upstream.json'), path.join(destination, 'upstream.json'))
console.log(`Built infinite-canvas ${upstream.commit} → ${destination}`)
