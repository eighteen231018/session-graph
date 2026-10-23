# session-graph CLI 支持开发文档

- 文档日期：2026-10-21
- 基线版本：`session-graph` 0.1.13
- 目标版本：0.2.0（CLI 支持）
- 验证环境：Claude Code CLI `2.1.306`、Claude Code Desktop（Code tab）
- 目标：在不改变 Desktop 现有行为的前提下，让插件在 CLI 终端中可用

---

## 0. 结论摘要

**现在可以在 CLI 中加载和运行，但只能算"只读可用"，还不是完整支持。**

已经可用：

- CLI 能加载插件并注册 `/session-graph` 命令；
- `terminal` surface 的元素表支持 Pane、`Box` / `Text` / `Button`；空快照的面板树已通过 `$.ui.mount` 挂载校验；
- 转录扫描、分支树构建、线性降级视图的代码路径不依赖 Desktop 的会话管理器；CLI 下会缺少 App 记录带来的合并信息。

当前不可用或行为不正确：

| 功能 | CLI 当前表现 | 原因 |
|---|---|---|
| 点击卡片打开另一个会话 | 会尝试调用 Desktop 的 `ccd_session_mgmt`，失败后可能构造 `claude://` 深链并调用 `open`，**可能误唤起 Claude Desktop**；否则只复制会话 ID | 打开逻辑只实现了 Desktop 深链路径 |
| 删除会话 | 调用 `mcp__ccd_session_mgmt__delete_session`，CLI 没有这个工具，报错或触发工具权限确认；不会删文件 | 删除完全依赖 Desktop 会话管理器 |
| 自动打开面板 | 不会自动打开 | 自动打开只监听 `session.attach { surface: 'desktop' }`，并检查 `surfaces.includes('desktop')` |
| App 会话合并 | rewind / 编辑重发 / clear 后的多个 CLI 转录可能各显示一张卡片 | 只有 Desktop 有 `claude-code-sessions` 记录，CLI 没有 |
| 分支关系识别 | **分叉会话全部变成独立根卡片，或父子方向错乱** | CLI 没有 App 记录的创建时间；`inferParent` 只在历史“完整包含”时定方向，分叉后双方继续增长就放弃。详见 1.6 |
| 鼠标点击卡片 | 终端交互以键盘为主；原生 Button 的鼠标点击未在本版本验证，需要 Tab/Enter | 当前 UI 没有为终端提供键盘提示和快捷键 |
| 面板日志 | 首次绘制会向 transcript 写一条日志 | `$.ui.log` 默认写 transcript |

**因此：要把它变成 CLI 一等公民，需要新增 surface 能力判断、CLI 打开/删除分支、终端交互提示和测试；Desktop 的代码路径保持不变。**

---

## 1. 验证记录

### 1.1 插件清单与钩子加载

```bash
claude plugin validate /Users/mac/code/Claude_plugin/session-graph
```

结果：通过（有 author、LICENSE、icon 等发布相关警告，与 CLI 运行无关）。

### 1.2 CLI 无界面加载验证

```bash
claude --plugin-dir /Users/mac/code/Claude_plugin/session-graph \
  --debug-file /tmp/sg-debug.log -p "reply ok"
```

本机 CLI 未登录，模型调用返回 `Not logged in`，但插件加载链路已经执行完成。日志中的关键行：

```text
--plugin-dir .../session-graph is one plugin: .claude-plugin at its top marks it
hooks module session-graph@inline loaded (worker, environment 1, tier user);
  events: session.start,session.attach,session.end,command.run,
          prompt.submit,turn.complete,ui.render
$.command.register (session-graph): /session-graph listed
hooks module session-graph@inline session.start settled in 38.4ms
hooks module session-graph@inline prompt.submit settled in 33.8ms
hooks module session-graph@inline turn.complete settled in 0.8ms
```

说明：CLI 会加载 `hooks/hooks.json` 里的 mod 模块，`/session-graph` 会被注册，`session.start` / `prompt.submit` / `turn.complete` 都会执行，且没有加载错误。

### 1.3 会话管理器可用性

```bash
claude mcp list
# No MCP servers configured. Use `claude mcp add`...
```

说明：CLI 没有 Desktop App 内置的 `ccd_session_mgmt`。所有依赖它的打开、删除、创建时间查询都需要在 CLI 走不同分支。

### 1.4 现有测试

```bash
claude plugin test /Users/mac/code/Claude_plugin/session-graph
# 24 pass, 0 fail
```

### 1.5 terminal surface 挂载冒烟验证

用插件测试 API 在 `terminal` surface 上挂载当前 Pane 树：

```ts
const ui = await $.ui.mount({
  plugin: 'session-graph',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-graph',
  props: { title, isFocused: false, bodyColumns: 100, placement: 'inline', scroll, view },
  viewport: { columns: 100, rows: 40, isFullscreen: false },
})
```

结果：空快照的 Pane 树挂载通过，`Box` / `Text` / `Button` 都被 terminal 元素表接受。

**未验证的部分**：

- 没有在真实交互式 CLI 中截图验证完整卡片树（本机 CLI 未登录）；
- 完整卡片树的挂载测试还没有落地（见第 9 节测试计划）；
- Desktop 的手动回归还没有执行。

### 1.6 CLI 下分支关系丢失：复现与根因（P0 缺陷）

#### 1.6.1 现象

用户在实际 CLI 会话中测试：Claude Code CLI 打开 `/session-graph` 后，**每个会话都显示为一张独立的根卡片**，卡片之间没有父子连线，也没有 fork 关系。在另一种数据分布下（原始会话比副本长），同一段逻辑还会把原始会话反向挂到某个副本下面，造成父子方向错乱。

这不是“CLI 里没有分支”的数据问题：同一批转录在 Desktop 中通常能借助 App 会话记录正确显示父子关系。问题出在 CLI 缺少 Desktop 的会话元数据时的父分支推断逻辑。

#### 1.6.2 根因

链路如下：

1. `lib/collect.ts:250` 的 `applyCreationTimes` 负责给每个转录文件填 `createdAt`。
   - Desktop 有 `claude-code-sessions/*.json` 会话记录，能直接拿到 `createdAt`；
   - 没有记录时，它尝试 `ccd_session_mgmt.get_session` 补创建时间；
   - CLI 没有这个 MCP，所以所有 CLI 转录的 `createdAt` 都保持 `0`。
2. `lib/graph.ts` 的 `resolveUnitParents` → `inferParent` 在没有创建时间时，只接受一种方向证据：

   ```ts
   } else if (shared !== other.uuidSet.size || other.uuidSet.size === unit.uuidSet.size) {
     // No creation time: the candidate's whole history must be a proper part
     // of this unit, as it is when a fork copied its parent and then grew.
     continue
   }
   ```

   也就是说：**候选会话的整段历史必须是当前会话历史的真子集**，才认为候选是父。
3. 真实的 CLI fork 不是这样：
   - 子会话在 fork 时复制父会话当时的历史；
   - 之后父会话继续增长，子会话也继续增长；
   - 于是父不是子的子集，子也不是父的子集；
   - `inferParent` 对每一对候选都 `continue`，最终 `parentOf` 为 `null`，每张卡片都成了根。
4. 历史完全相同的副本也会被跳过（`other.uuidSet.size === unit.uuidSet.size`），所以“同一段历史的多个副本”同样全部变成根。
5. 还有一个方向反转问题：当父会话确实是子的超集（例如父 829 条、多个子各 523 条）时，现有循环可能把**父会话挂到某个 523 条副本下面**，而不是让副本挂到父下面。这在多个副本并存时会把树的方向弄反。

#### 1.6.3 真实数据证据

在本机 `~/.claude/projects` 上做了转录分析（2026-10-21）：

**项目 `-Users-mac-code-python-code-MyClaude`**：

| 转录 | 消息数 | 与 `4b7f633b` 共享 uuid | 是否子集 | 结果 |
|---|---:|---:|---|---|
| `4b7f633b`（原始 s09） | 125 | 125 | 自身 | 应为根 |
| `4825240a`（s09fork1） | 111 | 77 | 否 | 应为 `4b7f633b` 的子 |
| `6d6c2493`（s09 fork2） | 89 | 77 | 否 | 应为 `4b7f633b` 的子 |
| `d0b4cc25`（s09fork2） | 86 | 83 | 否 | 应为 `4b7f633b` 的子 |

