# Ink Asset Studio 计划

## 1. 文档目的与状态

本文定义 `E:\MyDemo\InkAssetStudio` 中的独立软件项目 **Ink Asset Studio**（下称 Studio）的确认方向。Studio 是一个以 iPad 为主要设备的离线 Ink 创作工具，用于以与 Painting 项目兼容的 Ink 规则制作、检查和整理可编辑的 Ink 工作场景。

本文件是 Studio 后续开发的源计划。Studio 的源代码、构建配置、测试、PWA 文件和文档均放在本目录中；当前阶段**不得修改** `E:\MyDemo\Painting` 的源码、数据、文档、构建配置或依赖。

Studio 后续与 Painting 的文件导入对接是一个单独的、需在 Painting 仓库中另行确认的工作。本项目先定义稳定交换格式、导出和验证规则，不在本项目阶段向 Painting 写入任何文件。

## 2. 产品定位

Studio 不是图片画板、Procreate 导入器、远程桌面，也不是完整游戏地图编辑器。它是一个安装到 iPad 主屏幕、以 Apple Pencil 为主输入的 **移动 Ink 编辑器**。

它让作者在离线状态下完成以下闭环：

1. 建立一个带格子、方块和坡面的工作场景；
2. 在场景中创建、摆放并编辑多个 Ink Group；
3. 用与 Painting Ink 一致的 Shape、描边、Fill 和填充规则制作可编辑内容；
4. 在 Map Reference、Ink、Ink 硬阴影和可调灯光下检查结果；
5. 自动保存本地草稿，并导出工作场景文件；
6. 以后将工作场景文件交给 Painting 的桌面导入功能，作为可继续编辑的场景内容而不是位图。

`InkGroup` 仍是基本创作单位。一个 Group 表达一株植物、一组书架、一个店面立面、一个路口图案或其他完整视觉组合；一个工作场景可包含任意多个 Group 及其摆放引用。

## 3. 已确认目标

### 3.1 核心创作能力

- 一个工作场景可包含多个 Ink Group、每个 Group 多个 Shape。
- Group 保留稳定 `id`、名称、局部 Pivot、连续世界坐标摆放和 `0 / 90 / 180 / 270` 度离散 Y 轴旋转。
- Shape 保留与 Painting 一致的 `plane`、`cuboid`、`sphere`、`cylinder`、`frustum` 五类，以及位置、YXZ 旋转和固有尺寸；Cuboid 使用 XYZ size，Sphere 使用 radius，Cylinder 使用 radius/height，Frustum 使用 top size/bottom size/height；不提供通用 Transform Scale。
- Cuboid、Sphere、Cylinder 与 Frustum 提供 Painting 当前的 `normalOutset` Shape 配置：可切换启用、设置壳颜色与 `0.001～1` 世界单位外扩距离；默认距离与默认 Outline 宽度同为 `0.035`。壳 Geometry 直接烘焙最终内在尺寸和 `distance`，不在 shader 中按插值 normal 二次外扩：Cuboid、Cylinder、Frustum 使用逐面恒距 miter 壳，Sphere 使用无接缝的 `radius + distance` 径向外球。Plane 不提供该配置；每张壳面复用对应 Fill 图表的纹理与 UV 裁切，并以相同的 `alpha < 0.5` 阈值裁去透明像素；没有 Fill 图表时不创建壳资源。壳不参与 Half-Lambert 或 Ink 硬阴影，关闭时不保留 Mesh 或 GPU 资源。
- Move 与 Rotate 手柄支持 Unity 风格的 World/Local 坐标空间切换；该选择只属于 Editor Session。Shape 列表在删除按钮左侧提供眼睛按钮，可将指定 Shape 临时排除出绘制、吸色与 Shape 拾取，但不隐藏其已提交 Ink 渲染结果，也不写入作者源、导出、Undo/Redo 或内容 dirty。
- 提供完整 Ink 工具：描边绘制、描边擦除、填色绘制、填色擦除、Bucket Fill、吸色、颜色调整、可编辑色板、笔刷尺寸、直线辅助、Group/Shape 选择、Undo/Redo。
- Fill 仍是每个 Shape 表面图表上的可编辑稀疏 RGBA 块，不把绘制轨迹当作 Fill 的权威数据。
- 描边仍是带压力点的可编辑表面坐标序列，并编译为世界宽度 Ribbon。

