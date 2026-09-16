# AI-Built-Tools

AI-Built-Tools 是一个用于整理 AI 构建、AI 辅助开发和自动化工具的集合仓库。

## 目录结构

```text
AI-Built-Tools/
├── 01-browser-extensions/
│   ├── edge/
│   │   └── path-vault-edge/
│   ├── chrome/
│   └── shared/
├── 02-ide-plugins/
├── 03-codex-plugins/
├── 04-codex-skills/
├── 05-ai-agents/
├── 06-ai-automations/
├── 07-web-tools/
├── 08-desktop-tools/
├── 09-cli-tools/
├── 10-document-ai/
├── 11-data-ai/
├── 12-image-ai/
└── 99-archive/
```

## 目录说明

| 目录 | 说明 |
|---|---|
| `01-browser-extensions` | 浏览器扩展，目前包含 Microsoft Edge 扩展 |
| `02-ide-plugins` | IDE、编辑器插件 |
| `03-codex-plugins` | Codex 插件 |
| `04-codex-skills` | Codex Skills |
| `05-ai-agents` | AI Agent、自动化代理 |
| `06-ai-automations` | 定时任务、工作流自动化 |
| `07-web-tools` | Web 工具、在线工具 |
| `08-desktop-tools` | 桌面应用 |
| `09-cli-tools` | 命令行工具 |
| `10-document-ai` | Word、PDF、文档处理类 AI 工具 |
| `11-data-ai` | Excel、数据分析类 AI 工具 |
| `12-image-ai` | 图片生成、图片处理类 AI 工具 |
| `99-archive` | 归档、停用或历史版本工具 |

## Edge 扩展：应用级密码库

路径：

```text
01-browser-extensions/edge/path-vault-edge
```

功能：

- 按 URL 第一层路径区分不同应用，例如 `/TPBidderCS`、`/TPFrameCS`
- 同一 IP 和端口下不同应用可以保存不同账号密码
- 账号密码使用 AES-256-GCM 加密
- 主口令使用 PBKDF2-SHA256 派生密钥
- 支持自动填充、多账号选择和默认账号
- 支持浏览器重启后自动解锁
- 支持记录 Edge 默认填充后提交的账号密码
- 支持导出和导入加密备份

### 安装

1. 打开 Edge。
2. 进入 `edge://extensions/`。
3. 打开“开发人员模式”。
4. 点击“加载解压缩的扩展”。
5. 选择目录：

```text
D:\AI-Built-Tools\01-browser-extensions\edge\path-vault-edge
```

注意：Edge 的“加载解压缩的扩展”只能选择文件夹，不能选择 `.zip` 文件。

## 版本记录

Edge 扩展的版本记录：

```text
01-browser-extensions/edge/path-vault-edge/CHANGELOG.md
```

插件内也可以点击“版本记录”查看。

## License

Apache License 2.0
