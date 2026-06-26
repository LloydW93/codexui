import { getPathLeafName, normalizePathForUi } from './pathUtils.js'
import type { UiProjectGroup } from './types/codex'

export function hasDuplicateFolderLeaf(path: string, knownPaths: string[]): boolean {
  const normalizedPath = normalizePathForUi(path).trim()
  const leafName = getPathLeafName(normalizedPath)
  if (!normalizedPath || !leafName) return false
  return knownPaths.some((knownPath) => {
    const normalizedKnownPath = normalizePathForUi(knownPath).trim()
    return normalizedKnownPath !== normalizedPath && getPathLeafName(normalizedKnownPath) === leafName
  })
}

export function isManagedWorktreePath(cwdRaw: string): boolean {
  const cwd = cwdRaw.trim().replace(/\\/gu, '/')
  if (!cwd) return false
  return cwd.includes('/.codex/worktrees/') || cwd.includes('/.git/worktrees/')
}

export function resolveWorkspaceRootCwdForProject(options: {
  projectName: string
  workspaceRootOrder: string[]
  projectGroups: UiProjectGroup[]
}): string {
  const normalizedProjectName = normalizePathForUi(options.projectName).trim()
  if (!normalizedProjectName) return ''
  const knownPaths = [
    ...options.workspaceRootOrder,
    ...options.projectGroups.map((group) => group.threads[0]?.cwd?.trim() ?? '').filter(Boolean),
  ]
  const leafMatches: string[] = []
  for (const cwdRaw of options.workspaceRootOrder) {
    const cwd = normalizePathForUi(cwdRaw).trim()
    if (!cwd) continue
    const leafName = getPathLeafName(cwd)
    const orderName = hasDuplicateFolderLeaf(cwd, knownPaths) ? cwd : leafName
    if (cwd === normalizedProjectName || orderName === normalizedProjectName) {
      return cwd
    }
    if (leafName === normalizedProjectName) {
      leafMatches.push(cwd)
    }
  }
  return leafMatches.find((cwd) => !isManagedWorktreePath(cwd)) ?? leafMatches[0] ?? ''
}

export function resolvePreferredProjectCwd(options: {
  projectName: string
  workspaceRootOrder: string[]
  projectGroups: UiProjectGroup[]
  fallbackCwd?: string
}): string {
  const group = options.projectGroups.find((row) => row.projectName === options.projectName)
  const workspaceRootCwd = resolveWorkspaceRootCwdForProject(options)
  const fallbackCwd = options.fallbackCwd?.trim() ?? ''
  if (!group) return workspaceRootCwd || fallbackCwd
  const nonWorktreeThread = group.threads.find((thread) => !thread.hasWorktree && thread.cwd.trim())
  const candidate = nonWorktreeThread?.cwd?.trim() || workspaceRootCwd || group.threads[0]?.cwd?.trim() || ''
  return candidate || fallbackCwd
}