### 3.2 压感开关

Studio 的 Ink 工具状态必须提供始终可见、可随时切换的 `压感：开 / 关` 控件。

- 默认开启，Apple Pencil 压力按当前 Ink 规则写入新描边点。
- 关闭时，新描边采样统一写入 `pressure: 1`，忽略 Pencil 的原始压力。
- 切换仅影响切换之后开始采样的新点；不得回写、归一化或重新解释已提交笔画的历史压力。
- 该设置属于 Studio Editor Session，不属于 Ink Group、公开资产或交换文件中的作者内容。
- Fill、Bucket Fill 和橡皮的尺寸继续由各自的工具数值决定，压感开关不改变它们的既有语义。

### 3.3 简化格子地图

Studio 提供真实的地形几何参照，而不是二维背景图。它只包含 Paintng 首版已定义的三种格子地形：

- `block`：实体方块；
- `slope`：单个 45° 坡面；
- `corner-slope`：两个 45° 坡面组成的角坡。

每个地形格保留 `x/y/z` 格子坐标、类型、`0 / 90 / 180 / 270` 度旋转和基础颜色。地形形状、坡面高度、旋转方向与 Painting 的 `TileCell` 语义完全一致；Studio 不得另行发明近似的坡面或坐标系。

Studio 只提供放置、删除、工具切换、旋转和必要的颜色编辑。它不包含玩家、碰撞、出口、NPC、剧情、地图切换、Game Window、游戏运行时或地形玩法规则。

### 3.4 预览渲染

Studio 只提供下列渲染路径：

| 路径 | 状态 | 用途 |
| --- | --- | --- |
| Map PBR | 关闭 | 不在移动端运行生产级地形材质、GTAO 或环境反射。 |
| Map Reference | 开启 | 使用当前 Half-Lambert 风格显示地形颜色、体积和坡面。 |
| 编辑期格子与坡向辅助 | 开启 | 地块真实边缘、近似无限网格与 X/Y/Z 坐标轴可分别开关，清楚显示单元边界、坡向、选择状态和绘制落点；永不作为最终资产内容。 |
| Ink Ribbon / Fill / Normal Outset | 开启 | 显示最终 Ink 描边、填色、可选法线外扩壳和真实深度遮挡。 |
| Ink 专属硬阴影 | 开启 | 保留 Ink 视觉表现必须的硬阴影。 |
| 常规 PCF 阴影、GTAO、PMREM | 关闭 | 不运行与移动端 Ink 创作无关的重型路径。 |

Ink 硬阴影复用 Painting 已确认的语义：最近采样深度图、目标密度 `64 px / 世界单位`、不改变 Three.js 的常规 PCF 阴影配置。Studio 的 Reference 地形不投射、不接收此 Ink 专属阴影；该深度图只包含 Ink 自身的已批准投射体，并只在 Ink 投射/接收对象的 Transform 或几何、以及灯光方向等真实输入改变时失效。地形 Reference、灯光颜色和强度的变化不得无故重建阴影深度图。若设备最大纹理尺寸不足，Studio 必须显示清晰的可恢复提示，而不是悄悄改变作品数据。

### 3.5 灯光预览

Studio 提供与 Painting 当前 Global Lighting 相同语义的灯光调节，用于实时检查 Reference 与 Ink 的视觉效果。

新建工作场景的完整灯光初值必须复制自 Painting 当前实际保存的 `global-lighting-default-instance.json`，不能使用源代码中的历史默认常量。当前基线为：昼夜位置 `0`、太阳路径 X 倾角 `-12°`、Z 偏移 `15°`、全局地形反弹 `0.5`；Day 与 Night 的主光、环境光、背景、反射天空/地面、反射强度和地形反弹亮度也全部使用该实例的保存值。

