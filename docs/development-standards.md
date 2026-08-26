# Pheno Lab 当前技术栈与开发规范

本文描述仓库**当前已经落地**的技术栈、模块边界和开发门禁，供人类开发者与 coding agent
共同遵守。它不是未来架构愿望清单；长期决策背景见
[`architecture-refactor.md`](architecture-refactor.md)，仓库级 agent 硬规则见
[`../AGENTS.md`](../AGENTS.md)。

最后核对：2026-08-26。

## 1. 当前系统边界

Pheno Lab 是可测试的模块化单体：

```text
Browser / mobile responsive routes / Go Bridge
                    │
                    ▼
     Next.js pages / Server Actions / Route Handlers
                    │
                    ▼
      domain modules + authorization + audit
                    │
                    ▼
    infrastructure adapters (PostgreSQL / COS / mail)
```

- Web、响应式移动采集页和 API Route 由同一个 Next.js 进程提供。
- Go Bridge 是当前唯一独立的非浏览器客户端，继续调用 `/api/ingest/*`。
- 系统是一个部署单元、一个 PostgreSQL 数据库，不存在独立 Hono/API 服务。
- COS 是生产文件事实来源；PostgreSQL 保存结构化数据与 object key，不保存附件二进制。
- 向量索引目前不参与应用运行；如未来启用，它只能是可重建的派生数据。

不要因为其他仓库使用 Pulse 架构，就在本项目复制 Web/API 分离。只有出现明确的第二业务客户端、
独立扩缩容、独立团队发布、性能隔离或稳定外部 API 等真实触发条件，才重新评估部署边界。

## 2. 技术栈基线

版本以 `pheno-lab/package.json`、`pnpm-lock.yaml`、`.node-version` 和 `pheno-bridge/go.mod` 为准。

| 层               | 当前技术                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| Runtime          | Node.js 24；pnpm 11.1.2                                                             |
| Web              | Next.js 16.3.1 App Router；React/React DOM 19.2.8                                   |
| Language         | TypeScript 5.9.x；Go 1.26.7（Bridge）                                               |
| UI               | Tailwind CSS 4；Lucide React；仓库内 Pheno design tokens/brand assets               |
| Database         | PostgreSQL 18；Prisma/Prisma Client 6.19.3                                          |
| Validation       | Zod 4.4.x                                                                           |
| Auth/security    | `jose` 签名 Session；`bcryptjs` 密码散列；httpOnly/Secure Cookie                    |
| Object storage   | 腾讯云 COS；`cos-nodejs-sdk-v5`；CVM instance role                                  |
| Mail             | Nodemailer 9；SMTP 可选                                                             |
| Unit/integration | Vitest 4.1.x；独立真实 PostgreSQL 测试库                                            |
| Browser E2E      | Playwright 1.62.x / Chromium                                                        |
| Quality          | ESLint 9；Prettier 3.9.x；自定义 structure/deploy/schema-drift checks               |
| Production       | Ubuntu CVM；Nginx；systemd；不可变 release 目录                                     |
| CI               | GitHub Actions；Node 24、PostgreSQL 18、Go tests、Vitest、Playwright、release build |

升级 Node、Next.js、React、Prisma、PostgreSQL 或 pnpm 属于显式升级任务，不能混入普通功能 PR。
Next.js 16 的 API 和约定可能不同于模型训练记忆；修改 Next 代码前必须阅读安装版本
`node_modules/next/dist/docs/` 中对应文档，并处理 deprecation notice。

## 3. 目录职责

### 3.1 Web 与传输层

- `pheno-lab/src/app/**`：App Router 页面、布局和 Route Handler。
- `pheno-lab/src/lib/actions/**`：Server Action 适配器。
- `pheno-lab/src/components/**`：React 展示与交互组件。
- `pheno-lab/src/proxy.ts`：请求入口相关代理/中间件逻辑。

