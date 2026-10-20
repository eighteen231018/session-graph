# session-graph

**session-graph** 是一个 Claude Code 插件，用卡片树展示当前项目中的会话分支关系。每个 Claude Code 会话显示为一张卡片，包含分支名称、首条用户消息和会话统计；点击卡片可尝试打开对应会话。

## 功能

- 以树形卡片展示根会话和由 fork 创建的分支，并标记当前会话。
- 将同一 App 会话对应的多份 CLI 转录合并为一张卡片，避免 rewind、编辑重发或清空后出现重复分支。
- 刷新图谱、复制当前会话 ID，并导出可离线查看的静态 HTML。
- 在面板中删除会话前要求确认，并通过宿主的会话管理器执行删除。
- 支持面板主题切换；会话记录不可用时提供降级视图。

## 安装

克隆仓库后，将插件目录传给 Claude Code：

```bash
git clone https://github.com/eighteen231018/session-graph.git
claude --plugin-dir ./session-graph
```

加载或更新插件后，在 Claude Code 中运行 `/reload-plugins`。

## 使用

```text
/session-graph          打开分支图谱
/session-graph focus    打开面板并请求键盘焦点
/session-graph refresh  刷新图谱并打开面板
/session-graph export   导出静态 HTML
/session-graph close    关闭面板
```

在面板中可以刷新图谱、导出 HTML、复制当前会话 ID，或打开和删除卡片对应的会话。Claude Code Desktop 的交互式会话会自动打开面板；其他情况可运行 `/session-graph` 手动打开。

## 数据与隐私

- 图谱从本机 `~/.claude/projects` 中的转录文件读取消息，并尝试读取 Claude Code App 的本机会话记录以识别会话标题、分支关系及多个转录文件之间的对应关系。
- 插件不会自动上传会话数据。运行 `export` 会在当前项目目录生成 `session-graph-<会话ID>.html`；导出文件包含消息预览和会话 ID，请在分享前检查内容。
- 删除操作通过宿主提供的会话管理器执行。管理器不可用或拒绝删除时，插件不会绕过它直接删除转录文件。

## 限制

- 跳转到会话依赖宿主的会话管理能力，属于尽力而为；不可用时插件会提供会话 ID 作为替代。
- 本地转录和 App 会话记录是宿主的存储格式，不是插件专用的稳定 API。记录缺失或格式变化时，图谱会尝试降级显示当前会话。
- 插件扫描当前项目最近的 32 份转录，并额外包含当前会话的转录。更早且不再包含在扫描范围内的分支可能不会显示。
- 没有 App 记录的会话只能从共享消息推断父子关系：只有一方完整包含另一方在分叉时的历史时才确定方向；双方在分叉后都继续增长，或历史完全相同时，方向保持未知，不会按消息数量猜测。

## 项目结构

```text
session-graph/
├── .claude-plugin/plugin.json  # 插件元数据
├── hooks/hooks.json           # 插件入口配置
├── hooks/register.tsx         # 命令、面板和事件处理
├── lib/                       # 转录读取、图谱构建、布局和导出
├── tests/                     # 分支分组测试
└── types/                     # 图谱数据类型
```
