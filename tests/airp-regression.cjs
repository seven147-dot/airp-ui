const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'airp-core.js'), 'utf8').replace(/\bexport /g, '');
const storageSource = fs.readFileSync(path.join(root, 'airp-storage.js'), 'utf8').replace(/\bexport /g, '');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', '"file:///airp/index.js"').replace('export async function onActivate', 'async function onActivate');

function fixture() {
    const storage = new Map();
    const inputs = new Map();
    const context = { name1: '玩家', characters: [], chat: [], chatMetadata: {}, characterId: 0, getCurrentChatId: () => 'test-chat', saveMetadata: async () => {}, saveChat: async () => {}, getThumbnailUrl: () => '' };
    const box = { Date, Math, JSON, Map, Set, WeakMap, WeakSet, URL, crypto: require('node:crypto').webcrypto,
        console: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        SillyTavern: { getContext: () => context }, document: { getElementById: id => inputs.get(id) ?? null, querySelectorAll: () => [] },
    };
    vm.createContext(box);
    vm.runInContext(core + '\n' + storageSource + '\n' + source, box);
    vm.runInContext('globalThis.renderRealView = renderCurrentView; globalThis.state = createDefaultState(); normalizeState(state); SillyTavern.getContext().chatMetadata.airp = state; refreshAirpStatePrompt = async () => ""; renderCurrentView = async () => {};', box);
    const run = code => vm.runInContext(code, box);
    const npc = (id, friend = true) => run(`state.characters[${JSON.stringify(id)}] = {...createNpcCharacter(${JSON.stringify(id)}), id:${JSON.stringify(id)}, contactStatus:${JSON.stringify(friend ? 'friend' : 'known')}}`);
    return { context, box, run, npc, inputs, storage, get state() { return context.chatMetadata.airp; } };
}

const cases = [];
function test(name, execute) { cases.push([name, execute]); }