传输层可以做：读取 session、解析输入、调用领域 service/query、映射 HTTP/Action 返回值、
revalidate。它不应复制权限、组织 scope、事务或领域状态转换。

### 3.2 领域层

- `pheno-lab/src/modules/**`：accounts、authorization、audit、experiments、runs、ingest、
  instruments、files、library、organizations、exports、workflow、system 等领域能力。
- 每个领域保持稳定的 service/query facade；文件变大时按业务能力拆分，不强制为每个模块创建
  空的 commands/queries 目录。
- schema/policy/type 可以保持纯函数；访问数据库、配置或存储的 service/query 必须
  `import "server-only"`。

领域模块不得依赖 `src/app`、`src/components`、`src/lib/actions` 或 Next.js transport API。

### 3.3 基础设施层

- `src/infrastructure/config/**`：Zod runtime config 和 fail-fast。
- `src/infrastructure/db/**`：Prisma client 与测试库保护。
- `src/infrastructure/storage/**`：Local/COS storage adapter、key 和 credential provider。
- `src/infrastructure/crypto/**`：凭据加密。
- `src/infrastructure/mail/**`：SMTP adapter。
- `src/infrastructure/logging/**`：结构化日志。

基础设施实现不应在 Client Component 中出现；业务调用 adapter/interface，不直接散落 SDK 调用。

### 3.4 数据模型与外部客户端

- `pheno-lab/prisma/schema.prisma`：当前完整结构化数据模型。
- `pheno-lab/prisma/migrations/**`：只追加的生产 migration 历史。
- `pheno-bridge/**`：仪器电脑上的 Go Bridge；不是 Pheno Lab Web 的第二个业务后端。

## 4. 实现规范

### 4.1 输入、错误与返回值

- 浏览器表单、Route body、query/path 参数、仪器 metadata、环境变量和外部响应都视为不可信输入。
- 在传输边界使用 Zod parse/safeParse；schema 放在相关领域中并为允许/拒绝输入写测试。
- 不向客户端返回堆栈、数据库错误、COS 凭据或内部路径。服务端日志使用结构化字段与 request ID。
- 对可重试 ingest 保持幂等；不要把暂时错误伪装成成功，也不要改变 Bridge 已依赖的状态码语义。

### 4.2 授权和多租户

- actor 从服务端 session/credential 建立，不接受客户端提交的 role 或 organization 作为事实。
- policy 回答“能否执行”，scope 限定“能看到哪些行”，resource check 验证具体对象归属。
- ADMIN、MANAGER、TECHNICIAN 的规则集中在 authorization/module service，不在 UI 和页面复制。
- 每个 Prisma 查询都必须能解释 organization scope；按 ID 查询后仍要检查组织和资源权限。
- 文件读取、导出、实验复制、ingest rematch 等间接数据路径同样受组织隔离保护。

权限变更至少需要：policy 单元测试、允许/拒绝矩阵、真实 PostgreSQL 跨组织集成测试。

### 4.3 事务和审计

- 一个业务动作涉及多张表时使用同一 Prisma transaction client。
- `AuditEvent` 与成功业务修改同事务提交；业务回滚时不能留下“成功”审计。
- 审计记录 actor、organization、action、target 和必要摘要；敏感字段使用 allowlist/脱敏，不保存
  credential、secret、OTP 或整份上传内容。
- 后台、仪器和系统任务使用明确的 actor 类型，不伪装成管理员用户。

### 4.4 PostgreSQL 与 migration

- 本地 schema 开发可以创建新的 Prisma migration；生产只执行 `prisma migrate deploy`。
- 永不修改已经提交或生产应用过的 migration SQL。
- 禁止生产 `prisma migrate dev`、`prisma db push`、`prisma migrate reset`、`prisma db seed`。
- 所有变更遵循 expand/contract，确保新 schema 可以短暂运行上一 release。
- 新的必填列先 nullable/default，完成回填和代码切换后再在后续 release 收紧。
- 大规模回填、去重、删除和历史数据迁移必须有只读盘点、dry run、审计、回滚/补偿和 Louis 批准。

