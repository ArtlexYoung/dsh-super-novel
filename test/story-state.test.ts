import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { chapterImpacts } from '../lib/host/chapter-impacts.js'
import { hash } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/story-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root); let book = await books.createBook({ operationId: randomUUID(), title: '五章连续性' }, signal())
  const characters = [randomUUID(), randomUUID()], ids = Array.from({ length: 5 }, () => randomUUID()), texts = [
    '林舟的左腕骨折。他站在渡口，只有两枚铜钱。林舟看见船头刻着一朵白花。',
    '三天前，苏晴把船票藏进柜中。只有苏晴知道柜中的船票。林舟仍在渡口。',
    '林舟用右手交出两枚铜钱，上船后空着口袋。他还不知道船票的去向。',
    '苏晴告诉林舟，船票藏在柜中。林舟现在知道船票的位置。左腕夹板仍在。',
    '船头的白花是渡口暗号，船夫终于向林舟解释。林舟用右手接过信。',
  ]
  const create = async (id, title, kind, content) => { book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: id, expectedRevision: book.revision, action: 'create', title, kind, content, expectedHash: '', beforeChapterId: '' }, signal()) }
  for (const [index,id] of characters.entries()) await create(id, index ? '苏晴' : '林舟', 'character', index ? '保留苏晴人物卡。' : '保留林舟人物卡。')
  for (const [index,id] of ids.entries()) await create(id, `第${index + 1}章`, 'chapter', texts[index])
  const store = await StoryStore.at(root, hash(root), books), proposals = await ProposalStore.at(root, hash(root), books), reviews = await ReviewStore.at(root, hash(root), books)
  const evidence = (index, quote = texts[index]) => ({ chapterId: ids[index], revision: book.chapters.find(item => item.chapterId === ids[index]).revision, hash: hash(texts[index]), start: texts[index].indexOf(quote), end: texts[index].indexOf(quote) + quote.length, quote })
  const save = async value => store.save({ workspaceId: hash(root), bookId: book.bookId, operationId: randomUUID(), expectedVersion: (await store.read(book.bookId)).version, expectedRevision: (await books.readBook(book.bookId)).revision, ...value }, signal())
  const event = (index, changes = [], time = { kind: 'unknown' }) => ({ eventId: randomUUID(), title: `事件${index + 1}`, time, evidence: evidence(index), changes })
  const change = (index, kind, value) => ({ characterId: characters[index], kind, value })
  const generation = (index, extra = {}) => ({ proposalId: randomUUID(), bookId: book.bookId, chapterId: ids[index], expectedRevision: book.revision, expectedHash: hash(texts[index]), mode: 'continue', instruction: '只续写，不新增资源', materials: '', start: texts[index].length, end: texts[index].length, ...extra })
  return { root, books, book, ids, texts, characters, store, proposals, reviews, evidence, save, event, change, generation }
}
test('five chapters preserve narrative versus story order, injuries, resources and character-scoped knowledge; thread resolution requires two quotes', async t => {
  const f = await fixture(t), events = [
    f.event(0, [f.change(0, 'injury', '左腕骨折'),f.change(0,'location','渡口'),f.change(0,'item','两枚铜钱')]),
    f.event(1, [f.change(1,'knowledge','船票藏在柜中')], { kind: 'known', label: '三天前', order: -3 }),
    f.event(2, [f.change(0,'item','铜钱已交出'), f.change(0,'knowledge','仍不知道船票去向')]),
    f.event(3, [f.change(0,'knowledge','得知船票藏在柜中'),f.change(0,'injury','夹板仍在')]),
    f.event(4, [f.change(0,'knowledge','白花是暗号')]),
  ]
  for (const event of events) await f.save({ event })
  const thread = { foreshadowId: randomUUID(), title: '船头白花', note: '计划后续解释', status: 'planned' }
  await f.save({ foreshadow: thread }); await f.save({ foreshadow: { ...thread, status: 'planted', planted: f.evidence(0, '林舟看见船头刻着一朵白花。') } })
  await f.save({ foreshadow: { ...thread, status: 'unresolved', planted: f.evidence(0) } })
  await f.save({ foreshadow: { ...thread, status: 'resolved', planted: f.evidence(0), resolved: f.evidence(4) } })
  const state = await f.store.read(f.book.bookId)
  assert.deepEqual(state.events.map(item => item.evidence.chapterId), f.ids); assert.equal(state.events[0].time.kind, 'unknown'); assert.equal(state.events[1].time.order, -3)
  assert(state.events.every(item => item.state === 'valid')); assert.equal(state.foreshadows[0].status,'resolved')
  const beforeResolution = JSON.parse((await f.store.context(f.book.bookId,f.ids[3],'reader')).content)
  assert.equal(beforeResolution.foreshadows[0].status,'unresolved'); assert.equal(beforeResolution.foreshadows[0].resolved,undefined)
  const lin = JSON.parse((await f.store.context(f.book.bookId,f.ids[2],f.characters[0])).content)
  assert(!JSON.stringify(lin).includes('船票')); assert(lin.events.every(item => !item.evidence && !item.title && item.changes.every(change => change.characterId === f.characters[0])))
  const later = JSON.parse((await f.store.context(f.book.bookId,f.ids[4],f.characters[0])).content)
  assert(later.events.some(item => item.changes.some(change => change.value === '得知船票藏在柜中')))
  await assert.rejects(f.save({ foreshadow: { ...thread, status: 'resolved', planted: f.evidence(4), resolved: f.evidence(0) } }),reason('invalid-evidence'))
  await assert.rejects(f.save({ foreshadow: { ...thread, status: 'planted' } }))
  assert.equal((await f.books.readChapter(f.book.bookId,f.characters[0])).content,'保留林舟人物卡。')
})
test('state queries are pure, saves replay, forged and foreign evidence is rejected, complete backup includes ledger', async t => {
  const f = await fixture(t), folder = join(f.root,'novels',f.book.bookId), before = await readdir(folder)
  assert.equal((await f.store.read(f.book.bookId)).version,0); await f.store.context(f.book.bookId,f.ids[4],'reader'); assert.deepEqual(await readdir(folder),before)
  const input = { workspaceId: hash(f.root), bookId:f.book.bookId, operationId:randomUUID(), expectedVersion:0, expectedRevision:f.book.revision,event:f.event(0) }
  const first = await f.store.save(input,signal()); assert.equal((await f.store.save(input,signal())).version,first.version)
  await assert.rejects(f.store.save({ ...input,operationId:randomUUID() },signal()),reason('revision-conflict'))
  await assert.rejects(f.store.save({ ...input,workspaceId:hash('foreign') },signal()),reason('location-changed'))
  await assert.rejects(f.save({ event:{ ...f.event(1),evidence:{ ...f.evidence(1),quote:'伪造',end:2 } } }))
  await assert.rejects(f.save({ event:{ ...f.event(1),changes:[f.change(0,'knowledge','秘密'),{ ...f.change(0,'item','东西'),characterId:randomUUID() }] } }),reason('invalid-material'))
  const backups = await BackupStore.at(f.root), backup = await backups.create(f.book.bookId,randomUUID(),signal()), preview = await backups.inspect(f.book.bookId,backup.backupId,signal())
  assert(preview.files.some(name => name.includes('/story-state/00000001.json')))
})
test('chapter changes expire related state, facts, summary, material source, candidate and review without rewriting cards', async t => {
  const f = await fixture(t); await f.save({ event:f.event(0,[f.change(0,'injury','左腕骨折')]) })
  const factStore = await FactStore.at(f.root,hash(f.root),f.books), quote='林舟的左腕骨折。'
  const proposed = await factStore.propose({ proposalId:randomUUID(),bookId:f.book.bookId,sourceChapterId:f.ids[0],expectedRevision:f.book.revision,expectedHash:hash(f.texts[0]),coverage:'chapter',
    facts:[{ subject:'林舟',predicate:'伤势',value:'左腕骨折',scope:{kind:'reader'},sourceChapterId:f.ids[0],start:0,end:quote.length,quote }],summary:{text:'左腕骨折，在渡口等船。',start:0,end:quote.length,quote} },signal())
  await factStore.decide(f.book.bookId,proposed.proposalId,proposed.factsHash,true,signal())
  let book=await f.books.readBook(f.book.bookId)
  // New material has an exact source citation; strict v2 is enabled explicitly.
  book=await f.books.upgrade(book.bookId,book.revision,randomUUID(),signal())
  const materialId=randomUUID()
  book=await f.books.mutate({bookId:book.bookId,operationId:randomUUID(),chapterId:materialId,expectedRevision:book.revision,action:'create',title:'来源资料',kind:'seed',content:'伤势摘录',expectedHash:'',beforeChapterId:'',sourceEvidence:f.evidence(0)},signal())
  const request={ ...f.generation(2,{materialIds:[materialId],precedingChapterIds:[f.ids[0]],useStoryState:true}),expectedRevision:book.revision }
  await f.proposals.create('a',request,signal()); await f.proposals.checkpoint(book.bookId,request.proposalId,'继续。','review','',{state:'unknown'},1)
  const candidate=await f.proposals.view(book.bookId,request.proposalId,false)
  await f.reviews.run({reviewId:randomUUID(),bookId:book.bookId,chapterId:f.ids[2],proposalId:candidate.proposalId,expectedRevision:book.revision,expectedHash:candidate.candidateHash,minCharacters:0,maxCharacters:0,minParagraphs:0,maxParagraphs:0},false,signal())
  book=await f.books.mutate({bookId:book.bookId,operationId:randomUUID(),chapterId:f.ids[0],expectedRevision:book.revision,action:'save',title:'',content:'林舟左腕已经愈合。',expectedHash:hash(f.texts[0]),beforeChapterId:''},signal())
  assert.equal((await f.store.read(book.bookId)).events[0].state,'expired'); assert.equal((await f.store.context(book.bookId,f.ids[3],'reader')).state,'expired')
  const impacts=await chapterImpacts(f.root,hash(f.root),f.books,book.bookId,f.ids[0],signal())
  assert.equal(impacts.complete,true)
  for(const kind of ['facts','summary','material','proposal','review','event'])assert(impacts.items.some(item=>item.kind===kind&&item.state==='expired'),kind)
  assert.equal((await f.books.readChapter(book.bookId,f.characters[0])).content,'保留林舟人物卡。')
  const current=await f.books.readChapter(book.bookId,f.ids[0]), event=(await f.store.read(book.bookId)).events[0]
  const { state,narrativeOrder,...record }=event
  await f.save({event:{...record,evidence:{chapterId:f.ids[0],revision:current.book.chapters.find(item=>item.chapterId===f.ids[0]).revision,hash:current.hash,start:0,end:current.content.length,quote:current.content},changes:[f.change(0,'injury','左腕已经愈合')]}})
  assert.equal((await f.store.context(book.bookId,f.ids[3],'reader')).state,'ready')
  assert.equal((await f.proposals.view(book.bookId,request.proposalId,false)).state,'expired')
})
test('unrelated chapter edits preserve candidates and reviews; adoption and issue revision bind current book revision', async t => {
  const f=await fixture(t), request=f.generation(1)
  await f.proposals.create('a',request,signal());await f.proposals.checkpoint(f.book.bookId,request.proposalId,'继续。','review','',{state:'unknown'},1)
  const review=await f.reviews.run({reviewId:randomUUID(),bookId:f.book.bookId,chapterId:f.ids[0],proposalId:'',expectedRevision:f.book.revision,expectedHash:hash(f.texts[0]),minCharacters:1000,maxCharacters:0,minParagraphs:0,maxParagraphs:0},false,signal())
  const book=await f.books.mutate({bookId:f.book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:f.book.revision,action:'save',title:'',content:'第五章无关修改。',expectedHash:hash(f.texts[4]),beforeChapterId:''},signal())
  const view=await f.proposals.view(book.bookId,request.proposalId,false);assert.equal(view.state,'review')
  assert.notEqual((await f.reviews.list(book.bookId,f.ids[0]))[0].state,'expired')
  assert.equal((await f.reviews.revision(book.bookId,review.reviewId,review.issues[0].issueId)).request.expectedRevision,book.revision)
  const accepted=await f.proposals.decide({bookId:book.bookId,proposalId:view.proposalId,expectedCandidateHash:view.candidateHash},true,signal())
  assert.equal(accepted.state,'accepted');assert.equal((await f.books.readBook(book.bookId)).revision,book.revision+1)
  assert.equal((await f.proposals.decide({bookId:book.bookId,proposalId:view.proposalId,expectedCandidateHash:view.candidateHash},true,signal())).state,'accepted')
})
test('rebased adoption receipt survives each interrupted publication stage exactly once', async t => {
  for(const stage of ['prepared','chapter','manifest','completed']) {
    const f=await fixture(t),request=f.generation(1)
    await f.proposals.create('a',request,signal());await f.proposals.checkpoint(f.book.bookId,request.proposalId,'继续。','review','',{state:'unknown'},1)
    const book=await f.books.mutate({bookId:f.book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:f.book.revision,action:'rename',title:'末章改名',content:'',expectedHash:'',beforeChapterId:''},signal())
    const view=await f.proposals.view(book.bookId,request.proposalId,false),decision={bookId:book.bookId,proposalId:view.proposalId,expectedCandidateHash:view.candidateHash}
    const broken=await ProposalStore.at(f.root,hash(f.root),await BookStore.at(f.root,{afterStage:async value=>{if(value===stage)throw new Error('fault')}}))
    await assert.rejects(broken.decide(decision,true,signal()),/fault/)
    if(stage!=='completed')await f.books.recover(book.bookId,signal())
    assert.equal((await f.proposals.decide(decision,true,signal())).state,'accepted');assert.equal((await f.books.readBook(book.bookId)).revision,book.revision+1)
  }
})
test('AI suggestions stay unconfirmed, do not invent time, validate quotes and character IDs, and replay without another call', async t => {
  const f=await fixture(t),request={workspaceId:hash(f.root),bookId:f.book.bookId,chapterId:f.ids[0],proposalId:randomUUID(),expectedRevision:f.book.revision,expectedHash:hash(f.texts[0])}
  let calls=0
  const generate=async prompt=>{calls++;assert.equal(JSON.parse(prompt).task,'suggest-chapter-state');return {replacement:JSON.stringify({events:[{title:'左腕骨折',evidence:{start:0,end:10,quote:f.texts[0].slice(0,10)},changes:[f.change(0,'injury','左腕骨折')]}],foreshadows:[]}),complete:true,reason:'',usage:{state:'unknown'}}}
  const value=await f.store.suggest(request,generate,signal());assert.equal(value.state,'review');assert.equal(value.events[0].time.kind,'unknown')
  assert.equal((await f.store.read(f.book.bookId)).events.length,0);await f.store.suggest(request,generate,signal());assert.equal(calls,1)
  await assert.rejects(f.store.suggest({...request,proposalId:randomUUID()},async()=>({replacement:JSON.stringify({events:[{title:'伪造',evidence:{start:0,end:2,quote:'伪造'},changes:[]}],foreshadows:[]}),complete:true,reason:'',usage:{state:'unknown'}}),signal()),reason('invalid-evidence'))
  await f.save({event:value.events[0]});assert.equal((await f.store.read(f.book.bookId)).events.length,1)
  await writeFile(join(f.root,'novels',f.book.bookId,'chapters',`${f.ids[0]}.md`),'外部改稿')
  assert.equal((await f.store.suggestions(f.book.bookId,f.ids[0]))[0].state,'expired')
})