三份 fork 文件都与原始会话共享 77～83 条消息，但都没有完整包含关系；`createdAt` 又都是 0，所以现在全部变成根。

**项目 `-Users-mac-code-Claude-plugin`**：

| 转录 | 消息数 | 与 `56f8e9f9` 共享 uuid | 说明 |
|---|---:|---:|---|
| `56f8e9f9` | 829 | 829 | 原始会话，应为根 |
| `03e33db6` | 523 | 523 | 523 条历史的完整副本 |
| `22b18a0d` | 523 | 523 | 同上 |
| `29311f3b` | 523 | 523 | 同上 |
| `a5a5bca3` | 523 | 523 | 同上 |
| `d81cc811` | 523 | 523 | 同上 |

五个副本都没有自己的新增消息，现有逻辑既不会把它们挂到 829 条的原始会话下，还会把原始会话反向挂到某个副本下。

#### 1.6.4 可用的强信号：复制消息保留源 `sessionId`

> 后续实测补充：本节覆盖保留来源 ID 的路径；终端内置 `/fork` 的另一条路径会重写 `sessionId`，需使用宿主 fork 通知。修复与真实复现见第 16 节。

CLI 的 fork 路径（例如 `--fork-session`）在复制历史时，**被复制的消息记录保留源会话的 `sessionId`**，新产生的消息才写新会话 id。这在真实数据里可以直接看到：

```text
4825240a.jsonl  消息 111 条：
  77 条 sessionId = 4b7f633b-...（父会话）
  34 条 sessionId = 4825240a-...（自己）

6d6c2493.jsonl  消息 89 条：
  77 条 sessionId = 4b7f633b-...（父会话）
  12 条 sessionId = 6d6c2493-...（自己）

d0b4cc25.jsonl  消息 86 条：
  83 条 sessionId = 4b7f633b-...（父会话）
   3 条 sessionId = d0b4cc25-...（自己）
```

`lib/parse.ts` 已经把每条消息的 `sessionId` 解析进 `ParsedMessage.sessionId`，只是 `lib/graph.ts` 目前没有使用它。因此可以在**不依赖 Linux/macOS 文件创建时间、不依赖 Desktop MCP** 的情况下恢复 CLI 的父子关系。

注意：

- Desktop 创建的部分转录会在复制时改写 `sessionId`（本机 `0b768e0a`、`be56ae8e`、`c6446c47` 就是这种情况），这类文件没有 provenance 信号；
- 这些文件在 Desktop 上通常有 App 会话记录，仍然走现有的 App 记录父链；
- 纯 CLI 的 fork 路径保留 provenance，正好覆盖本次 bug。

#### 1.6.5 修复方案：provenance 优先，包含关系兜底

不改 Desktop 已有的 App 记录路径，只在 `lib/graph.ts` 的父关系推断中增加一层“来源会话”证据：

1. **在 `buildUnits` 中统计每个 unit 的 `foreignSessionIds`**

   ```ts
   // 每条消息的 sessionId 若不是本 unit 自己的转录 id，就是复制来源
   const ownIds = new Set([
     unit.id,
     unit.app?.cliSessionId ?? '',
     ...unit.files.map(file => file.id),
     ...(unit.app?.transcriptIds ?? []),
   ])
   const foreign = new Map<string, number>()
   for (const message of merged) {
     const owner = message.sessionId
     if (owner === '' || ownIds.has(owner)) continue
     foreign.set(owner, (foreign.get(owner) ?? 0) + 1)
   }
   ```

2. **建立转录 id → unit 的映射**

   ```ts
   const unitByTranscriptId = new Map<string, BranchUnit>()
   for (const unit of units) {
     for (const file of unit.files) unitByTranscriptId.set(file.id, unit)
   }
   ```

3. **用 provenance 定父**

   对没有 App 父链的 unit：

   - 把 `foreign` 里的源 id 按消息数从多到少排序，逐个检查；
   - 如果该 unit 没有任何自己的消息（完整副本，例如五个 523 条副本），直接接受第一个能映射到 unit 的来源；
   - 否则要求外来消息构成**前缀**：最后一个外来消息的时间戳不晚于第一个自己消息的时间戳（时间戳相同或缺失时按 merged 序列中的位置判断）；
   - 第一个通过检查、且 `unitByTranscriptId.get(source)` 存在并且不是自己的来源，设为父；
   - 把所有已确定的关系（App + provenance）记入 `knownChildren`，供下一步排除反向候选。

4. **兜底时排除已知子节点**

   对没有 provenance 父、也没有 App 父的 unit，继续调用现有的 `inferParent`，但候选集合要排除 `knownChildren.get(unit.id)` 里的 unit（包括 App 父链已经确定的子节点）。这样可以避免“829 条原始会话被挂到 523 条副本下面”。

5. **保留现有保守原则**

   - 没有 provenance、没有创建时间、也没有完整包含关系时，仍然保持 `parent = null`，不按消息数量猜；
   - `breakCycles` 照常执行；
   - App 记录的父链优先级最高，provenance 只用于补充 CLI。

6. **可选：记录父关系证据**

   为了测试和调试，可以在内部 `parentOf` 旁维护 `parentEvidence: 'app' | 'provenance' | 'containment' | 'none'`，或给 `BranchCard` 增加可选的 `parentEvidence` 字段（不显示在 UI 中）。这样测试可以断言“这个父关系来自 provenance，而不是猜出来的”。

#### 1.6.6 预期结果

- `MyClaude`：`4825240a`、`6d6c2493`、`d0b4cc25` 都挂到 `4b7f633b` 下，`4b7f633b` 为根；
- `Claude_plugin`：五个 523 条副本都挂到 `56f8e9f9` 下，`56f8e9f9` 为根；
- 没有共享历史的其他会话仍然是独立根（这是正确的）；
- Desktop 有 App 记录的会话继续使用 App 父链，行为不变。

#### 1.6.7 需要新增的测试

1. CLI fork：父 125 条、子 89 条、共享 77 条、复制消息 `sessionId` 指向父、双方 `createdAt = 0` → 子的 `parentSessionId` 为父。
2. 多副本：原始 829 条、五个 523 条完整副本、副本消息 `sessionId` 指向原始 → 五副本都挂原始，原始为根，方向不反转。
3. 非前缀的外来消息（外来 id 与自己的消息交错）→ 不使用 provenance，保持原有兜底。
4. App 父链与 provenance 冲突 → App 父链优先。
5. 无关会话 → 仍为独立根。
6. 现有 24 个测试全部通过。

#### 1.6.8 真实数据模拟结果

先用**当前算法**（没有 provenance）在真实转录上模拟，结果与用户现象一致：

```text
-Users-mac-code-python-code-MyClaude:
  4825240a parent=ROOT
  4b7f633b parent=ROOT
  6d6c2493 parent=ROOT
  d0b4cc25 parent=ROOT
  ...（其余也全部 ROOT）

-Users-mac-code-Claude-plugin:
  56f8e9f9 parent=03e33db6   ← 原始会话被反向挂到 523 条副本下
  03e33db6 parent=ROOT
  22b18a0d parent=ROOT
  29311f3b parent=ROOT
  a5a5bca3 parent=ROOT
  d81cc811 parent=ROOT
  ...（其余独立会话也全部 ROOT）
```

这解释了为什么 CLI 中看不到分支：fork 子会话全部变成根；唯一一个能推出关系的案例还把方向弄反了。

按上述 provenance 算法在同一批数据上模拟（不修改插件代码），结果与预期一致：

**`-Users-mac-code-python-code-MyClaude`**：

```text
0b768e0a n=125 parent=ROOT      evidence=none
4825240a n=111 parent=4b7f633b  evidence=provenance
4b7f633b n=125 parent=ROOT      evidence=none
6d6c2493 n= 89 parent=4b7f633b  evidence=provenance
be56ae8e n= 84 parent=ROOT      evidence=none
c6446c47 n=164 parent=ROOT      evidence=none
d0b4cc25 n= 86 parent=4b7f633b  evidence=provenance
```

