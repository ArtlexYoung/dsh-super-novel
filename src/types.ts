/** Public status contains no private filesystem paths. */
export interface PresetStatus {
  readonly state: 'available' | 'enabled' | 'conflict' | 'unavailable' | 'busy' | 'incomplete'
  readonly reason: string
}