所有 Global Lighting 参数均可编辑并随工作场景保存。`-1～1` 的昼夜位置是最高频参数，界面必须将它作为重点触控滑杆直接呈现；太阳路径、全局反弹和完整 Day/Night Profile 也必须保留编辑入口，并提供一键恢复 Painting 当前基线。首次版本中未修改过其它灯光参数的旧草稿可迁移到新基线，同时保留其昼夜位置；已有自定义灯光不得被迁移覆盖。

昼夜求值复用 Painting 当前规则：环境光和背景按 `abs(dayNightPhase)` 在线性工作色彩空间插值；太阳/月亮沿相同 X 倾角、Z 偏移与相位路径运行，根据天体方向选择 Day 或 Night 主光，并按地平线高度衰减强度。Studio 遵循 Painting 的 command 式合成边界：Map Reference 先捕获 `referenceColor + referenceDepth`，再以不写主深度的全屏合成进入 HDR 主画面，并由 `OutputPass` 执行 sRGB、ACES Filmic 和 `1.05` 曝光；Ink 随后直接显示其原始作者 sRGB 值，禁止对 Ink 执行 ACES 或 sRGB 解码/编码。Ink 仍可在原始色值上叠加其既有的 Half-Lambert、环境光和 Ink-only 硬阴影；Reference 不写 Ink 使用的主深度，因而绝不遮挡 Ink。编辑辅助最后作为 overlay 绘制。Studio 只支持 `Reference = 1 → 3 → 5 → 7`、`Ink = 6 → 7` 与 `Reference + Ink = 1 → 3 → 5 → 6 → 7` 三种组合。Map Reference 的 Half-Lambert 必须在 Three.js 展开灯光 ShaderChunk 前注入，不能依赖展开后的字符串替换。由于 Studio 明确只运行 Map Reference 而不运行 Map PBR/PMREM/地形色反弹，Sky、Ground、Reflection 和 Bounce 参数在当前预览中只负责兼容保存，仍可编辑但不虚构额外渲染效果。

灯光在 Studio 中首先是**工作场景预览状态**：它随工作场景保存，以便作者下次打开时看到相同效果；它不会自动改写 Painting 中由多个地图共享的 Global Lighting。未来 Painting 导入器可以明确提供一次性“应用此预览灯光”的选择，但该选择不属于本项目当前实现范围。

## 4. 非目标与明确不做的内容

本项目不实现以下能力，除非日后经明确确认：

- 从 PNG、PSD、Procreate 或其他外部绘画软件自动生成 Ink 描边、Fill 或 Shape；
- 完整 PBR 地图表现、实时软阴影、GTAO、环境 PMREM，或除 Map Reference 最终颜色管理 `OutputPass` 外的效果型后处理或性能降级替代视觉；
- 玩家控制、碰撞验证、出口、NPC、剧情、Game Window、Play Mode；
- 云同步、账号、多人协作、局域网配对、远程写入 Painting 目录；
- 直接在 iPad 上打开或修改 Painting 工程目录；
- App Store 发布、原生 iOS 壳、macOS/Xcode 构建链；
- 自动把移动端多个 Group 合并进一张已有 Painting 地图。

## 5. 软件形态与离线策略

Studio 以 Vue + Three.js 的静态 PWA 形式构建，目标设备为支持 Apple Pencil 的 iPad Safari / 主屏幕 Web App。它在视觉上是独立的全屏应用，而不是桌面网页的缩小版。

### 5.1 当前部署形态

- 开发、构建和本地验证均在 Windows 完成。
- PWA manifest、Service Worker、离线应用外壳缓存和 IndexedDB 草稿存储在项目内实现。
- 源码托管在 `Mario8664/InkAssetStudio`，`main` 分支通过 GitHub Actions 构建并部署到 GitHub Pages。
- 正式 HTTPS 地址为 `https://mario8664.github.io/InkAssetStudio/`；首次打开并完成预缓存后可离线使用。
- Studio 不需要自建服务器或 Windows 常驻服务，也不要求 iPad 与电脑持续保持网络连接。

### 5.2 后续部署原则

可靠的离线 PWA 必须至少一次从可信 HTTPS Origin 安装并预缓存应用外壳。普通 `http://192.168.x.x` 局域网地址不能作为正式的离线安装方案，因为 iPad Safari 的 Service Worker 安全上下文要求无法满足。