**`-Users-mac-code-Claude-plugin`**：

```text
03e33db6 n= 523 parent=56f8e9f9  evidence=provenance
19ae8116 n= 768 parent=ROOT      evidence=none
22b18a0d n= 523 parent=56f8e9f9  evidence=provenance
29311f3b n= 523 parent=56f8e9f9  evidence=provenance
2a0129ab n= 625 parent=ROOT      evidence=none
4484e926 n= 213 parent=ROOT      evidence=none
56f8e9f9 n= 829 parent=ROOT      evidence=none
a5a5bca3 n= 523 parent=56f8e9f9  evidence=provenance
c6f7ffa5 n= 801 parent=ROOT      evidence=none
d7f7c62b n= 321 parent=ROOT      evidence=none
d81cc811 n= 523 parent=56f8e9f9  evidence=provenance
f610270a n=1244 parent=ROOT      evidence=none
```

说明：

- CLI fork 全部恢复为子分支，原始会话保持为根；
- 五个完整副本全部挂到 `56f8e9f9`，没有再把原始会话反向挂到副本下；如果这些副本实际是同一逻辑会话的 rewind/clear 结果，是否合并成一张卡片仍属于 5.3 的 P2 范围；
- 没有 provenance 的 Desktop 转录保持为根，交给 App 记录路径处理（Desktop 上它们会按 App 父链显示）；
- 无关会话保持为独立根，符合现有原则。

---

## 2. 现状：Desktop 依赖清单

| # | 依赖 | 代码位置 | CLI 结果 | 处理方式 |
|---|---|---|---|---|
| 1 | `ccd_session_mgmt.list_sessions` | `lib/session-link.ts:319` | 无此 MCP，抛错；会继续尝试 `tool.call` | CLI 不调用，直接走 `claude --resume` 复制路径 |
| 2 | `ccd_session_mgmt.get_session`（创建时间） | `lib/collect.ts:342` | 无此 MCP，抛错 | CLI 扫描时跳过这个兜底 |
| 3 | `mcp__ccd_session_mgmt__delete_session` | `lib/session-link.ts:159` | 无此工具；不会删文件，但会报错/可能弹权限 | CLI 隐藏删除按钮，并加防御性拦截 |
| 4 | `claude://` 深链 + `open` / `xdg-open` / `cmd start` | `lib/session-link.ts:73`, `:377-392` | `claude://` 指向 Desktop；CLI 点击可能误唤起 Desktop | CLI 不进入 `openSession` |
| 5 | Desktop 会话记录 `claude-code-sessions/*.json` | `lib/app-store.ts:184-219` | 文件不存在或没有当前 CLI 会话的记录 | 保留文件扫描；只跳过远程 MCP 补全 |
| 6 | `session.attach { surface: 'desktop' }` 自动打开 | `hooks/register.tsx:210` | 终端 attach 不会触发 | 保持现状；CLI 用 `/session-graph` 手动打开 |
| 7 | `surfaces.includes('desktop')` 自动打开判断 | `hooks/register.tsx:528-534` | 返回 false | 保持现状 |
| 8 | 鼠标点击语义 | `hooks/register.tsx` 的 `Button onPress` | 终端只能键盘操作 | 增加终端提示和快捷键 |
| 9 | `$.ui.log` 默认写 transcript | `hooks/register.tsx:319` | CLI 首绘会多一行日志 | CLI 改为 `{ to: 'debug' }` |
| 10 | 连接线动画每 160ms invalidate | `hooks/register.tsx:156-170` | 终端持续重绘，可能闪烁/耗 CPU | CLI 关闭脉冲动画，保留按层着色 |
| 11 | `$.process.run` 读大文件尾部 | `lib/collect.ts:357` | 文档标注 "CLI only"，CLI 可用 | 保持；CLI 更可靠 |
| 12 | `$.config.list()` 读 theme | `lib/collect.ts:367-376` | CLI 可读；终端颜色走主题键 | 保持 |

**关键结论：数据层（转录扫描、树构建）基本与 surface 无关；问题集中在"对会话的操作"和"终端呈现/交互"两层。**

---

## 3. 宿主能力边界

来自本版本 `claude-code` 类型声明的已确认事实：

- `RenderSurface`：`terminal` / `desktop` / `mobile` / `vscode`。
- `terminal` 的元素表：`Box`、`Text`、`Button`、`Input`、`Select`、`Link`、`Code`、`Markdown`、`Client`、`Raster`、`Image`，**没有 `Svg`**。当前实现已不使用 `Svg`，只使用 `Box` / `Text` / `Button`，兼容。
- `Pane` 在 "every attached surface" 上绘制；terminal 的 Pane 由 Ink 画。
- `$.ui.open` 由命令触发时："placed at any width: docked beside a fullscreen transcript from 110 columns, else inline above the prompt." 因此 `/session-graph` 在窄终端也会以内联面板出现。
- 未被用户动作触发的 `$.ui.open`（例如 `session.start`）在 144 列以下等待不绘制。这是 CLI 不自动打开面板的另一个理由。
- `session.attach` 的文档明确："the terminal's attachment is the REPL's binding and raises nothing." 终端不会收到 attach 事件。
- `$.ui.copy` 在 terminal 上使用终端剪贴板工具或 OSC 52；OSC 52 不回报，某些终端/SSH 可能静默失败。
- `$.process.run` 文档标注 "CLI only"；本项目用它读大转录尾部，CLI 反而比 Desktop 更适用。
- `$.ui.ask` 在 CLI 可用（`AskUserQuestion` 对话框），但删除功能在 CLI 不会使用它。

---

## 4. 设计原则

1. **surface gating**：所有行为差异只依据 `e.surface === 'terminal'`（或 `surfaces` 是否包含 `desktop`）分支；`desktop` / `mobile` / `vscode` 的现有路径不改。
2. **不伪造成功**：CLI 不能打开会话时，明确复制 `claude --resume <id>` 并提示，不声称已打开。
3. **不做破坏性兜底**：CLI 不能删除会话时，隐藏删除入口并提示去 Desktop；绝不用 `rm` 删除转录文件。
4. **数据层保持 surface 无关**：树构建、转录解析、导出继续共用；只把"会话管理器的可用性"作为可选依赖。
5. **增量类型**：`BranchCard` 只增加可选字段，不改变现有字段语义；Desktop 渲染不读取新字段。
6. **终端优先键盘**：为 CLI 增加 Tab/Enter 说明和少量快捷键；Desktop 的鼠标交互和按钮集合保持不变。

---

## 5. 改动清单

### 5.1 P0：让 CLI 真正可用

#### 5.1.1 修复 CLI 分支父关系（provenance 推断）

这是本次 CLI 支持的核心数据修复，详见 1.6。改动集中在 `lib/graph.ts`，不依赖 Desktop MCP，也不改变 App 记录路径：

1. `buildUnits` 为每个 unit 统计 `foreignSessionIds`：消息的 `sessionId` 不属于本 unit 自己的转录 id 时，计入复制来源；同时记录这些外来消息是否构成历史前缀。
2. `resolveUnitParents` 在 App 父链之后、`inferParent` 之前，先用 provenance 定父：
   - 取消息数最多的外来 `sessionId`；
   - 通过 `unitByTranscriptId` 找到对应 unit；
   - 要求外来消息构成前缀、源不是自己；
   - 记录 `knownChildren`。
3. 对剩余 unit 调用 `inferParent` 时，排除 `knownChildren` 中的候选，避免把原始父会话反向挂到副本下面。
4. 保留现有原则：证据不足时 `parent = null`，不按消息数量猜；`breakCycles` 继续执行。
5. 可选增加 `parentEvidence`（`app` / `provenance` / `containment` / `none`）用于测试和调试，不显示在 UI 中。

验收：

- 真实 CLI fork（父继续增长、子也继续增长）能挂到父下；
- 多个完整副本能挂到同一个原始会话下，原始会话保持为根；
- 无关会话仍是独立根；
- Desktop App 记录父链行为不变；
- 现有 24 个测试 + 新增 provenance 测试全部通过。