### 4.5 文件与 COS

- 生产 `STORAGE_DRIVER=cos`、`COS_AUTH_MODE=instance-role`；长期密钥不进入应用 env。
- 上传、下载、head、delete 均通过 `src/infrastructure/storage` 的现有接口。
- object key 必须包含 organization scope，使用已有 key builder，不接受客户端任意 key。
- 数据库只保存 object key/metadata；二进制不写 PostgreSQL，也不写 release/source。
- 上传失败或业务事务失败要补偿清理；删除业务记录前先明确数据库引用和 COS 对象的顺序。
- 测试对象必须使用独立前缀/组织，验证后受控删除并保留必要审计。

### 4.6 React、UI 与 i18n

- 默认使用 Server Component；只有浏览器状态、事件或 Web API 确实需要时才加 `"use client"`。
- Client Component 不得 import Prisma、server infrastructure 或 server-only module。
- 保持响应式移动采集体验；修改 capture/ingest/designer 大组件前先补对应 Playwright 行为测试。
- 用户可见的新文案接入现有中英文 i18n 结构，不在多个组件重复硬编码。
- `public/brand/**` 和 `mockups/brand/**` 是正式品牌资产，未经 Louis 明确要求不得修改或重制。
- 不在功能 PR 顺便全面换风格、引入组件库或状态管理框架。

### 4.7 依赖与新文件

- 优先复用已安装依赖和既有模块。新增 npm/Go 依赖必须有当前需求、维护性和安全理由。
- 可以为明确的新领域能力创建源代码/测试文件，但不能创建同义 service、备用配置、空目录或
  `*-new`/`*-v2` 平行实现来逃避迁移。
- 部署目录、env 文件和生产配置受更严格限制，见部署手册和根 `AGENTS.md`。
- 不提交 build output、`.env*`、数据库 dump、上传文件、Playwright artifacts、日志、临时脚本或
  真实科研数据。

### 4.8 批量数据导入

批量导入数据库记录和文件必须遵守
[`data-import-rules.md`](data-import-rules.md)。导入不是 deployment，也不是普通 seed：每个数据集
需要独立 inventory、mapping、受测 importer、真实测试库/非生产 COS 演练、二次幂等验证、生产
batchId、canary、reconciliation 和回滚批准。不得把 source dump restore 到现有生产库，不得把
文件复制进 source/release，也不得直接运行仓库里的历史 `seed-*`/`stage-*`/`backfill-*` 脚本。

## 5. 测试策略

| 类型         | 工具                                | 适用范围                                                      |
| ------------ | ----------------------------------- | ------------------------------------------------------------- |
| 单元测试     | Vitest                              | Zod schema、policy、parser、serial、key、sanitize、纯状态转换 |
| 集成测试     | Vitest + 真 PostgreSQL              | scope、跨组织拒绝、事务、审计、领域 service、ingest、runs     |
| 浏览器 E2E   | Playwright                          | 登录、核心导航、采集/上传等用户可见行为                       |
| 契约/fixture | Vitest + 真实 CSV fixture           | 仪器 parser、Go Bridge ingest 兼容性                          |
| 部署制品     | shell syntax + deploy check + build | env/Nginx/systemd/script 约束和 release artifact              |

### 5.1 常用命令

