# 钉钉 AI 卡片「子代理任务卡」设计

- 日期：2026-08-31
- 对象：openclaw v2026.7.1-2 + dingtalk-openclaw-connector 0.8.25（私有 fork）
- 状态：设计已逐节确认，待实现计划

## 1. 目标与非目标

### 目标

用户在钉钉发出一条指令，openclaw 主控 agent 决定启用子代理模式（主控规划 + N 个原生 runtime 子代理执行）时：

1. 钉钉侧只出现 **一张** AI 卡片。
2. 卡片上半部分展示主控通过 `update_plan` 维护的 todo list，状态实时更新（⏳ 待开始 / 🔄 进行中 / ✅ 已完成 / ❌ 失败）。
3. 全部子任务完成后，同一张卡片下半部分展示最终答案，卡片进入 FINISHED。
4. 不触发子代理的普通问答路径行为与 0.8.25 完全一致。

### 非目标（YAGNI）

- 不持久化任务卡状态（网关重启即丢失，与 openclaw announce 的 best-effort 等级一致）。
- 一个 session 同时只有一张任务卡；不支持嵌套子代理的层级展示（`maxSpawnDepth ≥ 2` 时只展示直接子代理）。
- 不做卡片按钮/交互；不新建钉钉卡片模板（沿用官方 AI 卡片模板与单字段 `msgContent`）。
- 不修改 openclaw 源码。

## 2. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 交付形态 | 私有 fork，直接修改官方插件 |
| todo 权威数据源 | `update_plan` 为主，`subagent_spawned/ended` 兜底 |
| 卡片布局 | 单字段合成 markdown（todo 区 + 分隔线 + 结果区） |
| 中间轮输出 | 覆盖，只显示最新一条 |
| 适用范围 | 单聊 + `groupReplyMode=aicard` 的群聊 |
| 异常收尾 | 子代理失败只标记，等主控最终输出；看门狗到期强制完成 |

## 3. 源码事实（设计依据）

路径相对两棵源码树根目录。

### openclaw

- 子代理由模型调用 `sessions_spawn`（非阻塞）后 `sessions_yield` 结束本轮；yield 通过 abort 结束运行并返回空文本 assistant 消息（`src/agents/embedded-agent-runner/run/attempt.sessions-yield.ts:83-95`，`run/attempt.ts:1443-1447, 5099-5115`）。
- 子代理以 `deliver: false`、`disableMessageTool: true` 启动（`src/agents/subagent-spawn.ts:1544-1570`），永远不会直接向渠道写消息。
- 子代理完成后走 announce 链：父会话不活跃时用 gateway `agent` 命令在父会话新起一轮，`deliver: true`，回复经 **channel outbound adapter（`sendText`）** 投递（`src/agents/subagent-announce-delivery.ts:1360-1366, 1530-1555`；`src/gateway/server-methods/agent.ts:432-456`），不经过原 inbound dispatch 的流式回调。
- `update_plan` 由 `tools.experimental.planTool: true` 开启，参数 `plan: [{step, status: pending|in_progress|completed}]`，最多一个 in_progress；结果只写入 tool `details`（`src/agents/tools/update-plan-tool.ts`）。原生 runtime **不产生** `stream: "plan"` 事件（仅 codex/copilot 扩展产生），因此 `onPlanUpdate` 不可用；`steps` 也仅为 `string[]` 无状态。
- 可用 hook（`src/plugins/hook-types.ts`）：
  - `before_tool_call` / `after_tool_call`：`event.toolName`、`event.params`、`event.result`、`event.error`；`ctx.sessionKey`。
  - `subagent_spawned`：`childSessionKey`、`label`、`requester{channel, accountId, to}`；`ctx.requesterSessionKey`。
  - `subagent_ended`：`targetSessionKey`、`outcome: ok|error|timeout|killed|reset|deleted`。