#### 5.1.2 新增 `lib/surface.ts`

目的：把 surface 判断集中，避免在 `register.tsx` 里散落字符串比较。

```ts
export function isTerminalSurface(surface: string | undefined): boolean {
  return surface === 'terminal'
}

export function isTerminalOnly(surfaces: readonly string[]): boolean {
  return surfaces.includes('terminal') && !surfaces.includes('desktop')
}
```

不引入新依赖；纯函数，可直接单测。

#### 5.1.3 `lib/session-link.ts`：增加 CLI resume 命令生成

```ts
/**
 * The command a CLI person runs to reopen a branch. App ids carry a
 * `local_` prefix that `claude --resume` does not take.
 */
export function resumeCommand(sessionId: string): string {
  const id = sessionId.startsWith('local_') ? sessionId.slice('local_'.length) : sessionId
  return id === '' ? '' : `claude --resume ${id}`
}
```

说明：

- 会话 ID 来自转录文件名，是 UUID；`local_` 前缀只在 Desktop App 记录中出现。
- 不在插件里自动执行这条命令：它会启动一个嵌套的交互式 CLI，阻塞当前终端，且需要用户已登录。
- 如果需要跨目录 resume，可在后续版本改为 `cd "<cwd>" && claude --resume <id>`；当前扫描范围就是当前项目目录，先复制简单形式。

#### 5.1.4 `types/index.d.ts` + `lib/graph.ts`：给 `BranchCard` 增加 `cliSessionId`

```ts
export type BranchCard = {
  // ...existing fields
  /** The CLI transcript id `claude --resume` takes; additive. */
  cliSessionId: string
}
```

在 `buildCard` 中：

```ts
cliSessionId: unit.app?.cliSessionId ?? unit.primary.id,
```

原因：Desktop App 卡片的 `sessionId` 是 `local_...`；如果用户同时使用 Desktop，CLI 的 resume 应该用 live transcript id，而不是简单去掉前缀。CLI-only 卡片两者相同。

兼容性：

- Desktop UI 不读取该字段；
- 导出 HTML 的 cards JSON 会多一个字段，属于输出增量，不影响 Desktop 功能；
- `types/index.d.ts` 是插件自己的数据契约，不是宿主 `PluginState` 契约，改动安全。

#### 5.1.5 `hooks/register.tsx`：按 surface 分派卡片动作

**(a) 把 surface 传进卡片闭包**

```ts
const surface = e.surface
const open = (sessionId: string): void => {
  const card = cardById.get(sessionId)
  if (card !== undefined) void openCard($, card, surface)
}
const remove = (sessionId: string): void => {
  const card = cardById.get(sessionId)
  if (card !== undefined) $.clock.after(1, () => { void deleteCard($, card, surface) })
}
```

**(b) `openCard` 增加 terminal 分支**

```ts
async function openCard($: EngineInterface, card: BranchCard, surface: string): Promise<void> {
  // existing debounce / isCurrent checks stay

  if (isTerminalSurface(surface)) {
    const command = resumeCommand(card.cliSessionId || card.sessionId)
    if (command === '') {
      $.ui.toast('无法生成恢复命令：会话 ID 为空')
      return
    }
    try {
      const result = await $.ui.copy({ text: command, surface })
      $.ui.toast(result.isCopied
        ? `已复制：${command}`
        : `请在终端运行：${command}`)
    } catch {
      $.ui.toast(`请在终端运行：${command}`)
    }
    return
  }

  // existing Desktop/remote path unchanged
}
```

关键点：

- terminal 分支**不调用** `openSession`，因此不会触发 `ccd_session_mgmt`、不会构造 `claude://`、不会调用系统 `open`。
- 失败时仍然给出可执行的命令，不声称已经打开。
- 去重逻辑 `lastOpen` 保留，避免双击/重复 Enter 复制两次。

**(c) `deleteCard` 增加 terminal 拦截，并隐藏按钮**

```ts
async function deleteCard($: EngineInterface, card: BranchCard, surface: string): Promise<void> {
  if (isTerminalSurface(surface)) {
    $.ui.toast('CLI 中暂不支持删除会话；请在 Claude Code Desktop 中删除')
    return
  }
  // existing logic unchanged
}
```

渲染时：

```tsx
{card.isCurrent ? (
  <Text color={accentColor}>当前</Text>
) : (
  <Button key={`${card.sessionId}:open`} plain onPress={() => open(card.sessionId)}>
    <Text color={normalColor}>打开</Text>
  </Button>
)}
{isTerminal ? null : (
  <Button key={`${card.sessionId}:delete`} plain dimColor={...} onPress={() => remove(card.sessionId)}>
    删除
  </Button>
)}
```

说明：即使按钮被隐藏，`deleteCard` 的 terminal 拦截仍然保留，作为防御层。

**(d) 终端快捷键与底部提示**

只对 terminal 设置 `hotkey`，Desktop 不传，保持现有快捷键集合不变：

```tsx
const isTerminal = isTerminalSurface(e.surface)
<Button key="refresh" hotkey={isTerminal ? 'r' : undefined} onPress={...}>刷新</Button>
<Button key="export"  hotkey={isTerminal ? 'e' : undefined} onPress={...}>导出 HTML</Button>
<Button key="copy"    hotkey={isTerminal ? 'c' : undefined} onPress={...}>复制会话 ID</Button>
```

底部提示按 surface 切换：

```tsx
<Text dimColor>
  {isTerminal
    ? `${summaryLine(snapshot)} · Tab/Shift+Tab 选择，Enter 打开；↑↓ 滚动；r 刷新、e 导出、c 复制`
    : `${summaryLine(snapshot)} · 点击卡片标题或正文进入会话；删除按钮在卡片底部`}
</Text>
```

注意：`hotkey` 只在 Pane/band 持有焦点时有效；用户可以用 `/session-graph focus` 或 `ctrl+x tab` 把焦点交给面板。

**(e) 日志落到 debug**

```ts
$.ui.log(message, isTerminalSurface(e.surface) ? { to: 'debug' } : undefined)
```

Desktop 仍然写 transcript，行为不变。

**(f) 终端关闭脉冲动画**

```ts
const animateLines = !isTerminalSurface(e.surface)
if (animateLines && layout.connectors.length > 0) startLineAnimation($)
const pulseAt = (flow: number): boolean =>
  animateLines && (((flow - linePhase) % PULSE_SPAN + PULSE_SPAN) % PULSE_SPAN < PULSE_WIDTH)
```

理由：终端 Pane 打开期间，现有定时器每 160ms `$.ui.invalidate('ui.render')`，会持续重绘；Ink 虽做差分，但长时间运行仍有闪烁和 CPU 成本。CLI 保留按层着色和连接线字形，只是不播流动高亮。Desktop 保持不变。

如果产品上希望 CLI 也有流动效果，可改为更慢的帧率（例如 480ms），但不建议默认开启。

#### 5.1.6 `lib/collect.ts`：CLI 跳过会话管理器 MCP 兜底

当前 `applyCreationTimes` 在转录没有 App 记录时，会调用 `listAppSessions`，进而调用 `ccd_session_mgmt`。CLI 没有这个 MCP，虽然异常被捕获，但每轮扫描都会白跑一次。

给 `HostDeps` 增加：

```ts
readonly surfaces: () => Promise<readonly RenderSurface[]>
```

在 `depsOf` 中绑定：

```ts
surfaces: () => $.session.surfaces(),
```

在 `applyCreationTimes` 开头：

```ts
const surfaces = await deps.surfaces().catch(() => [])
const hasAppManager = surfaces.includes('desktop')
// app records are still read from disk; only the remote manager fallback is skipped
if (!hasAppManager) return
```

保留 `scanAppSessions` 的文件扫描，因为机器上可能同时安装了 Desktop，App 记录仍然有助于合并视图。只跳过"通过 MCP 补创建时间"这一步。

注意：不要在模块级永久缓存 `hasAppManager`；Desktop 可能在会话中途 attach，导致 surfaces 变化。每次扫描读取一次即可。

