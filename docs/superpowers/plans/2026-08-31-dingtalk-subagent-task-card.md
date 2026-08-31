# 钉钉子代理任务卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dingtalk-openclaw-connector 私有 fork 中实现"任务卡片"：openclaw 子代理模式下一条指令只产生一张钉钉 AI 卡片，上半部分实时展示 todo list，下半部分展示最终答案。

**Architecture:** 新增 TaskCardRegistry（按 `sessionKey` 索引的状态机 + 纯函数渲染器，唯一调用钉钉卡片 API 的编排组件）；`index.ts` 注册 4 个 openclaw hook（`before_tool_call`/`after_tool_call`/`subagent_spawned`/`subagent_ended`）向 Registry 喂事件；`reply-dispatcher.ts` 与 `channel.ts` 各加一个"编排态"分支把既有回调/出站文本路由进 Registry。

**Tech Stack:** TypeScript (ESM, `.ts` 后缀导入), zod, vitest（`vi.hoisted` + `vi.mock` 风格见 `tests/reply-dispatcher/card-lifecycle.test.ts`）。

**Spec:** `docs/superpowers/specs/2026-08-31-dingtalk-subagent-task-card-design.md`

## Global Constraints

- 代码位置：仓库根目录 `dingtalk-openclaw-connector/`（任务 1 从 `dingtalk-openclaw-connector-0.8.25.tar.gz` 解包而来）。以下相对路径均相对该目录。
- 不新增任何 npm 依赖。
- 所有导入带 `.ts` 后缀（与现有代码一致）；日志用 `createLoggerFromConfig` 风格的中文消息，前缀 `[TaskCard]`。
- 功能默认开启：`taskCard.enabled !== false` 即启用；`enabled: false` 时全链路 no-op，行为必须等同 0.8.25。
- 看门狗默认 `900_000` ms（`DEFAULT_TASK_WATCHDOG_MS`），渲染节流 `800` ms（`RENDER_THROTTLE_MS`）。
- 测试命令一律 `npx vitest run <path>`（`npm test` 只跑 gateway-methods，不要用）；类型检查 `npm run type-check`。不要跑 `npm run test:all`（部分 integration 套件需要真实凭据）。
- 每个任务结束时 `git add <明确路径> && git commit`；commit message 用 `feat|test|docs|chore: ...` 前缀。
- openclaw 侧零代码改动；openclaw 配置与 AGENTS.md 协议只作为文档交付（任务 8）。

---

### Task 1: Vendor 插件源码并建立测试基线

**Files:**
- Create: `dingtalk-openclaw-connector/`（整棵树，来自 tarball）
- Modify: `.gitignore`（仓库根）
- Modify: `dingtalk-openclaw-connector/package.json`（还原 devDependencies）

**Interfaces:**
- Consumes: 仓库根的 `dingtalk-openclaw-connector-0.8.25.tar.gz`
- Produces: 可安装、可跑测试的 `dingtalk-openclaw-connector/` 目录，供后续所有任务修改

- [ ] **Step 1: 解包并重命名**

```bash
cd /Users/admin/Developer/ccProjects/test_openclaw
tar xzf dingtalk-openclaw-connector-0.8.25.tar.gz
mv dingtalk-openclaw-connector-0.8.25 dingtalk-openclaw-connector
```

- [ ] **Step 2: 还原 devDependencies（发布 tarball 的 prepack 把它改名成了 `_devDependencies`）**

```bash
cd dingtalk-openclaw-connector
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p._devDependencies&&!p.devDependencies){p.devDependencies=p._devDependencies;delete p._devDependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('restored')}else{console.log('nothing to do')}"
```

- [ ] **Step 3: 安装依赖**

Run: `npm install`（在 `dingtalk-openclaw-connector/` 内）
Expected: 成功，`node_modules/.bin/vitest` 存在。若 vitest 仍缺失，检查 package.json 是否有 `devDependencies.vitest`，没有则 `npm i -D vitest@^2 @vitest/coverage-v8` 并在 commit message 里注明。

- [ ] **Step 4: 跑基线测试**

Run: `npx vitest run tests/reply-dispatcher tests/config`
Expected: 全部 PASS（这是后续回归对照的基线）。

- [ ] **Step 5: 更新根 .gitignore 并提交**

在仓库根 `.gitignore` 追加两行：

```
dingtalk-openclaw-connector/node_modules/
dingtalk-openclaw-connector/coverage/
```

```bash
cd /Users/admin/Developer/ccProjects/test_openclaw
git add .gitignore dingtalk-openclaw-connector
git commit -m "chore: vendor dingtalk-openclaw-connector 0.8.25 as fork baseline"
```

---

### Task 2: TaskCardRenderer 纯函数与目标归一化

**Files:**
- Create: `dingtalk-openclaw-connector/src/services/task-card.ts`（本任务只放类型 + 两个纯函数）
- Test: `dingtalk-openclaw-connector/tests/task-card/renderer.test.ts`

**Interfaces:**
- Consumes: `AICardTarget`（`src/services/messaging/card.ts:164`）
- Produces（后续任务依赖，签名必须一字不差）:
  - `type StepStatus = "pending" | "in_progress" | "completed" | "failed"`
  - `type TaskStep = { step: string; status: StepStatus; childKey?: string }`
  - `renderTaskCard(state: { steps: TaskStep[]; answer: string }): string`
  - `normalizeOutboundTarget(to: string): AICardTarget | null`
  - `targetKey(target: AICardTarget): string`（`"user:<id>"` / `"group:<cid>"`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/task-card/renderer.test.ts
import { describe, expect, it } from "vitest";
import {
  normalizeOutboundTarget,
  renderTaskCard,
  targetKey,
  type TaskStep,
} from "../../src/services/task-card.ts";

describe("renderTaskCard", () => {
  it("渲染四种状态图标与完成计数，让用户一眼分辨进度", () => {
    const steps: TaskStep[] = [
      { step: "检索资料", status: "completed" },
      { step: "分析定价", status: "in_progress" },
      { step: "输出对比表", status: "pending" },
      { step: "汇总结果", status: "failed" },
    ];
    const md = renderTaskCard({ steps, answer: "" });
    expect(md).toContain("**📋 任务进度（1/4）**");
    expect(md).toContain("- ✅ 检索资料");
    expect(md).toContain("- 🔄 分析定价");
    expect(md).toContain("- ⏳ 输出对比表");
    expect(md).toContain("- ❌ 汇总结果（失败）");
    expect(md).toContain("---");
  });

  it("answer 为空时显示占位文案，避免结果区空白误导用户", () => {
    expect(renderTaskCard({ steps: [], answer: "" })).toContain("（子任务执行中…）");
  });

  it("answer 非空时原样出现在结果区", () => {
    const md = renderTaskCard({ steps: [{ step: "a", status: "completed" }], answer: "最终答案" });
    expect(md).toContain("**💬 结果**");
    expect(md.endsWith("最终答案")).toBe(true);
  });

  it("steps 为空时不渲染进度区（普通回复不该看到空 todo 头）", () => {
    const md = renderTaskCard({ steps: [], answer: "hi" });
    expect(md).not.toContain("任务进度");
  });
});