test('long-term memory builds prompt and integrity detects missing references', () => {
    const f = fixture(); f.npc('a');
    f.run('state.memory.world.push({id:"m",eventId:"missing",text:"记忆"});state.memory.characters.a=[{eventId:"missing",text:"个人记忆"}];');
    assert.doesNotThrow(() => f.run('buildAirpContextBlock(state)'));
    assert.equal(f.run('runStateIntegrityCheck(state).issueCount'), 2);
});
test('non-friends cannot send private messages or view moments', () => {
    const f = fixture(); f.npc('a', false);
    assert.throws(() => f.run('appendPrivateMessage(state,{senderId:"player",receiverId:"a",text:"你好"})'), /未加好友/);
    assert.equal(f.run('canViewMoment(state,{authorId:"a"})'), false);
});
test('moments spread only to friends', () => {
    const f = fixture(); f.npc('a'); f.npc('b', false);
    f.run('addEventToState(state,{summary:"玩家动态",channel:"moments",visibility:"social",participants:[],tags:["玩家发布"]})');
    assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.pendingExposures.map(x=>x.characterId))')), ['a']);
});
test('private message stays pending, creates reaction and includes receiver card', async () => {
    const f = fixture(); for (let i = 0; i < 12; i++) f.npc('npc_' + i);
    f.inputs.set('airp-chat-compose-input', { value: '新私聊唯一文本' });
    await f.run('sendPlayerPrivateMessage("npc_0")');
    assert.equal(f.state.reactions.length, 1);
    assert.equal(f.run('getRelevantCharacterIdsForPrompt(state).has("npc_0")'), true);
    assert.match(f.run('buildAirpContextBlock(state)'), /PENDING PRIVATE MESSAGES[\s\S]*新私聊唯一文本/);
});
test('reply writes into phone and resolves pending private messages', async () => {
    const f = fixture(); f.npc('a');
    f.run('appendPrivateMessage(state,{senderId:"player",receiverId:"a",text:"今晚见吗？"})');
    await f.run('applyStateDelta({social:[{authorId:"a",type:"private_chat",targetCharacterId:"player",text:"好，今晚见。"}]})');
    assert.equal(f.state.messages.a.length, 2);
    assert.equal(f.state.messages.a[0].processingStatus, 'handled');
});
test('model creates reusable NPC and resolves same-turn references', async () => {
    const f = fixture();
    await f.run('applyStateDelta({npcs:[{ref:"new_a",name:"林同学",profile:{identity:"摄影社",signature:"先试试看"}}],world:{presentCharacterIds:["new_a"]},social:[{authorId:"new_a",type:"forum",title:"招新",text:"今晚活动室开放"}]})');
    const [id] = Object.keys(f.state.characters);
    assert.equal(f.state.world.presentCharacterIds[0], id);
    assert.equal(f.state.forum[0].authorId, id);
    assert.equal(f.state.characters[id].profile.signature, '先试试看');
    await f.run('applyStateDelta({npcs:[{ref:"again",name:"林同学"}]})');
    assert.equal(Object.keys(f.state.characters).length, 1);
});
test('manual profile fields stay protected', async () => {
    const f = fixture(); f.npc('a');
    f.run('state.characters.a.profile.signature="手写签名";state.characters.a.profileMeta.locked.signature=true;');
    await f.run('applyStateDelta({profileUpdates:[{characterId:"a",profile:{signature:"覆盖",identity:"学生"}}]})');
    assert.equal(f.state.characters.a.profile.signature, '手写签名');
    assert.equal(f.state.characters.a.profile.identity, '学生');
});
test('forum body, comments and knowledge interpretations reach context', () => {
    const f = fixture(); f.npc('a');
    f.run('const m=appendMoment(state,{authorId:"a",text:"动态"});addMomentComment(state,m.id,{authorId:"player",text:"唯一评论"});appendForumPost(state,{authorId:"a",title:"标题",text:"唯一正文"});const e=addEventToState(state,{summary:"世界真相",participants:["a"]});state.characters.a.knowledge[e.id].interpretation="误解版本";state.world.presentCharacterIds=["a"];');
    const prompt = f.run('buildAirpContextBlock(state)');
    for (const text of ['唯一评论', '唯一正文', '误解版本']) assert.ok(prompt.includes(text));
});
test('like without execute is safe and keeps original event link', async () => {
    const f = fixture(); f.npc('a');
    f.run('globalThis.e=addEventToState(state,{summary:"动态",participants:["a"]});globalThis.m=appendMoment(state,{authorId:"a",text:"日常",eventId:e.id});');
    await f.run('applyStateDelta({reactions:[{characterId:"a",eventId:e.id,action:{type:"moment_like",targetArtifactId:m.id,timing:"now"}}]})');
    assert.equal(f.state.moments[0].eventId, f.run('e.id'));
    assert.ok(f.state.moments[0].likes.includes('a'));
});
test('same event dimension cannot be applied twice', async () => {
    const f = fixture();
    f.run('state.characters.a={...createCharacterFromCard({name:"A",avatar:"a.png"}),id:"a"};globalThis.e=addEventToState(state,{summary:"事件",participants:["a"]});');
    await f.run('applyStateDelta({relationChanges:[{characterId:"a",eventId:e.id,changes:{trust:3}},{characterId:"a",eventId:e.id,changes:{trust:3}}],reactions:[{characterId:"a",eventId:e.id,relationChanges:{trust:3}}]})');
    assert.equal(f.state.characters.a.relation.trust, 3);
});
test('invalid schema does not partially mutate live state', async () => {
    const f = fixture();
    await assert.rejects(f.run('applyStateDelta({world:{location:"不应生效"},reactions:[null]})'));
    assert.equal(f.state.world.location, '');
});
test('failed save leaves original state and raw block recoverable; retry applies once', async () => {
    const f = fixture(); await f.run('ensureState()');
    f.context.chat.push({ is_user: false, send_date: 'unique', mes: '正文<AIRP_STATE>{"world":{"location":"侧廊"}}</AIRP_STATE>' });
    f.context.saveMetadata = async () => { throw new Error('offline'); };
    assert.equal(await f.run('processAssistantStateBlock(0)'), false);
    assert.equal(f.state.world.location, '');
    assert.ok(f.context.chat[0].mes.includes('<AIRP_STATE>'));
    assert.ok([...f.storage.values()].some(value => value.includes('侧廊')));
    f.context.saveMetadata = async () => {};
    await f.run('retryAirpSave()');
    assert.equal(f.state.world.location, '侧廊');
    assert.equal(f.state.safety.historyCheckpoints.length, 1);
    assert.equal(f.context.chat[0].extra.airp.applied, true);
});
test('false save response is treated as a failure', async () => {
    const f = fixture(); await f.run('ensureState()'); f.context.saveMetadata = async () => false;
    await assert.rejects(f.run('saveState(state)'));
    assert.equal(f.state.runtime.saveStatus, 'failed');
});
test('switching chat cannot commit old reply to the new world', async () => {
    const f = fixture();
    f.context.chat.push({is_user:false,mes:'正文<AIRP_STATE>{"world":{"location":"A的地点"}}</AIRP_STATE>'});
    const old = f.state;
    f.context.saveMetadata = async () => { f.context.chatMetadata = {airp: {...old, world:{...old.world,location:'B的地点'}}}; f.context.getCurrentChatId = () => 'B'; };
    await f.run('processAssistantStateBlock(0)');
    assert.equal(f.state.world.location, 'B的地点');
});
test('history keeps more than six compact checkpoints and reconstructs first turn', () => {
    const f = fixture();
    f.run('for(let i=0;i<15;i++){const before=createDynamicStateSnapshot(state);state.world.location="地点"+i;addEventToState(state,{summary:"事件"+i});addHistoryCheckpoint(state,{messageId:i,before,after:createDynamicStateSnapshot(state)});}');
    assert.equal(f.state.safety.historyCheckpoints.length, 15);
    assert.equal(f.run('getCheckpointById(state,state.safety.historyCheckpoints[0].id).after.world.location'), '地点0');
    assert.equal('after' in f.state.safety.historyCheckpoints[0], false);
});
test('rollback preserves player messages and removes model-created NPCs', () => {
    const f = fixture(); f.npc('a');
    f.run('globalThis.before=createDynamicStateSnapshot(state);state.characters.newNpc={...createNpcCharacter("新NPC"),id:"newNpc",source:{type:"model-npc"}};appendPrivateMessage(state,{senderId:"player",receiverId:"a",text:"保留这条"});const e=addEventToState(state,{summary:"玩家私聊",participants:["a"],audienceCharacterIds:["a"],channel:"private_chat",tags:["玩家发送"]});state.messages.a[0].eventId=e.id;restoreDynamicStateSnapshot(state,before);');
    assert.equal(f.state.messages.a.length, 1);
    assert.equal(f.state.characters.newNpc, undefined);
    assert.equal(f.state.events.length, 1);
});
test('undo/redo restores original event IDs and checkpoint', async () => {
    const f = fixture();
    f.context.chat.push({is_user:false,send_date:'turn',mes:'正文<AIRP_STATE>{"events":[{"ref":"e","summary":"一次事件"}]}</AIRP_STATE>'});
    await f.run('processAssistantStateBlock(0)'); const id = f.state.events[0].id;
    await f.run('undoLastAutoUpdate()'); assert.equal(f.state.events.length, 0);
    await f.run('redoLastAutoUpdate()'); assert.equal(f.state.events[0].id, id);
    assert.equal(f.state.safety.activeCheckpointId, f.state.safety.historyCheckpoints[0].id);
});
test('balanced truncation keeps last section and stays within budget', () => {
    const f = fixture();
    const output = f.run('balancedText("# 开头\\n"+"甲".repeat(2000)+"\\n# 日历\\n末尾日期规则",300)');
    assert.ok(output.includes('日历') && output.includes('末尾日期规则'));
    assert.ok(output.length <= 300);
});