#### 5.1.7 `README.md`：补充 CLI 行为说明

在现有 CLI 安装段落后增加：

- CLI 中用 `/session-graph` 打开面板；终端不会自动打开；
- `Tab` / `Shift+Tab` 选择按钮，`Enter` 打开，方向键滚动；
- `r` 刷新、`e` 导出、`c` 复制会话 ID（面板持有焦点时）；
- CLI 中"打开"= 复制 `claude --resume <id>`，不会切换当前会话；
- CLI 中不提供删除；删除仍在 Desktop 中进行；
- CLI 的父分支优先用复制消息保留的源 `sessionId` 判断：`--fork-session` 产生的分支能正确显示父子关系；
- 少数由 Desktop 改写 `sessionId` 的转录没有这个信号，仍以 App 会话记录为准；没有记录时可能保持为根；
- 没有 Desktop 会话记录时，rewind / 编辑重发 / clear 可能各显示一张卡片；
- CLI 的连接线为静态着色，不播放流动高亮。

#### 5.1.8 测试

新增 `tests/cli.test.ts`：

```ts
import { expect, test } from 'claude-code/testing'
import { resumeCommand } from '../lib/session-link'

test('resumeCommand keeps a transcript id', () => {
  expect(resumeCommand('3cda145c-1111-2222-3333-444455556666'))
    .toBe('claude --resume 3cda145c-1111-2222-3333-444455556666')
})

test('resumeCommand strips the app prefix', () => {
  expect(resumeCommand('local_3cda145c-1111-2222-3333-444455556666'))
    .toBe('claude --resume 3cda145c-1111-2222-3333-444455556666')
})

test('resumeCommand refuses an empty id', () => {
  expect(resumeCommand('')).toBe('')
})
```

新增 `tests/provenance.test.ts`，覆盖 1.6.7 的用例：

- 父 125 条、子 89 条、共享 77 条、复制消息 `sessionId` 指向父、`createdAt = 0` → 子挂父；
- 原始 829 条 + 五个 523 条完整副本，副本消息 `sessionId` 指向原始 → 五副本挂原始，原始为根，方向不反转；
- 外来消息与自己的消息交错（不构成前缀）→ 不使用 provenance；
- App 父链与 provenance 冲突 → App 父链优先；
- 无关会话 → 仍为独立根。

再增加 surface 层测试：

- 在 `terminal` surface 挂载 Pane，注入包含一张卡片和一张 current 卡片的快照；
- 断言不存在 `key` 以 `:delete` 结尾的 Button；
- 按标题 Button，断言 `ui.copy` 收到 `claude --resume ...`，且没有 `mcp.call` / `tool.call` / `process.run` 调用；
- 在 `desktop` surface 挂载同样的快照，断言删除按钮存在，按标题 Button 仍走原 Desktop 路径（用测试 hook 模拟 `ccd_session_mgmt`）。

如果测试套件无法直接注入状态快照，备选方案：把 Pane 的树构建提取为 `renderPane(snapshot, layout, ...)` 纯函数，测试该函数在两种 surface 元素表下的输出。不要为了测试改变 Desktop 的渲染路径。

### 5.2 P1：体验完善

1. **导出的静态 HTML 提示按来源调整**
   - 当前导出页脚写"在插件 Pane 中点击卡片会尝试打开对应会话"。
   - CLI 导出时可以改为"在 CLI 中运行 `claude --resume <id>`"。
   - 可选：`exportHtml` 接收 `surface` 参数；默认保持 Desktop 文案。

2. **`/session-graph` 命令返回文案区分 surface**
   - 终端 `isPlaced` false 时，`reason` 可能是 `no-surface`；当前提示"可在更宽的窗口重试"不准确，可细化为：
     - `no-surface`：当前运行没有可绘制界面；
     - 列数不足：加宽终端或再次运行命令。

3. **卡片标题回退**
   - CLI 没有 App 记录时，卡片标题可能是"会话 xxxxxxxx"。
   - 可选：在 terminal 扫描时，标题回退到首条用户消息的短预览。
   - 必须按 surface 开启，避免改变 Desktop 的卡片标题。

4. **快速定位当前卡片**
   - 终端树可能较高，可以在面板顶部加一行"当前：<标题>"，或提供跳转当前卡片的快捷键。不是 P0。

### 5.3 P2：数据与跨平台增强

1. **CLI 下的 rewind / clear 合并**
   - P0 的 provenance 修复解决的是**父子方向**，不是"同一会话的多个转录合并成一张卡片"。
   - 现状：没有 App 记录，rewind / 编辑重发 / clear 产生的多个转录仍可能各显示一张卡片。
   - 若要合并，需要研究 CLI 转录里的 `sessionId`、`parentUuid`、`custom-title` 等字段能否可靠判断"同一会话的多个转录"。
   - 不能把 provenance 直接当作"同一会话"：它说明历史来源，不说明两个文件属于同一个逻辑会话。
   - 不得用消息数量猜测；方向不确定时保持未知（现有原则）。
   - 这属于数据层改动，必须先在真实 CLI 转录上验证。

2. **`claude --resume` 的目录语义**
   - 当前复制 `claude --resume <id>`，默认用户在同一项目目录运行。
   - 如果确认跨目录 resume 不可靠，可改为复制 `cd "<cwd>" && claude --resume <id>`。
   - cwd 可以来自 `$.session.cwd()`；不要在命令里使用未转义的用户输入。

3. **Windows / 远程终端**
   - `openUrl` 的 `cmd /c start` 分支是 Desktop 深链用的，CLI 不再走它。
   - 剪贴板在 Windows Terminal / SSH / tmux 下可能不可用；保留"请在终端运行"的 toast 兜底。

4. **终端自动打开（可选，默认关闭）**
   - 如果用户强烈需要，可增加一个显式开关（`$.store` 或 userConfig），在 `session.start` 时对 terminal 也尝试 `$.ui.open`。
   - 默认不开启：未请求的 Pane 在 144 列以下不会绘制，且终端空间有限。

---

## 6. CLI 交互设计

### 6.1 打开与聚焦

| 操作 | CLI |
|---|---|
| 打开面板 | `/session-graph` |
| 打开并请求焦点 | `/session-graph focus` |
| 关闭 | `/session-graph close` 或 Pane 的关闭键 |
| 刷新 | `/session-graph refresh` 或面板内"刷新" / `r` |
| 导出 | `/session-graph export` 或面板内"导出 HTML" / `e` |

### 6.2 卡片操作

| 操作 | CLI | Desktop |
|---|---|---|
| 选中按钮 | `Tab` / `Shift+Tab` | 鼠标 |
| 激活 | `Enter` | 点击 |
| 滚动 | 方向键 / Pane 的滚动键 | 滚轮 |
| 打开会话 | 复制 `claude --resume <id>` | `ccd_session_mgmt` 深链 + `open` |
| 删除会话 | 不显示 | 显示，确认后调用会话管理器 |
| 当前会话 | 显示"当前"，不可打开 | 同左 |

### 6.3 Toast 文案建议

- 复制成功：`已复制：claude --resume <id>`
- 剪贴板不可用：`请在终端运行：claude --resume <id>`
- 空 ID：`无法生成恢复命令：会话 ID 为空`
- 删除：`CLI 中暂不支持删除会话；请在 Claude Code Desktop 中删除`

文案保持简洁，不声称"已打开"。

---

## 7. Desktop 不回归保证

### 7.1 不变量

以下行为在本次改动后必须完全不变：

1. Desktop 在打开、恢复、切换会话时自动打开 Pane（`session.attach { surface: 'desktop' }`）。
2. Desktop 点击卡片标题/正文/打开按钮时，仍走 `openSession`：
   - 先 `mcp.call('ccd_session_mgmt', 'list_sessions')`；
   - 失败时走 `tool.call('mcp__ccd_session_mgmt__list_sessions')`；
   - 构造/校验 `claude://` 链接；
   - 用 `open` / `xdg-open` / `cmd start` 打开；
   - 失败时复制会话 ID 并 toast。