在 `pheno-lab/`：

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run structure:check
pnpm run deploy:check
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify
```

数据库集成测试：

```bash
TEST_DATABASE_URL='postgresql://.../pheno_lab_test' pnpm run test:db:prepare
TEST_DATABASE_URL='postgresql://.../pheno_lab_test' pnpm run test:db:drift
TEST_DATABASE_URL='postgresql://.../pheno_lab_test' pnpm run test:integration
```

测试 guard 要求测试库与 `DATABASE_URL` 不同、名称以 `_test` 结尾，并在非 CI 环境使用
loopback。不要改 guard 来适配不安全的 URL。

UI/用户流程：

```bash
pnpm run e2e
```

Bridge：

```bash
cd ../pheno-bridge
go test ./...
```

### 5.2 按改动选择门禁

- 纯文档：Prettier、链接/路径检查、`git diff --check`。
- 纯 schema/policy/parser：相关 Vitest + `pnpm run typecheck` + `structure:check`。
- module/Action/Route：相关单元/集成测试 + `pnpm run verify`。
- UI/登录/上传/路由：`pnpm run verify` + Playwright。
- Prisma/migration：schema drift + 全部集成测试 + `pnpm run verify`；人工审查 SQL。
- deploy/config/storage：相关测试 + `deploy:check` + `pnpm run verify` + artifact 构建；不得自动部署。
- Bridge/API contract：Web 契约测试 + `go test ./...`。

提交或 PR 前工作区不应包含未知文件、真实数据、secret 或被 agent 自动生成但未解释的制品。

## 6. 功能开发的推荐闭环

1. 用一段话定义用户、业务结果和明确非目标。
2. 找到领域所有者和现有 service/schema/test，确认不需要另建平行实现。
3. 先固定高风险行为：权限、组织 scope、数据关系、外部契约和失败语义。
4. 在 module 实现业务能力；让 Action/Route/Page 保持薄。
5. 把审计和数据库写入放进同一事务。
6. 为外部输入补 Zod，为权限和数据路径补单元/集成测试。
7. 需要时修改 UI，并用 Playwright 固定关键行为。
8. 运行门禁，检查 git diff，更新受影响文档。
9. 报告仍需 Louis 决策或人工运维的事项，不把它们伪装成已完成。

## 7. 明确禁止的“vibe coding”模式

- 未读现有代码就另写一套 auth、storage、database client、API wrapper 或配置加载器。
- 只让 TypeScript 编译通过，却不测试权限、组织隔离和运行时输入。
- 看到大文件就机械拆分，或同时改 UI、ORM、API 和部署方式。
- 用 mock Prisma 测试跨租户安全，然后宣称授权已验证。
- 为快速演示把管理员权限、测试 secret、固定 OTP 或 demo seed 放进生产路径。
- 修改已应用 migration、删除审计、直接操作生产 COS/数据库，或在生产机手改 source。
- 新建 `.env.production`、备用 Nginx/systemd 文件、Docker 服务或第二个部署流程。
- 测试失败时放宽 guard、添加 skip、降低断言或吞掉错误。
- 把计划、推测或“命令没有报错”写成已经完成的生产验收。

## 8. 文档地图

- [`../AGENTS.md`](../AGENTS.md)：agent 总则、Louis 决策边界、部署硬约束和任务索引。
- [`architecture-refactor.md`](architecture-refactor.md)：为什么采用模块化单体、长期触发条件和重构历史。
- [`../pheno-lab/deploy/README.md`](../pheno-lab/deploy/README.md)：唯一生产部署/更新/回滚手册。
- [`pheno-lab-production-deployment-log-2026-08-25.md`](pheno-lab-production-deployment-log-2026-08-25.md)：首次真实部署证据和故障处理。
- [`data-inventory-template.md`](data-inventory-template.md)：历史数据库/附件迁移前盘点模板。
- [`data-import-rules.md`](data-import-rules.md)：数据库、文件、COS 批量导入的强制流程和批准门槛。
- [`../pheno-lab/src/modules/README.md`](../pheno-lab/src/modules/README.md)：领域模块局部规则。
- [`../pheno-lab/README.md`](../pheno-lab/README.md)：本地启动、产品结构和安全概览。
- [`../PLAN.md`](../PLAN.md)：早期产品规划，仅作背景；与当前代码冲突时以代码和上述现行文档为准。