test('same-turn friend exchange allows immediate private reply', async () => {
    const f = fixture(); f.npc('a', false);
    await f.run('applyStateDelta({events:[{ref:"exchange",summary:"双方交换联系方式",participants:["player","a"]}],friendships:[{characterId:"a",status:"friend",eventRef:"exchange",reason:"双方同意加好友"}],social:[{type:"private_chat",authorId:"a",targetCharacterId:"player",text:"这是我的账号"}]})');
    assert.equal(f.state.characters.a.contactStatus, 'friend');
    assert.equal(f.state.messages.a.length, 1);
});
test('card initialization fills public profile and existing relationship once', async () => {
    const f = fixture(); f.run('state.characters.a={...createCharacterFromCard({name:"A",avatar:"a.png"}),id:"a"}');
    await f.run('applyStateDelta({characterInitializations:[{characterId:"a",profile:{identity:"学生",signature:"慢慢来"},relation:{trust:15},contactStatus:"friend",reason:"角色卡明确说明与玩家是多年好友"}]})');
    assert.equal(f.state.characters.a.profile.identity, '学生');
    assert.equal(f.state.characters.a.relation.trust, 15);
    await f.run('applyStateDelta({characterInitializations:[{characterId:"a",relation:{trust:99},reason:"重复初始化"}]})');
    assert.equal(f.state.characters.a.relation.trust, 15);
});
test('social switch stops ambient posts but keeps replies', async () => {
    const f = fixture(); f.npc('a'); f.run('state.settings.socialGenerationEnabled=false');
    await f.run('applyStateDelta({social:[{type:"forum",authorId:"a",text:"日常"},{type:"private_chat",authorId:"a",targetCharacterId:"player",text:"回复"}]})');
    assert.equal(f.state.forum.length, 0);
    assert.equal(f.state.messages.a.length, 1);
});
test('missed exposure is archived and not spuriously recreated by rollback', async () => {
    const f = fixture(); f.npc('a');
    f.run('const e=addEventToState(state,{summary:"动态",channel:"moments",visibility:"social",tags:["玩家发布"]});globalThis.exposureId=state.pendingExposures[0].id;');
    await f.run('applyStateDelta({exposures:[{exposureId,outcome:"missed",interpretation:"没刷手机"}]})');
    f.run('state=SillyTavern.getContext().chatMetadata.airp;restoreDynamicStateSnapshot(state,createDynamicStateSnapshot(state))');
    assert.equal(f.state.exposureHistory[0].outcome, 'missed');
    assert.equal(f.state.pendingExposures.length, 0);
});
test('anonymous labels are valid and notifications do not expose author', () => {
    const f = fixture(); f.npc('realAuthor');
    f.run('globalThis.p=appendForumPost(state,{authorId:"player",text:"帖子"});globalThis.r=addForumReply(state,p.id,{authorId:"realAuthor",text:"匿名回答",anonymous:true});');
    assert.ok(!f.run('r.anonymousLabel').includes('NaN'));
    assert.ok(f.state.notifications[0].anonymousLabel);
    assert.ok(!f.run('renderNotifications(state)').includes('<strong>realAuthor</strong>'));
});
test('reading private chat clears matching notification too', () => {
    const f = fixture(); f.npc('a');
    f.run('appendPrivateMessage(state,{senderId:"a",receiverId:"player",text:"你好"});markThreadRead(state,"a")');
    assert.equal(f.state.notifications[0].read, true);
    assert.equal(f.state.messages.a[0].read, true);
});
test('manual world basis does not overwrite later model state during redo', async () => {
    const f = fixture();
    f.run('state.world.location="手动地点";state.safety.manualWorld={...state.world};state.safety.manualWorldVersion="manual1";');
    f.context.chat.push({is_user:false,send_date:'world',mes:'正文<AIRP_STATE>{"world":{"location":"模型新地点"}}</AIRP_STATE>'});
    await f.run('processAssistantStateBlock(0)');
    await f.run('undoLastAutoUpdate()'); assert.equal(f.state.world.location, '手动地点');
    await f.run('redoLastAutoUpdate()'); assert.equal(f.state.world.location, '模型新地点');
});
test('compact array patch preserves modifications, appends and reorderings', () => {
    const f = fixture();
    f.run('globalThis.a={items:[{id:"x",status:"pending"}]};globalThis.b={items:[{id:"x",status:"done"},{id:"y",status:"pending"}]};');
    assert.equal(f.run('JSON.stringify(applyPatch(a,diffState(a,b)))'), f.run('JSON.stringify(b)'));
    f.run('globalThis.c={items:[b.items[1],b.items[0]]}');
    assert.equal(f.run('JSON.stringify(applyPatch(b,diffState(b,c)))'), f.run('JSON.stringify(c)'));
});
test('concurrent state initialization shares one preparation and one revision', async () => {
    const f = fixture(); let saves = 0;
    f.run('state.settings.newMissingField=undefined;delete state.settings.socialGenerationEnabled;');
    f.context.saveMetadata = async () => { saves++; };
    const states = await f.run('Promise.all([ensureState(),ensureState(),ensureState()])');
    assert.equal(states[0], states[1]); assert.equal(states[1], states[2]);
    assert.equal(saves, 1);
});
test('startup interface refresh uses the correct chat owner', async () => {
    const f = fixture(); f.box.document.body = {classList:{toggle(){}}};
    await f.run('refreshAirpInterfaceState()');
});
test('non-friend profile hides moments and disables message buttons', () => {
    const f = fixture(); f.npc('a', false);
    f.run('appendMoment(state,{authorId:"a",text:"隐藏的动态正文"})');
    const html = f.run('renderProfile(state,"a")');
    assert.ok(!html.includes('隐藏的动态正文'));
    assert.match(html, /data-airp-action="profile-chat"[^>]*disabled/);
    assert.ok(html.includes('申请好友'));
});
test('phone renders archived chat without a send composer after unfriending', async () => {
    const f = fixture(); f.npc('a');
    f.run('appendPrivateMessage(state,{senderId:"player",receiverId:"a",text:"历史消息"});state.characters.a.contactStatus="known";currentView={page:"chat",characterId:"a"};');
    const content = {innerHTML:'',classList:{toggle(){}},querySelector:()=>null};
    const footer = {innerHTML:'',classList:{add(){},remove(){}}};
    f.inputs.set('airp-phone-content',content); f.inputs.set('airp-phone-footer',footer);
    f.box.requestAnimationFrame = callback => callback();
    await f.run('renderRealView()');
    assert.ok(content.innerHTML.includes('历史消息')); assert.equal(footer.innerHTML,'');
});
test('dirty local recovery is saved before cleaning an already committed state block', async () => {
    const first = fixture(); await first.run('ensureState()');
    first.context.chat.push({is_user:false,send_date:'recovered',mes:'正文<AIRP_STATE>{"world":{"location":"待恢复地点"}}</AIRP_STATE>'});
    first.context.saveMetadata = async () => {throw new Error('offline')};
    await first.run('processAssistantStateBlock(0)');
    const next = fixture(); for (const [key,value] of first.storage) next.storage.set(key,value);
    next.context.chat.push({...first.context.chat[0],extra:{}}); let saves=0;
    next.context.saveMetadata = async () => {saves++};
    await next.run('processExistingStateBlocks()');
    assert.equal(next.state.world.location,'待恢复地点');
    assert.ok(saves > 0); assert.equal(next.state.safety.historyCheckpoints.length,1);
});
test('local/server conflict remains readable and offers explicit recovery', async () => {
    const f = fixture();
    f.run('state.runtime.revision=5;');
    await f.run('writeBackup(recoveryKey(captureOwner()),{state:{...state,world:{...state.world,location:"旧本机进度"}},dirty:true,baseRevision:2,savedAt:"2026"})');
    await f.run('ensureState()');
    assert.equal(f.state.runtime.recoveryConflict,true);
    assert.equal(f.state.world.location,'');
    await f.run('resolveLocalRecovery(false)');
    assert.equal(f.state.runtime.recoveryConflict,false);
});
test('important old memories survive recent ordinary entries', () => {
    const f = fixture();
    f.run('globalThis.notes=[{text:"重要旧事实",importance:"high"},...Array.from({length:100},(_,i)=>({text:"日常"+i,importance:"low"}))]');
    assert.equal(f.run('retainMemories(notes,60)[0].text'),'重要旧事实');
});

