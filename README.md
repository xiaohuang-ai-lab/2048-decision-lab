# 2048 决策实验室

把同一张 2048 棋盘交给 Jev、大模型或本地搜索算法，观察它们如何选择下一步，以及得分、速度和 API 费用的差异。由「小黄有算力」的 Jev 实验项目独立整理而来。

本项目属于 [小黄实验室](https://github.com/users/hevbevt/projects/1)，这里汇总后续 AI 实验、独立仓库和面向读者的开源进度。

## 能做什么

- **手动游玩**：方向键、WASD、触屏滑动；支持随机种子复现。
- **大模型**：通过 OpenAI 兼容的 Chat Completions 接口选择方向，默认配置为 DeepSeek。
- **Jev**：通过 TypeSafe System One 接口返回方向、概率和置信度，展示原始响应。
- **代码 AI**：默认使用 nneonneo C++ Expectimax，另有 JavaScript 简化版，无模型 API 调用。
- **对局记录**：单步或连续运行，实时查看响应、耗时、Token、费用估算；本地保存 JSON / Markdown，也可手动导出。
- **对局统计**：按操作模式和策略查看最新对局，展示得分与最大方块随步数、时间、估算费用变化的曲线。

默认「2048 封顶」适用于全部模式。「无限挑战」支持手动和代码 AI，可持续运行至无路可走或手动暂停。原生算法遇到 32768 或更大的方块时自动切换到 JavaScript 搜索。

## 快速开始

需要 Node.js 22 或更新版本。项目使用 Node.js 内置模块和原生 HTML / CSS / JavaScript，**无需 npm install**。

```sh
git clone https://github.com/hevbevt/2048-decision-lab.git
cd 2048-decision-lab
npm start
```

打开 <http://127.0.0.1:2048>，即可手动游玩。统计页为 <http://127.0.0.1:2048/stats>。启动服务不会自动调用模型。

如果端口已占用：

```sh
PORT=2049 npm start
```

### 本地代码 AI

使用默认的 nneonneo 原生引擎前，先用本机已有的 C++11 编译器构建：

```sh
npm run build:native
```

默认编译器是 `clang++`；也可设置 `CXX=g++ npm run build:native`。构建会检查随仓库提供的上游源码哈希，不下载源码或安装编译器。没有编译器时，可以在页面中选择 JavaScript 简化版。

### 接入 Jev / 大模型

在页面右上角「接入设置」填写服务地址、模型名称和 API Key。配置保存到本机 `.local/config.json`，目录权限为 700、文件权限为 600，不放入浏览器存储或 Git。独立项目不会继承原实验目录里的密钥，需要重新配置。

也可以复制环境变量模板，填写后重启服务：

```sh
cp .env.example .env
npm start
```

模板中的模型名是本项目提取时的默认值，可以按账户实际可用模型修改。大模型使用 `/chat/completions`，Jev 使用 `/systemone`；模型调用由本地 Node.js 服务完成。`LLM_EXTRA_BODY` 可填写服务商支持的额外 JSON 参数。保存配置不会调用模型，点击模型模式的运行或单步才会发起请求，可能产生 API 费用。

如需 HTTP 代理，使用支持 `--use-env-proxy` 的 Node.js 版本，并按本机代理端口设置环境变量。例如仓库中的 `npm run start:proxy` 使用 `127.0.0.1:7890`，端口不同时请自行调整。

## 实验与统计

两类远程模型均可选择直接决策、策略指引、增强策略。增强策略包含程序提供的局面分析；比较模型时应保持玩法、策略、初始种子和停止条件一致。

费用使用代码中的固定价格快照和人民币参考汇率，不实时更新，缺失用量不会视为免费。修改模型或服务商后应核对对应价格。算法评分是搜索启发分数，Jev 返回的概率和置信度也不直接等于实际获胜率。

每局记录保存在 `logs/`，统计页读取本机记录。刷新或关闭前请确认页面显示「已保存到本地」。仓库不附带作者的模型实测日志、凭据或公众号素材。

## 开发与验证

```sh
# HTTP 接入链路：只使用本地模拟服务，不调用真实模型
node --test tests/server.test.mjs

# 原生引擎相关验证：先执行构建
npm run build:native
node --test tests/native-ai.test.mjs

# 其他测试按改动选取，例如游戏规则
node --test tests/game.test.mjs
```

`npm test` 可运行全部现有测试，需先构建原生引擎。日常修改优先运行相关测试文件。`benchmarks/` 保留可选本地对局脚本，运行会消耗 CPU 并生成被 Git 忽略的结果文件，不会调用付费 API。

## 文件结构

```text
public/          游戏页面、统计页面、游戏规则和前端逻辑
server.mjs       本地 HTTP 服务
providers.mjs    大模型 / Jev / 本地算法适配
strategy.mjs     提示词和局面分析
local-ai.mjs     JavaScript 搜索算法
native-ai.mjs    原生算法进程适配
native/          C++ 桥接与本机构建脚本
vendor/          固定版本上游源码与许可证
archive.mjs      对局归档
statistics.mjs   统计读取与归并
config-store.mjs 本机配置保存
tests/           自动化测试与模拟数据
benchmarks/      可选本地算法评测脚本
```

服务仅监听 `127.0.0.1`，用于个人本地实验；仓库不提供公网部署配置。

## 第三方代码

nneonneo 的 [2048-ai](https://github.com/nneonneo/2048-ai) 使用 MIT 许可证。固定提交为 `41e298f4571a9505e421e3a19af7a1cb372a368c`，来源与文件哈希见 [SOURCE.json](vendor/nneonneo-2048-ai/SOURCE.json)，许可证全文见 [LICENSE](vendor/nneonneo-2048-ai/LICENSE)。该许可证适用于对应上游代码；本仓库其他代码尚未另行指定开源许可证。
