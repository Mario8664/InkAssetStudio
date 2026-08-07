# Ink Asset Studio 实现与验收记录

更新日期：2026-08-07

## 1. 当前结论

`InkAssetStudio_Plan.md` 中阶段 A 至 D 的可在 Windows 开发环境内实现部分，以及经确认追加的 Source/非 TAA Watercolor 预览已经完成。Studio 是独立的 Vue 3 + Three.js + TypeScript 静态 PWA，全部源码、构建配置、测试、PWA 文件和工作数据格式均位于 `E:\MyDemo\InkAssetStudio`。

Painting 的水彩分支已快进合入并推送到 Painting `main`；Painting 保留该分支原有的完整实现（包括 TAA）。Studio 只移植非 TAA 水彩表现，不从 Painting 源目录做运行时导入、不新增 GameFramework 依赖，也不会在运行时写入 Painting 的场景、资产、文档或构建配置。

## 2. 已完成功能

### 2.1 PWA 与离线外壳

- Vite 生产构建、Web App Manifest、iPad standalone 元数据和 Service Worker 已建立。
- 构建时自动枚举生产文件并生成预缓存清单；缓存版本同时哈希文件路径和实际内容，固定文件名的 HTML、manifest 或图标变化也会触发更新。
- Service Worker 对带 `Vary` 的静态资源使用可靠缓存匹配，只对页面导航回退 `index.html`，不会把 HTML 错误返回给 JS/CSS 请求。
- Service Worker 只清理 `ink-asset-studio-` 前缀的旧缓存，不会影响同一 `github.io` Origin 下的其他项目。
- 浏览器自动验收已确认：应用首次加载后切断网络并刷新，仍可打开完整工作场景。
- GitHub Actions Pages 工作流已建立，正式 HTTPS 地址为 `https://mario8664.github.io/InkAssetStudio/`，无需常驻服务器。

### 2.2 工作场景、持久化与文件交换

- 工作文件格式：`ink-asset-studio-work`，`formatVersion: 1`。
- Painting Ink 作者数据兼容版本：资产 schema 1、编译格式 1；仅接受完整的 v1 source-only 工作文件和 IndexedDB 快照。所有旧格式、遗留字段及派生缓存负载均会被拒绝；当前作者源会重新编译派生数据。
- Terrain schema：1。
- 一个工作场景可内嵌多个独立 Ink 源和多个摆放引用。
- IndexedDB 保存当前场景的作者源快照和独立 Editor Session；作者内容修改使用 600 ms 节流自动保存，工具状态使用独立低频保存。Ribbon/Fill 派生缓存不进入该保存事务，恢复时在 Worker 中重建。
- Source/Watercolor 选择和全部非 TAA 水彩参数只进入 Editor Session；它们不进入工作文件、导出、Undo/Redo 或内容 dirty。新建、旧 Session 迁移和 Reset 均使用 Painting 当前 Ink Global Setting 存档的非 TAA 值。
- 顶栏显示保存中、本地已保存、最近保存时间和未导出提醒，并明确提示本地草稿不等于备份。
- `.inkstudio-work.json` 支持随时导出和重新导入；导出只包含可编辑作者源、摆放、地形、灯光和兼容版本，不携带可重建的 Ribbon/Fill/footprint 缓存。
- 导入前校验 `512 MiB` 文件上限、格式版本、ID 唯一性、引用完整性、数值、颜色、地形、Shape、笔画点和稀疏 Fill 资源上限；`File` 直接交给 Worker 读取、解析和编译，不在 PWA 主线程先复制完整文本。
- 导入和本地草稿恢复在一次性 Worker 中完成校验与 Ink 重编译，结束后立即终止 Worker。
- 导入和 IndexedDB 恢复不信任文件中的派生缓存，即使持久化哈希仍然匹配也会从作者源重编译；作者源始终是权威。
- Undo/Redo 使用结构共享快照；一次绘制、一次地形拖动或一次 Group/Shape 拖动只产生一条历史记录。连续灯光滑杆/颜色输入会合并为一条历史记录。顶栏使用带文字的 `Undo` / `Redo` 触控按钮，并在 iPad 横竖屏保持直接可见。

### 2.3 Ink 作者工具

