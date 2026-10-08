/** Public status contains no private filesystem paths. */
export interface PresetStatus {
  readonly state: 'available' | 'enabled' | 'conflict' | 'unavailable' | 'busy' | 'incomplete'
  readonly reason: string
}

export interface ChapterSummary {
  readonly chapterId: string
  readonly title: string
  readonly revision: number
  readonly hash: string
}
export interface BookSnapshot {
  readonly schemaVersion: 1
  readonly bookId: string
  readonly title: string
  readonly revision: number
  readonly chapters: readonly ChapterSummary[]
  readonly recoveryRequired: boolean
}
export interface LibrarySnapshot {
  readonly workspace: string
  readonly workspaceId: string
  readonly writable: boolean
  readonly books: readonly BookSnapshot[]
}
export interface ChapterText {
  readonly book: BookSnapshot
  readonly chapterId: string
  readonly content: string
  readonly hash: string
  readonly externallyModified: boolean
}
export interface CreateBookRequest { readonly operationId: string; readonly title: string }
export interface ChapterMutationRequest {
  readonly operationId: string
  readonly bookId: string
  readonly expectedRevision: number
  readonly action: 'create' | 'rename' | 'move' | 'save'
  readonly chapterId: string
  readonly title: string
  readonly beforeChapterId: string
  readonly content: string
  readonly expectedHash: string
}
