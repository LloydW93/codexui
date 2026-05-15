import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getSpawnInvocation } from '../utils/commandInvocation.js'

type RpcExecutor = {
  rpc(method: string, params: unknown): Promise<unknown>
}

type ConfiguredMcpServer = {
  name: string
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
  enabled: boolean
}

export type McpServerStatusRecord = {
  name: string
  tools: Record<string, unknown>
  resources: unknown[]
  resourceTemplates: unknown[]
  authStatus: string
}

type ListMcpServerStatusesResult = {
  data: McpServerStatusRecord[]
  nextCursor: null
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type SpawnProcess = typeof spawn
type StdioMcpTransportMode = 'framed' | 'line'

type ListMcpServerStatusesOptions = {
  forceRefresh?: boolean
  cacheTtlMs?: number
  nowMs?: number
  probeServer?: (server: ConfiguredMcpServer) => Promise<McpServerStatusRecord>
}

type ProbeConfiguredMcpServerOptions = {
  spawnProcess?: SpawnProcess
  initializeTimeoutMs?: number
  listTimeoutMs?: number
  resourceTimeoutMs?: number
}

type CachedMcpStatus = {
  expiresAtMs: number
  status: McpServerStatusRecord
}

const MCP_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_MCP_STATUS_CACHE_TTL_MS = 30_000
const DEFAULT_MCP_INITIALIZE_TIMEOUT_MS = 2_000
const DEFAULT_MCP_LIST_TIMEOUT_MS = 8_000
const DEFAULT_MCP_RESOURCE_TIMEOUT_MS = 2_000
const MCP_STATUS_CLIENT_NAME = 'codexui-mcp-status'
const MCP_STATUS_CLIENT_VERSION = '0.1.0'
const MAX_STDERR_LENGTH = 4096

const cachedStatusesByServer = new Map<string, CachedMcpStatus>()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  const entries = Object.entries(record).filter(([, item]) => typeof item === 'string')
  return Object.fromEntries(entries) as Record<string, string>
}

function readConfiguredMcpServersFromConfigPayload(payload: unknown): ConfiguredMcpServer[] {
  const record = asRecord(payload)
  const config = asRecord(record?.config)
  const servers = asRecord(config?.mcp_servers)
  if (!servers) return []

  return Object.entries(servers).map(([name, raw]) => {
    const entry = asRecord(raw)
    return {
      name,
      command: readString(entry?.command),
      args: readStringArray(entry?.args),
      cwd: readString(entry?.cwd) || null,
      env: readStringRecord(entry?.env),
      enabled: readBoolean(entry?.enabled) ?? true,
    }
  })
}

function emptyStatus(name: string): McpServerStatusRecord {
  return {
    name,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: 'unsupported',
  }
}

function normalizeToolMap(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const entries = value.map((raw, index) => {
      const tool = asRecord(raw)
      const name = readString(tool?.name) || `tool-${String(index + 1)}`
      return [name, tool ?? {}] as const
    })
    return Object.fromEntries(entries)
  }

  const record = asRecord(value)
  return record ? record : {}
}

function normalizeUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function summarizeTransportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown MCP transport failure')
  return message.trim().slice(0, 500)
}

function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Method not found:')
}

class StdioMcpClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readBuffer = Buffer.alloc(0)
  private readTextBuffer = ''
  private nextId = 1
  private stderr = ''
  private disposed = false

  constructor(
    server: ConfiguredMcpServer,
    private readonly mode: StdioMcpTransportMode,
    spawnProcess: SpawnProcess = spawn,
  ) {
    const invocation = getSpawnInvocation(server.command, server.args)
    const env = Object.keys(server.env).length > 0
      ? { ...process.env, ...server.env }
      : process.env
    this.proc = spawnProcess(invocation.command, invocation.args, {
      cwd: server.cwd ?? undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      if (this.mode === 'framed') {
        this.handleFramedStdout(buffer)
        return
      }
      this.handleLineStdout(buffer.toString('utf8'))
    })

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      if (this.stderr.length >= MAX_STDERR_LENGTH) return
      this.stderr = `${this.stderr}${chunk}`.slice(0, MAX_STDERR_LENGTH)
    })

    this.proc.on('error', (error) => {
      this.failAll(error)
    })

    this.proc.on('close', (code) => {
      if (this.disposed) return
      const suffix = this.stderr.trim().length > 0
        ? `: ${this.stderr.trim()}`
        : ''
      this.failAll(new Error(`MCP server exited with code ${code ?? 0}${suffix}`))
    })
  }

  private handleResponseMessage(message: unknown): void {
    const record = asRecord(message)
    const id = typeof record?.id === 'number' ? record.id : null
    if (id === null) return

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timeout)

    const errorPayload = asRecord(record?.error)
    if (errorPayload) {
      pending.reject(new Error(readString(errorPayload.message) || `MCP request ${String(id)} failed`))
      return
    }

    pending.resolve(record?.result ?? null)
  }

  private handleLineStdout(chunk: string): void {
    this.readTextBuffer = `${this.readTextBuffer}${chunk}`
    while (true) {
      const newlineIndex = this.readTextBuffer.indexOf('\n')
      if (newlineIndex < 0) return
      const line = this.readTextBuffer.slice(0, newlineIndex).trim()
      this.readTextBuffer = this.readTextBuffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        this.handleResponseMessage(JSON.parse(line))
      } catch {
        // Ignore non-JSON stdout noise and wait for the next line.
      }
    }
  }

  private handleFramedStdout(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    while (true) {
      const headerEnd = this.readBuffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return

      const headerText = this.readBuffer.subarray(0, headerEnd).toString('ascii')
      const contentLengthMatch = headerText.match(/content-length:\s*(\d+)/iu)
      if (!contentLengthMatch) {
        this.failAll(new Error('MCP server response missing Content-Length header'))
        return
      }

      const bodyLength = Number.parseInt(contentLengthMatch[1] ?? '', 10)
      if (!Number.isFinite(bodyLength) || bodyLength < 0) {
        this.failAll(new Error(`MCP server response has invalid Content-Length: ${contentLengthMatch[1] ?? ''}`))
        return
      }

      const totalLength = headerEnd + 4 + bodyLength
      if (this.readBuffer.length < totalLength) return

      const bodyText = this.readBuffer.subarray(headerEnd + 4, totalLength).toString('utf8')
      this.readBuffer = this.readBuffer.subarray(totalLength)

      let message: unknown
      try {
        message = JSON.parse(bodyText)
      } catch (error) {
        this.failAll(new Error(`MCP server returned invalid JSON: ${summarizeTransportFailure(error)}`))
        return
      }

      this.handleResponseMessage(message)
    }
  }

  private failAll(error: unknown): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    try {
      this.proc.stdin.end()
    } catch {}
    try {
      this.proc.kill('SIGTERM')
    } catch {}
    const timer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {}
    }, 250)
    timer.unref?.()
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (this.disposed) throw new Error('MCP transport is already closed')
    if (this.mode === 'line') {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    this.proc.stdin.write(Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, 'ascii'))
    this.proc.stdin.write(body)
  }

  async call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.disposed) throw new Error('MCP transport is already closed')
    const id = this.nextId++

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request ${method} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      timeout.unref?.()

      this.pending.set(id, { resolve, reject, timeout })

      try {
        this.writeMessage({
          jsonrpc: '2.0',
          id,
          method,
          params,
        })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.disposed) return
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  dispose(): void {
    this.failAll(new Error('MCP transport closed'))
  }
}

function preferredTransportModes(server: ConfiguredMcpServer): StdioMcpTransportMode[] {
  const candidate = `${server.command} ${server.args.join(' ')}`.toLowerCase()
  return candidate.includes('mcpc-session-proxy') ? ['framed', 'line'] : ['line', 'framed']
}