本项目已经选择第一种方式：

1. GitHub Pages 无后端 HTTPS 静态托管，仅用于首次安装与应用更新；资产和草稿不上传。

局域网 HTTPS 配对不属于当前部署流程；如果以后需要，再作为独立功能设计。

### 5.3 本地数据安全

- IndexedDB 是自动保存和崩溃恢复的工作副本，不是唯一长期备份。
- 工作场景必须可随时手动导出到 iPad“文件”App。
- 应用必须显示本地保存状态、最后保存时间和尚未导出的变更提醒。
- 浏览器存储被系统回收、PWA 被卸载或设备故障后，未导出的本地草稿可能不可恢复；界面不得暗示 IndexedDB 等同于可靠备份。

## 6. 架构边界

Studio 是独立项目，**不能直接从** `E:\MyDemo\Painting\src` **导入运行时代码**。这样可确保在不修改 Painting 的前提下开发、构建和发布 Studio。

Studio 可以根据已确认的兼容契约移植必要的领域逻辑；每一份移植逻辑必须有明确来源、测试和格式版本说明。长期如需消除重复，应在另行确认后抽取一个真正独立、内容无关的共享包，而不是让 Studio 反向依赖 Painting 工程。

建议目录职责如下：

```text
InkAssetStudio/
├─ Docs/                         项目计划、TODO、格式说明和验收记录
├─ src/
│  ├─ app/                       Vue 壳、路由、全局布局和 PWA 注册
│  ├─ domain/
│  │  ├─ ink/                    Ink 作者数据、验证、编译和 Worker
│  │  ├─ terrain/                TileCell、坡面规则与编辑操作
│  │  ├─ lighting/               预览灯光数据和验证
│  │  └─ workspace/              工作场景、Undo/Redo、导入/导出
│  ├─ editor/                    触摸/Pencil 工具控制器、Inspector 与 Outliner
│  ├─ render/                    Three.js 场景、Reference、Ink、硬阴影、编辑辅助
│  ├─ storage/                   IndexedDB 文档仓库、导出文件和恢复
│  └─ workers/                   Ink 编译及其他异步计算入口
├─ public/                       manifest、图标和静态 PWA 资源
├─ tests/                        单元、格式、渲染规则和交互测试
└─ InkAssetStudio_Plan.md        当前主计划
```

Vue 仅负责工作区 UI、Inspector、工具栏和状态展示。每帧 Three.js 变换、笔画预览、Reference 和硬阴影更新不使用 Vue 响应式循环。

## 7. 工作场景与交换格式

### 7.1 工作场景的职责

Studio 的作者文件称为 **Ink Studio Work Scene**。它保存可以直接重建创作现场的内容：

- 地形格集合；
- 多个 Ink 私有源与摆放引用；
- Group 的布局关系；
- 工作场景预览灯光；
- 必要的格式版本和来源信息。

它不保存浏览器实例、GPU 资源、临时笔画预览、当前 Pointer、未提交手势或 Service Worker 缓存。

相机位置、侧栏开合、当前工具、当前颜色、色板、笔刷宽度、压感开关、Transform World/Local 空间、临时排除绘制的 Shape ID，以及地块边缘/无限网格/坐标轴三个显示开关属于 Editor Session。它们可低频地保存到本机，但不应污染可交换的作品内容；色板等确有创作价值的工具预设可作为单独的用户设置导出能力，不能隐式绑定到每个资产。

### 7.2 建议顶层格式

文件扩展名暂定为 `.inkstudio-work.json`。顶层格式必须显式版本化，且只保存可验证的 JSON：

```ts
type InkStudioWorkFile = {
  format: 'ink-asset-studio-work';
  formatVersion: number;
  sourceCompatibility: {
    paintingInkAssetSchemaVersion: 3;
    paintingInkCompiledFormatVersion: 14;
    terrainSchemaVersion: number;
  };
  documentId: string;
  name: string;
  terrain: {
    tiles: TileCell[];
  };
  ink: {
    embeddedAssets: InkEmbeddedAsset[];
    assetReferences: InkAssetReference[];
  };
  previewLighting: StudioPreviewLighting;
};
```