- `agents.defaults.subagents` 为 strict zod（`src/config/zod-schema.agent-defaults.ts:271`），可用键：`delegationMode, allowAgents, maxConcurrent, maxSpawnDepth, maxChildrenPerAgent, archiveAfterMinutes, model, thinking, runTimeoutSeconds, announceTimeoutMs, requireAgentId`。
- `channels.<id>.streaming.mode: "progress"` 仅内置渠道实现；钉钉插件未实现 `streaming` 适配。

### dingtalk-openclaw-connector 0.8.25

- 无任何 hook 注册（`index.ts:72-80`）。
- 回复链路只消费 `onPartialReply`、`deliver(final|block)`、`onCommandOutput`（`src/reply-dispatcher.ts:665-869, 907-1009`）。
- 卡片固定模板 `AI_CARD_TEMPLATE_ID`（`src/services/messaging/card.ts:12`），只写 `msgContent`，`PUT /v1.0/card/streaming` 使用 `isFull: true` 全量替换（`card.ts:533-541`）；`finishAICard` 置 flowStatus=3（`card.ts:599-672`）。
- `deliver(final)` → `closeStreaming` → finish；`onIdle`/`onError` 也 finish 并 seal（`reply-dispatcher.ts:797-813, 870-892`）；同轮第二个不同 `final` 会新建卡。
- outbound `sendText`（`src/channel.ts:330`）→ `sendTextToDingTalk`（`src/services/messaging.ts:682`），`useAICard` 默认 `true`（`messaging.ts:1056-1065`）→ 每次新建卡。
- `streaming` 键被代码读取（`reply-dispatcher.ts:221`）但未在 strict schema 声明（`src/config/schema.ts:109,132`）。
- 看门狗 `CARD_WATCHDOG_TIMEOUT_MS` 10 分钟（`reply-dispatcher.ts:236`），节流 `updateInterval` 800ms（`:121`）。

### 不改造时的实际表现

```
用户指令 → 第1轮：update_plan + sessions_spawn×N + sessions_yield
        → 空 final / onIdle → 卡片①被 finish
子任务完成 → announce 新轮 → 父输出 → sendText → 卡片②（NO_REPLY 则无）
最后完成 → announce 新轮 → 最终答案 → sendText → 卡片③
todo：无任何展示
```

## 4. 架构

```
钉钉消息 ──▶ message-handler ──▶ dispatchReplyFromConfig ──▶ 主控 agent 第1轮
                 │ (sessionKey 已知)                              │ update_plan / sessions_spawn×N / sessions_yield
                 ▼                                               ▼
        reply-dispatcher ──创建卡片──▶ [TaskCardRegistry] ◀── hooks: before/after_tool_call,
        (final/onIdle 在编排态不 finish)        │                   subagent_spawned/ended
                                               │ render() + streamAICard
                                               ▼
                                         同一张 AI 卡片
                                               ▲
子代理完成 ──announce──▶ 主控新一轮 ──deliver──▶ channel.sendText ──命中注册表──▶ 写入结果区 / finish
```

### 组件

| 组件 | 文件 | 职责 | 依赖 |
|---|---|---|---|
| TaskCardRegistry（新） | `src/services/task-card.ts` | 每个 `sessionKey` 至多一个任务卡状态；接口 `bind / markOrchestrating / applyPlan / onChildSpawned / onChildEnded / setAnswer / isComplete / flush / finish / forceFinish / release` | `streamAICard`、`finishAICard` |
| TaskCardRenderer（新，纯函数） | `src/services/task-card.ts` | `render(state) → markdown` | 无 |
| Hook 桥接（新） | `src/task-card-hooks.ts`，由 `index.ts` 注册 | 4 个 hook 事件 → Registry 调用；只做字段映射与过滤 | Registry |
| 既有出口分支（改） | `src/reply-dispatcher.ts`、`src/channel.ts` | dispatcher：创建卡后 `bind`；`final`/`onIdle` 先问 Registry。`sendText`：先问 Registry | Registry |

