import { hostname } from 'node:os'
import { hash } from '../domain/books.js'

export interface GenerationOwner { readonly machine: string; readonly pid: number; readonly runtimeId: string }
export const activeGenerationRuntimes = new Set<string>()
export const generationMachine = hash(hostname())

export function ownerRunning(owner: GenerationOwner): boolean {
  if (owner.machine !== generationMachine) return true
  if (owner.pid === process.pid) return activeGenerationRuntimes.has(owner.runtimeId)
  try { process.kill(owner.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