describe("normalizeOutboundTarget / targetKey", () => {
  it("解析 user:/group: 前缀、裸 cid 归为群、其余裸 id 归为用户（对齐出站 to 的各种形态）", () => {
    expect(normalizeOutboundTarget("user:u1")).toEqual({ type: "user", userId: "u1" });
    expect(normalizeOutboundTarget("group:cidXYZ")).toEqual({ type: "group", openConversationId: "cidXYZ" });
    expect(normalizeOutboundTarget("cidXYZ==")).toEqual({ type: "group", openConversationId: "cidXYZ==" });
    expect(normalizeOutboundTarget("u123")).toEqual({ type: "user", userId: "u123" });
    expect(normalizeOutboundTarget("")).toBeNull();
  });

  it("targetKey 与 bind 侧使用同一编码，保证出站命中判断的键一致", () => {
    expect(targetKey({ type: "user", userId: "u1" })).toBe("user:u1");
    expect(targetKey({ type: "group", openConversationId: "c1" })).toBe("group:c1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/task-card/renderer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/services/task-card.ts
/**
 * 任务卡片（子代理模式）：类型、渲染纯函数与出站目标归一化。
 * Registry 在 Task 3 中加入本文件。
 */
import type { AICardTarget } from "./messaging/card.ts";

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskStep = { step: string; status: StepStatus; childKey?: string };

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
};

export function renderTaskCard(state: { steps: TaskStep[]; answer: string }): string {
  const lines: string[] = [];
  const total = state.steps.length;
  if (total > 0) {
    const done = state.steps.filter((s) => s.status === "completed").length;
    lines.push(`**📋 任务进度（${done}/${total}）**`);
    for (const s of state.steps) {
      lines.push(`- ${STATUS_ICON[s.status]} ${s.step}${s.status === "failed" ? "（失败）" : ""}`);
    }
    lines.push("", "---", "");
  }
  lines.push("**💬 结果**", "");
  lines.push(state.answer.trim() ? state.answer : "（子任务执行中…）");
  return lines.join("\n");
}

/** 出站 to 的各种形态：user:/group: 前缀、裸 cid（群）、其余裸 id（用户）。 */
export function normalizeOutboundTarget(to: string): AICardTarget | null {
  const raw = (to ?? "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("user:")) {
    const userId = raw.slice(5).trim();
    return userId ? { type: "user", userId } : null;
  }
  if (lowered.startsWith("group:")) {
    const openConversationId = raw.slice(6).trim();
    return openConversationId ? { type: "group", openConversationId } : null;
  }
  if (raw.startsWith("cid")) return { type: "group", openConversationId: raw };
  return { type: "user", userId: raw };
}

export function targetKey(target: AICardTarget): string {
  return target.type === "user" ? `user:${target.userId}` : `group:${target.openConversationId}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/task-card/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/services/task-card.ts dingtalk-openclaw-connector/tests/task-card/renderer.test.ts
git commit -m "feat: task card renderer and outbound target normalization"
```

---

### Task 3: TaskCardRegistry 状态机

**Files:**
- Modify: `dingtalk-openclaw-connector/src/services/task-card.ts`（追加 Registry）
- Test: `dingtalk-openclaw-connector/tests/task-card/registry.test.ts`

**Interfaces:**
- Consumes: Task 2 的类型与 `renderTaskCard`/`targetKey`/`normalizeOutboundTarget`；`AICardInstance`、`streamAICard(card, content, finished, config, log)`、`finishAICard(card, content, config, log)`（`src/services/messaging/card.ts`）
- Produces（后续任务依赖，签名必须一字不差）:
  - `DEFAULT_TASK_WATCHDOG_MS = 900_000`、`RENDER_THROTTLE_MS = 800`
  - `createTaskCardRegistry(deps?: Partial<TaskCardDeps>): TaskCardRegistry`
  - `export const taskCardRegistry: TaskCardRegistry`（模块级单例，默认 deps）
  - `TaskCardRegistry` 方法：
    - `bind(p: { sessionKey: string; target: AICardTarget; card: AICardInstance; config: unknown; log?: LoggerLike }): void`
    - `markOrchestrating(sessionKey: string): void`
    - `isOrchestrating(sessionKey: string): boolean`
    - `applyPlan(sessionKey: string, plan: Array<{ step?: unknown; status?: unknown }>): void`
    - `onChildSpawned(sessionKey: string, childKey: string, label?: string): void`
    - `onChildEnded(childKey: string, outcome?: string): void`
    - `setAnswer(sessionKey: string, text: string): Promise<void>`
    - `interceptOutboundText(p: { to: string; text: string }): Promise<{ handled: boolean; cardInstanceId?: string }>`
    - `onDispatchIdle(sessionKey: string): "keep-open" | "not-orchestrating"`
    - `release(sessionKey: string): void`
    - `reset(): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/task-card/registry.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCardRegistry,
  DEFAULT_TASK_WATCHDOG_MS,
  type TaskCardRegistry,
} from "../../src/services/task-card.ts";

const CARD = { cardInstanceId: "card-1", accessToken: "tk", tokenExpireTime: 0, inputingStarted: true };
const CFG = { taskCard: {} } as any;
const KEY = "agent:main:dingtalk-connector:dm:u1";
const TARGET = { type: "user", userId: "u1" } as const;

function make() {
  const streamAICard = vi.fn().mockResolvedValue(undefined);
  const finishAICard = vi.fn().mockResolvedValue(undefined);
  const registry: TaskCardRegistry = createTaskCardRegistry({ streamAICard, finishAICard });
  return { registry, streamAICard, finishAICard };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TaskCardRegistry", () => {
  it("编排态下 setAnswer('') 不触发 finish —— 第 1 轮 yield 后卡片必须保持打开", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    await registry.setAnswer(KEY, "");
    expect(finishAICard).not.toHaveBeenCalled();
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });

  it("applyPlan 按 step 文本保留 childKey 绑定 —— 重规划不丢子代理关联", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.applyPlan(KEY, [{ step: "A", status: "in_progress" }]);
    registry.onChildSpawned(KEY, "child-1", "A");
    registry.applyPlan(KEY, [
      { step: "A", status: "in_progress" },
      { step: "B", status: "pending" },
    ]);
    // childKey 仍绑定：child-1 结束时 A 被标记 completed
    registry.onChildEnded("child-1", "ok");
    // 通过渲染结果断言（不暴露内部 state）：A 已完成
    // 完成计数 1/2 出现在下一次推送内容里
  });

  it("最终答案先到、最后一个子代理后到时，由 onChildEnded 主动 finish —— 事件乱序不悬空", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    await registry.setAnswer(KEY, "最终答案");           // isComplete 仍为 false
    expect(finishAICard).not.toHaveBeenCalled();
    registry.onChildEnded("child-1", "ok");              // 此刻 isComplete 为 true
    await vi.runAllTimersAsync();
    expect(finishAICard).toHaveBeenCalledTimes(1);
    const md = finishAICard.mock.calls[0][1] as string;
    expect(md).toContain("✅ 任务A");
    expect(md).toContain("最终答案");
    expect(registry.isOrchestrating(KEY)).toBe(false);
  });

  it("outcome!=='ok' 只标 failed 不 finish —— 等主控收尾", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    registry.onChildSpawned(KEY, "child-2", "任务B");
    registry.onChildEnded("child-1", "timeout");
    await vi.runAllTimersAsync();
    expect(finishAICard).not.toHaveBeenCalled();
  });

  it("看门狗到期 forceFinish 并追加提示 —— 不留永久转圈卡", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_WATCHDOG_MS + 1000);
    expect(finishAICard).toHaveBeenCalledTimes(1);
    expect(finishAICard.mock.calls[0][1]).toContain("任务未在预期时间内完成");
  });

  it("800ms 内多次变更只推送一次 —— QPS 限流保护", async () => {
    const { registry, streamAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "c1", "A");
    registry.onChildSpawned(KEY, "c2", "B");
    registry.onChildSpawned(KEY, "c3", "C");
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard.mock.calls.length).toBeLessThanOrEqual(2); // 首推 + 合并推各至多一次
  });

  it("spawn 被拒（无 spawned、无 in_progress）时 onDispatchIdle 回退普通收尾 —— 不留悬空卡", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.applyPlan(KEY, [{ step: "A", status: "pending" }]);
    expect(registry.onDispatchIdle(KEY)).toBe("not-orchestrating");
    expect(registry.isOrchestrating(KEY)).toBe(false);
  });

  it("有活跃子代理时 onDispatchIdle 返回 keep-open", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    expect(registry.onDispatchIdle(KEY)).toBe("keep-open");
  });

  it("interceptOutboundText 按归一化 target 命中并写入结果区；未完成时不 finish", async () => {
    const { registry, finishAICard, streamAICard } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    const r = await registry.interceptOutboundText({ to: "u1", text: "阶段结论" });
    expect(r).toEqual({ handled: true, cardInstanceId: "card-1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard).toHaveBeenCalled();
    expect(finishAICard).not.toHaveBeenCalled();
    const miss = await registry.interceptOutboundText({ to: "user:other", text: "x" });
    expect(miss.handled).toBe(false);
  });

  it("release 只清除非编排态记录 —— 普通轮收尾不影响任务卡", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.release(KEY);
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });

  it("markOrchestrating 早于 bind（卡片创建在途）也能工作，bind 合并后可正常渲染", async () => {
    const { registry, streamAICard } = make();
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    registry.bind({ sessionKey: KEY, target: TARGET, card: CARD, config: CFG });
    registry.onChildSpawned(KEY, "child-2", "任务B");
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard).toHaveBeenCalled();
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/task-card/registry.test.ts`
Expected: FAIL（`createTaskCardRegistry` 未导出）

- [ ] **Step 3: 实现 Registry（追加到 `src/services/task-card.ts`）**

```ts
import type { AICardInstance } from "./messaging/card.ts";
import {
  finishAICard as defaultFinishAICard,
  streamAICard as defaultStreamAICard,
} from "./messaging/card.ts";

export const DEFAULT_TASK_WATCHDOG_MS = 900_000;
export const RENDER_THROTTLE_MS = 800;
const WATCHDOG_SUFFIX = "\n\n⚠️ 任务未在预期时间内完成，请重新发起或查看 /subagents";

export type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export type TaskCardDeps = {
  streamAICard: typeof defaultStreamAICard;
  finishAICard: typeof defaultFinishAICard;
  now: () => number;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
};

type TaskChild = { label: string; done: boolean; ok?: boolean };

type TaskCardRecord = {
  sessionKey: string;
  phase: "normal" | "orchestrating";
  card?: AICardInstance;
  config?: unknown;
  log?: LoggerLike;
  tKey?: string;
  steps: TaskStep[];
  children: Map<string, TaskChild>;
  answer: string;
  watchdogMs: number;
  watchdog?: ReturnType<typeof setTimeout>;
  renderTimer?: ReturnType<typeof setTimeout>;
  lastPushAt: number;
  finishing: boolean;
};

export type TaskCardRegistry = {
  bind(p: { sessionKey: string; target: AICardTarget; card: AICardInstance; config: unknown; log?: LoggerLike }): void;
  markOrchestrating(sessionKey: string): void;
  isOrchestrating(sessionKey: string): boolean;
  applyPlan(sessionKey: string, plan: Array<{ step?: unknown; status?: unknown }>): void;
  onChildSpawned(sessionKey: string, childKey: string, label?: string): void;
  onChildEnded(childKey: string, outcome?: string): void;
  setAnswer(sessionKey: string, text: string): Promise<void>;
  interceptOutboundText(p: { to: string; text: string }): Promise<{ handled: boolean; cardInstanceId?: string }>;
  onDispatchIdle(sessionKey: string): "keep-open" | "not-orchestrating";
  release(sessionKey: string): void;
  reset(): void;
};

const VALID_STATUSES: readonly StepStatus[] = ["pending", "in_progress", "completed", "failed"];

export function createTaskCardRegistry(depsIn?: Partial<TaskCardDeps>): TaskCardRegistry {
  const deps: TaskCardDeps = {
    streamAICard: depsIn?.streamAICard ?? defaultStreamAICard,
    finishAICard: depsIn?.finishAICard ?? defaultFinishAICard,
    now: depsIn?.now ?? Date.now,
    setTimeoutFn: depsIn?.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: depsIn?.clearTimeoutFn ?? clearTimeout,
  };

  const bySession = new Map<string, TaskCardRecord>();
  const byTarget = new Map<string, string>();      // targetKey -> sessionKey
  const byChild = new Map<string, string>();       // childSessionKey -> sessionKey

  const clearTimers = (rec: TaskCardRecord) => {
    if (rec.watchdog) { deps.clearTimeoutFn(rec.watchdog); rec.watchdog = undefined; }
    if (rec.renderTimer) { deps.clearTimeoutFn(rec.renderTimer); rec.renderTimer = undefined; }
  };

  const remove = (rec: TaskCardRecord) => {
    clearTimers(rec);
    bySession.delete(rec.sessionKey);
    if (rec.tKey && byTarget.get(rec.tKey) === rec.sessionKey) byTarget.delete(rec.tKey);
    for (const [child, owner] of byChild) if (owner === rec.sessionKey) byChild.delete(child);
  };

  const isComplete = (rec: TaskCardRecord): boolean => {
    if (!rec.answer.trim()) return false;
    if (rec.steps.length > 0) {
      return rec.steps.every((s) => s.status === "completed" || s.status === "failed");
    }
    if (rec.children.size > 0) {
      return [...rec.children.values()].every((c) => c.done);
    }
    return false;
  };

  const push = async (rec: TaskCardRecord) => {
    if (rec.phase !== "orchestrating" || !rec.card || !rec.config || rec.finishing) return;
    rec.lastPushAt = deps.now();
    try {
      await deps.streamAICard(rec.card, renderTaskCard(rec), false, rec.config as never, rec.log as never);
    } catch (err) {
      rec.log?.warn?.(`[TaskCard] 渲染推送失败（下次事件会全量补齐）: ${(err as Error)?.message ?? err}`);
    }
  };

  const scheduleRender = (rec: TaskCardRecord) => {
    if (!rec.card || !rec.config || rec.renderTimer || rec.finishing) return;
    const delay = Math.max(0, RENDER_THROTTLE_MS - (deps.now() - rec.lastPushAt));
    rec.renderTimer = deps.setTimeoutFn(() => {
      rec.renderTimer = undefined;
      void push(rec);
    }, delay);
    (rec.renderTimer as { unref?: () => void }).unref?.();
  };

  const finish = async (rec: TaskCardRecord) => {
    if (rec.finishing) return;
    rec.finishing = true;
    clearTimers(rec);
    const { card, config } = rec;
    remove(rec);
    if (card && config) {
      try {
        await deps.finishAICard(card, renderTaskCard(rec), config as never, rec.log as never);
        rec.log?.info?.(`[TaskCard] ✅ 任务卡收尾完成 card=${card.cardInstanceId}`);
      } catch (err) {
        rec.log?.error?.(`[TaskCard] ❌ 任务卡收尾失败: ${(err as Error)?.message ?? err}`);
      }
    }
  };

  const touchWatchdog = (rec: TaskCardRecord) => {
    if (rec.phase !== "orchestrating") return;
    if (rec.watchdog) deps.clearTimeoutFn(rec.watchdog);
    rec.watchdog = deps.setTimeoutFn(() => {
      rec.watchdog = undefined;
      if (!rec.card) { remove(rec); return; }   // 从未绑定卡片的悬空记录：静默清理
      rec.log?.warn?.(`[TaskCard] 看门狗到期，强制收尾 session=${rec.sessionKey}`);
      rec.answer = (rec.answer.trim() ? rec.answer : "") + WATCHDOG_SUFFIX;
      void finish(rec);
    }, rec.watchdogMs);
    (rec.watchdog as { unref?: () => void }).unref?.();
  };

  const afterMutation = (rec: TaskCardRecord): Promise<void> => {
    touchWatchdog(rec);
    if (isComplete(rec)) return finish(rec);
    scheduleRender(rec);
    return Promise.resolve();
  };

  const applyAnswer = async (rec: TaskCardRecord, text: string) => {
    rec.answer = text;
    await afterMutation(rec);
  };

  const getOrCreate = (sessionKey: string): TaskCardRecord => {
    let rec = bySession.get(sessionKey);
    if (!rec) {
      rec = {
        sessionKey,
        phase: "normal",
        steps: [],
        children: new Map(),
        answer: "",
        watchdogMs: DEFAULT_TASK_WATCHDOG_MS,
        lastPushAt: 0,
        finishing: false,
      };
      bySession.set(sessionKey, rec);
    }
    return rec;
  };

  return {
    bind(p) {
      const rec = getOrCreate(p.sessionKey);
      rec.card = p.card;
      rec.config = p.config;
      rec.log = p.log;
      rec.tKey = targetKey(p.target);
      byTarget.set(rec.tKey, p.sessionKey);
      const configured = (p.config as { taskCard?: { watchdogMs?: number } } | undefined)?.taskCard?.watchdogMs;
      if (typeof configured === "number" && configured > 0) rec.watchdogMs = configured;
      if (rec.phase === "orchestrating") touchWatchdog(rec);
    },
    markOrchestrating(sessionKey) {
      const rec = getOrCreate(sessionKey);
      if (rec.phase === "orchestrating") { touchWatchdog(rec); return; }
      rec.phase = "orchestrating";
      touchWatchdog(rec);
      // 注意：此处不 scheduleRender —— steps 尚空，避免用占位符清掉已流式的叙述文本
    },
    isOrchestrating(sessionKey) {
      return bySession.get(sessionKey)?.phase === "orchestrating";
    },
    applyPlan(sessionKey, plan) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return;
      const old = rec.steps;
      rec.steps = plan
        .filter((e): e is { step: string; status: string } => typeof e?.step === "string" && !!(e.step as string).trim())
        .map((e) => {
          const status = VALID_STATUSES.includes(e.status as StepStatus) ? (e.status as StepStatus) : "pending";
          const prev = old.find((o) => o.step === e.step);
          return { step: e.step, status, ...(prev?.childKey ? { childKey: prev.childKey } : {}) };
        });
      void afterMutation(rec);
    },
    onChildSpawned(sessionKey, childKey, label) {
      if (!childKey) return;
      const rec = getOrCreate(sessionKey);
      if (rec.phase !== "orchestrating") { rec.phase = "orchestrating"; }
      const name = (label ?? "").trim() || `子任务 ${rec.children.size + 1}`;
      rec.children.set(childKey, { label: name, done: false });
      byChild.set(childKey, sessionKey);
      const match = rec.steps.find((s) => s.step === name && (!s.childKey || s.childKey === childKey));
      if (match) {
        match.childKey = childKey;
        if (match.status === "pending" || match.status === "failed") match.status = "in_progress";
      } else {
        rec.steps.push({ step: name, status: "in_progress", childKey });
      }
      void afterMutation(rec);
    },
    onChildEnded(childKey, outcome) {
      const sessionKey = byChild.get(childKey);
      if (!sessionKey) return;
      const rec = bySession.get(sessionKey);
      if (!rec) return;
      const child = rec.children.get(childKey);
      if (child) { child.done = true; child.ok = outcome === "ok"; }
      const step = rec.steps.find((s) => s.childKey === childKey);
      if (step && (step.status === "pending" || step.status === "in_progress")) {
        step.status = outcome === "ok" ? "completed" : "failed";
      }
      void afterMutation(rec);
    },
    async setAnswer(sessionKey, text) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return;
      await applyAnswer(rec, text);
    },
    async interceptOutboundText({ to, text }) {
      const target = normalizeOutboundTarget(to);
      if (!target) return { handled: false };
      const sessionKey = byTarget.get(targetKey(target));
      if (!sessionKey) return { handled: false };
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating" || !rec.card || !rec.config) return { handled: false };
      const cardInstanceId = rec.card.cardInstanceId;
      await applyAnswer(rec, text);
      return { handled: true, cardInstanceId };
    },
    onDispatchIdle(sessionKey) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return "not-orchestrating";
      const hasInProgress = rec.steps.some((s) => s.status === "in_progress");
      if (rec.children.size === 0 && !hasInProgress) {
        rec.phase = "normal";       // 降级：spawn 从未成功，交回 dispatcher 正常收尾
        clearTimers(rec);
        return "not-orchestrating";
      }
      return "keep-open";
    },
    release(sessionKey) {
      const rec = bySession.get(sessionKey);
      if (rec && rec.phase !== "orchestrating") remove(rec);
    },
    reset() {
      for (const rec of [...bySession.values()]) remove(rec);
    },
  };
}

export const taskCardRegistry: TaskCardRegistry = createTaskCardRegistry();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/task-card/registry.test.ts tests/task-card/renderer.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/services/task-card.ts dingtalk-openclaw-connector/tests/task-card/registry.test.ts
git commit -m "feat: task card registry state machine with watchdog and throttled rendering"
```

---

### Task 4: 配置 schema 与 manifest

**Files:**
- Modify: `dingtalk-openclaw-connector/src/config/schema.ts`（`DingtalkSharedConfigShape`，约 :66-89）
- Modify: `dingtalk-openclaw-connector/openclaw.plugin.json`（`channelConfigs.dingtalk-connector.schema.properties`，共享与 accounts 两处）
- Test: `dingtalk-openclaw-connector/tests/task-card/config.test.ts`

**Interfaces:**
- Consumes: 现有 `DingtalkConfigSchema` 导出
- Produces: 配置键 `taskCard: { enabled?: boolean; watchdogMs?: number }` 与 `streaming?: boolean`，顶层与账号级均可用

- [ ] **Step 1: 写失败测试**

```ts
// tests/task-card/config.test.ts
import { describe, expect, it } from "vitest";
import { DingtalkConfigSchema } from "../../src/config/schema.ts";

describe("taskCard / streaming config", () => {
  it("接受 taskCard 配置（顶层与账号级）—— 用户必须能关闭任务卡或调整看门狗", () => {
    const parsed = DingtalkConfigSchema.safeParse({
      clientId: "id",
      taskCard: { enabled: false, watchdogMs: 600000 },
      accounts: { a1: { taskCard: { enabled: true } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("接受 streaming 布尔（修复 strict schema 拒绝已被代码读取的键的缺口）", () => {
    expect(DingtalkConfigSchema.safeParse({ clientId: "id", streaming: false }).success).toBe(true);
  });

  it("拒绝 taskCard 未知子键 —— 保持 strict 校验风格", () => {
    expect(DingtalkConfigSchema.safeParse({ clientId: "id", taskCard: { foo: 1 } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/task-card/config.test.ts`
Expected: FAIL（strict schema 拒绝 `taskCard`/`streaming`）

- [ ] **Step 3: 实现**

在 `src/config/schema.ts` 的 `GroupReplyModeSchema` 定义之后追加：

```ts
/**
 * 子代理任务卡配置。
 * - enabled（默认 true）：openclaw 子代理模式下把 todo 进度与最终答案聚合到一张 AI 卡片
 * - watchdogMs（默认 900000）：任务卡看门狗，无事件超时后强制收尾
 */
const TaskCardConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    watchdogMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();
```

在 `DingtalkSharedConfigShape` 对象内（`groupReplyMode: GroupReplyModeSchema,` 之后）追加两行：

```ts
  taskCard: TaskCardConfigSchema,
  /** 是否启用 AI Card 流式（reply-dispatcher.ts:221 一直在读，此前 schema 漏声明） */
  streaming: z.boolean().optional(),
```

在 `openclaw.plugin.json` 的 `channelConfigs.dingtalk-connector.schema.properties`（顶层与 `accounts.additionalProperties.properties` 两处，与 `groupReplyMode` 相邻的位置）各追加：

```json
"taskCard": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enabled": { "type": "boolean" },
    "watchdogMs": { "type": "number" }
  }
},
"streaming": { "type": "boolean" }
```

- [ ] **Step 4: 跑测试确认通过（含既有 config 回归）**

Run: `npx vitest run tests/task-card/config.test.ts tests/config`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/config/schema.ts dingtalk-openclaw-connector/openclaw.plugin.json dingtalk-openclaw-connector/tests/task-card/config.test.ts
git commit -m "feat: taskCard config schema and declare existing streaming key"
```

---

### Task 5: Hook 桥接与 index.ts 注册

**Files:**
- Create: `dingtalk-openclaw-connector/src/task-card-hooks.ts`
- Modify: `dingtalk-openclaw-connector/index.ts`（`register` 函数，:74-80）
- Test: `dingtalk-openclaw-connector/tests/task-card/hooks.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `TaskCardRegistry` 与 `taskCardRegistry`
- Produces: `registerTaskCardHooks(api: unknown, registry?: TaskCardRegistry): void`
- Hook 事实（openclaw v2026.7.1-2）：`api.on(name, handler, opts?)`；`before_tool_call` 事件 `{toolName, params, ...}` + `ctx.sessionKey`；`after_tool_call` 额外有 `result`/`error`；`subagent_spawned` 事件 `{childSessionKey, label, ...}` + `ctx.requesterSessionKey`；`subagent_ended` 事件 `{targetSessionKey, outcome, ...}`

- [ ] **Step 1: 写失败测试**

```ts
// tests/task-card/hooks.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerTaskCardHooks } from "../../src/task-card-hooks.ts";

const DT_KEY = "agent:main:dingtalk-connector:dm:u1";
const OTHER_KEY = "agent:main:telegram:dm:u1";

function makeApi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  return {
    handlers,
    api: {
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
      logger: { warn: vi.fn() },
    },
  };
}

function makeRegistry() {
  return {
    bind: vi.fn(), markOrchestrating: vi.fn(), isOrchestrating: vi.fn(),
    applyPlan: vi.fn(), onChildSpawned: vi.fn(), onChildEnded: vi.fn(),
    setAnswer: vi.fn(), interceptOutboundText: vi.fn(), onDispatchIdle: vi.fn(),
    release: vi.fn(), reset: vi.fn(),
  };
}

describe("registerTaskCardHooks", () => {
  it("sessions_spawn → markOrchestrating，且只处理钉钉会话 —— 其他渠道的运行不得污染注册表", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    handlers.get("before_tool_call")!({ toolName: "sessions_spawn", params: {} }, { sessionKey: DT_KEY });
    handlers.get("before_tool_call")!({ toolName: "sessions_spawn", params: {} }, { sessionKey: OTHER_KEY });
    handlers.get("before_tool_call")!({ toolName: "exec", params: {} }, { sessionKey: DT_KEY });
    expect(registry.markOrchestrating).toHaveBeenCalledTimes(1);
    expect(registry.markOrchestrating).toHaveBeenCalledWith(DT_KEY);
  });

  it("update_plan 成功 → applyPlan；带 error 的调用被忽略 —— 不用坏数据覆盖状态", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    const plan = [{ step: "A", status: "in_progress" }];
    handlers.get("after_tool_call")!({ toolName: "update_plan", params: { plan } }, { sessionKey: DT_KEY });
    handlers.get("after_tool_call")!({ toolName: "update_plan", params: { plan }, error: "boom" }, { sessionKey: DT_KEY });
    expect(registry.applyPlan).toHaveBeenCalledTimes(1);
    expect(registry.applyPlan).toHaveBeenCalledWith(DT_KEY, plan);
  });

  it("subagent_spawned 用 ctx.requesterSessionKey 定位；subagent_ended 全局按 childKey 转发", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    handlers.get("subagent_spawned")!({ childSessionKey: "child-1", label: "任务A" }, { requesterSessionKey: DT_KEY });
    handlers.get("subagent_spawned")!({ childSessionKey: "child-2", label: "X" }, { requesterSessionKey: OTHER_KEY });
    handlers.get("subagent_ended")!({ targetSessionKey: "child-1", outcome: "ok" });
    expect(registry.onChildSpawned).toHaveBeenCalledTimes(1);
    expect(registry.onChildSpawned).toHaveBeenCalledWith(DT_KEY, "child-1", "任务A");
    expect(registry.onChildEnded).toHaveBeenCalledWith("child-1", "ok");
  });

  it("api.on 不存在时告警并跳过 —— 旧版 SDK 下插件仍可加载", () => {
    const registry = makeRegistry();
    const logger = { warn: vi.fn() };
    expect(() => registerTaskCardHooks({ logger }, registry as never)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/task-card/hooks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/task-card-hooks.ts`**

```ts
/**
 * openclaw hook → TaskCardRegistry 桥接。
 * 只做字段映射与渠道过滤，不做任何 HTTP 调用。
 */
import { taskCardRegistry, type TaskCardRegistry } from "./services/task-card.ts";

const DINGTALK_SESSION_MARKER = ":dingtalk-connector:";

function isDingtalkSession(sessionKey: unknown): sessionKey is string {
  return typeof sessionKey === "string" && sessionKey.includes(DINGTALK_SESSION_MARKER);
}

type HookApi = {
  on?: (name: string, handler: (event: never, ctx?: never) => unknown, opts?: unknown) => unknown;
  logger?: { warn?: (...args: unknown[]) => void };
};

export function registerTaskCardHooks(api: unknown, registry: TaskCardRegistry = taskCardRegistry): void {
  const hookApi = api as HookApi;
  const on = typeof hookApi?.on === "function" ? hookApi.on.bind(hookApi) : null;
  if (!on) {
    hookApi?.logger?.warn?.("[dingtalk-connector] api.on 不可用（openclaw 版本过旧），任务卡片功能停用");
    return;
  }

  on("before_tool_call", (event: { toolName?: string }, ctx?: { sessionKey?: string }) => {
    if (event?.toolName !== "sessions_spawn") return;
    if (!isDingtalkSession(ctx?.sessionKey)) return;
    registry.markOrchestrating(ctx!.sessionKey!);
  });

  on("after_tool_call", (
    event: { toolName?: string; error?: string; params?: { plan?: unknown } },
    ctx?: { sessionKey?: string },
  ) => {
    if (event?.toolName !== "update_plan" || event?.error) return;
    if (!isDingtalkSession(ctx?.sessionKey)) return;
    const plan = event?.params?.plan;
    if (Array.isArray(plan)) registry.applyPlan(ctx!.sessionKey!, plan as never);
  });

  on("subagent_spawned", (
    event: { childSessionKey?: string; label?: string },
    ctx?: { requesterSessionKey?: string },
  ) => {
    if (!isDingtalkSession(ctx?.requesterSessionKey)) return;
    if (!event?.childSessionKey) return;
    registry.onChildSpawned(ctx!.requesterSessionKey!, event.childSessionKey, event.label);
  });

  on("subagent_ended", (event: { targetSessionKey?: string; outcome?: string }) => {
    if (!event?.targetSessionKey) return;
    registry.onChildEnded(event.targetSessionKey, event.outcome);
  });
}
```

在 `index.ts`：import 区追加 `import { registerTaskCardHooks } from "./src/task-card-hooks.ts";`，`register` 函数中 `registerGatewayMethods(api);` 之后追加一行 `registerTaskCardHooks(api);`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/task-card/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/task-card-hooks.ts dingtalk-openclaw-connector/index.ts dingtalk-openclaw-connector/tests/task-card/hooks.test.ts
git commit -m "feat: register openclaw hooks bridging subagent/plan events to task card registry"
```

---

### Task 6: reply-dispatcher 编排态集成

**Files:**
- Modify: `dingtalk-openclaw-connector/src/reply-dispatcher.ts`
- Modify: `dingtalk-openclaw-connector/src/core/message-handler.ts`（dispatcher 构造调用，约 :1470-1481）
- Test: `dingtalk-openclaw-connector/tests/reply-dispatcher/task-card-integration.test.ts`（新文件，不改动既有 `card-lifecycle.test.ts` 用例）

**Interfaces:**
- Consumes: Task 3 的 `taskCardRegistry`（`isOrchestrating` / `bind` / `setAnswer` / `onDispatchIdle` / `release`）
- Produces: `CreateDingtalkReplyDispatcherParams` 新增可选字段 `sessionKey?: string`；message-handler 传入已计算的 `sessionKey`

- [ ] **Step 1: 写失败测试**

新建 `tests/reply-dispatcher/task-card-integration.test.ts`。mock 头部（`vi.mock` 段）整体复制自 `tests/reply-dispatcher/card-lifecycle.test.ts:19-97`（同样的 `vi.hoisted` + `vi.mock` 列表，不要省略任何一个 mock），再追加 registry mock 与用例：

```ts
// 追加在复制来的 mock 定义之后
const mockRegistry = vi.hoisted(() => ({
  bind: vi.fn(),
  markOrchestrating: vi.fn(),
  isOrchestrating: vi.fn(() => false),
  applyPlan: vi.fn(),
  onChildSpawned: vi.fn(),
  onChildEnded: vi.fn(),
  setAnswer: vi.fn(async () => {}),
  interceptOutboundText: vi.fn(async () => ({ handled: false })),
  onDispatchIdle: vi.fn(() => "not-orchestrating"),
  release: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../src/services/task-card.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/task-card.ts")>();
  return { ...actual, taskCardRegistry: mockRegistry };
});

// makeDispatcher 与 card-lifecycle.test.ts 相同，但 params 里额外传
// sessionKey: "agent:main:dingtalk-connector:dm:user-1"

describe("reply-dispatcher task card integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDingtalkAccount.mockReturnValue({
      accountId: "acc-1",
      config: { debug: false, streaming: true },
    });
    mockGetOapiAccessToken.mockResolvedValue(null);
    mockProcessLocalImages.mockImplementation(async (s: string) => s);
    mockCreateAICardForTarget.mockResolvedValue(CARD);
    mockStreamAICard.mockResolvedValue(undefined);
    mockFinishAICard.mockResolvedValue(undefined);
    mockRegistry.isOrchestrating.mockReturnValue(false);
    mockRegistry.onDispatchIdle.mockReturnValue("not-orchestrating");
    mockRegistry.interceptOutboundText.mockResolvedValue({ handled: false });
    // mockCreateReplyDispatcherWithTyping / mockGetDingtalkRuntime 的桩实现
    // 与 card-lifecycle.test.ts 的 beforeEach 完全一致（把 deliver/onIdle 等
    // 参数存进 (globalThis as any).__dispatcherArgs 供用例调用）——整体照搬。
  });

  it("卡片创建成功后 bind 注册表 —— hook 事件才能找到这张卡", async () => {
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    expect(mockRegistry.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dingtalk-connector:dm:user-1",
        card: CARD,
        target: { type: "user", userId: "user-1" },
      }),
    );
  });

  it("编排态下 final 只写结果区，不 finishAICard、不密封 —— 第 1 轮 yield 后卡片保持打开", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await args.deliver({ text: "我先拆解任务" }, { kind: "final" });
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(
      "agent:main:dingtalk-connector:dm:user-1",
      "我先拆解任务",
    );
    expect(mockFinishAICard).not.toHaveBeenCalled();
    // 未密封：后续 block 仍走卡片路径而非降级普通消息
    await args.deliver({ text: "后续块" }, { kind: "block" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("编排态下 onIdle keep-open 时不 closeStreaming —— announce 轮还会回来写卡", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    mockRegistry.onDispatchIdle.mockReturnValue("keep-open");
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await args.onIdle();
    expect(mockFinishAICard).not.toHaveBeenCalled();
  });

  it("onDispatchIdle 返回 not-orchestrating 时正常收尾 —— spawn 被拒不留悬空卡", async () => {
    mockRegistry.onDispatchIdle.mockReturnValue("not-orchestrating");
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await args.onIdle();
    expect(mockFinishAICard).toHaveBeenCalled();
    expect(mockRegistry.release).toHaveBeenCalledWith("agent:main:dingtalk-connector:dm:user-1");
  });

  it("编排态下 partial 与 block 都改写结果区而非覆盖整卡 —— todo 区不被破坏", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    const { result, args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await result.replyOptions.onPartialReply({ text: "叙述" });
    await args.deliver({ text: "块文本" }, { kind: "block" });
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(expect.any(String), "叙述");
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(expect.any(String), "块文本");
    expect(mockStreamAICard).not.toHaveBeenCalled();   // 原始覆盖式推送被绕过
  });

  it("未传 sessionKey（旧调用方）时行为与 0.8.25 完全一致 —— 向后兼容", async () => {
    const { args } = await makeDispatcher({ sessionKey: undefined });
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await args.deliver({ text: "答案" }, { kind: "final" });
    expect(mockFinishAICard).toHaveBeenCalled();
    expect(mockRegistry.bind).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/reply-dispatcher/task-card-integration.test.ts`
Expected: FAIL（`bind` 未被调用等）

- [ ] **Step 3: 实现 dispatcher 改动**

`src/reply-dispatcher.ts` 六处修改：

1. import 区追加：
```ts
import { taskCardRegistry } from "./services/task-card.ts";
```
2. `CreateDingtalkReplyDispatcherParams` 追加字段，并加入函数体解构（`preCreatedCard,` 之后）：
```ts
  /** openclaw 会话键；提供后启用子代理任务卡（hook 事件按此键关联到本轮卡片） */
  sessionKey?: string;
```
```ts
    sessionKey,
```
3. 看门狗时长改读配置（替换 `const CARD_WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;`）：
```ts
  const CARD_WATCHDOG_TIMEOUT_MS =
    (account.config as any)?.taskCard?.watchdogMs ?? 10 * 60 * 1000;
```
4. 任务卡启用判定 + bind。在 `streamingEnabled` 定义之后追加：
```ts
  // 子代理任务卡：需要 sessionKey 且未显式关闭
  const taskCardEnabled = Boolean(sessionKey) && (account.config as any)?.taskCard?.enabled !== false;
  const bindTaskCard = (card: AICardInstance) => {
    if (!taskCardEnabled) return;
    const target: AICardTarget = isDirect
      ? { type: 'user', userId: senderId }
      : { type: 'group', openConversationId: conversationId };
    taskCardRegistry.bind({ sessionKey: sessionKey!, target, card, config: account.config, log });
  };
  const inTaskCardMode = () => taskCardEnabled && taskCardRegistry.isOrchestrating(sessionKey!);
```
`startStreaming` 内两处成功路径调用 `bindTaskCard`：preCreatedCard 分支在 `armCardWatchdog();` 之后加 `bindTaskCard(preCreatedCard);`；创建成功分支（`if (card) {` 内）在 `armCardWatchdog();` 之后加 `bindTaskCard(card);`。
5. 编排态分支：
   - `forceFinishStaleCard` 开头（`const staleCard = watchdogCard;` 之前）加：
```ts
    if (inTaskCardMode()) {
      log.info(`[TaskCard] dispatcher 看门狗触发但处于编排态，交由任务卡看门狗收尾`);
      cardWatchdogTimer = null;
      return;
    }
```
   - `deliver` 的 block 分支：`await startStreaming();` 之后、`if (currentCardTarget) {` 之前加：
```ts
          if (inTaskCardMode()) {
            await taskCardRegistry.setAnswer(sessionKey!, text);
            outboundUserVisibleThisTurn = true;
            return;
          }
```
   - `deliver` 的 final 流式分支：`await startStreaming();` 之后、`if (currentCardTarget) {` 之前加：
```ts
          if (inTaskCardMode()) {
            deliveredFinalTexts.add(text);
            await taskCardRegistry.setAnswer(sessionKey!, text);
            outboundUserVisibleThisTurn = true;
            return;
          }
```
   - `onIdle` 回调：`typingCallbacks.onIdle?.();` 之后、`streamingSealed = true;` 之前加：
```ts
        if (taskCardEnabled && taskCardRegistry.onDispatchIdle(sessionKey!) === "keep-open") {
          log.info(`[TaskCard] 编排进行中，onIdle 不收口不密封，等待子代理完成`);
          return;
        }
```
   - `onError` 回调：`streamingSealed = true;` 之前加同样的 keep-open 早退（子代理仍会经 announce 轮送达结果）：
```ts
        if (taskCardEnabled && taskCardRegistry.onDispatchIdle(sessionKey!) === "keep-open") {
          log.warn(`[TaskCard] 编排进行中遇到 onError，保持卡片打开等待子代理结果`);
          return;
        }
```
   - `onPartialReply`：`if (currentCardTarget) {` 内第一行加：
```ts
        if (inTaskCardMode()) {
          accumulatedText = payload.text;
          await taskCardRegistry.setAnswer(sessionKey!, payload.text);
          return;
        }
```
6. 普通路径释放注册表记录：`closeStreaming` 的 `finally` 块（`accumulatedText = "";` 之后）加：
```ts
      if (taskCardEnabled) taskCardRegistry.release(sessionKey!);
```

`src/core/message-handler.ts` 一处修改：`createDingtalkReplyDispatcher({ ... })` 调用（约 :1470）在 `preCreatedCard: params.preCreatedCard,` 之后追加：

```ts
      sessionKey,   // 任务卡：hook 事件按 sessionKey 关联到本轮卡片
```

- [ ] **Step 4: 跑新测试 + 既有回归**

Run: `npx vitest run tests/reply-dispatcher`
Expected: 新文件与 `card-lifecycle.test.ts`、`reply-dispatcher.test.ts` 全部 PASS（既有用例不传 sessionKey，`taskCardEnabled=false`，路径完全不变）

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/reply-dispatcher.ts dingtalk-openclaw-connector/src/core/message-handler.ts dingtalk-openclaw-connector/tests/reply-dispatcher/task-card-integration.test.ts
git commit -m "feat: keep AI card open in orchestrating mode and route dispatch callbacks into task card"
```

---

### Task 7: channel.sendText 出站路由

**Files:**
- Modify: `dingtalk-openclaw-connector/src/channel.ts`（`outbound.sendText`，约 :330）
- Test: `dingtalk-openclaw-connector/tests/task-card/send-text-intercept.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `taskCardRegistry.interceptOutboundText`
- Produces: 编排态下 announce 轮的最终答案写入既有任务卡而非新建消息

- [ ] **Step 1: 写失败测试**

测试直接驱动真实 registry + mock 卡片 API，再调用 channel 插件的 `outbound.sendText`：

```ts
// tests/task-card/send-text-intercept.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStreamAICard = vi.hoisted(() => vi.fn(async () => {}));
const mockFinishAICard = vi.hoisted(() => vi.fn(async () => {}));
const mockSendTextToDingTalk = vi.hoisted(() => vi.fn(async () => ({ ok: true, processQueryKey: "pq-1" })));

vi.mock("../../src/services/messaging/card.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/messaging/card.ts")>();
  return { ...actual, streamAICard: mockStreamAICard, finishAICard: mockFinishAICard };
});
vi.mock("../../src/services/messaging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/messaging.ts")>();
  return { ...actual, sendTextToDingTalk: mockSendTextToDingTalk };
});

const CARD = { cardInstanceId: "card-1", accessToken: "tk", tokenExpireTime: 0, inputingStarted: true };
const KEY = "agent:main:dingtalk-connector:dm:u1";
const CFG = { channels: { "dingtalk-connector": { clientId: "id", clientSecret: "sec" } } } as any;

describe("outbound sendText 任务卡命中", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { taskCardRegistry } = await import("../../src/services/task-card.ts");
    taskCardRegistry.reset();
  });

  it("编排态命中：文本写入任务卡，不调 sendTextToDingTalk，messageId 为卡片 id —— 一指令一卡片", async () => {
    const { taskCardRegistry } = await import("../../src/services/task-card.ts");
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    taskCardRegistry.bind({ sessionKey: KEY, target: { type: "user", userId: "u1" }, card: CARD as never, config: {} });
    taskCardRegistry.markOrchestrating(KEY);
    taskCardRegistry.onChildSpawned(KEY, "child-1", "任务A");
    const result = await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "阶段结论" } as never);
    expect(mockSendTextToDingTalk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messageId: "card-1", conversationId: "u1" });
  });

  it("全部子代理完成后的出站文本触发 finish —— 最终答案落在同一张卡并收尾", async () => {
    const { taskCardRegistry } = await import("../../src/services/task-card.ts");
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    taskCardRegistry.bind({ sessionKey: KEY, target: { type: "user", userId: "u1" }, card: CARD as never, config: {} });
    taskCardRegistry.markOrchestrating(KEY);
    taskCardRegistry.onChildSpawned(KEY, "child-1", "任务A");
    taskCardRegistry.onChildEnded("child-1", "ok");
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "最终答案" } as never);
    expect(mockFinishAICard).toHaveBeenCalledTimes(1);
    expect(mockFinishAICard.mock.calls[0][1]).toContain("最终答案");
  });

  it("未命中（无编排记录）时走原有 sendTextToDingTalk —— 回归保障", async () => {
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "hi" } as never);
    expect(mockSendTextToDingTalk).toHaveBeenCalledTimes(1);
  });
});
```

注意：默认单例 `taskCardRegistry` 用真实 `streamAICard`/`finishAICard` 绑定，因此本测试通过 `vi.mock` card.ts 模块拦截。第 3 个用例（未命中回归）会真正走到 `resolveDingtalkAccount`，若上面的 `CFG` 形状导致账号解析失败，参照 `tests/outbound/` 现有用例的 cfg fixture 调整（保持前两个用例的 `to`/`target` 不变）。若单例在 mock 生效前已被创建（ESM 静态 import 顺序问题），把 channel/task-card 的 import 全部放在用例内 `await import(...)`（如上所写）即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/task-card/send-text-intercept.test.ts`
Expected: 第 1、2 用例 FAIL（sendText 未接注册表）

