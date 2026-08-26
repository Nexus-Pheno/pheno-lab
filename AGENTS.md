# Pheno Lab Agent 开发与运维总则

本文件适用于整个仓库。任何 coding agent 在分析、修改、测试或部署前都必须先阅读本文件，
再按“文件索引”读取与任务直接相关的文档。不要只凭聊天上下文、模型记忆或常见脚手架习惯行事。

## 1. 项目负责人和决策边界

项目负责人是 **Louis**。以下情况必须停止扩大改动，向 Louis 说明已知事实、风险和可选方案，
获得明确答复后再继续：

- 产品行为、权限语义、科研数据含义或组织隔离规则不明确；
- 需要删除、覆盖、回填、合并或迁移 PostgreSQL/COS 中的真实数据；
- 需要新增部署文件、生产环境变量、系统服务、进程、端口、域名、云资源或长期凭据；
- 需要修改生产 Nginx、systemd、Certbot、CAM、COS、PostgreSQL 权限、备份或网络配置；
- 需要执行生产部署、migration、回滚、secret 轮换或任何外部状态变更；
- 需要改变 Next.js + Prisma 模块化单体这一架构决定，或引入独立 API/队列/缓存/容器编排；
- 发现文档、代码和真实环境互相矛盾，无法用只读检查确认哪个才是事实；
- 需求有多个会显著改变数据、安全、用户体验或工期的合理解释。

不要把“先做一个假设”用于上述高风险事项。不确定时问 Louis，不要替 Louis 作生产决策。

## 2. 工作方式

每次任务都遵守以下顺序：

1. 阅读本文件及相关索引文档；检查 `git status --short --branch`，保留他人的未提交改动。
2. 先读现有实现、测试、schema 和历史决策，再提出或实施最小的完整改动。
3. 修复根因，不复制已有能力，不为“以后可能用到”创建空抽象、备用目录或第二套配置。
4. 改业务行为时同步增加或更新测试；涉及权限、多租户或事务时使用真实测试 PostgreSQL。
5. 运行与风险相称的校验；交付前至少运行受影响测试、TypeScript、架构边界和格式检查。
6. 清楚报告修改文件、验证结果、未完成事项和需要人工执行的生产步骤。

除非 Louis 明确要求，否则 agent 不得自行 commit、push、创建 PR、部署、发消息或修改云资源。
不得通过删除/重置他人改动来得到干净工作区；禁止 `git reset --hard`、生产 `db push`、生产
`migrate dev` 和生产 seed。

## 3. 不可违反的架构边界

- 当前架构是**可测试的 Next.js 模块化单体**：一个 Web 进程、一个部署单元、一个 PostgreSQL
  数据库；不要擅自拆成 Pulse 式独立 Web/API 服务。
- `src/app/**`、Route Handler 和 `src/lib/actions/**` 是传输层，只负责鉴权入口、输入解析、调用
  service、映射响应和 cache/revalidation，不承载重复的领域规则。
- 领域逻辑位于 `src/modules/**`。模块不得 import `src/app`、React 组件、Server Action 或 Next.js
  传输 API；服务端 `service.ts` / `query.ts` 必须使用 `import "server-only"`。
- PostgreSQL、COS、邮件、运行配置和密钥实现位于 `src/infrastructure/**`。Client Component 不得
  import server infrastructure、Prisma runtime 或 server-only service。
- UI 隐藏按钮不是权限控制。所有读写必须在服务端验证 actor、role、organization scope 和资源
  归属；不要把角色判断重新散落到 page、Action 和 Route 中。
- 外部输入必须做运行时校验，优先使用已有 Zod schema。TypeScript 类型不能替代运行时校验。
- 业务修改和对应 `AuditEvent` 应在同一事务中完成；审计 payload 不得包含密码、token、密钥、
  OTP、完整凭据或无必要的科研敏感内容。
- 生产文件只写 COS，并通过现有 storage adapter；不要在 page/Action/module 中直接调用 COS SDK
  或 `fs` 写生产附件。Local storage 仅供开发、测试和明确批准的迁移。