3. Desktop 的删除按钮、确认对话框、`delete_session` 调用、子分支保护逻辑不变。
4. Desktop 的连接线流动动画不变（160ms）。
5. Desktop 首次绘制仍向 transcript 写日志。
6. Desktop 有 App 记录的父子链、卡片标题和 App 记录合并逻辑不变；provenance 只在没有 App 父链时补充父关系，`wouldCreateCycle` 排除已知子孙节点，防止父关系反转。该检查已覆盖原先 `knownChildren` 的直接子节点过滤，无需另存一份映射。
7. Desktop 的面板标题、`retitlePane`、`openOnDesktop` 重试逻辑不变。

### 7.2 代码约束

- 所有新分支都以 `isTerminalSurface(e.surface)` 或 `surfaces.includes('desktop')` 为条件；
- `openCard` / `deleteCard` 的签名变化只影响 `register.tsx` 内部调用；
- `BranchCard` 新字段是可选/增量，Desktop 不读取；
- 不修改 `openSession` / `deleteAppSession` 的 Desktop 代码路径；
- 不修改 `scanAppSessions` 的 Desktop 记录解析；
- provenance / 环检测的改动集中在 `lib/graph.ts` 的父关系推断，App 记录父链先写入且不可被 provenance 覆盖；
- 不在共享函数里改变默认 toast、默认日志 sink、默认动画行为。

### 7.3 回归测试

- 现有 24 个测试全部通过；
- 新增 Desktop surface 的 mount 测试，断言删除按钮仍存在、打开按钮存在；
- 新增 Desktop 路径的 `openSession` 测试（可在现有 `tests/grouping.test.ts` 的 mock 基础上扩展）：
  - `mcp.call` 成功返回 link 时，`process.run` 收到 `['open', 'claude://...']`；
  - `mcp.call` 失败、`tool.call` 成功时仍能打开；
  - 找不到 link 时复制会话 ID，toast 不含"已打开"；
- 手动 Desktop 验收：打开/恢复/切换自动开面板、点击卡片、删除确认、动画、日志。

---

## 8. 测试计划与验收

### 8.1 自动化

```bash
claude plugin test /Users/mac/code/Claude_plugin/session-graph
claude plugin validate /Users/mac/code/Claude_plugin/session-graph
```

通过标准：

- 原有 24 个测试 + 新增 CLI/Desktop surface 测试全部通过；
- `validate` 不出现新的结构性错误；
- CLI 无界面加载日志中 `/session-graph listed` 且无 `session-graph` 错误。

### 8.2 CLI 手动验收

1. 在已登录的终端运行：

   ```bash
   claude --plugin-dir /Users/mac/code/Claude_plugin/session-graph
   ```

2. 在一个有多个会话/分支的项目中运行 `/session-graph`。
3. 确认：
   - Pane 以内联方式出现，卡片树可见；
   - **用 `claude --fork-session` 产生的分支能挂在父会话下，并出现父子连接线；不再全部显示为根**；
   - 多个完整副本挂到同一个原始会话下，原始会话保持为根；
   - `Tab` 能在按钮间移动，`Enter` 激活；
   - 方向键能滚动；
   - 当前卡片带"当前"标记；
   - 按非当前卡片标题后，剪贴板得到 `claude --resume <id>`，toast 明确；
   - 面板中没有删除按钮；
   - `r` / `e` / `c` 快捷键有效；
   - 导出生成 `session-graph-<id>.html`；
   - 关闭面板后 `/session-graph` 能重新打开。

4. 打开新的终端窗口，粘贴 `claude --resume <id>`，确认能恢复对应会话。

### 8.3 Desktop 手动验收

1. 在 Desktop Code tab 中打开/恢复/切换会话，确认面板自动打开。
2. 点击非当前卡片，确认仍通过桌面深链打开。
3. 删除一个无子分支的会话，确认确认对话框和删除结果不变。
4. 确认连接线仍有流动动画。
5. 确认首次绘制仍写一条 transcript 日志。

---

## 9. 风险与开放问题

| 风险 / 问题 | 影响 | 建议 |
|---|---|---|
| `claude --resume <id>` 依赖 CLI 登录状态和项目上下文 | 复制的命令在错误目录可能找不到会话 | 文档说明在同项目目录运行；必要时 P2 改为带 `cd` 的命令 |
| OSC 52 剪贴板在 SSH/tmux 中可能不可用 | 复制静默失败 | toast 同时显示完整命令，用户可以手动复制 |
| 没有 App 记录时 rewind/clear 产生多张卡片 | CLI 视图比 Desktop 碎 | 文档说明；P2 研究 CLI 转录合并 |
| CLI 转录在复制时被改写 `sessionId`（非 `--fork-session` 路径） | provenance 不适用，该分支仍可能显示为根 | App 记录优先；文档说明；P2 再研究文件创建时间等信号 |
| 一个 unit 有多个外来 `sessionId` 来源 | 可能选到间接祖先而不是直接父 | 按消息数从多到少检查，只接受“外来消息构成前缀”且能映射到 unit 的来源；不满足就回退到包含关系/根；加测试 |
| provenance 可能把“复制来源”误当成“直接父” | 跨多代的 fork 可能挂到中间祖先而不是直接父 | 当前 CLI 数据里复制来源就是直接父；若发现多代链，按最大前缀 + 层级校验收紧 |
| 隐藏删除按钮可能让 CLI 用户困惑 | 找不到删除入口 | 底部提示或 README 明确"删除在 Desktop 中进行" |
| 终端静态连接线改变视觉 | 少了流动效果 | 仅 terminal 生效；Desktop 不变；若需要可加慢速动画 |
| surface 在会话中途变化（Desktop attach） | 缓存的 capability 可能过期 | 每次 render/click 读取 `e.surface`；扫描时每次读取 `surfaces()`，不永久缓存 |
| 快捷键与终端/引擎按键冲突 | 误触 | 只在 terminal 设置，且仅在 Pane 持有焦点时生效；上线前手动验证 |
| 测试套件难以注入 state 快照 | surface 测试难写 | 优先尝试 `on('state.get')`；不行则提取纯渲染函数，保持 Desktop 路径不变 |
| `$.process.run` 文档标注 CLI only | Desktop 的大文件 tail 兜底可能不可用 | 与本次改动无关；保持现有 catch 降级 |

---

## 10. 发布计划

1. 代码改动合入后，更新 `.claude-plugin/plugin.json` 版本到 `0.2.0`。
2. 更新 `README.md` 的 CLI 章节和"限制"章节。
3. 运行 `claude plugin test` 和 `claude plugin validate`。
4. 在本地用 `--plugin-dir` 完成 CLI 手动验收。
5. 在 Desktop 完成手动回归。
6. 推送到 `eighteen231018/session-graph`，更新 marketplace 缓存：
   ```bash
   claude plugin update session-graph
   ```
7. 如使用 `claude plugin tag`，确认 `plugin.json` 与 marketplace 条目版本一致。

---

## 11. 任务拆解

| 任务 | 内容 | 预估 |
|---|---|---|
| T1 | **修复 CLI 分支父关系**：`foreignSessionIds` provenance、`knownChildren`、方向测试 | 1.5 天 |
| T2 | 新增 `lib/surface.ts`、`resumeCommand`、`BranchCard.cliSessionId` 与单测 | 1 天 |
| T3 | `register.tsx` terminal 打开/删除分支、按钮条件、日志、动画 | 1 天 |
| T4 | 终端快捷键、底部提示、命令文案 | 0.5 天 |
| T5 | `collect.ts` 跳过 CLI 下的会话管理器 MCP 兜底 | 0.5 天 |
| T6 | surface mount 测试 + Desktop 回归测试 | 1 天 |
| T7 | README、手动 CLI/Desktop 验收、发布 | 1 天 |
| 合计 | | 约 6.5 人日 |

---

## 12. 一句话回答

**现在的 session-graph 在 CLI 里能加载、能画图、能导出，但不能可靠地打开或删除会话，也不会自动打开面板；更严重的是，CLI 的 fork 分支因为缺少创建时间而全部退化成独立根分支。按本文 P0 改动后（优先用复制消息保留的源 `sessionId` 恢复父子关系），CLI 会成为"分支树正确 + 可看图 + 一键复制恢复命令 + 无删除入口"的完整只读视图，同时 Desktop 的所有现有行为保持不变。**