test('changed preceding selection expires facts and prose snapshots even when old source hashes remain unchanged', async t => {
  const f = await fixture(t), facts = await FactStore.at(f.root,hash(f.root),f.books)
  for (const index of [0,1]) {
    const book = await f.books.readBook(f.book.bookId), quote = f.texts[index]
    const value = await facts.propose({proposalId:randomUUID(),bookId:book.bookId,sourceChapterId:f.ids[index],expectedRevision:book.revision,expectedHash:hash(quote),coverage:'chapter',
      facts:[{subject:'本章',predicate:'记录',value:quote,scope:{kind:'reader'},sourceChapterId:f.ids[index],start:0,end:quote.length,quote}]},signal())
    await facts.decide(book.bookId,value.proposalId,value.factsHash,true,signal())
  }
  let book = await f.books.readBook(f.book.bookId)
  const requests = [f.generation(2,{useFacts:true}),f.generation(2,{precedingChapterIds:[f.ids[0]]})]
  for (const request of requests) {
    request.expectedRevision = book.revision
    await f.proposals.create('a',request,signal()); await f.proposals.checkpoint(book.bookId,request.proposalId,'继续。','review','',{state:'unknown'},1)
    assert.equal((await f.proposals.view(book.bookId,request.proposalId,false)).state,'review')
  }
  book = await f.books.mutate({bookId:book.bookId,operationId:randomUUID(),chapterId:f.ids[0],expectedRevision:book.revision,action:'move',beforeChapterId:f.ids[3],content:'',title:'',expectedHash:''},signal())
  for (const request of requests) assert.equal((await f.proposals.view(book.bookId,request.proposalId,false)).state,'expired')
  assert.equal((await f.books.readChapter(book.bookId,f.ids[0])).hash,hash(f.texts[0]))
  // A newly preceding nonempty chapter also makes a formerly complete selection incomplete.
  const empty = f.generation(1,{useFacts:true,expectedRevision:book.revision})
  await f.proposals.create('a',empty,signal()); await f.proposals.checkpoint(book.bookId,empty.proposalId,'继续。','review','',{state:'unknown'},1)
  await f.books.mutate({bookId:book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:book.revision,action:'move',beforeChapterId:f.ids[1],content:'',title:'',expectedHash:''},signal())
  assert.equal((await f.proposals.view(book.bookId,empty.proposalId,false)).state,'expired')
})

