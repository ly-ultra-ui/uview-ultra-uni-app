# uview-plus4-vue3

`uview-ultra` 在 **uni-app Vue3**（非 uni-app x）模式下的独立示例站与编译门禁工程。

## 为什么需要它

`uview-plus4` 是 **uni-app x** 工程（`manifest.json` 里有 `uni-app-x` 段，`main.uts` 导入 `index.uts`），
它只编译 `uview-ultra` 的 `.uts` / `.uvue` 那一套实现。

而 `uview-ultra` 是**双实现**：`components/up-*/` 下同时存在

| 实现 | 文件 | 编译链 |
| --- | --- | --- |
| uni-app x | `.uts` / `.uvue` | 由 `uview-plus4` 承载 |
| uni-app Vue3 | `.js` / `.vue` | **本工程承载** |

所以 Vue3 那一套（153 个 `.vue` + `libs/**/*.js` + `index.js`）在 `uview-plus4` 里**从来不参与编译**，
任何语法错误、缺失导出、未声明变量都不会被发现——这正是用户反馈的那批 bug 的成因。

本工程把这条链路补上：一个真实的 uni-app Vue3 工程，带 126 个示例页，并提供可重复执行的编译门禁与运行时冒烟。

## 目录

```
uview-plus4-vue3/
├── index.html
├── package.json
├── vite.config.js
├── scripts/
│   ├── setup-links.mjs              # 建立指向 uview-plus4 的目录联接
│   ├── sync-demo-pages.mjs          # 把 uview-plus4 的 .uvue 示例页同步成 .vue
│   ├── fix-vue-import-extensions.mjs# 补全被 .uts 孪生抢掉的导入扩展名
│   ├── check-import-exports.mjs     # 导入的名字对方到底有没有导出
│   ├── verify-vue-build.mjs         # 编译门禁
│   ├── verify-demo-pages.mjs        # 逐页运行时冒烟（Playwright）
│   └── node-esm-resolve-hook.mjs    # 让 Node 也能解析省略扩展名的导入
└── src/
    ├── App.vue / main.js / uni.scss
    ├── manifest.json                # 无 uni-app-x 段，vueVersion = 3
    ├── pages.json                   # 由 sync-demo-pages 生成
    ├── pages/                       # 首页 + 126 个示例页（生成物）
    ├── uni_modules/uview-ultra      # 目录联接 → ../uview-plus4/uni_modules/uview-ultra
    ├── static                       # 目录联接 → ../uview-plus4/static
    └── common                       # 目录联接 → ../uview-plus4/common
```

## 接入方式：全部走目录联接，不复制源码

三个 junction 由 `pnpm setup:links` 建立（都写进了 `.gitignore`），改 `uview-plus4` 里的组件源码或静态资源，本工程即时可见：

| 联接 | 指向 | 用途 |
| --- | --- | --- |
| `src/uni_modules/uview-ultra` | `../uview-plus4/uni_modules/uview-ultra` | 组件源码 |
| `src/static` | `../uview-plus4/static` | 示例页引用的图片等静态资源 |
| `src/common` | `../uview-plus4/common` | `province.js` / `city.js` 等示例数据 + `demo.scss` |

## 示例页怎么来的

`uview-plus4/pages` 下是 122 个 `.uvue` 示例页（uni-app x），本工程要的是 `.vue`。
手抄一定漂移，所以用 `scripts/sync-demo-pages.mjs` 做**确定性转换**：

1. `<script setup lang="uts">` → `<script setup lang="ts">`（UTS 基本是 TS 超集，类型交给 esbuild 擦除）
2. 去掉 uvue 专有的 `styleIsolation` / `virtualHost`；对象变空时整段去掉 `defineOptions`
3. 摘掉模板里的 TS 断言（`item['x'] as UTSJSONObject` 在 JS 模板表达式里是语法错误）
4. 按实际用到的钩子补 `import { onLoad, ... } from '@dcloudio/uni-app'`
5. 把显式写死的 `.uts` 导入改写成 `.js`；没有 `.js` 孪生的（如 `types/index.uts`）改成 `import type`
6. 同名时 **`.vue` 优先于 `.uvue`**（那 19 个 `.vue` 本来就是给 uni-app 链路写的）
7. `.config.uts`（示例首页的导航数据）转成 `.config.ts`
8. 顺带生成 `src/pages.json` 与 `src/pages/index/demo-manifest.js`

```bash
pnpm sync:demo          # 生成 / 覆盖
pnpm verify:demo-sync   # 只检查是否与源仓库一致（门禁的 A 段也会跑）
```

## 用法