- 多 Group Outliner、Group 新建/删除/改名、连续 X/Y/Z 摆放、0/90/180/270° Y 轴摆放旋转。
- Group Pivot 视口选择和 XZ 拖动摆放。
- 每个 Group 支持任意多个 Plane、Cuboid、Sphere、Cylinder、Frustum。
- Shape 支持选择、删除、位置、XYZ 旋转、Cuboid 固有尺寸、Sphere 固有半径、Cylinder 半径/高度与 Frustum 上表面 size/下表面 size/高度；不提供通用 Transform Scale。Move、Rotate 与内在尺寸是互斥视口手柄模式，尺寸手柄不会与移动或旋转手柄混显。Move/Rotate 支持持久化的 World/Local 坐标空间切换，默认 World。有限 Shape 尺寸变更只重采样当前 Shape 的 Fill 图表。
- 只有 Sphere 与 Cylinder 支持 `surfaceOutline`：启用与世界单位宽度可实时调整、Undo/Redo、保存和交换，默认宽度与默认 Outline 宽度同为 `0.035`。它是 Ink 显示 pass 中常驻的相机相关 Ribbon，不进入 Worker 编译载荷或硬阴影。Sphere 用相机切线圆生成闭合 Ribbon；Cylinder 只生成侧面两条切线母线，顶面和底面不描边。Ribbon 复用普通描边的宽度、颜色和深度路径，并按对应 Fill 图表的 `alpha < 0.5` 裁切；透明区域或图表外不显示。Plane、Cuboid 与 Frustum 不拥有该设置；关闭时立即释放 Ribbon 资源。
- Shape 列表在删除按钮左侧提供眼睛按钮。它将该 Shape 临时排除出新绘制、吸色与 Shape 拾取，仍显示既有 Ink；排除 ID 仅进入 Editor Session，不进入作者源、导出、Undo/Redo 或内容 dirty。
- Shape 视口拖动支持 XZ 移动和 Y 轴旋转，手势结束后才提交一次作者事务。
- Shape 编辑辅助已与 Painting 当前视觉一致：选中 Surface 使用 `#63c7fa / 0.34`，未选中及 Draw 模式 Surface 使用 `#548097 / 0.16`；相应参考网格使用 `#b9ebff / 0.84` 与 `#7aa0ae / 0.42`。辅助面读取深度但不写入深度，不再使用黄色 wireframe。
- Plane 辅助面按 Outline 与稀疏 Fill 内容动态扩展并保留最小 `1×1` 范围；Cuboid/Frustum 显示六面世界单位网格，Sphere 显示每面 `4×4` 的球化六面体网格，Cylinder 依据三角化圆柱表面显示网格。辅助面及其网格仅属于编辑器视口，不进入作者源或导出文件。
- Outline、Outline Eraser、Fill Paint、Fill Eraser、Blur、Water、Water Eraser、Bucket Fill、Fill Picker 全部以居中的 Emoji 触控按钮选择，并保留说明提示与无障碍名称。参数使用独立可换行区域；Blur/Water/Water Eraser 不显示颜色或色板控件。
- Outline 保留带压力的可编辑表面点，并编译为世界宽度 Ribbon。
- Fill 保留每个表面图表上的稀疏 16×16 RGBA 块，不保存可重放的 Fill 笔迹。`alpha < 128` 为透明；`255` 为干燥不透明；`128..254` 保存 Watercolor 湿度并仍按不透明 Fill 处理。Water/Water Eraser 只对已有覆盖调整 alpha，保持 RGB 不变；同一手势去重、不同手势叠加。
- Water/Water Eraser 的盖章热路径按 Surface/稀疏块建立索引，并以数值坐标保存手势去重状态；实时预览只收集本帧变化的连续 alpha 行段并局部上传既有 `DataTexture`，不再逐帧完整编译 Fill、扫描整张纹理、重建 Shape Helper 或刷新硬阴影。
- Fill Blur 使用 transient 增量工作批次；每帧固定预算处理目标 texel，复用稳定的预批次 Fill 源、预计算模糊核和手势级 surface/block 索引。新到 Pencil 盖印优先、从笔刷中心向外处理；同一 texel 保留时间上最后一个盖印，避免后台旧任务覆盖当前笔尖。Pencil 抬起后继续在后续帧完成剩余工作，再写入一条作者源/Undo 事务；实时预览只上传本帧变更的连续 RGBA 行段，不再逐帧完整编译 Fill、重建 Shape Helper 或刷新 Ink 硬阴影深度。
- Plane、Cuboid、Sphere、Cylinder、Frustum 均使用 Painting 当前的表面坐标和编译规则；Cylinder side chart 在环绕方向连续，Cylinder cap 与 Frustum 的六个面都保有独立 Fill 图表。
- 支持圆形/方形 Fill 笔刷、笔刷尺寸、Outline 宽度和可见笔刷光标。Water 与 Water Eraser 额外提供 Session 持久化的 Soft Radius 与 Water Opacity；光标以恒定屏幕细线的实线核心加精确对应 Feather 外半径的虚线外框显示，增大半径不会加粗核心轮廓。
- 支持直线辅助；其端点状态保存在作者数据中，不进入编译几何哈希。
- 调色板可新增、删除、直接改色和触控排序，最多 32 色，并作为 Editor Session 独立保存。颜色工具将色板固定在左侧栏底部，色块显示缩放同样随 Session 保存；色块区域独立纵向滚动，不与底部工具或 Water 参数争抢空间。
- Apple Pencil 使用 Pointer Events、合并事件和可用时的 `pointerrawupdate`；压感开启时只有非零 raw 压力才取代合并事件，避免 iPad Safari 的零压力 raw 更新使压感失效。手势取消、失焦和 Pointer Capture 丢失都会丢弃未提交临时数据并清理状态。
- 自适应稳定器在采样阶段平滑表面点，不在提交后重解释作者轨迹。
- 压感默认开启且始终有可见开关。开启时 Fill Brush、Fill Eraser 与 Fill Blur 的每个盖印半径及可见光标按采样压力的 `0.05～1` 范围缩放，Fill Blur 的混色采样半径使用同一比例；Water 与 Water Eraser 的每个盖印按同一比例缩放 `fillWaterOpacity`，但笔刷尺寸和羽化半径不变。关闭时新 Outline 点写入 `pressure: 1`，这些工具使用完整配置值；旧笔画不会被回写。
- 正式落笔后的 Ink 编译在常驻编译 Worker 中完成。Worker 在初始载入或 Shape 集合改变时保存 Group 作者源和轻量 Shape hash；每次提交只接收受影响 Shape、只回传该 Shape 的派生缓存，未变 Shape 的 Ribbon/Fill 留在主文档复用。Worker 结果作为派生缓存协调回主文档，不增加历史或内容 revision。
- 已提交的 Outline 预览会保留至对应 Shape 的 Worker 派生缓存回写并挂载后再释放，避免松笔时出现可见空档；取消手势和切换工作场景会立即清理该预览。

