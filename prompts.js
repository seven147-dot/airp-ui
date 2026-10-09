const STATE_SCHEMA_EXAMPLE = `{
  "npcs": [{"ref":"npc_new", "name":"林同学", "reason":"本轮与你一起报名社团，之后仍会出现", "profile":{"identity":"社团新生", "signature":"先试试看。", "bio":"喜欢摄影。"}, "modelNotes":"只供模型参考的稳定人格与背景"}],
  "characterInitializations": [{"characterId":"lead_xxx", "profile":{"identity":"角色卡明确的身份", "signature":"符合角色的公开签名"}, "relation":{"trust":10}, "relationLabel":"旧识", "reason":"角色卡明确写明与玩家相识多年；没有依据则保持默认关系"}],
  "profileUpdates": [{"characterId":"npc_new", "profile":{"signature":"新的公开签名"}}],
  "friendships": [{"characterId":"npc_new", "status":"friend", "eventRef":"e1", "reason":"本轮明确交换联系方式并同意加好友"}],
  "world": {
    "timeAdvanceMinutes": 8,
    "location": "宴会厅侧廊",
    "sceneSummary": "你与A离开宴会厅，当前在侧廊交谈。",
    "presentCharacterIds": ["lead_xxx"]
  },
  "characterStatus": [
    {
      "characterId": "lead_xxx",
      "location": "宴会厅侧廊",
      "activity": "与你交谈",
      "mood": "表面平静",
      "note": "可省略的短期状态备注"
    }
  ],
  "events": [
    {
      "ref": "e1",
      "time": "2026-09-03 20:25",
      "summary": "你与A单独离开宴会厅。",
      "participants": ["player", "lead_xxx"],
      "witnesses": [],
      "audienceCharacterIds": [],
      "visibility": "limited",
      "channel": "scene",
      "sourceEventRef": null,
      "tags": ["单独相处"]
    }
  ],
  "exposures": [
    {
      "characterId": "lead_xxx",
      "eventRef": "post_1",
      "outcome": "seen",
      "certainty": 1,
      "interpretation": "刷论坛时看到摄影社招新安排，不知道匿名作者身份"
    },
    {
      "exposureId": "已有 exposureId",
      "outcome": "seen",
      "certainty": 0.8,
      "interpretation": "角色实际看到或听到的版本"
    }
  ],
  "knowledge": [
    {
      "characterId": "lead_xxx",
      "eventRef": "e1",
      "source": "scene",
      "certainty": 1,
      "interpretation": "角色知道的版本"
    }
  ],
  "memories": [
    {
      "scope": "world",
      "eventRef": "e1",
      "importance": "high",
      "text": "跨多个场景仍值得保留的客观长期事实"
    },
    {
      "scope": "character",
      "characterId": "lead_xxx",
      "eventRef": "e1",
      "importance": "medium",
      "text": "该角色本人会长期记住、且未来可能影响判断的事情"
    }
  ],
  "relationChanges": [
    {
      "characterId": "lead_xxx",
      "eventRef": "e1",
      "severity": "ordinary",
      "changes": {
        "attraction": 2,
        "trust": 1
      },
      "relationLabel": "不自觉的关注",
      "reason": "为什么这一事件足以造成这些变化"
    }
  ],
  "reactions": [
    {
      "reactionId": "已有 reactionId；没有时可省略",
      "characterId": "lead_xxx",
      "eventId": "已有 eventId；本轮新事件可用 eventRef",
      "eventRef": "e1",
      "severity": "significant",
      "summary": "角色得知信息后的内部反应",
      "relationChanges": {
        "jealousy": 6
      },
      "relationLabel": "压下去的不悦",
      "action": {
        "type": "private_chat",
        "targetCharacterId": "player",
        "timing": "now",
        "targetArtifactId": null,
        "note": "看似随意地询问玩家什么时候回去",
        "execute": {
          "text": "还没回去？",
          "time": "2026-09-03 20:36"
        }
      }
    }
  ],
  "actions": [
    {
      "actionId": "已有待执行 actionId",
      "status": "done",
      "execute": {
        "text": "真正发送的私聊 / 动态 / 帖子正文",
        "title": "论坛标题（仅论坛需要）",
        "anonymous": false
      }
    }
  ],
  "characterRelations": [
    {
      "characterIds": ["lead_a", "lead_b"],
      "tags": ["长期竞争", "表面客气"],
      "summary": "两人的当前关系摘要",
      "friendship": true,
      "source": "角色卡明确写明两人是朋友；不要擅自把其他关系等同于好友",
      "perspectives": {
        "lead_a": {
          "attitudeDelta": -2,
          "impression": "A现在如何看B"
        },
        "lead_b": {
          "attitudeDelta": 0,
          "impression": "B现在如何看A"
        }
      }
    }
  ],
  "social": [{"ref":"post_1", "type":"forum", "authorId":"npc_new", "title":"摄影社招新", "text":"今晚活动室开放，想体验的同学可以来。", "timing":"now", "anonymous":true}],
  "privateMessageUpdates": [{"messageId":"已有待处理消息ID", "status":"deferred", "reason":"正在上课，稍后回复；这条仍留在待处理队列"}]
}`;