async function callOptionalListMethod(
  client: StdioMcpClient,
  method: string,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    return await client.call(method, {}, timeoutMs)
  } catch (error) {
    if (isMethodNotFoundError(error)) return null
    return null
  }
}

export async function probeConfiguredMcpServer(
  server: ConfiguredMcpServer,
  options: ProbeConfiguredMcpServerOptions = {},
): Promise<McpServerStatusRecord> {
  if (!server.enabled || !server.command) {
    return emptyStatus(server.name)
  }

  let lastError: unknown = null
  for (const mode of preferredTransportModes(server)) {
    const client = new StdioMcpClient(server, mode, options.spawnProcess)
    try {
      await client.call('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: {
          name: MCP_STATUS_CLIENT_NAME,
          version: MCP_STATUS_CLIENT_VERSION,
        },
        capabilities: {},
      }, options.initializeTimeoutMs ?? DEFAULT_MCP_INITIALIZE_TIMEOUT_MS)
      client.notify(mode === 'line' ? 'initialized' : 'notifications/initialized')

      const toolsPayload = asRecord(await client.call(
        'tools/list',
        {},
        options.listTimeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS,
      ))
      const resourcesPayload = asRecord(await callOptionalListMethod(
        client,
        'resources/list',
        options.resourceTimeoutMs ?? DEFAULT_MCP_RESOURCE_TIMEOUT_MS,
      ))
      const resourceTemplatesPayload = asRecord(await callOptionalListMethod(
        client,
        'resources/templates/list',
        options.resourceTimeoutMs ?? DEFAULT_MCP_RESOURCE_TIMEOUT_MS,
      ))

      return {
        name: server.name,
        tools: normalizeToolMap(toolsPayload?.tools),
        resources: normalizeUnknownArray(resourcesPayload?.resources),
        resourceTemplates: normalizeUnknownArray(
          resourceTemplatesPayload?.resourceTemplates
          ?? resourceTemplatesPayload?.resource_templates,
        ),
        authStatus: 'unsupported',
      }
    } catch (error) {
      lastError = error
    } finally {
      client.dispose()
    }
  }

  throw lastError ?? new Error(`Failed to probe MCP server ${server.name}`)
}

async function readConfiguredMcpServers(appServer: RpcExecutor): Promise<ConfiguredMcpServer[]> {
  const payload = await appServer.rpc('config/read', {})
  return readConfiguredMcpServersFromConfigPayload(payload)
}

export async function listBridgeMcpServerStatuses(
  appServer: RpcExecutor,
  options: ListMcpServerStatusesOptions = {},
): Promise<ListMcpServerStatusesResult> {
  const servers = await readConfiguredMcpServers(appServer)
  const nowMs = options.nowMs ?? Date.now()
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_MCP_STATUS_CACHE_TTL_MS
  const probeServer = options.probeServer ?? probeConfiguredMcpServer

  const data = await Promise.all(servers.map(async (server) => {
    const cached = cachedStatusesByServer.get(server.name)
    if (!server.enabled) {
      const disabledStatus = emptyStatus(server.name)
      cachedStatusesByServer.set(server.name, {
        expiresAtMs: nowMs + cacheTtlMs,
        status: disabledStatus,
      })
      return disabledStatus
    }

    if (!options.forceRefresh && cached && cached.expiresAtMs > nowMs) {
      return cached.status
    }

    try {
      const status = await probeServer(server)
      cachedStatusesByServer.set(server.name, {
        expiresAtMs: nowMs + cacheTtlMs,
        status,
      })
      return status
    } catch {
      if (cached) return cached.status
      return emptyStatus(server.name)
    }
  }))

  return {
    data,
    nextCursor: null,
  }
}

export function clearBridgeMcpServerStatusCache(): void {
  cachedStatusesByServer.clear()
}

export const __testing = {
  emptyStatus,
  readConfiguredMcpServersFromConfigPayload,
}