---

## 13. 0.2.0 实现与验证记录（2026-10-21）

前文保留为 0.1.13 基线分析与验收计划。本节记录当前代码的实现状态。

### 已实现

- T1：App 父链优先，其次使用复制消息的来源 `sessionId`，最后保留原有包含关系兜底；排除已知子孙节点，防止方向反转或覆盖 App 父链。时间戳相同或缺失时，来源前缀检查使用转录顺序，不使用 UUID 排序。
- T2：新增 `lib/surface.ts`、`resumeCommand` 和可选的 `BranchCard.cliSessionId`；App 卡片使用 live transcript ID，旧快照仍可回退到 `sessionId`。异常文件名字符会做 shell 引号转义。
- T3～T5：terminal 的卡片动作复制恢复命令，隐藏删除按钮并保留防御性拦截，日志写 debug，连接线不播放脉冲动画；增加 `r/e/c` 和焦点/键盘提示；扫描仅在存在 Desktop surface 时调用远程会话管理器，并在每轮扫描重新判断。
- T6：新增来源推断、扫描和完整卡片树挂载/交互测试，覆盖 Desktop 自动打开、深链与 tool fallback、删除确认/取消/子分支保护、动画、日志及默认快捷键。
- P1：CLI 静态导出显示恢复命令和同项目目录提示；无可绘制 surface 时给出准确提示。宿主实际返回的原因可能是 `no-surface: ...`，因此同时支持简码和带说明的原因。
- 更新 README 与插件版本 `0.2.0`。

### 已完成的验证

- `claude plugin test`：**63 pass，0 fail**，包括原有 24 个测试。
- TypeScript `tsc --noEmit`：通过。
- `claude plugin validate`：通过，没有新增结构错误；仍有原有的 author、LICENSE、icon 和本地 `.DS_Store` 发布检查提示。
- 对 1.6 的两组真实转录只读回放，使用实际 `parseTranscript` / `buildGraph` 且令 `createdAt = 0`：MyClaude 的 3 个 fork 和 Claude_plugin 的 5 个完整副本均指向预期父会话，两个原始会话保持为根。
- CLI `--plugin-dir ... -p /session-graph`：模块加载、`/session-graph listed` 和命令处理成功；headless 模式无 surface 属于正常结果。沙箱运行同时出现了宿主 transcript 写入的 `EPERM` 和本地 socket 监听失败，未将此记录作为真实终端绘制验证。

### 待执行

- 真实交互式终端的 Tab/Enter、滚动和快捷键人工验收；mount 测试验证元素与事件，不验证 Ink 的实际绘制。
- Desktop 实际窗口的手动回归；当前已完成自动化回归，尚未人工验收。
- 第 5.3 节 P2 项目（CLI 多转录合并、多代来源消歧、跨目录恢复等）保留后续研究。
- 提交、推送和更新 marketplace 尚未执行。

## 14. CLI 体验完善与多 surface 修复（2026-10-22）

### 本轮实现

- 完成 P1 标题回退：仅在 terminal 将自动生成的“会话 <短 ID>”替换为首条用户消息预览与短 ID；自定义标题、`matchTitle`、共享图谱快照及 Desktop 标题均不改写。CLI HTML 导出使用同样的显示标题。
- 完成 P1 当前分支定位：顶部显示当前会话标题；“定位当前”按钮与 `g` 快捷键调用宿主滚动 API，将当前卡片标题带入视口。拒绝或异常时显示滚动提示，错误详情只写 debug。
- 修复窄终端横向溢出：二维树可容纳时沿用原布局，超过列数时仅 terminal 改为带树形缩进的纵向卡片列表。深层缩进有上限，为卡片保留宽度；Desktop 和导出的二维树布局保持原样。
- 修复多 surface 日志互相干扰：绘制内容和视口的记录按 surface 保存，避免 terminal 与 Desktop 交替绘制时把同一份 Desktop 树重复记入 transcript。

### 验证结果

- `claude plugin test`：**77 pass，0 fail**（原有 24 个测试仍通过）；新增标题不变性、窄终端多兄弟分支/深层缩进、当前分支导航、多 surface 日志与动作隔离测试。
- TypeScript `tsc --noEmit`、`git diff --check`：通过。
- `claude plugin validate`：通过；发布元数据告警与上一轮一致。
- Claude Code CLI `2.1.308` 的真实 PTY 验证：在已信任的项目根目录恢复已有会话，面板实际绘制了 5 张卡片和 4 条连线；确认 Tab 移动焦点、Shift+Tab 反向移动、Enter 激活刷新、`r` 刷新、`g` 定位当前卡片、↑/↓ 滚动均有效。
- `g` 的宿主记录为 `ui.scroll Pane session-graph (plugin) ...: moved`；上下方向键记录为 `origin=person` 的滚动。当前测试运行器未实现 `$.ui.scroll` 的服务入口，因此导航请求、拒绝与异常通过依赖注入的单元测试覆盖，实际滚动另由上述 PTY 验证。
- 沙箱仍拒绝宿主向 `~/.claude` 写入转录；恢复已有会话可以读取现存转录并绘图，该限制不影响本轮上述键盘交互验证。

### 剩余范围

- 窄终端排列已有几何约束和完整卡片挂载测试，仍需实际小窗口的视觉验收；剪贴板与导出行为保持自动化验证。
- Desktop 真实窗口的人工回归、P2 数据研究、提交与发布尚未执行。

## 15. 修复终端首屏看不到分支树（2026-10-22）

复现结果：宿主默认给 inline Pane 约三分之一的终端高度。原来的工具栏、当前标题与空行，再加上 9 行高的卡片及 5 行层间距，使首屏只露出根卡片顶部；分叉线和子分支均在窗口外。元素挂载成功不能证明这些内容在实际视口可见。

修复内容：

- 独立 CLI 打开时请求 `rows: 24` 和键盘焦点；标题更新时保留该高度请求。Desktop 或 Desktop 与 terminal 同时连接时，保持原来的默认打开参数。
- terminal 卡片压缩为 5 行，层间距压缩为 1 行；标题、消息预览各占一行，精简工具栏并将滚动提示放到树前。Desktop 与 HTML 导出仍使用 9 行卡片和 5 行层间距。
- 卡片行高由布局结果驱动，避免布局与渲染的固定高度不一致。
- 新增小视口可见性与 CLI/Desktop 打开参数测试。

验证：**81 pass，0 fail**，类型检查通过。真实 CLI 的 80 列 PTY 中关闭并重新打开 `/session-graph`，初始窗口已显示根卡片、分叉连线和子分支标题；不额外切换焦点即可用方向键滚动。宿主仍可根据可用空间和用户保存的手动尺寸限制面板高度，因此保留滚动与 `g` 定位入口。

## 16. 修复内置 `/fork` 改写来源 ID 后丢失父子关系（2026-10-22）

本轮按用户澄清排查父关系识别。此前的面板裁剪修复不解决这项数据问题。

### 真实复现

项目 `/Users/mac/code/Claude_plugin/test` 中，根转录 `120044cb` 与子转录 `69e513c5` 各有 7 条解析消息，共享其中 6 条。子转录把复制消息的 `sessionId` 全部改为自己的 ID，没有外来来源 ID；双方又各有一条独有消息，没有完整包含关系，也没有 App 创建时间。旧代码从任一会话扫描都只得到一张独立根卡片。

子转录还保留了宿主写入的 `origin.kind = task-notification`、`promptSource = system` 的 `<fork-source>` 通知，其中包含共享历史截止时间；通知的 `parentUuid` 经 system/attachment 行回溯后，能够定位到共享的消息 UUID。

### 修复

