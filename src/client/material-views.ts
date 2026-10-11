export interface MaterialFilters { query: string; kind: string; status: string; favorite: boolean; tag: string; linkedChapterId: string; attention: string }
export interface MaterialView { id: string; name: string; filters: MaterialFilters }
export const defaultMaterialFilters = (): MaterialFilters => ({ query: '', kind: 'all', status: 'available', favorite: false, tag: '', linkedChapterId: '', attention: 'all' })
export class MaterialViews {
  private readonly identity: string
  private readonly storage: () => Storage
  constructor(identity: string, storage: () => Storage) { this.identity = identity; this.storage = storage }
  private key(): string { return `super-novel.material-views:${this.identity}` }
  read(): MaterialView[] {
    try {
      const raw = this.storage().getItem(this.key())
      if (!raw || raw.length > 32 * 1024) return []
      const value = JSON.parse(raw)
      if (value.version !== 1 || !Array.isArray(value.views)) return []
      return value.views.slice(0, 20).filter(item => typeof item?.id === 'string' && item.id.length <= 36 && typeof item.name === 'string' && item.name.trim() && item.name.length <= 60 &&
        item.filters && typeof item.filters.query === 'string' && item.filters.query.length <= 500 && typeof item.filters.tag === 'string' && item.filters.tag.length <= 80 &&
        ['all', 'seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene'].includes(item.filters.kind) &&
        ['available', 'active', 'inbox', 'archived', 'trashed', 'all'].includes(item.filters.status) && typeof item.filters.favorite === 'boolean' &&
        typeof item.filters.linkedChapterId === 'string' && (item.filters.linkedChapterId === '' || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item.filters.linkedChapterId)) && ['all', 'untagged', 'unlinked', 'stale'].includes(item.filters.attention))
    } catch { return [] }
  }
  write(views: MaterialView[]): { saved: boolean } {
    try { this.storage().setItem(this.key(), JSON.stringify({ version: 1, views: views.slice(0, 20) })); return { saved: true } }
    catch { return { saved: false } }
  }
}
