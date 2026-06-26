import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildThreadMaterializationPendingReadResult,
  buildProjectlessFolderName,
  callRpcWithArchiveRecovery,
  canonicalizeThreadListResponseForRead,
  canonicalizeWorkspaceRootsStateForRead,
  ensureDefaultFreeModeStateForMissingAuthSync,
  hasUsableCodexAuth,
  isEmptyThreadReadError,
  isThreadMaterializationPendingError,
  isThreadNotFoundError,
  isUnauthenticatedRateLimitError,
  loadThreadSummariesForSearch,
  readDirectSessionThreadTurnPage,
  writeFreeModeStateFile,
  writeWorkspaceRootsState,
} from './codexAppServerBridge'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

describe('callRpcWithArchiveRecovery', () => {
  it('sets a fallback name and retries archive when Codex has not materialized a rollout', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let archiveCalls = 0
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/archive') {
          archiveCalls += 1
          if (archiveCalls === 1) {
            throw new Error('no rollout found for thread test-thread')
          }
          return { ok: true }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'test-thread',
              preview: 'Preview title',
              path: '/home/user/.codex/sessions/rollout-test-thread.jsonl',
            },
          }
        }
        return { ok: true }
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'test-thread' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      { method: 'thread/archive', params: { threadId: 'test-thread' } },
      { method: 'thread/read', params: { threadId: 'test-thread', includeTurns: false } },
      { method: 'thread/name/set', params: { threadId: 'test-thread', name: 'Preview title' } },
      { method: 'thread/archive', params: { threadId: 'test-thread' } },
    ])
  })

  it('treats no-rollout archive of an already archived thread as successful', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'thread/archive') {
          throw new Error('no rollout found for thread archived-thread')
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'archived-thread',
              path: '/home/user/.codex/archived_sessions/rollout-archived-thread.jsonl',
            },
          }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'archived-thread' })).resolves.toBeNull()
    expect(calls).toEqual([
      { method: 'thread/archive', params: { threadId: 'archived-thread' } },
      { method: 'thread/read', params: { threadId: 'archived-thread', includeTurns: false } },
    ])
  })

  it('does not recover unrelated RPC failures', async () => {
    const appServer = {
      async rpc(): Promise<unknown> {
        throw new Error('network failed')
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'thread/archive', { threadId: 'test-thread' })).rejects.toThrow('network failed')
    await expect(callRpcWithArchiveRecovery(appServer, 'thread/read', { threadId: 'test-thread' })).rejects.toThrow('network failed')
  })

  it('resumes and retries turn/start when a restarted app-server has not materialized the thread', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    let startCalls = 0
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params })
        if (method === 'turn/start') {
          startCalls += 1
          if (startCalls === 1) {
            throw new Error('thread not found: test-thread')
          }
          return { turn: { id: 'turn-2' } }
        }
        if (method === 'thread/resume') {
          return { thread: { id: 'test-thread', turns: [] } }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }

    await expect(callRpcWithArchiveRecovery(appServer, 'turn/start', {
      threadId: 'test-thread',
      input: [{ type: 'text', text: 'hi' }],
    })).resolves.toEqual({ turn: { id: 'turn-2' } })
    expect(calls).toEqual([
      {
        method: 'turn/start',
        params: { threadId: 'test-thread', input: [{ type: 'text', text: 'hi' }] },
      },
      { method: 'thread/resume', params: { threadId: 'test-thread' } },
      {
        method: 'turn/start',
        params: { threadId: 'test-thread', input: [{ type: 'text', text: 'hi' }] },
      },
    ])
  })
})

describe('buildProjectlessFolderName', () => {
  it('falls back to unique suffixes after the readable collision range', () => {
    expect(buildProjectlessFolderName('hi', 0, 'ignored')).toBe('hi')
    expect(buildProjectlessFolderName('hi', 1, 'ignored')).toBe('hi-2')
    expect(buildProjectlessFolderName('hi', 19, 'ignored')).toBe('hi-20')
    expect(buildProjectlessFolderName('hi', 20, 'mabc1234-deadbeef')).toBe('hi-mabc1234-deadbeef')
  })

  it('keeps long unique fallback names within the slug length limit', () => {
    const slug = 'a'.repeat(80)
    const folderName = buildProjectlessFolderName(slug, 20, 'mabc1234-deadbeef')
    expect(folderName).toHaveLength(80)
    expect(folderName).toMatch(/-mabc1234-deadbeef$/)
  })
})

