/** Adapt the two public preset lifecycles without changing the author's default. */
import type { Context } from '@deepseek-ai/cordis'
import type { PresetStatus } from '../types.js'
import { PRESET_ID, PresetInstaller } from './preset-install.js'
import type { PresetHost } from './preset-install.js'

interface PresetSetup {
  status(): Promise<PresetStatus>
  enable(signal: AbortSignal): Promise<PresetStatus>
}

export interface PresetRegistry {
  list(): Promise<readonly { readonly id: string; readonly broken?: string }[]>
  register(definition: {
    readonly id: string; readonly name: string; readonly description: string; readonly order: number
    readonly plugins: readonly { readonly id: string; readonly name: string }[]
  }): Promise<() => Promise<void>>
}

/** 0.2 presets are plugin-owned declarations, automatically retired on unload. */
class RegisteredPreset implements PresetSetup {
  private readonly ready: Promise<() => Promise<void>>

  constructor(ctx: Context, private readonly host: PresetRegistry) {
    this.ready = host.register({
      id: PRESET_ID, name: 'Super Novel · 小说生成',
      description: 'Novel generation with chapter planning, author voice, and explicit continuity checks.',
      order: 20, plugins: [{ id: 'super-novel-persona', name: 'dsh-super-novel/preset' }],
    })
    ctx.effect(() => this.ready, 'super-novel: registered writing preset')
  }

  async status(): Promise<PresetStatus> {
    await this.ready
    const row = (await this.host.list()).find(item => item.id === PRESET_ID)
    return row && !row.broken ? { state: 'enabled', reason: 'ready' }
      : { state: 'unavailable', reason: 'host-discovery-failed' }
  }

  async enable(signal: AbortSignal): Promise<PresetStatus> {
    signal.throwIfAborted()
    return await this.status()
  }
}

export function createPresetSetup(ctx: Context, host: PresetHost | PresetRegistry, source: string, version: string): PresetSetup {
  if ('roots' in host && Array.isArray(host.roots)) return new PresetInstaller(host as PresetHost, source, version)
  if ('register' in host && typeof host.register === 'function') return new RegisteredPreset(ctx, host)
  throw new Error('Unsupported Host preset service')
}