test('future resolution edits do not leak into earlier context; reordered resolutions require reconfirmation', async t => {
  const f = await fixture(t), thread = {foreshadowId:randomUUID(),title:'白花',note:'',status:'resolved',planted:f.evidence(0),resolved:f.evidence(4)}
  await f.save({foreshadow:thread})
  const before = await f.store.context(f.book.bookId,f.ids[3],'reader')
  let book = await f.books.mutate({bookId:f.book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:f.book.revision,action:'save',beforeChapterId:'',content:'回收章节改写。',title:'',expectedHash:hash(f.texts[4])},signal())
  const after = await f.store.context(book.bookId,f.ids[3],'reader')
  assert.equal(after.state,'ready'); assert.equal(after.hash,before.hash)
  const current = await f.books.readChapter(book.bookId,f.ids[4])
  await f.save({foreshadow:{...thread,resolved:{...thread.resolved,revision:current.book.chapters.find(item=>item.chapterId===f.ids[4]).revision,hash:current.hash,start:0,end:current.content.length,quote:current.content}}})
  book = await f.books.mutate({bookId:book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:book.revision,action:'move',beforeChapterId:f.ids[0],content:'',title:'',expectedHash:''},signal())
  assert.equal((await f.store.read(book.bookId)).foreshadows[0].state,'expired')
  assert.equal((await f.store.context(book.bookId,f.ids[3],'reader')).state,'expired')
})