- Go Bridge 已使用现有 `/api/ingest/*` 契约。任何 URL、认证、字段、状态码、幂等或重试语义变更
  都必须保持向后兼容并增加契约测试。
- 不以“整理代码”为由主动大拆 React 组件、替换 Next.js/Prisma/Tailwind、重写 UI 或引入新状态
  管理框架。只有当前功能确实需要修改且已有行为测试保护时才就地拆分。

`pheno-lab/scripts/check-structure.ts` 是可执行边界，不得绕过、删除或用 lint ignore 掩盖违规。

## 4. 数据和数据库规则

- `pheno-lab/prisma/schema.prisma` 是数据模型源；已应用的 migration 永不修改，只能新增 migration。
- schema 变更必须使用 expand/contract：先增加兼容结构，再迁移读写，最后在后续 release 清理旧
  结构。代码回滚不会回滚数据库。
- 权限、组织隔离、审计、ingest 关联和关键事务必须在独立 `_test` PostgreSQL 上测试；不要用
  Prisma mock 证明数据库授权正确。
- 测试必须经过仓库的 test database guard。不得把 `DATABASE_URL` 当测试库，不得关闭 `_test`
  后缀、loopback 和主库不同等保护。
- 不执行 demo seed 到生产。生产 bootstrap 已完成，不得再次运行或创建第二个 bootstrap 脚本。
- 任何批量数据库/文件导入都必须遵守 `docs/data-import-rules.md`：先盘点、恢复演练、字段映射、
  测试库与非生产 COS 演练、二次幂等验证、canary、reconciliation 和可精确识别批次的回滚。
- 数据导入与代码发布是不同授权。脚本存在、PR 合并或 dry run 通过都不等于允许生产 `--apply`；
  Louis 必须批准具体 dataset、commit、batchId 和执行窗口。
- `stage-*`、`seed-*`、`mock-lab-day.ts`、`backfill-serials.ts` 和
  `migrate-uploads-to-cos.ts` 都有严格适用边界，不得把文件名中的“stage/seed/backfill/migrate”
  当作生产安全证明。
- 不在 Git、Issue、PR、日志、测试 fixture 或文档中保存真实密码、数据库 URL、管理员身份、完整
  COS object key、Session Secret、CAM 临时凭据或科研原始数据。

## 5. 测试与交付门槛

在 `pheno-lab/` 目录执行：

```bash
pnpm run verify
```

它依次执行 format、ESLint、架构边界、部署文件检查、TypeScript、Vitest 和 production build。
按改动范围再执行：

```bash
# 需要独立、受保护的 TEST_DATABASE_URL
pnpm run test:db:prepare
pnpm run test:db:drift
pnpm run test:integration

# 核心浏览器行为或 UI/路由变更
pnpm run e2e

# Go Bridge 变更
(cd ../pheno-bridge && go test ./...)
```

如果因本机依赖或外部服务无法运行某项检查，必须明确报告未运行的命令和原因，不能写“全部通过”。
不要通过弱化断言、跳过测试、删除 fixture 或放宽安全检查来让 CI 变绿。

## 6. 部署硬约束

生产部署的唯一操作手册是
[`pheno-lab/deploy/README.md`](pheno-lab/deploy/README.md)，真实首发证据是
[`docs/pheno-lab-production-deployment-log-2026-08-25.md`](docs/pheno-lab-production-deployment-log-2026-08-25.md)。
两者冲突时先做只读核对，再问 Louis；不要自行选择第三种流程。

日常更新必须沿用现有链路：

```text
/srv/pheno-lab/source 中 git pull
  -> 现有 build-release.sh 构建并校验 artifact
  -> /srv/pheno-lab/releases/<release-id>
  -> 现有 deploy-release.sh 迁移、切换 current、重启、readiness
```

未经 Louis 明确批准，部署 agent 不得：