### 2.4 简化地形与编辑参照

- 支持 Painting 兼容的 Block、45° Slope 和 Corner Slope。
- 地形格保存整数 `x/y/z`、0/90/180/270° 旋转和 PICO-8 基础颜色。
- 支持已有地块射线相邻放置、X/Y/Z 零坐标工作面、Brush/Rectangle 连续放置与擦除，以及按钮式类型/四向旋转和固定 PICO-8 颜色切换。
- 地形 Reference 几何携带 barycentric 与真实边界掩码，边缘暗化不会显示内部三角形对角线；描边使用与地块协调的深色并设有非纯黑下限。
- 参考地形、无限网格与 X/Y/Z 坐标轴是 Studio 所有的编辑器视口显示项，可分别开关；地块边缘也有独立开关。参考地形默认显示，关闭时停止 Map Reference 的捕获与合成，但不删除地形数据、不影响地形拾取或放置预览。四个设置仅进入 Editor Session，不进入工作场景、Ink 作者源或导出文件。
- Terrain、Group、Shape 和 Draw 模式中手指始终只驱动 OrbitControls；Apple Pencil 只驱动编辑，鼠标不驱动编辑或镜头。相机轨道保留极点安全余量，但可越过水平面旋转到目标下方的负 Y 视角。

### 2.5 渲染与灯光