test('chat save failure retries without reapplying model delta', async () => {
    const f = fixture();
    f.context.chat.push({is_user:false,send_date:'chat-failure',mes:'正文<AIRP_STATE>{"events":[{"summary":"一次事件"}]}</AIRP_STATE>'});
    f.context.saveChat=async()=>false;
    assert.equal(await f.run('processAssistantStateBlock(0)'),false);
    assert.equal(f.state.events.length,1); assert.ok(f.state.runtime.chatSaveError);
    f.context.saveChat=async()=>{};
    await f.run('retryAirpSave()');
    assert.equal(f.state.events.length,1); assert.equal(f.state.runtime.chatSaveError,'');
});
test('deleting failed reply cancels pending model commit', async () => {
    const f = fixture(); await f.run('ensureState()');
    f.context.chat.push({is_user:false,send_date:'deleted',mes:'正文<AIRP_STATE>{"world":{"location":"已删除的剧情"}}</AIRP_STATE>'});
    f.context.saveMetadata=async()=>{throw new Error('offline')};
    await f.run('processAssistantStateBlock(0)');
    f.context.chat=[]; f.context.saveMetadata=async()=>{};
    await f.run('handleAirpMessageDeleted(0)'); await f.run('retryAirpSave()');
    assert.equal(f.state.world.location,''); assert.equal(f.state.safety.historyCheckpoints.length,0);
});
test('repairing failed JSON through message edit applies corrected state', async () => {
    const f=fixture();
    f.context.chat.push({is_user:false,send_date:'repair',mes:'正文<AIRP_STATE>{bad}</AIRP_STATE>'});
    assert.equal(await f.run('processAssistantStateBlock(0)'),false);
    f.context.chat[0].mes='正文<AIRP_STATE>{"world":{"location":"修正地点"}}</AIRP_STATE>';
    await f.run('handleAirpMessageEdited(0)'); assert.equal(f.state.world.location,'修正地点');
});
test('manually removed character stays inactive when model history rolls back', () => {
    const f=fixture(); f.npc('a');
    f.run('globalThis.before=createDynamicStateSnapshot(state);state.characters.a.active=false;state.characters.a.activeManualVersion="manual-remove";state.characters.a.activeManualValue=false;restoreDynamicStateSnapshot(state,before)');
    assert.equal(f.state.characters.a.active,false);
});
test('legacy import creates fresh baseline and detaches old message checkpoints', async () => {
    const f=fixture();
    f.context.chat.push({is_user:false,send_date:'old',mes:'旧正文',extra:{airp:{transactionId:'old-tx',applied:true}}});
    f.box.file={text:async()=>JSON.stringify({version:10,world:{location:'导入地点'},characters:{}})};
    f.run('loadWorldPack=async()=>({});loadExternalPromptBundle=async()=>({})');
    await f.run('importAirpWorldFromFile(file)');
    assert.equal(f.state.safety.historyCheckpoints.length,0);
    assert.equal(f.state.safety.historyBaseSnapshot.world.location,'导入地点');
    assert.equal(f.context.chat[0].extra.airp.invalidated,true);
});
test('actual world/style documents fit new default budgets', () => {
    const f=fixture();
    for(const [relative,key] of [['世界包/学院世界/世界设定.md','maxWorldDocChars'],['世界包/学院世界/叙事风格.md','maxStyleDocChars']]) {
        f.box.documentText=fs.readFileSync(path.join(root,relative),'utf8');
        const text=f.run(`stripPromptComments(documentText)`);
        assert.equal(f.run(`balancedText(stripPromptComments(documentText),state.settings.${key})`),text);
    }
});
test('changed reaction arrays remain compact over a long history', () => {
    const f=fixture();
    f.run('globalThis.baseline=createDynamicStateSnapshot(state);for(let i=0;i<100;i++){const before=createDynamicStateSnapshot(state);if(state.reactions.length)state.reactions.at(-1).status="resolved";state.reactions.push({id:"r"+i,characterId:"a",eventId:"e",status:"pending",summary:"反应"+i});addHistoryCheckpoint(state,{messageId:i,before,after:createDynamicStateSnapshot(state)});}');
    const compact=f.run('JSON.stringify(state.safety).length');
    const repeated=f.run('JSON.stringify(createDynamicStateSnapshot(state)).length*200');
    assert.ok(compact < repeated / 4, `${compact} vs ${repeated}`);
    assert.equal(f.run('getCheckpointById(state,state.safety.historyCheckpoints[99].id).after.reactions.length'),100);
});