describe('canonicalizeWorkspaceRootsStateForRead', () => {
  it('realpaths existing local roots so symlink cwd sessions remain visible', async () => {
    const state = await canonicalizeWorkspaceRootsStateForRead({
      order: ['/workspace-link/projects/demo', 'remote-project-id'],
      labels: {
        '/storage/projects/demo': 'Canonical Demo',
        '/workspace-link/projects/demo': 'Symlink Demo',
        'remote-project-id': 'Remote Demo',
      },
      active: ['/workspace-link/projects/demo'],
      projectOrder: ['remote-project-id', '/workspace-link/projects/demo'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:host',
        remotePath: '/remote/projects/demo',
        label: 'remote-demo',
      }],
    }, async (value) => value.replace('/workspace-link/', '/storage/'))

    expect(state.order).toEqual([
      '/storage/projects/demo',
      'remote-project-id',
    ])
    expect(state.active).toEqual(['/storage/projects/demo'])
    expect(state.projectOrder).toEqual([
      'remote-project-id',
      '/storage/projects/demo',
    ])
    expect(state.labels).toEqual({
      '/storage/projects/demo': 'Canonical Demo',
      'remote-project-id': 'Remote Demo',
    })
    expect(state.remoteProjects[0]?.id).toBe('remote-project-id')
  })
})