test('foreshadow-only and empty suggestions bind source revision; corrupt or future ledger formats are refused', async t => {
  const f = await fixture(t), request = {workspaceId:hash(f.root),bookId:f.book.bookId,chapterId:f.ids[0],proposalId:randomUUID(),expectedRevision:f.book.revision,expectedHash:hash(f.texts[0])}
  const generator = output => async () => ({replacement:JSON.stringify(output),complete:true,reason:'',usage:{state:'unknown'}})
  const onlyThread = await f.store.suggest(request,generator({events:[],foreshadows:[{title:'白花',note:'核对',evidence:{start:0,end:10,quote:f.texts[0].slice(0,10)}}]}),signal())
  assert.equal(onlyThread.state,'review')
  await f.store.suggest({...request,proposalId:randomUUID()},generator({events:[],foreshadows:[]}),signal())
  await f.books.mutate({bookId:f.book.bookId,operationId:randomUUID(),chapterId:f.ids[0],expectedRevision:f.book.revision,action:'save',beforeChapterId:'',content:f.texts[0],title:'',expectedHash:hash(f.texts[0])},signal())
  assert((await f.store.suggestions(f.book.bookId,f.ids[0])).every(item=>item.state==='expired'))
  await f.save({event:f.event(1)})
  const path = join(f.root,'novels',f.book.bookId,'story-state','00000001.json'), original = JSON.parse(await readFile(path,'utf8'))
  await writeFile(path,JSON.stringify({...original,version:9})); await assert.rejects(f.store.read(f.book.bookId),reason('unsupported-format'))
  await writeFile(path,'null'); await assert.rejects(f.store.read(f.book.bookId),reason('invalid-format'))
  await writeFile(path,JSON.stringify({...original,events:[original.events[0],original.events[0]]})); await assert.rejects(f.store.read(f.book.bookId),reason('invalid-format'))
  await writeFile(path,JSON.stringify({...original,events:[]})); await assert.rejects(f.store.read(f.book.bookId),reason('invalid-format'))
  await writeFile(path,JSON.stringify(original)); await f.save({event:f.event(2)})
  await rm(path); await writeFile(join(f.root,'novels',f.book.bookId,'story-state','00000000.json'),JSON.stringify(original))
  await assert.rejects(f.store.read(f.book.bookId),reason('invalid-format'))
})

