import { describe, expect, it } from 'vitest'
import type { UiProjectGroup } from './types/codex'
import {
  resolvePreferredProjectCwd,
  resolveWorkspaceRootCwdForProject,
} from './workspaceProjectCwd'

function thread(id: string, cwd: string, options: { hasWorktree?: boolean } = {}) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
  }
}

describe('workspace project cwd resolution', () => {
  it('prefers the saved base root over earlier saved Codex worktree roots', () => {
    const projectGroups: UiProjectGroup[] = [
      {
        projectName: 'rollups-monitor',
        threads: [
          thread('first-worktree-chat', '/home/lloyd/.codex/worktrees/70f8/rollups-monitor', { hasWorktree: true }),
          thread('second-worktree-chat', '/home/lloyd/.codex/worktrees/5279/rollups-monitor', { hasWorktree: true }),
        ],
      },
    ]
    const workspaceRootOrder = [
      '/home/lloyd/.codex/worktrees/70f8/rollups-monitor',
      '/home/lloyd/.codex/worktrees/5279/rollups-monitor',
      '/home/lloyd/ws/opencode/rollups-monitor',
    ]

    expect(resolveWorkspaceRootCwdForProject({
      projectName: 'rollups-monitor',
      workspaceRootOrder,
      projectGroups,
    })).toBe('/home/lloyd/ws/opencode/rollups-monitor')
    expect(resolvePreferredProjectCwd({
      projectName: 'rollups-monitor',
      workspaceRootOrder,
      projectGroups,
    })).toBe('/home/lloyd/ws/opencode/rollups-monitor')
  })

  it('uses non-worktree session metadata before worktree session cwds', () => {
    const projectGroups: UiProjectGroup[] = [
      {
        projectName: 'rollups-monitor',
        threads: [
          thread('recent-worktree-chat', '/home/lloyd/.codex/worktrees/70f8/rollups-monitor', { hasWorktree: true }),
          thread('base-chat', '/home/lloyd/ws/opencode/rollups-monitor'),
        ],
      },
    ]

    expect(resolvePreferredProjectCwd({
      projectName: 'rollups-monitor',
      workspaceRootOrder: [],
      projectGroups,
    })).toBe('/home/lloyd/ws/opencode/rollups-monitor')
  })

  it('keeps an exact full-path worktree project selection exact', () => {
    const projectGroups: UiProjectGroup[] = []
    const workspaceRootOrder = [
      '/home/lloyd/.codex/worktrees/70f8/rollups-monitor',
      '/home/lloyd/ws/opencode/rollups-monitor',
    ]

    expect(resolveWorkspaceRootCwdForProject({
      projectName: '/home/lloyd/.codex/worktrees/70f8/rollups-monitor',
      workspaceRootOrder,
      projectGroups,
    })).toBe('/home/lloyd/.codex/worktrees/70f8/rollups-monitor')
  })
})