- `parseTranscript` 额外提取宿主 fork 通知的标记 UUID、共享消息锚点、截止时间和通知时间；普通用户文本、失败的 `/fork` 命令、无效截止时间及缺失锚点均不作为证据。
- `collectGraph` 在读取与缓存转录时保留该元数据。仅存在 terminal、没有 Desktop surface 时启用新推断；Desktop 与混合连接沿用已有路径。
- App 父链和已有来源 ID 关系优先。剩余节点根据最新 fork 通知匹配候选：候选必须包含截止时间前的完整已读历史，且不能包含该次新通知本身；必须唯一匹配，已知子孙节点不得成为父。
- 多代 fork 使用最新通知，复制的旧通知不会使孙分支挂回祖先；多个来源副本无法唯一匹配时保持未知。

### 验证

- **92 pass，0 fail**，TypeScript 检查通过；新增真实同构的“7 条消息、共享 6 条、来源 ID 全部改写”回归，以及多代 fork、来源歧义、App 父链优先、缓存和 Desktop/mixed surface 测试。
- 使用实际 `collectGraph` 只读扫描：从 `120044cb` 或 `69e513c5` 开始均得到同一棵两节点树，`69e513c5.parentSessionId = 120044cb`，根保持不反转。
- 在真实 CLI 恢复 `120044cb` 并运行 `/session-graph`，面板实际显示根、子卡片和连接线，宿主日志为 `面板已绘制（2 个分支 · 1 条连线 · 76x13 格）`。

## 17. 修复续接转录导致父候选重复（2026-10-22）

用户指出“长沙凤凰芙蓉镇旅游”没有显示为子分支。该会话对应 `cee47192`，与上一节的 `69e513c5` 是不同案例。

实际来源转录 `ab250ffc` 有宿主记录 `continued-in`，明确指向 `dc6792b1`；两份转录共享全部 10 条消息，属于同一会话的续接。此前把它们作为两个来源候选，唯一父来源检查因此失败，`cee47192` 被留为独立根。

本轮改动：

- 仅解析 `sessionId` 与转录文件 ID 一致的 `continued-in` 记录；目标冲突时不合并，复制的其他会话元数据不参与合并。
- 独立 CLI 在父关系推断前沿明确续接链合并转录；目标必须在本次扫描内，不能跨越 App 所属会话，循环关系不合并。
- 卡片和恢复命令使用续接链末端的 ID；从旧转录恢复时仍能识别当前卡片，消息按 UUID 去重。
- Desktop 与混合连接不启用该合并路径，App 记录继续优先。

读取真实转录后的树为 `dc6792b1 → cee47192 → 1e3dab9a`，没有重复根卡片。根会话首条提问为“去湖南旅游规划”，但磁盘上的自动标题已变为“长沙住宿推荐”；标题为“湖南旅游规划”的 `120044cb` 属于另一组不共享消息 UUID 的会话，不能仅凭名称关联。保留实际标题，没有改写用户转录。

本轮 TypeScript 类型检查通过，未新增或运行测试套件，尚未在终端面板人工验收本次改动。

## 18. CLI 同时展示 fork / branch 并直接跳转（2026-10-22）

本节按用户最新要求替代前文 CLI“复制恢复命令”作为主动作的方案。

### 数据与卡片

- 解析 `/branch` 复制记录的 `forkedFrom = { sessionId, messageUuid }`，要求文件自身的 `sessionId`、被复制消息的 UUID 一致，并排除 sidechain。只读保存直接来源与共享历史边界。
- 仅独立 CLI 使用该直接来源建立 branch 父链；App 父链仍优先。branch 复制的旧 fork 通知不会将它误标为 fork；后续 fork 也不会沿用祖先 branch 的类型。
- 宿主 branch 成功输出中的目标 ID、来源 ID 与记录一致时，读取其明确创建时间。识别 fork 的来源候选时，排除在共享历史截止之后才创建的 branch，避免新建 branch 后原有 fork 消失。
- CLI 标题改为完整的 live CLI 会话 ID，类型单独显示根 / fork / branch。描述只选分支边界后的首条实际用户提示词，排除继承消息、meta、系统通知、命令和工具结果；没有新提示词时显示“分支后尚未输入提示词”。Desktop 标题、描述和原始转录不改写。
- terminal 卡片改为 6 行，增加类型行，二维卡片宽度至少 44 列以容纳完整 UUID；超宽时沿用纵向缩进排列。共享布局的新宽度参数默认仍是原有 Desktop 尺寸。CLI HTML 导出同步显示 ID、类型、描述与恢复命令。

### 会话跳转

- CLI 点击卡片调用宿主 `$.command.run({ command: 'resume', args: id })`，在当前 REPL 切换；不通过 `process.run` 启动一个缺少交互终端的嵌套 Claude 进程。
- 切换后读取 `$.session.id()` 确认已经进入目标 ID，才显示成功。点击当前卡片不重复恢复，跳转期间拒绝重复点击。
- 首版曾依赖宿主的后台占用提示，并错误地给 `claude stop` 传完整会话 UUID；本节的停止与完成判定已由第 19 节修正。
- 失败时保留具体原因并尝试复制 shell 恢复命令。CLI 在 resume / clear 后保留扫描计时器，更新当前分支；Desktop 的打开、删除和生命周期路径维持原有处理。

### 本轮检查

- TypeScript 类型检查、`git diff --check` 通过；插件 manifest 和 hooks 验证通过。目录发布仍有原来的 LICENSE 缺失及 author、icon、`.DS_Store` 提示。
- 只读读取真实项目转录后，`a1a73b3b` 为根，`de2ffc5f` 为其 fork 子分支，`f44f0032` 为其 branch 子分支，两种子分支出现在同一棵树。branch 描述为“北京烤鸭怎么做的”，不是根提问或 branch 前的“北京有什么美食”。
- `92fa61cb → 6f39376a` 的 fork 描述为“从北京怎么去广州”；湖南组仍为 `dc6792b1 → cee47192 → 1e3dab9a`，中间 fork 描述为“去凤凰在哪里住”，无新提示词的孙分支显示空状态。
- 未新增或运行测试套件。本轮未实际停止用户后台任务，也未在交互终端执行真实跳转；这部分仍需人工验收。

## 19. 修复 fork 跳转误报及后台停止参数（2026-10-22）

用户反馈“宿主未切换到目标会话；已复制恢复命令”。排查安装的 CLI `2.1.308` 实现，发现两个问题：

1. `/resume` 对活动后台会话会优先调用 `attachLiveBackgroundSession`，打开后台视图，此时主会话 `session.id()` 不变；local-jsx 命令显示的消息也不一定作为 `command.run` 的 `text` 返回。此前在空返回后就判断失败，既可能误报，也无法进入依赖英文错误文本的停止逻辑。
2. `claude stop` 的参数是后台任务 ID（列表的 `id`，当前为 8 位十六进制），不是完整转录 UUID（列表的 `sessionId`）。CLI 的解析器按任务 ID 前缀查找，传长 UUID 无法匹配。

本轮改为先读取活动后台列表，用完整 `sessionId` 唯一匹配目标，取该行经过格式检查的任务 `id`，必要时停止此任务，再执行 `/resume <完整会话ID>`。不会截取会话 UUID 来猜任务 ID，也不按标题查找。停止失败立即返回具体原因；列表读取失败的 fork 不冒然进入后台视图。

命令返回后有界等待主会话 ID 更新；若后台进程恰好在首次查询后启动，会重新读取列表并处理一次。停止后的恢复有界重试，不依赖命令打印英文占用提示；增加查询失败、停止失败和恢复阶段的 debug 信息与“正在跳转”提示。Desktop 路径没有改动。

排查时在真实 PTY 恢复 `120044cb`，打开 graph 后点击已停止的 fork `69e513c5`，确认宿主能实际切换主会话、卡片当前标记和面板 ID，退出时显示 `claude --resume 69e513c5-ac00-4962-a300-85b7fbb6e8a2`。这确认了 `/resume` 对已停止 fork 的恢复路径。调试日志位于 `/private/tmp/session-graph-cli-navigation-issue.log`；沙箱仍拒绝宿主写入 `~/.claude` 转录。

TypeScript、`git diff --check` 与插件校验通过，目录元数据提示不变。没有新增或运行测试套件；排查时活动后台列表为空，没有实际执行停止用户后台 fork 的操作，停止后完整链路仍待在用户活动 fork 上验收。
