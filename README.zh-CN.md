# Page Lock(中文版)

> 把笔记锁住，解锁之前无法编辑——类似 Notion 的“锁定页面”，但用于 Obsidian。

锁定后，笔记标题栏会显示锁图标，编辑器顶部可选显示一条轻量横幅；Canvas 白板也可以单独锁定。通过点击、命令或文件菜单即可解锁；如果设置了密码，还需要输入密码。

Page Lock 刻意保持小巧、本地优先：不收集遥测，不发起网络请求。锁定状态写入 frontmatter；默认允许 Obsidian 在文件重命名或移动时自动更新链接。

[English](./README.md) | **简体中文**

这是 [Page Lock](https://github.com/haivri/obsidian-page-lock) 的简体中文本地化版本，基于上游 `1.2.2`，版本号 `1.4.0`，使用 i18n 方式实现中英双语界面。界面语言默认跟随 Obsidian，也可以在 **设置 → Page Lock → Language** 中切换。

汉化与维护：[allensky708](https://github.com/allensky708)。原项目版权归 Robert Fleming 所有，按 MIT 协议发布。

---

## 功能

- 锁定后仍可选中、复制编辑器文字，以及 YAML 属性的只读预览。
- 阻止所有编辑：输入、粘贴、拖放、剪切、撤销，在实时预览和源码模式下都生效。
- 阻止阅读视图和实时预览中的任务复选框、Meta Bind 字段/按钮、属性控件；笔记链接和解锁操作仍然可用。
- 阻止其他插件写入（Templater、linter、格式化工具等）。
- 允许文件重命名/移动后自动更新锁定笔记中的链接，无需解锁，也不会放行其他修改；可在设置中关闭。
- 锁定状态保存在 frontmatter 属性中（默认 `locked: true`），会随笔记同步到其他设备。
- 同时锁定内联标题，锁定笔记无法在编辑器中重命名。
- 主题感知的胶囊横幅，一键/轻点解锁。
- 每篇笔记的标题栏都有锁定/解锁图标，阅读视图也可见。
- 阅读视图保持干净：不显示横幅，PDF 导出不受影响。
- 可通过命令面板（可设快捷键）、文件菜单/三点菜单、横幅或标题栏图标锁定/解锁。
- 桌面端和移动端均可使用；锁定笔记不会弹出键盘。
- 支持锁定 Canvas 白板：锁定后白板进入只读，无法编辑节点或连线。
- 密码解锁：可在设置中录入密码（密文显示）；只保存 PBKDF2 哈希，解锁笔记或白板时必须验证。
- Obsidian 内删除保护：锁定中的 Markdown 或 Canvas 文件，通过文件管理器/命令删除会被拒绝。
- 可选：解锁前弹出确认提示（未设置密码时生效）。

## 使用

- **锁定**：点击标题栏中的开锁图标；在命令面板执行 **切换当前文件的锁定状态**；或在三点菜单/文件管理器右键菜单中选择 **锁定笔记**。
- **解锁**：点击横幅、标题栏锁图标，或再次执行同一命令/菜单项；设置密码后需要先输入密码。
- **Canvas**：打开白板，点击右上角锁图标，或执行同一命令/文件菜单里的 **锁定白板**；解锁时同样需要密码（如果已设置）。
- 可在 **设置 → 快捷键** 中为 **切换当前文件的锁定状态** 分配快捷键，实现一键锁定。

## 工作原理

锁定状态保存在笔记的 frontmatter 中（默认属性 `locked`）。设置后：

- 编辑器在 CodeMirror 层变为只读，任何编辑都无法写入文档。
- 在插件回调修改元数据之前，会先检查 frontmatter 写入。
- Obsidian 的文件写入 API 会拒绝其他插件对锁定笔记的修改，并给出提示。
- 自动链接更新只应用 Obsidian 计算出的引用替换：正文、任务状态、无关属性和周边格式保持不变。支持 wikilink、Markdown 链接、嵌入和属性链接。是否在重命名时更新仍受 Obsidian 自己的“更新链接”设置/确认控制。
- 同步服务和外部工具仍然可以更新文件——Page Lock 防止的是 Obsidian 内部的编辑，而不是你的同步服务。

解锁就是删除该属性。因为锁只是一个普通的 frontmatter 属性，它会随笔记一起经过同步、备份和仓库迁移。

## 适用范围

- **Markdown**：锁定状态保存在 frontmatter 属性中（默认 `locked`），会随笔记同步。
- **Canvas 白板**：锁定路径保存在插件设置中，不修改 `.canvas` 文件；锁定时调用 Obsidian 内部的 Canvas 只读模式，并阻止通过 Obsidian 写入。
- **删除保护**：拦截 Obsidian 的 `vault.delete`、`vault.trash` 和 `fileManager.trashFile`，锁定文件在 Obsidian 内无法删除。
- **范围外**：Finder、终端 `rm`、同步客户端的删除不受插件控制；非 Markdown/Canvas 文件也不支持。

## 设置

- **显示锁定提示横幅**：关闭后移除横幅，只保留标题栏锁图标；编辑保护仍然生效。对已打开的笔记立即生效。
- **锁定属性名**：标记笔记已锁定的 frontmatter 属性（默认 `locked`）。
- **允许自动更新链接**：链接文件重命名或移动时，更新锁定笔记中的引用（默认开启，已有安装也适用）。关闭后锁定期间这些链接保持不变。这不会允许手动编辑链接，也不会解锁笔记。
- **解锁密码**：点击“设置密码”，在弹窗中输入并确认；输入框为密文显示。设置后解锁笔记/白板必须验证密码。只保存 PBKDF2 哈希，不保存明文。
- **解锁前确认**：未设置密码时，解锁前请求确认，避免误触导致意外解锁（默认关闭）。
- **语言**：跟随 Obsidian、English 或简体中文。

Simple Gallery 1.8.4+ 可以通过受控的 Page Lock 集成更新 gallery 代码块中的图片目标。它会遵守 **允许自动更新链接**，原子校验每个目标，并且从不解锁笔记。Gallery 更新使用 Simple Gallery 自己的重命名设置，与 Obsidian 原生链接设置独立。

原生自动链接更新使用一个经过特性检测的 Obsidian 内部钩子。如果未来版本移除该钩子，笔记仍受保护，自动更新会保持阻止状态。如果更新前引用位置或属性值发生变化，Page Lock 会保持该笔记不变并显示提示，而不是冒险修改无关内容。需要 Obsidian 1.8.7 或更高版本。

## 从 Note Lock 迁移

Page Lock 取代了本项目原先的 `note-lock` 插件 ID。安装此版本前请先禁用旧插件，不要同时启用两个副本。保留原 `data.json` 到新的 `page-lock` 文件夹，并把命令快捷键更新到新的前缀。`locked` frontmatter 属性没有变化，已有锁定笔记会保持锁定。

如果你安装过 Robert Fleming 的 Note Lock，请在部署 Page Lock 前关闭 Obsidian，并在源码仓库运行 `python3 scripts/migrate-install.py /path/to/vault`。脚本会备份旧安装并保留设置、启用状态和命令快捷键；之后重启 Obsidian。这个迁移不适用于另一个同名的社区插件 Note Lock。

截图是在改名之前截取的，仍显示旧名称；锁定界面没有变化。

## 安装

### 使用 BRAT（推荐用于本汉化版）

1. 安装并启用 **BRAT**。
2. 命令面板执行 **BRAT: Add a beta plugin for testing**。
3. 输入：

   ```text
   allensky708/Page-Lock
   ```

4. 点击 **Add Plugin**，BRAT 会从最新 Release 下载 `main.js`、`manifest.json`、`styles.css`。
5. 到 **设置 → 第三方插件** 启用 **Page Lock**。

> 本汉化版与官方版使用相同的插件 ID（`page-lock`），会覆盖同一插件目录，但 `data.json` 中的设置会保留。不要同时安装两个版本。

> 密码只是 Obsidian 内的解锁门槛，不是内容加密；能直接访问 `data.json` 或文件系统的人仍然可以绕过。真正防止删除请配合 macOS 只读权限或备份。

### 手动安装

从本仓库的 Release 下载 `main.js`、`manifest.json`、`styles.css`，放入：

```text
<你的仓库>/.obsidian/plugins/page-lock/
```

然后重启 Obsidian，在 **设置 → 第三方插件** 中启用 **Page Lock(中文版)**。

### 社区插件市场

官方版上架后，可在 **设置 → 第三方插件 → 浏览** 中搜索 **Page Lock**。本汉化版请使用 BRAT 或手动安装。

## 开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev     # esbuild 监听模式
npm run build   # 类型检查 + 生产构建
npm run lint
npm test        # 构建并运行 Node 测试
```

## 许可证

[MIT](./LICENSE) © 2026 Robert Fleming

简体中文本地化部分由 allensky708 维护，同样以 MIT 协议发布。