- Map Reference 在 Three.js 展开灯光 ShaderChunk 前注入有效 Half-Lambert，显示地形体积和基础颜色，背光坡面不再退化为接近纯黑。
- Ink Ribbon 和 Fill 使用自身真实深度遮挡；Reference 合成不写入该深度，不能遮挡 Ink。
- Ink Fill 保留当前硬分档光照和专属原生深度硬阴影：`DepthTexture` 保存 nearest-filtered 原始深度，同一 target 的 nearest 颜色附件保存最近 Shape owner ID。Source 执行 owner-aware 单中心比较；Watercolor 从同一原始深度的四个相邻 texel 重建 Marching Squares 连续边界。两条路径均不使用 PCF 或 bias；Reference 地形不进入 Ink 硬阴影投射或接收。
- Ink Fill 可见材质与专属硬阴影 depth/owner material 均固定使用 `DoubleSide`，片元在背面翻转光照法线；每个有 Fill Shape 取得 transient `1..255` owner ID，超过上限安全使用 `0` 回退而不做自身排除。Cuboid、Sphere、Cylinder 与 Frustum 的表面三角形绕序均保持法线朝外。
- Ink 阴影目标密度固定为 64 px/世界单位；普通 Three.js PCF 阴影保持关闭。
- 阴影深度只在 Ink 几何/Transform、摆放或光照方向变化时失效；Reference 地形、灯光颜色和强度不会触发阴影深度重建。
- Worker 回写的 Fill 以 `alpha >= 128` 的二值覆盖精确判断硬阴影失效；仅 RGB 或 Water 湿度变化会更新显示纹理，但不会重建覆盖未变的硬阴影深度。
- 纯 Outline 与 Surface Outline 编辑不再重绘硬阴影；原生 depth capture 会隔离 Shape 格线、无限网格、笔刷圈及其他非 Mesh 可渲染辅助对象，并在捕获后恢复全部状态。
- Ink Group 渲染按 Shape 复用已上传资源：Transform 只更新对象变换，Fill-only 更新复用 Ribbon，描边变化只替换对应 Shape，而不是重建整组 Ink。
- Appearance 面板可即时选择 Source 或 Watercolor。Watercolor 使用双颜色附件捕获分档光照颜色、局部 Water 湿度和 Group-local 稳定噪声：湿度只在 capture 阶段把 `shadedColor` 稀释向纸白，再交给同一套三层 depth-aware soft-tail/color-mix 扩散与当前帧 composite。全干 Fill 完整遵照旧版 Diffusion 的浓度、颜料强度与 `Interior Fade Color` 插值；有水时只叠加已经稀释的颜色，不以湿度门控或改写 Water Edge/Soft Tail 权重。Ribbon/Surface Outline 继续使用连续透明度蜡笔材质。
- 默认值严格来自 Painting 当前保存的 `ink-global-setting-default-instance.json`：Watercolor、Grain `96`、Minimum Alpha `0.3`、Noise `3`、Water Edge `true / 4 / 0.24 / 0.47 / 0.03`、Diffusion `true / 15 / 5 / 1 / 0.8 / #f9f5f1`。Studio 未移植 TAA、history、jitter、reprojection、disocclusion 或 temporal debug 字段。
- 阴影相机范围变化后显式更新投影矩阵。
- GPU 最大纹理不足时不修改作品数据，界面会显示所需尺寸、设备上限和恢复办法。
- 预览灯光的初值已与 Painting 当前实际保存的 Global Lighting 对齐：相位 `0`、太阳路径 `-12° / 15°`、全局地形反弹 `0.5`，以及完整 Day/Night Profile。所有参数均可编辑，并提供 Reset 恢复该基线；昼夜相位使用重点 `-1～1` 触控滑杆。
- 太阳/月亮 Profile 选择、地平线强度衰减、环境光/背景线性色彩插值均与 Painting 当前算法一致。Reference 先捕获到 Half Float 目标，再单独经 `OutputPass` 执行 sRGB、ACES Filmic 和 `1.05` 曝光；Ink 在该输出之后以原始作者 sRGB 值直接显示，不做 ACES 或 sRGB 解码/编码，并保留自身 Half-Lambert、环境光和 Ink-only 硬阴影。编辑器辅助最后作为 overlay 绘制；默认 Reference 背景输出像素与所给 Painting 参考图同为 `(227, 222, 215)`。
- 首版默认灯光未被自定义的旧草稿会迁移到 Painting 当前基线并保留原昼夜相位；存在任意其它自定义灯光值的草稿保持原样。
- Sky、Ground、Reflection、地形反弹强度和 Profile 反弹亮度均可编辑、保存和交换；当前 Map Reference 范围不启用 PMREM 或地形色反弹，因此这些字段不会虚构移动端预览效果。
- Map PBR、PCF 软阴影、GTAO、PMREM、环境反射及其它效果型后处理未启用；只保留 Map Reference 最终颜色管理必需的 `OutputPass` 和已确认的 Studio 非 TAA Watercolor，Ink 不经过 Reference 的 `OutputPass`。
- Three.js 几何、材质、纹理、Watercolor Fill capture material、MRT/seed/三层扩散 RenderTarget、监听器、ResizeObserver、Worker 和 UI 计时器均有明确 dispose/terminate/clear 路径。