边界原则：只有 Registry 调用钉钉卡片 API（既有非编排路径除外）；hook 桥接与出口分支不直接碰 HTTP，状态机可在无网络单测中完整验证。

## 5. 数据流与状态机

### 状态

```ts
type StepStatus = "pending" | "in_progress" | "completed" | "failed";

type TaskCardState = {
  sessionKey: string;
  accountId: string;
  target: string;                      // 归一化：user:<id> | group:<cid>（与 card-bridge.ts 同一解析函数）
  card: AICardInstance;
  phase: "normal" | "orchestrating" | "finished";
  steps: Array<{ step: string; status: StepStatus; childKey?: string }>;
  children: Map<string /* childSessionKey */, { label: string; done: boolean; ok?: boolean }>;
  answer: string;
  watchdog: NodeJS.Timeout;
  renderTimer?: NodeJS.Timeout;
};
```

索引：主索引 `sessionKey`；辅助索引 `${accountId}:${target}`（仅供 `sendText` 命中判断）。

### 事件表

| # | 事件 | 来源 | Registry 动作 |
|---|---|---|---|
| 1 | 卡片创建成功 | `reply-dispatcher.startStreaming` | `bind(...)`，`phase="normal"`；若该 `sessionKey` 已有 `orchestrating` 记录则不注册（新卡由 dispatcher 按普通路径处理）。普通路径 finish 时调用 `release(sessionKey)` 移除 `normal` 记录 |
| 2 | `before_tool_call`，`toolName==="sessions_spawn"` | hook，`ctx.sessionKey` | `markOrchestrating`：`phase="orchestrating"`，启动看门狗。必须在第 1 轮结束前发生，是阻止 finish 的唯一前置条件 |
| 3 | `after_tool_call`，`toolName==="update_plan"` 且 `error` 为空 | hook，`event.params.plan` | `applyPlan`：整表替换 `steps`，按 step 文本保留已有 `childKey` 绑定；触发渲染 |
| 4 | `subagent_spawned` | hook，`ctx.requesterSessionKey` | `onChildSpawned(childKey, label)`：`steps` 中存在 `step===label` 则绑定，否则追加 `{step: label, status: "in_progress"}`；若该 step 已为 `failed`（重试）则重置为 `in_progress`；触发渲染 |
| 5 | 第 1 轮 `deliver(final)` / `onIdle` | dispatcher | `phase==="orchestrating"` → `setAnswer(text)` 并渲染，不 finish、不 seal；否则原逻辑 |
| 6 | `subagent_ended` | hook，`targetSessionKey` | `onChildEnded(childKey, outcome)`：`done=true`；绑定 step 若为 `in_progress|pending` → `ok ? completed : failed`；触发渲染；随后检查 `isComplete` |
| 7 | announce 轮 `sendText(to, text)` | `channel.ts` | 命中且 `phase==="orchestrating"` → `setAnswer(text)`；`isComplete()` ? `finish()` : 渲染。返回 `{ messageId: cardInstanceId, conversationId: to }` |
| 8 | `isComplete()` 为真（任何状态变更后检查） | 内部 | `finishAICard(render())`，`phase="finished"`，清看门狗，移除记录 |
| 9 | 看门狗到期 | 内部 | `forceFinish()`：结果区追加提示后 `finishAICard`，移除记录 |

`isComplete()` ≡ `answer` 非空 **且**（`steps` 非空且全为 `completed|failed`，**或** `steps` 为空且 `children` 非空且全 `done`）。

每个事件都刷新看门狗。

### 渲染

```
**📋 任务进度（2/4）**
- ✅ 检索竞品资料
- 🔄 分析定价策略
- ⏳ 输出对比表
- ❌ 汇总结果（失败）
---
**💬 结果**
<answer 或 "子任务执行中…">
```