describe('writeWorkspaceRootsState', () => {
  it('persists workspace roots in canonical form', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-workspace-roots-'))
    const canonicalRoot = join(codexHome, 'storage', 'projects', 'demo')
    const symlinkParent = join(codexHome, 'workspace-link', 'projects')
    const symlinkRoot = join(symlinkParent, 'demo')
    process.env.CODEX_HOME = codexHome

    try {
      await mkdir(canonicalRoot, { recursive: true })
      await mkdir(symlinkParent, { recursive: true })
      await symlink(canonicalRoot, symlinkRoot)
      await writeWorkspaceRootsState({
        order: [symlinkRoot, 'remote-project-id', canonicalRoot],
        labels: {
          [canonicalRoot]: 'Canonical Demo',
          [symlinkRoot]: 'Symlink Demo',
          'remote-project-id': 'Remote Demo',
        },
        active: [symlinkRoot, canonicalRoot],
        projectOrder: ['remote-project-id', symlinkRoot, canonicalRoot],
        remoteProjects: [{
          id: 'remote-project-id',
          hostId: 'remote-ssh-discovered:host',
          remotePath: '/remote/projects/demo',
          label: 'remote-demo',
        }],
      })

      const rawState = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>
      expect(rawState['electron-saved-workspace-roots']).toEqual([
        canonicalRoot,
        'remote-project-id',
      ])
      expect(rawState['active-workspace-roots']).toEqual([canonicalRoot])
      expect(rawState['project-order']).toEqual([
        'remote-project-id',
        canonicalRoot,
      ])
      expect(rawState['electron-workspace-root-labels']).toEqual({
        [canonicalRoot]: 'Canonical Demo',
        'remote-project-id': 'Remote Demo',
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('canonicalizeThreadListResponseForRead', () => {
  it('realpaths thread cwd values to match canonicalized workspace roots', async () => {
    const payload = await canonicalizeThreadListResponseForRead({
      data: [
        { id: 'symlink-cwd-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    }, async (value) => value.replace('/workspace-link/', '/storage/'))

    expect(payload).toEqual({
      data: [
        { id: 'symlink-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    })
  })

  it('reuses cwd realpath results within one thread list response', async () => {
    const calls: string[] = []
    const payload = await canonicalizeThreadListResponseForRead({
      data: [
        { id: 'first-symlink-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'second-symlink-thread', cwd: '/workspace-link/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    }, async (value) => {
      calls.push(value)
      return value.replace('/workspace-link/', '/storage/')
    })

    expect(payload).toEqual({
      data: [
        { id: 'first-symlink-thread', cwd: '/storage/projects/demo' },
        { id: 'second-symlink-thread', cwd: '/storage/projects/demo' },
        { id: 'canonical-cwd-thread', cwd: '/storage/projects/demo' },
        { id: 'remote-thread', cwd: 'remote-project-id' },
      ],
      nextCursor: null,
    })
    expect(calls).toEqual([
      '/workspace-link/projects/demo',
      '/storage/projects/demo',
    ])
  })
})

describe('isUnauthenticatedRateLimitError', () => {
  it('matches unauthenticated rate-limit failures from a fresh Codex home', () => {
    expect(isUnauthenticatedRateLimitError(new Error('codex account authentication required to read rate limits'))).toBe(true)
  })

  it('matches direct message fields from Codex stream errors', () => {
    expect(isUnauthenticatedRateLimitError({
      message: 'codex account authentication required to read rate limits',
      codexErrorInfo: 'other',
      additionalDetails: null,
    })).toBe(true)
  })

  it('does not match unrelated authentication failures', () => {
    expect(isUnauthenticatedRateLimitError(new Error('codex account authentication required to send messages'))).toBe(false)
    expect(isUnauthenticatedRateLimitError(new Error('failed to read rate limits'))).toBe(false)
  })
})

describe('isEmptyThreadReadError', () => {
  it('matches Codex empty rollout read failures during immediate thread startup', () => {
    expect(isEmptyThreadReadError(new Error(
      'failed to read thread: thread-store internal error: failed to read thread /tmp/codex-home/sessions/rollout-test.jsonl: rollout at /tmp/codex-home/sessions/rollout-test.jsonl is empty',
    ))).toBe(true)
  })

  it('does not match unrelated thread read failures', () => {
    expect(isEmptyThreadReadError(new Error('failed to read thread: permission denied'))).toBe(false)
    expect(isEmptyThreadReadError(new Error('rollout is empty'))).toBe(false)
  })
})

describe('isThreadMaterializationPendingError', () => {
  it('matches Codex live-state reads before the first message is materialized', () => {
    expect(isThreadMaterializationPendingError(new Error(
      'thread 019e1f04-dca4-7823-8b9a-554b9bd22f57 is not materialized yet; includeTurns is unavailable before first user message',
    ))).toBe(true)
  })

  it('does not match unrelated thread read failures', () => {
    expect(isThreadMaterializationPendingError(new Error('thread read failed: permission denied'))).toBe(false)
    expect(isThreadMaterializationPendingError(new Error('not materialized yet'))).toBe(false)
  })
})

describe('buildThreadMaterializationPendingReadResult', () => {
  it('matches the in-progress thread shape used by thread/read fallbacks', () => {
    expect(buildThreadMaterializationPendingReadResult('pending-thread')).toEqual({
      thread: {
        id: 'pending-thread',
        turns: [],
        status: { type: 'inProgress' },
      },
    })
  })
})

describe('loadThreadSummariesForSearch', () => {
  it('uses bounded thread/list summary pages without reading full thread bodies', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const appServer = {
      async rpc(method: string, params: unknown): Promise<unknown> {
        calls.push({ method, params: params as Record<string, unknown> })
        if (method === 'thread/read') {
          throw new Error('thread/read should not be used while building the search summary index')
        }
        if (method !== 'thread/list') {
          throw new Error(`unexpected method ${method}`)
        }

        const cursor = typeof (params as { cursor?: unknown }).cursor === 'string'
          ? (params as { cursor: string }).cursor
          : ''
        const index = cursor ? Number.parseInt(cursor.replace('cursor-', ''), 10) : 0
        return {
          data: [{
            id: `thread-${index}`,
            name: `Thread ${index}`,
            preview: `Preview ${index}`,
          }],
          nextCursor: `cursor-${index + 1}`,
        }
      },
    }

    await expect(loadThreadSummariesForSearch(appServer)).resolves.toEqual([
      {
        id: 'thread-0',
        title: 'Thread 0',
        preview: 'Preview 0',
        messageText: '',
        searchableText: 'Thread 0\nPreview 0',
      },
      {
        id: 'thread-1',
        title: 'Thread 1',
        preview: 'Preview 1',
        messageText: '',
        searchableText: 'Thread 1\nPreview 1',
      },
      {
        id: 'thread-2',
        title: 'Thread 2',
        preview: 'Preview 2',
        messageText: '',
        searchableText: 'Thread 2\nPreview 2',
      },
      {
        id: 'thread-3',
        title: 'Thread 3',
        preview: 'Preview 3',
        messageText: '',
        searchableText: 'Thread 3\nPreview 3',
      },
      {
        id: 'thread-4',
        title: 'Thread 4',
        preview: 'Preview 4',
        messageText: '',
        searchableText: 'Thread 4\nPreview 4',
      },
    ])
    expect(calls).toEqual([
      { method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: null } },
      { method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: 'cursor-1' } },
      { method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: 'cursor-2' } },
      { method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: 'cursor-3' } },
      { method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: 'cursor-4' } },
    ])
  })
})

describe('readDirectSessionThreadTurnPage', () => {
  it('loads a bounded turn page directly from the session jsonl', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-direct-thread-page-'))
    const threadId = 'direct-thread'
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '26')
    const sessionPath = join(sessionDir, `rollout-2026-06-26T12-00-00-${threadId}.jsonl`)
    await mkdir(sessionDir, { recursive: true })
    process.env.CODEX_HOME = codexHome

    const lines: string[] = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-06-26T12:00:00.000Z',
          cwd: '/workspace/project',
          cli_version: '0.1.0',
          source: 'vscode',
          model_provider: 'proxy',
        },
      }),
    ]
    for (let index = 1; index <= 12; index += 1) {
      const turnId = `turn-${String(index).padStart(2, '0')}`
      lines.push(JSON.stringify({
        timestamp: `2026-06-26T12:${String(index).padStart(2, '0')}:00.000Z`,
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: turnId, started_at: 1782475200 + index },
      }))
      lines.push(JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: turnId, cwd: '/workspace/project', model: 'gpt-5.5' },
      }))
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `user ${index}` }],
        },
      }))
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: index === 12
              ? `assistant ${index}

<oai-mem-citation>
<citation_entries>
MEMORY.md:137-145|note=[phase b account incident workflow context]
</citation_entries>
<rollout_ids>
019ef00e-ac21-7b40-8363-e84213ba3e3f
</rollout_ids>
</oai-mem-citation>`
              : `assistant ${index}`,
          }],
          phase: 'final_answer',
        },
      }))
      if (index === 12) {
        lines.push(JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_direct',
            arguments: JSON.stringify({ cmd: 'git status --short', workdir: '/workspace/project' }),
          },
        }))
        lines.push(JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_direct',
            output: 'Process exited with code 0\nWall time: 0.1 seconds\nOutput:\nclean\n',
          },
        }))
      }
      lines.push(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          completed_at: 1782475201 + index,
          duration_ms: 1000,
        },
      }))
    }
    await writeFile(sessionPath, `${lines.join('\n')}\n`, 'utf8')
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: threadId, thread_name: 'Direct Thread', updated_at: '2026-06-26T12:12:00.000Z' })}\n`,
      'utf8',
    )

    try {
      const page = await readDirectSessionThreadTurnPage(threadId, '', 10)
      expect(page?.startTurnIndex).toBe(2)
      expect(page?.hasMoreOlder).toBe(true)
      const result = page?.result as { model?: string; modelProvider?: string; thread?: { name?: string; turns?: Array<{ id: string; items: unknown[] }> } }
      expect(result.model).toBe('gpt-5.5')
      expect(result.modelProvider).toBe('proxy')
      expect(result.thread?.name).toBe('Direct Thread')
      expect(result.thread?.turns?.map((turn) => turn.id)).toEqual([
        'turn-03',
        'turn-04',
        'turn-05',
        'turn-06',
        'turn-07',
        'turn-08',
        'turn-09',
        'turn-10',
        'turn-11',
        'turn-12',
      ])
      expect(result.thread?.turns?.at(-1)?.items.map((item) => (item as { type?: string }).type)).toEqual([
        'userMessage',
        'agentMessage',
        'commandExecution',
      ])
      const agentItem = result.thread?.turns?.at(-1)?.items.find((item) => (item as { type?: string }).type === 'agentMessage') as { text?: string } | undefined
      expect(agentItem?.text).toBe('assistant 12')

      const olderPage = await readDirectSessionThreadTurnPage(threadId, 'turn-03', 10)
      expect(olderPage?.startTurnIndex).toBe(0)
      expect(olderPage?.hasMoreOlder).toBe(false)
      const olderResult = olderPage?.result as { thread?: { turns?: Array<{ id: string }> } }
      expect(olderResult.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-01', 'turn-02'])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not expose unfinished direct session turns as active without live stream evidence', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-direct-thread-orphan-'))
    const threadId = 'direct-orphan-thread'
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '26')
    const sessionPath = join(sessionDir, `rollout-2026-06-26T13-00-00-${threadId}.jsonl`)
    await mkdir(sessionDir, { recursive: true })
    process.env.CODEX_HOME = codexHome

    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-06-26T13:00:00.000Z',
          cwd: '/workspace/project',
          cli_version: '0.1.0',
          source: 'vscode',
          model_provider: 'proxy',
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-26T13:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-open', started_at: 1782478801 },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn-open', cwd: '/workspace/project', model: 'gpt-5.5' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'still running before restart' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_open',
          arguments: JSON.stringify({ cmd: 'sleep 100', workdir: '/workspace/project' }),
        },
      }),
    ]
    await writeFile(sessionPath, `${lines.join('\n')}\n`, 'utf8')

    try {
      const page = await readDirectSessionThreadTurnPage(threadId, '', 10)
      const result = page?.result as {
        thread?: {
          status?: { type?: string }
          turns?: Array<{ id: string; status?: string; items: Array<{ type?: string; status?: string }> }>
        }
      }
      const turn = result.thread?.turns?.[0]
      const command = turn?.items.find((item) => item.type === 'commandExecution')
      expect(result.thread?.status).toEqual({ type: 'idle' })
      expect(turn?.status).toBe('interrupted')
      expect(command?.status).toBe('interrupted')

      const livePage = await readDirectSessionThreadTurnPage(threadId, '', 10, { activeTurnIds: new Set(['turn-open']) })
      const liveResult = livePage?.result as {
        thread?: {
          status?: { type?: string; activeFlags?: unknown[] }
          turns?: Array<{ id: string; status?: string; items: Array<{ type?: string; status?: string }> }>
        }
      }
      const liveTurn = liveResult.thread?.turns?.[0]
      const liveCommand = liveTurn?.items.find((item) => item.type === 'commandExecution')
      expect(liveResult.thread?.status).toEqual({ type: 'active', activeFlags: [] })
      expect(liveTurn?.status).toBe('inProgress')
      expect(liveCommand?.status).toBe('inProgress')
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('isThreadNotFoundError', () => {
  it('matches app-server thread lookup failures after restart', () => {
    expect(isThreadNotFoundError(new Error('thread not found: 019e2180-6ad7'))).toBe(true)
    expect(isThreadNotFoundError(new Error('no rollout found for thread id 019e2180-6ad7'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isThreadNotFoundError(new Error('network failed'))).toBe(false)
    expect(isThreadNotFoundError(new Error('thread read failed: permission denied'))).toBe(false)
  })
})

describe('hasUsableCodexAuth', () => {
  it('returns false when auth.json is missing or does not contain usable tokens', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-no-token-'))
    process.env.CODEX_HOME = codexHome
    try {
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: {} }))
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('returns true when auth.json contains an access token or refresh token', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-with-token-'))
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))
      await expect(hasUsableCodexAuth()).resolves.toBe(true)
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'refresh-token' } }))
      await expect(hasUsableCodexAuth()).resolves.toBe(true)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('warns when auth.json exists but cannot be parsed', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-invalid-auth-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), '{')
      await expect(hasUsableCodexAuth()).resolves.toBe(false)
      expect(warn).toHaveBeenCalledWith(
        '[codex-auth] Unable to read Codex auth state',
        expect.objectContaining({ path: join(codexHome, 'auth.json') }),
      )
    } finally {
      warn.mockRestore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('ensureDefaultFreeModeStateForMissingAuthSync', () => {
  it('creates CODEX_HOME before writing free-mode state', async () => {
    const codexHome = join(tmpdir(), `codex-home-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const statePath = join(codexHome, 'webui-custom-providers.json')
    try {
      await writeFreeModeStateFile(statePath, {
        enabled: true,
        apiKey: 'community-key',
        model: 'openrouter/free',
        customKey: false,
        provider: 'openrouter',
        wireApi: 'responses',
      })

      const info = await stat(statePath)
      expect(info.isFile()).toBe(true)
      expect(info.mode & 0o777).toBe(0o600)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses OpenCode Zen as a runtime fallback without creating a state file', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-runtime-zen-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)

      expect(state?.enabled).toBe(true)
      expect(state?.provider).toBe('opencode-zen')
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not synthesize OpenCode Zen after Codex auth exists and no state file is present', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-auth-no-state-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toBeNull()
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not synthesize OpenCode Zen when config.toml explicitly selects a model provider', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-config-provider-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model = "gpt-5.5"',
        'model_provider = "azure"',
        '',
        '[model_providers.azure]',
        'base_url = "https://example.openai.azure.com/openai/v1"',
        'wire_api = "responses"',
      ].join('\n'))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toBeNull()
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('detects quoted top-level model_provider keys in config.toml', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-quoted-config-provider-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'config.toml'), [
        '"model_provider" = "azure"',
        '',
        '[model_providers.azure]',
        'base_url = "https://example.openai.azure.com/openai/v1"',
        'wire_api = "responses"',
      ].join('\n'))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toBeNull()
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('ignores commented and nested model_provider keys when deciding the runtime fallback', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-nested-provider-config-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'config.toml'), [
        '# model_provider = "azure"',
        '',
        '[profiles.work]',
        'model_provider = "azure"',
      ].join('\n'))

      const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)

      expect(state?.enabled).toBe(true)
      expect(state?.provider).toBe('opencode-zen')
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('ignores model_provider text inside multiline TOML strings', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-multiline-provider-config-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'banner = """',
        'model_provider = "azure"',
        '"""',
      ].join('\n'))

      const state = ensureDefaultFreeModeStateForMissingAuthSync(statePath)

      expect(state?.enabled).toBe(true)
      expect(state?.provider).toBe('opencode-zen')
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('ignores community provider state after Codex auth appears', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-auth-community-provider-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))
      await writeFile(statePath, JSON.stringify({
        enabled: true,
        apiKey: 'community-openrouter-key',
        model: 'openrouter/free',
        customKey: false,
        provider: 'openrouter',
        wireApi: 'responses',
      }))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toBeNull()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('keeps user configured provider state after Codex auth appears', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-auth-custom-provider-'))
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))
      const configuredState = {
        enabled: true,
        apiKey: 'user-openrouter-key',
        model: 'openrouter/model',
        customKey: true,
        provider: 'openrouter',
        wireApi: 'responses',
      }
      await writeFile(statePath, JSON.stringify(configuredState))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toEqual(configuredState)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('ignores the legacy free-mode state filename instead of migrating it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-legacy-free-mode-'))
    const legacyStatePath = join(codexHome, 'webui-free-mode.json')
    const statePath = join(codexHome, 'webui-custom-providers.json')
    process.env.CODEX_HOME = codexHome
    try {
      await writeFile(legacyStatePath, JSON.stringify({
        enabled: true,
        apiKey: null,
        model: 'legacy-model',
        provider: 'opencode-zen',
        wireApi: 'responses',
      }))
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'access-token' } }))

      expect(ensureDefaultFreeModeStateForMissingAuthSync(statePath)).toBeNull()
      await expect(stat(statePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