test('large impact lists are bounded and marked incomplete rather than silently claiming full coverage', async t => {
  const f = await fixture(t)
  await f.save({event:f.event(0)})
  await f.save({foreshadow:{foreshadowId:randomUUID(),title:'白花',note:'',status:'planted',planted:f.evidence(0)}})
  const path = join(f.root,'novels',f.book.bookId,'story-state','00000002.json'), record = JSON.parse(await readFile(path,'utf8'))
  record.events = Array.from({length:1000},(_,index)=>({...record.events[0],eventId:randomUUID(),title:`事件 ${index}`}))
  await writeFile(path,JSON.stringify(record))
  const before = await readdir(join(f.root,'novels',f.book.bookId))
  const result = await chapterImpacts(f.root,hash(f.root),f.books,f.book.bookId,f.ids[0],signal())
  assert.equal(result.complete,false); assert.equal(result.items.length,1000)
  assert.deepEqual(await readdir(join(f.root,'novels',f.book.bookId)),before)
})

test('pending book recovery prevents model suggestions even when the target prose is unchanged', async t => {
  const f = await fixture(t), broken = await BookStore.at(f.root,{afterStage:async stage=>{if(stage==='prepared')throw new Error('fault')}})
  await assert.rejects(broken.mutate({bookId:f.book.bookId,operationId:randomUUID(),chapterId:f.ids[4],expectedRevision:f.book.revision,action:'save',beforeChapterId:'',content:'待恢复的新末章',title:'',expectedHash:hash(f.texts[4])},signal()),/fault/)
  const request = {workspaceId:hash(f.root),bookId:f.book.bookId,chapterId:f.ids[0],proposalId:randomUUID(),expectedRevision:f.book.revision,expectedHash:hash(f.texts[0])}
  let calls = 0
  await assert.rejects(f.store.suggest(request,async()=>{calls++;throw new Error('must not call')},signal()),reason('recovery-required'))
  assert.equal(calls,0)
})

test('invalid or oversized model output leaves no unreadable suggestion file and reports the actual failure', async t => {
  const f = await fixture(t), request = {workspaceId:hash(f.root),bookId:f.book.bookId,chapterId:f.ids[0],proposalId:randomUUID(),expectedRevision:f.book.revision,expectedHash:hash(f.texts[0])}
  const generator = replacement => async()=>({replacement,complete:true,reason:'',usage:{state:'unknown'}})
  await assert.rejects(f.store.suggest(request,generator('not JSON'),signal()),reason('invalid-output'))
  await assert.rejects(f.store.suggest(request,generator('{"events":[]}'),signal()),reason('invalid-output'))
  const evidence = {start:0,end:f.texts[0].length,quote:f.texts[0]}, changes = Array.from({length:100},()=>f.change(0,'item','物'.repeat(2000)))
  const output = {events:Array.from({length:50},()=>({title:'过大记录',evidence,changes})),foreshadows:[]}
  await assert.rejects(f.store.suggest(request,generator(JSON.stringify(output)),signal()),reason('too-large'))
  assert.deepEqual(await f.store.suggestions(f.book.bookId,f.ids[0]),[])
})