其中 `InkEmbeddedAsset`、`InkAssetReference`、`InkGroupData`、`TileCell` 的字段和几何语义必须与目标 Painting 兼容版本一致。Studio 不保存已解析的冗余 `groups` 视图数组。

`compiled` 数据是由作者源生成的派生缓存。`.inkstudio-work.json` 导出与 IndexedDB 草稿快照只保存作者源，不保存 Ribbon 顶点、Fill 上传数组、源哈希或 `visualFootprint`；重新打开、导入或未来进入 Painting 时均在 Worker 中重建派生数据。这样交换文件保持为可编辑的场景数据而非位图，避免重复保存渲染缓存。导入方绝不能信任旧文件可能携带的派生缓存：必须验证作者源、检查版本和哈希，并以目标项目的编译器重建或验证派生数据。交换文件的权威永远是作者源。

### 7.3 ID、引用与冲突规则

- 新建文档、Group、Shape、笔画、内嵌资产与摆放引用均生成稳定 UUID 风格 ID。
- 同一工作场景内，资产 ID 和引用 ID 必须唯一。
- Group 作者源 Pivot 固定在本地原点；摆放引用才保存世界 `anchorPosition` 与离散旋转。
- 导入方不得因为名称相同而覆盖既有 Painting 资产。
- 若目标项目已有同 ID 且内容不同，导入器必须要求选择“生成新 ID”“跳过”或显式覆盖；默认不得覆盖。
- Group 名称可重复，但 UI 必须能通过上下文或 ID 安全区分它们。

### 7.4 后续 Painting 导入契约

以后在 Painting 中实现导入时，导入器应：

1. 读取 `.inkstudio-work.json`；
2. 对文件大小、嵌套深度、数组长度、数字范围、RGBA 块、ID 唯一性和 schema version 做不可信输入验证；
3. 验证或迁移兼容的 Ink / terrain 作者数据；
4. 在 Worker 中编译/验证 Ink 派生数据；
5. 将结果创建为一张可编辑的项目场景或经用户确认的资产集合；
6. 只在 Painting 的手动 Save 事务中写入项目文件。

这项导入器属于未来 Painting 变更，不在 Studio 当前仓库中实现。

## 8. 移动交互设计

桌面 Ink 的功能语义必须保留，桌面鼠标和键盘手势不必照搬。

| 当前意图 | Studio 交互 |
| --- | --- |
| Pencil 落笔绘制 | Apple Pencil 在激活 Draw 工具且命中 Shape 时绘制。 |
| 视图导航 | 无 Pencil 悬浮或绘制时，所有编辑模式下均可用手指触控轨道导航；Pencil 和鼠标都不负责相机导航。Pencil 悬浮或绘制期间，支撑手的触摸不得旋转镜头。 |
| 选择 Group / Shape | 明确的 Select 模式，点击 Pivot 或可见的 Shape 辅助面。 |
| 直线辅助 | 工具栏中可见的直线模式/临时按钮，不依赖键盘 `Shift`。 |
| 吸色 | 独立吸色工具按钮，不依赖 `Ctrl`。 |
| 调整笔刷宽度 | 底部可拖拽数值或滑杆，不依赖右键和 Pointer Lock。 |
| 工具切换 | 拇指可触及的底栏；当前工具、颜色、笔宽、压感状态始终可识别。 |

Ink Shape 辅助面必须与 Painting 当前编辑器保持一致，而不是使用移动端自定义高亮：选中 Surface 为 `#63c7fa / 0.34`，未选中 Surface 为 `#548097 / 0.16`，Draw 模式全部按未选中透明度显示；选中/未选中参考网格分别为 `#b9ebff / 0.84` 和 `#7aa0ae / 0.42`。辅助面和网格读取深度但不写入深度。Plane 范围随 Outline/Fill 内容动态扩展，Cuboid 与 Frustum 使用六面世界单位网格，Sphere 使用每面 `4×4` 的球化六面体网格，Cylinder 依据三角化圆柱表面显示网格。这些对象只承担编辑显示与表面拾取，不进入作者数据或导出结果，并在离开 Ink 编辑模式时立即清除。

