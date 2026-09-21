/** Host service and browser discovery entry for the novel-generation bundle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PresetInstaller } from './host/preset-install.js'
import type { PresetStatus } from './types.js'

export type { PresetStatus } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { superNovel: SuperNovel }
}

/** User-initiated preset setup; it never changes the default mode or existing roots. */
export class SuperNovel extends TypertRemoteService {
  static inject = ['agentPresets']
  private readonly installer: PresetInstaller

  constructor(ctx: Context) {
    super(ctx, 'superNovel', { namespace: 'superNovel' })
    this.installer = new PresetInstaller(ctx.agentPresets, fileURLToPath(new URL('../presets/dsh-super-novel/', import.meta.url)), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  }

  /**
   * @param signal - request cancellation.
   * @returns Current setup state without writing files or activating an Agent.
   */
  @Remote
  async status(signal: AbortSignal): Promise<PresetStatus> {
    signal.throwIfAborted()
    return await this.installer.status()
  }

  /**
   * Install the fixed bundled preset following an explicit sidebar action.
   * @param signal - request cancellation; never removes partially written user data.
   * @returns Setup result, including conflicts that require manual resolution.
   */
  @Remote
  async enable(signal: AbortSignal): Promise<PresetStatus> {
    return await this.installer.enable(signal)
  }
}

export default SuperNovel