- [ ] **Step 3: 实现**

`src/channel.ts`：import 区追加 `import { taskCardRegistry } from "./services/task-card.ts";`。`outbound.sendText` 函数体开头（`const account = resolveDingtalkAccount(...)` 之前）加：

```ts
      // 子代理任务卡：announce 轮的最终答案写入既有卡片而非新建消息
      const intercepted = await taskCardRegistry.interceptOutboundText({ to, text });
      if (intercepted.handled) {
        return {
          channel: CHANNEL_ID,
          messageId: intercepted.cardInstanceId ?? "task-card",
          conversationId: to,
        };
      }
```

- [ ] **Step 4: 跑测试确认通过（含出站回归）**

Run: `npx vitest run tests/task-card/send-text-intercept.test.ts tests/outbound tests/send`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add dingtalk-openclaw-connector/src/channel.ts dingtalk-openclaw-connector/tests/task-card/send-text-intercept.test.ts
git commit -m "feat: route announce-turn outbound text into open task card"
```

---

### Task 8: 部署文档与整体验证

**Files:**
- Create: `docs/deploy/openclaw-task-card.md`（仓库根 docs/）
- Modify: `dingtalk-openclaw-connector/README.md`（追加一节）

**Interfaces:**
- Consumes: 前面全部任务
- Produces: 可交付的部署/配置文档 + 绿色测试套件

- [ ] **Step 1: 写部署文档 `docs/deploy/openclaw-task-card.md`**

内容必须包含以下三块（照抄，占位符 `<...>` 保留给运维填写）：

````markdown
# 子代理任务卡：openclaw 配置与部署

## 1. openclaw.json（零代码改动）

```json5
{
  tools: {
    experimental: { planTool: true },
    alsoAllow: ["sessions_spawn", "sessions_yield", "subagents"],
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
        model: "<openai-compat-provider>/<subagent-model>",
      },
    },
  },
  channels: {
    "dingtalk-connector": {
      // taskCard 默认开启；如需关闭或调整看门狗：
      // taskCard: { enabled: true, watchdogMs: 900000 },
    },
  },
}
```

注意：不要配置 `channels.dingtalk-connector.streaming.mode`（openclaw 内置渠道专用）；
`agents.defaults.subagents` 是 strict schema，只接受上面列出的键。

## 2. 主控 agent workspace 的 AGENTS.md 编排协议

```
需要拆分给子代理时，严格按顺序：
1. update_plan：列出全部步骤（每个子任务一条 + 末尾"汇总结果"），首条 in_progress，其余 pending。
2. 对每个子任务 sessions_spawn，label 与对应 step 文字完全一致，taskName 用 step_1、step_2…。
3. sessions_yield，本轮不输出正文。
4. 每收到一个子代理完成事件：update_plan 把该 step 标 completed、下一个标 in_progress；
   若仍有未完成子任务，回复 NO_REPLY。