```bash
pnpm install
pnpm setup:links       # 建目录联接（换机器 / 目录被清掉时才需要）
pnpm sync:demo         # 同步示例页（首次和 uview-plus4/pages 变更后）

pnpm dev:h5            # 浏览器里逐个点开示例页（默认 http://localhost:5200）
pnpm dev:mp-weixin     # 微信小程序开发者工具

pnpm verify:vue-build    # 编译门禁（全量扫描 + H5 构建）
pnpm verify:vue-modules  # 只跑静态扫描，不跑构建，约 3 秒
pnpm verify:demo-pages   # 逐页运行时冒烟（需先起 dev:h5）
```

## 编译门禁 `scripts/verify-vue-build.mjs`

分六段，全部通过才算绿：

| 段 | 做什么 | 能抓到什么 |
| --- | --- | --- |
| A | 比对 `src/pages` 与 `uview-plus4/pages` | 示例页漂移 |
| B | 扫导入解析 | 省略扩展名却存在 `.uts` 孪生；导入的名字对方没导出 |
| C | 用 `@vue/compiler-sfc` 编译 280 个 `.vue`（153 库组件 + 127 页面） | SFC 解析 / `<script setup>` / 模板编译错误 |
| D | 用 `@babel/traverse` 对 260 个 `.js` 做 no-undef | `crtProp`、`UpNoNetwork` 这类未声明标识符 |
| E | 用 Node 逐个 `import` 237 个 `.js` 模块 | 引用了不存在的导出、模块加载期报错 |
| F | 跑一次真实的 `uni build`（H5） | 整条链路、`import.meta.glob`、条件编译、静态资源 |

> F 段若报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，是沙箱的批量删除保护拦住了 uni build
> 清空 `dist/build/h5/assets`，不是代码问题——先 `rm -rf dist` 再跑。

### 为什么 B 段是必需的：`.uts` 会抢 `.js`

uni-app 的 `resolve.extensions` 是

```
['.uts', '.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue', '.nvue', '.uvue']
```

——`.uts` 排在**最前面**，而且**非 uni-app x 构建也是这个顺序**
（见 `@dcloudio/uni-cli-shared/dist/constants.js` 的 `COMMON_EXTENSIONS`）。

于是凡是「同名 `.js` 与 `.uts` 并存、导入又省略了扩展名」的地方，在 Vue3 工程里都会解析到 `.uts`，
被 esbuild 当 UTS 解析而失败；目录导入（`libs/i18n` 这种）会解析到 `index.uts`，
运行时直接 `UTSJSONObject is not defined`。

`pnpm fix:import-extensions` 会在这些**真正有歧义**的地方补 `.js`（其余导入一律不动）。

### 其他实现细节

- **先裁剪条件编译再解析。** 组件源码里大量使用 `#ifdef H5` / `#ifndef APP-PLUS`，而且
  标记既可能在行首，也可能在行中间（`} else /* #endif */ if (...)`）。
  不裁剪就会把同一个变量在不同分支里的重复声明误报成 `Identifier has already been declared`。
  裁剪用空行占位，所以报错行号仍然对应原始文件。
- **F 段的输出走文件描述符而不是管道。** 本机杀软会拦截管道创建，`spawnSync` 带 pipe 会直接 `EBUSY`。
  完整日志落在 `.verify-build.log`（已 gitignore）。
- **首页用 `import.meta.glob` 全量引入组件**，即使某个组件没有任何示例页，也不会躺在仓库里没人编译。
  注意 glob 必须用**相对路径**：目录联接下 `@/` 别名不展开。

## 逐页运行时冒烟 `scripts/verify-demo-pages.mjs`

```bash
pnpm dev:h5                       # 另开一个终端
pnpm verify:demo-pages            # 126 个页面逐个打开，收集报错
pnpm verify:demo-pages --only componentsA/button,componentsC/tabs
pnpm verify:demo-pages --no-screenshot
```

- 每个页面都用**全新文档**加载（uni-app 是 hash 路由，只改 hash 的跳转不会重载），
  收集 `console.error` / `pageerror` / 请求失败，页面正文过短会被判为「近乎空白」。
- 截图落在 `.demo-screenshots/`，报告落在 `.demo-report.json`。
- playwright 解析顺序：`PLAYWRIGHT_MODULE` 环境变量 → 本地依赖 → 托管 node 工作区。

## 注意

- 本工程只覆盖 **uni-app Vue3** 链路。uni-app x（Android / iOS / 鸿蒙）的验证仍然在 `uview-plus4` 里做，
  按 `uview-plus4/AGEMTS.md` 的 HBuilderX CLI 流程执行。
- `.uvue` 文件**不**参与本工程编译（Vue3 编译器不认识 uvue 语法），它们由 `uview-plus4` 负责。
- 示例页与 `src/pages.json` 都是**生成物**，不要手改；要改就改 `uview-plus4/pages` 再 `pnpm sync:demo`。
