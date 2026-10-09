import { buildAirpStateTrackerPrompt } from "./prompts.js?v=0.9.2";
import { assertSafeObject, validateDelta, diffState, applyPatch, checkpointSnapshot, balancedText } from "./airp-core.js?v=0.9.2";
import { readBackup, writeBackup } from "./airp-storage.js?v=0.9.2";

const MODULE_NAME = "AIRP UI";
const AIRP_KEY = "airp";
const STATE_VERSION = 14;
const AIRP_PROMPT_ID = "airp_state_tracker_v14";
const AIRP_STATE_BLOCK_RE = /<AIRP_STATE>\s*(?:```(?:json)?\s*)?([\s\S]*?)(?:\s*```)?\s*<\/AIRP_STATE>/gi;
const AIRP_OPENING_BLOCK_RE = /<AIRP_OPENING(?:\s+type=["']([^"']+)["'])?\s*>\s*(?:```(?:json)?\s*)?([\s\S]*?)(?:\s*```)?\s*<\/AIRP_OPENING>/i;
const AIRP_WORLD_OPENING_MARKER = "<<AIRP_WORLD_OPENING>>";
const AIRP_LEGACY_ADMISSION_RE = /^\s*\[类型[：:]\s*正式录取通知\]\s*/;
const AIRP_OPENING_STYLE_ID = "airp-opening-style-v132";
const RELATION_KEYS = Object.freeze([
    "attraction",
    "trust",
    "respect",
    "hostility",
    "possessiveness",
    "dependence",
    "jealousy",
]);

const RELATION_SEVERITY_LIMITS = Object.freeze({
    ordinary: 4,
    significant: 10,
    major: 20,
});

// V13：使用紧凑增量检查点，保留可回溯的完整分支历史。
let lastChatStructure = [];
const stateOwners = new WeakMap();
const recoveryChecked = new WeakSet();
const statePreparation = new WeakMap();
let mutationQueue = Promise.resolve();
let activeUiChatId = null;
let activationInstalled = false;
const pendingCommits = new WeakMap();
let renderedDraftScope = "";
let renderedDraftView = "";

function draftKey(id) { return `${renderedDraftScope}:draft:${renderedDraftView}:${id}`; }
function captureAirpDrafts() {
    if (!renderedDraftScope) return;
    for (const input of document.querySelectorAll?.('#airp-phone-overlay textarea[id], #airp-player-forum-title') ?? []) {
        if (!/compose|reply|moment-comment|player-(forum|moment)/.test(input.id)) continue;
        try { if (input.value) localStorage.setItem(draftKey(input.id), input.value); else localStorage.removeItem(draftKey(input.id)); } catch { /* Saving state reports storage availability separately. */ }
    }
}
function restoreAirpDrafts() {
    for (const input of document.querySelectorAll?.('#airp-phone-overlay textarea[id], #airp-player-forum-title') ?? []) {
        if (!/compose|reply|moment-comment|player-(forum|moment)/.test(input.id)) continue;
        try { input.value = localStorage.getItem(draftKey(input.id)) ?? input.value; } catch { /* Browser storage may be disabled. */ }
    }
}
function clearAirpDrafts(ids) {
    for (const id of ids) {
        const input = document.getElementById(id);
        if (input) input.value = "";
        try { localStorage.removeItem(draftKey(id)); } catch { /* No draft storage. */ }
    }
}

async function handleAirpClick(event) {
    const target = event.target.closest("[data-airp-action]");
    if (!target || target.disabled) return;
    target.disabled = true;
    try { await enqueueAirp(() => handleContentClick(event)); }
    catch (error) {
        console.error(`[${MODULE_NAME}] UI action`, error);
        showAirpSaveStatus(getContext().chatMetadata?.[AIRP_KEY], error.message);
    } finally { target.disabled = false; }
}

function showAirpSaveStatus(state, extraError = "") {
    const content = document.getElementById("airp-phone-content");
    if (!content) return;
    document.getElementById("airp-save-banner")?.remove();
    const error = extraError || state?.runtime?.saveError || state?.runtime?.chatSaveError || state?.runtime?.localRecoveryError || state?.runtime?.promptLoadError || (["error", "history_unavailable"].includes(state?.runtime?.lastTrackerStatus) ? state.runtime.lastTrackerError : "");
    if (!error) return;
    const banner = document.createElement("div");
    banner.id = "airp-save-banner";
    banner.className = "airp-save-banner";
    const text = document.createElement("p"); text.textContent = error;
    banner.append(text);
    for (const [action, label] of state?.runtime?.recoveryConflict ? [["export-airp-world", "导出服务器进度"], ["export-local-recovery", "导出本机副本"], ["restore-local-recovery", "恢复为本机副本"], ["keep-server-recovery", "保留服务器进度"]] : state?.runtime?.promptLoadError ? [["reload-world-pack", "重新加载资料"]] : [["retry-airp-save", "重试保存"]]) {
        const button = document.createElement("button"); button.type = "button"; button.dataset.airpAction = action; button.textContent = label; banner.append(button);
    }
    content.prepend(banner);
}

async function openSocialArtifact(type, id) {
    const state = await ensureState();
    if (!state) return;
    if (["forum", "forum_reply"].includes(type)) {
        const post = state.forum.find(item => item.id === id || item.replies.some(reply => reply.id === id));
        if (post) await navigateToForumPost(post.id);
    } else if (["moments", "moment_comment", "moment_like"].includes(type)) {
        const moment = state.moments.find(item => item.id === id || item.comments.some(comment => comment.id === id));
        if (moment && canViewMoment(state, moment)) { await navigateTo("moments"); requestAnimationFrame(() => document.getElementById(`airp-moment-${moment.id}`)?.scrollIntoView({ block: "center" })); }
    } else if (type === "private_chat") {
        const message = Object.values(state.messages).flat().find(item => item.id === id);
        const characterId = message?.senderId === "player" ? message.receiverId : message?.senderId;
        if (message && message.senderId !== "player" && message.receiverId !== "player") { if (message.eventId) await navigateToEvent(message.eventId); }
        else if (characterId && areFriends(state, "player", characterId)) await navigateTo("chat", characterId);
    }
}

async function commitAirpDraft(original, draft, owner) {
    assertOwner(owner);
    owner.metadata[AIRP_KEY] = draft;
    stateOwners.set(draft, owner);
    try {
        await saveState(draft);
        pendingCommits.delete(owner.metadata);
        return draft;
    } catch (error) {
        pendingCommits.set(owner.metadata, draft);
        if (owner.metadata[AIRP_KEY] === draft) owner.metadata[AIRP_KEY] = original;
        original.runtime.saveStatus = "failed";
        original.runtime.saveError = String(error?.message ?? error);
        throw error;
    }
}

async function retryAirpSave() {
    const owner = captureOwner();
    const current = await ensureState();
    const draft = pendingCommits.get(owner.metadata);
    if (draft) await commitAirpDraft(current, draft, owner);
    else await saveState(current);
    await processExistingStateBlocks();
    const saved = owner.metadata[AIRP_KEY];
    assertOwner(owner);
    try {
        const undo = saved.safety.lastAutoUpdate;
        const undoMessage = owner.context.chat?.[undo?.messageId];
        if (undo && undoMessage?.extra?.airp?.transactionId === undo.transactionId) { undoMessage.extra.airp.applied = !undo.isUndone; undoMessage.extra.airp.rolledBackAt = undo.isUndone ? undo.undoneAt : null; syncCleanMessageToSwipe(undoMessage); }
        for (const message of owner.context.chat ?? []) if (message.extra?.airp?.applied) { message.extra.airp.error = null; syncCleanMessageToSwipe(message); }
        checkedSaveResult(await owner.context.saveChat?.());
        saved.runtime.chatSaveError = "";
        saved.runtime.lastTrackerError = "";
        if (saved.runtime.lastTrackerStatus === "error") saved.runtime.lastTrackerStatus = "applied";
        clearAirpDrafts(saved.runtime.pendingUiInputIds ?? []);
        delete saved.runtime.pendingUiInputIds;
        await saveState(saved);
    } catch (error) {
        saved.runtime.chatSaveError = String(error?.message ?? error);
        await writeRecovery(owner, saved, true);
        throw error;
    }
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

function enqueueAirp(task) {
    const owner = captureOwner();
    const run = mutationQueue.then(() => { assertOwner(owner); return task(); });
    mutationQueue = run.catch(error => console.error(`[${MODULE_NAME}]`, error));
    return run;
}

async function resolveLocalRecovery(useLocal) {
    const owner = captureOwner();
    const state = await ensureState();
    const local = await readBackup(recoveryKey(owner));
    if (!state || !local?.state) return;
    try { await writeBackup(recoveryKey(owner) + ":alternate", { state: deepCloneAirp(useLocal ? state : local.state), savedAt: new Date().toISOString() }); } catch (error) { console.warn(`[${MODULE_NAME}] alternate recovery copy`, error); }
    const chosen = useLocal ? local.state : state;
    normalizeState(chosen);
    chosen.runtime.recoveryConflict = false;
    chosen.runtime.saveError = "";
    chosen.runtime.revision = Number(state.runtime.revision) || 0;
    pendingCommits.delete(owner.metadata);
    if (useLocal) await commitAirpDraft(state, chosen, owner);
    else await saveState(chosen);
    await processExistingStateBlocks();
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

function captureOwner(context = getContext()) {
    return { context, metadata: context.chatMetadata, chatId: String(context.getCurrentChatId?.() ?? ""), characterId: context.characterId, groupId: context.groupId };
}

function assertOwner(owner) {
    const current = captureOwner();
    if (!owner?.chatId || current.chatId !== owner.chatId || current.metadata !== owner.metadata || current.characterId !== owner.characterId || current.groupId !== owner.groupId) throw new Error("聊天已切换，已停止旧存档操作");
}

function recoveryKey(owner) {
    return `airp-recovery-v14:${owner.groupId ?? owner.characterId ?? "host"}:${owner.chatId}`;
}

async function writeRecovery(owner, state, dirty, baseRevision = state.runtime?.revision ?? 0) {
    try {
        await writeBackup(recoveryKey(owner), { state: deepCloneAirp(state), dirty, baseRevision, savedAt: new Date().toISOString() });
        state.runtime.localRecoveryError = "";
    } catch (error) {
        state.runtime.localRecoveryError = `本机恢复副本不可用：${error?.message ?? error}`;
    }
}

function checkedSaveResult(result) {
    if (result === false || result?.ok === false || result?.success === false || result?.error) throw new Error(`酒馆保存未成功：${result?.error || result?.status || "请求失败"}`);
}


const VISIBILITY_LABELS = {
    private: "私密",
    limited: "小范围",
    social: "社交传播",
    public: "公开",
    rumor: "传言",
};

const CHANNEL_LABELS = {
    scene: "现场",
    private_chat: "私聊",
    moments: "朋友圈",
    forum: "论坛",
    group_chat: "群聊",
    word_of_mouth: "口耳相传",
    other: "其他",
};

const DIRECT_DELIVERY_CHANNELS = new Set([
    "private_chat",
    "group_chat",
    "word_of_mouth",
]);

const BROADCAST_CHANNELS = new Set([
    "moments",
    "forum",
]);

const REACTION_STATUS_LABELS = {
    pending: "待处理",
    resolved: "已处理",
    ignored: "已忽略",
};

const ACTION_LABELS = {
    none: "不采取行动",
    private_chat: "私聊",
    moments: "发朋友圈",
    forum: "发论坛 / 匿名帖",
    moment_comment: "评论朋友圈",
    moment_like: "点赞朋友圈",
    forum_reply: "回复论坛",
    find_character: "去找某人",
    investigate: "继续确认信息",
    bring_up_later: "以后再提",
};

const ACTION_TIMING_LABELS = {
    now: "现在",
    later: "稍后",
    next_meeting: "下次见面",
};

let currentView = createHomeView();
let navigationStack = [];

let worldPackCache = {
    folder: "",
    status: "idle",
    error: "",
    loadedAt: null,
    config: null,
    documents: {
        world: "",
        player: "",
        opening: "",
        style: "",
    },
    sections: [],
};

let externalPromptCache = {
    status: "idle",
    error: "",
    loadedAt: null,
    text: "",
    files: [],
};

function encodeRelativeAssetPath(relativePath = "") {
    return String(relativePath)
        .split("/")
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join("/");
}

function extensionAssetUrl(relativePath = "") {
    return new URL(`./${encodeRelativeAssetPath(relativePath)}`, import.meta.url).href;
}

async function fetchExtensionText(relativePath, { optional = false } = {}) {
    try {
        const response = await fetch(extensionAssetUrl(relativePath), { cache: "no-store" });
        if (!response.ok) {
            if (optional && response.status === 404) return "";
            throw new Error(`${response.status} ${response.statusText}`);
        }
        return await response.text();
    } catch (error) {
        throw error;
    }
}

function stripPromptComments(text = "") {
    return String(text).replace(/<!--[\s\S]*?-->/g, "").trim();
}

function parseMarkdownSections(text = "") {
    const source = String(text ?? "");
    const lines = source.split(/\r?\n/);
    const sections = [];
    let current = null;
    const stack = [];

    for (const line of lines) {
        const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (match) {
            const level = match[1].length;
            const title = match[2].trim();
            stack[level - 1] = title;
            stack.length = level;
            if (current && current.content.trim()) sections.push(current);
            current = {
                level,
                title,
                path: stack.join(" / "),
                content: `${line}\n`,
            };
        } else if (current) {
            current.content += `${line}\n`;
        }
    }
    if (current && current.content.trim()) sections.push(current);
    return sections;
}

async function loadWorldPack(state, force = false) {
    const folder = String(state?.worldInfo?.packFolder || "学院世界").trim() || "学院世界";
    const enabled = state?.settings?.worldPackEnabled !== false;

    if (!enabled) {
        worldPackCache = {
            folder,
            status: "disabled",
            error: "",
            loadedAt: null,
            config: null,
            documents: { world: "", player: "", opening: "", style: "" },
            sections: [],
        };
        return worldPackCache;
    }

    if (!force && worldPackCache.folder === folder && worldPackCache.status === "loaded") {
        return worldPackCache;
    }

    worldPackCache = {
        folder,
        status: "loading",
        error: "",
        loadedAt: null,
        config: null,
        documents: { world: "", player: "", opening: "", style: "" },
        sections: [],
    };

    const requestCache = worldPackCache;
    try {
        const configText = await fetchExtensionText(`世界包/${folder}/世界配置.json`);
        const config = JSON.parse(configText);
        const files = config?.files ?? {};
        const read = async (key, fallback) => {
            const name = String(files[key] || fallback).trim();
            return name ? fetchExtensionText(`世界包/${folder}/${name}`, { optional: true }) : "";
        };

        const world = await read("world", "世界设定.md");
        let premise = await read("premise", "开局前提.md");
        // 兼容 V10 模板：如果还没新建「开局前提.md」，继续读取旧的「玩家设定.md」。
        if (!String(premise ?? "").trim()) {
            premise = await read("player", "玩家设定.md");
        }
        const [opening, style] = await Promise.all([
            read("opening", "开场内容.md"),
            read("style", "叙事风格.md"),
        ]);

        const loadedPack = {
            folder,
            status: "loaded",
            error: "",
            loadedAt: new Date().toISOString(),
            config,
            documents: { world, player: premise, opening, style },
            sections: parseMarkdownSections(world),
        };
        if (worldPackCache === requestCache) worldPackCache = loadedPack;
        return loadedPack;
    } catch (error) {
        requestCache.status = "error";
        requestCache.error = error?.message || String(error);
    }

    return requestCache;
}

async function loadExternalPromptBundle(state, force = false) {
    const enabled = state?.settings?.externalPromptsEnabled !== false;
    if (!enabled) {
        externalPromptCache = { status: "disabled", error: "", loadedAt: null, text: "", files: [] };
        return externalPromptCache;
    }

    if (!force && externalPromptCache.status === "loaded") return externalPromptCache;

    externalPromptCache = { status: "loading", error: "", loadedAt: null, text: "", files: [] };
    const specs = [
        ["叙事规则", "提示词/叙事规则.md"],
        ["状态追踪", "提示词/状态追踪.md"],
        ["关系规则", "提示词/关系规则.md"],
        ["社交反应", "提示词/社交反应.md"],
    ];

    try {
        const parts = [];
        const files = [];
        for (const [label, path] of specs) {
            const raw = await fetchExtensionText(path, { optional: true });
            const cleaned = stripPromptComments(raw);
            files.push({
                label,
                path,
                chars: cleaned.length,
                loaded: Boolean(raw),
            });
            if (cleaned) parts.push(`## ${label}\n${cleaned}`);
        }
        externalPromptCache = {
            status: "loaded",
            error: "",
            loadedAt: new Date().toISOString(),
            text: parts.join("\n\n"),
            files,
        };
    } catch (error) {
        externalPromptCache.status = "error";
        externalPromptCache.error = error?.message || String(error);
    }

    return externalPromptCache;
}

function getWorldPackSummary() {
    const pack = worldPackCache;
    if (pack.status !== "loaded") return "";
    const config = pack.config ?? {};
    const documents = pack.documents ?? {};
    const bits = [
        `${config.name || pack.folder}`,
        config.version ? `v${config.version}` : "",
        documents.world ? `${documents.world.length}字世界资料` : "",
        documents.player ? `${documents.player.length}字开局前提` : "",
        documents.style ? `${documents.style.length}字叙事风格` : "",
    ].filter(Boolean);
    return bits.join(" · ");
}

function createHomeView() {
    return {
        page: "home",
        characterId: null,
        eventId: null,
        relationKey: null,
        reactionId: null,
        actionId: null,
        forumPostId: null,
    };
}

/* =========================================================
   基础工具
   ========================================================= */

function getContext() {
    return SillyTavern.getContext();
}

function applyAirpInterfaceState(state) {
    const body = document.body;
    if (!body) return;

    const settings = state?.settings ?? {};
    body.classList.toggle("airp-ui-enabled", settings.themeEnabled !== false);
    body.classList.toggle("airp-player-mode", settings.interfaceMode === "player");
    body.classList.toggle("airp-developer-mode", settings.interfaceMode !== "player");
    body.classList.toggle("airp-responsive-phone", settings.responsivePhone !== false);
    body.classList.toggle("airp-compact-message-controls", settings.compactMessageControls !== false);
}

async function refreshAirpInterfaceState() {
    const owner = captureOwner();
    const state = await ensureState();
    if (state) { assertOwner(owner); applyAirpInterfaceState(state); }
}

function escapeHtml(value = "") {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function escapeAttribute(value = "") {
    return escapeHtml(value);
}

function clamp(value, min = 0, max = 100) {
    const number = Number(value);
    if (Number.isNaN(number)) return min;
    return Math.min(max, Math.max(min, number));
}

function clampSigned(value, min = -100, max = 100) {
    const number = Number(value);
    if (Number.isNaN(number)) return 0;
    return Math.min(max, Math.max(min, number));
}

function getInitial(name = "?") {
    const value = String(name).trim();
    return value ? Array.from(value)[0] : "?";
}

function extractWorldTime(datetime) {
    if (!datetime) return "--:--";
    const match = String(datetime).match(/(\d{1,2}):(\d{2})/);
    if (!match) return "--:--";
    return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function splitCommaText(value = "") {
    return String(value)
        .split(/[，,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function createId(prefix) {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }

    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* =========================================================
   SillyTavern 角色卡
   ========================================================= */

function getCurrentCard() {
    const context = getContext();

    // AIRP 当前正式路线仍以单聊作为一个世界存档。
    if (context.groupId) return null;

    if (context.characterId === undefined || context.characterId === null) {
        return null;
    }

    return context.characters?.[context.characterId] ?? null;
}

function isAirpHostCard(card) {
    if (!card) return false;
    const data = card.data ?? card;
    const notes = String(data.creator_notes ?? card.creator_notes ?? "");
    const tags = Array.isArray(data.tags) ? data.tags : (Array.isArray(card.tags) ? card.tags : []);
    const extensionFlag = data.extensions?.airp?.host === true || card.extensions?.airp?.host === true;
    return extensionFlag
        || tags.some(tag => String(tag).toUpperCase() === "AIRP_HOST")
        || notes.includes("[AIRP_HOST_CARD]");
}

function getAllCards() {
    const context = getContext();

    return (context.characters ?? [])
        .filter(card => card && card.name && card.avatar && card.avatar !== "none" && !isAirpHostCard(card))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
}

function getCardByAvatar(avatar) {
    if (!avatar) return null;
    return getContext().characters?.find(card => card.avatar === avatar) ?? null;
}

function getCardAvatarUrl(card) {
    if (!card?.avatar) return "";

    try {
        return getContext().getThumbnailUrl("avatar", card.avatar);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] avatar error`, error);
        return "";
    }
}

function hashString(value) {
    let hash = 5381;

    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }

    return (hash >>> 0).toString(36);
}

function makeLeadId(avatar) {
    return `lead_${hashString(String(avatar))}`;
}

/* =========================================================
   默认数据结构
   ========================================================= */

function createDefaultRelation() {
    return {
        attraction: 0,
        trust: 0,
        respect: 0,
        hostility: 0,
        possessiveness: 0,
        dependence: 0,
        jealousy: 0,
    };
}

function createDefaultProfile(name = "") {
    return {
        name,
        handle: name ? `@${name}` : "",
        signature: "还没有设置个人签名。",
        identity: "",
        grade: "",
        department: "",
        organization: "",
        background: "",
        bio: "",
        commonContacts: 0,
        avatar: "",
        cover: "",
    };
}

function createDefaultInternal() {
    return {
        modelNotes: "",
    };
}

function createDefaultCharacterStatus() {
    return {
        location: "",
        activity: "",
        mood: "",
        note: "",
        updatedAt: null,
    };
}

function createNpcCharacter(name = "新联系人") {
    return {
        id: createId("npc"),
        type: "npc",
        active: true,
        source: { type: "airp-npc" },
        contactStatus: "known",
        profileMeta: { locked: {}, sources: {} },
        profile: createDefaultProfile(name),
        attitude: 0,
        impression: "尚未形成明确印象",
        internal: createDefaultInternal(),
        status: createDefaultCharacterStatus(),
        knowledge: {},
    };
}

function createCharacterFromCard(card, id = null) {
    return {
        id: id ?? makeLeadId(card.avatar),
        type: "main",
        active: true,
        contactStatus: "known",
        profileInitialized: false,
        profileMeta: { locked: {}, sources: {} },

        source: {
            type: "sillytavern-card",
            cardAvatar: card.avatar,
        },

        profile: createDefaultProfile(card.name),
        internal: createDefaultInternal(),
        status: createDefaultCharacterStatus(),

        relation: createDefaultRelation(),
        relationLabel: "尚未建立关系",

        // key = eventId
        knowledge: {},
    };
}

function createDefaultState() {
    const currentCard = getCurrentCard();
    const characters = {};
    const presentCharacterIds = [];

    if (currentCard && !isAirpHostCard(currentCard)) {
        const character = createCharacterFromCard(currentCard);
        characters[character.id] = character;
        presentCharacterIds.push(character.id);
    }

    return {
        version: STATE_VERSION,

        // V10.1：长期世界资料由 Markdown 世界包维护；这里只保存世界包选择和本存档补充。
        worldInfo: {
            packFolder: "学院世界",
            localSupplement: "",
        },

        world: {
            datetime: "",
            location: "",
            sceneSummary: "",
            presentCharacterIds,
        },

        characters,

        // pairKey -> relationship object
        characterRelations: {},

        events: [],

        // V12：稀疏长期记忆。只保存跨多场景仍值得保留的信息，不替代事件日志。
        memory: {
            world: [],
            characters: {},
        },

        // 事件已经进入某个传播渠道，但某角色是否真的看到尚未确认。
        pendingExposures: [],
        exposureHistory: [],

        // 角色在获得新信息后，是否需要产生关系 / 行动反应。
        reactions: [],

        // 反应产生的行动意图。后续会接到私聊 / 朋友圈 / 论坛等社交模块。
        actions: [],

        // V7：自动状态追踪与界面模式。
        settings: {
            interfaceMode: "developer",
            stateTrackerEnabled: true,
            contextInjectionEnabled: true,
            recentEventLimit: 6,
            maxPresentCardChars: 4200,
            maxRelatedCardChars: 1200,
            maxPersonaChars: 2400,
            themeEnabled: true,
            responsivePhone: true,
            compactMessageControls: true,
            openingComponentsEnabled: true,
            worldPackEnabled: true,
            externalPromptsEnabled: true,
            maxWorldDocChars: 12000,
            maxPlayerDocChars: 3200,
            maxStyleDocChars: 8000,
            socialNotificationsEnabled: true,
            socialGenerationEnabled: true,
            maxSocialPerTurn: 3,
        },

        // V13：最近一次撤销 + 有界消息检查点；用于删除 / 重生成 / Swipe / 编辑同步。
        safety: {
            lastAutoUpdate: null,
            lastIntegrityReport: null,
            lastExportAt: null,
            lastImportAt: null,
            historyCheckpoints: [],
            historyBaseSnapshot: null,
            activeCheckpointId: null,
            lastHistorySyncAt: null,
            lastHistorySyncReason: "",
        },

        runtime: {
            lastProcessedMessageId: null,
            lastTrackerStatus: "idle",
            lastTrackerError: "",
            lastProcessedAt: null,
        },

        moments: [],
        forum: [],
        messages: {},
        notifications: [],
    };
}

/* =========================================================
   迁移 / 标准化
   ========================================================= */

function normalizeCharacterExtras(character) {
    let changed = false;
    if (!character.profileMeta) { character.profileMeta = { locked: {}, sources: {} }; changed = true; }
    character.profileMeta.locked ??= {};
    character.profileMeta.sources ??= {};
    if (!character.contactStatus) { character.contactStatus = "known"; changed = true; }

    if (!character.profile || typeof character.profile !== "object" || Array.isArray(character.profile)) {
        character.profile = createDefaultProfile("");
        changed = true;
    }

    const profileDefaults = createDefaultProfile(character.profile.name ?? "");
    for (const [key, value] of Object.entries(profileDefaults)) {
        if (character.profile[key] === undefined) {
            character.profile[key] = value;
            changed = true;
        }
    }

    if (!character.internal || typeof character.internal !== "object" || Array.isArray(character.internal)) {
        character.internal = createDefaultInternal();
        changed = true;
    }
    if (character.internal.modelNotes === undefined) {
        character.internal.modelNotes = "";
        changed = true;
    }

    if (!character.status || typeof character.status !== "object" || Array.isArray(character.status)) {
        character.status = createDefaultCharacterStatus();
        changed = true;
    }
    const statusDefaults = createDefaultCharacterStatus();
    for (const [key, value] of Object.entries(statusDefaults)) {
        if (character.status[key] === undefined) {
            character.status[key] = value;
            changed = true;
        }
    }

    return changed;
}

function normalizeMainCharacter(character) {
    let changed = normalizeCharacterExtras(character);

    if (character.active === undefined) {
        character.active = true;
        changed = true;
    }

    if (!character.relation) {
        character.relation = createDefaultRelation();
        changed = true;
    }

    const defaults = createDefaultRelation();
    for (const key of Object.keys(defaults)) {
        if (character.relation[key] === undefined) {
            character.relation[key] = defaults[key];
            changed = true;
        }
    }

    if (character.relationLabel === undefined) {
        character.relationLabel = "尚未建立关系";
        changed = true;
    }

    if (!character.knowledge || typeof character.knowledge !== "object") {
        character.knowledge = {};
        changed = true;
    }

    return changed;
}

function normalizeNpcCharacter(character) {
    let changed = normalizeCharacterExtras(character);

    if (character.active === undefined) {
        character.active = true;
        changed = true;
    }

    if (!character.knowledge || typeof character.knowledge !== "object") {
        character.knowledge = {};
        changed = true;
    }

    return changed;
}

function normalizeEvent(event) {
    let changed = false;

    if (!event.id) {
        event.id = createId("evt");
        changed = true;
    }

    if (event.time === undefined) {
        event.time = "";
        changed = true;
    }

    if (event.summary === undefined) {
        event.summary = "";
        changed = true;
    }

    for (const key of ["participants", "witnesses", "audienceCharacterIds", "tags"]) {
        if (!Array.isArray(event[key])) {
            event[key] = [];
            changed = true;
        }
    }

    if (!VISIBILITY_LABELS[event.visibility]) {
        event.visibility = "private";
        changed = true;
    }

    if (!CHANNEL_LABELS[event.channel]) {
        event.channel = "scene";
        changed = true;
    }

    if (event.sourceEventId === undefined) {
        event.sourceEventId = null;
        changed = true;
    }

    if (!event.createdAt) {
        event.createdAt = new Date().toISOString();
        changed = true;
    }

    return changed;
}

function normalizeReaction(reaction) {
    let changed = false;

    if (!reaction.id) {
        reaction.id = createId("react");
        changed = true;
    }

    if (!REACTION_STATUS_LABELS[reaction.status]) {
        reaction.status = "pending";
        changed = true;
    }

    if (reaction.trigger === undefined) {
        reaction.trigger = "knowledge";
        changed = true;
    }

    if (reaction.source === undefined) {
        reaction.source = "other";
        changed = true;
    }

    if (reaction.summary === undefined) {
        reaction.summary = "";
        changed = true;
    }

    if (!reaction.relationChanges || typeof reaction.relationChanges !== "object") {
        reaction.relationChanges = {};
        changed = true;
    }

    if (reaction.relationLabel === undefined) {
        reaction.relationLabel = null;
        changed = true;
    }

    if (reaction.npcAttitudeDelta === undefined) {
        reaction.npcAttitudeDelta = 0;
        changed = true;
    }

    if (reaction.npcImpression === undefined) {
        reaction.npcImpression = null;
        changed = true;
    }

    if (reaction.actionId === undefined) {
        reaction.actionId = null;
        changed = true;
    }

    if (!reaction.createdAt) {
        reaction.createdAt = new Date().toISOString();
        changed = true;
    }

    if (reaction.resolvedAt === undefined) {
        reaction.resolvedAt = null;
        changed = true;
    }

    return changed;
}

function normalizeAction(action) {
    let changed = false;

    if (!action.id) {
        action.id = createId("act");
        changed = true;
    }

    if (!ACTION_LABELS[action.type] || action.type === "none") {
        action.type = "bring_up_later";
        changed = true;
    }

    if (!ACTION_TIMING_LABELS[action.timing]) {
        action.timing = "later";
        changed = true;
    }

    if (!["pending", "done", "cancelled"].includes(action.status)) {
        action.status = "pending";
        changed = true;
    }

    if (action.targetCharacterId === undefined) {
        action.targetCharacterId = "player";
        changed = true;
    }

    if (action.note === undefined) {
        action.note = "";
        changed = true;
    }

    if (action.targetArtifactId === undefined) {
        action.targetArtifactId = null;
        changed = true;
    }

    if (!action.createdAt) {
        action.createdAt = new Date().toISOString();
        changed = true;
    }

    if (action.completedAt === undefined) {
        action.completedAt = null;
        changed = true;
    }

    if (action.executedArtifactId === undefined) {
        action.executedArtifactId = null;
        changed = true;
    }

    if (action.executedEventId === undefined) {
        action.executedEventId = null;
        changed = true;
    }

    return changed;
}

function normalizeState(state) {
    let changed = false;

    if (!state.worldInfo || typeof state.worldInfo !== "object" || Array.isArray(state.worldInfo)) {
        state.worldInfo = {};
        changed = true;
    }
    const worldInfoDefaults = {
        packFolder: "学院世界",
        localSupplement: "",
    };
    for (const [key, value] of Object.entries(worldInfoDefaults)) {
        if (state.worldInfo[key] === undefined) {
            state.worldInfo[key] = value;
            changed = true;
        }
    }

    if (!state.world) {
        state.world = {
            datetime: "",
            location: "",
            sceneSummary: "",
            presentCharacterIds: [],
        };
        changed = true;
    }

    if (state.world.datetime === undefined) {
        state.world.datetime = "";
        changed = true;
    }

    if (state.world.location === undefined) {
        state.world.location = "";
        changed = true;
    }

    // 兼容之前若有人已经尝试过 scene 字段的过渡版本。
    if (state.world.sceneSummary === undefined) {
        state.world.sceneSummary = state.world.scene ?? "";
        changed = true;
    }

    if (!Array.isArray(state.world.presentCharacterIds)) {
        const currentCard = getCurrentCard();
        const matched = currentCard && !isAirpHostCard(currentCard)
            ? Object.values(state.characters ?? {}).find(
                character => character.source?.cardAvatar === currentCard.avatar,
            )
            : null;

        state.world.presentCharacterIds = matched ? [matched.id] : [];
        changed = true;
    }

    if (!state.characters) {
        state.characters = {};
        changed = true;
    }

    // 清掉旧版测试 NPC。
    if (state.characters.npc_demo?.profile?.name === "测试联系人") {
        delete state.characters.npc_demo;
        changed = true;
    }

    // V13.1：主叙事卡只是 AIRP 宿主，不应进入攻略角色 / 在场角色状态。
    for (const [characterId, character] of Object.entries(state.characters)) {
        if (character?.type !== "main") continue;
        const card = getCardByAvatar(character.source?.cardAvatar);
        if (!isAirpHostCard(card)) continue;
        delete state.characters[characterId];
        state.world.presentCharacterIds = (state.world.presentCharacterIds ?? []).filter(id => id !== characterId);
        changed = true;
    }

    for (const character of Object.values(state.characters)) {
        if (character.type === "main") {
            changed = normalizeMainCharacter(character) || changed;
        } else if (character.type === "npc") {
            changed = normalizeNpcCharacter(character) || changed;
        }
    }

    if (!state.characterRelations || typeof state.characterRelations !== "object") {
        state.characterRelations = {};
        changed = true;
    }

    if (!Array.isArray(state.events)) {
        state.events = [];
        changed = true;
    }

    for (const event of state.events) {
        changed = normalizeEvent(event) || changed;
    }

    if (!Array.isArray(state.pendingExposures)) {
        state.pendingExposures = [];
        changed = true;
    }

    const seenExposureKeys = new Set();
    state.pendingExposures = state.pendingExposures.filter(exposure => {
        if (!exposure || !exposure.eventId || !exposure.characterId) {
            changed = true;
            return false;
        }

        if (!state.characters[exposure.characterId] || !state.events.some(event => event.id === exposure.eventId)) {
            changed = true;
            return false;
        }

        const key = `${exposure.eventId}::${exposure.characterId}`;
        if (seenExposureKeys.has(key)) {
            changed = true;
            return false;
        }

        if (state.characters[exposure.characterId]?.knowledge?.[exposure.eventId]) {
            changed = true;
            return false;
        }

        seenExposureKeys.add(key);
        exposure.id = exposure.id || createId("exp");
        exposure.channel = CHANNEL_LABELS[exposure.channel] ? exposure.channel : "other";
        exposure.certainty = clamp(exposure.certainty ?? 1, 0, 1);
        exposure.reason = String(exposure.reason ?? "");
        exposure.createdAt = exposure.createdAt || new Date().toISOString();
        return true;
    });

    if (!Array.isArray(state.reactions)) {
        state.reactions = [];
        changed = true;
    }

    state.reactions = state.reactions.filter(reaction => {
        if (!reaction || !reaction.characterId || !reaction.eventId) {
            changed = true;
            return false;
        }

        if (!state.characters[reaction.characterId] || !state.events.some(event => event.id === reaction.eventId)) {
            changed = true;
            return false;
        }

        changed = normalizeReaction(reaction) || changed;
        return true;
    });

    if (!Array.isArray(state.actions)) {
        state.actions = [];
        changed = true;
    }

    state.actions = state.actions.filter(action => {
        if (!action || !action.actorId || !state.characters[action.actorId]) {
            changed = true;
            return false;
        }

        changed = normalizeAction(action) || changed;
        return true;
    });

    if (!Array.isArray(state.moments)) {
        state.moments = [];
        changed = true;
    }

    for (const moment of state.moments) {
        if (!moment.id) {
            moment.id = createId("moment");
            changed = true;
        }
        if (moment.eventId === undefined) {
            moment.eventId = null;
            changed = true;
        }
        if (moment.actionId === undefined) {
            moment.actionId = null;
            changed = true;
        }
        if (!moment.createdAt) {
            moment.createdAt = new Date().toISOString();
            changed = true;
        }
        if (!Array.isArray(moment.likes)) {
            moment.likes = [];
            changed = true;
        }
        if (!Array.isArray(moment.comments)) {
            moment.comments = [];
            changed = true;
        }
        for (const comment of moment.comments) {
            if (!comment.id) {
                comment.id = createId("mcomment");
                changed = true;
            }
            if (!comment.createdAt) {
                comment.createdAt = new Date().toISOString();
                changed = true;
            }
            if (comment.time === undefined) {
                comment.time = "";
                changed = true;
            }
        }
    }

    if (!Array.isArray(state.forum)) {
        state.forum = [];
        changed = true;
    }

    for (const post of state.forum) {
        if (!post.id) {
            post.id = createId("post");
            changed = true;
        }
        if (post.title === undefined) {
            post.title = "";
            changed = true;
        }
        if (post.anonymous === undefined) {
            post.anonymous = false;
            changed = true;
        }
        if (post.eventId === undefined) {
            post.eventId = null;
            changed = true;
        }
        if (post.actionId === undefined) {
            post.actionId = null;
            changed = true;
        }
        if (!post.createdAt) {
            post.createdAt = new Date().toISOString();
            changed = true;
        }
        if (post.anonymousLabel === undefined || (post.anonymous && (!post.anonymousLabel || post.anonymousLabel.includes("NaN")))) {
            post.anonymousLabel = post.anonymous ? `匿名用户 ${hashString(post.id).toUpperCase().slice(-3).padStart(3, "0")}` : "";
            changed = true;
        }
        if (!Array.isArray(post.replies)) {
            post.replies = [];
            changed = true;
        }
        for (const reply of post.replies) {
            if (!reply.id) {
                reply.id = createId("reply");
                changed = true;
            }
            if (!reply.createdAt) {
                reply.createdAt = new Date().toISOString();
                changed = true;
            }
            if (reply.time === undefined) {
                reply.time = "";
                changed = true;
            }
            if (reply.anonymous === undefined) {
                reply.anonymous = false;
                changed = true;
            }
            if (reply.anonymous && (!reply.anonymousLabel || reply.anonymousLabel.includes("NaN"))) {
                reply.anonymousLabel = `匿名用户 ${hashString(reply.id).toUpperCase().slice(-3).padStart(3, "0")}`;
                changed = true;
            }
        }
    }

    if (!state.messages || typeof state.messages !== "object" || Array.isArray(state.messages)) {
        state.messages = {};
        changed = true;
    }

    for (const [threadKey, items] of Object.entries(state.messages)) {
        if (!Array.isArray(items)) {
            state.messages[threadKey] = [];
            changed = true;
            continue;
        }

        for (const message of items) {
            if (!message.id) {
                message.id = createId("msg");
                changed = true;
            }
            if (message.eventId === undefined) {
                message.eventId = null;
                changed = true;
            }
            if (message.actionId === undefined) {
                message.actionId = null;
                changed = true;
            }
            if (message.read === undefined) {
                message.read = false;
                changed = true;
            }
            if (!message.createdAt) {
                message.createdAt = new Date().toISOString();
                changed = true;
            }
        }
    }

    if (!Array.isArray(state.notifications)) {
        state.notifications = [];
        changed = true;
    }
    state.notifications = state.notifications.filter(item => {
        if (!item || typeof item !== "object") {
            changed = true;
            return false;
        }
        if (!item.id) {
            item.id = createId("notify");
            changed = true;
        }
        if (item.read === undefined) {
            item.read = false;
            changed = true;
        }
        if (!item.createdAt) {
            item.createdAt = new Date().toISOString();
            changed = true;
        }
        return true;
    });

    if (!state.memory || typeof state.memory !== "object" || Array.isArray(state.memory)) {
        state.memory = { world: [], characters: {} };
        changed = true;
    }
    if (!Array.isArray(state.memory.world)) {
        state.memory.world = [];
        changed = true;
    }
    if (!state.memory.characters || typeof state.memory.characters !== "object" || Array.isArray(state.memory.characters)) {
        state.memory.characters = {};
        changed = true;
    }
    state.memory.world = retainMemories(state.memory.world.filter(item => item && typeof item === "object" && String(item.text ?? "").trim()), 60);
    for (const [characterId, items] of Object.entries(state.memory.characters)) {
        if (!Array.isArray(items)) {
            delete state.memory.characters[characterId];
            changed = true;
            continue;
        }
        state.memory.characters[characterId] = retainMemories(items.filter(item => item && typeof item === "object" && String(item.text ?? "").trim()), 40);
    }

    if (!state.settings || typeof state.settings !== "object" || Array.isArray(state.settings)) {
        state.settings = {};
        changed = true;
    }

    const defaultSettings = {
        interfaceMode: "developer",
        stateTrackerEnabled: true,
        contextInjectionEnabled: true,
        recentEventLimit: 6,
        maxPresentCardChars: 4200,
        maxRelatedCardChars: 1200,
        maxPersonaChars: 2400,
        themeEnabled: true,
        responsivePhone: true,
        compactMessageControls: true,
        openingComponentsEnabled: true,
        worldPackEnabled: true,
        externalPromptsEnabled: true,
        maxWorldDocChars: 12000,
        maxPlayerDocChars: 3200,
        maxStyleDocChars: 8000,
        socialNotificationsEnabled: true,
    };

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (state.settings[key] === undefined) {
            state.settings[key] = value;
            changed = true;
        }
    }

    if (!["developer", "player"].includes(state.settings.interfaceMode)) {
        state.settings.interfaceMode = "developer";
        changed = true;
    }

    state.settings.recentEventLimit = Math.min(20, Math.max(1, Number(state.settings.recentEventLimit) || 6));
    state.settings.maxPresentCardChars = Math.min(12000, Math.max(1000, Number(state.settings.maxPresentCardChars) || 4200));
    state.settings.maxRelatedCardChars = Math.min(5000, Math.max(300, Number(state.settings.maxRelatedCardChars) || 1200));
    state.settings.maxPersonaChars = Math.min(6000, Math.max(300, Number(state.settings.maxPersonaChars) || 2400));

    if (!state.safety || typeof state.safety !== "object" || Array.isArray(state.safety)) {
        state.safety = {};
        changed = true;
    }

    const safetyDefaults = {
        lastAutoUpdate: null,
        lastIntegrityReport: null,
        lastExportAt: null,
        lastImportAt: null,
        historyCheckpoints: [],
        historyBaseSnapshot: null,
        activeCheckpointId: null,
        lastHistorySyncAt: null,
        lastHistorySyncReason: "",
    };

    for (const [key, value] of Object.entries(safetyDefaults)) {
        if (state.safety[key] === undefined) {
            state.safety[key] = value;
            changed = true;
        }
    }

    if (!state.runtime || typeof state.runtime !== "object" || Array.isArray(state.runtime)) {
        state.runtime = {};
        changed = true;
    }

    const runtimeDefaults = {
        lastProcessedMessageId: null,
        lastTrackerStatus: "idle",
        lastTrackerError: "",
        lastProcessedAt: null,
    };

    for (const [key, value] of Object.entries(runtimeDefaults)) {
        if (state.runtime[key] === undefined) {
            state.runtime[key] = value;
            changed = true;
        }
    }

    if (!Array.isArray(state.exposureHistory)) { state.exposureHistory = []; changed = true; }
    if (state.settings.socialGenerationEnabled === undefined) { state.settings.socialGenerationEnabled = true; changed = true; }
    if (state.settings.maxSocialPerTurn === undefined) { state.settings.maxSocialPerTurn = 3; changed = true; }
    if ((Number(state.version) || 0) < 14) {
        if (state.settings.maxWorldDocChars === 7000) state.settings.maxWorldDocChars = 12000;
        if (state.settings.maxStyleDocChars === 2600) state.settings.maxStyleDocChars = 8000;
        for (const character of Object.values(state.characters)) {
            character.contactStatus = (state.messages[character.id] ?? []).length ? "friend" : "known";
            character.profileMeta ??= { locked: {}, sources: {} };
            for (const [key, value] of Object.entries(character.profile ?? {})) {
                if (value && value !== "还没有设置个人签名。" && !["name", "handle", "commonContacts"].includes(key)) character.profileMeta.locked[key] = true;
            }
            if (character.type === "main") character.profileInitialized = false;
        }
        state.safety.lastAutoUpdate = null;
        changed = true;
    }
    if (state.version !== STATE_VERSION) {
        state.version = STATE_VERSION;
        changed = true;
    }

    return changed;
}

async function ensureState() {
    const owner = captureOwner();
    if (!owner.chatId || !owner.metadata) return null;
    const pending = statePreparation.get(owner.metadata);
    if (pending) { const state = await pending; assertOwner(owner); return state; }
    const task = prepareCurrentState();
    statePreparation.set(owner.metadata, task);
    try { return await task; } finally { statePreparation.delete(owner.metadata); }
}

async function prepareCurrentState() {
    const context = getContext();
    const owner = captureOwner(context);

    if (!context.getCurrentChatId?.()) return null;

    const metadata = context.chatMetadata;
    if (!metadata) return null;

    let changed = false;

    if (!metadata[AIRP_KEY]) {
        metadata[AIRP_KEY] = createDefaultState();
        changed = true;
    }

    if (!recoveryChecked.has(metadata)) {
        recoveryChecked.add(metadata);
        try {
            const local = await readBackup(recoveryKey(owner));
            if (local?.dirty && local.state && Number(local.baseRevision) === Number(metadata[AIRP_KEY].runtime?.revision ?? 0)) {
                metadata[AIRP_KEY] = local.state;
                metadata[AIRP_KEY].runtime.saveStatus = "pending";
                metadata[AIRP_KEY].runtime.saveError = "发现未保存的本机进度，请重试保存";
            } else if (local?.state && (local.dirty || Number(local.state.runtime?.revision ?? 0) > Number(metadata[AIRP_KEY].runtime?.revision ?? 0))) {
                metadata[AIRP_KEY].runtime.recoveryConflict = true;
                metadata[AIRP_KEY].runtime.saveError = "服务器进度与本机未保存进度不同。请先导出两份存档，再选择恢复。";
            }
        } catch (error) { console.warn(`[${MODULE_NAME}] local recovery`, error); }
    }

    if (normalizeState(metadata[AIRP_KEY])) {
        changed = true;
    }

    stateOwners.set(metadata[AIRP_KEY], owner);
    if (changed && !metadata[AIRP_KEY].runtime.recoveryConflict && !pendingCommits.has(metadata)) await saveState(metadata[AIRP_KEY]);
    assertOwner(owner);
    return metadata[AIRP_KEY];
}

async function saveState(state = getContext().chatMetadata?.[AIRP_KEY]) {
    if (!state) return;
    const owner = stateOwners.get(state) ?? captureOwner();
    assertOwner(owner);
    if (pendingCommits.has(owner.metadata) && pendingCommits.get(owner.metadata) !== state) throw new Error("有未保存的状态更新，请先重试保存");
    if (state.runtime.recoveryConflict) throw new Error(state.runtime.saveError);
    const baseRevision = Number(state.runtime.revision) || 0;
    state.runtime.saveStatus = "pending";
    await writeRecovery(owner, state, true);
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
        assertOwner(owner);
        try {
            if (typeof owner.context.saveMetadata !== "function") throw new Error("酒馆保存接口不可用");
            state.runtime.revision = baseRevision + 1;
            state.runtime.saveStatus = "submitted";
            state.runtime.lastSavedAt = new Date().toISOString();
            state.runtime.saveError = "";
            await writeRecovery(owner, state, true, baseRevision);
            checkedSaveResult(await owner.context.saveMetadata());
            assertOwner(owner);
            state.runtime.saveStatus = "submitted";
            state.runtime.saveError = "";
            state.runtime.lastSavedAt = new Date().toISOString();
            await writeRecovery(owner, state, false);
            return;
        } catch (error) {
            failure = error;
            // Do not submit an old chat through an API bound to the current chat.
            assertOwner(owner);
        }
    }
    state.runtime.revision = baseRevision;
    state.runtime.saveStatus = "failed";
    state.runtime.saveError = String(failure?.message ?? failure);
    await writeRecovery(owner, state, true);
    throw failure;
}

/* =========================================================
   当前世界角色管理
   ========================================================= */

function findCharacterByCard(state, avatar) {
    return Object.values(state.characters).find(
        character =>
            character.type === "main" &&
            character.source?.type === "sillytavern-card" &&
            character.source?.cardAvatar === avatar,
    ) ?? null;
}

async function addCardToWorld(avatar) {
    const state = await ensureState();
    if (!state) return;

    const card = getCardByAvatar(avatar);
    if (!card) return;

    const existing = findCharacterByCard(state, avatar);

    if (existing) {
        existing.active = true;
        existing.activeManualVersion = createId("active");
        existing.activeManualValue = true;
        existing.profile.name = card.name;
    } else {
        const character = createCharacterFromCard(card);
        state.characters[character.id] = character;
    }

    await saveState(state);
    await renderCurrentView();
}

async function removeCardFromWorld(avatar) {
    const state = await ensureState();
    if (!state) return;

    const character = findCharacterByCard(state, avatar);
    if (!character) return;

    character.active = false;
    character.activeManualVersion = createId("active");
    character.activeManualValue = false;

    state.world.presentCharacterIds = (state.world.presentCharacterIds ?? [])
        .filter(id => id !== character.id);

    state.pendingExposures = (state.pendingExposures ?? [])
        .filter(exposure => exposure.characterId !== character.id);

    for (const reaction of state.reactions ?? []) {
        if (reaction.characterId === character.id && reaction.status === "pending") {
            reaction.status = "ignored";
            reaction.resolvedAt = new Date().toISOString();
        }
    }

    for (const action of state.actions ?? []) {
        if (action.actorId === character.id && action.status === "pending") {
            action.status = "cancelled";
            action.completedAt = new Date().toISOString();
        }
    }

    await saveState(state);
    await renderCurrentView();
}

/* =========================================================
   角色显示数据
   ========================================================= */

function resolveCharacter(character) {
    if (!character) return null;

    const profile = character.profile ?? {};
    let card = null;

    if (character.type === "main" && character.source?.type === "sillytavern-card") {
        card = getCardByAvatar(character.source.cardAvatar);
    }

    const name = card?.name || profile.name || "未命名角色";
    const avatarUrl = profile.avatar || getCardAvatarUrl(card);

    return {
        ...character,
        display: {
            name,
            avatarUrl,
            handle: profile.handle || `@${name}`,
            signature: profile.signature || "",
            identity: profile.identity || "",
            grade: profile.grade || "",
            department: profile.department || "",
            organization: profile.organization || "",
            background: profile.background || "",
            bio: profile.bio || "",
            cover: profile.cover || "",
            commonContacts: Number(profile.commonContacts) || 0,
        },
        internal: character.internal ?? createDefaultInternal(),
        status: character.status ?? createDefaultCharacterStatus(),
    };
}

function getWorldCharacters(state, includeInactive = false) {
    return Object.values(state.characters)
        .filter(character => includeInactive || character.active !== false)
        .map(resolveCharacter)
        .filter(Boolean);
}

function getCharacterName(state, characterId) {
    if (characterId === "player") return "你";
    return resolveCharacter(state.characters[characterId])?.display?.name ?? "未知角色";
}

const CONTACT_LABELS = { known: "未加好友", requested: "已申请好友", incoming: "对方申请好友", friend: "好友", blocked: "已屏蔽" };

function areFriends(state, a, b) {
    if (a === b) return true;
    if (a === "player" || b === "player") {
        const character = state.characters[a === "player" ? b : a];
        return Boolean(character?.active !== false && character?.contactStatus === "friend");
    }
    return Object.values(state.characterRelations ?? {}).some(rel => rel.characterIds?.includes(a) && rel.characterIds?.includes(b) && rel.friendship === true);
}

function canViewMoment(state, moment, viewer = "player") {
    return moment.authorId === viewer || areFriends(state, moment.authorId, viewer);
}

function getPendingPrivateMessages(state) {
    return Object.values(state.messages ?? {}).flat().filter(message => message.senderId === "player" && state.characters[message.receiverId]?.active !== false && !["handled", "ignored"].includes(message.processingStatus)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function finishExposure(state, exposure, outcome, interpretation = "") {
    state.exposureHistory ??= [];
    state.exposureHistory.push({ ...exposure, outcome, interpretation, resolvedAt: state.world.datetime || "", recordedAt: new Date().toISOString() });
    state.pendingExposures = state.pendingExposures.filter(item => item.id !== exposure.id);
}

// New social items can be referenced before their generated event IDs are known.
// Retry only unresolved entries when those refs become available, not all updates.
function applyInformationDelta(state, delta, refs, processed) {
    for (const item of (delta.exposures ?? []).slice(0, 40)) {
        if (processed.has(item)) continue;
        const eventId = resolveEventRef(state, item.eventId, refs) ?? resolveEventRef(state, item.eventRef, refs);
        const exposure = item.exposureId
            ? getPendingExposureById(state, item.exposureId)
            : eventId ? getPendingExposure(state, eventId, item.characterId) : null;
        if (!exposure) continue;
        processed.add(item);
        const outcome = String(item.outcome ?? "defer");
        if (outcome === "missed") {
            finishExposure(state, exposure, "missed", truncateText(item.interpretation || item.reason || "", 500));
        } else if (outcome === "seen") {
            const interpretation = truncateText(item.interpretation ?? "", 500);
            finishExposure(state, exposure, "seen", interpretation);
            setCharacterKnowledge(state, exposure.characterId, exposure.eventId, {
                source: exposure.channel,
                certainty: item.certainty ?? exposure.certainty,
                interpretation,
                learnedAt: state.world.datetime || getEventById(state, exposure.eventId)?.time || "",
            });
        } else if (outcome === "defer") {
            exposure.deferReason = truncateText(item.reason || item.interpretation || "尚未到合理的阅读时机", 500);
            exposure.lastCheckedAt = new Date().toISOString();
        }
    }
    for (const item of (delta.knowledge ?? []).slice(0, 40)) {
        if (processed.has(item)) continue;
        const eventId = resolveEventRef(state, item.eventId, refs) ?? resolveEventRef(state, item.eventRef, refs);
        const characterId = String(item.characterId ?? "");
        if (!state.characters[characterId] || !eventId) continue;
        processed.add(item);
        if (item.known === false) removeCharacterKnowledge(state, characterId, eventId);
        else setCharacterKnowledge(state, characterId, eventId, {
            source: item.source,
            certainty: item.certainty,
            learnedAt: item.learnedAt ?? state.world.datetime,
            interpretation: truncateText(item.interpretation ?? "", 500),
            triggerReaction: item.triggerReaction !== false,
        });
    }
}

function registerExecutionRefs(item, result, eventRefs, artifactRefs) {
    if (!item.ref || !result?.event) return;
    eventRefs.set(String(item.ref), result.event.id);
    if (result.artifact?.id) artifactRefs.set(String(item.ref), result.artifact.id);
}

function updateProfileFromModel(character, incoming = {}, source = "model") {
    character.profileMeta ??= { locked: {}, sources: {} };
    for (const key of ["handle", "signature", "identity", "grade", "department", "organization", "background", "bio"]) {
        if (incoming[key] === undefined || character.profileMeta.locked?.[key]) continue;
        character.profile[key] = truncateText(incoming[key], ["background", "bio"].includes(key) ? 1600 : 240);
        character.profileMeta.sources[key] = source;
    }
}

function applyCharacterSetup(state, delta, rejected) {
    const refs = new Map();
    for (const incoming of (delta.npcs ?? []).slice(0, 3)) {
        const name = truncateText(incoming.name ?? incoming.profile?.name ?? "", 80);
        const ref = String(incoming.ref ?? "");
        if (!name || !ref || state.characters[ref] || refs.has(ref)) { rejected.push("npc:missing-or-duplicate-ref"); continue; }
        let character = Object.values(state.characters).find(item => item.active !== false && item.profile?.name === name);
        if (!character) {
            character = createNpcCharacter(name);
            character.source = { type: "model-npc", origin: truncateText(incoming.reason ?? "剧情发展", 400) };
            state.characters[character.id] = character;
        }
        updateProfileFromModel(character, incoming.profile ?? incoming);
        if (incoming.modelNotes && (character.source.type === "model-npc" || !character.internal.modelNotes)) character.internal.modelNotes = truncateText(incoming.modelNotes, 2000);
        if (character.source.type === "model-npc" && incoming.playerRelationship) character.impression = truncateText(incoming.playerRelationship, 500);
        refs.set(ref, character.id);
    }
    // Resolve temporary character references only in identity fields, never prose.
    const visit = value => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
            if (["characterId", "actorId", "authorId", "targetCharacterId", "receiverId", "senderId"].includes(key) && refs.has(item)) value[key] = refs.get(item);
            else if (["characterIds", "participants", "witnesses", "audienceCharacterIds", "presentCharacterIds"].includes(key) && Array.isArray(item)) value[key] = item.map(id => refs.get(id) ?? id);
            else if (key === "perspectives" && item && typeof item === "object") {
                for (const id of Object.keys(item)) if (refs.has(id)) { item[refs.get(id)] = item[id]; delete item[id]; }
            } else visit(item);
        }
    };
    visit(delta);
    for (const incoming of (delta.characterInitializations ?? []).slice(0, 5)) {
        const character = state.characters[incoming.characterId];
        if (!character || character.type !== "main" || character.profileInitialized) continue;
        updateProfileFromModel(character, incoming.profile ?? {}, "card");
        if (incoming.reason && Object.values(character.relation).every(value => value === 0)) {
            for (const key of RELATION_KEYS) if (Number.isFinite(Number(incoming.relation?.[key]))) character.relation[key] = clamp(incoming.relation[key]);
            if (incoming.relationLabel) character.relationLabel = truncateText(incoming.relationLabel, 80);
        }
        character.profileInitialized = true;
        if (incoming.contactStatus === "friend" && incoming.reason && character.contactStatus !== "blocked") { character.contactStatus = "friend"; character.contactSource = truncateText(incoming.reason, 400); }
        character.initializationSource = truncateText(incoming.reason ?? "角色卡资料初始化", 500);
    }
    for (const incoming of (delta.profileUpdates ?? []).slice(0, 10)) {
        const character = state.characters[incoming.characterId];
        if (character?.active !== false && character) updateProfileFromModel(character, incoming.profile ?? incoming);
    }
}

function applyFriendships(state, delta, eventRefMap, rejected) {
    for (const incoming of (delta.friendships ?? []).slice(0, 10)) {
        const character = state.characters[incoming.characterId];
        if (!character || !CONTACT_LABELS[incoming.status] || !String(incoming.reason ?? "").trim() || character.contactStatus === "blocked") continue;
        const eventId = resolveEventRef(state, incoming.eventId ?? incoming.eventRef, eventRefMap);
        if (incoming.status === "friend" && !["requested", "incoming"].includes(character.contactStatus) && (!eventId || !characterKnowsEvent(state, character.id, eventId))) { rejected.push(`friend:${character.id}:missing-exchange`); continue; }
        if (incoming.status === "incoming" && character.contactStatus !== "incoming") createNotification(state, { type: "friend_request", actorId: character.id, text: `${getCharacterName(state, character.id)}请求添加你为好友`, sourceId: character.id });
        character.contactStatus = incoming.status;
        character.contactSource = truncateText(incoming.reason, 400);
    }
}

async function changeFriendship(characterId, status) {
    const state = await ensureState();
    const character = state?.characters[characterId];
    if (!character || !CONTACT_LABELS[status]) return;
    if (status === "friend" && character.contactStatus !== "incoming") return;
    character.contactStatus = status;
    character.contactManualStatus = status;
    character.contactManualVersion = createId("contact");
    const event = addEventToState(state, { summary: `${getContext().name1 || "你"}${status === "requested" ? "向" + getCharacterName(state, characterId) + "发送好友申请" : "更新了与" + getCharacterName(state, characterId) + "的联系人状态：" + CONTACT_LABELS[status]}`, channel: "private_chat", visibility: "private", participants: [], audienceCharacterIds: [characterId], tags: ["玩家操作", "好友申请"] });
    character.contactSource = event.id;
    await saveState(state);
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

/* =========================================================
   信息传播候选
   ========================================================= */

function getPendingExposure(state, eventId, characterId) {
    return (state.pendingExposures ?? []).find(
        exposure => exposure.eventId === eventId && exposure.characterId === characterId,
    ) ?? null;
}

function getPendingExposureById(state, exposureId) {
    return (state.pendingExposures ?? []).find(exposure => exposure.id === exposureId) ?? null;
}

function getPendingExposureCountForEvent(state, eventId) {
    return (state.pendingExposures ?? [])
        .filter(exposure => exposure.eventId === eventId)
        .length;
}

function removePendingExposure(state, eventId, characterId) {
    const before = (state.pendingExposures ?? []).length;
    state.pendingExposures = (state.pendingExposures ?? [])
        .filter(exposure => !(exposure.eventId === eventId && exposure.characterId === characterId));
    return state.pendingExposures.length !== before;
}

function addPendingExposure(state, event, characterId, data = {}) {
    const character = state.characters[characterId];
    if (!character || character.active === false) return false;
    if (character.knowledge?.[event.id]) return false;
    if (getPendingExposure(state, event.id, characterId)) return false;

    state.pendingExposures.push({
        id: createId("exp"),
        eventId: event.id,
        characterId,
        channel: data.channel ?? event.channel ?? "other",
        certainty: clamp(data.certainty ?? getKnowledgeDefaultCertainty(event), 0, 1),
        reason: String(data.reason ?? ""),
        createdAt: new Date().toISOString(),
    });

    return true;
}

function createPropagationCandidates(state, event) {
    const activeIds = getWorldCharacters(state).map(character => character.id);
    const forced = new Set([
        ...event.participants.filter(id => id !== "player"),
        ...event.witnesses.filter(id => id !== "player"),
    ]);

    const explicitAudience = (event.audienceCharacterIds ?? [])
        .filter(id => state.characters[id]?.active !== false);

    // 私聊 / 群聊 / 明确的口耳相传属于直接送达：选中的对象立即知情。
    if (DIRECT_DELIVERY_CHANNELS.has(event.channel)) {
        for (const characterId of explicitAudience) {
            if (forced.has(characterId)) continue;
            setCharacterKnowledge(state, characterId, event.id, {
                source: event.channel,
                certainty: getKnowledgeDefaultCertainty(event),
                learnedAt: event.time || state.world.datetime || "",
            });
        }
        return;
    }

    // 单纯现场事件只由参与者 / 目击者得知，不擅自扩散。
    if (event.channel === "scene" && !["social", "public", "rumor"].includes(event.visibility)) {
        return;
    }

    let targets = [];

    // 论坛 / 朋友圈：不指定对象时，默认当前世界所有活跃角色都有“看到的可能”。
    if (BROADCAST_CHANNELS.has(event.channel)) {
        targets = explicitAudience.length ? explicitAudience : activeIds;
        if (event.channel === "moments") {
            const authorId = event.authorId ?? event.participants[0] ?? "player";
            targets = targets.filter(id => areFriends(state, authorId, id));
        }
    } else if (["social", "public", "rumor"].includes(event.visibility)) {
        // 其他公开 / 社交 / 传言渠道也默认形成广域传播候选。
        targets = explicitAudience.length ? explicitAudience : activeIds;
    } else if (event.visibility === "limited") {
        // 小范围事件只对明确选中的对象形成候选。
        targets = explicitAudience;
    } else {
        targets = explicitAudience;
    }

    for (const characterId of [...new Set(targets)]) {
        if (forced.has(characterId)) continue;
        if (state.characters[characterId]?.knowledge?.[event.id]) continue;
        if ((state.exposureHistory ?? []).some(item => item.eventId === event.id && item.characterId === characterId && item.outcome === "missed")) continue;

        addPendingExposure(state, event, characterId, {
            channel: event.channel,
            certainty: getKnowledgeDefaultCertainty(event),
            reason: BROADCAST_CHANNELS.has(event.channel)
                ? `${CHANNEL_LABELS[event.channel] || "公开渠道"}中已经出现这条信息`
                : `${VISIBILITY_LABELS[event.visibility] || "传播事件"}使其有机会获知`,
        });
    }
}

/* =========================================================
   知情系统
   ========================================================= */

function getKnowledgeDefaultCertainty(event) {
    return event?.visibility === "rumor" ? 0.55 : 1;
}

function setCharacterKnowledge(state, characterId, eventId, data = {}) {
    const character = state.characters[characterId];
    const event = state.events.find(item => item.id === eventId);

    if (!character || !event) return false;

    if (!character.knowledge || typeof character.knowledge !== "object") {
        character.knowledge = {};
    }

    const wasKnown = Boolean(character.knowledge[eventId]);
    const existing = character.knowledge[eventId] ?? {};

    character.knowledge[eventId] = {
        source: data.source ?? existing.source ?? event.channel ?? "scene",
        certainty: clamp(
            data.certainty ?? existing.certainty ?? getKnowledgeDefaultCertainty(event),
            0,
            1,
        ),
        learnedAt: data.learnedAt ?? existing.learnedAt ?? state.world.datetime ?? event.time ?? "",
        interpretation: data.interpretation || existing.interpretation || event.publicSummary || "",
    };

    removePendingExposure(state, eventId, characterId);

    // 新获得的信息才进入“待反应”；现场参与 / 目击会显式关闭这一项，
    // 因为他们的即时反应应该直接写进当前正文，而不是异步排队。
    if (!wasKnown && data.triggerReaction !== false) {
        createReactionCandidate(state, characterId, eventId, {
            source: character.knowledge[eventId].source,
        });
    }

    return true;
}

function removeCharacterKnowledge(state, characterId, eventId) {
    const character = state.characters[characterId];
    if (!character?.knowledge?.[eventId]) return false;

    delete character.knowledge[eventId];

    // 如果“知道这件事”被撤销，还没处理的反应也一起撤销；
    // 已处理历史保留，避免回溯时丢记录。
    for (const reaction of state.reactions ?? []) {
        if (
            reaction.characterId === characterId &&
            reaction.eventId === eventId &&
            reaction.status === "pending"
        ) {
            reaction.status = "ignored";
            reaction.resolvedAt = new Date().toISOString();
        }
    }

    return true;
}

function getKnownCharacterIdsForEvent(state, eventId) {
    return Object.values(state.characters)
        .filter(character => Boolean(character.knowledge?.[eventId]))
        .map(character => character.id);
}

function seedEventKnowledge(state, event) {
    const forcedKnowers = new Set([
        ...event.participants.filter(id => id !== "player"),
        ...event.witnesses.filter(id => id !== "player"),
    ]);

    for (const characterId of forcedKnowers) {
        setCharacterKnowledge(state, characterId, event.id, {
            source: event.channel,
            certainty: event.visibility === "rumor" ? 0.7 : 1,
            learnedAt: event.time || state.world.datetime || "",
            triggerReaction: false,
        });
    }
}

/* =========================================================
   事件系统
   ========================================================= */

function addEventToState(state, eventInput = {}) {
    const event = {
        id: eventInput.id || createId("evt"),
        time: eventInput.time ?? state.world.datetime ?? "",
        summary: String(eventInput.summary ?? "").trim(),
        publicSummary: eventInput.publicSummary ? String(eventInput.publicSummary).trim() : null,
        participants: Array.isArray(eventInput.participants)
            ? [...new Set(eventInput.participants)]
            : [],
        witnesses: Array.isArray(eventInput.witnesses)
            ? [...new Set(eventInput.witnesses)]
            : [],
        audienceCharacterIds: Array.isArray(eventInput.audienceCharacterIds)
            ? [...new Set(eventInput.audienceCharacterIds)]
            : [],
        visibility: VISIBILITY_LABELS[eventInput.visibility]
            ? eventInput.visibility
            : "private",
        channel: CHANNEL_LABELS[eventInput.channel]
            ? eventInput.channel
            : "scene",
        sourceEventId: eventInput.sourceEventId || null,
        authorId: eventInput.authorId ?? null,
        tags: Array.isArray(eventInput.tags)
            ? [...new Set(eventInput.tags.map(tag => String(tag).trim()).filter(Boolean))]
            : [],
        createdAt: eventInput.createdAt || new Date().toISOString(),
    };

    state.events.push(event);
    seedEventKnowledge(state, event);
    createPropagationCandidates(state, event);
    return event;
}

function getEventById(state, eventId) {
    return state.events.find(event => event.id === eventId) ?? null;
}

function getEventParticipantNames(state, ids = []) {
    return ids.map(id => getCharacterName(state, id));
}

/* =========================================================
   角色间关系图谱
   ========================================================= */

function getRelationKey(characterIdA, characterIdB) {
    return [characterIdA, characterIdB].sort().join("::");
}

function createPairRelationship(characterIdA, characterIdB) {
    const characterIds = [characterIdA, characterIdB].sort();
    const [a, b] = characterIds;

    return {
        id: getRelationKey(a, b),
        characterIds,
        tags: [],
        summary: "",
        perspectives: {
            [a]: {
                attitude: 0,
                impression: "",
            },
            [b]: {
                attitude: 0,
                impression: "",
            },
        },
    };
}

function getRelationshipSnapshot(state, characterIdA, characterIdB) {
    const key = getRelationKey(characterIdA, characterIdB);
    const stored = state.characterRelations[key];

    if (!stored) {
        return createPairRelationship(characterIdA, characterIdB);
    }

    const snapshot = globalThis.structuredClone
        ? globalThis.structuredClone(stored)
        : JSON.parse(JSON.stringify(stored));

    const [a, b] = snapshot.characterIds ?? [characterIdA, characterIdB].sort();
    snapshot.characterIds = [a, b];
    snapshot.tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
    snapshot.summary = snapshot.summary ?? "";
    snapshot.perspectives = snapshot.perspectives ?? {};

    for (const id of [a, b]) {
        snapshot.perspectives[id] = snapshot.perspectives[id] ?? {};
        snapshot.perspectives[id].attitude = clampSigned(snapshot.perspectives[id].attitude ?? 0);
        snapshot.perspectives[id].impression = snapshot.perspectives[id].impression ?? "";
    }

    return snapshot;
}

function getActiveCharacterPairs(state) {
    const ids = getWorldCharacters(state)
        .map(character => character.id);

    const pairs = [];

    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            pairs.push([ids[i], ids[j]]);
        }
    }

    return pairs;
}

/* =========================================================
   Reaction：角色获得新信息后的异步反应层
   ========================================================= */

function getReactionById(state, reactionId) {
    return (state.reactions ?? []).find(reaction => reaction.id === reactionId) ?? null;
}

function getPendingReactionForKnowledge(state, characterId, eventId) {
    return (state.reactions ?? []).find(reaction =>
        reaction.characterId === characterId &&
        reaction.eventId === eventId &&
        reaction.trigger === "knowledge" &&
        reaction.status === "pending"
    ) ?? null;
}

function getAnyReactionForKnowledge(state, characterId, eventId) {
    return (state.reactions ?? []).find(reaction =>
        reaction.characterId === characterId &&
        reaction.eventId === eventId &&
        reaction.trigger === "knowledge"
    ) ?? null;
}

function getPendingReactionCount(state) {
    return (state.reactions ?? []).filter(reaction => reaction.status === "pending").length;
}

function getPendingActionCount(state) {
    return (state.actions ?? []).filter(action => action.status === "pending").length;
}

function createReactionCandidate(state, characterId, eventId, data = {}) {
    const character = state.characters[characterId];
    const event = getEventById(state, eventId);

    if (!character || character.active === false || !event) return null;

    // 同一角色对同一条“新知情”只生成一次反应记录。
    const existing = getAnyReactionForKnowledge(state, characterId, eventId);
    if (existing) return existing;

    const reaction = {
        id: createId("react"),
        characterId,
        eventId,
        trigger: "knowledge",
        source: data.source ?? character.knowledge?.[eventId]?.source ?? event.channel ?? "other",
        status: "pending",
        summary: "",
        relationChanges: {},
        relationLabel: null,
        npcAttitudeDelta: 0,
        npcImpression: null,
        actionId: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
    };

    state.reactions.push(reaction);
    return reaction;
}

function createActionFromReaction(state, reaction, actionInput = {}) {
    const type = ACTION_LABELS[actionInput.type] ? actionInput.type : "none";
    if (type === "none") return null;

    const actor = state.characters[reaction.characterId];
    if (!actor) return null;

    const requestedTarget = actionInput.targetCharacterId ?? "player";
    const targetCharacterId = requestedTarget === "player" || state.characters[requestedTarget]
        ? requestedTarget
        : "player";

    const timing = ACTION_TIMING_LABELS[actionInput.timing]
        ? actionInput.timing
        : "later";

    const action = {
        id: createId("act"),
        reactionId: reaction.id,
        eventId: reaction.eventId,
        actorId: reaction.characterId,
        targetCharacterId,
        type,
        timing,
        note: String(actionInput.note ?? "").trim(),
        targetArtifactId: actionInput.targetArtifactId ?? null,
        status: "pending",
        createdAt: new Date().toISOString(),
        completedAt: null,
        executedArtifactId: null,
        executedEventId: null,
    };

    state.actions.push(action);
    reaction.actionId = action.id;
    return action;
}

function resolveReactionInState(state, reactionId, resolution = {}) {
    const reaction = getReactionById(state, reactionId);
    if (!reaction || reaction.status !== "pending") return false;

    const character = state.characters[reaction.characterId];
    if (!character) return false;

    const appliedChanges = {};

    if (character.type === "main") {
        const requestedChanges = resolution.relationChanges ?? {};

        for (const key of Object.keys(createDefaultRelation())) {
            if (requestedChanges[key] === undefined) continue;

            const requestedDelta = Number(requestedChanges[key]);
            if (!Number.isFinite(requestedDelta) || requestedDelta === 0) continue;

            const before = clamp(character.relation?.[key] ?? 0);
            const after = clamp(before + requestedDelta);
            character.relation[key] = after;
            appliedChanges[key] = after - before;
        }

        if (resolution.relationLabel !== undefined && String(resolution.relationLabel).trim()) {
            character.relationLabel = String(resolution.relationLabel).trim();
            reaction.relationLabel = character.relationLabel;
        }
    } else if (character.type === "npc") {
        const requestedDelta = Number(resolution.npcAttitudeDelta ?? 0);
        const before = clampSigned(character.attitude ?? 0);
        const after = clampSigned(before + (Number.isFinite(requestedDelta) ? requestedDelta : 0));

        character.attitude = after;
        reaction.npcAttitudeDelta = after - before;

        if (resolution.npcImpression !== undefined && String(resolution.npcImpression).trim()) {
            character.impression = String(resolution.npcImpression).trim();
            reaction.npcImpression = character.impression;
        }
    }

    reaction.relationChanges = appliedChanges;
    reaction.summary = String(resolution.summary ?? "").trim();
    reaction.status = "resolved";
    reaction.resolvedAt = new Date().toISOString();

    createActionFromReaction(state, reaction, resolution.action ?? {});
    return true;
}

function ignoreReactionInState(state, reactionId) {
    const reaction = getReactionById(state, reactionId);
    if (!reaction || reaction.status !== "pending") return false;

    reaction.status = "ignored";
    reaction.resolvedAt = new Date().toISOString();
    return true;
}

function setActionStatusInState(state, actionId, status) {
    const action = (state.actions ?? []).find(item => item.id === actionId);
    if (!action || action.status !== "pending") return false;
    if (!["done", "cancelled"].includes(status)) return false;

    action.status = status;
    action.completedAt = new Date().toISOString();
    return true;
}


/* =========================================================
   社交内容 / Action 执行
   ========================================================= */

function getActionById(state, actionId) {
    return (state.actions ?? []).find(action => action.id === actionId) ?? null;
}

function isSocialAction(action) {
    return ["private_chat", "moments", "forum", "moment_comment", "moment_like", "forum_reply"].includes(action?.type);
}

function getMessageThreadKey(memberA, memberB) {
    if (memberA === "player") return String(memberB);
    if (memberB === "player") return String(memberA);
    return `private:${[memberA, memberB].sort().join("::")}`;
}


function createNotification(state, {
    type = "system",
    actorId = null,
    text = "",
    sourceType = "",
    sourceId = null,
    time = "",
    anonymousLabel = "",
}) {
    if (state.settings?.socialNotificationsEnabled === false) return null;
    if (!Array.isArray(state.notifications)) state.notifications = [];

    const notification = {
        id: createId("notify"),
        type,
        actorId,
        text: String(text ?? "").trim(),
        sourceType,
        sourceId,
        anonymousLabel,
        time: time || state.world.datetime || "",
        read: false,
        createdAt: new Date().toISOString(),
    };
    state.notifications.push(notification);
    return notification;
}

function getUnreadNotificationCount(state) {
    return (state.notifications ?? []).filter(item => !item.read).length;
}

function markAllNotificationsRead(state) {
    let changed = false;
    for (const item of state.notifications ?? []) {
        if (!item.read) {
            item.read = true;
            changed = true;
        }
    }
    return changed;
}

function getMomentById(state, momentId) {
    return (state.moments ?? []).find(item => item.id === momentId) ?? null;
}

function getForumPostById(state, postId) {
    return (state.forum ?? []).find(item => item.id === postId) ?? null;
}

function addMomentComment(state, momentId, {
    authorId = "player",
    text = "",
    time = "",
}) {
    const moment = getMomentById(state, momentId);
    const body = String(text ?? "").trim();
    if (!moment || !body || !canViewMoment(state, moment, authorId)) return null;
    if (!Array.isArray(moment.comments)) moment.comments = [];

    const comment = {
        id: createId("mcomment"),
        authorId,
        text: body,
        time: time || state.world.datetime || "",
        createdAt: new Date().toISOString(),
    };
    moment.comments.push(comment);

    if (authorId !== "player" && moment.authorId === "player") {
        createNotification(state, {
            type: "moment_comment",
            actorId: authorId,
            text: body,
            sourceType: "moment",
            sourceId: moment.id,
            time: comment.time,
        });
    }
    return comment;
}

function toggleMomentLike(state, momentId, actorId = "player") {
    const moment = getMomentById(state, momentId);
    if (!moment || !canViewMoment(state, moment, actorId)) return false;
    if (!Array.isArray(moment.likes)) moment.likes = [];
    const index = moment.likes.indexOf(actorId);
    if (index >= 0) {
        moment.likes.splice(index, 1);
        return false;
    }
    moment.likes.push(actorId);
    if (actorId !== "player" && moment.authorId === "player") {
        createNotification(state, {
            type: "moment_like",
            actorId,
            text: "赞了你的朋友圈",
            sourceType: "moment",
            sourceId: moment.id,
            time: state.world.datetime || "",
        });
    }
    return true;
}

function addForumReply(state, postId, {
    authorId = "player",
    text = "",
    anonymous = false,
    time = "",
}) {
    const post = getForumPostById(state, postId);
    const body = String(text ?? "").trim();
    if (!post || !body) return null;
    if (!Array.isArray(post.replies)) post.replies = [];

    const reply = {
        id: createId("reply"),
        authorId,
        text: body,
        anonymous: Boolean(anonymous),
        anonymousLabel: anonymous ? `匿名用户 ${hashString(`${authorId}:${Date.now()}`).toUpperCase().slice(-3).padStart(3, "0")}` : "",
        time: time || state.world.datetime || "",
        createdAt: new Date().toISOString(),
    };
    post.replies.push(reply);

    if (authorId !== "player" && post.authorId === "player") {
        createNotification(state, {
            type: "forum_reply",
            anonymousLabel: anonymous ? reply.anonymousLabel : "",
            actorId: authorId,
            text: body,
            sourceType: "forum",
            sourceId: post.id,
            time: reply.time,
        });
    }
    return reply;
}

function appendPrivateMessage(state, {
    senderId,
    receiverId,
    text,
    time = "",
    eventId = null,
    actionId = null,
}) {
    if (!areFriends(state, senderId, receiverId)) throw new Error("未加好友，不能发送私聊");
    const threadKey = getMessageThreadKey(senderId, receiverId);

    if (!Array.isArray(state.messages[threadKey])) {
        state.messages[threadKey] = [];
    }

    const message = {
        id: createId("msg"),
        senderId,
        receiverId,
        text: String(text ?? "").trim(),
        time: time || state.world.datetime || "",
        eventId,
        actionId,
        read: senderId === "player",
        createdAt: new Date().toISOString(),
        processingStatus: senderId === "player" ? "pending" : null,
    };

    state.messages[threadKey].push(message);
    if (receiverId === "player") {
        for (const pending of getPendingPrivateMessages(state).filter(item => item.receiverId === senderId)) {
            pending.processingStatus = "handled";
            pending.handledByMessageId = message.id;
        }
    }

    if (senderId !== "player" && receiverId === "player") {
        createNotification(state, {
            type: "private_chat",
            actorId: senderId,
            text: message.text,
            sourceId: message.id,
            time: message.time,
        });
    }

    return message;
}

function appendMoment(state, {
    authorId,
    text,
    time = "",
    eventId = null,
    actionId = null,
}) {
    const moment = {
        id: createId("moment"),
        authorId,
        text: String(text ?? "").trim(),
        time: time || state.world.datetime || "",
        eventId,
        actionId,
        likes: [],
        comments: [],
        createdAt: new Date().toISOString(),
    };

    state.moments.push(moment);
    return moment;
}

function appendForumPost(state, {
    authorId,
    title = "",
    text,
    anonymous = false,
    time = "",
    eventId = null,
    actionId = null,
}) {
    const post = {
        id: createId("post"),
        authorId,
        title: String(title ?? "").trim(),
        text: String(text ?? "").trim(),
        anonymous: Boolean(anonymous),
        anonymousLabel: anonymous ? `匿名用户 ${hashString(`${authorId}:${Date.now()}`).toUpperCase().slice(-3).padStart(3, "0")}` : "",
        time: time || state.world.datetime || "",
        eventId,
        actionId,
        replies: [],
        createdAt: new Date().toISOString(),
    };

    state.forum.push(post);
    return post;
}

function executeActionInState(state, actionId, execution = {}) {
    const action = getActionById(state, actionId);
    if (!action || action.status !== "pending") return null;

    const actor = state.characters[action.actorId];
    if (!actor || actor.active === false) return null;
    if (action.type === "private_chat" && !areFriends(state, action.actorId, action.targetCharacterId)) { action.lastError = "未加好友，私聊暂未发送"; return null; }
    if (["moment_comment", "moment_like"].includes(action.type)) {
        const target = state.moments.find(item => item.id === action.targetArtifactId);
        if (!target || !canViewMoment(state, target, action.actorId)) { action.lastError = "动态不存在或不可见"; return null; }
        if (action.type === "moment_like" && target.likes.includes(action.actorId)) { action.status = "done"; return target; }
    }

    const actorName = getCharacterName(state, action.actorId);
    const targetName = getCharacterName(state, action.targetCharacterId);
    const text = String(execution.text ?? "").trim();
    const title = String(execution.title ?? "").trim();
    const time = String(execution.time ?? state.world.datetime ?? "").trim();

    let artifact = null;
    let createdEvent = null;

    if (action.type === "private_chat") {
        if (!text) return null;

        artifact = appendPrivateMessage(state, {
            senderId: action.actorId,
            receiverId: action.targetCharacterId,
            text,
            time,
            eventId: action.eventId,
            actionId: action.id,
        });

        createdEvent = addEventToState(state, {
            time,
            summary: `${actorName}向${targetName}发送私聊：${text}`,
            participants: [
                action.actorId,
                action.targetCharacterId,
            ],
            witnesses: [],
            audienceCharacterIds:
                action.targetCharacterId === "player"
                    ? []
                    : [action.targetCharacterId],
            visibility: "private",
            channel: "private_chat",
            sourceEventId: action.eventId || null,
            tags: ["私聊"],
        });
    } else if (action.type === "moments") {
        if (!text) return null;

        artifact = appendMoment(state, {
            authorId: action.actorId,
            text,
            time,
            eventId: action.eventId,
            actionId: action.id,
        });

        createdEvent = addEventToState(state, {
            time,
            summary: `${actorName}发布朋友圈：${text}`,
            participants: [action.actorId],
            witnesses: [],
            visibility: "social",
            channel: "moments",
            sourceEventId: action.eventId || null,
            tags: ["朋友圈"],
        });
    } else if (action.type === "forum") {
        if (!text && !title) return null;

        artifact = appendForumPost(state, {
            authorId: action.actorId,
            title,
            text,
            anonymous: Boolean(execution.anonymous),
            time,
            eventId: action.eventId,
            actionId: action.id,
        });

        const displayAuthor = execution.anonymous ? "匿名用户" : actorName;
        const subject = title || text;

        createdEvent = addEventToState(state, {
            time,
            summary: `${displayAuthor}发布论坛帖：${subject}`,
            participants: [action.actorId],
            witnesses: [],
            visibility: "public",
            channel: "forum",
            sourceEventId: action.eventId || null,
            tags: ["论坛"],
        });
    } else if (action.type === "moment_comment") {
        if (!text || !action.targetArtifactId) return null;
        artifact = addMomentComment(state, action.targetArtifactId, {
            authorId: action.actorId,
            text,
            time,
        });
        if (!artifact) return null;
        const moment = getMomentById(state, action.targetArtifactId);
        createdEvent = addEventToState(state, {
            time,
            summary: `${actorName}评论朋友圈：${text}`,
            participants: [action.actorId],
            witnesses: [],
            audienceCharacterIds: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
            visibility: "social",
            channel: "moments",
            sourceEventId: action.eventId || moment?.eventId || null,
            tags: ["朋友圈", "评论"],
        });
    } else if (action.type === "moment_like") {
        if (!action.targetArtifactId) return null;
        toggleMomentLike(state, action.targetArtifactId, action.actorId);
        artifact = getMomentById(state, action.targetArtifactId);
        const moment = artifact;
        createdEvent = addEventToState(state, {
            time,
            summary: `${actorName}赞了${moment?.authorId === "player" ? "你的" : `${getCharacterName(state, moment?.authorId)}的`}朋友圈`,
            participants: [action.actorId],
            witnesses: [],
            audienceCharacterIds: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
            visibility: "social",
            channel: "moments",
            sourceEventId: action.eventId || moment?.eventId || null,
            tags: ["朋友圈", "点赞"],
        });
    } else if (action.type === "forum_reply") {
        if (!text || !action.targetArtifactId) return null;
        artifact = addForumReply(state, action.targetArtifactId, {
            authorId: action.actorId,
            text,
            anonymous: Boolean(execution.anonymous),
            time,
        });
        if (!artifact) return null;
        const post = getForumPostById(state, action.targetArtifactId);
        createdEvent = addEventToState(state, {
            time,
            summary: `${execution.anonymous ? "匿名用户" : actorName}回复论坛：${text}`,
            participants: [action.actorId],
            witnesses: [],
            visibility: "public",
            channel: "forum",
            sourceEventId: action.eventId || post?.eventId || null,
            tags: ["论坛", "回复"],
        });
    } else {
        // 非社交类行动暂时由玩家 / 后续模型确认其已发生。
        action.status = "done";
        action.completedAt = new Date().toISOString();
        return {
            action,
            artifact: null,
            event: null,
        };
    }

    if (artifact && createdEvent && action.type !== "moment_like") {
        artifact.eventId = createdEvent.id;
    }

    action.status = "done";
    action.completedAt = new Date().toISOString();
    action.executedArtifactId = artifact?.id ?? null;
    action.executedEventId = createdEvent?.id ?? null;

    return {
        action,
        artifact,
        event: createdEvent,
    };
}

function getPlayerThreadMessages(state, characterId) {
    const messages = state.messages?.[String(characterId)];
    return Array.isArray(messages) ? messages : [];
}

function getUnreadCountForCharacter(state, characterId) {
    return getPlayerThreadMessages(state, characterId)
        .filter(message => message.receiverId === "player" && message.read === false)
        .length;
}

function markThreadRead(state, characterId) {
    let changed = false;

    for (const message of getPlayerThreadMessages(state, characterId)) {
        if (message.receiverId === "player" && message.read === false) {
            message.read = true;
            changed = true;
        }
    }

    for (const notification of state.notifications) if (notification.type === "private_chat" && notification.actorId === characterId && !notification.read) { notification.read = true; changed = true; }
    return changed;
}

/* =========================================================
   V7 · Context Builder / AIRP_STATE 解析 / 自动 State Delta
   ========================================================= */

function truncateText(value, maxChars = 1000) {
    const text = String(value ?? "").trim();
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function getCardField(card, key) {
    return card?.[key] ?? card?.data?.[key] ?? "";
}

function buildCardCoreText(card, maxChars = 4200) {
    if (!card) return "";

    const parts = [];
    const fields = [
        ["角色描述", getCardField(card, "description")],
        ["性格", getCardField(card, "personality")],
        ["场景设定", getCardField(card, "scenario")],
        ["角色备注", getCardField(card, "creator_notes")],
        ["示例对话", getCardField(card, "mes_example")],
    ];

    for (const [label, value] of fields) {
        const text = String(value ?? "").trim();
        if (!text) continue;
        parts.push(`### ${label}\n${text}`);
    }

    return balancedText(parts.join("\n\n"), maxChars);
}

function getRecentKnownEventIds(character, state, limit = 8) {
    const known = new Set(Object.keys(character?.knowledge ?? {}));
    return [...state.events]
        .reverse()
        .filter(event => known.has(event.id))
        .slice(0, limit)
        .map(event => event.id);
}

function getRelevantCharacterIdsForPrompt(state) {
    const ids = new Set(state.world.presentCharacterIds ?? []);
    for (const message of getPendingPrivateMessages(state)) {
        ids.add(message.receiverId);
    }
    for (const character of getWorldCharacters(state)) {
        if (["requested", "incoming"].includes(character.contactStatus)) ids.add(character.id);
    }

    for (const reaction of state.reactions ?? []) {
        if (reaction.status === "pending") ids.add(reaction.characterId);
    }

    for (const exposure of state.pendingExposures ?? []) {
        ids.add(exposure.characterId);
    }

    for (const action of state.actions ?? []) {
        if (action.status === "pending") {
            ids.add(action.actorId);
            if (action.targetCharacterId !== "player") ids.add(action.targetCharacterId);
        }
    }

    return ids;
}

function getCurrentPersonaContext() {
    const context = getContext();
    const power = context.powerUserSettings ?? {};
    return {
        name: context.name1 || "玩家",
        description: String(power.persona_description ?? "").trim(),
    };
}

function retainMemories(items, limit) {
    return [...items].map((item,index)=>({item,index})).sort((a,b)=>memoryImportanceRank(b.item.importance)-memoryImportanceRank(a.item.importance) || b.index-a.index).slice(0,limit).sort((a,b)=>a.index-b.index).map(entry=>entry.item);
}

function memoryImportanceRank(value = "medium") {
    return { high: 3, medium: 2, low: 1 }[String(value)] ?? 2;
}

function normalizeMemoryText(value = "") {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getSelectedMemories(items = [], limit = 8) {
    return [...items]
        .filter(item => item && String(item.text ?? "").trim())
        .sort((a, b) => {
            const rank = memoryImportanceRank(b.importance) - memoryImportanceRank(a.importance);
            if (rank) return rank;
            return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
        })
        .slice(0, limit);
}

function addLongTermMemory(state, raw, eventRefMap, rejected) {
    const text = truncateText(String(raw?.text ?? "").trim(), 500);
    if (!text) return false;

    const scope = raw?.scope === "character" ? "character" : "world";
    const importance = ["high", "medium", "low"].includes(String(raw?.importance)) ? String(raw.importance) : "medium";
    const eventId = resolveEventRef(state, raw?.eventId, eventRefMap)
        ?? resolveEventRef(state, raw?.eventRef, eventRefMap)
        ?? null;

    if (scope === "character") {
        const characterId = String(raw?.characterId ?? "");
        const character = state.characters?.[characterId];
        if (!character || character.active === false) return false;
        if (!eventId || !characterKnowsEvent(state, characterId, eventId)) {
            rejected?.push(`memory:${characterId}:unknown-event`);
            return false;
        }

        state.memory = state.memory ?? { world: [], characters: {} };
        state.memory.characters = state.memory.characters ?? {};
        const list = state.memory.characters[characterId] = Array.isArray(state.memory.characters[characterId])
            ? state.memory.characters[characterId]
            : [];
        const normalized = normalizeMemoryText(text);
        const existing = list.find(item => normalizeMemoryText(item.text) === normalized);
        if (existing) {
            existing.importance = importance;
            existing.eventId = eventId;
            existing.updatedAt = state.world.datetime || new Date().toISOString();
        } else {
            list.push({
                id: createId("mem"),
                text,
                importance,
                eventId,
                createdAt: state.world.datetime || new Date().toISOString(),
                updatedAt: state.world.datetime || new Date().toISOString(),
            });
        }
        state.memory.characters[characterId] = retainMemories(list, 40);
        return true;
    }

    state.memory = state.memory ?? { world: [], characters: {} };
    state.memory.world = Array.isArray(state.memory.world) ? state.memory.world : [];
    const normalized = normalizeMemoryText(text);
    const existing = state.memory.world.find(item => normalizeMemoryText(item.text) === normalized);
    if (existing) {
        existing.importance = importance;
        existing.eventId = eventId;
        existing.updatedAt = state.world.datetime || new Date().toISOString();
    } else {
        state.memory.world.push({
            id: createId("mem"),
            text,
            importance,
            eventId,
            createdAt: state.world.datetime || new Date().toISOString(),
            updatedAt: state.world.datetime || new Date().toISOString(),
        });
    }
    state.memory.world = retainMemories(state.memory.world, 60);
    return true;
}

function buildAirpContextBlock(state) {
    const context = getContext();
    const settings = state.settings ?? {};
    const activeCharacters = getWorldCharacters(state);
    const presentIds = new Set(state.world.presentCharacterIds ?? []);
    const relevantIds = getRelevantCharacterIdsForPrompt(state);
    const recentEventLimit = Number(settings.recentEventLimit) || 6;
    const recentEvents = [...state.events].slice(-recentEventLimit);

    const lines = [];
    lines.push("[AIRP CURRENT WORLD]");
    lines.push(`player = ${context.name1 || "玩家"}`);

    const persona = getCurrentPersonaContext();
    if (persona.description) {
        lines.push("");
        lines.push("[AIRP PLAYER PERSONA]");
        lines.push(`name = ${persona.name}`);
        lines.push(truncateText(persona.description, Number(settings.maxPersonaChars) || 2400));
        lines.push("（Persona 描述玩家是谁；世界包不得覆盖或擅自补全玩家未写明的人设。）");
    }

    if (state.worldInfo?.localSupplement) lines.push(`CURRENT_SAVE_SUPPLEMENT = ${truncateText(state.worldInfo.localSupplement, 2200)}`);

    if (state.settings?.worldPackEnabled !== false && worldPackCache.status === "loaded") {
        const pack = worldPackCache;
        const config = pack.config ?? {};
        lines.push("");
        lines.push("[AIRP WORLD PACK]");
        lines.push(`pack = ${config.name || pack.folder}${config.version ? ` | version=${config.version}` : ""}`);
        if (pack.documents.world) {
            lines.push("### 世界设定.md");
            lines.push(balancedText(stripPromptComments(pack.documents.world), Number(settings.maxWorldDocChars) || 12000));
        }
        if (pack.documents.player) {
            lines.push("### 开局前提（开局前提.md / 兼容玩家设定.md）");
            lines.push(balancedText(stripPromptComments(pack.documents.player), Number(settings.maxPlayerDocChars) || 3200));
        }
        if (pack.documents.style) {
            lines.push("### 叙事风格.md");
            lines.push(balancedText(stripPromptComments(pack.documents.style), Number(settings.maxStyleDocChars) || 8000));
        }
    }

    lines.push(`datetime = ${state.world.datetime || "未设置"}`);
    lines.push(`location = ${state.world.location || "未设置"}`);
    lines.push(`scene = ${state.world.sceneSummary || "未设置"}`);
    lines.push(`present = ${(state.world.presentCharacterIds ?? []).join(", ") || "无"}`);
    lines.push("");

    lines.push("[AIRP CHARACTER INDEX]");
    for (const character of activeCharacters) {
        const flags = [];
        if (presentIds.has(character.id)) flags.push("在场");
        if (relevantIds.has(character.id) && !presentIds.has(character.id)) flags.push("当前相关");

        const relation = character.type === "main"
            ? RELATION_KEYS.map(key => `${key}:${clamp(character.relation?.[key] ?? 0)}`).join(" ")
            : `attitude:${clampSigned(character.attitude ?? 0)}`;

        const known = getRecentKnownEventIds(character, state, recentEventLimit);
        lines.push(`- ${character.id} | ${character.display.name} | ${character.type} | ${flags.join("/") || "场外"} | ${character.relationLabel || ""} | playerContact=${character.contactStatus} | needsCardInitialization=${character.type === "main" && !character.profileInitialized}`);
        lines.push(`  relation = ${relation}`);
        const statusBits = [
            character.status?.location ? `location:${character.status.location}` : "",
            character.status?.activity ? `activity:${character.status.activity}` : "",
            character.status?.mood ? `mood:${character.status.mood}` : "",
        ].filter(Boolean);
        if (statusBits.length) lines.push(`  currentStatus = ${statusBits.join(" | ")}`);
        lines.push(`  recentKnownEvents = ${known.join(", ") || "无"}`);
    }
    lines.push("");

    const detailedIds = new Set([
        ...state.world.presentCharacterIds,
        ...[...relevantIds].filter(id => state.characters[id]?.active !== false),
    ]);
    for (const character of activeCharacters.filter(item => item.type === "main" && !item.profileInitialized).slice(0, 3)) detailedIds.add(character.id);

    if (detailedIds.size) {
        lines.push("[AIRP RELEVANT CHARACTER CARDS]");
        for (const characterId of detailedIds) {
            const character = state.characters[characterId];
            if (!character) continue;
            const resolved = resolveCharacter(character);
            const card = character.source?.cardAvatar
                ? getCardByAvatar(character.source.cardAvatar)
                : null;
            const isPresent = presentIds.has(characterId);
            const currentCard = getCurrentCard();
            const alreadyInjectedBySt = Boolean(
                card?.avatar && currentCard?.avatar && card.avatar === currentCard.avatar,
            );
            const maxChars = isPresent
                ? Number(settings.maxPresentCardChars) || 4200
                : Number(settings.maxRelatedCardChars) || 1200;
            const cardText = alreadyInjectedBySt
                ? "（该角色是当前 SillyTavern 主卡；完整角色卡已由 ST 原生上下文提供，此处不重复注入。）"
                : buildCardCoreText(card, maxChars);
            const profileText = [
                resolved?.display?.identity,
                resolved?.display?.background,
                resolved?.display?.bio,
            ].filter(Boolean).join("；");

            lines.push(`### ${characterId} | ${resolved?.display?.name || characterId} | ${isPresent ? "在场" : "场外相关"}`);
            if (profileText) lines.push(`AIRP公开资料：${truncateText(profileText, 800)}`);
            const currentStatus = [
                resolved?.status?.location ? `所在地：${resolved.status.location}` : "",
                resolved?.status?.activity ? `正在做：${resolved.status.activity}` : "",
                resolved?.status?.mood ? `当前情绪：${resolved.status.mood}` : "",
                resolved?.status?.note ? `状态备注：${resolved.status.note}` : "",
            ].filter(Boolean).join("；");
            if (currentStatus) lines.push(`AIRP当前状态：${truncateText(currentStatus, 700)}`);
            if (resolved?.internal?.modelNotes) {
                lines.push(`MODEL_ONLY_CHARACTER_NOTES：${truncateText(resolved.internal.modelNotes, 1500)}`);
            }
            if (cardText) lines.push(cardText);
            lines.push(`profile=${JSON.stringify({ ...character.profile, avatar: undefined, cover: undefined })}; lockedFields=${Object.keys(character.profileMeta?.locked ?? {}).filter(key => character.profileMeta.locked[key]).join(",") || "无"}`);
            const known = Object.entries(character.knowledge ?? {}).slice(-12);
            if (known.length) {
                lines.push("CHARACTER_KNOWLEDGE（本人的理解，不能用世界真相替换）：");
                for (const [eventId, knowledge] of known) lines.push(`- ${eventId} | source=${knowledge.source} | certainty=${knowledge.certainty} | ${truncateText(knowledge.interpretation || getEventById(state, eventId)?.summary || "", 500)}`);
            }
        }
        lines.push("");
    }

    const worldMemories = getSelectedMemories(state.memory?.world ?? [], 8);
    const characterMemoryGroups = [];
    for (const characterId of detailedIds) {
        const selected = getSelectedMemories(state.memory?.characters?.[characterId] ?? [], 6);
        if (selected.length) characterMemoryGroups.push([characterId, selected]);
    }
    if (worldMemories.length || characterMemoryGroups.length) {
        lines.push("[AIRP LONG TERM MEMORY]");
        if (worldMemories.length) {
            lines.push("WORLD:");
            for (const item of worldMemories) lines.push(`- [${item.importance || "medium"}] ${truncateText(item.text, 420)}`);
        }
        for (const [characterId, items] of characterMemoryGroups) {
            lines.push(`${characterId}:`);
            for (const item of items) lines.push(`- [${item.importance || "medium"}] ${truncateText(item.text, 420)}`);
        }
        lines.push("");
    }

    if (recentEvents.length) {
        lines.push("[AIRP RECENT EVENTS]");
        for (const event of recentEvents) {
            const knownBy = getKnownCharacterIdsForEvent(state, event.id);
            lines.push(`- ${event.id} | ${event.time || "未标时间"} | ${event.channel}/${event.visibility}`);
            lines.push(`  ${truncateText(event.summary, 320)}`);
            lines.push(`  participants=${event.participants.join(",") || "无"}; witnesses=${event.witnesses.join(",") || "无"}; knownBy=${knownBy.join(",") || "无"}`);
        }
        lines.push("");
    }

    const recentMoments = [...(state.moments ?? [])].slice(-8);
    const recentForum = [...(state.forum ?? [])].slice(-5);
    const recentMessages = Object.values(state.messages ?? {}).flat().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-16);
    if (recentMoments.length || recentForum.length || recentMessages.length) {
        lines.push("[AIRP RECENT SOCIAL]");
        for (const moment of recentMoments) {
            lines.push(`- momentId=${moment.id} | eventId=${moment.eventId || "无"} | author=${moment.authorId} | friends-only | ${truncateText(moment.text, 600)} | likes=${(moment.likes ?? []).join(",") || "无"}`);
            for (const comment of (moment.comments ?? []).slice(-5)) lines.push(`  comment ${comment.authorId}: ${truncateText(comment.text, 400)}`);
        }
        for (const post of recentForum) {
            lines.push(`- forumPostId=${post.id} | eventId=${post.eventId || "无"} | ${post.anonymous ? `visibleAuthor=${post.anonymousLabel}; MODEL_ONLY_AUTHOR=${post.authorId}（角色不知道真实作者）` : `author=${post.authorId}`} | title=${truncateText(post.title, 160)} | body=${truncateText(post.text, 800)}`);
            for (const reply of (post.replies ?? []).slice(-6)) lines.push(`  reply ${reply.anonymous ? reply.anonymousLabel + "（匿名）" : reply.authorId}: ${truncateText(reply.text, 400)}`);
        }
        for (const message of recentMessages) {
            lines.push(`- privateMessageId=${message.id} | eventId=${message.eventId || "无"} | ${message.senderId}->${message.receiverId} | ${truncateText(message.text, 600)}`);
        }
        lines.push("");
    }

    const pendingMessages = getPendingPrivateMessages(state);
    if (pendingMessages.length) {
        lines.push(`[AIRP PENDING PRIVATE MESSAGES] total=${pendingMessages.length}`);
        for (const message of pendingMessages.slice(0, 20)) lines.push(`- messageId=${message.id} | eventId=${message.eventId} | to=${message.receiverId} | status=${message.processingStatus || "pending"} | ${truncateText(message.text, 1200)}`);
        lines.push("请逐条决定回复、继续等待或忽略；未处理消息会保留，延迟不是已经处理。\n");
    }
    lines.push(`[AIRP SOCIAL GENERATION] enabled=${state.settings.socialGenerationEnabled !== false}; maxNewItems=${state.settings.maxSocialPerTurn ?? 3}; lastGenerationTime=${state.runtime.lastSocialGenerationTime || "无"}`);

    const pendingExposures = [...(state.pendingExposures ?? [])]
        .sort((a, b) => String(a.lastCheckedAt || "").localeCompare(String(b.lastCheckedAt || ""))).slice(0, 20);
    if (pendingExposures.length) {
        lines.push(`[AIRP PENDING EXPOSURES] total=${state.pendingExposures.length}; 以下条目由模型判断，不要求玩家点确认`);
        for (const exposure of pendingExposures) {
            const event = getEventById(state, exposure.eventId);
            lines.push(`- exposureId=${exposure.id} | characterId=${exposure.characterId} | eventId=${exposure.eventId} | channel=${exposure.channel}`);
            if (event) lines.push(`  event=${truncateText(event.publicSummary || event.summary, 500)}`);
            if (exposure.deferReason) lines.push(`  previousDeferReason=${truncateText(exposure.deferReason, 300)}`);
        }
        lines.push("逐条输出 seen / missed / defer；defer 必须说明时机原因。seen 后同轮用 reactions 决定反应或明确无明显反应。不要把没有填写当作已经处理。\n");
    }

    const pendingReactions = (state.reactions ?? [])
        .filter(reaction => reaction.status === "pending")
        .sort((a, b) => String(a.lastCheckedAt || "").localeCompare(String(b.lastCheckedAt || "")))
        .slice(0, 20);
    if (pendingReactions.length) {
        lines.push("[AIRP PENDING REACTIONS]");
        for (const reaction of pendingReactions) {
            const event = getEventById(state, reaction.eventId);
            lines.push(`- reactionId=${reaction.id} | characterId=${reaction.characterId} | eventId=${reaction.eventId} | source=${reaction.source}`);
            if (event) lines.push(`  event=${truncateText(event.publicSummary || event.summary, 500)}`);
            if (reaction.deferReason) lines.push(`  previousDeferReason=${truncateText(reaction.deferReason, 300)}`);
        }
        lines.push("逐条决定内部反应、status=none（无明显反应）或 status=deferred（必须有 reason）；情绪已经确定但行动延迟时，先记录反应，再用 action.timing=later。\n");
    }

    const pendingActions = (state.actions ?? [])
        .filter(action => action.status === "pending")
        .slice(0, 10);
    if (pendingActions.length) {
        lines.push("[AIRP PENDING ACTIONS]");
        for (const action of pendingActions) {
            lines.push(`- actionId=${action.id} | actorId=${action.actorId} | type=${action.type} | timing=${action.timing} | target=${action.targetCharacterId}${action.targetArtifactId ? ` | targetArtifactId=${action.targetArtifactId}` : ""}`);
            if (action.note) lines.push(`  intent=${truncateText(action.note, 220)}`);
        }
        lines.push("");
    }

    const relationships = Object.values(state.characterRelations ?? {})
        .filter(rel => rel?.characterIds?.some(id => relevantIds.has(id) || presentIds.has(id)))
        .slice(0, 12);
    if (relationships.length) {
        lines.push("[AIRP CHARACTER RELATIONSHIPS]");
        for (const rel of relationships) {
            const [a, b] = rel.characterIds;
            lines.push(`- ${a} <-> ${b} | tags=${(rel.tags ?? []).join("/") || "无"} | ${truncateText(rel.summary, 220)}`);
            lines.push(`  ${a}->${b}: ${rel.perspectives?.[a]?.attitude ?? 0} | ${truncateText(rel.perspectives?.[a]?.impression ?? "", 140)}`);
            lines.push(`  ${b}->${a}: ${rel.perspectives?.[b]?.attitude ?? 0} | ${truncateText(rel.perspectives?.[b]?.impression ?? "", 140)}`);
        }
    }

    return lines.join("\n");
}

async function refreshAirpStatePrompt() {
    const context = getContext();
    const owner = captureOwner(context);
    context.setExtensionPrompt?.("airp_state_tracker_v13", "", 1, 0, false);
    const state = await ensureState();

    if (!state || !state.settings?.stateTrackerEnabled || !state.settings?.contextInjectionEnabled) {
        context.setExtensionPrompt?.(AIRP_PROMPT_ID, "", 1, 0, false);
        return "";
    }

    await loadWorldPack(state);
    const externalPrompts = await loadExternalPromptBundle(state);
    assertOwner(owner);
    state.runtime.promptLoadError = [worldPackCache.status === "error" ? `世界资料加载失败：${worldPackCache.error}` : "", externalPrompts.status === "error" ? `规则加载失败：${externalPrompts.error}` : ""].filter(Boolean).join("；");
    const contextBlock = buildAirpContextBlock(state);
    const prompt = buildAirpStateTrackerPrompt(
        contextBlock,
        externalPrompts.status === "loaded" ? externalPrompts.text : "",
    );

    // position=1: in-chat prompt; depth=0: 靠近当前上下文末端；role 默认 SYSTEM。
    context.setExtensionPrompt?.(AIRP_PROMPT_ID, prompt, 1, 0, false);
    context.setExtensionPrompt?.("airp_state_tracker_v13", "", 1, 0, false);
    return prompt;
}

function extractAirpStateBlock(text) {
    const source = String(text ?? "");
    const blocks = [];
    let match;

    AIRP_STATE_BLOCK_RE.lastIndex = 0;
    while ((match = AIRP_STATE_BLOCK_RE.exec(source)) !== null) {
        blocks.push(String(match[1] ?? "").trim());
    }
    AIRP_STATE_BLOCK_RE.lastIndex = 0;

    if (!blocks.length) {
        return { cleanText: source, rawState: null };
    }

    const cleanText = source.replace(AIRP_STATE_BLOCK_RE, "").trimEnd();
    AIRP_STATE_BLOCK_RE.lastIndex = 0;
    return { cleanText, rawState: blocks.at(-1) ?? null };
}

function parseAirpStateJson(rawState) {
    if (!rawState) return null;
    let raw = String(rawState).trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    try {
        return JSON.parse(raw);
    } catch (firstError) {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start >= 0 && end > start) {
            return JSON.parse(raw.slice(start, end + 1));
        }
        throw firstError;
    }
}

function resolveEventRef(state, value, eventRefMap = new Map()) {
    if (!value) return null;
    const ref = String(value);
    if (eventRefMap.has(ref)) return eventRefMap.get(ref);
    if (getEventById(state, ref)) return ref;
    return null;
}

function sanitizeEventCharacterIds(state, ids) {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids
        .map(id => String(id))
        .filter(id => id === "player" || Boolean(state.characters[id]))
    )];
}

function sanitizeRelationChanges(changes = {}, severity = "ordinary") {
    const limit = RELATION_SEVERITY_LIMITS[severity] ?? RELATION_SEVERITY_LIMITS.ordinary;
    const result = {};

    for (const key of RELATION_KEYS) {
        if (changes?.[key] === undefined) continue;
        const number = Number(changes[key]);
        if (!Number.isFinite(number) || number === 0) continue;
        const capped = Math.max(-limit, Math.min(limit, number));
        if (capped !== 0) result[key] = capped;
    }

    return result;
}

function characterKnowsEvent(state, characterId, eventId) {
    if (!characterId || !eventId) return false;
    return Boolean(state.characters[characterId]?.knowledge?.[eventId]);
}

function createPendingActionFromModel(state, item = {}) {
    const actorId = String(item.actorId ?? "");
    if (!state.characters[actorId]) return null;

    const type = ACTION_LABELS[item.type] && item.type !== "none"
        ? item.type
        : null;
    if (!type) return null;

    const target = item.targetCharacterId === "player" || state.characters[item.targetCharacterId]
        ? item.targetCharacterId
        : "player";

    const action = {
        id: createId("act"),
        reactionId: item.reactionId ?? null,
        eventId: item.eventId ?? null,
        actorId,
        targetCharacterId: target,
        type,
        timing: ACTION_TIMING_LABELS[item.timing] ? item.timing : "later",
        note: String(item.note ?? "").trim(),
        targetArtifactId: item.targetArtifactId ?? null,
        status: "pending",
        createdAt: new Date().toISOString(),
        completedAt: null,
        executedArtifactId: null,
        executedEventId: null,
    };

    state.actions.push(action);
    return action;
}

function applySocialDelta(state, delta, refs, rejected, artifactRefs = new Map(), onExecuted = () => {}) {
    const maximum = Math.min(5, Math.max(0, Number(state.settings.maxSocialPerTurn) || 3));
    const incoming = (delta.social ?? []).filter(item => state.settings.socialGenerationEnabled !== false || !["moments", "forum"].includes(item.type) || item.eventId || item.eventRef).slice(0, maximum);
    for (const item of incoming) {
        const actorId = item.authorId ?? item.actorId;
        if (!state.characters[actorId] || state.characters[actorId].active === false || !["private_chat", "moments", "forum", "moment_comment", "moment_like", "forum_reply"].includes(item.type)) { rejected.push("social:invalid-author-or-type"); continue; }
        const eventId = resolveEventRef(state, item.eventId ?? item.eventRef, refs);
        if ((item.eventId || item.eventRef) && !eventId) { rejected.push(`social:${actorId}:unknown-source-event`); continue; }
        if (eventId && !characterKnowsEvent(state, actorId, eventId)) { rejected.push(`social:${actorId}:unknown-event`); continue; }
        if (item.ref && refs.has(String(item.ref))) { rejected.push(`social:${actorId}:duplicate-ref`); continue; }
        const targetArtifactId = item.targetArtifactId || artifactRefs.get(String(item.targetArtifactRef ?? ""));
        const execution = item.execute ?? item;
        const socialKey = `${actorId}:${item.type}:${state.world.datetime}:${hashString(String(execution.text ?? "") + String(targetArtifactId ?? ""))}`;
        const existing = state.actions.find(action => action.socialKey === socialKey);
        if (existing) {
            if (existing.executedEventId) {
                registerExecutionRefs(item, {event: {id: existing.executedEventId}, artifact: {id: existing.executedArtifactId}}, refs, artifactRefs);
                onExecuted();
            }
            continue;
        }
        const action = createPendingActionFromModel(state, { ...item, targetArtifactId, note: item.note || execution.text || "", actorId, eventId, timing: item.timing ?? "now" });
        if (!action) continue;
        action.socialKey = socialKey;
        if (action.timing === "now") {
            const result = executeActionInState(state, action.id, { text: truncateText(execution.text ?? "", 1200), title: truncateText(execution.title ?? "", 160), anonymous: Boolean(execution.anonymous), time: state.world.datetime });
            registerExecutionRefs(item, result, refs, artifactRefs);
            onExecuted();
            if (action.status !== "done") rejected.push(`social:${action.id}:${action.lastError || "missing-content"}`);
        }
    }
    if (incoming.length) state.runtime.lastSocialGenerationTime = state.world.datetime;
    for (const item of (delta.privateMessageUpdates ?? []).slice(0, 20)) {
        const message = Object.values(state.messages).flat().find(entry => entry.id === item.messageId && entry.senderId === "player");
        if (!message || !["handled", "deferred", "ignored"].includes(item.status) || !String(item.reason ?? "").trim()) continue;
        message.processingStatus = item.status;
        message.processingReason = truncateText(item.reason, 400);
    }
}

function updateWorldTimeByMinutes(state, minutes) {
    const delta = Number(minutes);
    if (!Number.isFinite(delta) || delta === 0) return false;

    const source = String(state.world.datetime ?? "").trim();
    const full = source.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
    if (full) {
        const [, y, m, d, hh, mm] = full;
        const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
        date.setMinutes(date.getMinutes() + delta);
        const pad = value => String(value).padStart(2, "0");
        state.world.datetime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        return true;
    }

    const timeOnly = source.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnly) {
        let total = Number(timeOnly[1]) * 60 + Number(timeOnly[2]) + delta;
        total = ((total % 1440) + 1440) % 1440;
        state.world.datetime = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
        return true;
    }

    return false;
}


function deepCloneAirp(value) {
    if (value === undefined) return undefined;
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function createDynamicStateSnapshot(state) {
    const characters = {};
    for (const [id, character] of Object.entries(state.characters ?? {})) {
        characters[id] = deepCloneAirp({ ...character, profile: { ...character.profile, avatar: undefined, cover: undefined } });
    }

    return {
        world: deepCloneAirp(state.world ?? {}),
        manualWorldVersion: state.safety?.manualWorldVersion ?? null,
        characters,
        characterRelations: deepCloneAirp(state.characterRelations ?? {}),
        events: deepCloneAirp(state.events ?? []),
        memory: deepCloneAirp(state.memory ?? { world: [], characters: {} }),
        pendingExposures: deepCloneAirp(state.pendingExposures ?? []),
        exposureHistory: deepCloneAirp(state.exposureHistory ?? []),
        reactions: deepCloneAirp(state.reactions ?? []),
        actions: deepCloneAirp(state.actions ?? []),
        moments: deepCloneAirp(state.moments ?? []),
        forum: deepCloneAirp(state.forum ?? []),
        messages: deepCloneAirp(state.messages ?? {}),
        notifications: deepCloneAirp(state.notifications ?? []),
    };
}

function restoreDynamicStateSnapshot(state, snapshot) {
    if (!state || !snapshot) return false;
    const manual = capturePlayerProgress(state);
    if (snapshot.characters) {
        const current = state.characters;
        state.characters = deepCloneAirp(snapshot.characters);
        for (const [id, character] of Object.entries(current)) {
            if (!state.characters[id] && character.source?.type !== "model-npc") state.characters[id] = deepCloneAirp(character);
            const restored = state.characters[id];
            if (!restored) continue;
            for (const key of ["avatar", "cover"]) restored.profile[key] = character.profile[key] ?? "";
            for (const [key, locked] of Object.entries(character.profileMeta?.locked ?? {})) if (locked) {
                restored.profile[key] = character.profile[key];
                restored.profileMeta ??= { locked: {}, sources: {} };
                restored.profileMeta.locked[key] = true;
            }
            if (character.activeManualVersion && character.activeManualVersion !== restored.activeManualVersion) { restored.active = character.activeManualValue; restored.activeManualVersion = character.activeManualVersion; restored.activeManualValue = character.activeManualValue; }
            if (character.contactManualVersion && character.contactManualVersion !== restored.contactManualVersion) {
                restored.contactStatus = character.contactManualStatus;
                restored.contactManualStatus = character.contactManualStatus;
                restored.contactManualVersion = character.contactManualVersion;
            }
        }
    }

    state.world = deepCloneAirp(snapshot.world ?? state.world ?? {});
    state.characterRelations = deepCloneAirp(snapshot.characterRelations ?? {});
    state.events = deepCloneAirp(snapshot.events ?? []);
    state.memory = deepCloneAirp(snapshot.memory ?? state.memory ?? { world: [], characters: {} });
    state.pendingExposures = deepCloneAirp(snapshot.pendingExposures ?? []);
    state.exposureHistory = deepCloneAirp(snapshot.exposureHistory ?? []);
    state.reactions = deepCloneAirp(snapshot.reactions ?? []);
    state.actions = deepCloneAirp(snapshot.actions ?? []);
    state.moments = deepCloneAirp(snapshot.moments ?? []);
    state.forum = deepCloneAirp(snapshot.forum ?? []);
    state.messages = deepCloneAirp(snapshot.messages ?? {});
    state.notifications = deepCloneAirp(snapshot.notifications ?? []);

    for (const [id, runtime] of Object.entries(snapshot.characterRuntime ?? {})) {
        const character = state.characters?.[id];
        if (!character) continue;
        character.status = deepCloneAirp(runtime.status ?? character.status ?? {});
        character.knowledge = deepCloneAirp(runtime.knowledge ?? {});
        if (character.type === "main") {
            character.relation = deepCloneAirp(runtime.relation ?? character.relation ?? createDefaultRelation());
            character.relationLabel = runtime.relationLabel ?? character.relationLabel ?? "尚未建立关系";
        } else {
            if (runtime.attitude !== null && runtime.attitude !== undefined) character.attitude = runtime.attitude;
            if (runtime.impression !== null && runtime.impression !== undefined) character.impression = runtime.impression;
        }
    }

    restorePlayerProgress(state, manual);
    state.world.presentCharacterIds = state.world.presentCharacterIds.filter(id => state.characters[id]?.active !== false);
    state.pendingExposures = state.pendingExposures.filter(item => state.characters[item.characterId]?.active !== false);
    for (const reaction of state.reactions) if (state.characters[reaction.characterId]?.active === false && reaction.status === "pending") reaction.status = "ignored";
    for (const action of state.actions) if (state.characters[action.actorId]?.active === false && action.status === "pending") action.status = "cancelled";
    if (state.safety?.manualWorld && state.safety.manualWorldVersion !== snapshot.manualWorldVersion) Object.assign(state.world, state.safety.manualWorld);
    return true;
}

function capturePlayerProgress(state) {
    return deepCloneAirp({
        characters: state.characters,
        events: state.events.filter(event => event.tags?.some(tag => String(tag).includes("玩家"))),
        moments: state.moments.filter(item => item.authorId === "player").map(item => ({ ...item, comments: item.comments.filter(comment => comment.authorId === "player"), likes: item.likes.filter(id => id === "player") })),
        forum: state.forum.filter(item => item.authorId === "player").map(item => ({ ...item, replies: item.replies.filter(reply => reply.authorId === "player") })),
        comments: state.moments.flatMap(item => item.comments.filter(comment => comment.authorId === "player").map(comment => ({ momentId: item.id, ...comment }))),
        replies: state.forum.flatMap(item => item.replies.filter(reply => reply.authorId === "player").map(reply => ({ postId: item.id, ...reply }))),
        likes: state.moments.filter(item => item.likes.includes("player")).map(item => item.id),
        messages: Object.values(state.messages).flat().filter(item => item.senderId === "player"),
    });
}

function restorePlayerProgress(state, manual) {
    const merge = (list, items) => { for (const item of items) if (!list.some(existing => existing.id === item.id)) list.push(item); };
    for (const message of manual.messages) {
        const id = message.receiverId;
        if (!state.characters[id] && manual.characters[id]) state.characters[id] = manual.characters[id];
        state.messages[id] ??= [];
        merge(state.messages[id], [{ ...message, processingStatus: "pending", handledByMessageId: null }]);
    }
    for (const event of manual.events) for (const id of [...event.participants, ...event.witnesses, ...event.audienceCharacterIds]) if (id !== "player" && !state.characters[id] && manual.characters[id]) state.characters[id] = manual.characters[id];
    merge(state.events, manual.events);
    merge(state.moments, manual.moments);
    merge(state.forum, manual.forum);
    for (const item of manual.comments) { const moment = state.moments.find(entry => entry.id === item.momentId); if (moment) merge(moment.comments, [item]); }
    for (const item of manual.replies) { const post = state.forum.find(entry => entry.id === item.postId); if (post) merge(post.replies, [item]); }
    for (const moment of state.moments) {
        moment.likes = moment.likes.filter(id => id !== "player");
        if (manual.likes.includes(moment.id)) moment.likes.push("player");
    }
    for (const event of manual.events) {
        seedEventKnowledge(state, event);
        createPropagationCandidates(state, event);
        if (event.channel === "private_chat" && event.tags.includes("玩家发送")) for (const id of event.audienceCharacterIds) createReactionCandidate(state, id, event.id, { source: "private_chat" });
    }
    const validEvents = new Set(state.events.map(event => event.id));
    for (const character of Object.values(state.characters)) for (const id of Object.keys(character.knowledge ?? {})) if (!validEvents.has(id)) delete character.knowledge[id];
    const messageIds = new Set(Object.values(state.messages).flat().map(item => item.id));
    for (const message of Object.values(state.messages).flat()) if (message.handledByMessageId && !messageIds.has(message.handledByMessageId)) { message.processingStatus = "pending"; message.handledByMessageId = null; }
}


/* =========================================================
   V13 · ST 消息历史 ↔ AIRP 状态同步
   - 删除 / Regenerate：回到仍然存在的上一条 AIRP 检查点
   - Swipe：切换到对应 swipe 的检查点；生成新 swipe 前先回到该消息之前
   - 编辑：撤销该位置之后的 AIRP 自动状态，避免“正文改了但后台还活在旧分支”

   说明：检查点保存变化量，共用基线；不再淘汰较早的可见消息状态。
   ========================================================= */

function ensureHistorySafety(state) {
    state.safety = state.safety ?? {};
    if (!Array.isArray(state.safety.historyCheckpoints)) state.safety.historyCheckpoints = [];
    if (state.safety.historyBaseSnapshot === undefined) state.safety.historyBaseSnapshot = null;
    if (state.safety.activeCheckpointId === undefined) state.safety.activeCheckpointId = null;
    if (!state.safety.historyCheckpoints.some(item => item.before && item.after)) return state.safety;
    let previousId = null;
    let previousAfter = state.safety.historyBaseSnapshot;
    for (const item of state.safety.historyCheckpoints) {
        if (item.before && item.after) {
            if (!state.safety.historyBaseSnapshot) state.safety.historyBaseSnapshot = deepCloneAirp(item.before);
            item.parentId = previousId;
            item.bridge = diffState(previousAfter ?? state.safety.historyBaseSnapshot, item.before);
            item.patch = diffState(item.before, item.after);
            previousAfter = item.after;
            delete item.before;
            delete item.after;
        } else previousAfter = checkpointSnapshot(state.safety, item.id);
        previousId = item.id;
    }
    return state.safety;
}

function getCheckpointById(state, checkpointId) {
    if (!checkpointId) return null;
    const item = (state?.safety?.historyCheckpoints ?? []).find(item => item?.id === checkpointId);
    return item ? { ...item, before: checkpointSnapshot(state.safety, item.id, "before"), after: checkpointSnapshot(state.safety, item.id) } : null;
}

function getCurrentMessageCheckpointId(message) {
    const airp = message?.extra?.airp;
    if (!airp || airp.invalidated === true || airp.applied === false) return null;
    return airp.transactionId ?? null;
}

function getAnyMessageCheckpointId(message) {
    return message?.extra?.airp?.transactionId ?? null;
}

function captureChatStructure() {
    const chat = getContext().chat ?? [];
    return chat.map((message, index) => {
        const tx = getAnyMessageCheckpointId(message);
        if (tx) return `tx:${tx}`;
        const stamp = String(message?.send_date ?? "");
        const role = message?.is_user ? "u" : (message?.is_system ? "s" : "a");
        const name = String(message?.name ?? "");
        // send_date 通常足以稳定标识；index 仅做极端旧消息的兜底。
        return `${role}:${stamp}:${name}:${index}`;
    });
}

function rememberChatStructure() {
    lastChatStructure = captureChatStructure();
}

function findCommonPrefixLength(a = [], b = []) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i += 1;
    return i;
}

function findLatestVisibleCheckpoint(state, beforeIndex = Infinity) {
    const chat = getContext().chat ?? [];
    const end = Math.min(chat.length - 1, Number.isFinite(beforeIndex) ? beforeIndex - 1 : chat.length - 1);
    for (let i = end; i >= 0; i--) {
        const checkpointId = getCurrentMessageCheckpointId(chat[i]);
        const checkpoint = getCheckpointById(state, checkpointId);
        if (checkpoint) return { checkpoint, messageId: i };
    }
    return null;
}

function findCheckpointFromMessageSwipes(state, message) {
    const candidates = [];
    const currentId = getAnyMessageCheckpointId(message);
    if (currentId) candidates.push(currentId);
    for (const info of message?.swipe_info ?? []) {
        const id = info?.extra?.airp?.transactionId;
        if (id) candidates.push(id);
    }
    for (const id of candidates) {
        const checkpoint = getCheckpointById(state, id);
        if (checkpoint) return checkpoint;
    }
    return null;
}

function addHistoryCheckpoint(state, { messageId, swipeId, generationType, before, after }) {
    const safety = ensureHistorySafety(state);
    if (!safety.historyBaseSnapshot) safety.historyBaseSnapshot = deepCloneAirp(before);

    const checkpoint = {
        id: createId("tx"),
        messageId: Number.isInteger(Number(messageId)) ? Number(messageId) : null,
        swipeId: Number.isInteger(Number(swipeId)) ? Number(swipeId) : null,
        generationType: String(generationType ?? "normal"),
        createdAt: new Date().toISOString(),
        parentId: safety.activeCheckpointId ?? null,
        bridge: diffState(checkpointSnapshot(safety, safety.activeCheckpointId) ?? safety.historyBaseSnapshot, before),
        patch: diffState(before, after),
    };

    safety.historyCheckpoints.push(checkpoint);
    safety.activeCheckpointId = checkpoint.id;
    safety.lastHistorySyncAt = new Date().toISOString();
    safety.lastHistorySyncReason = "model_state_applied";
    return checkpoint;
}

function markAirpMessagesInvalidFrom(startIndex, reason = "history_changed") {
    const context = getContext();
    const chat = context.chat ?? [];
    let changed = false;
    for (let i = Math.max(0, Number(startIndex) || 0); i < chat.length; i++) {
        const message = chat[i];
        if (!message?.extra?.airp?.transactionId) continue;
        message.extra.airp.applied = false;
        message.extra.airp.invalidated = true;
        message.extra.airp.invalidatedAt = new Date().toISOString();
        message.extra.airp.invalidReason = reason;
        syncCleanMessageToSwipe(message);
        changed = true;
    }
    return changed;
}

async function saveHistorySyncState(state, reason = "history_sync", { saveChat = false } = {}) {
    const safety = ensureHistorySafety(state);
    safety.lastHistorySyncAt = new Date().toISOString();
    safety.lastHistorySyncReason = reason;
    const owner = stateOwners.get(state) ?? captureOwner();
    if (safety.lastAutoUpdate?.transactionId !== safety.activeCheckpointId) safety.lastAutoUpdate = null;
    state.runtime.lastTrackerStatus = "history_synced";
    state.runtime.lastTrackerError = "";
    state.runtime.lastProcessedAt = new Date().toISOString();
    await saveState(state);
    if (saveChat) {
        try { assertOwner(owner); checkedSaveResult(await owner.context.saveChat?.()); assertOwner(owner); } catch (error) {
            state.runtime.chatSaveError = String(error?.message ?? error);
            await writeRecovery(owner, state, true);
            console.warn(`[${MODULE_NAME}] failed to save chat after history sync`, error);
        }
    }
    await refreshAirpStatePrompt();
    const overlay = document.getElementById("airp-phone-overlay");
    if (overlay && !overlay.classList.contains("airp-hidden")) await renderCurrentView({ background: true });
}

async function restoreToLatestVisibleCheckpoint(reason = "history_sync", beforeIndex = Infinity) {
    const state = await ensureState();
    if (!state) return false;
    const safety = ensureHistorySafety(state);
    const found = findLatestVisibleCheckpoint(state, beforeIndex);
    if (!found && (getContext().chat ?? []).slice(0, Number.isFinite(beforeIndex) ? beforeIndex : undefined).some(message => getCurrentMessageCheckpointId(message) && !(safety.detachedMessageIds ?? []).includes(getCurrentMessageCheckpointId(message)))) {
        state.runtime.lastTrackerStatus = "history_unavailable";
        state.runtime.lastTrackerError = "这段旧存档的检查点已被旧版本淘汰，无法准确回退；没有用较新的状态冒充旧进度。";
        await saveState(state);
        return false;
    }

    if (found?.checkpoint?.after) {
        restoreDynamicStateSnapshot(state, found.checkpoint.after);
        safety.activeCheckpointId = found.checkpoint.id;
    } else if (safety.historyBaseSnapshot) {
        restoreDynamicStateSnapshot(state, safety.historyBaseSnapshot);
        safety.activeCheckpointId = null;
    } else if (safety.lastAutoUpdate?.before) {
        // 兼容从 V11/V12 升级后尚未建立历史检查点的最近一次回退。
        restoreDynamicStateSnapshot(state, safety.lastAutoUpdate.before);
        safety.activeCheckpointId = null;
    } else {
        return false;
    }

    await saveHistorySyncState(state, reason);
    return true;
}

async function rollbackFromMessageIndex(startIndex, reason = "message_edited") {
    const state = await ensureState();
    if (!state) return false;
    const safety = ensureHistorySafety(state);
    const previous = findLatestVisibleCheckpoint(state, Math.max(0, Number(startIndex) || 0));
    if (!previous && (getContext().chat ?? []).slice(0, Math.max(0, Number(startIndex) || 0)).some(message => getCurrentMessageCheckpointId(message) && !(safety.detachedMessageIds ?? []).includes(getCurrentMessageCheckpointId(message)))) {
        state.runtime.lastTrackerStatus = "history_unavailable";
        state.runtime.lastTrackerError = "旧版本已淘汰这段历史的检查点，无法准确回退";
        await saveState(state);
        return false;
    }

    if (previous?.checkpoint?.after) {
        restoreDynamicStateSnapshot(state, previous.checkpoint.after);
        safety.activeCheckpointId = previous.checkpoint.id;
    } else if (safety.historyBaseSnapshot) {
        restoreDynamicStateSnapshot(state, safety.historyBaseSnapshot);
        safety.activeCheckpointId = null;
    } else {
        return false;
    }

    const changedChat = markAirpMessagesInvalidFrom(startIndex, reason);
    await saveHistorySyncState(state, reason, { saveChat: changedChat });
    return true;
}

async function discardStalePendingCommit(changedMessageId = null) {
    const owner = captureOwner();
    const draft = pendingCommits.get(owner.metadata);
    const checkpoint = draft?.safety?.historyCheckpoints?.find(item => item.id === draft.safety.lastAutoUpdate?.transactionId);
    if (!checkpoint?.messageKey) return;
    const stillPresent = (owner.context.chat ?? []).some((message,index) => { const raw=extractAirpStateBlock(message.mes).rawState ?? message.extra?.airp?.rawState; return raw && `${message.send_date ?? index}:${message.swipe_id ?? 0}:${hashString(raw)}` === checkpoint.messageKey && !message.extra?.airp?.invalidated; });
    if (stillPresent && checkpoint.messageId !== changedMessageId) return;
    pendingCommits.delete(owner.metadata);
    const current = await ensureState();
    current.runtime.saveError = "";
    await saveState(current);
}

async function handleAirpMessageDeleted(newLength) {
    await discardStalePendingCommit();
    const current = captureChatStructure();
    const previous = lastChatStructure;
    const commonPrefix = previous.length ? findCommonPrefixLength(previous, current) : current.length;
    const isMiddleMutation = previous.length && commonPrefix < current.length;

    if (isMiddleMutation) {
        await rollbackFromMessageIndex(commonPrefix, "message_deleted_mid_history");
    } else {
        const state = await ensureState();
        const activeId = state?.safety?.activeCheckpointId;
        const activeStillVisible = Boolean(activeId && (getContext().chat ?? []).some(message => getCurrentMessageCheckpointId(message) === activeId));
        if (!activeStillVisible) {
            await restoreToLatestVisibleCheckpoint("message_deleted_tail");
        }
    }

    rememberChatStructure();
}

async function handleAirpMessageSwiped(messageId) {
    await discardStalePendingCommit();
    const context = getContext();
    const index = Number(messageId);
    const message = Number.isInteger(index) ? context.chat?.[index] : null;
    const state = await ensureState();
    if (!message || !state) {
        rememberChatStructure();
        return;
    }

    const selectedId = getCurrentMessageCheckpointId(message);
    const selected = getCheckpointById(state, selectedId);
    const safety = ensureHistorySafety(state);

    if (selected?.after) {
        restoreDynamicStateSnapshot(state, selected.after);
        safety.activeCheckpointId = selected.id;
        // 如果用户改的是较早的分支，后面的自动状态不能继续当作有效事实。
        const changedChat = index < (context.chat?.length ?? 0) - 1
            ? markAirpMessagesInvalidFrom(index + 1, "earlier_swipe_changed")
            : false;
        await saveHistorySyncState(state, "swipe_existing", { saveChat: changedChat });
    } else {
        // 新 swipe 的占位消息没有 AIRP transaction。生成开始前回到该 AI 消息之前的世界状态。
        const branchCheckpoint = findCheckpointFromMessageSwipes(state, message);
        if (branchCheckpoint?.before) {
            restoreDynamicStateSnapshot(state, branchCheckpoint.before);
        } else {
            const previous = findLatestVisibleCheckpoint(state, index);
            if (previous?.checkpoint?.after) restoreDynamicStateSnapshot(state, previous.checkpoint.after);
            else if (safety.historyBaseSnapshot) restoreDynamicStateSnapshot(state, safety.historyBaseSnapshot);
        }
        const previous = findLatestVisibleCheckpoint(state, index);
        safety.activeCheckpointId = previous?.checkpoint?.id ?? null;
        const changedChat = index < (context.chat?.length ?? 0) - 1
            ? markAirpMessagesInvalidFrom(index + 1, "new_swipe_branch")
            : false;
        await saveHistorySyncState(state, "swipe_new_branch", { saveChat: changedChat });
    }

    rememberChatStructure();
}

async function handleAirpMessageEdited(messageId) {
    await discardStalePendingCommit(Number(messageId));
    const index = Number(messageId);
    if (!Number.isInteger(index)) return;
    const context = getContext();
    const message = context.chat?.[index];
    const hasStateAtOrAfter = (context.chat ?? []).slice(index).some(item => Boolean(item?.extra?.airp?.transactionId));
    if (!hasStateAtOrAfter) {
        if (!message?.is_user && extractAirpStateBlock(message?.mes).rawState) await processAssistantStateBlock(index,"edited");
        rememberChatStructure();
        return;
    }
    await rollbackFromMessageIndex(index, message?.is_user ? "user_message_edited" : "assistant_message_edited");
    if (!message?.is_user && extractAirpStateBlock(message?.mes).rawState) await processAssistantStateBlock(index,"edited");
    rememberChatStructure();
}

async function cleanupDeletedSwipeCheckpoint(payload = {}) {
    // 删除非当前 swipe 不改变世界状态；这里只更新结构缓存。
    // 保留检查点以支持分支回溯，不误删仍可回切的分支。
    rememberChatStructure();
}

function prepareAutoUndoPoint(state, delta, options = {}) {
    state.safety = state.safety ?? {};
    state.safety.lastAutoUpdate = {
        id: createId("undo"),
        messageId: options.messageId ?? null,
        generationType: options.generationType ?? "normal",
        createdAt: new Date().toISOString(),
        undoneAt: null,
        redoneAt: null,
        isUndone: false,
        delta: deepCloneAirp(delta ?? {}),
        before: createDynamicStateSnapshot(state),
    };
}

function findChatMessageById(messageId) {
    const id = Number(messageId);
    return Number.isInteger(id) ? getContext().chat?.[id] ?? null : null;
}

async function syncSafetyMessageFlag(record, applied, extra = {}, state = getContext().chatMetadata?.[AIRP_KEY]) {
    if (!record || !state) return;
    const owner = stateOwners.get(state) ?? captureOwner();
    assertOwner(owner);
    const context = owner.context;
    const message = context.chat?.[Number(record.messageId)];
    if (!message?.extra?.airp) return;
    message.extra.airp.applied = Boolean(applied);
    Object.assign(message.extra.airp, extra);
    syncCleanMessageToSwipe(message);
    try {
        checkedSaveResult(await context.saveChat?.());
        assertOwner(owner);
    } catch (error) {
        state.runtime.chatSaveError = String(error?.message ?? error);
        await writeRecovery(owner, state, true);
        console.warn(`[${MODULE_NAME}] failed to save safety marker`, error);
    }
}

async function undoLastAutoUpdate() {
    const state = await ensureState();
    const record = state?.safety?.lastAutoUpdate;
    const checkpoint = getCheckpointById(state, record?.transactionId);
    const before = checkpoint?.before ?? record?.before;
    if (!state || !before || record.isUndone) return false;

    restoreDynamicStateSnapshot(state, before);
    state.safety.activeCheckpointId = checkpoint?.parentId ?? null;
    record.isUndone = true;
    record.undoneAt = new Date().toISOString();
    record.redoneAt = null;
    state.runtime.lastTrackerStatus = "rolled_back";
    state.runtime.lastTrackerError = "";
    state.runtime.lastProcessedAt = new Date().toISOString();
    await saveState(state);
    await syncSafetyMessageFlag(record, false, { rolledBackAt: record.undoneAt }, state);
    await refreshAirpStatePrompt();
    await renderCurrentView();
    return true;
}

async function redoLastAutoUpdate() {
    const state = await ensureState();
    const record = state?.safety?.lastAutoUpdate;
    const checkpoint = getCheckpointById(state, record?.transactionId);
    if (!state || !checkpoint?.after || !record.isUndone) return false;

    // Restore the same IDs and artifacts; replaying delta would create new IDs.
    restoreDynamicStateSnapshot(state, checkpoint.after);
    state.safety.activeCheckpointId = checkpoint.id;

    const fresh = await ensureState();
    const freshRecord = fresh?.safety?.lastAutoUpdate;
    if (freshRecord) {
        freshRecord.isUndone = false;
        freshRecord.redoneAt = new Date().toISOString();
        freshRecord.undoneAt = null;
        await saveState(state);
        await syncSafetyMessageFlag(freshRecord, true, { redoneAt: freshRecord.redoneAt, rolledBackAt: null }, fresh);
    }
    await refreshAirpStatePrompt();
    await renderCurrentView();
    return true;
}

function sanitizeStateForExport(state) {
    const copy = deepCloneAirp(state);
    if (copy?.safety) copy.safety.lastAutoUpdate = null;
    return copy;
}

function safeFilePart(value = "AIRP世界") {
    return String(value || "AIRP世界")
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, "-")
        .slice(0, 60) || "AIRP世界";
}

function downloadAirpState(state, label = "AIRP世界") {
    const payload = { format: "AIRP_WORLD_EXPORT", version: STATE_VERSION, exportedAt: new Date().toISOString(), state: sanitizeStateForExport(state) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilePart(label)}-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

async function exportCurrentAirpWorld() {
    const state = await ensureState();
    if (!state) return false;
    const payload = {
        format: "AIRP_WORLD_EXPORT",
        version: STATE_VERSION,
        exportedAt: new Date().toISOString(),
        state: sanitizeStateForExport(state),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const worldName = worldPackCache.config?.name || state.worldInfo?.packFolder || "AIRP世界";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    anchor.href = url;
    anchor.download = `${safeFilePart(worldName)}-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    state.safety.lastExportAt = new Date().toISOString();
    if (!state.runtime.recoveryConflict && !pendingCommits.has(getContext().chatMetadata)) await saveState(state);
    await renderCurrentView();
    return true;
}

function validateImportedAirpPayload(payload) {
    const candidate = payload?.format === "AIRP_WORLD_EXPORT" ? payload.state : payload;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("文件里没有可识别的 AIRP 世界数据。 ");
    }
    assertSafeObject(candidate);
    if (!candidate.world || typeof candidate.world !== "object" || Array.isArray(candidate.world) || !candidate.characters || typeof candidate.characters !== "object" || Array.isArray(candidate.characters)) {
        throw new Error("这不是完整的 AIRP 世界存档。 ");
    }
    return candidate;
}

async function importAirpWorldFromFile(file) {
    if (!file) return false;
    const owner = captureOwner();
    const original = await ensureState();
    const text = await file.text();
    assertOwner(owner);
    const parsed = JSON.parse(text);
    const imported = validateImportedAirpPayload(parsed);
    const context = getContext();
    const metadata = context.chatMetadata;
    if (!metadata) throw new Error("当前聊天没有可写入的 metadata。 ");

    const cloned = deepCloneAirp(imported);
    cloned.runtime ??= {};
    cloned.safety = cloned.safety && typeof cloned.safety === "object" ? cloned.safety : {};
    cloned.safety.lastAutoUpdate = null;
    cloned.safety.lastImportAt = new Date().toISOString();
    // Imported message indexes belong to the exported chat, not this chat.
    cloned.safety.historyCheckpoints = [];
    cloned.safety.historyBaseSnapshot = null;
    cloned.safety.activeCheckpointId = null;
    cloned.runtime.recoveryConflict = false;
    cloned.runtime.revision = original.runtime.revision ?? 0;
    normalizeState(cloned);
    cloned.safety.historyBaseSnapshot = createDynamicStateSnapshot(cloned);
    cloned.safety.detachedMessageIds = (context.chat ?? []).map(getAnyMessageCheckpointId).filter(Boolean);
    cloned.safety.ignoredStateBlocks = (context.chat ?? []).map((message,index) => { const raw=extractAirpStateBlock(message.mes).rawState; return raw ? `${message.send_date ?? index}:${message.swipe_id ?? 0}:${hashString(raw)}` : null; }).filter(Boolean);
    await commitAirpDraft(original, cloned, owner);
    if (markAirpMessagesInvalidFrom(0,"world_imported")) { try { checkedSaveResult(await context.saveChat?.()); } catch (error) { cloned.runtime.chatSaveError = String(error.message); await writeRecovery(owner, cloned, true); } }
    await loadWorldPack(metadata[AIRP_KEY], true);
    await loadExternalPromptBundle(metadata[AIRP_KEY], true);
    await refreshAirpStatePrompt();
    navigationStack = [];
    currentView = createHomeView();
    await renderCurrentView();
    return true;
}

async function chooseAndImportAirpWorld() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    document.body.appendChild(input);

    return new Promise(resolve => {
        input.addEventListener("change", async () => {
            try {
                const file = input.files?.[0];
                if (!file) return resolve(false);
                await importAirpWorldFromFile(file);
                resolve(true);
            } catch (error) {
                console.error(`[${MODULE_NAME}] import failed`, error);
                window.alert(`AIRP 导入失败：${String(error?.message ?? error)}`);
                resolve(false);
            } finally {
                input.remove();
            }
        }, { once: true });
        input.click();
    });
}

function runStateIntegrityCheck(state) {
    const issues = [];
    const eventIds = new Set();
    const characterIds = new Set(Object.keys(state.characters ?? {}));

    for (const event of state.events ?? []) {
        if (!event?.id) issues.push("存在没有 ID 的事件");
        else if (eventIds.has(event.id)) issues.push(`重复事件 ID：${event.id}`);
        else eventIds.add(event.id);
        for (const id of [...(event.participants ?? []), ...(event.witnesses ?? []), ...(event.audienceCharacterIds ?? [])]) {
            if (id !== "player" && !characterIds.has(String(id))) issues.push(`事件 ${event.id ?? "?"} 引用了不存在的角色 ${id}`);
        }
    }

    for (const id of state.world?.presentCharacterIds ?? []) {
        if (!characterIds.has(String(id))) issues.push(`在场人物 ${id} 已不存在`);
    }

    for (const [characterId, character] of Object.entries(state.characters ?? {})) {
        for (const eventId of Object.keys(character.knowledge ?? {})) {
            if (!eventIds.has(eventId)) issues.push(`${character.profile?.name || characterId} 知情列表引用了不存在的事件 ${eventId}`);
        }
    }

    for (const exposure of state.pendingExposures ?? []) {
        if (!eventIds.has(exposure.eventId)) issues.push(`传播候选 ${exposure.id ?? "?"} 的事件不存在`);
        if (!characterIds.has(String(exposure.characterId))) issues.push(`传播候选 ${exposure.id ?? "?"} 的角色不存在`);
    }

    for (const reaction of state.reactions ?? []) {
        if (!eventIds.has(reaction.eventId)) issues.push(`反应 ${reaction.id ?? "?"} 的事件不存在`);
        if (!characterIds.has(String(reaction.characterId))) issues.push(`反应 ${reaction.id ?? "?"} 的角色不存在`);
    }

    for (const action of state.actions ?? []) {
        if (!characterIds.has(String(action.actorId))) issues.push(`行动 ${action.id ?? "?"} 的执行者不存在`);
    }
    for (const item of state.memory?.world ?? []) {
        if (item.eventId && !eventIds.has(item.eventId)) issues.push(`世界长期记忆 ${item.id ?? "?"} 引用了不存在的事件 ${item.eventId}`);
    }
    for (const [characterId, items] of Object.entries(state.memory?.characters ?? {})) {
        if (!characterIds.has(String(characterId))) issues.push(`长期记忆引用了不存在的角色 ${characterId}`);
        for (const item of items ?? []) if (item.eventId && !eventIds.has(item.eventId)) issues.push(`${characterId} 的长期记忆引用了不存在的事件 ${item.eventId}`);
    }

    return {
        checkedAt: new Date().toISOString(),
        issueCount: issues.length,
        issues: issues.slice(0, 40),
    };
}

async function checkCurrentAirpWorld() {
    const state = await ensureState();
    if (!state) return false;
    state.safety.lastIntegrityReport = runStateIntegrityCheck(state);
    await saveState(state);
    await renderCurrentView();
    return true;
}

async function applyStateDelta(delta = {}, options = {}) {
    const original = options.state ?? await ensureState();
    if (!original) return false;
    const state = options.state ?? deepCloneAirp(original);
    const owner = stateOwners.get(original) ?? captureOwner();
    assertOwner(owner);
    delta = deepCloneAirp(validateDelta(delta));

    const eventRefMap = new Map();
    const artifactRefMap = new Map();
    const processedInformation = new Set();
    const rejected = [];
    const supported = new Set(["world", "characterStatus", "events", "exposures", "knowledge", "memories", "relationChanges", "reactions", "actions", "characterRelations", "npcs", "profileUpdates", "friendships", "social", "privateMessageUpdates", "characterInitializations"]);
    for (const key of Object.keys(delta)) if (!supported.has(key)) rejected.push(`unsupported:${key}`);
    applyCharacterSetup(state, delta, rejected);
    const changedRelations = new Set();

    if (delta.world && typeof delta.world === "object") {
        if (delta.world.datetime !== undefined && String(delta.world.datetime ?? "").trim()) {
            state.world.datetime = String(delta.world.datetime).trim();
        } else if (delta.world.timeAdvanceMinutes !== undefined) {
            updateWorldTimeByMinutes(state, delta.world.timeAdvanceMinutes);
        }

        if (delta.world.location !== undefined) {
            state.world.location = truncateText(String(delta.world.location ?? "").trim(), 180);
        }

        if (delta.world.sceneSummary !== undefined) {
            state.world.sceneSummary = truncateText(String(delta.world.sceneSummary ?? "").trim(), 500);
        }

        if (Array.isArray(delta.world.presentCharacterIds)) {
            state.world.presentCharacterIds = [...new Set(delta.world.presentCharacterIds.map(String))]
                .filter(id => Boolean(state.characters[id]?.active !== false && state.characters[id]));
        }
    }

    if (Array.isArray(delta.characterStatus)) {
        for (const item of delta.characterStatus.slice(0, 20)) {
            const characterId = String(item?.characterId ?? "");
            const character = state.characters[characterId];
            if (!character || character.active === false) continue;

            character.status = character.status ?? createDefaultCharacterStatus();
            if (item.location !== undefined) character.status.location = truncateText(String(item.location ?? "").trim(), 160);
            if (item.activity !== undefined) character.status.activity = truncateText(String(item.activity ?? "").trim(), 220);
            if (item.mood !== undefined) character.status.mood = truncateText(String(item.mood ?? "").trim(), 120);
            if (item.note !== undefined) character.status.note = truncateText(String(item.note ?? "").trim(), 300);
            character.status.updatedAt = state.world.datetime || new Date().toISOString();
        }
    }

    if (Array.isArray(delta.events)) {
        for (const rawEvent of delta.events.slice(0, 12)) {
            if (!rawEvent || !String(rawEvent.summary ?? "").trim()) continue;

            const sourceEventId = resolveEventRef(state, rawEvent.sourceEventId, eventRefMap)
                ?? resolveEventRef(state, rawEvent.sourceEventRef, eventRefMap);

            const created = addEventToState(state, {
                time: truncateText(rawEvent.time ?? state.world.datetime ?? "", 80),
                summary: truncateText(rawEvent.summary, 600),
                participants: sanitizeEventCharacterIds(state, rawEvent.participants),
                witnesses: sanitizeEventCharacterIds(state, rawEvent.witnesses),
                audienceCharacterIds: sanitizeEventCharacterIds(state, rawEvent.audienceCharacterIds)
                    .filter(id => id !== "player"),
                visibility: VISIBILITY_LABELS[rawEvent.visibility] ? rawEvent.visibility : "private",
                channel: CHANNEL_LABELS[rawEvent.channel] ? rawEvent.channel : "scene",
                sourceEventId,
                tags: Array.isArray(rawEvent.tags)
                    ? rawEvent.tags.map(tag => truncateText(tag, 40)).filter(Boolean).slice(0, 10)
                    : [],
            });

            if (rawEvent.ref) eventRefMap.set(String(rawEvent.ref), created.id);
        }
    }

    applyInformationDelta(state, delta, eventRefMap, processedInformation);

    applyFriendships(state, delta, eventRefMap, rejected);
    for (const eventId of eventRefMap.values()) { const event = getEventById(state, eventId); if (event?.channel === "moments") createPropagationCandidates(state, event); }

    // Publish social content before evaluating its readers and reactions.
    if (Array.isArray(delta.characterRelations)) {
        for (const item of delta.characterRelations.slice(0, 12)) {
            const ids = item?.characterIds;
            if (!Array.isArray(ids) || ids.length !== 2) continue;
            if (ids[0] === ids[1]) { rejected.push("relationship:self"); continue; }
            if (!state.characters[ids[0]] || !state.characters[ids[1]]) continue;

            const key = getRelationKey(ids[0], ids[1]);
            const relationship = getRelationshipSnapshot(state, ids[0], ids[1]);
            if (typeof item.friendship === "boolean") relationship.friendship = item.friendship;
            if (item.source) relationship.source = truncateText(item.source, 500);

            if (Array.isArray(item.tags)) {
                relationship.tags = [...new Set(item.tags.map(tag => truncateText(String(tag).trim(), 40)).filter(Boolean))].slice(0, 10);
            }

            if (item.summary !== undefined) {
                relationship.summary = truncateText(String(item.summary ?? ""), 500);
            }

            if (item.perspectives && typeof item.perspectives === "object") {
                for (const characterId of relationship.characterIds) {
                    const incoming = item.perspectives[characterId];
                    if (!incoming) continue;

                    if (incoming.attitudeDelta !== undefined) {
                        const before = clampSigned(relationship.perspectives[characterId].attitude ?? 0);
                        const deltaValue = Math.max(-10, Math.min(10, Number(incoming.attitudeDelta) || 0));
                        relationship.perspectives[characterId].attitude = clampSigned(before + deltaValue);
                    } else if (incoming.attitude !== undefined) {
                        relationship.perspectives[characterId].attitude = clampSigned(incoming.attitude);
                    }

                    if (incoming.impression !== undefined) {
                        relationship.perspectives[characterId].impression = truncateText(String(incoming.impression ?? ""), 500);
                    }
                }
            }

            state.characterRelations[key] = relationship;
        }
    }

    applySocialDelta(state, delta, eventRefMap, rejected, artifactRefMap, () => applyInformationDelta(state, delta, eventRefMap, processedInformation));

    // V12：只把跨多场景仍值得保留的信息写入长期记忆。
    if (Array.isArray(delta.memories)) {
        for (const item of delta.memories.slice(0, 6)) {
            addLongTermMemory(state, item, eventRefMap, rejected);
        }
    }

    // 当前正文里的即时关系变化：必须能追溯到一个角色已知的事件。
    if (Array.isArray(delta.relationChanges)) {
        for (const change of delta.relationChanges.slice(0, 20)) {
            const characterId = String(change?.characterId ?? "");
            const character = state.characters[characterId];
            if (!character || character.type !== "main") continue;

            const eventId = resolveEventRef(state, change?.eventId, eventRefMap)
                ?? resolveEventRef(state, change?.eventRef, eventRefMap);
            if (!eventId || !characterKnowsEvent(state, characterId, eventId)) {
                rejected.push(`relation:${characterId}:unknown-event`);
                continue;
            }

            const severity = RELATION_SEVERITY_LIMITS[change.severity]
                ? change.severity
                : "ordinary";
            const requested = sanitizeRelationChanges(change.changes ?? change.relationChanges ?? {}, severity);
            const applied = {};

            for (const [key, value] of Object.entries(requested)) {
                const identity = `${characterId}:${eventId}:${key}`;
                if (changedRelations.has(identity)) { rejected.push(`relation:${identity}:duplicate`); continue; }
                changedRelations.add(identity);
                const before = clamp(character.relation?.[key] ?? 0);
                const after = clamp(before + value);
                character.relation[key] = after;
                applied[key] = after - before;
            }

            if (change.relationLabel !== undefined && String(change.relationLabel).trim()) {
                character.relationLabel = truncateText(String(change.relationLabel).trim(), 80);
            }

            if (Object.keys(applied).length || change.relationLabel) {
                state.reactions.push({
                    id: createId("react"),
                    characterId,
                    eventId,
                    trigger: "model_immediate",
                    source: getEventById(state, eventId)?.channel ?? "other",
                    status: "resolved",
                    summary: truncateText(change.reason ?? "", 500),
                    relationChanges: applied,
                    relationLabel: change.relationLabel ? character.relationLabel : null,
                    npcAttitudeDelta: 0,
                    npcImpression: null,
                    actionId: null,
                    createdAt: new Date().toISOString(),
                    resolvedAt: new Date().toISOString(),
                });
            }
        }
    }

    // 场外 / 延迟反应。
    if (Array.isArray(delta.reactions)) {
        for (const item of delta.reactions.slice(0, 20)) {
            const characterId = String(item?.characterId ?? "");
            const eventId = resolveEventRef(state, item?.eventId, eventRefMap)
                ?? resolveEventRef(state, item?.eventRef, eventRefMap);
            if (!state.characters[characterId] || !eventId) continue;

            if (!characterKnowsEvent(state, characterId, eventId)) {
                rejected.push(`reaction:${characterId}:unknown-event`);
                continue;
            }

            let reaction = item?.reactionId ? getReactionById(state, item.reactionId) : null;
            if (!reaction) reaction = getPendingReactionForKnowledge(state, characterId, eventId);
            if (!reaction) {
                reaction = createReactionCandidate(state, characterId, eventId, {
                    source: state.characters[characterId]?.knowledge?.[eventId]?.source,
                });
            }
            if (!reaction || reaction.status !== "pending") continue;

            if (item.status === "deferred" || item.status === "pending") {
                reaction.deferReason = truncateText(item.reason || item.summary || "等待合适的反应时机", 500);
                reaction.lastCheckedAt = new Date().toISOString();
                continue;
            }

            if (item.status === "ignored" || item.status === "none") {
                reaction.summary = truncateText(item.summary || item.reason || "已获知，没有明显情绪或行动反应", 500);
                ignoreReactionInState(state, reaction.id);
                continue;
            }

            const severity = RELATION_SEVERITY_LIMITS[item.severity]
                ? item.severity
                : "ordinary";
            const safeChanges = sanitizeRelationChanges(item.relationChanges ?? {}, severity);
            for (const key of Object.keys(safeChanges)) {
                const identity = `${characterId}:${eventId}:${key}`;
                if (changedRelations.has(identity)) { delete safeChanges[key]; rejected.push(`relation:${identity}:duplicate`); }
                else changedRelations.add(identity);
            }

            const resolution = {
                relationChanges: safeChanges,
                relationLabel: item.relationLabel,
                npcAttitudeDelta: Math.max(-10, Math.min(10, Number(item.npcAttitudeDelta ?? 0) || 0)),
                npcImpression: item.npcImpression,
                summary: truncateText(item.summary ?? "", 500),
                action: item.action ? {
                    type: item.action.type,
                    targetCharacterId: item.action.targetCharacterId,
                    timing: item.action.timing,
                    note: truncateText(item.action.note ?? "", 400),
                    targetArtifactId: item.action.targetArtifactId || artifactRefMap.get(String(item.action.targetArtifactRef ?? "")) || null,
                } : {},
            };

            const ok = resolveReactionInState(state, reaction.id, resolution);
            if (!ok) continue;

            const action = reaction.actionId ? getActionById(state, reaction.actionId) : null;
            const execution = item.action?.execute ?? {};
            if (action && action.timing === "now" && (item.action?.execute || action.type === "moment_like") && isSocialAction(action)) {
                const result = executeActionInState(state, action.id, {
                    text: truncateText(execution.text ?? "", 1200),
                    title: truncateText(execution.title ?? "", 160),
                    anonymous: Boolean(execution.anonymous),
                    time: execution.time ?? state.world.datetime,
                });
                if (item.action.ref && eventRefMap.has(String(item.action.ref))) rejected.push("reaction:duplicate-ref");
                else registerExecutionRefs(item.action, result, eventRefMap, artifactRefMap);
                applyInformationDelta(state, delta, eventRefMap, processedInformation);
            }
        }
    }

    // 对之前遗留的待执行 Action 做落地。
    if (Array.isArray(delta.actions)) {
        for (const item of delta.actions.slice(0, 20)) {
            const action = item?.actionId ? getActionById(state, item.actionId) : null;
            if (!action || action.status !== "pending") continue;

            if (item.status === "cancelled") {
                setActionStatusInState(state, action.id, "cancelled");
                continue;
            }

            if (isSocialAction(action) && (item.execute || (action.type === "moment_like" && item.status === "done"))) {
                const result = executeActionInState(state, action.id, {
                    text: truncateText(item.execute?.text ?? "", 1200),
                    title: truncateText(item.execute?.title ?? "", 160),
                    anonymous: Boolean(item.execute?.anonymous),
                    time: item.execute?.time ?? state.world.datetime,
                });
                if (item.ref && eventRefMap.has(String(item.ref))) rejected.push("action:duplicate-ref");
                else registerExecutionRefs(item, result, eventRefMap, artifactRefMap);
                applyInformationDelta(state, delta, eventRefMap, processedInformation);
            } else if (item.status === "done") {
                setActionStatusInState(state, action.id, "done");
            }
        }
    }

    state.runtime.lastProcessedMessageId = options.messageId ?? state.runtime.lastProcessedMessageId;
    state.runtime.lastTrackerStatus = rejected.length ? "applied_with_rejections" : "applied";
    state.runtime.lastTrackerError = rejected.join("; ");
    state.runtime.lastProcessedAt = new Date().toISOString();

    if (!options.state) await commitAirpDraft(original, state, owner);

    const overlay = document.getElementById("airp-phone-overlay");
    if (!options.state && overlay && !overlay.classList.contains("airp-hidden")) {
        await renderCurrentView();
    }

    return true;
}


function ensureAirpOpeningPresentationStyles() {
    if (document.getElementById(AIRP_OPENING_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = AIRP_OPENING_STYLE_ID;
    style.textContent = `
        :root {
            --airp-system-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
        }

        body.airp-ui-enabled #chat .mes_text,
        body.airp-ui-enabled #send_textarea,
        #airp-phone-overlay,
        .airp-opening-card,
        .airp-opening-card button,
        .airp-opening-card input {
            font-family: var(--airp-system-font) !important;
        }

        .airp-opening-message .mes_text {
            overflow: visible;
        }

        .airp-opening-card {
            width: min(680px, calc(100% - 10px));
            margin: 8px auto 24px;
            color: #28303a;
        }

        .airp-opening-paper {
            position: relative;
            overflow: hidden;
            box-sizing: border-box;
            padding: clamp(30px, 6vw, 58px) clamp(26px, 6.5vw, 62px) clamp(28px, 5.5vw, 52px);
            border: 1px solid rgba(176, 132, 47, .58);
            border-radius: 4px;
            background:
                linear-gradient(135deg, rgba(255,255,255,.78), rgba(255,255,255,0) 36%),
                radial-gradient(circle at 11% 8%, rgba(201,166,91,.10), transparent 33%),
                radial-gradient(circle at 88% 90%, rgba(155,112,37,.065), transparent 34%),
                #fbf8ef;
            box-shadow:
                0 18px 48px rgba(66, 54, 31, .13),
                inset 0 0 0 5px rgba(255,255,255,.55),
                inset 0 0 0 6px rgba(168,126,43,.18);
        }

        .airp-opening-paper::before {
            content: "";
            position: absolute;
            inset: 14px;
            pointer-events: none;
            border: 1px solid rgba(173, 129, 44, .28);
        }

        .airp-opening-paper::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            opacity: .34;
            mix-blend-mode: multiply;
            background-image:
                radial-gradient(circle at 20% 30%, rgba(110,88,45,.055) 0 1px, transparent 1.4px),
                radial-gradient(circle at 72% 64%, rgba(110,88,45,.04) 0 1px, transparent 1.4px);
            background-size: 17px 19px, 23px 29px;
        }

        .airp-opening-admission .airp-opening-crest {
            position: relative;
            z-index: 1;
            width: 54px;
            height: 54px;
            margin: 0 auto 18px;
            display: grid;
            place-items: center;
            border: 1px solid rgba(170,124,35,.72);
            border-radius: 50%;
            box-shadow: inset 0 0 0 4px #fbf8ef, inset 0 0 0 5px rgba(170,124,35,.35);
            font-family: var(--airp-system-font);
            font-size: 22px;
            font-weight: 620;
            letter-spacing: .08em;
            color: #9b7429;
        }

        .airp-opening-foil {
            position: relative;
            z-index: 1;
            background: linear-gradient(102deg, #75551d 0%, #b88932 22%, #e2c46e 43%, #8f671f 58%, #d8b65d 78%, #7b581d 100%);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .airp-opening-topline {
            position: relative;
            z-index: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            margin-bottom: 8px;
            font-size: 11px;
            line-height: 1.4;
            letter-spacing: .16em;
            text-transform: uppercase;
            color: #8b6b32;
        }

        .airp-opening-issuer {
            position: relative;
            z-index: 1;
            margin-top: 26px;
            text-align: center;
            font-size: 13px;
            letter-spacing: .26em;
            color: #705a33;
        }

        .airp-opening-paper h2 {
            position: relative;
            z-index: 1;
            margin: 10px 0 20px;
            text-align: center;
            font-size: clamp(28px, 5vw, 42px);
            line-height: 1.18;
            font-weight: 600;
            letter-spacing: .18em;
            color: #2f3339;
        }

        .airp-opening-rule {
            position: relative;
            z-index: 1;
            width: 72px;
            height: 1px;
            margin: 0 auto 28px;
            background: linear-gradient(90deg, transparent, #b58a3d 20%, #dfc476 50%, #a77624 80%, transparent);
        }

        .airp-opening-recipient {
            position: relative;
            z-index: 1;
            margin-bottom: 18px;
            font-size: 15px;
            font-weight: 610;
            color: #39414a;
        }

        .airp-opening-body {
            position: relative;
            z-index: 1;
            font-size: 14px;
            line-height: 2.05;
            letter-spacing: .015em;
            color: #414850;
        }

        .airp-opening-footer {
            position: relative;
            z-index: 1;
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 24px;
            margin-top: 34px;
            padding-top: 18px;
            border-top: 1px solid rgba(146,110,48,.16);
            font-size: 11px;
            line-height: 1.7;
            color: #777065;
        }

        .airp-opening-meta {
            position: relative;
            z-index: 1;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 18px;
            margin-top: 22px;
            font-size: 10px;
            letter-spacing: .06em;
            color: #948977;
        }

        .airp-opening-seal {
            flex: 0 0 auto;
            width: 78px;
            height: 78px;
            display: grid;
            place-items: center;
            padding: 9px;
            box-sizing: border-box;
            border: 2px solid rgba(166, 116, 36, .64);
            border-radius: 50%;
            transform: rotate(-7deg);
            text-align: center;
            font-size: 9px;
            line-height: 1.45;
            font-weight: 700;
            color: rgba(155, 105, 29, .76);
            background: radial-gradient(circle, rgba(211,177,96,.06), transparent 68%);
        }

        .airp-opening-prose {
            width: min(720px, 100%);
            margin: 0 auto;
        }

        @media (max-width: 720px) {
            .airp-opening-card {
                width: calc(100% - 2px);
                margin-top: 4px;
            }
            .airp-opening-paper {
                padding: 34px 25px 30px;
                border-radius: 2px;
                box-shadow: 0 12px 32px rgba(66,54,31,.11), inset 0 0 0 4px rgba(255,255,255,.55), inset 0 0 0 5px rgba(168,126,43,.16);
            }
            .airp-opening-paper::before { inset: 10px; }
            .airp-opening-topline { font-size: 9px; letter-spacing: .12em; }
            .airp-opening-issuer { font-size: 11px; letter-spacing: .20em; }
            .airp-opening-paper h2 { font-size: 30px; letter-spacing: .13em; }
            .airp-opening-body { font-size: 13.5px; line-height: 1.95; }
            .airp-opening-seal { width: 68px; height: 68px; font-size: 8px; }
        }
    `;
    document.head.appendChild(style);
}

function parseLegacyAdmissionOpening(text = "") {
    const source = String(text ?? "");
    if (!AIRP_LEGACY_ADMISSION_RE.test(source)) return null;

    let working = source.replace(AIRP_LEGACY_ADMISSION_RE, "").trim();
    working = working
        .replace(/^昭庭学院\s*$/m, "")
        .replace(/^ADMISSION NOTICE\s*$/mi, "")
        .trim();

    let recipient = "";
    working = working.replace(/^致\s*([^：:\n]+)[：:]\s*$/m, (_, name) => {
        recipient = String(name ?? "").trim();
        return "";
    });

    const split = working.split(/^——\s*$/m);
    let body = (split[0] || "").trim();
    let tail = split.slice(1).join("\n").trim();

    body = body
        .replace(/^\[学院印章\]\s*$/gm, "")
        .replace(/^\[录取编号[：:].*?\]\s*$/gm, "")
        .replace(/^\[签发日期[：:].*?\]\s*$/gm, "")
        .trim();

    const footerMatch = tail.match(/昭庭学院招生委员会/);
    const footer = footerMatch ? "昭庭学院招生委员会" : "昭庭学院招生委员会";

    return {
        cleanText: "",
        opening: {
            type: "admission",
            data: {
                eyebrow: "ZHAOTING ACADEMY · ADMISSION OFFICE",
                issuer: "昭庭学院",
                title: "录取通知书",
                recipient: recipient || getContext().name1 || "玩家",
                body,
                footer,
                seal: "昭庭学院\n招生委员会",
            },
        },
    };
}

function resolveWorldOpeningMacros(text = "", state = null) {
    const context = getContext();
    const currentCard = getCurrentCard();
    const values = {
        user: context.name1 || "玩家",
        player: context.name1 || "玩家",
        char: currentCard?.name || "",
        worldDate: state?.world?.datetime || "",
    };

    return String(text ?? "").replace(/\{\{\s*(user|player|char|worldDate)\s*\}\}/g, (_, key) => values[key] ?? "");
}

async function materializeWorldPackOpening() {
    const context = getContext();
    const currentCard = getCurrentCard();
    if (!isAirpHostCard(currentCard)) return false;

    const index = (context.chat ?? []).findIndex(message =>
        message
        && !message.is_user
        && !message.is_system
        && String(message.mes ?? "").includes(AIRP_WORLD_OPENING_MARKER),
    );
    if (index < 0) return false;

    const state = await ensureState();
    await loadWorldPack(state, false);
    const source = String(worldPackCache.documents?.opening ?? "").trim();
    if (!source) return false;

    const message = context.chat[index];
    message.mes = resolveWorldOpeningMacros(source, state);
    message.extra = message.extra || {};
    message.extra.airpWorldOpening = {
        packFolder: worldPackCache.folder,
        loadedAt: worldPackCache.loadedAt,
    };
    syncCleanMessageToSwipe(message);
    context.updateMessageBlock?.(index, message, { rerenderMessage: true });
    await context.saveChat?.();
    await processOpeningBlock(index);
    requestAnimationFrame(() => decorateOpeningMessage(index));
    return true;
}

function extractAirpOpeningBlock(text = "") {
    const source = String(text ?? "");
    const match = source.match(AIRP_OPENING_BLOCK_RE);
    if (!match) {
        const legacy = parseLegacyAdmissionOpening(source);
        return legacy ?? { cleanText: source, opening: null };
    }

    const rawType = String(match[1] ?? "document").trim().toLowerCase() || "document";
    const rawJson = String(match[2] ?? "").trim();

    let data = {};
    try {
        data = rawJson ? JSON.parse(rawJson) : {};
    } catch (error) {
        throw new Error(`AIRP_OPENING JSON 解析失败：${error?.message ?? error}`);
    }

    return {
        cleanText: source.replace(match[0], "").trim(),
        opening: { type: rawType, data },
    };
}

function buildOpeningComponentHtml(opening = {}) {
    const type = String(opening.type ?? "document").toLowerCase();
    const data = opening.data && typeof opening.data === "object" ? opening.data : {};
    const title = data.title || (type === "admission" ? "录取通知书" : "通知");
    const issuer = data.issuer || data.school || data.organization || "";
    const recipient = data.recipient || "";
    const date = data.date || "";
    const body = data.body || "";
    const footer = data.footer || "";
    const seal = data.seal || issuer || "";
    const eyebrow = data.eyebrow || (type === "admission" ? "ADMISSION NOTICE" : "AIRP DOCUMENT");

    if (type === "admission") {
        const serialSeed = `${issuer}|${recipient}|${date || worldPackCache.folder || "airp"}`;
        const serial = data.serial || data.number || `ZT-${String(date || "2026").slice(0, 4)}-${hashString(serialSeed).toUpperCase().slice(0, 6)}`;
        return `
            <section class="airp-opening-card airp-opening-admission" data-airp-opening-component="true">
                <div class="airp-opening-paper">
                    <div class="airp-opening-crest airp-opening-foil" aria-hidden="true">昭</div>
                    <div class="airp-opening-topline">
                        <span class="airp-opening-foil">${escapeHtml(eyebrow)}</span>
                        ${date ? `<time>${escapeHtml(date)}</time>` : ""}
                    </div>
                    ${issuer ? `<div class="airp-opening-issuer airp-opening-foil">${escapeHtml(issuer)}</div>` : ""}
                    <h2>${escapeHtml(title)}</h2>
                    <div class="airp-opening-rule"></div>
                    ${recipient ? `<div class="airp-opening-recipient">致 ${escapeHtml(recipient)}：</div>` : ""}
                    ${body ? `<div class="airp-opening-body">${escapeHtml(body).replaceAll("\\n", "<br>")}</div>` : ""}
                    <div class="airp-opening-meta">
                        <span>ADMISSION NO. ${escapeHtml(serial)}</span>
                        ${date ? `<span>ISSUED ${escapeHtml(date)}</span>` : ""}
                    </div>
                    <div class="airp-opening-footer">
                        ${footer ? `<span>${escapeHtml(footer)}</span>` : `<span></span>`}
                        ${seal ? `<b class="airp-opening-seal">${escapeHtml(seal).replaceAll("\\n", "<br>")}</b>` : ""}
                    </div>
                </div>
            </section>
        `;
    }

    return `
        <section class="airp-opening-card airp-opening-${escapeAttribute(type)}" data-airp-opening-component="true">
            <div class="airp-opening-paper">
                <div class="airp-opening-topline">
                    <span>${escapeHtml(eyebrow)}</span>
                    ${date ? `<time>${escapeHtml(date)}</time>` : ""}
                </div>
                ${issuer ? `<div class="airp-opening-issuer">${escapeHtml(issuer)}</div>` : ""}
                <h2>${escapeHtml(title)}</h2>
                <div class="airp-opening-rule"></div>
                ${recipient ? `<div class="airp-opening-recipient">致 ${escapeHtml(recipient)}</div>` : ""}
                ${body ? `<div class="airp-opening-body">${escapeHtml(body).replaceAll("\\n", "<br>")}</div>` : ""}
                <div class="airp-opening-footer">
                    ${footer ? `<span>${escapeHtml(footer)}</span>` : `<span></span>`}
                    ${seal ? `<b class="airp-opening-seal">${escapeHtml(seal)}</b>` : ""}
                </div>
            </div>
        </section>
    `;
}

function decorateOpeningMessage(messageId) {
    const context = getContext();
    const index = Number(messageId);
    const message = Number.isInteger(index) ? context.chat?.[index] : null;
    if (!message?.extra?.airpOpening) return false;

    const state = context.chatMetadata?.[AIRP_KEY];

    const messageElement = document.querySelector(`#chat .mes[mesid="${index}"]`);
    const textElement = messageElement?.querySelector(".mes_text");
    if (!textElement || textElement.querySelector('[data-airp-opening-component="true"]')) return false;

    if (state?.settings?.openingComponentsEnabled === false) {
        const data = message.extra.airpOpening?.data ?? {};
        const title = data.title || "剧情文档";
        const body = data.body || "";
        textElement.insertAdjacentHTML(
            "afterbegin",
            `<section class="airp-opening-fallback" data-airp-opening-component="true"><strong>${escapeHtml(title)}</strong>${body ? `<p>${escapeHtml(body).replaceAll("\n", "<br>")}</p>` : ""}</section>`,
        );
        return true;
    }

    textElement.insertAdjacentHTML("afterbegin", buildOpeningComponentHtml(message.extra.airpOpening));
    messageElement.classList.add("airp-opening-message");
    return true;
}

function decorateAllOpeningMessages() {
    const context = getContext();
    for (let i = 0; i < (context.chat?.length ?? 0); i++) {
        if (context.chat[i]?.extra?.airpOpening) decorateOpeningMessage(i);
    }
}

async function processOpeningBlock(messageId) {
    const context = getContext();
    const index = Number(messageId);
    const message = Number.isInteger(index) ? context.chat?.[index] : null;
    if (!message || message.is_user || message.is_system) return false;

    if (message.extra?.airpOpening) {
        queueMicrotask(() => decorateOpeningMessage(index));
        return true;
    }

    const openingText = String(message.mes ?? "");
    if (!openingText.includes("<AIRP_OPENING") && !AIRP_LEGACY_ADMISSION_RE.test(openingText)) return false;

    try {
        const { cleanText, opening } = extractAirpOpeningBlock(message.mes);
        if (!opening) return false;
        message.extra = message.extra || {};
        message.extra.airpOpening = opening;
        message.mes = cleanText;
        syncCleanMessageToSwipe(message);
        context.updateMessageBlock?.(index, message, { rerenderMessage: true });
        await context.saveChat?.();
        queueMicrotask(() => decorateOpeningMessage(index));
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] AIRP_OPENING parse failed`, error);
        return false;
    }
}

async function processExistingOpeningBlocks() {
    const context = getContext();
    for (let i = 0; i < (context.chat?.length ?? 0); i++) {
        const message = context.chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const openingText = String(message.mes ?? "");
        if (message.extra?.airpOpening || openingText.includes("<AIRP_OPENING") || AIRP_LEGACY_ADMISSION_RE.test(openingText)) {
            await processOpeningBlock(i);
        }
    }
    requestAnimationFrame(decorateAllOpeningMessages);
}

function syncCleanMessageToSwipe(message) {
    if (!message || message.swipe_id === undefined || !Array.isArray(message.swipes)) return;
    const index = Number(message.swipe_id);
    if (Number.isInteger(index) && index >= 0) {
        message.swipes[index] = message.mes;
        if (Array.isArray(message.swipe_info) && message.swipe_info[index]) {
            message.swipe_info[index].extra = structuredClone(message.extra ?? {});
        }
    }
}

async function processAssistantStateBlock(messageId, generationType = "normal") {
    const context = getContext();
    const owner = captureOwner(context);
    const index = Number(messageId);
    const message = Number.isInteger(index) ? context.chat?.[index] : null;
    if (!message || message.is_user || message.is_system) return false;
    const extracted = extractAirpStateBlock(message.mes);
    const rawState = extracted.rawState ?? ((!message.extra?.airp?.applied && !message.extra?.airp?.invalidated) ? message.extra?.airp?.rawState : null);
    if (!rawState) return false;
    const cleanText = extracted.cleanText;
    let state;
    try {
        const delta = validateDelta(parseAirpStateJson(rawState));
        state = await ensureState();
        assertOwner(owner);
        if (!state || state.settings.stateTrackerEnabled === false) return false;
        const key = `${message.send_date ?? index}:${message.swipe_id ?? 0}:${hashString(rawState)}`;
        let checkpoint = (state.safety.historyCheckpoints ?? []).find(item => item.messageKey === key);
        if (checkpoint && (message.extra?.airp?.invalidated || !isCheckpointOnActiveBranch(state, checkpoint.id))) checkpoint = null;
        if (!checkpoint) {
            const draft = deepCloneAirp(state);
            stateOwners.set(draft, owner);
            const before = createDynamicStateSnapshot(draft);
            prepareAutoUndoPoint(draft, delta, { messageId: index, generationType });
            await applyStateDelta(delta, { state: draft, messageId: index, generationType });
            assertOwner(owner);
            checkpoint = addHistoryCheckpoint(draft, { messageId: index, swipeId: message.swipe_id ?? 0, generationType, before, after: createDynamicStateSnapshot(draft) });
            checkpoint.messageKey = key;
            draft.safety.lastAutoUpdate.transactionId = checkpoint.id;
            delete draft.safety.lastAutoUpdate.before;
            state = await commitAirpDraft(state, draft, owner);
        } else if (state.runtime.saveStatus !== "submitted") {
            await saveState(state);
        }
        message.extra ??= {};
        message.extra.airp = { version: STATE_VERSION, rawState, delta, generationType, processedAt: new Date().toISOString(), applied: true, invalidated: false, transactionId: checkpoint.id, error: null };
        message.mes = cleanText;
        syncCleanMessageToSwipe(message);
        checkedSaveResult(await context.saveChat?.());
        assertOwner(owner);
    } catch (error) {
        console.error(`[${MODULE_NAME}] AIRP_STATE parse/apply failed`, error);
        message.extra ??= {};
        message.extra.airp = { ...message.extra.airp, version: STATE_VERSION, rawState, generationType, applied: message.extra.airp?.applied === true, error: String(error?.message ?? error) };
        if (state && owner.metadata === getContext().chatMetadata) {
            state.runtime.lastTrackerStatus = "error";
            state.runtime.lastTrackerError = String(error?.message ?? error);
            if (message.extra.airp.applied) {
                state.runtime.chatSaveError = String(error?.message ?? error);
                await writeRecovery(owner, state, true);
            }
        }
        return false;
    }
    await refreshAirpStatePrompt();
    const overlay = document.getElementById("airp-phone-overlay");
    if (overlay && !overlay.classList.contains("airp-hidden")) await renderCurrentView({ background: true });
    rememberChatStructure();
    return true;
}

function isCheckpointOnActiveBranch(state, id) {
    const lookup = new Map((state.safety.historyCheckpoints ?? []).map(item => [item.id, item]));
    const seen = new Set();
    let current = state.safety.activeCheckpointId;
    while (current && !seen.has(current)) { if (current === id) return true; seen.add(current); current = lookup.get(current)?.parentId; }
    return false;
}

async function recoverCurrentChatState() {
    if (!getContext().getCurrentChatId?.()) return;
    await enqueueAirp(processExistingStateBlocks);
}

async function processExistingStateBlocks() {
    const context = getContext();
    const owner = captureOwner(context);
    for (let i = 0; i < (context.chat ?? []).length; i++) {
        const message = context.chat[i];
        if (message.is_user || message.is_system || message.extra?.airp?.invalidated || message.extra?.airp?.applied || message.extra?.airp?.rolledBackAt) continue;
        const raw = extractAirpStateBlock(message.mes).rawState;
        if (raw && (context.chatMetadata[AIRP_KEY]?.safety?.ignoredStateBlocks ?? []).includes(`${message.send_date ?? i}:${message.swipe_id ?? 0}:${hashString(raw)}`)) continue;
        if (/<AIRP_STATE>/i.test(message.mes ?? "") || message.extra?.airp?.rawState) {
            assertOwner(owner);
            if (!await processAssistantStateBlock(i, "recovery")) break;
        }
    }
}

/* =========================================================
   导航
   ========================================================= */

async function navigateTo(page, characterId = null, pushHistory = true) {
    if (pushHistory) {
        navigationStack.push({ ...currentView });
    }

    currentView = {
        page,
        characterId,
        eventId: null,
        relationKey: null,
        reactionId: null,
        actionId: null,
    };

    await renderCurrentView();
}

async function navigateToEvent(eventId, pushHistory = true) {
    if (pushHistory) navigationStack.push({ ...currentView });

    currentView = {
        page: "event-detail",
        characterId: null,
        eventId,
        relationKey: null,
        reactionId: null,
        actionId: null,
    };

    await renderCurrentView();
}

async function navigateToRelation(relationKey, pushHistory = true) {
    if (pushHistory) navigationStack.push({ ...currentView });

    currentView = {
        page: "relation-edit",
        characterId: null,
        eventId: null,
        relationKey,
        reactionId: null,
        actionId: null,
    };

    await renderCurrentView();
}

async function navigateToReaction(reactionId, pushHistory = true) {
    if (pushHistory) navigationStack.push({ ...currentView });

    currentView = {
        page: "reaction-detail",
        characterId: null,
        eventId: null,
        relationKey: null,
        reactionId,
        actionId: null,
    };

    await renderCurrentView();
}

async function navigateToAction(actionId, pushHistory = true) {
    if (pushHistory) navigationStack.push({ ...currentView });

    currentView = {
        page: "action-execute",
        characterId: null,
        eventId: null,
        relationKey: null,
        reactionId: null,
        actionId,
    };

    await renderCurrentView();
}

async function navigateToForumPost(postId, pushHistory = true) {
    if (pushHistory) navigationStack.push({ ...currentView });
    currentView = {
        ...createHomeView(),
        page: "forum-detail",
        forumPostId: postId,
    };
    await renderCurrentView();
}


async function goBack() {
    currentView = navigationStack.length === 0
        ? createHomeView()
        : navigationStack.pop();

    await renderCurrentView();
}

/* =========================================================
   手机外壳
   ========================================================= */

function createPhoneUI() {
    if (document.getElementById("airp-phone-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "airp-phone-overlay";
    overlay.classList.add("airp-hidden");

    overlay.innerHTML = `
        <div id="airp-phone">
            <div class="airp-statusbar">
                <span id="airp-world-time">--:--</span>
                <div class="airp-status-icons">
                    <i class="fa-solid fa-signal"></i>
                    <i class="fa-solid fa-wifi"></i>
                    <i class="fa-solid fa-battery-three-quarters"></i>
                </div>
            </div>

            <header class="airp-navbar">
                <button id="airp-phone-back" class="airp-nav-button airp-nav-hidden" type="button">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>

                <div id="airp-phone-title" class="airp-navbar-title">手机</div>

                <button id="airp-phone-close" class="airp-nav-button" type="button">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>

            <main id="airp-phone-content" class="airp-phone-content"></main>
            <div id="airp-phone-footer" class="airp-phone-footer airp-hidden"></div>
            <div class="airp-home-indicator"></div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("airp-phone-close")?.addEventListener("click", () => {
        overlay.classList.add("airp-hidden");
    });

    document.getElementById("airp-phone-back")?.addEventListener("click", goBack);

    overlay.addEventListener("input", captureAirpDrafts);
    overlay.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.matches('[data-airp-action="open-notification"]')) { event.preventDefault(); handleAirpClick(event); } });
    overlay.addEventListener("click", event => {
        if (event.target === overlay) {
            overlay.classList.add("airp-hidden");
        }
    });

    document.getElementById("airp-phone-content")?.addEventListener("click", handleAirpClick);
    document.getElementById("airp-phone-footer")?.addEventListener("click", handleAirpClick);
}

/* =========================================================
   通用组件
   ========================================================= */

function renderAvatar(character, className = "") {
    const name = character.display.name;
    const avatar = character.display.avatarUrl;

    if (avatar) {
        return `
            <div class="airp-avatar ${className}">
                <img src="${escapeAttribute(avatar)}" alt="">
            </div>
        `;
    }

    return `
        <div class="airp-avatar airp-avatar-fallback ${className}">
            ${escapeHtml(getInitial(name))}
        </div>
    `;
}

function renderCardAvatar(card, className = "") {
    const avatar = getCardAvatarUrl(card);

    if (avatar) {
        return `
            <div class="airp-avatar ${className}">
                <img src="${escapeAttribute(avatar)}" alt="">
            </div>
        `;
    }

    return `
        <div class="airp-avatar airp-avatar-fallback ${className}">
            ${escapeHtml(getInitial(card.name))}
        </div>
    `;
}

function renderEmpty(text) {
    return `<div class="airp-empty">${escapeHtml(text)}</div>`;
}

function renderChip(text, className = "") {
    return `<span class="airp-mini-chip ${className}">${escapeHtml(text)}</span>`;
}

/* =========================================================
   首页
   ========================================================= */

function renderHome(state) {
    const location = state.world.location || "地点未设置";
    const datetime = state.world.datetime || "等待剧情时间";
    const scene = state.world.sceneSummary || "点此设置当前场景";
    const presentCount = (state.world.presentCharacterIds ?? []).length;

    return `
        <div class="airp-home-screen">
            <button type="button" class="airp-home-clock airp-world-widget" data-airp-action="open-world-state">
                <div class="airp-home-time">
                    ${escapeHtml(extractWorldTime(state.world.datetime))}
                </div>

                <div class="airp-home-date">${escapeHtml(datetime)}</div>

                <div class="airp-home-location">
                    <i class="fa-solid fa-location-dot"></i>
                    ${escapeHtml(location)}
                    <i class="fa-solid fa-chevron-right airp-world-widget-arrow"></i>
                </div>

                <div class="airp-home-scene">${escapeHtml(scene)}</div>
                <div class="airp-home-present">在场 ${presentCount} 人 · 事件 ${state.events.length} 条</div>
            </button>

            <section class="airp-app-grid">
                ${renderApp("chat", "fa-comment", "私聊", "open-chat")}
                ${renderApp("moments", "fa-camera-retro", "朋友圈", "open-moments")}
                ${renderApp("forum", "fa-comments", "论坛", "open-forum")}
                ${renderApp("profiles", "fa-user-group", "角色", "open-profiles")}
                ${renderApp("notifications", "fa-bell", "通知", "open-notifications", getUnreadNotificationCount(state))}
            </section>
        </div>
    `;
}

function renderApp(type, icon, label, action, badge = 0) {
    return `
        <button type="button" class="airp-app airp-app-${type}" data-airp-action="${action}">
            <div class="airp-app-icon"><i class="fa-solid ${icon}"></i>${badge ? `<b class="airp-v10-app-badge">${Math.min(99, badge)}</b>` : ""}</div>
            <span>${escapeHtml(label)}</span>
        </button>
    `;
}

/* =========================================================
   当前场景 / 世界状态
   ========================================================= */

function renderWorldState(state) {
    const characters = getWorldCharacters(state);
    const presentIds = new Set(state.world.presentCharacterIds ?? []);
    const developerMode = state.settings?.interfaceMode !== "player";
    const trackerStatus = state.runtime?.lastTrackerStatus ?? "idle";

    const playerSummary = `
        <section class="airp-v7-world-summary airp-glass">
            <div><span>时间</span><strong>${escapeHtml(state.world.datetime || "未设置")}</strong></div>
            <div><span>地点</span><strong>${escapeHtml(state.world.location || "未设置")}</strong></div>
            <p>${escapeHtml(state.world.sceneSummary || "当前场景尚未同步。")}</p>
            <div class="airp-v7-present-chips">
                ${(state.world.presentCharacterIds ?? []).length
                    ? (state.world.presentCharacterIds ?? []).map(id => `<span>${escapeHtml(getCharacterName(state, id))}</span>`).join("")
                    : `<span>当前没有记录在场角色</span>`}
            </div>
        </section>
    `;

    const developerEditor = `
        <section class="airp-world-form airp-glass">
            <label class="airp-world-field">
                <span>世界时间</span>
                <input id="airp-world-datetime-input" type="text"
                    value="${escapeAttribute(state.world.datetime || "")}"
                    placeholder="例如：2026-09-03 20:17">
            </label>

            <label class="airp-world-field">
                <span>当前地点</span>
                <input id="airp-world-location-input" type="text"
                    value="${escapeAttribute(state.world.location || "")}"
                    placeholder="例如：学院宴会厅">
            </label>

            <label class="airp-world-field">
                <span>场景摘要</span>
                <textarea id="airp-world-scene-input" rows="3"
                    placeholder="一句话记录当前剧情状态。">${escapeHtml(state.world.sceneSummary || "")}</textarea>
            </label>
        </section>

        <div class="airp-section-heading airp-section-gap-small">当前在场</div>

        <section class="airp-present-list">
            ${characters.length
                ? characters.map(character => renderPresentCharacter(character, presentIds.has(character.id))).join("")
                : renderEmpty("当前世界里还没有角色")}
        </section>

        <button type="button" class="airp-world-save" data-airp-action="save-world-state">
            保存当前场景
        </button>
    `;

    return `
        <div class="airp-page airp-world-state-page">
            <section class="airp-v7-tracker-banner airp-glass">
                <div class="airp-v7-tracker-dot ${state.settings?.stateTrackerEnabled ? "is-on" : ""}"></div>
                <div>
                    <strong>AIRP State Tracker</strong>
                    <span>${state.settings?.stateTrackerEnabled ? "自动状态追踪已开启" : "自动状态追踪已关闭"} · ${escapeHtml(trackerStatus)}</span>
                </div>
                <button type="button" data-airp-action="open-settings" title="AIRP 设置">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </section>

            ${developerMode ? developerEditor : playerSummary}

            ${developerMode ? `
            <section class="airp-world-tools">
                <button type="button" class="airp-world-tool airp-glass" data-airp-action="open-world-studio">
                    <div class="airp-world-tool-icon"><i class="fa-solid fa-earth-asia"></i></div>
                    <div>
                        <strong>世界资料</strong>
                        <span>${escapeHtml(getWorldPackSummary() || "Markdown 世界包与本存档补充")}</span>
                    </div>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>

                <button type="button" class="airp-world-tool airp-glass" data-airp-action="open-events">
                    <div class="airp-world-tool-icon"><i class="fa-solid fa-clock-rotate-left"></i></div>
                    <div>
                        <strong>事件记录</strong>
                        <span>${state.events.length} 条 · 管理公开度与知情角色</span>
                    </div>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>

                <button type="button" class="airp-world-tool airp-glass" data-airp-action="open-propagation">
                    <div class="airp-world-tool-icon"><i class="fa-solid fa-tower-broadcast"></i></div>
                    <div>
                        <strong>信息传播</strong>
                        <span>${state.pendingExposures.length} 条待模型判断 · 谁真的看到了什么</span>
                    </div>
                    ${state.pendingExposures.length ? `<b class="airp-tool-badge">${state.pendingExposures.length}</b>` : ""}
                    <i class="fa-solid fa-chevron-right"></i>
                </button>

                <button type="button" class="airp-world-tool airp-glass" data-airp-action="open-reactions">
                    <div class="airp-world-tool-icon"><i class="fa-solid fa-bolt"></i></div>
                    <div>
                        <strong>角色反应</strong>
                        <span>${getPendingReactionCount(state)} 条待处理 · ${getPendingActionCount(state)} 个行动待执行</span>
                    </div>
                    ${getPendingReactionCount(state) ? `<b class="airp-tool-badge">${getPendingReactionCount(state)}</b>` : ""}
                    <i class="fa-solid fa-chevron-right"></i>
                </button>

                <button type="button" class="airp-world-tool airp-glass" data-airp-action="open-relations">
                    <div class="airp-world-tool-icon"><i class="fa-solid fa-diagram-project"></i></div>
                    <div>
                        <strong>人物关系</strong>
                        <span>攻略角色 / NPC 之间的双向关系</span>
                    </div>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </section>
            ` : ""}
        </div>
    `;
}


function renderWorldStudio(state) {
    const info = state.worldInfo ?? {};
    const pack = worldPackCache;
    const promptBundle = externalPromptCache;
    const statusLabel = {
        idle: "尚未加载",
        loading: "正在加载",
        loaded: "已加载",
        error: "加载失败",
        disabled: "已关闭",
    }[pack.status] || pack.status;
    const promptStatusLabel = {
        idle: "尚未加载",
        loading: "正在加载",
        loaded: "已加载",
        error: "加载失败",
        disabled: "已关闭",
    }[promptBundle.status] || promptBundle.status;

    const docs = pack.documents ?? {};
    const config = pack.config ?? {};
    const sectionCount = pack.sections?.length ?? 0;
    const promptFiles = Array.isArray(promptBundle.files) ? promptBundle.files : [];

    return `
        <div class="airp-page airp-v10-worldpack-page">
            <section class="airp-v9-studio-card airp-glass">
                <div class="airp-card-heading">
                    <span>World Pack · 世界包</span>
                    <span class="airp-v10-pack-status is-${escapeAttribute(pack.status)}">${escapeHtml(statusLabel)}</span>
                </div>
                <p class="airp-v9-help">长期世界资料只从 Markdown 读取；玩家人设直接读取当前 SillyTavern Persona，不在世界包里写死。</p>

                <label class="airp-world-field">
                    <span>世界包文件夹</span>
                    <input id="airp-worldinfo-pack-folder" type="text" value="${escapeAttribute(info.packFolder || "学院世界")}" placeholder="例如：学院世界">
                </label>

                <div class="airp-v10-pack-grid">
                    <div><span>名称</span><strong>${escapeHtml(config.name || "—")}</strong></div>
                    <div><span>版本</span><strong>${escapeHtml(config.version || "—")}</strong></div>
                    <div><span>世界设定.md</span><strong>${docs.world ? `${docs.world.length} 字` : "未读取"}</strong></div>
                    <div><span>开局前提.md</span><strong>${docs.player ? `${docs.player.length} 字` : "未读取"}</strong></div>
                    <div><span>开场内容.md</span><strong>${docs.opening ? `${docs.opening.length} 字` : "未读取"}</strong></div>
                    <div><span>叙事风格.md</span><strong>${docs.style ? `${docs.style.length} 字` : "未读取"}</strong></div>
                    <div><span>Markdown 章节</span><strong>${sectionCount}</strong></div>
                </div>

                ${pack.error ? `<div class="airp-v10-pack-error">${escapeHtml(pack.error)}</div>` : ""}
            </section>

            <section class="airp-v9-studio-card airp-glass">
                <div class="airp-card-heading">
                    <span>外置提示词</span>
                    <span class="airp-v10-pack-status is-${escapeAttribute(promptBundle.status)}">${escapeHtml(promptStatusLabel)}</span>
                </div>
                <p class="airp-v9-help">这里就是之前说的「叙事规则 / 状态追踪 / 关系规则 / 社交反应」。实际文字维护在 提示词/*.md。</p>
                <div class="airp-v10-pack-grid">
                    ${promptFiles.length
                        ? promptFiles.map(file => `
                            <div>
                                <span>${escapeHtml(file.label)}.md</span>
                                <strong>${file.loaded ? `${file.chars} 字 · 已读取` : "未读取"}</strong>
                            </div>
                        `).join("")
                        : `
                            <div><span>叙事规则.md</span><strong>等待加载</strong></div>
                            <div><span>状态追踪.md</span><strong>等待加载</strong></div>
                            <div><span>关系规则.md</span><strong>等待加载</strong></div>
                            <div><span>社交反应.md</span><strong>等待加载</strong></div>
                        `}
                </div>
                ${promptBundle.error ? `<div class="airp-v10-pack-error">${escapeHtml(promptBundle.error)}</div>` : ""}
            </section>

            <section class="airp-v9-studio-card airp-glass">
                <div class="airp-card-heading"><span>当前存档补充</span></div>
                <p class="airp-v9-help">只写这个周目临时新增、而不值得改进世界包的设定。会进入模型上下文，但不会写回 Markdown。</p>
                <label class="airp-world-field">
                    <span>补充设定</span>
                    <textarea id="airp-worldinfo-local-supplement" rows="7" placeholder="例如：本周临时增加校庆活动……">${escapeHtml(info.localSupplement || "")}</textarea>
                </label>
            </section>

            <div class="airp-v10-inline-actions airp-v10-world-actions">
                <button type="button" class="airp-world-save is-secondary" data-airp-action="reload-world-pack">重新加载全部 Markdown</button>
                <button type="button" class="airp-world-save" data-airp-action="save-world-studio">保存当前世界设置</button>
            </div>
        </div>
    `;
}

async function saveWorldStudioFromUI() {
    const state = await ensureState();
    if (!state) return;

    state.worldInfo.packFolder = document.getElementById("airp-worldinfo-pack-folder")?.value?.trim() || "学院世界";
    state.worldInfo.localSupplement = document.getElementById("airp-worldinfo-local-supplement")?.value?.trim() ?? "";

    await saveState(state);
    await loadWorldPack(state, true);
    await loadExternalPromptBundle(state, true);
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

async function reloadWorldPackFromUI() {
    const state = await ensureState();
    if (!state) return;

    const inputFolder = document.getElementById("airp-worldinfo-pack-folder")?.value?.trim();
    if (inputFolder) state.worldInfo.packFolder = inputFolder;
    await saveState(state);
    await loadWorldPack(state, true);
    await loadExternalPromptBundle(state, true);
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

function renderSettings(state) {
    const settings = state.settings ?? {};
    const runtime = state.runtime ?? {};

    return `
        <div class="airp-page airp-v7-settings-page airp-v8-settings-page">
            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>界面模式</span></div>
                <label class="airp-v7-setting-row">
                    <div>
                        <strong>玩家模式</strong>
                        <span>隐藏事件、传播、反应等调试入口，只保留正常游玩界面。</span>
                    </div>
                    <input id="airp-setting-player-mode" type="checkbox" ${settings.interfaceMode === "player" ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>界面与设备</span></div>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>AIRP 酒馆主题</strong>
                        <span>统一主聊天、输入区和菜单的蓝白玻璃视觉；关闭后保留 ST 原主题。</span>
                    </div>
                    <input id="airp-setting-theme-enabled" type="checkbox" ${settings.themeEnabled !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>手机自适应全屏</strong>
                        <span>窄屏设备打开 AIRP 手机时自动铺满真实屏幕；桌面仍显示手机外壳。</span>
                    </div>
                    <input id="airp-setting-responsive-phone" type="checkbox" ${settings.responsivePhone !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>弱化消息操作按钮</strong>
                        <span>编辑、复制等按钮平时降低存在感，悬停 / 触摸消息时恢复。</span>
                    </div>
                    <input id="airp-setting-compact-controls" type="checkbox" ${settings.compactMessageControls !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>特殊剧情组件</strong>
                        <span>允许开场白中的 AIRP_OPENING 渲染为录取通知书、信件等剧情 UI。</span>
                    </div>
                    <input id="airp-setting-opening-components" type="checkbox" ${settings.openingComponentsEnabled !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>社交通知</strong>
                        <span>角色私聊、评论、点赞和论坛回复可以进入手机通知中心。</span>
                    </div>
                    <input id="airp-setting-social-notifications" type="checkbox" ${settings.socialNotificationsEnabled !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>模型状态追踪</span></div>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>自动解析 AIRP_STATE</strong>
                        <span>模型回复后自动读取隐藏状态块并写入当前世界。</span>
                    </div>
                    <input id="airp-setting-tracker-enabled" type="checkbox" ${settings.stateTrackerEnabled ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>注入 AIRP 上下文</strong>
                        <span>生成前把当前世界、相关角色和状态规则注入模型。</span>
                    </div>
                    <input id="airp-setting-context-enabled" type="checkbox" ${settings.contextInjectionEnabled ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>World Pack / Markdown</span></div>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>读取世界包</strong>
                        <span>生成前自动读取 世界包/当前文件夹 下的世界设定、玩家设定和叙事风格。</span>
                    </div>
                    <input id="airp-setting-worldpack-enabled" type="checkbox" ${settings.worldPackEnabled !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>

                <label class="airp-v7-setting-row">
                    <div>
                        <strong>读取外置提示词</strong>
                        <span>从 提示词/*.md 加载你可直接维护的补充规则。</span>
                    </div>
                    <input id="airp-setting-external-prompts-enabled" type="checkbox" ${settings.externalPromptsEnabled !== false ? "checked" : ""}>
                    <span class="airp-present-toggle"></span>
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>Markdown Token 控制</span></div>
                <label class="airp-world-field">
                    <span>世界设定最大字符</span>
                    <input id="airp-setting-world-doc-limit" type="number" min="1000" max="20000" step="500" value="${escapeAttribute(settings.maxWorldDocChars ?? 12000)}">
                </label>
                <label class="airp-world-field">
                    <span>玩家设定最大字符</span>
                    <input id="airp-setting-player-doc-limit" type="number" min="500" max="10000" step="250" value="${escapeAttribute(settings.maxPlayerDocChars ?? 3200)}">
                </label>
                <label class="airp-world-field">
                    <span>叙事风格最大字符</span>
                    <input id="airp-setting-style-doc-limit" type="number" min="500" max="8000" step="250" value="${escapeAttribute(settings.maxStyleDocChars ?? 8000)}">
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass">
                <div class="airp-card-heading"><span>Token 控制</span></div>
                <label class="airp-world-field">
                    <span>最近事件条数</span>
                    <input id="airp-setting-event-limit" type="number" min="1" max="20" value="${escapeAttribute(settings.recentEventLimit ?? 6)}">
                </label>
                <label class="airp-world-field">
                    <span>Persona 最大字符</span>
                    <input id="airp-setting-persona-limit" type="number" min="300" max="6000" step="100" value="${escapeAttribute(settings.maxPersonaChars ?? 2400)}">
                </label>
                <label class="airp-world-field">
                    <span>在场角色卡最大字符</span>
                    <input id="airp-setting-present-card-limit" type="number" min="1000" max="12000" step="100" value="${escapeAttribute(settings.maxPresentCardChars ?? 4200)}">
                </label>
                <label class="airp-world-field">
                    <span>场外相关角色卡最大字符</span>
                    <input id="airp-setting-related-card-limit" type="number" min="300" max="5000" step="100" value="${escapeAttribute(settings.maxRelatedCardChars ?? 1200)}">
                </label>
            </section>

            <section class="airp-v7-settings-card airp-glass"><div class="airp-card-heading"><span>社交世界</span></div>
                <label class="airp-world-field"><span>允许模型生成日常朋友圈与论坛</span><input id="airp-setting-social-generation" type="checkbox" ${settings.socialGenerationEnabled !== false ? "checked" : ""}></label>
                <label class="airp-world-field"><span>每轮最多新增社交内容</span><input id="airp-setting-social-limit" type="number" min="1" max="5" value="${escapeAttribute(settings.maxSocialPerTurn ?? 3)}"></label>
            </section>
            <section class="airp-v7-settings-card airp-v11-safety-card airp-glass">
                <div class="airp-card-heading"><span>存档与恢复</span></div>
                <p class="airp-v11-safety-help">不会重置世界。这里仅提供导出、导入和最近一次自动状态更新的撤销保护。</p>
                <div class="airp-v11-safety-grid">
                    <button type="button" data-airp-action="retry-airp-save"><i class="fa-solid fa-rotate"></i><span>重试保存</span></button>
                    <button type="button" data-airp-action="export-airp-world"><i class="fa-solid fa-file-export"></i><span>导出当前世界</span></button>
                    <button type="button" data-airp-action="import-airp-world"><i class="fa-solid fa-file-import"></i><span>导入世界 JSON</span></button>
                    <button type="button" data-airp-action="undo-last-auto-update" ${state.safety?.lastAutoUpdate && !state.safety.lastAutoUpdate.isUndone ? "" : "disabled"}><i class="fa-solid fa-rotate-left"></i><span>撤销最近状态</span></button>
                    <button type="button" data-airp-action="redo-last-auto-update" ${state.safety?.lastAutoUpdate?.isUndone ? "" : "disabled"}><i class="fa-solid fa-rotate-right"></i><span>重新应用状态</span></button>
                    <button type="button" data-airp-action="check-airp-world"><i class="fa-solid fa-stethoscope"></i><span>检查数据</span></button>
                </div>
                ${state.safety?.lastAutoUpdate ? `
                    <div class="airp-v11-safety-status">
                        <span>最近自动状态</span>
                        <strong>${state.safety.lastAutoUpdate.isUndone ? "已撤销" : "已应用"}</strong>
                        <small>消息 #${escapeHtml(state.safety.lastAutoUpdate.messageId ?? "—")} · ${escapeHtml(state.safety.lastAutoUpdate.createdAt ?? "")}</small>
                    </div>
                ` : `<div class="airp-v11-safety-status"><span>最近自动状态</span><strong>暂无</strong></div>`}
                ${state.safety?.lastIntegrityReport ? `
                    <div class="airp-v11-safety-status ${state.safety.lastIntegrityReport.issueCount ? "has-issues" : "is-ok"}">
                        <span>数据检查</span>
                        <strong>${state.safety.lastIntegrityReport.issueCount ? `${state.safety.lastIntegrityReport.issueCount} 个问题` : "未发现异常"}</strong>
                        ${state.safety.lastIntegrityReport.issues?.length ? `<small>${escapeHtml(state.safety.lastIntegrityReport.issues.slice(0, 3).join("；"))}</small>` : ""}
                    </div>
                ` : ""}
            </section>

            <section class="airp-v7-runtime airp-glass">
                <div class="airp-card-heading"><span>最近一次状态处理</span></div>
                <div><span>状态</span><strong>${escapeHtml(runtime.lastTrackerStatus ?? "idle")}</strong></div>
                <div><span>保存</span><strong>${escapeHtml({submitted:"已提交酒馆保存",pending:"待保存",failed:"保存失败"}[runtime.saveStatus] || "尚未提交")}</strong></div>
                ${runtime.saveError ? `<p>${escapeHtml(runtime.saveError)}</p>` : ""}
                <div><span>消息</span><strong>${escapeHtml(runtime.lastProcessedMessageId ?? "—")}</strong></div>
                ${runtime.lastTrackerError ? `<p>${escapeHtml(runtime.lastTrackerError)}</p>` : `<p>暂时没有记录到解析错误。</p>`}
            </section>

            <button type="button" class="airp-world-save" data-airp-action="save-settings">保存设置</button>
        </div>
    `;
}

async function saveSettingsFromUI() {
    const state = await ensureState();
    if (!state) return;

    state.settings.socialGenerationEnabled = Boolean(document.getElementById("airp-setting-social-generation")?.checked);
    state.settings.maxSocialPerTurn = Math.min(5, Math.max(1, Number(document.getElementById("airp-setting-social-limit")?.value) || 3));
    state.settings.interfaceMode = document.getElementById("airp-setting-player-mode")?.checked
        ? "player"
        : "developer";
    state.settings.stateTrackerEnabled = Boolean(document.getElementById("airp-setting-tracker-enabled")?.checked);
    state.settings.contextInjectionEnabled = Boolean(document.getElementById("airp-setting-context-enabled")?.checked);
    state.settings.themeEnabled = Boolean(document.getElementById("airp-setting-theme-enabled")?.checked);
    state.settings.responsivePhone = Boolean(document.getElementById("airp-setting-responsive-phone")?.checked);
    state.settings.compactMessageControls = Boolean(document.getElementById("airp-setting-compact-controls")?.checked);
    state.settings.openingComponentsEnabled = Boolean(document.getElementById("airp-setting-opening-components")?.checked);
    state.settings.socialNotificationsEnabled = Boolean(document.getElementById("airp-setting-social-notifications")?.checked);
    state.settings.worldPackEnabled = Boolean(document.getElementById("airp-setting-worldpack-enabled")?.checked);
    state.settings.externalPromptsEnabled = Boolean(document.getElementById("airp-setting-external-prompts-enabled")?.checked);
    state.settings.maxWorldDocChars = Math.min(20000, Math.max(1000, Number(document.getElementById("airp-setting-world-doc-limit")?.value) || 12000));
    state.settings.maxPlayerDocChars = Math.min(10000, Math.max(500, Number(document.getElementById("airp-setting-player-doc-limit")?.value) || 3200));
    state.settings.maxStyleDocChars = Math.min(8000, Math.max(500, Number(document.getElementById("airp-setting-style-doc-limit")?.value) || 8000));
    state.settings.recentEventLimit = Math.min(20, Math.max(1, Number(document.getElementById("airp-setting-event-limit")?.value) || 6));
    state.settings.maxPresentCardChars = Math.min(12000, Math.max(1000, Number(document.getElementById("airp-setting-present-card-limit")?.value) || 4200));
    state.settings.maxPersonaChars = Math.min(6000, Math.max(300, Number(document.getElementById("airp-setting-persona-limit")?.value) || 2400));
    state.settings.maxRelatedCardChars = Math.min(5000, Math.max(300, Number(document.getElementById("airp-setting-related-card-limit")?.value) || 1200));

    await saveState(state);
    applyAirpInterfaceState(state);
    requestAnimationFrame(decorateAllOpeningMessages);
    await refreshAirpStatePrompt();
    await goBack();
}

function renderPresentCharacter(character, checked) {
    const typeLabel = character.type === "main" ? "攻略角色" : "NPC";

    return `
        <label class="airp-present-character airp-glass">
            ${renderAvatar(character, "airp-present-avatar")}

            <div class="airp-present-main">
                <strong>${escapeHtml(character.display.name)}</strong>
                <span>${escapeHtml(typeLabel)}</span>
            </div>

            <input type="checkbox" name="airp-present-character"
                value="${escapeAttribute(character.id)}" ${checked ? "checked" : ""}>
            <span class="airp-present-toggle"></span>
        </label>
    `;
}

async function saveWorldStateFromUI() {
    const state = await ensureState();
    if (!state) return;

    state.world.datetime = document.getElementById("airp-world-datetime-input")?.value?.trim() ?? "";
    state.world.location = document.getElementById("airp-world-location-input")?.value?.trim() ?? "";
    state.world.sceneSummary = document.getElementById("airp-world-scene-input")?.value?.trim() ?? "";

    state.world.presentCharacterIds = [
        ...document.querySelectorAll('input[name="airp-present-character"]:checked'),
    ].map(input => input.value);

    state.safety.manualWorld = deepCloneAirp(state.world);
    state.safety.manualWorldVersion = createId("manual-world");
    await saveState(state);
    await refreshAirpStatePrompt();
    await goBack();
}

/* =========================================================
   事件记录 UI
   ========================================================= */

function renderEvents(state) {
    const events = [...state.events].reverse();

    return `
        <div class="airp-page">
            <div class="airp-list-toolbar">
                <div>
                    <div class="airp-section-heading airp-heading-no-pad">世界事件</div>
                    <div class="airp-character-count">世界真相、传播渠道与角色知情彼此分开</div>
                </div>

                <button type="button" class="airp-add-character-button" data-airp-action="open-event-create" title="记录事件">
                    <i class="fa-solid fa-plus"></i>
                </button>
            </div>

            <div class="airp-event-list">
                ${events.length
                    ? events.map(event => renderEventCard(state, event)).join("")
                    : renderEmpty("还没有事件。先记录一件剧情里已经发生的事。")}
            </div>
        </div>
    `;
}

function renderEventCard(state, event) {
    const participantNames = getEventParticipantNames(state, event.participants);
    const knownCount = getKnownCharacterIdsForEvent(state, event.id).length;
    const pendingCount = getPendingExposureCountForEvent(state, event.id);

    return `
        <button type="button" class="airp-event-card airp-glass"
            data-airp-action="open-event-detail" data-event-id="${escapeAttribute(event.id)}">

            <div class="airp-event-card-top">
                <div class="airp-event-time">${escapeHtml(event.time || "未标时间")}</div>
                <div class="airp-event-chips">
                    ${renderChip(VISIBILITY_LABELS[event.visibility] || event.visibility)}
                    ${renderChip(CHANNEL_LABELS[event.channel] || event.channel)}
                </div>
            </div>

            <div class="airp-event-summary">${escapeHtml(event.summary || "未填写事件摘要")}</div>

            <div class="airp-event-meta">
                <span>${participantNames.length ? `涉及 ${escapeHtml(participantNames.join("、"))}` : "未标参与者"}</span>
                <span>知情 ${knownCount} 人${pendingCount ? ` · 待传播 ${pendingCount}` : ""}</span>
            </div>
        </button>
    `;
}

function renderEventCreate(state) {
    const characters = getWorldCharacters(state);

    return `
        <div class="airp-page">
            <section class="airp-world-form airp-glass">
                <label class="airp-world-field">
                    <span>时间</span>
                    <input id="airp-event-time-input" type="text"
                        value="${escapeAttribute(state.world.datetime || "")}"
                        placeholder="例如：2026-09-03 20:17">
                </label>

                <label class="airp-world-field">
                    <span>发生了什么</span>
                    <textarea id="airp-event-summary-input" rows="4"
                        placeholder="尽量写事实本身，不要把所有角色的理解混进来。"></textarea>
                </label>

                <div class="airp-two-column-fields">
                    <label class="airp-world-field">
                        <span>公开度</span>
                        <select id="airp-event-visibility-select">
                            ${Object.entries(VISIBILITY_LABELS)
                                .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
                                .join("")}
                        </select>
                    </label>

                    <label class="airp-world-field">
                        <span>渠道</span>
                        <select id="airp-event-channel-select">
                            ${Object.entries(CHANNEL_LABELS)
                                .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
                                .join("")}
                        </select>
                    </label>
                </div>

                <label class="airp-world-field">
                    <span>来源事件（可选）</span>
                    <select id="airp-event-source-select">
                        <option value="">无</option>
                        ${[...state.events].reverse().map(event => `
                            <option value="${escapeAttribute(event.id)}">
                                ${escapeHtml(`${event.time || ""} ${event.summary}`.trim())}
                            </option>
                        `).join("")}
                    </select>
                </label>

                <label class="airp-world-field">
                    <span>标签（可选，逗号分隔）</span>
                    <input id="airp-event-tags-input" type="text" placeholder="例如：晚宴, 偷拍, 修罗场">
                </label>
            </section>

            <div class="airp-section-heading airp-section-gap-small">参与者</div>
            <div class="airp-event-person-grid">
                ${renderEventPersonOption("participant", "player", "你", "", true)}
                ${characters.map(character => renderEventPersonOption(
                    "participant",
                    character.id,
                    character.display.name,
                    character.display.avatarUrl,
                    (state.world.presentCharacterIds ?? []).includes(character.id),
                )).join("")}
            </div>

            <div class="airp-section-heading airp-section-gap-small">目击者</div>
            <div class="airp-event-person-grid">
                ${characters.map(character => renderEventPersonOption(
                    "witness",
                    character.id,
                    character.display.name,
                    character.display.avatarUrl,
                    false,
                )).join("")}
            </div>

            <div class="airp-section-heading airp-section-gap-small">传播对象（可选）</div>
            <div class="airp-event-audience-note">
                私聊 / 群聊 / 口耳相传请勾具体对象；论坛或公开事件留空时，当前世界活跃角色进入传播候选，朋友圈只对好友形成候选。模型会在后续回复判断谁实际看到。
            </div>
            <div class="airp-event-person-grid">
                ${characters.map(character => renderEventPersonOption(
                    "audience",
                    character.id,
                    character.display.name,
                    character.display.avatarUrl,
                    false,
                )).join("")}
            </div>

            <button type="button" class="airp-world-save" data-airp-action="save-event">
                记录事件
            </button>
        </div>
    `;
}

function renderEventPersonOption(groupName, characterId, name, avatarUrl, checked) {
    const avatar = avatarUrl
        ? `<div class="airp-event-person-avatar"><img src="${escapeAttribute(avatarUrl)}" alt=""></div>`
        : `<div class="airp-event-person-avatar airp-avatar-fallback">${escapeHtml(getInitial(name))}</div>`;

    return `
        <label class="airp-event-person airp-glass">
            ${avatar}
            <span>${escapeHtml(name)}</span>
            <input type="checkbox" name="airp-event-${groupName}" value="${escapeAttribute(characterId)}" ${checked ? "checked" : ""}>
            <i class="fa-solid fa-check airp-event-person-check"></i>
        </label>
    `;
}

async function saveEventFromUI() {
    const state = await ensureState();
    if (!state) return;

    const summary = document.getElementById("airp-event-summary-input")?.value?.trim() ?? "";
    if (!summary) {
        alert("先写一下发生了什么。完事以后我们再把这个小提示换成更漂亮的 toast 😂");
        return;
    }

    const participants = [...document.querySelectorAll('input[name="airp-event-participant"]:checked')]
        .map(input => input.value);

    const witnesses = [...document.querySelectorAll('input[name="airp-event-witness"]:checked')]
        .map(input => input.value);

    const audienceCharacterIds = [...document.querySelectorAll('input[name="airp-event-audience"]:checked')]
        .map(input => input.value);

    const event = addEventToState(state, {
        time: document.getElementById("airp-event-time-input")?.value?.trim() ?? "",
        summary,
        participants,
        witnesses,
        audienceCharacterIds,
        visibility: document.getElementById("airp-event-visibility-select")?.value ?? "private",
        channel: document.getElementById("airp-event-channel-select")?.value ?? "scene",
        sourceEventId: document.getElementById("airp-event-source-select")?.value || null,
        tags: splitCommaText(document.getElementById("airp-event-tags-input")?.value ?? ""),
    });

    await saveState(state);

    await navigateToEvent(event.id, false);
}

function renderEventDetail(state, eventId) {
    const event = getEventById(state, eventId);
    if (!event) return renderEmpty("这个事件不存在。")

    const characters = getWorldCharacters(state);
    const forcedKnowerIds = new Set([
        ...event.participants.filter(id => id !== "player"),
        ...event.witnesses.filter(id => id !== "player"),
    ]);

    const sourceEvent = event.sourceEventId ? getEventById(state, event.sourceEventId) : null;

    return `
        <div class="airp-page">
            <section class="airp-event-detail airp-glass">
                <div class="airp-event-detail-time">${escapeHtml(event.time || "未标时间")}</div>
                <h2>${escapeHtml(event.summary || "未填写摘要")}</h2>

                <div class="airp-event-chips airp-event-detail-chips">
                    ${renderChip(VISIBILITY_LABELS[event.visibility] || event.visibility)}
                    ${renderChip(CHANNEL_LABELS[event.channel] || event.channel)}
                    ${event.tags.map(tag => renderChip(tag, "airp-mini-chip-muted")).join("")}
                </div>

                ${event.participants.length ? `
                    <div class="airp-event-detail-row">
                        <span>参与</span>
                        <strong>${escapeHtml(getEventParticipantNames(state, event.participants).join("、"))}</strong>
                    </div>
                ` : ""}

                ${event.witnesses.length ? `
                    <div class="airp-event-detail-row">
                        <span>目击</span>
                        <strong>${escapeHtml(getEventParticipantNames(state, event.witnesses).join("、"))}</strong>
                    </div>
                ` : ""}

                ${event.audienceCharacterIds.length ? `
                    <div class="airp-event-detail-row">
                        <span>传播对象</span>
                        <strong>${escapeHtml(getEventParticipantNames(state, event.audienceCharacterIds).join("、"))}</strong>
                    </div>
                ` : ""}

                ${getPendingExposureCountForEvent(state, event.id) ? `
                    <div class="airp-event-source-box airp-propagation-summary-box">
                        <span>传播中</span>
                        <p>${getPendingExposureCountForEvent(state, event.id)} 个角色有机会看到，正在等待模型判断阅读时机；后续回复会继续处理，无需逐条手动确认。</p>
                    </div>
                ` : ""}

                ${sourceEvent ? `
                    <div class="airp-event-source-box">
                        <span>来源事件</span>
                        <button type="button" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(sourceEvent.id)}">${escapeHtml(sourceEvent.summary)}</button>
                    </div>
                ` : ""}
            </section>

            ${renderEventTrace(state, event)}

            <div class="airp-section-heading airp-section-gap-small">谁已经知道</div>
            <div class="airp-knowledge-list">
                ${characters.length
                    ? characters.map(character => renderKnowledgeCharacter(
                        state,
                        event,
                        character,
                        forcedKnowerIds.has(character.id),
                    )).join("")
                    : renderEmpty("当前世界里还没有角色")}
            </div>

            <div class="airp-knowledge-note">
                参与者和目击者默认必然知情；其他人的知情状态以后会由论坛、朋友圈、私聊等传播自动更新。
            </div>

            <button type="button" class="airp-world-save" data-airp-action="save-event-knowledge" data-event-id="${escapeAttribute(event.id)}">
                保存知情状态
            </button>
        </div>
    `;
}

function renderEventTrace(state, event) {
    const children = state.events.filter(item => item.sourceEventId === event.id);
    const exposures = (state.exposureHistory ?? []).filter(item => item.eventId === event.id);
    const reactions = state.reactions.filter(item => item.eventId === event.id);
    const actions = state.actions.filter(item => item.eventId === event.id || item.executedEventId === event.id);
    return `<details class="airp-trace airp-glass" open><summary>传播与反应记录</summary>
        ${children.length ? `<div class="airp-trace-label">由此衍生的事件</div>${children.map(item => `<button type="button" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(item.id)}">${escapeHtml(item.time)} · ${escapeHtml(item.summary)}</button>`).join("")}` : ""}
        ${exposures.map(item => `<p>${escapeHtml(getCharacterName(state, item.characterId))} · ${escapeHtml(CHANNEL_LABELS[item.channel] || item.channel)} · ${item.outcome === "seen" ? "看到了" : "没有看到"} · ${escapeHtml(item.resolvedAt)}${item.interpretation ? `<br>${escapeHtml(item.interpretation)}` : ""}</p>`).join("")}
        ${Object.values(state.characters).filter(character => character.knowledge?.[event.id]).map(character => `<p>${escapeHtml(getCharacterName(state, character.id))}的理解：${escapeHtml(character.knowledge[event.id].interpretation || event.summary)}</p>`).join("")}
        ${reactions.map(item => `<button type="button" data-airp-action="open-reaction-detail" data-reaction-id="${escapeAttribute(item.id)}">${escapeHtml(getCharacterName(state, item.characterId))} · ${escapeHtml(REACTION_STATUS_LABELS[item.status])}<br>${escapeHtml(item.summary || "尚未决定如何反应")}<br>${escapeHtml(Object.entries(item.relationChanges ?? {}).map(([key, value]) => `${key} ${value > 0 ? "+" : ""}${value}`).join(" / "))}</button>`).join("")}
        ${actions.map(item => `<div class="airp-trace-action"><p>${escapeHtml(getCharacterName(state, item.actorId))} · ${escapeHtml(ACTION_LABELS[item.type])} · ${item.status === "done" ? "已完成" : item.status === "cancelled" ? "已取消" : "等待执行"}<br>${escapeHtml(item.note || item.lastError || "")}</p>${item.executedEventId && item.executedEventId !== event.id ? `<button type="button" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(item.executedEventId)}">查看后续事件</button>` : ""}${item.executedArtifactId ? `<button type="button" data-airp-action="open-artifact" data-source-type="${escapeAttribute(item.type)}" data-source-id="${escapeAttribute(item.executedArtifactId)}">查看实际内容</button>` : ""}</div>`).join("")}
        ${!children.length && !exposures.length && !reactions.length && !actions.length ? "<p>目前没有后续传播或反应。</p>" : ""}
    </details>`;
}

function renderKnowledgeCharacter(state, event, character, forced) {
    const knowledge = character.knowledge?.[event.id];
    const exposure = getPendingExposure(state, event.id, character.id);
    const known = forced || Boolean(knowledge);
    const certainty = knowledge?.certainty ?? (event.visibility === "rumor" ? 0.55 : 1);
    const statusText = forced
        ? "当事 / 目击 · 必然知情"
        : known
            ? `已知 · 可信度 ${Math.round(certainty * 100)}%`
            : exposure
                ? "传播中 · 可能看到"
                : "尚未知情";

    return `
        <label class="airp-knowledge-character airp-glass ${forced ? "airp-knowledge-forced" : ""}">
            ${renderAvatar(character, "airp-present-avatar")}

            <div class="airp-knowledge-main">
                <strong>${escapeHtml(character.display.name)}</strong>
                <span>${statusText}</span>
            </div>

            <input type="checkbox" name="airp-event-knower" value="${escapeAttribute(character.id)}"
                ${known ? "checked" : ""} ${forced ? "disabled" : ""}>
            <span class="airp-present-toggle"></span>
        </label>
    `;
}

async function saveEventKnowledgeFromUI(eventId) {
    const state = await ensureState();
    if (!state) return;

    const event = getEventById(state, eventId);
    if (!event) return;

    const activeCharacters = getWorldCharacters(state);
    const forced = new Set([
        ...event.participants.filter(id => id !== "player"),
        ...event.witnesses.filter(id => id !== "player"),
    ]);

    const checked = new Set([
        ...document.querySelectorAll('input[name="airp-event-knower"]:checked'),
    ].map(input => input.value));

    for (const character of activeCharacters) {
        if (forced.has(character.id) || checked.has(character.id)) {
            setCharacterKnowledge(state, character.id, eventId, {
                source: character.knowledge?.[eventId]?.source ?? event.channel,
                certainty: character.knowledge?.[eventId]?.certainty ?? getKnowledgeDefaultCertainty(event),
                learnedAt: character.knowledge?.[eventId]?.learnedAt ?? state.world.datetime ?? event.time,
            });
        } else {
            removeCharacterKnowledge(state, character.id, eventId);
        }
    }

    seedEventKnowledge(state, event);
    await saveState(state);
    await renderCurrentView();
}

/* =========================================================
   信息传播中心 UI
   ========================================================= */

function renderPropagationCenter(state) {
    const exposures = [...(state.pendingExposures ?? [])];

    return `
        <div class="airp-page">
            <div class="airp-section-heading airp-heading-no-pad">待传播信息</div>
            <div class="airp-character-count airp-relation-page-note">
                模型会在回复中根据人物习惯和剧情判断谁看到了，并处理对应反应。“可能看到”不等于“已经知道”；这里也可以手动调整。
            </div>

            <div class="airp-propagation-list">
                ${exposures.length
                    ? exposures.map(exposure => renderPropagationItem(state, exposure)).join("")
                    : renderEmpty("目前没有待确认的传播。公开信息已经处理完，或者还没有新的传播事件。")}
            </div>
        </div>
    `;
}

function renderPropagationItem(state, exposure) {
    const event = getEventById(state, exposure.eventId);
    const character = resolveCharacter(state.characters[exposure.characterId]);

    if (!event || !character) return "";

    return `
        <section class="airp-propagation-card airp-glass">
            <div class="airp-propagation-head">
                ${renderAvatar(character, "airp-present-avatar")}
                <div class="airp-propagation-person">
                    <strong>${escapeHtml(character.display.name)}</strong>
                    <span>可能通过 ${escapeHtml(CHANNEL_LABELS[exposure.channel] || exposure.channel)} 获知</span>
                </div>
                ${renderChip(VISIBILITY_LABELS[event.visibility] || event.visibility)}
            </div>

            <button type="button" class="airp-propagation-event"
                data-airp-action="open-event-detail" data-event-id="${escapeAttribute(event.id)}">
                <span>${escapeHtml(event.time || "未标时间")}</span>
                <p>${escapeHtml(event.summary)}</p>
            </button>

            ${exposure.reason ? `<div class="airp-propagation-reason">${escapeHtml(exposure.reason)}</div>` : ""}
            ${exposure.deferReason ? `<div class="airp-propagation-reason">暂缓原因：${escapeHtml(exposure.deferReason)}</div>` : ""}

            <div class="airp-propagation-actions">
                <button type="button" class="airp-propagation-skip"
                    data-airp-action="dismiss-exposure" data-exposure-id="${escapeAttribute(exposure.id)}">
                    这次没看到
                </button>

                <button type="button" class="airp-propagation-confirm"
                    data-airp-action="confirm-exposure" data-exposure-id="${escapeAttribute(exposure.id)}">
                    确认获知
                </button>
            </div>
        </section>
    `;
}

async function confirmExposure(exposureId) {
    const state = await ensureState();
    if (!state) return;

    const exposure = getPendingExposureById(state, exposureId);
    if (!exposure) return;

    const event = getEventById(state, exposure.eventId);
    if (!event) return;

    finishExposure(state, exposure, "seen");
    setCharacterKnowledge(state, exposure.characterId, exposure.eventId, {
        source: exposure.channel,
        certainty: exposure.certainty,
        learnedAt: state.world.datetime || event.time || "",
    });

    await saveState(state);
    await renderCurrentView();
}

async function dismissExposure(exposureId) {
    const state = await ensureState();
    if (!state) return;

    const exposure = getPendingExposureById(state, exposureId);
    if (exposure) finishExposure(state, exposure, "missed");

    await saveState(state);
    await renderCurrentView();
}

/* =========================================================
   角色反应 / 行动队列 UI
   ========================================================= */

function renderReactionCenter(state) {
    const pendingReactions = (state.reactions ?? [])
        .filter(reaction => reaction.status === "pending")
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const pendingActions = (state.actions ?? [])
        .filter(action => action.status === "pending")
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const handledCount = (state.reactions ?? [])
        .filter(reaction => reaction.status !== "pending")
        .length;

    return `
        <div class="airp-page">
            <section class="airp-reaction-summary airp-glass">
                <div>
                    <strong>${pendingReactions.length}</strong>
                    <span>待反应</span>
                </div>
                <div>
                    <strong>${pendingActions.length}</strong>
                    <span>待行动</span>
                </div>
                <div>
                    <strong>${handledCount}</strong>
                    <span>已归档</span>
                </div>
            </section>

            <div class="airp-reaction-note">
                模型会判断内部反应与后续行动；没有明显反应也会记录。“知道了”不等于“立刻做事”，延迟行动会保留意图。
            </div>

            <div class="airp-section-heading airp-section-gap-small">待处理反应</div>
            <div class="airp-reaction-list">
                ${pendingReactions.length
                    ? pendingReactions.map(reaction => renderReactionQueueItem(state, reaction)).join("")
                    : renderEmpty("目前没有角色需要处理新的知情反应")}
            </div>

            <div class="airp-section-heading airp-section-gap">待执行行动</div>
            <div class="airp-action-list">
                ${pendingActions.length
                    ? pendingActions.map(action => renderActionQueueItem(state, action)).join("")
                    : renderEmpty("目前没有待执行行动")}
            </div>
            <details class="airp-trace airp-glass"><summary>历史反应与行动</summary>
                ${[...state.reactions].reverse().filter(item => item.status !== "pending").map(item => `<button type="button" data-airp-action="open-reaction-detail" data-reaction-id="${escapeAttribute(item.id)}">${escapeHtml(getCharacterName(state, item.characterId))} · ${escapeHtml(REACTION_STATUS_LABELS[item.status])}<br>${escapeHtml(item.summary || "未采取明显反应")}</button>`).join("") || "<p>暂无历史反应。</p>"}
                ${[...state.actions].reverse().filter(item => item.status !== "pending").map(item => `<button type="button" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(item.executedEventId || item.eventId || "")}">${escapeHtml(getCharacterName(state, item.actorId))} · ${escapeHtml(ACTION_LABELS[item.type])} · ${item.status === "done" ? "已完成" : "已取消"}</button>`).join("")}
            </details>
        </div>
    `;
}

function renderReactionQueueItem(state, reaction) {
    const character = resolveCharacter(state.characters[reaction.characterId]);
    const event = getEventById(state, reaction.eventId);
    if (!character || !event) return "";

    const knowledge = state.characters[reaction.characterId]?.knowledge?.[reaction.eventId];
    const source = knowledge?.source ?? reaction.source ?? event.channel;

    return `
        <section class="airp-reaction-card airp-glass">
            <div class="airp-reaction-head">
                ${renderAvatar(character, "airp-present-avatar")}
                <div class="airp-reaction-person">
                    <strong>${escapeHtml(character.display.name)}</strong>
                    <span>刚通过 ${escapeHtml(CHANNEL_LABELS[source] || source || "未知渠道")} 获知</span>
                </div>
                ${renderChip("待反应", "airp-reaction-chip")}
            </div>

            <button type="button" class="airp-reaction-event"
                data-airp-action="open-event-detail" data-event-id="${escapeAttribute(event.id)}">
                <span>${escapeHtml(event.time || "未标时间")}</span>
                <p>${escapeHtml(event.summary)}</p>
            </button>

            ${character.type === "main" ? `
                <div class="airp-reaction-current">
                    嫉妒 ${clamp(character.relation?.jealousy ?? 0)} ·
                    占有欲 ${clamp(character.relation?.possessiveness ?? 0)} ·
                    信任 ${clamp(character.relation?.trust ?? 0)}
                </div>
            ` : ""}

            <div class="airp-reaction-actions">
                <button type="button" class="airp-reaction-ignore"
                    data-airp-action="ignore-reaction" data-reaction-id="${escapeAttribute(reaction.id)}">
                    无明显反应
                </button>

                <button type="button" class="airp-reaction-process"
                    data-airp-action="open-reaction-detail" data-reaction-id="${escapeAttribute(reaction.id)}">
                    处理反应
                </button>
            </div>
        </section>
    `;
}

function renderReactionDetail(state, reactionId) {
    const reaction = getReactionById(state, reactionId);
    if (!reaction) return renderEmpty("找不到这条反应记录");

    const character = resolveCharacter(state.characters[reaction.characterId]);
    const event = getEventById(state, reaction.eventId);

    if (!character || !event) return renderEmpty("反应关联的角色或事件不存在");

    if (reaction.status !== "pending") {
        return `
            <div class="airp-page">
                <section class="airp-reaction-archive airp-glass">
                    <strong>${escapeHtml(character.display.name)}</strong>
                    <span>${escapeHtml(REACTION_STATUS_LABELS[reaction.status] || reaction.status)}</span>
                    <p>${escapeHtml(reaction.summary || "这条反应已经处理。")}</p>
                </section>
            </div>
        `;
    }

    const activeCharacters = getWorldCharacters(state)
        .filter(item => item.id !== character.id);

    return `
        <div class="airp-page airp-reaction-detail-page">
            <section class="airp-reaction-context airp-glass">
                <div class="airp-reaction-head">
                    ${renderAvatar(character, "airp-present-avatar")}
                    <div class="airp-reaction-person">
                        <strong>${escapeHtml(character.display.name)}</strong>
                        <span>${escapeHtml(character.relationLabel || "当前反应待定")}</span>
                    </div>
                </div>

                <div class="airp-reaction-source-event">
                    <span>${escapeHtml(event.time || "未标时间")}</span>
                    <p>${escapeHtml(event.summary)}</p>
                </div>
            </section>

            ${character.type === "main"
                ? renderMainReactionEditor(character)
                : renderNpcReactionEditor(character)}

            <section class="airp-world-form airp-glass airp-reaction-form-block">
                <label class="airp-world-field">
                    <span>角色内部反应摘要</span>
                    <textarea id="airp-reaction-summary-input" rows="3"
                        placeholder="例如：表面没有表现出来，但明显介意这件事。"></textarea>
                </label>

                ${character.type === "main" ? `
                    <label class="airp-world-field">
                        <span>新的关系标签（可留空）</span>
                        <input id="airp-reaction-label-input" type="text"
                            placeholder="当前：${escapeAttribute(character.relationLabel || "尚未建立关系")}">
                    </label>
                ` : ""}
            </section>

            <div class="airp-section-heading airp-section-gap-small">后续行动</div>

            <section class="airp-world-form airp-glass airp-reaction-form-block">
                <label class="airp-world-field">
                    <span>行动类型</span>
                    <select id="airp-reaction-action-type">
                        ${Object.entries(ACTION_LABELS).map(([value, label]) => `
                            <option value="${escapeAttribute(value)}">${escapeHtml(label)}</option>
                        `).join("")}
                    </select>
                </label>

                <label class="airp-world-field">
                    <span>行动对象</span>
                    <select id="airp-reaction-action-target">
                        <option value="player">你</option>
                        ${activeCharacters.map(item => `
                            <option value="${escapeAttribute(item.id)}">${escapeHtml(item.display.name)}</option>
                        `).join("")}
                    </select>
                </label>

                <label class="airp-world-field">
                    <span>发生时机</span>
                    <select id="airp-reaction-action-timing">
                        ${Object.entries(ACTION_TIMING_LABELS).map(([value, label]) => `
                            <option value="${escapeAttribute(value)}">${escapeHtml(label)}</option>
                        `).join("")}
                    </select>
                </label>

                <label class="airp-world-field">
                    <span>行动意图 / 备注</span>
                    <textarea id="airp-reaction-action-note" rows="3"
                        placeholder="不是成品文案。例如：语气很平静地问你什么时候回去。"></textarea>
                </label>
            </section>

            <div class="airp-reaction-save-row">
                <button type="button" class="airp-reaction-ignore"
                    data-airp-action="ignore-reaction" data-reaction-id="${escapeAttribute(reaction.id)}">
                    无明显反应
                </button>

                <button type="button" class="airp-world-save airp-reaction-save"
                    data-airp-action="save-reaction" data-reaction-id="${escapeAttribute(reaction.id)}">
                    保存反应
                </button>
            </div>
        </div>
    `;
}

function renderMainReactionEditor(character) {
    const items = [
        ["吸引", "attraction"],
        ["信任", "trust"],
        ["尊重", "respect"],
        ["敌意", "hostility"],
        ["占有欲", "possessiveness"],
        ["依赖", "dependence"],
        ["嫉妒", "jealousy"],
    ];

    return `
        <section class="airp-reaction-deltas airp-glass">
            <div class="airp-card-heading"><span>对你的关系变化</span></div>
            <div class="airp-reaction-delta-note">
                填“变化量”而不是最终值。普通事件建议 ±1～4，显著事件 ±5～10，超过 10 只留给重大转折。
            </div>

            <div class="airp-reaction-delta-list">
                ${items.map(([label, key]) => `
                    <label class="airp-reaction-delta-row">
                        <span>${escapeHtml(label)}</span>
                        <b>${clamp(character.relation?.[key] ?? 0)}</b>
                        <input type="number" min="-30" max="30" step="1" value="0"
                            data-airp-reaction-delta="${escapeAttribute(key)}">
                    </label>
                `).join("")}
            </div>
        </section>
    `;
}

function renderNpcReactionEditor(character) {
    return `
        <section class="airp-world-form airp-glass airp-reaction-form-block">
            <label class="airp-world-field">
                <span>NPC 态度变化</span>
                <input id="airp-reaction-npc-attitude" type="number" min="-30" max="30" step="1" value="0"
                    placeholder="当前 ${clampSigned(character.attitude ?? 0)}">
            </label>

            <label class="airp-world-field">
                <span>新的印象（可留空）</span>
                <textarea id="airp-reaction-npc-impression" rows="3"
                    placeholder="当前：${escapeAttribute(character.impression || "暂无明显印象")}"></textarea>
            </label>
        </section>
    `;
}

async function saveReactionFromUI(reactionId) {
    const state = await ensureState();
    if (!state) return;

    const reaction = getReactionById(state, reactionId);
    if (!reaction || reaction.status !== "pending") return;

    const character = state.characters[reaction.characterId];
    if (!character) return;

    const relationChanges = {};

    if (character.type === "main") {
        for (const input of document.querySelectorAll("[data-airp-reaction-delta]")) {
            const key = input.dataset.airpReactionDelta;
            const value = Number(input.value ?? 0);
            if (key && Number.isFinite(value) && value !== 0) {
                relationChanges[key] = value;
            }
        }
    }

    const resolution = {
        summary: document.getElementById("airp-reaction-summary-input")?.value?.trim() ?? "",
        relationChanges,
        relationLabel: document.getElementById("airp-reaction-label-input")?.value?.trim() ?? "",
        npcAttitudeDelta: Number(document.getElementById("airp-reaction-npc-attitude")?.value ?? 0),
        npcImpression: document.getElementById("airp-reaction-npc-impression")?.value?.trim() ?? "",
        action: {
            type: document.getElementById("airp-reaction-action-type")?.value ?? "none",
            targetCharacterId: document.getElementById("airp-reaction-action-target")?.value ?? "player",
            timing: document.getElementById("airp-reaction-action-timing")?.value ?? "later",
            note: document.getElementById("airp-reaction-action-note")?.value?.trim() ?? "",
        },
    };

    resolveReactionInState(state, reactionId, resolution);
    await saveState(state);
    await goBack();
}

async function ignoreReaction(reactionId) {
    const state = await ensureState();
    if (!state) return;

    if (!ignoreReactionInState(state, reactionId)) return;

    await saveState(state);

    if (currentView.page === "reaction-detail") {
        await goBack();
    } else {
        await renderCurrentView();
    }
}

function renderActionQueueItem(state, action) {
    const actor = resolveCharacter(state.characters[action.actorId]);
    const event = getEventById(state, action.eventId);
    if (!actor) return "";

    const targetName = action.targetCharacterId === "player"
        ? "你"
        : getCharacterName(state, action.targetCharacterId);

    const social = isSocialAction(action);

    return `
        <section class="airp-action-card airp-glass">
            <div class="airp-action-head">
                ${renderAvatar(actor, "airp-present-avatar")}
                <div>
                    <strong>${escapeHtml(actor.display.name)}</strong>
                    <span>${escapeHtml(ACTION_LABELS[action.type] || action.type)} · ${escapeHtml(ACTION_TIMING_LABELS[action.timing] || action.timing)}</span>
                </div>
            </div>

            <div class="airp-action-target">对象：${escapeHtml(targetName)}</div>
            ${action.note ? `<p>${escapeHtml(action.note)}</p>` : ""}
            ${event ? `<div class="airp-action-source">源于：${escapeHtml(event.summary)}</div>` : ""}

            <div class="airp-action-buttons">
                <button type="button" data-airp-action="cancel-action" data-action-id="${escapeAttribute(action.id)}">
                    取消
                </button>

                ${social ? `
                    <button type="button" class="airp-action-done"
                        data-airp-action="open-action-execute" data-action-id="${escapeAttribute(action.id)}">
                        执行
                    </button>
                ` : `
                    <button type="button" class="airp-action-done"
                        data-airp-action="complete-action" data-action-id="${escapeAttribute(action.id)}">
                        标记已执行
                    </button>
                `}
            </div>
        </section>
    `;
}

function renderActionExecution(state, actionId) {
    const action = getActionById(state, actionId);
    if (!action) return renderEmpty("找不到这条行动");

    const actor = resolveCharacter(state.characters[action.actorId]);
    if (!actor) return renderEmpty("行动角色不存在");

    if (action.status !== "pending") {
        return `
            <div class="airp-page">
                <section class="airp-reaction-archive airp-glass">
                    <strong>${escapeHtml(actor.display.name)}</strong>
                    <span>行动已经处理</span>
                    <p>${escapeHtml(action.note || "这条行动已归档。")}</p>
                </section>
            </div>
        `;
    }

    const targetName = action.targetCharacterId === "player"
        ? "你"
        : getCharacterName(state, action.targetCharacterId);

    const isForum = ["forum", "forum_reply"].includes(action.type);
    const isReactionSocial = ["moment_comment", "moment_like", "forum_reply"].includes(action.type);

    return `
        <div class="airp-page airp-action-execute-page">
            <section class="airp-reaction-context airp-glass">
                <div class="airp-reaction-head">
                    ${renderAvatar(actor, "airp-present-avatar")}
                    <div class="airp-reaction-person">
                        <strong>${escapeHtml(actor.display.name)}</strong>
                        <span>${escapeHtml(ACTION_LABELS[action.type] || action.type)} → ${escapeHtml(targetName)}</span>
                    </div>
                </div>

                ${action.note ? `
                    <div class="airp-action-intent">
                        <span>原始行动意图</span>
                        <p>${escapeHtml(action.note)}</p>
                    </div>
                ` : ""}
            </section>

            <section class="airp-world-form airp-glass airp-reaction-form-block">
                <label class="airp-world-field">
                    <span>发生时间</span>
                    <input id="airp-action-time-input" type="text"
                        value="${escapeAttribute(state.world.datetime || "")}"
                        placeholder="例如：2026-09-03 21:08">
                </label>

                ${isForum ? `
                    <label class="airp-world-field">
                        <span>帖子标题</span>
                        <input id="airp-action-title-input" type="text"
                            placeholder="例如：今晚礼堂有人看见了吗？">
                    </label>

                    <label class="airp-action-anonymous-row">
                        <input id="airp-action-anonymous-input" type="checkbox">
                        <span>匿名发布</span>
                    </label>
                ` : ""}

                <label class="airp-world-field">
                    <span>${action.type === "private_chat" ? "消息内容" : action.type === "moments" ? "朋友圈内容" : "帖子正文"}</span>
                    <textarea id="airp-action-text-input" rows="5"
                        placeholder="开发阶段先手动填写成品内容；接模型后这一步会自动生成。"></textarea>
                </label>
            </section>

            <div class="airp-reaction-save-row">
                <button type="button" class="airp-reaction-ignore"
                    data-airp-action="cancel-action" data-action-id="${escapeAttribute(action.id)}">
                    取消行动
                </button>

                <button type="button" class="airp-world-save airp-reaction-save"
                    data-airp-action="execute-action" data-action-id="${escapeAttribute(action.id)}">
                    确认执行
                </button>
            </div>
        </div>
    `;
}

async function executeActionFromUI(actionId) {
    const state = await ensureState();
    if (!state) return;

    const result = executeActionInState(state, actionId, {
        time: document.getElementById("airp-action-time-input")?.value?.trim() ?? "",
        title: document.getElementById("airp-action-title-input")?.value?.trim() ?? "",
        text: document.getElementById("airp-action-text-input")?.value?.trim() ?? "",
        anonymous: Boolean(document.getElementById("airp-action-anonymous-input")?.checked),
    });

    if (!result) return;

    await saveState(state);
    await goBack();
}

async function updateActionStatus(actionId, status) {
    const state = await ensureState();
    if (!state) return;

    if (!setActionStatusInState(state, actionId, status)) return;

    await saveState(state);
    await renderCurrentView();
}

/* =========================================================
   人物关系图谱 UI
   ========================================================= */

function renderRelations(state) {
    const pairs = getActiveCharacterPairs(state);

    return `
        <div class="airp-page">
            <div class="airp-section-heading airp-heading-no-pad">人物关系</div>
            <div class="airp-character-count airp-relation-page-note">
                这里记录角色彼此怎么看对方；和攻略角色对“你”的七维关系分开。
            </div>

            <div class="airp-pair-list">
                ${pairs.length
                    ? pairs.map(([a, b]) => renderPairCard(state, a, b)).join("")
                    : renderEmpty("至少加入两个角色以后，这里才会出现人物关系。")}
            </div>
        </div>
    `;
}

function renderPairCard(state, a, b) {
    const relationship = getRelationshipSnapshot(state, a, b);
    const nameA = getCharacterName(state, a);
    const nameB = getCharacterName(state, b);
    const attitudeA = relationship.perspectives[a]?.attitude ?? 0;
    const attitudeB = relationship.perspectives[b]?.attitude ?? 0;

    return `
        <button type="button" class="airp-pair-card airp-glass"
            data-airp-action="open-relation-edit" data-relation-key="${escapeAttribute(relationship.id)}">

            <div class="airp-pair-names">
                <strong>${escapeHtml(nameA)}</strong>
                <i class="fa-solid fa-arrow-right-arrow-left"></i>
                <strong>${escapeHtml(nameB)}</strong>
            </div>

            <div class="airp-pair-summary">
                ${escapeHtml(relationship.summary || "尚未设置两人的关系摘要。")}
            </div>

            <div class="airp-pair-attitudes">
                <span>${escapeHtml(nameA)} → ${attitudeA}</span>
                <span>${escapeHtml(nameB)} → ${attitudeB}</span>
            </div>
        </button>
    `;
}

function renderRelationEdit(state, relationKey) {
    const [a, b] = String(relationKey ?? "").split("::");
    if (!a || !b || !state.characters[a] || !state.characters[b]) {
        return renderEmpty("这组人物关系不存在。")
    }

    const relationship = getRelationshipSnapshot(state, a, b);
    const nameA = getCharacterName(state, a);
    const nameB = getCharacterName(state, b);

    return `
        <div class="airp-page">
            <section class="airp-relation-editor airp-glass">
                <div class="airp-relation-editor-title">
                    <strong>${escapeHtml(nameA)}</strong>
                    <i class="fa-solid fa-arrow-right-arrow-left"></i>
                    <strong>${escapeHtml(nameB)}</strong>
                </div>

                <label class="airp-world-field">
                    <span>共同标签</span>
                    <input id="airp-pair-tags-input" type="text"
                        value="${escapeAttribute(relationship.tags.join(", "))}"
                        placeholder="例如：长期竞争, 表面客气, 互相了解">
                </label>

                <label class="airp-world-field">
                    <span>共同关系摘要</span>
                    <textarea id="airp-pair-summary-input" rows="3"
                        placeholder="两人的客观关系背景。">${escapeHtml(relationship.summary)}</textarea>
                </label>
            </section>

            ${renderPerspectiveEditor(
                a,
                nameA,
                nameB,
                relationship.perspectives[a],
                "a",
            )}

            ${renderPerspectiveEditor(
                b,
                nameB,
                nameA,
                relationship.perspectives[b],
                "b",
            )}

            <button type="button" class="airp-world-save"
                data-airp-action="save-relation" data-relation-key="${escapeAttribute(relationship.id)}">
                保存人物关系
            </button>
        </div>
    `;
}

function renderPerspectiveEditor(characterId, fromName, toName, perspective, slot) {
    return `
        <section class="airp-perspective-editor airp-glass">
            <div class="airp-card-heading">
                <span>${escapeHtml(fromName)} → ${escapeHtml(toName)}</span>
            </div>

            <label class="airp-world-field">
                <span>态度 -100 ～ 100</span>
                <input id="airp-pair-${slot}-attitude" type="number" min="-100" max="100" step="1"
                    value="${clampSigned(perspective?.attitude ?? 0)}">
            </label>

            <label class="airp-world-field">
                <span>主观印象</span>
                <textarea id="airp-pair-${slot}-impression" rows="3"
                    placeholder="这个人现在是怎么看对方的。">${escapeHtml(perspective?.impression ?? "")}</textarea>
            </label>

            <input type="hidden" id="airp-pair-${slot}-id" value="${escapeAttribute(characterId)}">
        </section>
    `;
}

async function saveRelationFromUI(relationKey) {
    const state = await ensureState();
    if (!state) return;

    const [a, b] = String(relationKey ?? "").split("::");
    if (!a || !b || !state.characters[a] || !state.characters[b]) return;

    const relationship = getRelationshipSnapshot(state, a, b);

    relationship.tags = splitCommaText(document.getElementById("airp-pair-tags-input")?.value ?? "");
    relationship.summary = document.getElementById("airp-pair-summary-input")?.value?.trim() ?? "";

    for (const slot of ["a", "b"]) {
        const characterId = document.getElementById(`airp-pair-${slot}-id`)?.value;
        if (!characterId || !relationship.perspectives[characterId]) continue;

        relationship.perspectives[characterId].attitude = clampSigned(
            document.getElementById(`airp-pair-${slot}-attitude`)?.value ?? 0,
        );

        relationship.perspectives[characterId].impression =
            document.getElementById(`airp-pair-${slot}-impression`)?.value?.trim() ?? "";
    }

    state.characterRelations[relationship.id] = relationship;

    await saveState(state);
    await goBack();
}

/* =========================================================
   当前世界角色列表
   ========================================================= */

function renderProfiles(state) {
    const characters = getWorldCharacters(state);
    const mains = characters.filter(character => character.type === "main");
    const npcs = characters.filter(character => character.type === "npc");
    const developerMode = state.settings?.interfaceMode !== "player";

    return `
        <div class="airp-page">
            <div class="airp-character-toolbar">
                <div>
                    <div class="airp-section-heading airp-heading-no-pad">攻略角色</div>
                    <div class="airp-character-count">${mains.length} 位已加入当前世界</div>
                </div>

                ${developerMode ? `
                <div class="airp-v9-character-actions">
                    <button type="button" class="airp-add-character-button airp-v9-secondary-add"
                        data-airp-action="open-npc-create" title="新建 NPC">
                        <i class="fa-solid fa-user-plus"></i>
                    </button>
                    <button type="button" class="airp-add-character-button"
                        data-airp-action="open-character-library" title="添加攻略角色">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
                ` : ""}
            </div>

            <div class="airp-contact-list">
                ${mains.length
                    ? mains.map(renderMainContact).join("")
                    : renderEmpty(developerMode ? "还没有攻略角色，点右上角 ＋ 添加" : "当前还没有攻略角色")}
            </div>

            ${npcs.length || developerMode ? `
                <div class="airp-section-heading airp-section-gap">其他联系人</div>
                <div class="airp-contact-list">${npcs.length ? npcs.map(renderNpcContact).join("") : renderEmpty("还没有 NPC")}</div>
            ` : ""}
        </div>
    `;
}

function renderMainContact(character) {
    const relation = character.relation ?? {};

    return `
        <button type="button" class="airp-contact-card airp-glass"
            data-airp-action="open-profile" data-character-id="${escapeAttribute(character.id)}">

            ${renderAvatar(character)}

            <div class="airp-contact-main">
                <div class="airp-contact-name">${escapeHtml(character.display.name)}</div>
                <div class="airp-contact-subtitle">${escapeHtml(character.relationLabel || "尚未建立关系")}</div>
                <div class="airp-contact-stats">
                    吸引 ${clamp(relation.attraction)} · 信任 ${clamp(relation.trust)}
                </div>
            </div>

            <i class="fa-solid fa-chevron-right airp-contact-arrow"></i>
        </button>
    `;
}

function getAttitudeLabel(score) {
    const value = Number(score) || 0;
    if (value > 15) return "正面";
    if (value < -15) return "负面";
    return "中立";
}

function getAttitudeClass(score) {
    const label = getAttitudeLabel(score);
    if (label === "正面") return "positive";
    if (label === "负面") return "negative";
    return "neutral";
}

function renderNpcContact(character) {
    const label = getAttitudeLabel(character.attitude);

    return `
        <button type="button" class="airp-contact-card airp-glass"
            data-airp-action="open-profile" data-character-id="${escapeAttribute(character.id)}">

            ${renderAvatar(character)}

            <div class="airp-contact-main">
                <div class="airp-contact-name">${escapeHtml(character.display.name)}</div>
                <div class="airp-contact-subtitle">${escapeHtml(character.display.identity || "联系人")}</div>
            </div>

            <span class="airp-attitude-pill ${getAttitudeClass(character.attitude)}">${label}</span>
        </button>
    `;
}

/* =========================================================
   SillyTavern 角色库
   ========================================================= */

function renderCharacterLibrary(state) {
    const cards = getAllCards();
    const currentCard = getCurrentCard();

    return `
        <div class="airp-page">
            <div class="airp-library-intro airp-glass">
                <div class="airp-library-intro-icon"><i class="fa-solid fa-address-book"></i></div>
                <div>
                    <strong>添加攻略角色</strong>
                    <p>这里读取的是 SillyTavern 已导入的角色卡。加入角色不会切换当前剧情聊天。</p>
                </div>
            </div>

            <div class="airp-section-heading airp-section-gap-small">角色卡</div>

            <div class="airp-library-list">
                ${cards.length
                    ? cards.map(card => renderLibraryCard(state, card, currentCard)).join("")
                    : renderEmpty("角色库里暂时没有可用角色卡")}
            </div>
        </div>
    `;
}

function renderLibraryCard(state, card, currentCard) {
    const bound = findCharacterByCard(state, card.avatar);
    const isActive = bound?.active !== false && Boolean(bound);
    const isCurrent = currentCard?.avatar === card.avatar;

    return `
        <div class="airp-library-card airp-glass">
            ${renderCardAvatar(card, "airp-library-avatar")}

            <div class="airp-library-main">
                <div class="airp-library-name-row">
                    <div class="airp-library-name">${escapeHtml(card.name)}</div>
                    ${isCurrent ? `<span class="airp-current-card-badge">当前聊天</span>` : ""}
                </div>

                <div class="airp-library-subtitle">
                    ${isActive ? "已加入当前世界" : bound ? "曾加入 · 数据已保留" : "SillyTavern 角色卡"}
                </div>
            </div>

            ${isActive ? `
                <button type="button" class="airp-library-action airp-library-remove"
                    data-airp-action="remove-card" data-card-avatar="${escapeAttribute(card.avatar)}">
                    移出
                </button>
            ` : `
                <button type="button" class="airp-library-action airp-library-add"
                    data-airp-action="add-card" data-card-avatar="${escapeAttribute(card.avatar)}">
                    ＋ 加入
                </button>
            `}
        </div>
    `;
}


/* =========================================================
   V9 · 角色工作室
   ========================================================= */

function renderCharacterFields(character, { creatingNpc = false } = {}) {
    const resolved = character ? resolveCharacter(character) : null;
    const profile = character?.profile ?? createDefaultProfile("");
    const status = character?.status ?? createDefaultCharacterStatus();
    const internal = character?.internal ?? createDefaultInternal();
    const isMain = character?.type === "main";

    return `
        <section class="airp-v9-studio-card airp-glass">
            <div class="airp-card-heading"><span>公开资料</span></div>
            ${isMain ? `<p class="airp-v9-help">显示名优先读取已绑定的 SillyTavern 角色卡：<strong>${escapeHtml(resolved?.display?.name || "")}</strong>。AIRP 这里主要补充社交主页资料。</p>` : ""}

            ${creatingNpc || !isMain ? `
            <label class="airp-world-field">
                <span>姓名</span>
                <input id="airp-character-name" type="text" value="${escapeAttribute(profile.name || "")}" placeholder="角色姓名">
            </label>` : ""}

            <div class="airp-v9-form-grid">
                <label class="airp-world-field"><span>@账号</span><input id="airp-character-handle" type="text" value="${escapeAttribute(profile.handle || "")}" placeholder="@name"></label>
                <label class="airp-world-field"><span>身份</span><input id="airp-character-identity" type="text" value="${escapeAttribute(profile.identity || "")}" placeholder="学生 / 教师 / 家族继承人……"></label>
                <label class="airp-world-field"><span>年级</span><input id="airp-character-grade" type="text" value="${escapeAttribute(profile.grade || "")}"></label>
                <label class="airp-world-field"><span>院系</span><input id="airp-character-department" type="text" value="${escapeAttribute(profile.department || "")}"></label>
                <label class="airp-world-field"><span>组织</span><input id="airp-character-organization" type="text" value="${escapeAttribute(profile.organization || "")}"></label>
                <label class="airp-world-field"><span>共同联系人</span><input id="airp-character-common-contacts" type="number" min="0" value="${escapeAttribute(profile.commonContacts ?? 0)}"></label>
            </div>

            <label class="airp-world-field"><span>签名</span><input id="airp-character-signature" type="text" value="${escapeAttribute(profile.signature || "")}"></label>
            <label class="airp-world-field"><span>个人简介</span><textarea id="airp-character-bio" rows="3">${escapeHtml(profile.bio || "")}</textarea></label>
            <label class="airp-world-field"><span>公开背景</span><textarea id="airp-character-background" rows="4">${escapeHtml(profile.background || "")}</textarea></label>
            <label class="airp-world-field"><span>头像（可粘 URL，也可从本地选择）</span><input id="airp-character-avatar" type="text" value="${escapeAttribute(profile.avatar || "")}" placeholder="留空时攻略角色使用角色卡头像"></label>
            <label class="airp-v10-file-field"><span>本地头像</span><input id="airp-character-avatar-file" type="file" accept="image/*"><small>会压缩后嵌入当前 AIRP 存档，不需要图床。</small></label>
            <label class="airp-world-field"><span>封面（可粘 URL，也可从本地选择）</span><input id="airp-character-cover" type="text" value="${escapeAttribute(profile.cover || "")}"></label>
            <label class="airp-v10-file-field"><span>本地封面</span><input id="airp-character-cover-file" type="file" accept="image/*"><small>同样嵌入当前 AIRP 存档。</small></label>
        </section>

        <section class="airp-v9-studio-card airp-glass">
            <div class="airp-card-heading"><span>当前状态</span></div>
            <p class="airp-v9-help">这是会随剧情变化的短期状态。V9 起模型也可以通过 AIRP_STATE 自动更新。</p>
            <div class="airp-v9-form-grid">
                <label class="airp-world-field"><span>所在地</span><input id="airp-character-status-location" type="text" value="${escapeAttribute(status.location || "")}"></label>
                <label class="airp-world-field"><span>当前情绪</span><input id="airp-character-status-mood" type="text" value="${escapeAttribute(status.mood || "")}"></label>
            </div>
            <label class="airp-world-field"><span>正在做什么</span><input id="airp-character-status-activity" type="text" value="${escapeAttribute(status.activity || "")}"></label>
            <label class="airp-world-field"><span>状态备注</span><textarea id="airp-character-status-note" rows="3">${escapeHtml(status.note || "")}</textarea></label>
        </section>

        <section class="airp-v9-studio-card airp-glass">
            <div class="airp-card-heading"><span>仅模型可见</span><i class="fa-solid fa-eye-slash"></i></div>
            <p class="airp-v9-help">写隐藏动机、秘密、行为逻辑或卡里不方便公开的信息。不会直接展示给玩家，也不代表其他角色知道。</p>
            <label class="airp-world-field"><span>模型私有备注</span><textarea id="airp-character-model-notes" rows="7">${escapeHtml(internal.modelNotes || "")}</textarea></label>
        </section>
    `;
}

async function collectCharacterFields(character, { creatingNpc = false } = {}) {
    const before = { ...(character.profile ?? {}) };
    const profile = { ...(character.profile ?? createDefaultProfile("")) };
    if (creatingNpc || character.type !== "main") {
        profile.name = document.getElementById("airp-character-name")?.value?.trim() || profile.name || "未命名角色";
    }
    profile.handle = document.getElementById("airp-character-handle")?.value?.trim() ?? "";
    profile.identity = document.getElementById("airp-character-identity")?.value?.trim() ?? "";
    profile.grade = document.getElementById("airp-character-grade")?.value?.trim() ?? "";
    profile.department = document.getElementById("airp-character-department")?.value?.trim() ?? "";
    profile.organization = document.getElementById("airp-character-organization")?.value?.trim() ?? "";
    profile.commonContacts = Math.max(0, Number(document.getElementById("airp-character-common-contacts")?.value) || 0);
    profile.signature = document.getElementById("airp-character-signature")?.value?.trim() ?? "";
    profile.bio = document.getElementById("airp-character-bio")?.value?.trim() ?? "";
    profile.background = document.getElementById("airp-character-background")?.value?.trim() ?? "";
    profile.avatar = document.getElementById("airp-character-avatar")?.value?.trim() ?? "";
    profile.cover = document.getElementById("airp-character-cover")?.value?.trim() ?? "";
    const avatarFile = document.getElementById("airp-character-avatar-file")?.files?.[0];
    const coverFile = document.getElementById("airp-character-cover-file")?.files?.[0];
    if (avatarFile) profile.avatar = await fileToCompressedDataUrl(avatarFile, { maxWidth: 512, maxHeight: 512 });
    if (coverFile) profile.cover = await fileToCompressedDataUrl(coverFile, { maxWidth: 1200, maxHeight: 700, quality: 0.84 });
    character.profile = profile;
    character.profileMeta ??= { locked: {}, sources: {} };
    for (const key of Object.keys(profile)) if (profile[key] !== before[key]) { character.profileMeta.locked[key] = true; character.profileMeta.sources[key] = "manual"; }

    character.status = character.status ?? createDefaultCharacterStatus();
    character.status.location = document.getElementById("airp-character-status-location")?.value?.trim() ?? "";
    character.status.mood = document.getElementById("airp-character-status-mood")?.value?.trim() ?? "";
    character.status.activity = document.getElementById("airp-character-status-activity")?.value?.trim() ?? "";
    character.status.note = document.getElementById("airp-character-status-note")?.value?.trim() ?? "";
    character.status.updatedAt = stateSafeWorldTime() || new Date().toISOString();

    character.internal = character.internal ?? createDefaultInternal();
    character.internal.modelNotes = document.getElementById("airp-character-model-notes")?.value?.trim() ?? "";
    return character;
}

function stateSafeWorldTime() {
    try {
        return getContext().chatMetadata?.[AIRP_KEY]?.world?.datetime || "";
    } catch {
        return "";
    }
}

function renderNpcCreate() {
    const character = createNpcCharacter("");
    character.profile.signature = "";
    return `
        <div class="airp-page airp-v9-studio-page">
            <div class="airp-library-intro airp-glass">
                <div class="airp-library-intro-icon"><i class="fa-solid fa-user-plus"></i></div>
                <div><strong>新建 NPC</strong><p>NPC 不需要 SillyTavern 角色卡，适合老师、同学、家人、路人等。以后可以原地绑定角色卡晋升为攻略角色。</p></div>
            </div>
            ${renderCharacterFields(character, { creatingNpc: true })}
            <button type="button" class="airp-world-save" data-airp-action="save-npc-create">创建 NPC</button>
        </div>
    `;
}


async function fileToCompressedDataUrl(file, {
    maxWidth = 640,
    maxHeight = 640,
    quality = 0.86,
} = {}) {
    if (!file) return "";
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });

    const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片解析失败"));
        img.src = dataUrl;
    });

    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);

    const mime = file.type === "image/png" && file.size < 350_000 ? "image/png" : "image/webp";
    return canvas.toDataURL(mime, quality);
}

async function saveNpcFromUI() {
    const state = await ensureState();
    if (!state) return;
    const character = createNpcCharacter("");
    await collectCharacterFields(character, { creatingNpc: true });
    if (!character.profile.name.trim()) character.profile.name = "未命名角色";
    if (!character.profile.handle) character.profile.handle = `@${character.profile.name}`;
    state.characters[character.id] = character;
    await saveState(state);
    await refreshAirpStatePrompt();
    navigationStack = [];
    currentView = { ...createHomeView(), page: "profile", characterId: character.id };
    await renderCurrentView();
}

function getAvailableCardsForPromotion(state, characterId) {
    return getAllCards().filter(card => {
        const bound = findCharacterByCard(state, card.avatar);
        return !bound || bound.id === characterId;
    });
}

function renderCharacterEdit(state, characterId) {
    const character = state.characters[characterId];
    if (!character || character.active === false) return renderEmpty("这个角色目前不在当前世界中");
    const resolved = resolveCharacter(character);
    const promotionCards = character.type === "npc" ? getAvailableCardsForPromotion(state, characterId) : [];

    return `
        <div class="airp-page airp-v9-studio-page">
            <div class="airp-library-intro airp-glass">
                ${renderAvatar(resolved, "airp-library-avatar")}
                <div>
                    <strong>${escapeHtml(resolved.display.name)}</strong>
                    <p>${character.type === "main" ? "攻略角色 · 已绑定 SillyTavern 角色卡" : "NPC · AIRP 原生联系人"}</p>
                </div>
            </div>

            ${renderCharacterFields(character)}

            ${character.type === "npc" ? `
            <section class="airp-v9-studio-card airp-glass">
                <div class="airp-card-heading"><span>晋升为攻略角色</span></div>
                <p class="airp-v9-help">绑定一张尚未占用的 SillyTavern 角色卡。角色 ID、事件认知、私聊与历史都会保留，只是从轻量 NPC 结构升级为七维关系结构。</p>
                <label class="airp-world-field">
                    <span>绑定角色卡</span>
                    <select id="airp-character-promotion-card" ${promotionCards.length ? "" : "disabled"}>
                        <option value="">${promotionCards.length ? "选择角色卡" : "没有可用角色卡"}</option>
                        ${promotionCards.map(card => `<option value="${escapeAttribute(card.avatar)}">${escapeHtml(card.name)}</option>`).join("")}
                    </select>
                </label>
                <button type="button" class="airp-v9-promote-button" data-airp-action="promote-npc" data-character-id="${escapeAttribute(character.id)}" ${promotionCards.length ? "" : "disabled"}>
                    <i class="fa-solid fa-arrow-up-right-dots"></i> 绑定并晋升
                </button>
            </section>` : `
            <section class="airp-v9-studio-card airp-glass">
                <div class="airp-card-heading"><span>角色卡绑定</span></div>
                <p class="airp-v9-help">${escapeHtml(getCardByAvatar(character.source?.cardAvatar)?.name || "角色卡不可用")} · 核心人格 / 示例对话仍在 SillyTavern 角色卡中编辑。</p>
            </section>`}

            <button type="button" class="airp-world-save" data-airp-action="save-character-edit" data-character-id="${escapeAttribute(character.id)}">保存角色资料</button>
        </div>
    `;
}

async function saveCharacterEditFromUI(characterId) {
    const state = await ensureState();
    if (!state) return;
    const character = state.characters[characterId];
    if (!character) return;
    await collectCharacterFields(character);
    await saveState(state);
    await refreshAirpStatePrompt();
    await goBack();
}

async function promoteNpcFromUI(characterId) {
    const state = await ensureState();
    if (!state) return;
    const character = state.characters[characterId];
    if (!character || character.type !== "npc") return;
    const avatar = document.getElementById("airp-character-promotion-card")?.value;
    if (!avatar) return;
    const card = getCardByAvatar(avatar);
    const occupied = findCharacterByCard(state, avatar);
    if (!card || (occupied && occupied.id !== characterId)) return;

    await collectCharacterFields(character);
    character.type = "main";
    character.source = { type: "sillytavern-card", cardAvatar: card.avatar };
    character.profile.name = card.name;
    character.relation = createDefaultRelation();
    character.relation.trust = Math.max(0, Math.min(25, Number(character.attitude) || 0));
    character.relation.hostility = Math.max(0, Math.min(25, -(Number(character.attitude) || 0)));
    character.profileInitialized = false;
    character.relationLabel = character.impression && character.impression !== "尚未形成明确印象"
        ? truncateText(character.impression, 80)
        : "尚未建立关系";

    await saveState(state);
    await refreshAirpStatePrompt();
    navigationStack = [];
    currentView = { ...createHomeView(), page: "profile", characterId };
    await renderCurrentView();
}

/* =========================================================
   角色主页
   ========================================================= */

function renderProfile(state, characterId) {
    const character = resolveCharacter(state.characters[characterId]);

    if (!character || character.active === false) {
        return renderEmpty("这个角色目前不在当前世界中");
    }

    const infoItems = [
        character.display.identity,
        character.display.grade,
        character.display.department,
        character.display.organization,
    ].filter(Boolean);

    const recentMoment = [...state.moments]
        .reverse()
        .find(moment => moment.authorId === character.id && canViewMoment(state, moment));

    const knownEvents = Object.keys(character.knowledge ?? {}).length;
    const mutualContacts = getWorldCharacters(state).filter(other => other.id !== character.id && areFriends(state,"player",other.id) && areFriends(state,character.id,other.id)).length;

    return `
        <div class="airp-profile-page">
            <section class="airp-profile-hero airp-glass">
                <div class="airp-profile-cover">
                    ${character.display.cover ? `
                        <img src="${escapeAttribute(character.display.cover)}" alt="">
                    ` : ""}
                </div>

                <div class="airp-profile-header-row">
                    ${renderAvatar(character, "airp-profile-avatar")}

                    <div class="airp-profile-actions">
                        ${!areFriends(state, "player", character.id) ? `<button type="button" class="airp-profile-action airp-profile-action-primary" data-airp-action="friend-status" data-character-id="${escapeAttribute(character.id)}" data-status="${character.contactStatus === "incoming" ? "friend" : character.contactStatus === "blocked" ? "known" : "requested"}" ${character.contactStatus === "requested" ? "disabled" : ""}>${character.contactStatus === "incoming" ? "接受好友" : character.contactStatus === "blocked" ? "解除屏蔽" : character.contactStatus === "requested" ? "等待通过" : "申请好友"}</button>` : ""}
                        <button type="button" class="airp-profile-action"
                            data-airp-action="profile-chat" data-character-id="${escapeAttribute(character.id)}" ${areFriends(state, "player", character.id) ? "" : "disabled"}>
                            <i class="fa-solid fa-comment"></i>私聊
                        </button>

                        <button type="button" class="airp-profile-action airp-profile-action-primary"
                            data-airp-action="profile-moments" data-character-id="${escapeAttribute(character.id)}" ${areFriends(state, "player", character.id) ? "" : "disabled"}>
                            <i class="fa-solid fa-camera-retro"></i>朋友圈
                        </button>
                    </div>
                </div>

                ${state.settings?.interfaceMode !== "player" ? `
                    <button type="button" class="airp-v9-profile-edit" data-airp-action="open-character-edit" data-character-id="${escapeAttribute(character.id)}" title="编辑角色资料">
                        <i class="fa-solid fa-pen"></i> 编辑资料
                    </button>
                ` : ""}

                <div class="airp-profile-name">${escapeHtml(character.display.name)}</div>
                <div class="airp-profile-handle">${escapeHtml(character.display.handle)}</div>
                <div class="airp-contact-label">${escapeHtml(CONTACT_LABELS[character.contactStatus] || "未加好友")}${areFriends(state, "player", character.id) ? ` · <button type="button" data-airp-action="friend-status" data-character-id="${escapeAttribute(character.id)}" data-status="known">移除好友</button>` : ""}</div>

                ${character.display.signature ? `
                    <div class="airp-profile-signature">${escapeHtml(character.display.signature)}</div>
                ` : ""}

                ${infoItems.length ? `
                    <div class="airp-profile-tags">
                        ${infoItems.map(item => `<span>${escapeHtml(item)}</span>`).join("")}
                    </div>
                ` : ""}

                ${(character.display.bio || character.display.background) ? `
                    <div class="airp-profile-bio">
                        ${character.display.bio ? `<p>${escapeHtml(character.display.bio)}</p>` : ""}
                        ${character.display.background ? `<p class="airp-profile-background">${escapeHtml(character.display.background)}</p>` : ""}
                    </div>
                ` : ""}

                <div class="airp-profile-meta">
                    <div>
                        <strong>${mutualContacts}</strong>
                        <span>共同联系人</span>
                    </div>
                    <div>
                        <strong>${knownEvents}</strong>
                        <span>已知事件</span>
                    </div>
                </div>
            </section>

            ${(character.status?.location || character.status?.activity || character.status?.mood || character.status?.note) ? `
            <section class="airp-v9-status-card airp-glass">
                <div class="airp-card-heading"><span>当前状态</span></div>
                <div class="airp-v9-status-chips">
                    ${character.status.location ? `<span><i class="fa-solid fa-location-dot"></i>${escapeHtml(character.status.location)}</span>` : ""}
                    ${character.status.mood ? `<span><i class="fa-regular fa-face-smile"></i>${escapeHtml(character.status.mood)}</span>` : ""}
                </div>
                ${character.status.activity ? `<p>${escapeHtml(character.status.activity)}</p>` : ""}
                ${character.status.note ? `<p class="airp-v9-status-note">${escapeHtml(character.status.note)}</p>` : ""}
            </section>
            ` : ""}

            <section class="airp-latest-moment airp-glass"
                data-airp-action="profile-moments" data-character-id="${escapeAttribute(character.id)}">

                <div class="airp-card-heading">
                    <span>最近动态</span>
                    <i class="fa-solid fa-chevron-right"></i>
                </div>

                ${recentMoment ? `
                    <div class="airp-latest-time">${escapeHtml(recentMoment.time || "")}</div>
                    <div class="airp-latest-text">${escapeHtml(recentMoment.text || "")}</div>
                ` : `<div class="airp-empty-small">${areFriends(state, "player", character.id) ? "还没有动态。" : "加为好友后可见。"}</div>`}
            </section>

            ${character.type === "main"
                ? renderMainRelation(character)
                : renderNpcRelation(character)}
        </div>
    `;
}

/* =========================================================
   七维关系
   ========================================================= */

function renderMainRelation(character) {
    const relation = character.relation ?? createDefaultRelation();
    const items = [
        ["吸引", "attraction"],
        ["信任", "trust"],
        ["尊重", "respect"],
        ["敌意", "hostility"],
        ["占有欲", "possessiveness"],
        ["依赖", "dependence"],
        ["嫉妒", "jealousy"],
    ];

    return `
        <section class="airp-relation-card airp-glass">
            <div class="airp-card-heading"><span>仅玩家可见 · 关系状态</span></div>
            <div class="airp-relation-label">${escapeHtml(character.relationLabel || "尚未建立关系")}</div>

            <div class="airp-relation-list">
                ${items.map(([label, key]) => renderRelationRow(label, clamp(relation[key]))).join("")}
            </div>
        </section>
    `;
}

function renderRelationRow(label, value) {
    return `
        <div class="airp-relation-row">
            <div class="airp-relation-top">
                <span>${escapeHtml(label)}</span>
                <strong>${value}</strong>
            </div>

            <div class="airp-relation-track">
                <div class="airp-relation-fill" style="width:${value}%"></div>
            </div>
        </div>
    `;
}

function renderNpcRelation(character) {
    return `
        <section class="airp-npc-relation airp-glass">
            <div class="airp-card-heading"><span>当前印象</span></div>
            <div class="airp-npc-attitude">
                <span class="airp-attitude-pill ${getAttitudeClass(character.attitude)}">
                    ${getAttitudeLabel(character.attitude)}
                </span>
            </div>
            <p>${escapeHtml(character.impression || "目前没有更多关系信息。")}</p>
        </section>
    `;
}

/* =========================================================
   朋友圈
   ========================================================= */

function renderMoments(state, characterId = null) {
    if (characterId && !areFriends(state, "player", characterId)) return renderEmpty("加为好友后，才能查看对方朋友圈");
    let moments = [...state.moments].filter(moment => canViewMoment(state, moment)).reverse();
    let character = null;

    if (characterId) {
        character = resolveCharacter(state.characters[characterId]);
        moments = moments.filter(moment => moment.authorId === characterId);
    }

    return `
        <div class="airp-page airp-v10-social-page">
            ${character ? `
                <div class="airp-filter-chip airp-glass">
                    ${renderAvatar(character, "airp-filter-avatar")}
                    <span>只看 ${escapeHtml(character.display.name)}</span>
                </div>
            ` : `
                <div class="airp-v11-social-head">
                    <div>
                        <div class="airp-section-heading airp-heading-no-pad">朋友圈</div>
                        <div class="airp-social-page-note">好友动态与当前世界同步。</div>
                    </div>
                    <button type="button" class="airp-v11-create-icon" data-airp-action="open-moment-create" title="发布动态" aria-label="发布动态">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            `}

            <div class="airp-moment-feed">
                ${moments.length
                    ? moments.map(moment => renderMoment(state, moment)).join("")
                    : renderEmpty(character ? "这个角色还没有发布动态" : "朋友圈还是空的")}
            </div>
        </div>
    `;
}

function renderMomentCreate(state) {
    const playerName = getContext().name1 || "你";
    const time = state?.world?.datetime || "当前世界时间";
    return `
        <div class="airp-page airp-v11-create-page">
            <section class="airp-v11-social-editor airp-glass">
                <div class="airp-v11-editor-identity">
                    <div class="airp-avatar airp-avatar-fallback airp-v11-editor-avatar">${escapeHtml(getInitial(playerName))}</div>
                    <div><strong>${escapeHtml(playerName)}</strong><span>${escapeHtml(time)}</span></div>
                </div>
                <textarea id="airp-player-moment-text" rows="7" maxlength="1200" placeholder="分享这一刻……"></textarea>
                <div class="airp-v11-editor-footer">
                    <span class="airp-v11-visibility"><i class="fa-solid fa-earth-asia"></i> 好友可见</span>
                    <button type="button" class="airp-v11-publish-button" data-airp-action="publish-player-moment">发布</button>
                </div>
            </section>
        </div>
    `;
}

function getSocialActorName(state, actorId) {
    if (actorId === "player") return getContext().name1 || "你";
    return resolveCharacter(state.characters[actorId])?.display?.name || "未知用户";
}

function renderMoment(state, moment) {
    const author = moment.authorId === "player"
        ? null
        : resolveCharacter(state.characters[moment.authorId]);
    if (moment.authorId !== "player" && !author) return "";

    const authorName = moment.authorId === "player"
        ? (getContext().name1 || "你")
        : author.display.name;
    const liked = (moment.likes ?? []).includes("player");
    const likeNames = (moment.likes ?? []).map(id => getSocialActorName(state, id)).slice(0, 12);

    return `
        <article class="airp-moment-card airp-glass" id="airp-moment-${escapeAttribute(moment.id)}" data-moment-id="${escapeAttribute(moment.id)}">
            <div class="airp-moment-header">
                ${author ? renderAvatar(author, "airp-moment-avatar") : `<div class="airp-avatar airp-avatar-fallback airp-moment-avatar">${escapeHtml(getInitial(authorName))}</div>`}
                <div>
                    <div class="airp-moment-name">${escapeHtml(authorName)}</div>
                    <div class="airp-moment-time">${escapeHtml(moment.time || "")}</div>
                </div>
            </div>

            <div class="airp-moment-text">${escapeHtml(moment.text || "")}</div>
            ${moment.eventId ? `<button type="button" class="airp-trace-link" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(moment.eventId)}">查看事件链</button>` : ""}

            <div class="airp-v10-moment-actions">
                <button type="button" class="${liked ? "is-active" : ""}" data-airp-action="toggle-moment-like" data-moment-id="${escapeAttribute(moment.id)}">
                    <i class="fa-${liked ? "solid" : "regular"} fa-heart"></i> ${(moment.likes ?? []).length || ""}
                </button>
                <button type="button" data-airp-action="focus-moment-comment" data-moment-id="${escapeAttribute(moment.id)}">
                    <i class="fa-regular fa-comment"></i> ${(moment.comments ?? []).length || ""}
                </button>
            </div>

            ${(likeNames.length || (moment.comments ?? []).length) ? `
                <div class="airp-v10-moment-social">
                    ${likeNames.length ? `<div class="airp-v10-like-line"><i class="fa-solid fa-heart"></i>${escapeHtml(likeNames.join("、"))}</div>` : ""}
                    ${(moment.comments ?? []).map(comment => `
                        <div class="airp-v10-comment-line">
                            <strong>${escapeHtml(getSocialActorName(state, comment.authorId))}</strong>
                            <span>${escapeHtml(comment.text || "")}</span>
                        </div>
                    `).join("")}
                </div>
            ` : ""}

            <div class="airp-v10-inline-compose">
                <input id="airp-moment-comment-${escapeAttribute(moment.id)}" type="text" placeholder="评论……">
                <button type="button" data-airp-action="send-moment-comment" data-moment-id="${escapeAttribute(moment.id)}">发送</button>
            </div>
        </article>
    `;
}

/* =========================================================
   私聊 / 论坛 / 通知
   ========================================================= */

function renderChatHome(state) {
    const characters = getWorldCharacters(state).filter(character => areFriends(state, "player", character.id) || getPlayerThreadMessages(state, character.id).length);

    return `
        <div class="airp-page airp-v10-social-page">
            <div class="airp-section-heading airp-heading-no-pad">私聊</div>
            <div class="airp-character-count airp-social-page-note">
                私聊与主剧情是不同叙事渠道。这里的玩家消息会写入世界事件，下一轮模型能看到。
            </div>

            <div class="airp-chat-list">
                ${characters.length
                    ? characters.map(character => renderChatListItem(state, character)).join("")
                    : renderEmpty("当前世界里还没有联系人")}
            </div>
        </div>
    `;
}

function renderChatListItem(state, character) {
    const messages = getPlayerThreadMessages(state, character.id);
    const last = messages.at(-1);
    const unread = getUnreadCountForCharacter(state, character.id);

    return `
        <button type="button" class="airp-chat-list-item airp-glass"
            data-airp-action="open-chat-thread" data-character-id="${escapeAttribute(character.id)}">
            ${renderAvatar(character, "airp-present-avatar")}

            <div class="airp-chat-list-main">
                <div class="airp-chat-list-top">
                    <strong>${escapeHtml(character.display.name)}</strong>
                    <span>${escapeHtml(last?.time || "")}</span>
                </div>

                <p>${escapeHtml(last?.text || "还没有私聊记录")}</p>
            </div>

            ${unread ? `<b class="airp-social-unread">${unread}</b>` : ""}
        </button>
    `;
}

function renderChatThread(state, characterId) {
    if (!areFriends(state, "player", characterId) && !getPlayerThreadMessages(state, characterId).length) return renderEmpty("加为好友后，才能发送私聊");
    const character = resolveCharacter(state.characters[characterId]);
    if (!character) return renderEmpty("找不到这个联系人");

    const messages = getPlayerThreadMessages(state, characterId);

    return `
        <div class="airp-page airp-chat-thread-page airp-v10-social-page">
            ${areFriends(state, "player", characterId) ? "" : `<p class="airp-social-page-note">已不是好友，保留历史消息；重新加好友后可继续发送。</p>`}
            <div class="airp-chat-thread">
                ${messages.length
                    ? messages.map(message => renderChatBubble(state, character, message)).join("")
                    : renderEmpty("还没有消息。")}
            </div>
        </div>
    `;
}

function renderChatComposer(character) {
    return `
        <div class="airp-v10-chat-compose airp-glass">
            <textarea id="airp-chat-compose-input" rows="1" placeholder="发消息给 ${escapeAttribute(character.display.name)}"></textarea>
            <button type="button" data-airp-action="send-player-chat" data-character-id="${escapeAttribute(character.id)}" aria-label="发送">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function renderChatBubble(state, character, message) {
    const fromPlayer = message.senderId === "player";

    return `
        <div class="airp-chat-message ${fromPlayer ? "is-player" : "is-character"}">
            ${!fromPlayer ? renderAvatar(character, "airp-chat-message-avatar") : ""}

            <div class="airp-chat-bubble-wrap">
                <div class="airp-chat-bubble">${escapeHtml(message.text || "")}</div>
                <span>${escapeHtml(message.time || "")}${!fromPlayer && message.read ? " · 已读" : ""}${fromPlayer ? " · " + ({pending:"待处理",deferred:"稍后处理",handled:"已处理",ignored:"未回应"}[message.processingStatus] || "待处理") : ""}</span>
                ${message.eventId ? `<button type="button" class="airp-trace-link" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(message.eventId)}">查看事件链</button>` : ""}
            </div>
        </div>
    `;
}

function renderForum(state) {
    const posts = [...state.forum].reverse();

    return `
        <div class="airp-page airp-v10-social-page">
            <div class="airp-v11-social-head">
                <div>
                    <div class="airp-section-heading airp-heading-no-pad">论坛</div>
                    <div class="airp-social-page-note">匿名与真实身份由 AIRP 分开记录。</div>
                </div>
                <button type="button" class="airp-v11-create-icon" data-airp-action="open-forum-create" title="发帖" aria-label="发帖">
                    <i class="fa-solid fa-plus"></i>
                </button>
            </div>

            <div class="airp-forum-list">
                ${posts.length
                    ? posts.map(post => renderForumPost(state, post)).join("")
                    : renderEmpty("论坛目前还没有帖子")}
            </div>
        </div>
    `;
}

function renderForumCreate(state) {
    const playerName = getContext().name1 || "你";
    const time = state?.world?.datetime || "当前世界时间";
    return `
        <div class="airp-page airp-v11-create-page">
            <section class="airp-v11-social-editor airp-v11-forum-editor airp-glass">
                <div class="airp-v11-editor-kicker">新帖子</div>
                <input id="airp-player-forum-title" class="airp-v11-title-input" type="text" maxlength="120" placeholder="标题（可选）">
                <textarea id="airp-player-forum-text" rows="10" maxlength="3000" placeholder="写下你想说的……"></textarea>
                <div class="airp-v11-editor-footer">
                    <div class="airp-v11-editor-meta">
                        <span>${escapeHtml(playerName)} · ${escapeHtml(time)}</span>
                        <label class="airp-v11-anonymous-chip"><input id="airp-player-forum-anonymous" type="checkbox"><i class="fa-solid fa-user-secret"></i> 匿名</label>
                    </div>
                    <button type="button" class="airp-v11-publish-button" data-airp-action="publish-player-forum">发布</button>
                </div>
            </section>
        </div>
    `;
}

function renderForumPost(state, post) {
    const author = post.authorId === "player" ? null : resolveCharacter(state.characters[post.authorId]);
    const authorName = post.anonymous
        ? (post.anonymousLabel || "匿名用户")
        : post.authorId === "player"
            ? (getContext().name1 || "你")
            : author?.display?.name || "未知用户";

    return `
        <article class="airp-forum-post airp-glass" data-airp-action="open-forum-post" data-post-id="${escapeAttribute(post.id)}">
            <div class="airp-forum-post-head">
                <div class="airp-forum-author-icon">
                    ${post.anonymous
                        ? `<i class="fa-solid fa-user-secret"></i>`
                        : author
                            ? renderAvatar(author, "airp-forum-avatar")
                            : `<i class="fa-solid fa-user"></i>`}
                </div>

                <div>
                    <strong>${escapeHtml(authorName)}</strong>
                    <span>${escapeHtml(post.time || "")} · ${(post.replies ?? []).length} 回复</span>
                </div>
            </div>

            ${post.title ? `<h3>${escapeHtml(post.title)}</h3>` : ""}
            ${post.text ? `<p>${escapeHtml(post.text)}</p>` : ""}
        </article>
    `;
}

function renderForumDetail(state, postId) {
    const post = getForumPostById(state, postId);
    if (!post) return renderEmpty("帖子不存在");

    const author = post.authorId === "player" ? null : resolveCharacter(state.characters[post.authorId]);
    const authorName = post.anonymous
        ? (post.anonymousLabel || "匿名用户")
        : post.authorId === "player"
            ? (getContext().name1 || "你")
            : author?.display?.name || "未知用户";

    return `
        <div class="airp-page airp-v10-forum-detail">
            <article class="airp-forum-post airp-glass">
                <div class="airp-v10-floor">楼主</div>
                <div class="airp-forum-post-head">
                    <div class="airp-forum-author-icon">${post.anonymous ? `<i class="fa-solid fa-user-secret"></i>` : author ? renderAvatar(author, "airp-forum-avatar") : `<i class="fa-solid fa-user"></i>`}</div>
                    <div><strong>${escapeHtml(authorName)}</strong><span>${escapeHtml(post.time || "")}</span></div>
                </div>
                ${post.title ? `<h3>${escapeHtml(post.title)}</h3>` : ""}
                ${post.text ? `<p>${escapeHtml(post.text)}</p>` : ""}
                ${post.eventId ? `<button type="button" class="airp-trace-link" data-airp-action="open-event-detail" data-event-id="${escapeAttribute(post.eventId)}">查看事件链</button>` : ""}
            </article>

            <div class="airp-v10-reply-list">
                ${(post.replies ?? []).length ? post.replies.map((reply, index) => {
                    const replyAuthor = reply.authorId === "player" ? null : resolveCharacter(state.characters[reply.authorId]);
                    const name = reply.anonymous
                        ? (reply.anonymousLabel || "匿名用户")
                        : reply.authorId === "player"
                            ? (getContext().name1 || "你")
                            : replyAuthor?.display?.name || "未知用户";
                    return `
                        <article class="airp-v10-forum-reply airp-glass">
                            <div class="airp-v10-floor">${index + 2}F</div>
                            <div class="airp-v10-forum-reply-meta"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(reply.time || "")}</span></div>
                            <p>${escapeHtml(reply.text || "")}</p>
                        </article>
                    `;
                }).join("") : renderEmpty("还没有回复")}
            </div>
        </div>
    `;
}

function renderForumComposer(post) {
    if (!post) return "";

    return `
        <div class="airp-v10-forum-compose airp-glass">
            <textarea id="airp-forum-reply-input" rows="1" placeholder="回复帖子……"></textarea>
            <div class="airp-v10-forum-compose-row">
                <label><input id="airp-forum-reply-anonymous" type="checkbox"> 匿名回复</label>
                <button type="button" data-airp-action="send-forum-reply" data-post-id="${escapeAttribute(post.id)}">回复</button>
            </div>
        </div>
    `;
}

function renderNotifications(state) {
    const items = [...(state.notifications ?? [])].reverse();
    return `
        <div class="airp-page airp-v10-social-page">
            <div class="airp-v10-notification-head">
                <span>${getUnreadNotificationCount(state)} 条未读</span>
                <button type="button" data-airp-action="mark-notifications-read">全部已读</button>
            </div>
            <div class="airp-v10-notification-list">
                ${items.length ? items.map(item => {
                    const actorName = item.anonymousLabel || (item.actorId ? getSocialActorName(state, item.actorId) : "AIRP");
                    const icon = {
                        private_chat: "fa-comment",
                        moment_comment: "fa-comment-dots",
                        moment_like: "fa-heart",
                        forum_reply: "fa-reply",
                    }[item.type] || "fa-bell";
                    return `
                        <div class="airp-v10-notification airp-glass ${item.read ? "" : "is-unread"}" role="button" tabindex="0" data-airp-action="open-notification" data-notification-id="${escapeAttribute(item.id)}">
                            <div class="airp-v10-notify-icon"><i class="fa-solid ${icon}"></i></div>
                            <div><strong>${escapeHtml(actorName)}</strong><p>${escapeHtml(item.text || "")}</p><span>${escapeHtml(item.time || "")}</span></div>
                        </div>
                    `;
                }).join("") : renderEmpty("暂时没有通知")}
            </div>
        </div>
    `;
}

async function sendPlayerPrivateMessage(characterId) {
    const state = await ensureState();
    const text = document.getElementById("airp-chat-compose-input")?.value?.trim();
    if (!state || !text || !state.characters[characterId]) return;
    if (!areFriends(state, "player", characterId)) throw new Error("先加好友，才能发送私聊");

    const message = appendPrivateMessage(state, {
        senderId: "player",
        receiverId: characterId,
        text,
        time: state.world.datetime || "",
    });
    const event = addEventToState(state, {
        time: state.world.datetime || "",
        summary: `你向${getCharacterName(state, characterId)}发送私聊：${text}`,
        participants: [characterId],
        witnesses: [],
        audienceCharacterIds: [characterId],
        visibility: "private",
        channel: "private_chat",
        tags: ["私聊", "玩家发送"],
    });
    message.eventId = event?.id ?? null;
    createReactionCandidate(state, characterId, event.id, { source: "private_chat" });
    state.runtime.pendingUiInputIds = ["airp-chat-compose-input"];
    await saveState(state);
    clearAirpDrafts(state.runtime.pendingUiInputIds);
    delete state.runtime.pendingUiInputIds;
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

async function publishPlayerMoment() {
    const state = await ensureState();
    const text = document.getElementById("airp-player-moment-text")?.value?.trim();
    if (!state || !text) return;

    const moment = appendMoment(state, {
        authorId: "player",
        text,
        time: state.world.datetime || "",
    });
    const event = addEventToState(state, {
        time: state.world.datetime || "",
        summary: `你发布朋友圈：${text}`,
        participants: [],
        witnesses: [],
        visibility: "social",
        channel: "moments",
        tags: ["朋友圈", "玩家发布"],
    });
    moment.eventId = event?.id ?? null;

    state.runtime.pendingUiInputIds = ["airp-player-moment-text"];
    await saveState(state);
    clearAirpDrafts(state.runtime.pendingUiInputIds);
    delete state.runtime.pendingUiInputIds;
    await refreshAirpStatePrompt();
    currentView = { ...createHomeView(), page: "moments" };
    await renderCurrentView();
}

async function publishPlayerForumPost() {
    const state = await ensureState();
    const title = document.getElementById("airp-player-forum-title")?.value?.trim() || "";
    const text = document.getElementById("airp-player-forum-text")?.value?.trim();
    const anonymous = Boolean(document.getElementById("airp-player-forum-anonymous")?.checked);
    if (!state || !text) return;

    const post = appendForumPost(state, {
        authorId: "player",
        title,
        text,
        anonymous,
        time: state.world.datetime || "",
    });
    const subject = title || text;
    const event = addEventToState(state, {
        time: state.world.datetime || "",
        summary: `${anonymous ? "你以匿名身份" : "你"}发布论坛帖：${subject}`,
        publicSummary: anonymous ? `匿名用户发布论坛帖：${subject}；${text}` : null,
        participants: [],
        witnesses: [],
        visibility: "public",
        channel: "forum",
        tags: ["论坛", "玩家发布"],
    });
    post.eventId = event?.id ?? null;

    state.runtime.pendingUiInputIds = ["airp-player-forum-title","airp-player-forum-text"];
    await saveState(state);
    clearAirpDrafts(state.runtime.pendingUiInputIds);
    delete state.runtime.pendingUiInputIds;
    await refreshAirpStatePrompt();
    currentView = { ...createHomeView(), page: "forum" };
    await renderCurrentView();
}

async function sendPlayerMomentComment(momentId) {
    const state = await ensureState();
    if (!state || !canViewMoment(state, state.moments.find(item => item.id === momentId) ?? { authorId: null })) return;
    const input = document.getElementById(`airp-moment-comment-${momentId}`);
    const text = input?.value?.trim();
    if (!state || !text) return;
    const comment = addMomentComment(state, momentId, { authorId: "player", text, time: state.world.datetime || "" });
    if (!comment) return;
    const moment = getMomentById(state, momentId);
    const event = addEventToState(state, {
        time: state.world.datetime || "",
        summary: `你评论朋友圈：${text}`,
        participants: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
        witnesses: [],
        audienceCharacterIds: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
        visibility: "social",
        channel: "moments",
        sourceEventId: moment?.eventId || null,
        tags: ["朋友圈", "评论", "玩家发送"],
    });
    comment.eventId = event.id;
    for (const id of event.participants) if (id !== "player") createReactionCandidate(state,id,event.id,{source:event.channel});
    state.runtime.pendingUiInputIds = ["airp-moment-comment-" + momentId];
    await saveState(state);
    clearAirpDrafts(state.runtime.pendingUiInputIds);
    delete state.runtime.pendingUiInputIds;
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

async function togglePlayerMomentLike(momentId) {
    const state = await ensureState();
    if (!state || !canViewMoment(state, state.moments.find(item => item.id === momentId) ?? { authorId: null })) return;
    if (!state || !getMomentById(state, momentId)) return;
    const liked = toggleMomentLike(state, momentId, "player");
    const moment = getMomentById(state, momentId);
    if (liked) {
        addEventToState(state, {
            time: state.world.datetime || "",
            summary: `你赞了${moment?.authorId === "player" ? "自己的" : `${getCharacterName(state, moment?.authorId)}的`}朋友圈`,
            participants: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
            witnesses: [],
            audienceCharacterIds: moment?.authorId && moment.authorId !== "player" ? [moment.authorId] : [],
            visibility: "social",
            channel: "moments",
            sourceEventId: moment?.eventId || null,
            tags: ["朋友圈", "点赞", "玩家操作"],
        });
    }
    await saveState(state);
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

async function sendPlayerForumReply(postId) {
    const state = await ensureState();
    const text = document.getElementById("airp-forum-reply-input")?.value?.trim();
    const anonymous = Boolean(document.getElementById("airp-forum-reply-anonymous")?.checked);
    if (!state || !text) return;
    const reply = addForumReply(state, postId, { authorId: "player", text, anonymous, time: state.world.datetime || "" });
    if (!reply) return;
    const post = getForumPostById(state, postId);
    const event = addEventToState(state, {
        time: state.world.datetime || "",
        summary: `${anonymous ? "你以匿名身份" : "你"}回复论坛：${text}`,
        publicSummary: anonymous ? `匿名用户回复论坛：${text}` : null,
        participants: [],
        witnesses: [],
        visibility: "public",
        channel: "forum",
        sourceEventId: post?.eventId || null,
        tags: ["论坛", "回复", "玩家发送"],
    });
    reply.eventId = event.id;
    for (const id of event.participants) if (id !== "player") createReactionCandidate(state,id,event.id,{source:event.channel});
    state.runtime.pendingUiInputIds = ["airp-forum-reply-input"];
    await saveState(state);
    clearAirpDrafts(state.runtime.pendingUiInputIds);
    delete state.runtime.pendingUiInputIds;
    await refreshAirpStatePrompt();
    await renderCurrentView();
}

/* =========================================================
   占位页
   ========================================================= */

function renderPlaceholder(icon, title, text) {
    return `
        <div class="airp-placeholder-page">
            <div class="airp-placeholder-icon"><i class="fa-solid ${icon}"></i></div>
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(text)}</p>
        </div>
    `;
}

/* =========================================================
   Navbar
   ========================================================= */

function setNavbar(title, showBack) {
    const titleElement = document.getElementById("airp-phone-title");
    const backButton = document.getElementById("airp-phone-back");

    if (titleElement) titleElement.textContent = title;
    if (backButton) backButton.classList.toggle("airp-nav-hidden", !showBack);
}

/* =========================================================
   渲染路由
   ========================================================= */

async function renderCurrentView({ background = false } = {}) {
    if (background && ["character-edit", "npc-create", "settings", "world-studio", "world-state", "event-create", "relation-edit", "action-execute"].includes(currentView.page)) { showAirpSaveStatus(getContext().chatMetadata?.[AIRP_KEY]); return; }
    captureAirpDrafts();
    const focusedId = document.activeElement?.id;
    const selection = [document.activeElement?.selectionStart, document.activeElement?.selectionEnd];
    const oldThread = document.getElementById("airp-phone-content")?.querySelector(".airp-chat-thread");
    const oldScroll = oldThread?.scrollTop ?? 0;
    const wasAtBottom = !oldThread || oldThread.scrollHeight - oldThread.scrollTop - oldThread.clientHeight < 60;
    const sameView = renderedDraftView === `${currentView.page}:${currentView.characterId || currentView.forumPostId || ""}`;
    const owner = captureOwner();
    const content = document.getElementById("airp-phone-content");
    const footer = document.getElementById("airp-phone-footer");
    if (!content) return;

    const isChatThread = currentView.page === "chat" && Boolean(currentView.characterId);
    const isForumDetail = currentView.page === "forum-detail" && Boolean(currentView.forumPostId);
    content.classList.toggle("airp-chat-content-mode", isChatThread);
    content.classList.toggle("airp-forum-content-mode", isForumDetail);

    if (footer) {
        footer.classList.add("airp-hidden");
        footer.innerHTML = "";
    }

    const state = await ensureState();

    if (state) { assertOwner(owner); applyAirpInterfaceState(state); }

    if (!state) {
        setNavbar("AIRP", false);
        content.innerHTML = renderPlaceholder(
            "fa-message",
            "还没有打开存档",
            "先进入一个 SillyTavern 聊天，再打开 AIRP 手机。",
        );
        return;
    }

    const worldTime = document.getElementById("airp-world-time");
    if (worldTime) worldTime.textContent = extractWorldTime(state.world.datetime);

    switch (currentView.page) {
        case "home":
            setNavbar("手机", false);
            content.innerHTML = renderHome(state);
            break;

        case "world-state":
            setNavbar("当前世界", true);
            content.innerHTML = renderWorldState(state);
            break;

        case "world-studio":
            setNavbar(worldPackCache.config?.name || "世界资料", true);
            content.innerHTML = renderWorldStudio(state);
            break;

        case "settings":
            setNavbar("AIRP 设置", true);
            content.innerHTML = renderSettings(state);
            break;

        case "events":
            setNavbar("事件记录", true);
            content.innerHTML = renderEvents(state);
            break;

        case "event-create":
            setNavbar("记录事件", true);
            content.innerHTML = renderEventCreate(state);
            break;

        case "event-detail": {
            const event = getEventById(state, currentView.eventId);
            setNavbar(event?.time || "事件详情", true);
            content.innerHTML = renderEventDetail(state, currentView.eventId);
            break;
        }

        case "propagation":
            setNavbar("信息传播", true);
            content.innerHTML = renderPropagationCenter(state);
            break;

        case "reactions":
            setNavbar("角色反应", true);
            content.innerHTML = renderReactionCenter(state);
            break;

        case "reaction-detail": {
            const reaction = getReactionById(state, currentView.reactionId);
            const character = reaction
                ? resolveCharacter(state.characters[reaction.characterId])
                : null;
            setNavbar(character ? `${character.display.name} · 反应` : "角色反应", true);
            content.innerHTML = renderReactionDetail(state, currentView.reactionId);
            break;
        }

        case "relations":
            setNavbar("人物关系", true);
            content.innerHTML = renderRelations(state);
            break;

        case "relation-edit": {
            const [a, b] = String(currentView.relationKey ?? "").split("::");
            const title = a && b
                ? `${getCharacterName(state, a)} × ${getCharacterName(state, b)}`
                : "人物关系";
            setNavbar(title, true);
            content.innerHTML = renderRelationEdit(state, currentView.relationKey);
            break;
        }

        case "profiles":
            setNavbar("角色", true);
            content.innerHTML = renderProfiles(state);
            break;

        case "character-library":
            setNavbar("添加攻略角色", true);
            content.innerHTML = renderCharacterLibrary(state);
            break;

        case "profile": {
            const character = resolveCharacter(state.characters[currentView.characterId]);
            setNavbar(character?.display?.name || "角色主页", true);
            content.innerHTML = renderProfile(state, currentView.characterId);
            break;
        }

        case "npc-create":
            setNavbar("新建 NPC", true);
            content.innerHTML = renderNpcCreate();
            break;

        case "character-edit": {
            const character = resolveCharacter(state.characters[currentView.characterId]);
            setNavbar(character ? `${character.display.name} · 编辑` : "编辑角色", true);
            content.innerHTML = renderCharacterEdit(state, currentView.characterId);
            break;
        }

        case "moments": {
            const character = currentView.characterId
                ? resolveCharacter(state.characters[currentView.characterId])
                : null;

            setNavbar(character ? `${character.display.name} · 朋友圈` : "朋友圈", true);
            content.innerHTML = renderMoments(state, currentView.characterId);
            break;
        }

        case "moment-create":
            setNavbar("发布朋友圈", true);
            content.innerHTML = renderMomentCreate(state);
            requestAnimationFrame(() => document.getElementById("airp-player-moment-text")?.focus());
            break;

        case "chat": {
            const character = currentView.characterId
                ? resolveCharacter(state.characters[currentView.characterId])
                : null;

            setNavbar(character ? character.display.name : "私聊", true);
            content.innerHTML = character
                ? renderChatThread(state, currentView.characterId)
                : renderChatHome(state);

            if (footer && character && areFriends(state, "player", character.id)) {
                footer.innerHTML = renderChatComposer(character);
                footer.classList.remove("airp-hidden");
            }
            break;
        }

        case "forum":
            setNavbar("论坛", true);
            content.innerHTML = renderForum(state);
            break;

        case "forum-create":
            setNavbar("发布论坛帖", true);
            content.innerHTML = renderForumCreate(state);
            requestAnimationFrame(() => document.getElementById("airp-player-forum-title")?.focus());
            break;

        case "forum-detail": {
            const post = getForumPostById(state, currentView.forumPostId);
            setNavbar(post?.title || "帖子", true);
            content.innerHTML = renderForumDetail(state, currentView.forumPostId);

            if (footer && post) {
                footer.innerHTML = renderForumComposer(post);
                footer.classList.remove("airp-hidden");
            }
            break;
        }

        case "notifications":
            setNavbar("通知", true);
            content.innerHTML = renderNotifications(state);
            break;

        case "action-execute": {
            const action = getActionById(state, currentView.actionId);
            const actor = action ? resolveCharacter(state.characters[action.actorId]) : null;
            setNavbar(actor ? `${actor.display.name} · 执行动作` : "执行行动", true);
            content.innerHTML = renderActionExecution(state, currentView.actionId);
            break;
        }

        default:
            currentView = createHomeView();
            await renderCurrentView();
            break;
    }

    assertOwner(owner);
    renderedDraftScope = recoveryKey(owner);
    renderedDraftView = `${currentView.page}:${currentView.characterId || currentView.forumPostId || ""}`;
    restoreAirpDrafts();
    if (focusedId && background) { const input = document.getElementById(focusedId); input?.focus(); if (Number.isInteger(selection[0])) input?.setSelectionRange?.(...selection); }
    showAirpSaveStatus(state);

    if (isChatThread) {
        requestAnimationFrame(() => {
            const thread = content.querySelector(".airp-chat-thread");
            if (thread) thread.scrollTop = sameView && !wasAtBottom ? oldScroll : thread.scrollHeight;
        });
    }
}

/* =========================================================
   页面点击
   ========================================================= */

async function handleContentClick(event) {
    const target = event.target.closest("[data-airp-action]");
    if (!target) return;

    const action = target.dataset.airpAction;
    const characterId = target.dataset.characterId ?? null;
    const cardAvatar = target.dataset.cardAvatar ?? null;
    const eventId = target.dataset.eventId ?? null;
    const exposureId = target.dataset.exposureId ?? null;
    const relationKey = target.dataset.relationKey ?? null;
    const reactionId = target.dataset.reactionId ?? null;
    const actionId = target.dataset.actionId ?? null;
    const momentId = target.dataset.momentId ?? null;
    const postId = target.dataset.postId ?? null;

    switch (action) {
        case "friend-status":
            await changeFriendship(characterId, target.dataset.status);
            break;
        case "restore-local-recovery":
            await resolveLocalRecovery(true);
            break;
        case "keep-server-recovery":
            await resolveLocalRecovery(false);
            break;
        case "export-local-recovery": {
            const owner = captureOwner();
            const local = await readBackup(recoveryKey(owner));
            if (local?.state) downloadAirpState(local.state, "本机恢复副本");
            break;
        }
        case "retry-airp-save":
            await retryAirpSave();
            break;
        case "open-artifact":
            await openSocialArtifact(target.dataset.sourceType, target.dataset.sourceId);
            break;
        case "open-notification": {
            const state = await ensureState();
            const item = state?.notifications.find(entry => entry.id === target.dataset.notificationId);
            if (item) { item.read = true; await saveState(state); if (item.type === "friend_request") await navigateTo("profile", item.actorId); else await openSocialArtifact(item.type, item.sourceId); }
            break;
        }
        case "open-world-state":
            await navigateTo("world-state");
            break;

        case "save-world-state":
            await saveWorldStateFromUI();
            break;

        case "open-world-studio":
            await navigateTo("world-studio");
            break;

        case "save-world-studio":
            await saveWorldStudioFromUI();
            break;

        case "reload-world-pack":
            await reloadWorldPackFromUI();
            break;

        case "open-settings":
            await navigateTo("settings");
            break;

        case "save-settings":
            await saveSettingsFromUI();
            break;

        case "open-events":
            await navigateTo("events");
            break;

        case "open-event-create":
            await navigateTo("event-create");
            break;

        case "save-event":
            await saveEventFromUI();
            break;

        case "open-event-detail":
            if (eventId) await navigateToEvent(eventId);
            break;

        case "save-event-knowledge":
            if (eventId) await saveEventKnowledgeFromUI(eventId);
            break;

        case "open-propagation":
            await navigateTo("propagation");
            break;

        case "confirm-exposure":
            if (exposureId) await confirmExposure(exposureId);
            break;

        case "dismiss-exposure":
            if (exposureId) await dismissExposure(exposureId);
            break;

        case "open-reactions":
            await navigateTo("reactions");
            break;

        case "open-reaction-detail":
            if (reactionId) await navigateToReaction(reactionId);
            break;

        case "save-reaction":
            if (reactionId) await saveReactionFromUI(reactionId);
            break;

        case "ignore-reaction":
            if (reactionId) await ignoreReaction(reactionId);
            break;

        case "open-action-execute":
            if (actionId) await navigateToAction(actionId);
            break;

        case "execute-action":
            if (actionId) await executeActionFromUI(actionId);
            break;

        case "complete-action":
            if (actionId) await updateActionStatus(actionId, "done");
            break;

        case "cancel-action":
            if (actionId) await updateActionStatus(actionId, "cancelled");
            break;

        case "open-chat-thread":
            if (characterId) {
                const state = await ensureState();
                if (state && markThreadRead(state, characterId)) {
                    await saveState(state);
                }
                await navigateTo("chat", characterId);
            }
            break;

        case "open-relations":
            await navigateTo("relations");
            break;

        case "open-relation-edit":
            if (relationKey) await navigateToRelation(relationKey);
            break;

        case "save-relation":
            if (relationKey) await saveRelationFromUI(relationKey);
            break;

        case "open-profiles":
            await navigateTo("profiles");
            break;

        case "open-character-library":
            await navigateTo("character-library");
            break;

        case "open-npc-create":
            await navigateTo("npc-create");
            break;

        case "save-npc-create":
            await saveNpcFromUI();
            break;

        case "open-character-edit":
            if (characterId) await navigateTo("character-edit", characterId);
            break;

        case "save-character-edit":
            if (characterId) await saveCharacterEditFromUI(characterId);
            break;

        case "promote-npc":
            if (characterId) await promoteNpcFromUI(characterId);
            break;

        case "add-card":
            if (cardAvatar) await addCardToWorld(cardAvatar);
            break;

        case "remove-card":
            if (cardAvatar) await removeCardFromWorld(cardAvatar);
            break;

        case "open-profile":
            await navigateTo("profile", characterId);
            break;

        case "open-moments":
            await navigateTo("moments");
            break;

        case "open-moment-create":
            await navigateTo("moment-create");
            break;

        case "profile-moments":
            await navigateTo("moments", characterId);
            break;

        case "open-chat":
            await navigateTo("chat");
            break;

        case "profile-chat":
            if (characterId) {
                const state = await ensureState();
                if (state && markThreadRead(state, characterId)) {
                    await saveState(state);
                }
                await navigateTo("chat", characterId);
            }
            break;

        case "open-forum":
            await navigateTo("forum");
            break;

        case "open-forum-create":
            await navigateTo("forum-create");
            break;

        case "open-forum-post":
            if (postId) await navigateToForumPost(postId);
            break;

        case "send-player-chat":
            if (characterId) await sendPlayerPrivateMessage(characterId);
            break;

        case "toggle-moment-like":
            if (momentId) await togglePlayerMomentLike(momentId);
            break;

        case "focus-moment-comment":
            if (momentId) {
                document.getElementById(`airp-moment-comment-${momentId}`)?.focus();
            }
            break;

        case "send-moment-comment":
            if (momentId) await sendPlayerMomentComment(momentId);
            break;

        case "publish-player-moment":
            await publishPlayerMoment();
            break;

        case "publish-player-forum":
            await publishPlayerForumPost();
            break;

        case "send-forum-reply":
            if (postId) await sendPlayerForumReply(postId);
            break;

        case "export-airp-world":
            await exportCurrentAirpWorld();
            break;

        case "import-airp-world":
            await chooseAndImportAirpWorld();
            break;

        case "undo-last-auto-update":
            await undoLastAutoUpdate();
            break;

        case "redo-last-auto-update":
            await redoLastAutoUpdate();
            break;

        case "check-airp-world":
            await checkCurrentAirpWorld();
            break;

        case "open-notifications":
            await navigateTo("notifications");
            break;

        case "mark-notifications-read": {
            const state = await ensureState();
            if (state && markAllNotificationsRead(state)) await saveState(state);
            await renderCurrentView();
            break;
        }
    }
}

/* =========================================================
   打开手机
   ========================================================= */

async function openPhone() {
    createPhoneUI();

    const overlay = document.getElementById("airp-phone-overlay");
    if (!overlay) return;

    navigationStack = [];
    currentView = createHomeView();

    const state = await ensureState();
    if (state) applyAirpInterfaceState(state);
    overlay.classList.remove("airp-hidden");
    await renderCurrentView();
}

/* =========================================================
   魔法棒菜单入口
   ========================================================= */

function addExtensionMenuButton() {
    if (document.getElementById("airp-extension-menu-button")) return;

    const container = document.getElementById("extensionsMenu");
    if (!container) return;

    const button = document.createElement("div");
    button.id = "airp-extension-menu-button";
    button.classList.add("list-group-item", "flex-container", "flexGap5");

    const icon = document.createElement("div");
    icon.classList.add("fa-solid", "fa-mobile-screen-button", "extensionsMenuExtensionButton");

    const text = document.createElement("span");
    text.textContent = "AIRP 手机";

    button.append(icon, text);
    button.addEventListener("click", openPhone);
    container.appendChild(button);
}

/* =========================================================
   调试接口：以后模型状态块会调用同一套 delta
   ========================================================= */

function installDebugApi() {
    globalThis.AIRP_DEV = {
        getState: ensureState,
        applyStateDelta,
        refreshPrompt: refreshAirpStatePrompt,
        previewPrompt: async () => {
            const state = await ensureState();
            if (!state) return "";
            await loadWorldPack(state);
            const extra = await loadExternalPromptBundle(state);
            return buildAirpStateTrackerPrompt(buildAirpContextBlock(state), extra.text || "");
        },
        reloadWorldPack: async () => {
            const state = await ensureState();
            if (!state) return null;
            await loadWorldPack(state, true);
            await loadExternalPromptBundle(state, true);
            await refreshAirpStatePrompt();
            return { worldPackCache, externalPromptCache };
        },
        parseOpening: text => extractAirpOpeningBlock(text),
        decorateOpenings: decorateAllOpeningMessages,
        parseOutput: text => {
            const extracted = extractAirpStateBlock(text);
            return {
                ...extracted,
                delta: extracted.rawState ? parseAirpStateJson(extracted.rawState) : null,
            };
        },
        processLatestMessage: async () => {
            const context = getContext();
            const id = context.chat.length - 1;
            return processAssistantStateBlock(id, "manual_debug");
        },
        undoLastAutoUpdate,
        redoLastAutoUpdate,
        exportCurrentAirpWorld,
        checkCurrentAirpWorld,
        createNpc: async (name = "新联系人") => {
            const state = await ensureState();
            if (!state) return null;
            const npc = createNpcCharacter(name);
            state.characters[npc.id] = npc;
            await saveState(state);
            return npc;
        },
        createPropagationCandidates: async eventId => {
            const state = await ensureState();
            const event = state ? getEventById(state, eventId) : null;
            if (!state || !event) return false;
            createPropagationCandidates(state, event);
            await saveState(state);
            return true;
        },
        resolveReaction: async (reactionId, resolution = {}) => {
            const state = await ensureState();
            if (!state) return false;
            const ok = resolveReactionInState(state, reactionId, resolution);
            if (ok) await saveState(state);
            return ok;
        },
    };
}

/* =========================================================
   初始化
   ========================================================= */

function setup() {
    ensureAirpOpeningPresentationStyles();
    createPhoneUI();
    addExtensionMenuButton();
    installDebugApi();
}

export async function onActivate() {
    const context = getContext();
    const eventSource = context.eventSource;
    const event_types = context.event_types ?? context.eventTypes;

    if (!eventSource || !event_types) {
        console.error(`[${MODULE_NAME}] SillyTavern event API unavailable`);
        return;
    }

    setup();
    if (activationInstalled) return;
    activationInstalled = true;

    eventSource.on(event_types.APP_READY, async () => {
        setup();
        await refreshAirpInterfaceState();
        await materializeWorldPackOpening();
        await processExistingOpeningBlocks();
        await recoverCurrentChatState();
        await refreshAirpStatePrompt();
        rememberChatStructure();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        navigationStack = [];
        currentView = createHomeView();
        await refreshAirpInterfaceState();
        await materializeWorldPackOpening();
        await processExistingOpeningBlocks();
        await recoverCurrentChatState();
        await refreshAirpStatePrompt();
        rememberChatStructure();

        const overlay = document.getElementById("airp-phone-overlay");
        if (overlay && !overlay.classList.contains("airp-hidden")) {
            await renderCurrentView();
        }
    });

    if (event_types.PERSONA_CHANGED) {
        eventSource.on(event_types.PERSONA_CHANGED, async () => {
            await refreshAirpStatePrompt();
        });
    }

    // 官方生成流程会在这里等待扩展监听器，随后才真正构建 / 发送 prompt。
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type) => {
        if (["quiet", "impersonate"].includes(String(type))) return;
        await enqueueAirp(refreshAirpStatePrompt);
    });

    // MESSAGE_RECEIVED 在 AI 消息写入 chat、但尚未渲染到 UI 时触发。
    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId, type) => {
        await processOpeningBlock(messageId);

        await enqueueAirp(() => processAssistantStateBlock(messageId, type));
    });

    // V13：让 ST 可见聊天历史成为 AIRP 的“事实分支”。
    if (event_types.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, async () => {
            rememberChatStructure();
        });
    }

    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, async (newLength) => {
            await enqueueAirp(() => handleAirpMessageDeleted(newLength));
        });
    }

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, async (messageId) => {
            await enqueueAirp(() => handleAirpMessageSwiped(messageId));
        });
    }

    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, async (messageId) => {
            await enqueueAirp(() => handleAirpMessageEdited(messageId));
        });
    }

    if (event_types.MESSAGE_SWIPE_DELETED) {
        eventSource.on(event_types.MESSAGE_SWIPE_DELETED, async (payload) => {
            await cleanupDeletedSwipeCheckpoint(payload);
        });
    }

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        decorateOpeningMessage(messageId);
        rememberChatStructure();
    });

    await refreshAirpInterfaceState();
    await materializeWorldPackOpening();
    await processExistingOpeningBlocks();
    await recoverCurrentChatState();
    await refreshAirpStatePrompt();
    rememberChatStructure();
    console.log(`[${MODULE_NAME}] activated · state v${STATE_VERSION} · message-state sync ready`);
}