- 计数 = `completed` 数 / 总数。
- 所有"触发渲染"合并进 800ms 定时器（沿用 `updateInterval`），到期调用一次 `streamAICard(card, md, false)`；`finish`/`forceFinish` 立即执行并取消挂起定时器。
- 输出经现有 `normalizeForCard`，不引入新的 markdown 处理。

### 顺序与并发

- 事件 2 早于事件 5：`before_tool_call` 在工具执行前被 await，`final`/`onIdle` 在 `sessions_yield` 之后才到。
- 同一 session 编排期间收到用户新消息：新 dispatch 走普通卡片且不进入注册表（`bind` 发现已有 orchestrating 记录即跳过），任务卡继续独立收尾。期间再次 `sessions_spawn` 触发的 `markOrchestrating` 命中现有记录，步骤并入现有任务卡。

## 6. 异常处理

| 场景 | 处理 |
|---|---|
| 子代理 `outcome ∈ {error,timeout,killed,reset,deleted}` | step 标 `failed`，卡片继续等待主控最终输出；重试产生的同 label spawn 复用该 step 并重置为 `in_progress` |
| 看门狗到期（默认 15 分钟无事件） | `forceFinish`：结果区追加「⚠️ 任务未在预期时间内完成，请重新发起或查看 /subagents」，finish，移除 |
| 最终答案早于最后一个 `subagent_ended` | `sendText` 时 `isComplete` 为假只写结果区；`onChildEnded` 后 `isComplete` 为真则由 Registry 主动 finish |
| 中间轮 `NO_REPLY` | openclaw 出站前吞掉，`sendText` 不会被调用 |
| `update_plan` 被 openclaw 校验拒绝 | `after_tool_call.error` 非空 → 忽略，保留上一版 `steps` |
| `sessions_spawn` 被拒绝（allowAgents/深度/并发） | `onIdle` 时若 `children` 为空且 `steps` 无 `in_progress` → 回退普通收尾（finish），不留悬空卡 |
| 卡片创建失败（返回 null） | 不 `bind`，所有 hook no-op，`sendText` 走原逻辑；接受降级，warn 一次 |
| 流式接口错误 | 沿用 `streamAICard` 内部重试/刷 token；渲染失败只记日志，状态机不变；下次事件全量重推（`isFull:true` 幂等） |
| 网关重启 | 内存状态丢失；旧卡由现有 `fixStuckCards` 人工收尾；不持久化 |
| `taskCard.enabled=false` | hook 立即返回；出口分支不命中；行为等同 0.8.25 |
| 群聊 `groupReplyMode ∈ {text, markdown}` | 不创建卡 → 不 `bind` → 全链路 no-op |

## 7. 配置

### 7.1 openclaw（`openclaw.json`，仅配置）

```json5
{
  tools: {
    experimental: { planTool: true },
    alsoAllow: ["sessions_spawn", "sessions_yield", "subagents"],   // profile 为 coding/full 时可省
  },
  agents: {
    defaults: {
      subagents: {
        delegationMode: "prefer",
        maxSpawnDepth: 1,
        maxChildrenPerAgent: 5,
        maxConcurrent: 4,
        runTimeoutSeconds: 900,
        announceTimeoutMs: 120000,
        model: "<openai-compat-provider>/<model>",   // 省略则继承主控
      },
    },
  },
}
```

不配置 `channels.dingtalk-connector.streaming`（插件未实现且会被 strict schema 拒绝）。

### 7.2 编排协议（主控 agent workspace 的 `AGENTS.md`）

```
需要拆分给子代理时，严格按顺序：
1. update_plan：列出全部步骤（每个子任务一条 + 末尾"汇总结果"），首条 in_progress，其余 pending。
2. 对每个子任务 sessions_spawn，label 与对应 step 文字完全一致，taskName 用 step_1、step_2…。
3. sessions_yield，本轮不输出正文。
4. 每收到一个子代理完成事件：update_plan 把该 step 标 completed、下一个标 in_progress；
   若仍有未完成子任务，回复 NO_REPLY。
5. 全部完成后：update_plan 全部 completed，然后输出最终答案（正常口吻，不转述内部元数据）。
```

