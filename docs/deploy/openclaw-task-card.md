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