- 新建 `.env.production`、`.env.local`、第二份 env、secret 文件或新的 `/etc` 配置路径；
- 新建或改用另一套 systemd unit、Nginx vhost、Certbot hook、cron、PM2、Docker/Compose 服务；
- 新建 uploads/backups 目录到 App CVM，或把附件、数据库 dump 写入 source/release；
- 绕过 release 脚本在 `/srv/pheno-lab/current` 内修改代码或直接运行 `next start`；
- 覆盖 `/etc/pheno-lab/pheno-lab.env`，或自动生成/轮换生产 secret；
- 修改 `/srv/talent-platform`、其 Nginx 站点或同机其他服务；
- 开放 3457/5432 公网端口，改用 root 运行应用，或把 COS 改为长期静态密钥；
- 对生产库执行 `prisma migrate dev`、`prisma db push`、`prisma db seed` 或 destructive SQL。

现有生产配置只能备份后做**增量修改**；需要新文件、新变量、新服务或新路径时，先问 Louis。
普通功能开发不授权生产部署。

## 7. 文件索引与阅读顺序

| 任务               | 必须先读                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 任何代码修改       | 本文件；`docs/development-standards.md`；`pheno-lab/README.md`                                                                                   |
| 架构/模块边界      | `docs/architecture-refactor.md`；`pheno-lab/src/modules/README.md`；`pheno-lab/scripts/check-structure.ts`                                       |
| 数据模型/migration | `pheno-lab/prisma/schema.prisma`；相关 migration；集成测试；本文第 4 节                                                                          |
| 权限/组织隔离      | `pheno-lab/src/modules/authorization/**`；`pheno-lab/tests/integration/authorization.test.ts`；`pheno-lab/tests/integration/permissions.test.ts` |
| 仪器/Bridge        | `pheno-bridge/README.md`；`pheno-lab/src/modules/ingest/**`；`pheno-lab/src/modules/instruments/**`；parser fixture/tests                        |
| 文件/COS           | `pheno-lab/src/infrastructure/storage/**`；`pheno-lab/src/modules/files/**`；架构文档第 10 节                                                    |
| 配置/环境变量      | `pheno-lab/src/infrastructure/config/schema.ts`；`pheno-lab/.env.example`；`pheno-lab/deploy/pheno-lab.env.example`；配置测试                    |
| 测试/CI            | `pheno-lab/package.json`；`.github/workflows/verify.yml`；Vitest/Playwright 配置                                                                 |
| 部署/回滚          | `pheno-lab/deploy/README.md`；首次生产部署实录；现有 deploy scripts/templates                                                                    |
| 批量数据导入       | `docs/data-import-rules.md`；`docs/data-inventory-template.md`；Prisma schema；storage/audit；相关 importer/tests；必须取得 Louis 批次批准       |
| 历史数据迁移       | `docs/data-inventory-template.md`；架构文档相关章节；必须取得 Louis 批准                                                                         |
| 产品范围/早期设计  | `PLAN.md`；注意它是历史规划，当前代码与上述规范优先                                                                                              |

## 8. 文档维护规则

- 改变技术栈、依赖方向、质量门禁或开发命令时，同步更新
  `docs/development-standards.md` 和相关 README。
- 改变发布脚本、生产路径、systemd/Nginx/COS/PostgreSQL 约束时，必须先更新现有
  `pheno-lab/deploy/README.md`、模板和自动检查；不要另建一份部署手册。
- 部署实录是历史证据，只追加实际发生且已验证的事件；不要把计划写成已完成。
- 新增或改变批量导入路径、importer 前置条件、COS key/清理顺序或 reconciliation 时，同步更新
  `docs/data-import-rules.md`；不要另建一份相互竞争的数据迁移手册。
- 文档示例必须使用占位符，禁止复制生产 secret、完整内部标识或真实科研数据。
- 不创建 `AGENT.md`、`agent.md` 或另一份同类 agent 规则；本文件 `AGENTS.md` 是唯一仓库级总则。
