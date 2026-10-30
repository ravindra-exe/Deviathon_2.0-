/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'dotenv'

const root = process.cwd()
const envPath = path.join(root, '.env')
let fileEnv

try {
  fileEnv = parse(readFileSync(envPath))
} catch (error) {
  console.error(`Cannot read ${envPath}: ${error instanceof Error ? error.message : 'read failed'}`)
  process.exit(1)
}

const env = { ...fileEnv, ...process.env }
const backendValue = env.PEARL_ASSESSMENT_BACKEND_URL
if (!backendValue) {
  console.error('PEARL_ASSESSMENT_BACKEND_URL is missing from the environment and .env.')
  process.exit(1)
}

let backendUrl
try {
  backendUrl = new URL(backendValue)
  if (!['http:', 'https:'].includes(backendUrl.protocol) || backendUrl.pathname !== '/') {
    throw new Error('expected an HTTP(S) origin without a path')
  }
} catch (error) {
  console.error(
    `PEARL_ASSESSMENT_BACKEND_URL is invalid: ${error instanceof Error ? error.message : 'invalid URL'}`
  )
  process.exit(1)
}

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
const configuredPort = Number(env.PORT ?? '8787')
const backendPort = Number(backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80))
const isLocalBackend = localHosts.has(backendUrl.hostname)

if (isLocalBackend && backendPort !== configuredPort) {
  console.error(
    `Backend URL port (${backendPort}) does not match the backend PORT (${configuredPort}). Align PORT and PEARL_ASSESSMENT_BACKEND_URL in .env.`
  )
  process.exit(1)
}

const healthUrl = new URL('/health', backendUrl)
const healthTimeoutMs = 1_500
const startupTimeoutMs = 30_000
let backendProcess
let electronProcess
let stopping = false

/** @returns {Promise<boolean>} */
async function checkBackendHealth() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
  try {
    const response = await fetch(healthUrl, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return body?.status === 'ok' && body?.service === 'pearl-assessment-backend'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** @returns {import('node:child_process').ChildProcess} */
function runNpm(args, envOverrides = {}) {
  const npmExecPath = process.env.npm_execpath
  if (!npmExecPath) throw new Error('Run this launcher through npm: npm run dev:live.')
  return spawn(process.execPath, [npmExecPath, ...args], {
    cwd: root,
    env: { ...env, ...envOverrides },
    stdio: 'inherit'
  })
}

/** @param {import('node:child_process').ChildProcess | undefined} child */
function stopChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
}

/** @returns {Promise<void>} */
async function waitForBackend() {
  if (await checkBackendHealth()) {
    console.log(`Assessment backend is ready at ${backendUrl.origin}.`)
    return
  }
  if (!isLocalBackend) {
    throw new Error(`Assessment backend is not healthy at ${backendUrl.origin}/health.`)
  }

  console.log(`Starting the local assessment backend for ${backendUrl.origin}...`)
  backendProcess = runNpm(['run', 'backend:dev'])
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (backendProcess.exitCode !== null || backendProcess.signalCode !== null) {
      throw new Error(
        'The assessment backend exited before becoming healthy; inspect its output above.'
      )
    }
    if (await checkBackendHealth()) {
      console.log(`Assessment backend is ready at ${backendUrl.origin}.`)
      return
    }
    await delay(300)
  }
  throw new Error(
    `The assessment backend did not become healthy at ${backendUrl.origin}/health within ${startupTimeoutMs / 1000} seconds.`
  )
}

/** @returns {Promise<void>} */
async function shutdown(code) {
  if (stopping) return
  stopping = true
  stopChild(electronProcess)
  stopChild(backendProcess)
  if (electronProcess || backendProcess) await delay(200)
  process.exitCode = code
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal === 'SIGINT' ? 130 : 143)
  })
}

try {
  await waitForBackend()
  electronProcess = runNpm(['run', 'dev'])
  const exitCode = await new Promise((resolve, reject) => {
    electronProcess.once('error', reject)
    electronProcess.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0))
    })
  })
  await shutdown(exitCode)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live development startup failed.')
  await shutdown(1)
}
