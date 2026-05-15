import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __testing,
  clearBridgeMcpServerStatusCache,
  listBridgeMcpServerStatuses,
  type McpServerStatusRecord,
} from './mcpServerStatus'

afterEach(() => {
  clearBridgeMcpServerStatusCache()
})

describe('readConfiguredMcpServersFromConfigPayload', () => {
  it('normalizes configured MCP server definitions from config/read payloads', () => {
    expect(__testing.readConfiguredMcpServersFromConfigPayload({
      config: {
        mcp_servers: {
          'cf-portal': {
            command: '/tmp/mcpc-session-proxy',
            args: ['--stdio', '--session', '@cf-portal'],
            cwd: '/tmp/workspace',
            env: {
              MCP_TOKEN: 'secret',
              SKIP_NULL: null,
            },
            enabled: true,
          },
          disabled: {
            command: '/tmp/other-server',
            args: [],
            enabled: false,
          },
          invalid: null,
        },
      },
    })).toEqual([
      {
        name: 'cf-portal',
        command: '/tmp/mcpc-session-proxy',
        args: ['--stdio', '--session', '@cf-portal'],
        cwd: '/tmp/workspace',
        env: { MCP_TOKEN: 'secret' },
        enabled: true,
      },
      {
        name: 'disabled',
        command: '/tmp/other-server',
        args: [],
        cwd: null,
        env: {},
        enabled: false,
      },
      {
        name: 'invalid',
        command: '',
        args: [],
        cwd: null,
        env: {},
        enabled: true,
      },
    ])
  })
})

describe('listBridgeMcpServerStatuses', () => {
  it('caches enabled-server results, skips disabled probes, and falls back to stale cache on refresh failures', async () => {
    const appServer = {
      rpc: vi.fn().mockResolvedValue({
        config: {
          mcp_servers: {
            alpha: {
              command: '/tmp/alpha',
              args: ['--stdio'],
              enabled: true,
            },
            beta: {
              command: '/tmp/beta',
              args: ['--stdio'],
              enabled: false,
            },
          },
        },
      }),
    }

    const alphaStatus: McpServerStatusRecord = {
      name: 'alpha',
      tools: {
        search: {
          name: 'search',
          description: 'Search alpha',
        },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    }

    const probeServer = vi.fn()
      .mockResolvedValueOnce(alphaStatus)
      .mockRejectedValueOnce(new Error('probe failed'))

    const first = await listBridgeMcpServerStatuses(appServer, {
      probeServer,
      nowMs: 1_000,
      cacheTtlMs: 200,
    })
    expect(first).toEqual({
      data: [
        alphaStatus,
        {
          name: 'beta',
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
        },
      ],
      nextCursor: null,
    })
    expect(probeServer).toHaveBeenCalledTimes(1)
    expect(probeServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha' }))

    const second = await listBridgeMcpServerStatuses(appServer, {
      probeServer,
      nowMs: 1_050,
      cacheTtlMs: 200,
    })
    expect(second.data[0]).toEqual(alphaStatus)
    expect(probeServer).toHaveBeenCalledTimes(1)

    const third = await listBridgeMcpServerStatuses(appServer, {
      forceRefresh: true,
      probeServer,
      nowMs: 1_100,
      cacheTtlMs: 200,
    })
    expect(third.data[0]).toEqual(alphaStatus)
    expect(third.data[1]).toEqual({
      name: 'beta',
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })
    expect(probeServer).toHaveBeenCalledTimes(2)
  })
})
