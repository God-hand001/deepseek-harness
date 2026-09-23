# deepseek-harness 的 pi agent loop 适配器

这是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 内核运行时）的学习 fork：新增了一个用 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 驱动的 agent loop，与官方自带（stock）的 agent loop **可以互相切换**。

> 上游原版说明见 [README.zh.md](README.zh.md)（官方中文文档）。上游处于 developer preview 阶段，迭代很快，兼容性破坏是常态——本仓库声明了已验证的版本组合，见 [兼容性](#兼容性与上游漂移)。

```text
                    dsh-desktop（官方桌面端仓库）
                        │  git submodule（重定向到本仓库）
                        ▼
              deepseek-harness（本 fork，pi-loop 分支）
                        │  cordis agentLoop 服务槽位
            ┌───────────┴───────────┐
            ▼                       ▼
   @deepseek-ai/dsh-agent-loop   @deepseek-ai/dsh-pi-agent-loop   ← 本 fork 新增
      （官方 React 循环）            （pi-agent-core 驱动）
```

- 兼容版本：**dsh-v0.1.6-alpha.2**（桌面端 `2.0.14-beta.1` 实测通过）
- 本包相对官方循环的行为差异见 [已知差异](#已知差异相对-stock-loop)

---

## 快速开始

前提：Node ≥ 22.19、corepack 可用、git。假设你已经 clone 了官方桌面端：

```bash
git clone https://github.com/anywhere-labs/deepseek-harness-desktop.git dsh-desktop
cd dsh-desktop
```

### 1. 把桌面端的 submodule 重定向到本 fork

```bash
cd dsh-desktop
git config submodule.deepseek-harness.url https://github.com/<你的用户名>/deepseek-harness.git
git config submodule.deepseek-harness.branch pi-loop
git submodule update --init --remote
```

### 2. 构建 harness（含 pi 包）并 vendor 进桌面端

```bash
corepack yarn install                 # 桌面端依赖
corepack yarn upstream:install        # submodule 内安装依赖
corepack yarn upstream:build:official # 官方 profile 构建（pi 包会一起编译）
corepack yarn upstream:pack:dsh       # 打包 tgz
node scripts/sync-vendored-runtime.mjs --write
corepack yarn install                 # 重新解析，pi 包进入桌面端 node_modules
```

### 3. 启动桌面端

```bash
corepack yarn dev:beta     # 首次 / 改过代码后（构建 + 启动）
corepack yarn start:beta   # 已构建，直接启动
```

> **Windows 已知坑**：
> - `upstream:pack:dsh` 需要 bsdtar 优先于 Git Bash 自带的 GNU tar（GNU tar 会把 `E:\...` 当成远程主机）：`PATH="/c/Windows/System32:$PATH" corepack yarn upstream:pack:dsh`
> - `upstream:build:official` 经 corepack 嵌套调用 pnpm 时会报 `ERR_PNPM_BAD_PM_VERSION`（corepack 无法在内层 spawn 时对准项目的 pnpm 11.7.0）。修法：**绕过 corepack，用独立安装的 pnpm 11.7.0 直接进 submodule 构建**——`npm i -g pnpm@11.7.0` 后执行：
>   ```bash
>   cd deepseek-harness
>   CI=true DSH_BUILD_CLIENT_PROFILE=official pnpm run build
>   cd ..
>   ```
>   其余步骤仍按上面的 yarn 脚本走。

---

## agent loop 切换

本 fork 的 base 配置默认使用 pi loop（见 `packages/bundle/base/cordis.patch.yml` 的 `agent-loop` 行）。两种切换方式：

### 方式 A：桌面端 profile 补丁层（推荐，免重新打包）

桌面端每次启动都会实时读取你本地 profile 的补丁层（home 目录下 `profiles/<profile>/cordis.patch.yml`，默认内容为空数组 `[]`）。

**换回官方 stock loop**，把该文件改为：

```yaml
- id: agent-loop          # 禁用 base 里的 pi 行
  disabled: true
- insert:                 # 用新 id 插入 stock 行
    - id: agent-loop-stock
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
```

**换回 pi loop**：把文件改回 `[]`。改完重启桌面端即可。

### 方式 B：改 fork 的 base 配置（要重新走一遍 vendor 管线）

编辑 `packages/bundle/base/cordis.patch.yml` 中 `agent-loop` 行的 `name`（`'@deepseek-ai/dsh-pi-agent-loop'` ↔ `'@deepseek-ai/dsh-agent-loop'`），然后重跑第 2 步的 pack + sync + install。

---

## 架构说明（学习笔记）

dsh 的 agent 循环不是写死的：`@deepseek-ai/dsh-agent` 定义了 `AgentFactory` 接缝和 `agentLoop` cordis 服务槽位，**哪个插件加载进来、调用 `ctx.agents.setFactory(this)`，哪个循环就生效**。pi 适配器就是往这个槽位注册的另一个实现。

核心文件（`packages/core/pi-agent-loop/src/`）：

| 文件 | 职责 |
|---|---|
| `index.ts` | `PiAgentLoop` 服务：实现 `AgentFactory`（createAgent/resume）、持久化会话句柄管理、Inbox/turnBoundary 投影注册 |
| `driver.ts` | `PiAgent` 驱动：dsh 生命周期契约（phase/inbox/cancel/maintenance）+ pi 驱动的 turn/step 循环、请求头日志、system prompt 投影 |
| `pi-step.ts` | 单步内核：`runAgentLoopContinue` 跑一个 pi turn（= 一个 dsh step），模型调用桥接回 `ctx.llm`，工具调用桥接回 dsh 工具调度器（审批/护栏插件照常工作） |
| `translate.ts` | dsh 消息 ↔ pi 消息的双向翻译 |
| `runtime-context.ts` | 从 stock loop 复制的 SystemPromptProjection / RuntimeContextProjection（dsh 把 system prompt 作为日志 surface node 0） |
| `invariant.ts` | 与 stock loop 相同的“请求 ⟺ 日志重建”一致性不变量 |

关键设计：**模型可见的一切都来自会话日志的持久化重建**。pi 只贡献循环语义（消息排序、工具调用节奏），请求本身是从日志派生并冻结的，因此官方的一致性检查、压缩、回放等基础设施对 pi 驱动的会话照常生效。

## 已知差异（相对 stock loop）

- 无 `agent/assistant-stream` 实时流式推送——UI 从已提交的会话事件渲染（`assistant/message` 事件内嵌完整压缩流）
- 无 `agent/request-error` 重试瀑布
- 无 max-tokens 粘滞语义
- 工具顺序执行（pi 的模式；stock 支持并行调度）
- 外部依赖固定为 `@earendil-works/pi-agent-core@0.84.2` + `@earendil-works/pi-ai@0.84.2`

## 兼容性与上游漂移

上游更新后本适配器可能需要重新移植。接缝清单（上游这些文件变了就要检查）：

- `packages/core/agent/src/index.ts`（AgentFactory / CreateAgentOptions / ResumeAgentOptions / announce 签名）
- `packages/core/agent/src/runtime-types.ts`（Agent 运行时契约、Inbox 接口）
- `packages/core/agent-loop/src/inbox.ts`（Inbox 持久化契约）
- `packages/core/session/src/types.ts`（会话事件词汇表、assistant/message 的 stream 字段、EpochHeader）
- `packages/core/session/src/preparation.ts`、`packages/core/scope/src/index.ts`、`packages/core/tools`（调度器契约）

**哨兵测试**：接缝一变，这些测试最先红——

```bash
corepack pnpm exec vitest run packages/core/pi-agent-loop --config vitest.config.ts
```

移植流程（0.1.2 → 0.1.6 的实战经验）：diff 上述接缝文件 → 逐个对齐（本次改了 6 处：持久化句柄流、awaited announce、两参 setup、Inbox 持久化投影、assistant/message 内嵌 stream、system prompt 进日志）→ 跑哨兵测试 → 重新 pack + vendor。历史移植记录见本仓库 `pi-loop` 分支的 git log。