## 3. 自动验收结果

生产构建命令：

```powershell
npm.cmd run build
```

当前结果：

- Vue/TypeScript 类型检查通过。
- 9 个 Vitest 文件、93 项测试通过，另有 1 组 Service Worker 内容版本/缓存归属/导航回退脚本测试通过。
- 测试覆盖 Shape Surface/参考网格颜色、透明度、深度语义、动态 Plane 范围和 Sphere/Cylinder/Frustum 网格，以及固定浅蓝 Terrain 放置材质、分块精确更新和射线三角形到 Tile 映射、X/Y/Z 工作面 Brush/Rectangle 路径、Half-Lambert ShaderChunk 注入、非纯黑描边下限、参考地形/地块边缘/无限网格/坐标轴四个显示开关及旧 Session 迁移、World/Local Transform Session、临时排除绘制 Shape、Painting Ink Appearance 精确默认值/迁移/深拷贝/范围归一化、Source/Watercolor 双材质与 Fill/Ribbon 分层、MRT capture、三层非时域扩散、原始硬阴影深度及 Source 单中心/Watercolor 连续边界、多个 Group、五种 Shape 的 Outline/Fill 编译、Fill Brush/Fill Eraser/Fill Blur 压感半径缩放与 Water/Water Eraser 压感强度缩放、连续大笔刷 Blur 的固定帧预算、局部 RGBA 上传与 GPU 资源复用、有限 Shape 尺寸重采样、球体与圆柱体相机相关的世界单位 Surface Outline、Fill alpha 裁切和资源释放、Shape GPU 资源复用、所有有限 Shape 的向外绕序、辅助对象隔离、异常后的完整状态恢复、场景背景隔离、v1-only 工作文件拒绝、source-only 派生缓存重建、Pencil/Touch 输入边界、raw/coalesced 采样回退、真实抬笔终点、压感延续、损坏 Session 恢复、Outline 路径擦除、Worker 派生缓存交接、Undo/Redo 和连续输入合并。
- Vite 生产构建和 Service Worker 生成通过。

真实 Chrome 自动验收命令：

```powershell
npm.cmd run visual-check
```

验收脚本实际执行以下行为：

1. 新建第二个 Group；
2. 切换压感关闭并真实拖动画 Outline；
3. 真实拖动画 Fill，并以较大笔刷连续拖动画 Blur，确认增量队列完成后页面仍可响应；
4. 重新开启压感；
5. 切换到 Shape 模式，新建 Cuboid、Cylinder 与 Frustum，验证对应尺寸手柄和 World/Local Transform 切换；确认 Cuboid/Frustum 不显示 Surface Outline，Cylinder 可启用并调整世界单位宽度，确认可见 Fill 与 hard-shadow capture 均为 `DoubleSide`，再切回 Draw 模式继续编辑；
6. 打开调色板编辑器并排序颜色；
7. 核对 Painting 当前完整灯光初值、全部参数输入和重点昼夜滑杆，修改预览灯光并执行 Undo/Redo/Reset；
8. 打开 Appearance，核对 Painting 存档的全部非 TAA 默认值，往返切换 Source/Watercolor、修改参数并 Reset，确认导出不包含 Editor Session 外观；
9. 核对独立 Navigate 模式已删除，鼠标拖动不会绘制 Ink；
10. 核对参考地形、地块边缘、无限网格和坐标轴四个开关默认开启，并逐个关闭、重新开启；
11. 进入 Terrain 模式，核对三个 Tile 按钮、四向按钮、X/Y/Z 工作面按钮并用 Pencil 拖动擦除地形；
12. 导出 JSON，检查 Group、描边点、压力、五类 Shape、Fill 块、Sphere/Cylinder 的 `surfaceOutline` v1 配置和地形结果；
13. 新建场景后重新导入刚导出的文件；
14. 等待 IndexedDB 保存完成；
15. 断网刷新并确认完整工作场景与 Editor Session 恢复；
16. 在 1366×900、1024×768 和 768×1024 三种视口检查布局、画布、Group、工具、四个视口显示开关和页面溢出；
17. 收集控制台和页面错误。