协议为尽力引导：步骤 4 漏调由 `subagent_ended` 兜底；步骤 5 漏调由 `isComplete` 的「children 全 done」分支兜底。

### 7.3 插件（`src/config/schema.ts` 与 `openclaw.plugin.json` 同步）

```ts
taskCard: z.object({
  enabled: z.boolean().optional(),                       // 默认 true
  watchdogMs: z.number().int().positive().optional(),    // 默认 900_000
}).strict().optional(),
streaming: z.boolean().optional(),                       // 补声明：代码已读取但 schema 缺失
```

进入 `DingtalkSharedConfigShape`，支持账号级覆盖。

## 8. 代码改动清单

| 文件 | 改动 |
|---|---|
| `src/services/task-card.ts`（新） | Registry + Renderer + 目标归一化复用 |
| `src/task-card-hooks.ts`（新） | `registerTaskCardHooks(api)`：`before_tool_call`、`after_tool_call`、`subagent_spawned`、`subagent_ended` |
| `index.ts` | 调用 `registerTaskCardHooks(api)` |
| `src/reply-dispatcher.ts` | `startStreaming` 成功后 `bind`；普通路径 `closeStreaming` 后 `release`；`deliver(final)` 与 `onIdle` 增加编排态分支；看门狗时长改为读取 `taskCard.watchdogMs` |
| `src/channel.ts` | `sendText` 增加注册表命中分支 |
| `src/config/schema.ts`、`openclaw.plugin.json` | 新增 `taskCard`，补 `streaming` |

## 9. 测试

| 层 | 用例（含意图） |
|---|---|
| Renderer 纯函数 | 四种状态图标与计数；空 answer 占位；failed 后缀——用户能一眼分辨进度 |
| Registry 状态机（mock `streamAICard/finishAICard`） | ① orchestrating 后 `setAnswer("")` 不 finish——第 1 轮不关卡；② `applyPlan` 保留 `childKey`——重规划不丢关联；③ `onChildEnded` 使 `isComplete` 为真时主动 finish——乱序不悬空；④ `outcome!=="ok"` 标 failed 不 finish——等主控收尾；⑤ 看门狗 `forceFinish` 追加提示；⑥ 800ms 内多次变更只推一次——限流；⑦ spawn 后无 spawned 且无 in_progress → `onIdle` 回退普通收尾 |
| Hook 桥接 | 带 `error` 的 `update_plan` 忽略；`subagent_spawned` 用 `ctx.requesterSessionKey` 定位；`enabled=false` 全 no-op |
| reply-dispatcher（扩展 `tests/reply-dispatcher/card-lifecycle.test.ts`） | 编排态 `final`/`onIdle` 不调用 `finishAICard`、不 seal；非编排态与现有用例一致 |
| channel.sendText | 命中 → 不调 `sendTextToDingTalk`，返回同一 `cardInstanceId`；未命中 → 原逻辑 |
| 手工联调 | 拆 2-3 子任务指令：只 1 张卡，todo 随事件变化，最终 flowStatus=3；`/stop` 子代理后对应项 ❌ 且仍能收尾；普通问答无差异 |

## 10. 验收标准

1. 子代理模式下钉钉侧只出现一张卡片，卡片在最后一个子任务完成且主控输出后进入 FINISHED。
2. todo 状态变化在事件发生后 ≤ 1s（受 800ms 节流）反映到卡片。
3. `taskCard.enabled=false` 或普通问答路径下，`tests/` 全部既有用例通过且行为无差异。
4. 看门狗到期后不存在长期 INPUTING 的卡片。