界面至少包含：顶部文档栏、可收起 Group Outliner、可收起 Shape/属性面板、主视口、底部 Ink 工具栏、地形工具抽屉、Undo/Redo 和导出入口。Undo/Redo 必须是带文字、始终直接可见且能清楚表达禁用状态的触控按钮，不能只显示难以辨认的小图标。触控目标必须适合 iPad，不能把桌面 Inspector 的窄行控件简单缩放后复用。

Apple Pencil 输入使用 Pointer Events。实现必须优先采集可用的合并事件；`pointerrawupdate` 仅作为浏览器支持时的增强，不能假设 iPad Safari 一定提供它。压感开启时，只有带有效非零压力的 raw 样本才能替代合并事件；零压力 raw 样本必须继续回退到合并事件，避免 iPad Safari 丢失真实 Pencil 压力。无压力、非 Pencil 或压感关闭时写入稳定的 `1`。手势被取消、失焦或失去 Pointer Capture 时必须丢弃未提交的临时操作并清理输入状态。

## 9. 性能、资源与可靠性要求

- 指针拖动期间仅维护临时 Ribbon 或 Fill 工作副本；松手后才形成一次作者源写入和一条 Undo/Redo 记录。
- Ink 编译在常驻 Worker 中完成；页面首次打开或 Group 增删 Shape 时才初始化该 Group 的作者源与轻量 Shape hash。一次笔画提交只跨线程发送受影响的作者 Shape，并只回传该 Shape 的派生缓存；未变化 Shape 的 Ribbon/Fill 数组必须留在主文档并复用。
- Shape Position/Rotation 使用已有 Mesh Transform 更新；Cuboid size、Sphere radius、Cylinder radius/height 与 Frustum top size/bottom size/height 都是固有尺寸，保存在作者 Shape 数据中，不作为通用 Transform Scale。渲染时仅在 Shape 的内部内容坐标层应用尺寸，Normal Outset 壳以包含真实尺寸和 `distance` 的预外扩 Geometry 独立构建，`distance` 始终保持世界单位；不得由共享顶点的平滑 normal 或 shader 位移推导。尺寸或距离变化只替换当前 Shape 的壳 Geometry、重采样必要的有限 Fill 图表并刷新辅助面和硬阴影，不重建整个场景。
- 只要输入不变，普通相机导航、UI 变化和灯光颜色/强度变化不得触发全场景重编译或硬阴影深度重建。
- Ink 硬阴影捕获必须隔离 Line、Points、Sprite 和全部编辑辅助对象；纯 Outline 与 Normal Outset 编辑不得使硬阴影深度图失效。
- Terrain 修改只重建必要的 Reference 几何与阴影深度；不得以整份文档克隆、全场景序列化或 GPU 资源重建作为普通交互的便利回退。
- 每个 Three.js Geometry、Material、Texture、RenderTarget、Worker、事件监听、计时器和 PWA 页面 mount 都必须有单一所有者和明确 dispose 路径。
- IndexedDB 写入必须节流并避免在 Pencil `pointermove` 中阻塞渲染；它与导出均使用一致的作者源快照，不读取半提交的交互状态或复制派生 GPU 上传数组。
- 原始导入文件的当前上限为 `512 MiB`，并保留笔画点数、Shape 数量和 Fill 块数量等独立、可诊断的资源上限。`File`/`Blob` 必须直接交给导入 Worker 读取和解析，避免大文件文本先在 PWA 主线程复制；超过可用设备内存时导入必须明确失败，绝不写入半份草稿。

## 10. 验收标准

### 10.1 离线与持久化

- 在预缓存完成后，断网/飞行模式下可以从主屏幕进入 Studio 并打开最近草稿。
- 新建、编辑、关闭、重新打开后，工作场景作者内容完整恢复。
- 用户可导出文件，并能重新导入同一文件得到相同的 Group、地形、灯光预览和布局。
- 应用明确告知本地草稿不是唯一备份。

### 10.2 地形与视觉

