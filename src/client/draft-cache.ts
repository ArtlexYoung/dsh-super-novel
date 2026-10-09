// Browser drafts survive panel closure. IndexedDB failures leave the memory copy intact.
const memory = new Map()
let database
export function draftKey(workspaceId, bookId, chapterId, branchId = '') { return `super-novel.draft:${workspaceId}:${bookId}:${chapterId}${branchId ? `:${branchId}` : ''}` }
export function editorBranch() {
  // A document gets its own branch, including tabs duplicated with copied sessionStorage.
  // Reload can recover the previous branch through the recovery panel.
  return crypto.randomUUID()
}
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('super-novel-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => {
      const store = request.result
      store.onversionchange = () => { store.close(); database = undefined }
      resolve(store)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('draft-cache-blocked'))
  }).catch(error => { database = undefined; throw error })
  return await database
}
function key(request) { return draftKey(request.workspaceId, request.bookId, request.chapterId, request.branchId) }
export async function writeCachedDraft(request) {
  const id = key(request)
  const current = memory.get(id)
  if (!current || current.sequence <= request.sequence) memory.set(id, request)
  const store = await db()
  return await new Promise((resolve, reject) => {
    const transaction = store.transaction('drafts', 'readwrite'), records = transaction.objectStore('drafts')
    const read = records.get(id)
    read.onsuccess = () => { if (!read.result || read.result.sequence <= request.sequence) records.put(request, id) }
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('draft-cache-aborted'))
  })
}
export async function readCachedDrafts(workspaceId, bookId, chapterId) {
  const prefix = draftKey(workspaceId, bookId, chapterId) + ':'
  let persisted = []
  let available = true
  try {
    const store = await db()
    persisted = await new Promise((resolve, reject) => {
      const transaction = store.transaction('drafts', 'readonly'), records = transaction.objectStore('drafts'), result = []
      const cursor = records.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'))
      cursor.onsuccess = () => { const item = cursor.result; if (item) { result.push(item.value); item.continue() } }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('draft-cache-aborted'))
    })
  } catch { available = false }
  for (const item of persisted) { if (!memory.has(key(item))) memory.set(key(item), item) }
  return { available, drafts: [...memory.entries()].filter(([id]) => id.startsWith(prefix)).map(([, draft]) => draft).filter(draft =>
    typeof draft?.content === 'string' && typeof draft.baseHash === 'string' && typeof draft.branchId === 'string' && typeof draft.operationId === 'string' && Number.isSafeInteger(draft.bookRevision) && Number.isSafeInteger(draft.sequence)) }
}
export async function forgetCachedDraft(request) {
  const id = key(request)
  if (memory.get(id)?.operationId === request.operationId) memory.delete(id)
  const store = await db()
  return await new Promise((resolve, reject) => {
    const transaction = store.transaction('drafts', 'readwrite'), records = transaction.objectStore('drafts'), read = records.get(id)
    read.onsuccess = () => { if (read.result?.operationId === request.operationId) records.delete(id) }
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('draft-cache-aborted'))
  })
}