最近一次结果：2 个 Group、15 个可编辑 Outline 点、4 个稀疏 Fill 块、1 个已启用 Surface Outline、21 个剩余地形格；导出声明 Painting Ink compiled format v1，包含 `plane`、`cuboid`、`cylinder`、`frustum`。自动验收确认 Cuboid/Frustum 不显示曲面描边控件，Cylinder 的 Radius/Height 和 Surface Outline 宽度可用并可导出；Source/Watercolor 均可切换，Appearance 的 Painting 存档默认值、参数修改与 Reset 正确，且外观 Session 不进入导出。World/Local Transform 切换和删除键左侧的临时绘制排除眼睛按钮均可切换、还原并保持为 Session 状态。桌面、离线刷新、1024×768 与 768×1024 视口均无页面溢出；Undo/Redo、重点昼夜控件和四个视口显示开关在 iPad 横竖屏可见，按钮式 Terrain 工具、Pencil 绘制、鼠标输入隔离、模式切换、开关交互、断网恢复均成功，控制台和页面错误为 0。

视觉验收图位于：

- `studio-preview.png`
- `studio-shape-preview.png`
- `studio-lighting.png`
- `studio-appearance.png`
- `studio-ipad-landscape.png`
- `studio-ipad-portrait.png`

## 4. 仍需真实设备或后续授权的事项

以下事项不是当前 Windows 实现中的缺失功能，但无法在本阶段环境内完成最终结论：

- 使用真实 iPad Safari / 主屏幕 Web App 和 Apple Pencil 验证硬件压力曲线、Pencil 采样频率、长时间绘制温度与内存表现。
- 在真实 iPad Safari 上验证 GitHub Pages 的首次主屏幕安装和后续版本更新流程。
- 在不同 iPad GPU 上验证超大、分散工作场景的 64 px/世界单位硬阴影纹理上限提示。
- Painting 侧 `.inkstudio-work.json` 导入器仍需在 Painting 仓库中单独设计、确认和实现；当前 Studio 不写入 Painting。

上述真实设备验收不需要启动或保留任何 Studio 常驻服务。

## 5. 当前 iPad 绘画体验升级

- [x] 删除独立 Navigate 模式，完成 Touch-only 导航与 Pencil-only 编辑输入仲裁；Apple Pencil 悬浮或绘制期间锁定手指镜头，避免支撑手旋转视图。
- [x] Terrain 改为已有地形射线相邻放置、X/Y/Z 工作面、Brush/Rectangle 和批量半透明预览。
- [x] Terrain 改为固定 PICO-8 颜色、按钮式 Tile/四向旋转，并增加一秒工具形状预览。
- [x] 修复 Plane 同笔越界扩展、扩大后的局部坐标映射、多 Shape Outline/Fill 预览与提交。
- [x] 修复 Outline Worker 回写整体替换 Shape；现在只替换 Ribbon，保留 Fill GPU 资源和运行期硬阴影 owner。
- [x] 将 Fill、Terrain、Helper 与 Transform 热路径改为精确局部更新。
- [x] 将 Water/Water Eraser 实时预览改为稀疏块索引与连续 alpha 行段上传，并按二值覆盖精确限制硬阴影失效。
- [x] 增加 Group/Shape Transform Handle、Cuboid Size Handle、Sphere Radius Handle、Cylinder Radius/Height Handle、Frustum Top/Height/Bottom Handle、World/Local 空间与持久化 Snap 设置。
- [x] 将 Group/Shape 删除按钮移到左侧列表对应项，并增加 X/Y/Z/Camera Plane 创建按钮、Cylinder/Frustum 创建按钮和删除键左侧的 Shape 绘制排除眼睛按钮。
- [x] 将可缩放、纵向滚动的色板移到左侧栏底部，底栏改为居中 Emoji 工具和独立参数区；将参考地形显隐及 Source/Watercolor 切换常驻视口顶层，并修复画笔核心光标随半径变粗。
- [x] 补齐单元、交互、iPad 尺寸、离线与部署后远程验收，再提交推送 GitHub Pages。
