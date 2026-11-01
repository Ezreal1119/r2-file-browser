# 协作开发与跨电脑部署

仓库：<https://github.com/Ezreal1119/r2-file-browser>

这是一个 **本地 Wrangler CLI 直接部署**的项目。Git/GitHub 保存代码、协作和审核；
**push 不会自动部署生产环境**。生产数据和密钥留在 Cloudflare，不在 Git 里。

## 1. 新电脑开始开发

安装 Git 和 Node.js 22 或更新版本（使用 nvm 的话可以运行 `nvm install && nvm use`）。

```sh
git clone https://github.com/Ezreal1119/r2-file-browser.git
cd r2-file-browser
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run dev
```

打开终端输出的本地地址，通常是 `http://localhost:8788`。
`.dev.vars` 只用于本地，可自己设置本地 Admin/Uploader 密码；它已被 Git 忽略。
默认模板里的值不是线上密码。不要覆盖已经填写好的 `.dev.vars`。

本地 R2、D1 是独立的本地存储，初始为空；**不会自动复制线上文件、Labels、AI 配置或日志**。
两个本地 bucket 和 D1 的绑定已包含在 `wrangler.toml` 中，`npm run dev` 自动读取。
使用上传流程需要模板中的
`AI_SESSION_SECRET`，本地 AI 搜索还需要自己提供 API key 等配置。
`npm test` 使用伪造环境和数据，不依赖线上密钥，不会修改生产数据。

## 2. 日常协作

```sh
git switch main
git pull --ff-only
git switch -c codex/my-change
# 修改代码
npm test
git add <本次修改的文件>
git commit -m "Describe the change"
git push -u origin codex/my-change
```

在 GitHub 提交 Pull Request，审核后合并到 `main`。如果没有 GitHub 写权限，
仓库所有者需要邀请你的 GitHub 账号为协作者；换电脑也要配置自己的 GitHub HTTPS
凭据或 SSH key。不要复制别人的访问 token。

## 3. 从任何有权限的电脑部署

GitHub 权限和 Cloudflare 权限是两回事。需要登录**当前生产项目所属的 Cloudflare
账户**，或使用由管理员配置、具有必要部署权限的 Cloudflare API token。
不要在另一个账户里创建同名空项目来代替原生产项目。

```sh
git switch main
git pull --ff-only
npm ci
npm test
npx wrangler login
npx wrangler whoami
```

确认 `whoami` 显示的是有当前生产资源权限的账户。随后按变更范围部署：

```sh
# 只有新的 D1 migration 时才需要；会操作生产数据库
npm run db:migrate:remote

# 网站、API、MCP、上传等 Pages Functions
npm run deploy:pages

# 只有 sync-worker/ 变化时才需要；会同时更新原有 Cron/Queue 配置
npm run deploy:sync
```

生产网站：<https://tool-files.patrick-shenzhen.org>

`deploy:pages` 的生产分支名是 Cloudflare 项目已有的 `production`，与 Git 的 `main`
不是一回事。不要为了统一命名而改动它。只部署想要发布且已经测试的代码；避免多人
同时发布生产环境。普通部署不需要重新建 bucket、Queue 或 D1，也不需要重复输入密钥。

## 4. 哪些配置放在哪里

| 内容 | 保存位置 | 换电脑需要做什么 |
| --- | --- | --- |
| 源码、测试、migration、资源绑定名和 D1 ID | Git | clone / pull |
| `node_modules`、本地 R2/D1 状态 | 本机，Git 忽略 | `npm ci`，重新初始化本地状态 |
| 本地开发密码和 key | `.dev.vars`，Git 忽略 | 从模板配置自己的值 |
| Admin/Uploader 密码、AI key、Turnstile、签名 secret、同步 token | Cloudflare Pages Secrets | 部署同一项目时自动沿用，不要提交到 Git |
| Urovo 登录凭据、同步 token、可选 GitHub token | Sync Worker Secrets | 部署同一个 Worker 时自动沿用 |
| 实际文件、Description、Labels、AI 配置 | Cloudflare R2 | 不随 Git 迁移；继续使用现有绑定 |
| AI 配额、访问日志 | Cloudflare D1 | 不随 Git 迁移；需要时执行新 migration |

`wrangler.toml` 和 `sync-worker/wrangler.toml` 中的资源名称、D1 ID 不是密码，可以
提交。生产密钥只在 Cloudflare 设置，不能从仓库恢复明文，也不应在聊天/提交记录里共享。

修改生产密码的示例（命令会提示输入值，不要把值直接写进命令）：

```sh
npx wrangler pages secret put ADMIN_PASSWORD --project-name=r2-file-browser
npx wrangler pages secret put UPLOADER_PASSWORD --project-name=r2-file-browser
npm run deploy:pages
```

其他既有 Secret 和首次资源创建步骤见 [README.md](./README.md)。
本次整理已把原来的两个登录密码迁移到 Cloudflare Secrets，值保持不变。

可选线上上传测试会创建并清理自己的临时文件，需要在本机进程环境提供
`ADMIN_PASSWORD`、`UPLOADER_PASSWORD` 后执行 `node scripts/smoke-uploader.mjs`。
不要用真实生产密钥运行不可信分支，也不要在 CI 中向来自 fork 的 PR 提供密钥。