test('legacy NaN anonymous labels are repaired during migration', () => {
    const f=fixture();
    f.run('const post=appendForumPost(state,{authorId:"player",text:"旧匿名帖",anonymous:true});post.anonymousLabel="匿名用户 NaN";const reply=addForumReply(state,post.id,{authorId:"player",text:"旧回复",anonymous:true});reply.anonymousLabel="匿名用户 NaN";normalizeState(state)');
    assert.ok(!f.state.forum[0].anonymousLabel.includes('NaN'));
    assert.ok(!f.state.forum[0].replies[0].anonymousLabel.includes('NaN'));
});
test('reading an ordinary forum post does not repeatedly trigger metadata saves', async () => {
    const f=fixture();
    f.run('appendForumPost(state,{authorId:"player",text:"普通帖子"});normalizeState(state)');
    let saves=0;f.context.saveMetadata=async()=>{saves++};
    await f.run('ensureState()');await f.run('ensureState()');
    assert.equal(saves,0);
});

test('new forum ref supports same-turn readers, missed readers and no-reaction result', async () => {
    const f=fixture();f.npc('a');f.npc('b');f.npc('c');
    await f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",title:"摄影社招新",text:"今晚开放活动室",anonymous:true}],exposures:[{characterId:"b",eventRef:"post",outcome:"seen",interpretation:"只看到公开招新时间"},{characterId:"c",eventRef:"post",outcome:"missed",reason:"不关注社团论坛"}],reactions:[{characterId:"b",eventRef:"post",status:"none",summary:"看到了，但没有兴趣参加"}]})');
    const id=f.state.forum[0].eventId;
    assert.equal(f.state.characters.b.knowledge[id].interpretation,'只看到公开招新时间');
    assert.equal(f.state.characters.c.knowledge[id],undefined);
    assert.equal(f.state.pendingExposures.length,0);
    assert.equal(f.state.reactions.find(r=>r.characterId==='b').status,'ignored');
    assert.equal(f.state.reactions.find(r=>r.characterId==='b').summary,'看到了，但没有兴趣参加');
    assert.equal(f.state.exposureHistory.find(e=>e.characterId==='c').interpretation,'不关注社团论坛');
    assert.ok(!f.state.events.find(e=>e.id===id).summary.includes('a发布'));
});
test('same-turn forum reaction can reply to the newly created post artifact ref', async () => {
    const f=fixture();f.npc('a');f.npc('b');
    await f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",text:"活动室今晚开放"}],exposures:[{characterId:"b",eventRef:"post",outcome:"seen",interpretation:"看到活动通知"}],reactions:[{characterId:"b",eventRef:"post",summary:"想问清楚时间",action:{type:"forum_reply",targetArtifactRef:"post",timing:"now",execute:{text:"几点开始？"}}}]})');
    const post=f.state.forum[0];
    assert.equal(post.replies[0].text,'几点开始？');
    assert.equal(f.state.reactions.find(r=>r.characterId==='b').status,'resolved');
    const replyEvent=f.state.events.find(e=>e.id===post.replies[0].eventId);
    assert.equal(replyEvent.sourceEventId,post.eventId);
});
test('explicit exposure and reaction delays stay pending with their reason and no invented scores', async () => {
    const f=fixture();f.npc('a');f.npc('b');f.npc('c');
    await f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",text:"考试安排"}],exposures:[{characterId:"b",eventRef:"post",outcome:"defer",reason:"正在上课，晚间再浏览"},{characterId:"c",eventRef:"post",outcome:"seen",interpretation:"看到考试日期"}],reactions:[{characterId:"c",eventRef:"post",status:"deferred",reason:"需要核对自己的日程",npcAttitudeDelta:9}]})');
    assert.equal(f.state.pendingExposures.find(e=>e.characterId==='b').deferReason,'正在上课，晚间再浏览');
    assert.equal(f.state.reactions.find(r=>r.characterId==='c').deferReason,'需要核对自己的日程');
    assert.equal(f.state.reactions.find(r=>r.characterId==='c').status,'pending');
    assert.equal(f.state.characters.c.attitude,0);
    const prompt=f.run('buildAirpContextBlock(SillyTavern.getContext().chatMetadata.airp)');
    assert.ok(prompt.includes('正在上课，晚间再浏览'));
    assert.ok(prompt.includes('需要核对自己的日程'));
});
test('omitted readership is not silently treated as seen and unknown reactions are rejected', async () => {
    const f=fixture();f.npc('a');f.npc('b');
    await f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",text:"无依据的帖子"}],reactions:[{characterId:"b",eventRef:"post",summary:"不该凭空获知",npcAttitudeDelta:5}]})');
    assert.equal(f.state.characters.b.knowledge[f.state.forum[0].eventId],undefined);
    assert.equal(f.state.characters.b.attitude,0);
    assert.equal(f.state.pendingExposures.length,1);
    assert.match(f.state.runtime.lastTrackerError,/unknown-event/);
});
test('new post knowledge applies once and same-event score is not counted twice', async () => {
    const f=fixture();f.npc('a');f.npc('b');
    f.run('state.characters.b.type="main";state.characters.b.relation=createDefaultRelation();');
    await f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",text:"第一次活动"},{type:"forum",authorId:"a",text:"第二条无关通知"}],knowledge:[{characterId:"b",eventRef:"post",source:"forum",interpretation:"读到了第一条活动"}],relationChanges:[{characterId:"b",eventRef:"post",changes:{trust:2},reason:"活动通知可靠"}],reactions:[{characterId:"b",eventRef:"post",summary:"认可通知",relationChanges:{trust:2}}]})');
    assert.equal(f.state.characters.b.relation.trust,2);
    assert.equal(f.state.reactions.filter(r=>r.trigger==='knowledge'&&r.eventId===f.state.forum[0].eventId).length,1);
    assert.equal(f.state.reactions.find(r=>r.trigger==='knowledge').status,'resolved');
});
test('source event knowledge is available before posting and source refs remain distinct', async () => {
    const f=fixture();f.npc('a');f.npc('b');
    await f.run('applyStateDelta({events:[{ref:"source",summary:"公开活动通知",channel:"forum",visibility:"public"}],knowledge:[{characterId:"a",eventRef:"source",interpretation:"读到了通知"}],social:[{ref:"post",eventRef:"source",type:"forum",authorId:"a",text:"转发活动信息"}],exposures:[{characterId:"b",eventRef:"post",outcome:"seen",interpretation:"从转帖看到活动信息"}],reactions:[{characterId:"b",eventRef:"post",status:"none",summary:"看到了转帖"}]})');
    assert.equal(f.state.events.find(e=>e.id===f.state.forum[0].eventId).sourceEventId,f.state.events[0].id);
    assert.equal(f.state.characters.b.knowledge[f.state.forum[0].eventId].interpretation,'从转帖看到活动信息');
});
test('moments still respect NPC friendships established in the same delta', async () => {
    const f=fixture();f.npc('a');f.npc('b');f.npc('c');
    await f.run('applyStateDelta({characterRelations:[{characterIds:["a","b"],friendship:true,source:"已交换联系方式"}],social:[{ref:"moment",type:"moments",authorId:"a",text:"晚饭照片"}],exposures:[{characterId:"b",eventRef:"moment",outcome:"seen"},{characterId:"c",eventRef:"moment",outcome:"seen"}],reactions:[{characterId:"b",eventRef:"moment",status:"none",summary:"看过照片"}]})');
    const id=f.state.moments[0].eventId;
    assert.ok(f.state.characters.b.knowledge[id]);
    assert.equal(f.state.characters.c.knowledge[id],undefined);
    assert.equal(f.state.exposureHistory.filter(e=>e.characterId==='c').length,0);
});
test('reaction-generated post ref can be read and reacted to later in the same delta', async () => {
    const f=fixture();f.npc('a');f.npc('b');f.npc('c');
    await f.run('applyStateDelta({social:[{ref:"first",type:"forum",authorId:"a",text:"社团消息"}],exposures:[{characterId:"b",eventRef:"first",outcome:"seen"},{characterId:"c",eventRef:"followup",outcome:"seen",interpretation:"只读到后续转帖"}],reactions:[{characterId:"b",eventRef:"first",summary:"愿意转发",action:{ref:"followup",type:"forum",timing:"now",execute:{text:"我也关注这个活动"}}},{characterId:"c",eventRef:"followup",status:"none",summary:"看到了转帖，没有进一步互动"}]})');
    assert.equal(f.state.forum.length,2);
    assert.ok(f.state.characters.c.knowledge[f.state.forum[1].eventId]);
    assert.equal(f.state.reactions.find(r=>r.characterId==='c').status,'ignored');
});
test('unresolved social source refs are rejected instead of becoming unrelated posts', async () => {
    const f=fixture();f.npc('a');
    await f.run('applyStateDelta({social:[{ref:"post",eventRef:"missing",type:"forum",authorId:"a",text:"不该发布"}]})');
    assert.equal(f.state.forum.length,0);
    assert.match(f.state.runtime.lastTrackerError,/unknown-source-event/);
});
test('failed save rolls back new post, readership and reaction together', async () => {
    const f=fixture();f.npc('a');f.npc('b');
    f.context.saveMetadata=async()=>{throw Error('server unavailable')};
    await assert.rejects(f.run('applyStateDelta({social:[{ref:"post",type:"forum",authorId:"a",text:"事务测试"}],exposures:[{characterId:"b",eventRef:"post",outcome:"seen"}],reactions:[{characterId:"b",eventRef:"post",status:"none",summary:"看过"}]})'));
    assert.equal(f.state.forum.length,0);
    assert.equal(f.state.events.length,0);
    assert.equal(f.state.reactions.length,0);
    assert.equal(Object.keys(f.state.characters.b.knowledge).length,0);
});

(async () => {
    let failed = 0;
    for (const [name, execute] of cases) {
        try { await execute(); console.log('PASS ' + name); }
        catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
    }
    console.log(`${cases.length - failed}/${cases.length} passed`);
    process.exitCode = failed ? 1 : 0;
})();