- Block、Slope、Corner Slope 的世界坐标、朝向和可见坡面与 Painting 兼容。
- Reference 路径能清楚显示格子、坡向和基础颜色。
- Ink 与地形遵循真实深度遮挡。
- Ink 硬阴影存在，且在不相关的灯光颜色/强度调整时不重建阴影深度图。
- 不启用 Map PBR、PCF 阴影、GTAO 或 PMREM。

### 10.3 Ink 与输入

- 多个 Group 可在同一工作场景中独立选择、摆放、编辑和撤销/重做。
- Plane、Cuboid、Sphere、Cylinder、Frustum 都支持现有的 Ink 描边与 Fill 规则；Cylinder 的侧面图表在环绕方向连续，Frustum 使用六个表面图表。
- Cuboid/Sphere/Cylinder/Frustum 的 Normal Outset 开关、颜色和距离可实时预览、Undo/Redo、保存、导出和重新导入；所有有限 Shape 的壳均保持朝外、逐面恒距且无 Sphere 图表接缝或缺面。
- 可见 Fill 使用 `DoubleSide` 并在背面翻转光照法线；专属 alpha-clip hard-shadow depth pass 固定 `BackSide`。
- 描边/擦除/填色/Fill 擦除/Bucket Fill/吸色/色板/笔宽/直线辅助均可在触摸 UI 下完成。
- Apple Pencil 压感开启时记录有效压力；关闭时新描边全部记录为 `1`；切换不会改写历史笔画。
- 失焦、取消和 Pointer Capture 丢失不会产生半条已保存笔画或卡住的工具状态。

### 10.4 兼容与导出

- 导出文件包含可验证的作者源和版本信息。
- 导出文件不依赖浏览器临时状态或 GPU 对象。
- 针对兼容版本，导出结果能被未来 Painting 导入器在不依赖图片转换的前提下恢复为可编辑数据。

## 11. 开发阶段

### 阶段 A：项目基础与领域契约

- 创建独立 Vite + Vue + Three.js PWA 工程。
- 建立格式版本、工作场景、验证器、IndexedDB 草稿仓库和导出/导入文件壳。
- 移植并测试 TileCell、Ink 作者数据、哈希和基础编译逻辑的兼容契约。
- 建立 manifest、Service Worker、离线应用外壳；不部署地址。

### 阶段 B：工作场景、Reference 与简化地形

- 完成移动视口、格子辅助、Block/Slope/Corner Slope 编辑和相机导航。
- 完成 Map Reference、预览灯光和 Ink 专属硬阴影装配。
- 证明编辑期格子不污染导出作者内容。

### 阶段 C：完整 Ink 移动工具

- 完成 Group Outliner、Pivot/摆放、Shape 编辑和多 Group 选择。
- 完成所有描边、Fill、吸色、色板、直线、Undo/Redo 工具。
- 完成 Apple Pencil 压力采样、压感开关、合并事件和取消手势处理。

### 阶段 D：稳定性与导出验证

- 完成文件级 schema 验证、资源上限、错误提示和损坏文件恢复路径。
- 在实际 iPad Safari / 主屏幕 Web App 上进行 Pencil、离线、内存和长时间创作验证。
- 完成构建、类型检查、格式兼容测试和离线缓存回归。

### 阶段 E：未来、另行确认的 Painting 集成

- 在 Painting 仓库中单独设计并确认移动工作场景导入器。
- 重新编译或验证 Ink 派生数据，并接入该项目的手动 Save 原子事务。
- 绝不在 Studio 端直接写入 Painting 项目目录。

## 12. 当前决策记录

