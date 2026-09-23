# pi-agent-loop:用 pi-agent-core 替换 dsh 官方 agent 的完整适配器

**结论先行:dsh 的 agent 不能被 pi "直接接入",但也不需要"重写 pi"——正确做法是写一个适配器,把 pi 的循环库作为驱动内核。** 这个包就是那个适配器,并且已经端到端跑通:pi-agent-core 的循环驱动 DeepSeek 模型,工具、审批、持久化、UI 渲染全部保留 dsh 的。

## 为什么不能直接接入

dsh 的 agent 驱动器必须满足三份契约,pi-agent-core 对此一无所知:

| dsh 契约 | 内容 | pi-agent-core 的现状 |
|---|---|---|
| **工厂协议** | 实现 `AgentFactory`(`createAgent`/`resume` + 发布事务:prepare → setup → enter → announce → session-start,失败回滚),经 `ctx.agents.setFactory` 注册,ctx 键必须是 `agentLoop` | 无此概念;它是被直接 `new Agent(...)` 使用的库 |
| **Agent 运行时接口** | `id/options/session/inbox/status/ctx` + `send/followup/steer/inject/cancel/whenIdle/runMaintenance`;inbox 是持久化的两队列模型 | 有 `agent.prompt/steer/followUp/abort/waitForIdle`,语义相近但形状、持久化方式完全不同 |
| **会话日志纪律** | "模型可见 ⟺ 已记录":`turn/start`、`step/*`、`user/message`、`request/header`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 全部追加进 dsh 会话日志;请求消息必须与日志重建结果逐字一致(运行时不变量) | 有自己的 AgentMessage 格式与事件流,写自己的会话格式(pi sessions) |

## 适配方案:pi turn == dsh step

两边循环粒度天然对齐:**pi 的一个 turn(一次 LLM 调用 + 其工具执行)= dsh 的一个 step**。适配器用 `shouldStopAfterTurn: () => true` 把 pi 的低层循环([`runAgentLoopContinue`](src/pi-step.ts))钉在单个 turn 上,于是 dsh 的 pre-step / turn-stopping 等扩展点全部保留。

数据流(每一步):

```
dsh preStep 领取消息 → 追加 user/message
  → buildRequest:agent/request waterfall 得到路由配置,追加 request/header
  → runPiStep:
      dsh 历史(session.deriveMessages())──dshMessagesToPi──▶ pi 的 AgentContext
      pi 循环调 streamFn ──桥回 dsh ctx.llm.stream(真实适配器/凭据/计量)──▶ 流块
      dsh 流块 ──ChunkToPiAssembler──▶ pi 事件(pi 循环消化)
      pi 事件 ──processLoopEvent──▶ 追加 assistant/chunk、assistant/message
      pi 请求工具 ──bridgeTool──▶ 追加 tool/call → dsh 工具调度器(审批/护栏/post-execute)→ 追加 tool/result
  → step 返回结局:tool-calls 欠新请求则 turn 继续下一步,否则 turn/end
```

## 复用 vs 重写清单

**pi 侧零改动**:`@earendil-works/pi-agent-core@0.84.2` + `@earendil-works/pi-ai@0.84.2` 直接从 npm 安装(与 dsh 已有 `dsh-llm-pi-ai` 适配器的 pi-ai 精确同版,依赖树无分叉)。pi 的循环语义——`convertToLlm`、`beforeToolCall/afterToolCall`、`toolExecution` 模式、`transformContext` 压缩钩子——全部可用,只是由适配器代为装配。

**dsh 侧零改动**:官方 `agent-loop` 包没有被修改,本包只是新增。替换发生在组合层(profile 补丁),不碰任何现有代码。

**适配器自己实现的**:发布协议与生命周期(`src/index.ts`,骨架照官方契约)、phase 机与 inbox(`src/driver.ts`,契约要求)、两个方向的翻译(`src/translate.ts`、`ChunkToPiAssembler`)、工具桥(`bridgeTool`:每调用追加 `tool/call`,走 `TOOL_RUNTIME_SCHEDULER` 三段式 prepare→dispatch→finalize,追加 `tool/result`)。

## 刻意省略(与官方 ReactLoopAgent 的差距)

- 工具执行固定 `sequential`(官方按 `ctx.tools.executionMode` 分并行池/屏障;pi 的并行模式结果提交顺序与 dsh 的 model-order 提交纪律尚未对齐);
- 无 `agent/request-error` 重试瀑布(流失败即轮次终局)、无 max-tokens 粘滞、无 `startsRequestSeries`;
- 图片内容不翻译(dsh 侧是附件引用、pi 侧要内联字节,需要附件服务参与);
- 工具的流式进度(`onUpdate`)未转发;创建/恢复期间不融合调用方取消信号。

## 怎么跑(本机已配好)

```sh
pnpm dsh --profile myagent "你的任务"        # headless 一次性运行,走 pi 驱动器
pnpm dsh --profile myagent --dump-config     # 查看装配:agent-loop 已 disabled,pi-agent-loop 已插入
pnpm dsh --profile headless "任务"           # 对照:官方循环,未受影响
```

profile 配置在 `~/.dsh/profiles/myagent/`:`dsh.profile.bundles` 为 `[dsh-base, dsh-headless]`,`cordis.patch.yml` 禁用官方条目并插入本包(见 [README 之上的 patch 文件])。

## 文件导览

- `src/index.ts` —— 工厂服务 `PiAgentLoop`(AgentFactory seam 挂载点,ctx 键 `agentLoop`)
- `src/driver.ts` —— `PiAgent` 驱动器(生命周期契约 + turn/step 编排)
- `src/pi-step.ts` —— 步内核:`runAgentLoopContinue` 驱动、流块/事件双向翻译、工具桥
- `src/translate.ts` —— dsh 消息 ↔ pi 消息、内容块、用量、工具 schema 的纯翻译
- `src/runtime-context.ts` —— 动态上下文快照投影(拷贝自官方,官方未导出)
- `src/invariant.ts` —— 请求重建不变量伴随插件(断言 pi 驱动的请求同样服从日志纪律)
- `tests/` —— 经 `ctx.agents.create` 工厂 seam 的端到端单测(mock 适配器,dsh 层注入)

## 单测怎么证明"透明"

mock 适配器在 **dsh 的 LLM seam** 上注入,pi 桥夹在中间——测试从外部看到的请求、事件序列与官方循环一致。这证明 seam 对消费方完全透明:headless 运行器、Web UI、subagent 委派不需要知道背后是 pi。
