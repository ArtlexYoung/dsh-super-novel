import { open } from 'node:fs/promises'

type DirectoryHandle = { sync(): Promise<void>; close(): Promise<void> }

/** Node cannot open directories for fsync on Windows; file fsync is still required. */
export async function syncDirectory(
  path: string, platform: NodeJS.Platform = process.platform,
  openDirectory: (path: string) => Promise<DirectoryHandle> = path => open(path, 'r'),
): Promise<void> {
  if (platform === 'win32') return
  const handle = await openDirectory(path)
  try { await handle.sync() } finally { await handle.close() }
}

/** Retry only transient Windows interference; callers recheck the baseline each time. */
export async function publishFile(
  operation: () => Promise<void>, platform: NodeJS.Platform = process.platform,
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<void> {
  let delay = 20
  for (let retries = 0;; retries++) {
    try { await operation(); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || retries >= 8) throw error
    }
    await wait(delay)
    delay = Math.min(delay * 2, 200)
  }
}