| 决策 | 结论 |
| --- | --- |
| 项目位置 | `E:\MyDemo\InkAssetStudio`，独立于 Painting。 |
| 主要设备 | iPad + Apple Pencil。 |
| 应用形式 | 离线优先的静态 PWA。 |
| 多 Group | 必须支持，使用实际世界格子坐标摆放。 |
| 地形 | 仅 Block、Slope、Corner Slope 与基础格子编辑。 |
| 渲染 | Map Reference + 编辑网格 + Ink + Ink 硬阴影。 |
| 常规阴影 / PBR | 不在移动端启用。 |
| 灯光 | 完整参数可调；初值和 Reset 使用 Painting 当前保存值，不自动影响 Painting 全局灯光。 |
| 压感 | 默认开启，可随时关闭；只影响新描边采样。 |
| Normal Outset | Cuboid/Sphere/Cylinder/Frustum Shape 配置；实时预览，不进入 Ink 硬阴影。 |
| 图片导入 | 不做。 |
| 网络 | 当前不实现；离线能力先完成。 |
| Painting 修改 | 当前不做；未来导入器另行确认。 |

## 13. iPad Pencil 交互与增量编辑升级

本节取代此前“显式 Navigate 模式”和“按层放置 Terrain”的交互描述。

- 视口导航不再是独立模式。它在 Terrain、Group、Shape 与 Draw 模式中，在没有 Apple Pencil 悬浮或绘制时只接收手指触摸；Apple Pencil、鼠标均不得驱动镜头。检测到 Apple Pencil 悬浮或绘制后，必须拒绝支撑手的全部镜头旋转，直至 Pencil 离开视口。
- Terrain、Ink、Group/Shape 选择与全部 Transform/尺寸手柄只接收 Apple Pencil。手指不得修改作者内容，鼠标不得作为移动端编辑输入的替代品。
- Terrain 优先射线命中已有地块并按命中面放置相邻格，从而可以向上或向侧面搭建；空白处使用 X/Y/Z 三个零坐标工作面。一次 Brush 或 Rectangle 手势锁定工作轴和工作面。
- Terrain 保留 Brush 与 Rectangle、Block/Slope/Corner Slope、Place/Erase 和四向旋转。Tile 类型与四向旋转都使用直接按钮；点选类型或方向后在主画面显示一秒半透明形状预览，实际绘制期间持续显示半透明落点或范围预览。
- Terrain 放置预览沿用 Painting 的固定浅蓝色 `#74c7f7 / 0.42`；工具选择后的单块预览固定在世界坐标原点、关闭深度测试并置于最上层，不随相机移动。
- Terrain 颜色只能从固定的 PICO-8 16 色集合中选择。它没有可编辑色板、任意颜色输入或取色器；只有 Ink 支持任意颜色和可编辑色板。
- Group 与 Shape 的删除按钮位于左侧列表各自对应项右侧，并只删除该项。删除仍需确认，并作为一条 Undo 事务提交。
- 新建 Plane 的方向可直接选择 X、Y、Z 或 Camera，与 Painting 当前 Ink Plane 语义一致。
- Plane 在同一 Pencil 笔画中允许越出当前有限辅助面：离开有限面后继续与该 Shape 的无限作者平面求交，直到命中其它 Shape 或手势结束。
- 一笔经过同一 Group 的多个 Shape 时，每个 Shape 的段和实时预览都保留；Fill/擦除也分别维护每个 Shape 的临时作者状态。
- Fill 拖动只处理新增采样、只编译和上传变化 Shape 的 Fill；Terrain 只重建受影响分块；Transform 拖动只更新已有对象节点。普通 Pointer Move 不得构造完整临时文档或调用全局场景更新。
- Group 模式提供位置和兼容数据格式的 Y 旋转手柄；Shape 模式将 Move、Rotate 与内在尺寸分为互斥的手柄模式。Cuboid 的 Size 模式只显示三轴 Size Handle，Sphere 显示 Radius Handle，Cylinder 显示 Radius/Height Handle，Frustum 显示 Top/Height/Bottom Handle；它们绝不作为通用 Transform Scale，也不与移动或旋转手柄混显。Move/Rotate 手柄均可在 World 与 Local 空间切换。全部手柄只接收 Apple Pencil。
- Editor Session 持久化 Snap 开关、Translation Unit、Transform World/Local 空间和临时排除绘制的 Shape ID；默认单位为 `0.5`、默认空间为 World。启用后位置手柄持续吸附，不依赖 iPad 不便使用的 Ctrl 修饰键。临时排除只阻止新的绘制、吸色与 Shape 拾取，已提交的 Ink 仍可见且不影响作品内容。