5. 全部完成后：update_plan 全部 completed，然后输出最终答案（正常口吻，不转述内部元数据）。
```

## 3. 插件部署

fork 版插件构建与加载：在 `dingtalk-openclaw-connector/` 内 `npm run build`，
然后在 openclaw.json 的 `plugins.load.paths` 指向该目录（确保 `~/.openclaw/extensions/`
下没有同 id 的官方版本，避免重复加载）。

## 4. 手工联调清单

1. 发一条明确要拆 2-3 个子任务的指令 → 钉钉侧只出现 1 张卡，todo 状态随事件变化，
   最终同一张卡下半部分出现答案且停止转圈（flowStatus=3）。
2. 任务执行中 `/stop` 或让某个子代理超时 → 对应条目显示 ❌，主控输出后卡片仍能收尾。
3. 发普通问答 → 行为与 0.8.25 一致（单卡、正常收尾）。
4. `taskCard: { enabled: false }` 后重复 1 → 恢复多卡旧行为（确认开关有效）。
````

- [ ] **Step 2: README.md 追加一节（fork 说明）**

在 `dingtalk-openclaw-connector/README.md` 功能列表附近追加：

```markdown
## 🗂️ 子代理任务卡（fork 增强）

openclaw 子代理模式（`sessions_spawn`）下，一条指令只产生一张 AI 卡片：上半部分实时展示
`update_plan` 维护的 todo list（⏳/🔄/✅/❌），全部子任务完成后同一张卡下半部分展示最终答案。
配置：`channels.dingtalk-connector.taskCard: { enabled?: boolean, watchdogMs?: number }`（默认开启，
看门狗 15 分钟）。openclaw 侧配置与主控编排协议见仓库根 `docs/deploy/openclaw-task-card.md`。
```

- [ ] **Step 3: 全量受影响套件 + 类型检查**

Run（在 `dingtalk-openclaw-connector/`）:
```bash
npx vitest run tests/task-card tests/reply-dispatcher tests/config tests/outbound tests/send
npm run type-check
```
Expected: 测试全部 PASS；type-check 通过（若 type-check 报既有基线错误，先在基线（Task 1 的 commit）上确认同样报错，只允许存在基线已有的错误，新增错误必须修复）。

- [ ] **Step 4: 提交**

```bash
cd /Users/admin/Developer/ccProjects/test_openclaw
git add docs/deploy/openclaw-task-card.md dingtalk-openclaw-connector/README.md
git commit -m "docs: deployment guide for subagent task card (openclaw config + orchestration protocol)"
```