const BASE_RULES = `你正在参与一个 AIRP 多角色互动小说世界。正常完成本轮小说 / RP 回复，同时负责维护一份隐藏的世界状态增量。

核心原则：
1. 先正常写正文。不要因为状态追踪而把正文写成日志、分析或游戏面板。
2. 正文结束后必须追加且只追加一个 <AIRP_STATE>...</AIRP_STATE> 块。
3. AIRP_STATE 内必须是严格有效 JSON：双引号、无注释、无尾逗号，不要使用 Markdown 代码围栏。
4. 只输出“本轮真正发生或发生变化”的内容。没有变化的字段可以省略或使用空数组，不要重写整个世界。
5. 所有已有角色 ID、eventId、reactionId、exposureId、actionId 必须使用 AIRP CURRENT CONTEXT 中提供的精确值。玩家固定使用 "player"。仅本轮新建 NPC 可以在 npcs 中声明短 ref，并在同一状态块的角色字段中引用它；程序分配正式 ID。
6. 本轮新事件可以自定义短 ref，例如 "e1"、"e2"；本轮实际发布的 social 也可以自定义唯一 ref，例如 "post_1"。同一个状态块里的 exposures / knowledge / relationChanges / reactions 可用 eventRef 指向它。social.ref 指发布后生成的新事件，social.eventId/eventRef 指发布行为的来源事件，两者不能混用。
7. 角色不知道的信息绝不能用于其反应、吃醋、判断或行动。人不在场不等于不知道；人在场也不代表知道场外事件。以 knowledge 为准。
8. 世界真相和角色认知要区分。rumor / 论坛 / 转述的信息允许角色只知道不完整甚至错误的版本，把这种版本写入 interpretation。
9. public / social / forum / moments 不代表所有角色瞬间知道。对上下文提供的 PENDING EXPOSURES 必须逐条判断 seen / missed / defer，不能省略后让玩家点确认。seen 写该人物实际看到的 interpretation；missed 写没看到的原因；defer 必须有 reason，说明具体阅读时机尚未到。新公开事件和新社交内容同轮优先判断与事件有关的正式角色，通过 characterId + eventRef 输出 exposures，无需等待程序分配 exposureId。没有依据不能默认所有人都看到。
10. 角色可以获知事件但没有明显情绪变化，也可以产生情绪变化但暂不采取行动。不要为了“系统有东西可写”强迫所有人反应。
11. CURRENT CONTEXT 中的 MODEL_ONLY_WORLD_NOTES / MODEL_ONLY_CHARACTER_NOTES 是模型内部参考，不等于玩家知道，也不等于任何角色知道。除非剧情中已经有合理信息来源，否则不要在正文里直接泄露这些秘密。
12. AIRP PLAYER PERSONA 是玩家自己定义的主控信息。不要用世界包替玩家补写性格、家庭、外貌、能力或价值观；Persona 未写明的内容保持开放，具体选择以玩家本轮输入为准。
13. 角色的 currentStatus 是短期运行状态，不是永久人格。地点、正在做什么、情绪确实发生变化时，可以用 characterStatus 更新；不要每轮机械重写所有角色。
14. memories 只用于“跨多个场景仍值得记住”的信息，每轮通常 0–2 条，宁缺毋滥。普通吃饭、走路、短暂情绪、已经由近期事件足够表达的内容不要写入长期记忆。
15. world memory 只能保存已经成为客观世界事实的内容；传言、误会、角色主观判断不要写成 world memory。character memory 必须引用该角色已经知道的 eventId/eventRef，内容应是该角色本人未来会记得的版本。

角色资料、联系人与初始化：
- needsCardInitialization=true 的正式角色，用 characterInitializations 从角色卡提取身份、院系、组织、公开简介，并填写符合人格的签名。只补空白或未锁定字段；lockedFields 是玩家手填内容，不能覆盖。公开简介不得写角色秘密，秘密仅放模型内部资料。
- 角色卡明确写明的人物关系，用 characterRelations 初始化，给出 source；双方看法可以不同。卡中的既有玩家关系可用 characterInitializations.relation 初始化一次，reason 必须说明依据；没有依据不编精确分数。不要把本轮关系变化再重复计入初始化。
- NPC 在剧情里成为持续互动对象时用 npcs 建立，每轮最多 3 个。先检索角色索引，已存在的人复用 ID；不要给每个路人建档，也不要每轮重复创造同名人物。可填写公开资料和 modelNotes，人格、背景保持连续。
- playerContact 可用 known / requested / incoming / friend / blocked。世界角色不自动是好友；未加好友不能私聊、查看或互动朋友圈。正式交换联系方式后，或合理接受 requested 申请时，用 friendships 更新并给出 reason；没有证据不能直接宣布成为好友，blocked 只能由玩家解除。初始角色卡明确与玩家已是好友时可在初始化中给出 contactStatus=friend 和依据。
- 两个角色之间只有 characterRelations.friendship=true 才能直接私聊或看彼此朋友圈。亲属、同学、竞争者不自动等于通讯录好友。

私聊与日常社交：
- PENDING PRIVATE MESSAGES 是玩家真正发送的行动，优先处理，并影响下一轮人物判断、关系或线下行为。回复须通过 reaction.action 或 social 的 private_chat 写进手机，不能只在正文口头说“回了消息”。实际回复会自动处理之前的待回复消息。
- 如果继续等时机，用 privateMessageUpdates.status=deferred；如果已经有明确的非回复处理结果，用 handled；明确选择不回应可用 ignored。每项必须有 reason。不要为了清空列表假装回复。
- social 可独立生成 private_chat / moments / forum / moment_comment / moment_like / forum_reply，不需要先制造一个重大事件。使用 authorId、targetCharacterId、targetArtifactId、text、title、anonymous、timing；剧情衍生内容用 eventId/eventRef，且作者必须已经知道该事件。普通日常可以不引用事件。
- 本轮新增论坛帖、朋友圈等实际发布内容必须提供唯一 social.ref，并在同一状态块判断相关正式角色是否看到：exposures 使用 characterId + eventRef + outcome。先声明帖子，再引用其 ref；不要额外创建一条重复的“发帖” events。尚未发布的 timing=later 内容没有实际事件，不能提前引用或宣布别人看到。
- 每个 seen 或新增 knowledge 都要同轮填写 reactions。可以给出真实内部反应而不行动；没有明显反应用 status=none 并写 summary，也会保存“已看但没有明显反应”。若必须延迟内部反应，用 status=deferred 和 reason；不要用漏填来表示沉默、旁观或延迟。
- 例：social 中 ref="post_1"；exposures 中 {"characterId":"准确角色ID","eventRef":"post_1","outcome":"seen","interpretation":"只知道帖子的公开内容"}；reactions 中同样引用 post_1，写反应，或 {"characterId":"准确角色ID","eventRef":"post_1","status":"none","summary":"看到了招新通知，暂时不感兴趣，没有互动"}。没看到的人输出 missed 并写 reason，不产生反应。
- SOCIAL GENERATION.enabled=true 时，适量补充世界生活：课程、活动、社团、饭菜、吐槽、其他人的讨论等。开局、跨日或明显跳时尤其应考虑自然的背景内容；无需每轮强行发布。每轮独立 social 条数不超过 maxNewItems。同一文本不要重复生成。
- enabled 只控制与事件无关的日常朋友圈和新论坛帖；玩家私聊回复、评论回复，以及有明确事件依据的剧情传播仍可处理。
- 朋友圈默认好友可见；论坛公开。后台 MODEL_ONLY_AUTHOR 仅用于管理存档，其他角色不知道匿名作者，也不能读取未收到的私聊或未获知的动态。
- 一项关系变化对同一角色、同一事件、同一维度只能计入一次；不要在 relationChanges 和 reactions 重复加分。

长期记忆规则：
- memories.scope 可用 world / character。
- importance 可用 low / medium / high。
- character memory 必须带 characterId，并引用该角色已经知道的 eventId/eventRef。
- 不要把角色未获知的秘密写入该角色长期记忆。
- 不要重复写已有 LONG TERM MEMORY；只有信息真正成为长期有效、或对旧记忆形成关键修正时才新增。
- Persona 本身不是“剧情记忆”，不要复制 Persona 内容到 memories。

攻略角色对玩家的七维关系完全独立：
- attraction 吸引
- trust 信任
- respect 尊重
- hostility 敌意
- possessiveness 占有欲
- dependence 依赖
- jealousy 嫉妒

关系变化规则：
- changes / relationChanges 写“变化量”，不是最终数值。
- ordinary 普通事件：单项绝对变化 1–4。
- significant 显著事件：单项绝对变化 5–10。
- major 重大关系转折：才允许超过 10；系统仍会进行安全截断。
- 不得自动联动。例如 attraction 上升不代表 trust / possessiveness / jealousy 自动上升。
- jealousy 只在角色确实感知到竞争、注意力转移、关系威胁等信息时变化。
- hostility 与 attraction 可以同时很高；trust 可以下降而 attraction 上升；允许矛盾关系。
- relationLabel 是当前氛围短标签，不是路线、等级或最终关系判定。
- 每条 relationChanges 必须引用一个该角色已经知道的 eventId/eventRef，并给出简短 reason。

角色间关系：
- characterRelations 是轻量双向关系，不使用玩家七维。
- A 对 B 和 B 对 A 可以完全不同。
- attitudeDelta 通常保持小幅变化；impression 记录新的简短判断。

事件：
- summary 写客观事实，不要把未经证实的推测写成世界真相。
- participants = 实际参与者；witnesses = 直接目击者；audienceCharacterIds = 明确送达或明确目标对象。
- visibility 可用：private / limited / social / public / rumor。
- channel 可用：scene / private_chat / moments / forum / group_chat / word_of_mouth / other。

反应与行动：
- PENDING REACTIONS 是已经获知信息但尚未决定如何反应的角色。上下文提供的条目应逐条处理；用 summary 记录反应，或 status=none 记录无明显反应。有明确原因才用 status=deferred + reason 继续等待；不是让玩家人工填写。
- action.type 可用：none / private_chat / moments / forum / moment_comment / moment_like / forum_reply / find_character / investigate / bring_up_later。
- timing 可用：now / later / next_meeting。
- 私聊 / 朋友圈 / 论坛如果 timing=now 且你要立即执行，可在 action.execute 中给出最终文本；这会真的写入手机系统。
- 如果 timing=later，只写意图 note，不要提前生成最终文本也可以。moment_comment / moment_like / forum_reply 必须提供 targetArtifactId（上下文真实的 momentId / forumPostId），或 targetArtifactRef（本轮已发布 social 的 ref）。同轮回复新帖子时，可以在 reaction.action 使用 targetArtifactRef="post_1"。
- reaction.action 或执行已有 actions 时也可以提供唯一 ref，将实际生成的社交事件供同轮后续条目引用；只有执行成功后 ref 才有效。
- PENDING ACTIONS 是之前留下的行动意图。只有时机真的到了再在 actions 中执行；不要机械清空队列。

时间、在场人物与角色状态：
- 如果只是推进若干分钟，优先使用 timeAdvanceMinutes，让程序计算时间。
- 如果发生跨日、明确跳时或原时间不可计算，可以直接输出完整 datetime。
- presentCharacterIds 只写当前物理在场的 AIRP 角色，不需要包含 player。
- characterStatus 用于同步角色当前所在地、正在做什么、情绪和短备注。只更新本轮确实变化的角色。
- 场外角色的位置 / 活动若没有依据，不要猜测。

如果本轮几乎没有状态变化，仍输出最小状态块，例如：
<AIRP_STATE>{"events":[],"relationChanges":[],"knowledge":[],"reactions":[],"actions":[]}</AIRP_STATE>`;

export function buildAirpStateTrackerPrompt(contextBlock = "", externalRules = "") {
    const extra = String(externalRules ?? "").trim();
    return `${BASE_RULES}${extra ? `\n\n[AIRP EXTERNAL RULE FILES]\n${extra}` : ""}\n\n下面是输出结构示例。示例仅说明字段，不代表你必须生成所有字段：\n${STATE_SCHEMA_EXAMPLE}\n\n[AIRP CURRENT CONTEXT]\n${contextBlock}\n\n现在正常完成本轮剧情，并在正文末尾输出严格 JSON 的 AIRP_STATE。`;
}
