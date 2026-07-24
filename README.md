# Ink Asset Studio

Ink Asset Studio 是一个面向 iPad、Apple Pencil 和离线创作的独立 Ink PWA。它在 `E:\MyDemo\InkAssetStudio` 内自包含运行，不会在运行时引用或写入 `E:\MyDemo\Painting`。

当前实现覆盖计划中的 Studio 范围：多 Ink Group、Plane/Cuboid/Sphere、完整 Outline/Fill 工具、Normal Outset、压感开关、简化地形、Map Reference、Ink 专属硬阴影、完整可调的 Painting 兼容预览灯光、直接可见的 Undo/Redo、IndexedDB 自动保存、工作文件导入导出和离线应用外壳。Painting 侧导入器和真实 iPad/Apple Pencil 硬件验收仍属于后续单独工作。

正式 PWA：<https://mario8664.github.io/InkAssetStudio/>

## 本地开发

要求：Node.js 20 或更新版本。

```powershell
cd E:\MyDemo\InkAssetStudio
npm.cmd install
npm.cmd run dev
```

开发服务器固定使用 `http://127.0.0.1:1430/`。它只用于 Windows 本地开发，不是当前阶段的 iPad 安装地址。

## 完整验证

```powershell
npm.cmd run build
npm.cmd run preview
```

生产预览固定使用 `http://127.0.0.1:4430/`。预览服务器运行时，可在另一个终端执行：

```powershell
npm.cmd run visual-check
```

`build` 会依次执行 TypeScript/Vue 类型检查、Vitest 测试、生产构建和 Service Worker 预缓存清单生成。`visual-check` 使用本机 Chrome 做真实浏览器操作、文件导出/重新导入、断网刷新，以及 iPad 横竖屏布局检查。

## GitHub Pages 部署

仓库为 <https://github.com/Mario8664/InkAssetStudio>，默认分支为 `main`。`.github/workflows/deploy-pages.yml` 会在每次推送 `main` 时执行完整构建和测试，再把 `dist` 发布到 GitHub Pages。

Vite、manifest 和 Service Worker 都使用相对路径，因此可在 `/InkAssetStudio/` 仓库子路径运行。Service Worker 缓存版本包含预缓存文件的实际内容哈希，并且只清理 `ink-asset-studio-` 前缀的本应用缓存，不会删除同一 `github.io` Origin 下其他 PWA 的缓存。

## 数据安全

- 工作场景自动保存到浏览器 IndexedDB，并显示最近保存时间。
- 本地草稿不是长期备份；重要工作应使用 **Export** 保存为 `.inkstudio-work.json` 到“文件”App。
- 导入文件以作者源数据为权威，校验格式和资源上限，并重新生成派生 Ink 数据。
- 压感关闭时，新 Outline 点固定写入 `pressure: 1`；开关不会改写已有笔画。

更完整的产品和格式定义见 [InkAssetStudio_Plan.md](./InkAssetStudio_Plan.md)，实现与验收记录见 [Docs/InkAssetStudio_TODO.md](./Docs/InkAssetStudio_TODO.md)。
