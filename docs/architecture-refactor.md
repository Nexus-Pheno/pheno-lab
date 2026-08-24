# Pheno Lab 架构重构与腾讯云部署方案

> 状态：已批准实施 · 版本 v2 · 2026-08-24
> 目标：将现有耦合的 Next.js 单体重构为可测试的模块化单体，并以最少组件稳定部署到腾讯云。
> 核心约束：不重写产品、不拆独立 Hono API、不更换 Next.js / Prisma / PostgreSQL，不破坏现有实验与仪器数据。
> 当前交付边界：仓库内的模块化重构、测试、COS 适配器和部署制品已完成；腾讯云资源创建、生产配置、真实数据迁移和服务器切换在资源就绪后执行。

> 实施进度（2026-08-24）：仓库内重构已完成并通过完整本地验收；腾讯云实际主机、PostgreSQL、COS 与生产数据切换尚未执行。

---

## 0. 摘要

Pheno Lab 当前已经是一套功能完整的实验数据平台，而不是空骨架：它包含实验设计、样品与变化组、
实验执行、表征结果、材料与设备库、组织与角色权限、仪器文件自动采集、数据导入、导出、备份和反馈。

当前最主要的长期风险不是部署形态，而是**代码边界和验证能力**：

- 业务逻辑、权限、Prisma 查询、缓存刷新和传输层混在大型 Server Action 中；
- 页面与 Route Handler 中仍有直接数据库访问和分散的角色 / 组织判断；
- 自动化测试为 0，关键科研数据路径只能靠手工脚本验证；
- `zod` 已安装但 `src/` 中没有实际使用，外部输入缺少统一运行时校验；
- 没有审计日志，无法回答“谁在什么时候修改了哪个实验事实”；
- 图片、反馈附件和仪器原始文件写在应用工作目录，不适合 release 切换和无状态部署；
- 配置分散读取，`SESSION_SECRET` 等关键配置缺失时不能在启动阶段失败。

目标不是复制 Pulse 的 Web/API 两进程架构，而是采纳其中最有价值的工程约束：

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 运行形态 | 单个 Next.js 应用 + PostgreSQL + Go Bridge | **保持不变** |
| 浏览器写入 | Server Actions | **保持，改为薄适配层** |
| 仪器接入 | `/api/ingest/*` REST | **保持并稳定契约** |
| 业务逻辑 | 分散在 Action / Page / Route | **按领域收敛到 `src/modules/`** |
| 权限 | 多处手写角色和组织判断 | **统一 actor、policy、scope** |
| 输入验证 | TypeScript 类型为主 | **Zod 运行时校验** |
| 测试 | 0 个自动化测试 | **Vitest + 真 PostgreSQL + Playwright 冒烟** |
| 审计 | 无统一审计表 | **事务内追加 AuditEvent** |
| 文件 | 应用本地 `uploads/` | **Storage Adapter；首发使用外置本地目录，随后切 COS 私有桶** |
| 部署 | Mac / 手工运行语义 | **Ubuntu + Nginx + systemd + release 目录** |

推荐生产拓扑：

```text
浏览器 / 实验室终端 / Go Bridge
                 │ HTTPS
                 ▼
       腾讯云 CLB（可选）/ Nginx
                 │ 127.0.0.1:3457
                 ▼
        Ubuntu CVM · systemd
          pheno-lab.service
                 │
        ┌────────┴────────┐
        ▼                 ▼
 PostgreSQL          COS 对象存储
 同 VPC 内网         私有桶（第二里程碑）

 可选未来依赖：pgvector / 独立向量索引；它不是 COS，也不是当前上线前置条件。
```

实施分成两个里程碑：

1. **Web 可部署**：数据盘点 → 配置与测试基础 → 权限收敛 → 审计基础 → 按领域抽服务 →
   外置本地文件存储 → systemd / Nginx / release 部署；
2. **云数据切换**：腾讯云 PostgreSQL / COS 就绪 → 新写入切 COS → 存量文件与数据库迁移 → 完整恢复演练。

不允许在零测试状态下同时改权限、数据库结构、文件存储和部署方式。

### 0.1 本轮实施结果

| 范围 | 状态 | 已落地结果 |
| --- | --- | --- |
| 00–03 | 完成 | 数据盘点模板、集中配置、Vitest / PostgreSQL guard / Playwright / CI、4 个真实仪器 fixture、serial / dedupe / rematch 测试 |
| 04 | 完成 | actor / policy / scope、实时数据库 session 角色、跨组织真库测试、文件资源授权 |
| 05 | 完成 | additive `AuditEvent` migration、脱敏 writer、用户 / 仪器 / system actor、事务回滚测试 |
| 06 | 完成仪器闭环 | `/api/ingest/jv` 变薄、Zod 元数据、领域 service、原始文件 adapter、契约集成测试 |
| 06R | 完成 | 补上 migration 漂移、capture 关系完整性与 AI key 明文风险，并按首个完整领域闭环重估范围 |
| 07 | 完成 | experiments / runs / capture / workflow 进入领域服务；跨实体约束与关键写入事务审计 |
| 08 | 完成 | accounts、AI、data、exports、ingest review、insights、library、organizations、stewardship、system 全部收敛到领域模块；Action / Page / Route 不再直接访问 Prisma；experiments 与 ingest 再按生命周期 / 计划 / 发布 / 重复处置等能力拆分，避免把大 Action 原样搬成大 Service |
| 09A | 完成 | LocalObjectStorage、外置 `UPLOAD_DIR`、组织 / 实验授权下载、技术员上传 E2E |
| 09B | 代码完成、待云端启用 | 私有 COS adapter、CVM instance-role 临时凭据、静态凭据 fallback、COS-only 新写入与本地只读回落；不含 bucket / CAM 实际创建 |
| 09C | 待部署期执行 | 真实 `uploads/` / `pheno-data/` 盘点、hash 迁移、抽样下载、生产切换与旧副本保留 |
| 10 | 代码与配置完成 | health、Linux artifact、systemd、Nginx、定时备份、checksum、真实代码回滚；尚未在腾讯云主机演练 |

实施中额外发现：Git 中原有 4 个 migration 落后于 `schema.prisma`，新数据库会缺少仪器、ingest、workflow 等表 / 列。
现已增加幂等、只增不删的 baseline reconciliation migration，并在独立 `_test` 数据库上执行 `migrate deploy` 与 schema drift 检查。
该 migration 在导入真实数据前仍需对数据所有者的数据库副本做一次人工审查和恢复演练。

Web “可部署”表示 artifact、配置和验证门槛齐备，不表示已经配置腾讯云资源或迁移真实数据。首次服务器切换仍必须完成 §12 和 §14.1 的人工步骤。

最终本地验收结果：Node 24.19.0 下 `pnpm run verify`（format、lint、架构边界、部署脚本、typecheck、54 个单元测试和 production build）、
独立 `_test` PostgreSQL 上 8 个集成测试、Playwright 5 条浏览器 E2E 全部通过。Go Bridge 使用只读挂载的 Go 1.26.7
容器执行 `go test ./...` 通过（当前包没有 Go 测试文件），并已进入 Linux CI。

---

## 1. 背景与现状

### 1.1 产品边界

Pheno Lab 是内部实验数据与执行平台，当前有两个真实消费方：

1. **浏览器**：桌面实验设计器、移动端响应式采集页面、管理后台；它们属于同一个 Next.js 应用。
2. **Go Bridge**：运行在仪器 Windows PC 上，通过 REST 上传 J-V 等原始文件和心跳。

移动采集端不是独立 App。它直接属于浏览器客户端，不构成拆独立 API 的理由。

当前“浏览器走 Server Actions、Go Bridge 走 REST”是合理设计。重构只让两类入口调用同一套业务服务，
不把所有浏览器操作改成 HTTP。

### 1.2 当前技术栈

| 层 | 当前选型 |
| --- | --- |
| Web / Server | Next.js 16.3.1 App Router |
| UI | React 19.2.8、Tailwind CSS 4、lucide-react |
| 语言 | TypeScript 5 |
| 数据库 | PostgreSQL |
| ORM | Prisma 6.19.3 |
| 身份 | JWT httpOnly cookie、bcrypt、三级角色 |
| 输入校验依赖 | Zod 4.4.3（已安装但未使用） |
| 邮件 | Nodemailer |
| 仪器 Agent | Go，只有标准库依赖 |
| 文件 | 应用服务器本地磁盘 |
| 包管理 | pnpm 11 |

### 1.3 代码规模基线

以下数据以 2026-08-24 的 `main` 分支为基线：

| 项目 | 数量 |
| --- | ---: |
| `src/` 文件 | 119 |
| TypeScript / TSX | 19,885 行 |
| Prisma model | 35 |
| Prisma enum | 6 |
| Server Action 文件 | 17 |
| Route Handler | 6 |
| 自动化测试文件 | **0** |

最大的可执行文件包括：

| 文件 | 行数 | 处理原则 |
| --- | ---: | --- |
| `components/capture/CaptureView.tsx` | 1,299 | 不单独排期；修改采集行为时在 E2E 保护下拆 |
| `components/ingest/IngestReview.tsx` | 1,050 | 不单独排期；修改复核行为时拆 |
| `lib/actions/ingest.ts` | 1,024 | 属于领域服务抽取范围 |
| `components/designer/inspectors.tsx` | 841 | 机会性拆分 |
| `lib/actions/experiments.ts` | 649 | 属于领域服务抽取范围 |
| `components/designer/Designer.tsx` | 592 | 机会性拆分 |

大型文件本身不是架构失败的充分条件。后端业务与权限文件需要主动拆分；前端组件只有在新增行为、
已有测试保护或影响开发效率时才拆，避免把机械拆文件误当成进度。

### 1.4 当前运行边界

```text
Server Component ───────┐
Client Component        │
  └─ Server Action ─────┼─ 直接调用 Prisma
Route Handler ──────────┤
AI / instrument helper ─┘
```

问题不在“单体”，而在传输层和业务层没有稳定的内部分界：

- Action 同时负责身份、授权、输入、事务、业务规则、错误和 `revalidatePath`；
- 页面直接查询 Prisma 并自行判断组织与成员权限；
- 同一条授权规则可能在列表、详情、Action 和 Route 中以不同写法存在；
- 业务规则难以在不启动 Next.js 调用栈的情况下测试；
- 将来增加新入口时，只能复制逻辑或继续直接访问数据库。

### 1.5 已知数据边界与盘点门槛

已经确认：

- 开发者工作站存在实验 / 历史科研数据；
- 当前 Git 工作区和 Git 历史不包含运行中的 PostgreSQL 数据、`uploads/`、`backups/` 或 `pheno-data/`；
- 仓库只有 seed / demo 数据和四个仪器解析 fixture；
- 现有 `backup.sh` 只备份 PostgreSQL，不备份本地文件；
- 历史脚本直接引用开发者工作站上的 `pheno-data/`，其中可能含不可再生或保密科研原件。

尚未确认：开发者本地数据中哪些属于正在使用的生产数据、测试 / demo、历史档案或重复副本。
分类完成前，全部按**不可再生数据**处理，禁止清空、覆盖、重建或自动删除。

阶段 00 必须产出一份不含实验正文和密钥的只读盘点：

| 范围 | 只记录 |
| --- | --- |
| PostgreSQL | 版本、migration 状态、库大小、核心表行数、最早 / 最新时间 |
| `uploads/` | 文件数量、总大小、类型、hash 覆盖率、孤立文件 / 断链引用 |
| `backups/` | 最近成功时间、大小、是否完成隔离恢复 |
| `pheno-data/` | 目录级数量 / 大小、保密等级、是否已导入；不抄录内容 |
| 仪器电脑 | source 目录、Bridge 版本、`config.json` / `state.json` 是否可重建 |

代码重构和测试框架可以先行；任何生产数据库迁移、COS 存量迁移或清理动作必须等待盘点批准。

---

## 2. 重构目标与非目标

### 2.1 目标

1. 任何关键业务规则都能脱离 UI 和 Next.js 传输层进行测试。
2. 所有组织、角色、成员与资源权限使用同一套策略和查询 scope。
3. 页面、Server Action 和 Route Handler 不再直接承载跨实体业务事务。
4. 外部输入使用 Zod 校验，TypeScript 类型由 schema 推导。
5. 权限、多租户、仪器解析和科研数据关联通过真实 PostgreSQL 集成测试验证。
6. 所有关键科研数据变更在同一事务内产生不可变审计事件。
7. 文件访问经过 Storage Adapter；首发本地目录位于 release 外，COS 就绪后成为生产文件事实来源。
8. Ubuntu 上通过 Nginx + systemd 稳定运行，支持明确发布、健康检查和回滚。
9. Go Bridge 的现有 URL 与行为保持兼容，升级不要求同时前往实验室更新 Agent。

### 2.2 非目标

本次明确不做：

- Next.js → Vite；
- Prisma → Drizzle；
- 新建独立 Hono API 进程；
- 浏览器请求全部改成 REST；
- Kubernetes、Redis、消息队列或微服务；
- 为了目录整齐一次性拆完所有大型 React 组件；
- 业务功能重写或视觉改版；
- 在没有规模证据时引入独立向量数据库；
- 多实例高可用。

### 2.3 成功定义

重构完成的判断标准不是“目录移动完了”，而是：

- `pnpm run verify` 在本地和 CI 稳定通过；
- 权限矩阵、组织隔离和关键仪器路径有自动化测试；
- Server Action / Route Handler 是薄适配层；
- 新业务规则有明确领域归属，不再加入通用 `lib/` 大文件；
- 科研数据关键修改可从 AuditEvent 追溯；
- 应用可从一份 release artifact 部署到 `/srv/pheno-lab`；
- 第一里程碑可用 PostgreSQL、`/var/lib/pheno-lab/uploads`、配置和 release artifact 恢复服务；
- 第二里程碑可在 CVM 删除后只靠 PostgreSQL、COS、配置和 release artifact 恢复服务；
- Go Bridge 不更新也能继续上传现有格式文件。

---

## 3. 目标架构

### 3.1 模块化单体

```text
Transport / Presentation
├─ Server Components
├─ Client Components
├─ Server Actions
└─ Route Handlers
          │
          ▼
Application / Domain Modules
├─ authorization
├─ experiments
├─ runs
├─ ingest
├─ instruments
├─ materials
├─ organizations
├─ exports
└─ audit
          │
          ▼
Infrastructure
├─ Prisma / PostgreSQL
├─ COS / local storage adapter
├─ mail
├─ AI providers
└─ vector adapter（可选）
```

它仍然是一个 Next.js 进程、一个部署单元、一个 PostgreSQL 数据库。

### 3.2 推荐目录

第一阶段保留仓库现有顶层 `pheno-lab/` 与 `pheno-bridge/`，避免把大规模路径移动和业务重构绑在一起：

```text
pheno-lab/                         # Git 仓库根目录
├─ pheno-lab/                     # Next.js 模块化单体
│  ├─ prisma/
│  └─ src/
│     ├─ app/                     # Next.js 页面和 Route Handler
│     ├─ components/              # 展示组件
│     ├─ modules/
│     │  ├─ authorization/
│     │  │  ├─ actor.ts
│     │  │  ├─ policies.ts
│     │  │  ├─ scopes.ts
│     │  │  └─ policies.test.ts
│     │  ├─ experiments/
│     │  │  ├─ schemas.ts
│     │  │  ├─ service.ts
│     │  │  ├─ queries.ts         # 只有读路径变复杂时才创建
│     │  │  └─ service.integration.test.ts
│     │  ├─ runs/
│     │  ├─ ingest/
│     │  ├─ instruments/
│     │  ├─ materials/
│     │  └─ audit/
│     ├─ infrastructure/
│     │  ├─ database/
│     │  ├─ storage/
│     │  ├─ mail/
│     │  ├─ ai/
│     │  └─ vector/
│     └─ lib/actions/             # 迁移期兼容；最终只留薄 Action
├─ pheno-bridge/                  # Go Bridge，协议兼容
├─ docs/
├─ infra/
│  ├─ nginx/
│  └─ systemd/
└─ scripts/
```

不强制每个模块同时存在 `commands.ts`、`queries.ts`、`repository.ts`。文件在真实复杂度出现时再拆，
避免生成空壳。

### 3.3 依赖方向

允许：

```text
app / components
      ↓
modules
      ↓
infrastructure
```

禁止：

- `modules` import `app/**`；
- 领域服务依赖 React、Next navigation 或 `revalidatePath`；
- Client Component import Prisma、server-only infrastructure；
- 页面重新实现授权 policy；
- 一个领域直接修改另一个领域的内部表而不经过公开服务；
- `infrastructure` 反向 import 业务 UI。

这些规则最终由 ESLint / structure check 进入 `pnpm run verify`，不能只写在文档中。

所有访问 Prisma、COS、本地持久化目录、服务端配置或密钥的文件必须显式 `import "server-only"`，包括：

- `modules/**/service.ts`；
- `modules/**/repository.ts`；
- `infrastructure/db/**`；
- `infrastructure/storage/**`；
- `infrastructure/config/**`。

纯 `policy.ts`、无副作用的 `schemas.ts` 和共享类型不强制 server-only，以便在确有需要时复用。

---

## 4. 关键决策记录

### D-1 · 保持模块化单体，不拆独立 API

当前真实客户端是浏览器和 Go Bridge。浏览器与 Next.js 在同一个应用内，Go Bridge 已经有专用 REST 接口。
独立 API 会新增 HTTP 序列化、Cookie / CSRF、版本兼容、第二套部署和缓存问题，却没有对应的第二个业务客户端。

拆 API 的触发条件：

- 确定开发原生移动 App；
- 给合作方或其他实验室开放 API；
- 出现第二套独立 Web 产品；
- 仪器上传和解析需要独立扩容；
- Web 与后端由不同团队独立发布；
- 单体已经形成可量化的性能或可靠性瓶颈。

触发前不做。

### D-2 · 保留 Next.js 与 Prisma

Next.js 的 Server Components、Server Actions 和同进程鉴权正在被实际使用；Prisma 已承载 35 个关联模型。
更换框架或 ORM 会扩大回归面，却不解决权限散布、零测试和业务逻辑混层。

### D-3 · authorization 优先于普通领域模块

权限回归通常不会崩溃，而会静默暴露不该看到的实验。authorization 是风险最高、也最适合纯函数测试的模块，
必须在普通领域抽取前完成。

但“集中授权”不代表只在一个全局入口检查一次。每个 service 入口仍要执行统一 policy；每个查询仍要应用统一 scope。

### D-4 · 真 PostgreSQL 测权限和组织隔离

mock Prisma 只能证明 mock 按预期工作，不能证明查询真的包含 organization / membership 约束。

测试库必须具备硬保护：

- 数据库名以 `_test` 结尾；
- `TEST_DATABASE_URL` 不得等于 `DATABASE_URL`；
- 非 CI 环境只允许 loopback host；
- 危险清理操作只接受经过上述校验的 URL；
- CI 使用独立 PostgreSQL service。

初期可按测试组清表或重建 schema；等 service 接受 transaction client 后再逐步使用事务回滚，
不把某一种清理方式当成目标。

### D-5 · 审计事件与业务修改同事务

AuditEvent 不是普通日志。实验修改成功而审计写入失败不可接受，因此二者必须使用同一个 Prisma transaction client。

不采用完整 event sourcing；当前 PostgreSQL 表仍是事实状态，AuditEvent 是不可变的操作轨迹。

### D-6 · COS 是生产文件事实来源

生产环境不再把 `process.cwd()/uploads` 当持久存储。数据库保存 object key 和元数据，文件本体进入 COS 私有桶。

为先让 Web 上线，第一里程碑允许 `LocalObjectStorage` 指向 `/var/lib/pheno-lab/uploads`。该目录必须位于 release 外，
纳入独立备份，并且所有调用已经通过同一个 Storage interface；业务代码不得再直接使用 `process.cwd()/uploads`。
COS 资源就绪后只替换 adapter 和执行迁移，不改变领域服务或外部 API。

初期下载仍由应用代理：应用先执行组织 / 实验权限检查，再读取 COS 返回。预签名 URL 等流量真正成为问题后再引入。

### D-7 · Go Bridge 契约稳定优先

Bridge 的 `/api/ingest/heartbeat`、`/api/ingest/jv` 等接口属于真实外部契约。重构不得静默改变：

- URL；
- API key 认证；
- 去重语义；
- 文件稳定 / 重试预期；
- 成功和错误响应；
- 未匹配文件保留行为。

先用 fixture 建契约测试，再考虑 `/api/v1` 或 OpenAPI。Go 无法直接复用 TypeScript 的 Zod package，
需要共享时输出 OpenAPI / JSON Schema。

### D-8 · 单个 systemd 进程，不上容器编排

当前服务端只有一个 Next.js 进程，数据库和文件存储均为外部依赖；可选向量服务不属于当前运行前提。systemd 已能提供开机自启、重启、
日志、权限和优雅退出。Docker 可以以后加入，Kubernetes 当前没有收益。

### D-9 · 单实例优先

Next.js 多实例会引入缓存和 `revalidatePath` / tag 协调。当前内部系统允许发布时短暂停机，先运行一个实例。
要高可用时，先让文件进入 COS、健康检查稳定、部署 ID 和共享缓存策略明确，再通过 CLB 增加实例。

### D-10 · 向量索引是派生数据

实验、材料、文档、chunk 和 embedding model 元数据保存在 PostgreSQL / COS；向量索引必须可以重建。

数据量较小时优先 PostgreSQL + pgvector，减少一台数据库。只有压测证明主库无法承担，才使用独立向量服务器。

COS 是对象存储，不是向量数据库。当前代码没有 embedding / RAG / vector 查询，向量服务不属于 Web 首发依赖。

### D-11 · 不主动排期拆大型 React 组件

`CaptureView.tsx` 等组件确实过大，但在零 UI 测试状态下主动拆分风险高，也不解锁后端重构。
它们在下次修改对应功能时，先补 Playwright / 行为测试，再就地拆分。

### D-12 · 不重置生产数据库

已确认开发者本地存在实验 / 历史科研数据，但 Git 不包含运行数据库和文件。数据分类完成前一律按不可再生数据处理。
现有 Prisma migrations 必须保留，后续只追加可审查迁移。禁止用 `prisma migrate reset`、
`db push --accept-data-loss` 或删除数据库卷处理生产问题。

### D-13 · 活跃文件、科研档案和备份分离权限域

推荐至少三个独立 bucket / 权限域：

- `pheno-lab-prod-files`：应用附件和仪器原始文件，应用身份可按组织 prefix 读写；
- `pheno-lab-research-archive`：`pheno-data/` 原始科研档案，应用默认无权限；
- `pheno-lab-db-backups`：PostgreSQL 备份，应用默认无权限。

即使初期因为账号限制使用同一 bucket，也必须使用独立 prefix、CAM 身份和生命周期规则隔离。
应用凭据不得获得删除科研档案或数据库备份的能力。

### D-14 · AI secret 与科研数据外发是正式安全边界

当前 `AiProvider.apiKey` 明文存于 PostgreSQL，实验搜索会向配置的外部模型发送用户问题、材料名、工艺名和配方名。
生产启用 AI 前必须完成以下之一：

- 使用应用密钥 / KMS 对组织级 provider key 做信封加密，并记录 key version；或
- 禁用组织自带 AI provider，只允许经过批准的内网模型。

同时建立外发字段 allowlist。API key、完整配方 payload、保密 SAM 结构、原始实验文件和跨组织数据不得进入 prompt、日志或审计。

---

## 5. 配置与启动校验

### 5.1 当前问题

当前关键配置通过 `process.env.X!` 或分散的布尔判断读取。`SESSION_SECRET` 缺失时，进程可以启动，
直到第一次签发 / 验证 session 才失败；SMTP、ingest cron 等配置也没有集中状态。

### 5.2 目标

新增只在服务端使用的集中配置模块，例如：

```ts
// src/infrastructure/config/server.ts
import "server-only";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  INGEST_CRON_SECRET: z.string().min(24).optional(),
  STORAGE_DRIVER: z.enum(["local", "cos"]),
  UPLOAD_DIR: z.string().optional(),
  COS_REGION: z.string().optional(),
  COS_FILES_BUCKET: z.string().optional(),
  COS_AUTH_MODE: z.enum(["instance-role", "static"]).optional(),
  COS_SECRET_ID: z.string().optional(),
  COS_SECRET_KEY: z.string().optional(),
  VECTOR_DATABASE_URL: z.string().url().optional(),
});
```

额外约束：

- production 禁止示例 secret；
- `STORAGE_DRIVER=cos` 时全部 COS 配置必填；
- `STORAGE_DRIVER=local` 时 `UPLOAD_DIR` 必填且不得位于 release 目录；
- SMTP 配置必须全部存在或全部为空；
- test 环境额外执行测试数据库安全校验；
- config 解析失败时进程启动失败，不允许静默降级。

Next.js 构建阶段与运行阶段环境不同，启动校验要在 Node server 启动路径执行，并为 schema 单独写测试，
不能因构建机没有生产密钥而让 `next build` 失败。

---

## 6. 测试与质量门禁

### 6.1 测试分层

| 层 | 工具 | 目标 |
| --- | --- | --- |
| 纯函数单元测试 | Vitest | parser、serial、policy、状态转换、Zod schema |
| PostgreSQL 集成测试 | Vitest + 独立测试库 | 组织隔离、权限 scope、事务、审计、复制、rematch |
| Route / Action 测试 | Vitest | ingest 认证、输入、响应、service 调用 |
| 浏览器冒烟 | Playwright | 登录、实验创建 / 编辑、移动采集、仪器结果展示 |
| Go Bridge | `go test ./...` | 配置、状态、重试和协议行为 |

### 6.2 第一批必须覆盖

1. 四个 `src/lib/instruments/__fixtures__/` CSV：
   - GiantForce 自动单文件；
   - GiantForce 手工 data；
   - GiantForce 手工 table；
   - LIGHTSKY session。
2. 序列号规范化、pixel suffix、正反扫 key、去重和 alias。
3. 未匹配文件必须保留并可 rematch，不能静默丢弃。
4. 同一 hash 重复上传不会产生重复 measurement。
5. ADMIN / MANAGER / TECHNICIAN 权限矩阵。
6. 跨组织用户无法 list、detail、update、delete 其他组织数据。
7. Manager 的 creator / member 范围。
8. Technician 仅能执行允许的 capture 写入，不能编辑计划。
9. 实验复制不复制 run / execution / measurement，并生成新 serial。
10. 样品集合重建后的 measurement rematch。
11. Technician 在允许的 capture 页面上传 / 删除实验照片；当前 `/api/upload` 的角色限制必须由产品规则和 E2E 明确。

### 6.3 根级门禁

目标命令：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run verify
pnpm run e2e
```

`pnpm run verify` 至少包含：

```text
format:check → lint → structure:check → typecheck → test → build
```

E2E 可在 CI 中单独启动 PostgreSQL 和 Next.js 后运行，避免日常 `verify` 过慢。

Playwright 基础设施属于阶段 02，不推迟到阶段 07：阶段 02 至少建立 Web server、测试账号 / 数据工厂、
登录 smoke、Chromium 安装、失败截图和 trace。阶段 07 负责增加实验领域的完整 E2E 场景。

### 6.4 CI

CI 使用独立 PostgreSQL service，流程：

```text
checkout
→ 安装固定 Node / pnpm
→ pnpm install --frozen-lockfile
→ 创建 pheno_lab_test
→ prisma migrate deploy
→ pnpm run verify
→ 安装 Chromium
→ pnpm run e2e
→ 生成 Linux release artifact 并校验 SHA-256
→ go test ./...（pheno-bridge）
```

---

## 7. Authorization 设计

### 7.1 三层概念

```text
Authentication
  当前用户 / 仪器是谁，session / API key 是否有效

Policy
  该 actor 是否允许执行某种动作

Scope
  查询能返回哪些 organization / experiment / sample
```

UI 是否显示按钮不是安全边界。所有安全规则必须在服务端 service / query 中执行。

### 7.2 Actor

```ts
type UserActor = {
  kind: "user";
  userId: string;
  organizationId: string;
  role: "ADMIN" | "MANAGER" | "TECHNICIAN";
};

type InstrumentActor = {
  kind: "instrument";
  instrumentId: string;
  organizationId: string;
};

type Actor = UserActor | InstrumentActor;
```

### 7.3 Policy 与 scope

纯 policy 示例：

```ts
canEditExperiment(actor, resource): boolean
canCaptureRun(actor, resource): boolean
canManageLibrary(actor, stewardship): boolean
canExportData(actor, request): boolean
```

查询 scope 示例：

```ts
experimentScope(actor): Prisma.ExperimentWhereInput
materialScope(actor): Prisma.MaterialWhereInput
ingestScope(actor): Prisma.IngestItemWhereInput
```

scope 必须进入数据库查询，而不是先全量读取再在 JavaScript 过滤。

### 7.4 迁移方法

1. 先用测试固定当前允许 / 拒绝行为；
2. 把纯角色规则抽到 `policies.ts`；
3. 把组织和成员查询条件抽到 `scopes.ts`；
4. 页面、Action、Route 改为调用 service；
5. 删除重复判断；
6. 每删除一处旧判断，运行权限矩阵和跨组织集成测试。

---

## 8. 领域服务与传输层

### 8.1 Server Action 目标形态

```ts
"use server";

export async function updateExperiment(input: unknown) {
  const actor = await requireUserActor();
  const command = UpdateExperimentSchema.parse(input);

  await experimentService.update({ actor, command });

  revalidatePath(`/experiments/${command.id}`);
}
```

Action 只负责：

- 取得 actor；
- 解析输入；
- 调用 service；
- 映射可公开错误；
- `revalidatePath` / `redirect`。

Action 不负责：

- 直接拼跨实体事务；
- 自己实现组织隔离；
- 重复状态转换规则；
- 文件存储细节；
- 审计 payload 组装细节。

### 8.2 Route Handler 目标形态

```ts
export async function POST(request: Request) {
  const actor = await requireInstrumentActor(request);
  const upload = await parseInstrumentUpload(request);
  const result = await instrumentIngestService.ingest({ actor, upload });
  return Response.json(result);
}
```

Route Handler 与 Server Action 可以使用不同认证，但最终调用同一领域 service。

### 8.3 Prisma client 传递

需要事务的 service 接受 Prisma transaction client：

```ts
await db.$transaction(async (tx) => {
  await updateExperiment(tx, ...);
  await audit.record(tx, ...);
});
```

不要求所有简单查询都增加 repository 抽象；只有需要替换基础设施、复用复杂查询或事务边界时才抽。

### 8.4 领域迁移顺序

推荐按风险和依赖排序：

1. `authorization`；
2. `instruments` parser / serial / match；
3. `ingest` 和 instrument upload；
4. `experiments`；
5. `runs` / capture；
6. `workflow`；
7. `materials` / library / stewardship；
8. `exports` / insights；
9. organization / registration / profile；
10. AI provider 与辅助模块。

每个领域独立完成“测试 → schema → service → Action / Route 变薄 → 审计”，不做一次性大搬迁。

---

## 9. 审计日志

### 9.1 数据模型建议

```prisma
model AuditEvent {
  id             String       @id @default(cuid())
  organizationId String
  actorType      String       // USER | INSTRUMENT | SYSTEM
  actorUserId    String?
  instrumentId   String?
  action         String       // experiment.update, ingest.publish ...
  entityType     String
  entityId       String
  changes        Json?
  metadata       Json?
  requestId      String?
  createdAt      DateTime     @default(now())

  @@index([organizationId, createdAt])
  @@index([entityType, entityId, createdAt])
  @@index([actorUserId, createdAt])
}
```

最终关系字段和删除策略在实现设计中确定。审计事件本身不跟随业务实体级联删除。

### 9.2 首批审计事件

- 实验创建、复制、归档、删除、状态变化；
- 实验标题、科学方法字段、步骤、参数和变化组修改；
- 样品集合、sample code 和 instrument alias 修改；
- 成员、负责人、提交、批准、驳回；
- run 创建、清空、capture 批量保存；
- measurement 自动匹配、手动分配、解除分配、rematch；
- ingest stage、修改、发布、拒绝；
- 材料、设备、环境和 recipe 修改；
- 数据导出申请、批准和下载；
- 用户角色、启停、stewardship 和组织配置变化。

### 9.3 数据原则

- append-only；普通应用角色没有 UPDATE / DELETE 权限；
- 不记录密码、OTP、API key、完整 session、SMTP 或 AI secret；
- 大型文件内容不进入 changes，只记录 hash、object key、大小和关联；
- 批量 capture / ingest 使用摘要事件，必要时带受控 changes；
- 审计日志不是备份，也不是实验结果版本库；两者职责不同。

---

## 10. 文件与 COS

COS 是对象存储，不是向量存储。PostgreSQL 保存结构化事实和解析后的 J-V 曲线；COS / 本地 adapter 保存原始字节。

| 数据 | 事实来源 | 第一里程碑 | 第二里程碑 |
| --- | --- | --- | --- |
| 实验、样品、权限、解析指标 / 曲线 | PostgreSQL | PostgreSQL | PostgreSQL |
| 附件和仪器原始文件 | object storage | `/var/lib/pheno-lab/uploads` | COS files bucket |
| `pheno-data/` 历史科研原件 | archive | 原位置只读保留 | 独立 archive bucket |
| 数据库备份 | backup | 独立备份目录 / 现有方案 | 独立 backup bucket |
| 向量索引 | 派生数据 | 不启用 | 触发条件满足后再接入 |

### 10.1 当前问题

当前普通图片和仪器文件都使用：

```ts
path.join(process.cwd(), "uploads")
```

这会导致：

- release 切换后工作目录改变；
- 多实例无法共享文件；
- CVM 损坏时文件依赖本机备份；
- 应用进程拥有 release 目录写权限；
- 当前 `backup.sh` 只备份 PostgreSQL，不构成文件恢复方案。

### 10.2 Storage interface

```ts
export interface ObjectStorage {
  put(input: {
    key: string;
    body: Uint8Array | ReadableStream;
    contentType: string;
    sha256?: string;
  }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

实现：

- `LocalObjectStorage`：开发 / 测试和第一里程碑部署；固定 `UPLOAD_DIR`，不得位于 release；
- `CosObjectStorage`：生产；私有桶；同地域内网 endpoint。

对象写入与 PostgreSQL 事务无法原子提交，因此 adapter 调用方必须使用确定性 key / request id 实现幂等。
COS / 本地写入成功但 DB 提交失败时，重试应复用同一 key；定时一致性检查只清理超过保留期且没有 DB 引用的孤立对象。
业务删除先删引用 / 标记待删除，再由受控清理任务删除对象，禁止在普通级联删除中即时永久销毁科研原件。

### 10.3 Object key

建议格式：

```text
organizations/{orgId}/images/{yyyy}/{mm}/{uuid}.{ext}
organizations/{orgId}/feedback/{yyyy}/{mm}/{uuid}.{ext}
organizations/{orgId}/instruments/{instrumentId}/{yyyy}/{mm}/{sha256}.{ext}
organizations/{orgId}/executions/{runId}/{uuid}.{ext}
```

key 不含用户原始文件名、邮箱或可识别个人信息。原始文件名作为受控元数据保存。

### 10.4 下载路径

第一阶段：

```text
Browser → Next Route → session / org / resource auth → COS GetObject → stream
```

不直接公开 bucket，不在浏览器中持有长期 COS key。等流量成本显现后，再改为短期预签名 URL。

### 10.5 存量文件迁移

迁移必须明确在线写路径，顺序为：

1. 追加兼容字段（例如 `storageProvider` / `objectKey`），旧 `storedPath` 暂时保留；
2. 部署 Storage Adapter 和双读：先读 COS，miss 时回落旧本地目录；
3. 将**所有新上传只写 COS**，不用长期双写制造两份事实来源；
4. 记录迁移开始水位并只读扫描现有 `uploads/`；
5. 计算 SHA-256，使用确定性 object key 上传 COS；
6. `HEAD` 并抽样下载验证大小与 hash；
7. 在事务中更新数据库 object key 并记录迁移结果；
8. 再次扫描开始水位后的变化和断链引用，直到两轮无遗漏；
9. 验证生产授权下载和仪器重放后关闭本地回落；
10. 保留原目录只读副本至少一个完整备份周期，再由人工批准清理。

不允许边上传边删除原文件。

### 10.6 COS 权限

- bucket 默认私有；
- 应用使用 CAM 子用户 / 角色，不使用主账号；
- 只授权目标 bucket 和 prefix 的 Get / Put / Delete；
- 管理操作、改 bucket policy、列举全账号 bucket 不授予应用；
- 开启版本控制；原始科研文件是否启用对象锁由数据保留政策确认；
- COS 与 CVM 同地域，使用内网解析；
- 删除行为先进入业务软删除 / 审批，再执行对象删除。

应用只配置 files bucket。research archive 和 database backup 使用不同运维身份，应用 service account 不得读取或删除。

---

## 11. 数据库与向量存储

### 11.1 PostgreSQL

推荐腾讯云托管 PostgreSQL，同地域、同 VPC、内网连接。若继续使用独立 Ubuntu 自建 PostgreSQL，
本方案应用层不变，但数据库运维责任由团队承担。

连接原则：

- PostgreSQL 5432 不开放公网；
- 安全组只允许应用 CVM；
- production 使用独立数据库用户；
- 应用连接数预算按实例数 × Prisma pool 计算；
- 暂不引入 PgBouncer，连接数或突发并发出现证据后再评估；
- migration 使用受控 deploy 身份，不在 systemd 每次启动时自动执行；
- production 只使用 `prisma migrate deploy`。

### 11.2 备份

上线前先由数据所有者确定 RPO / RTO；文档不得用“有备份”替代可量化的恢复目标。

托管 PostgreSQL：

- 开启自动全量备份；
- 开启并保留 WAL / 日志备份以支持 PITR；
- 保留周期按科研数据政策设置；
- 每季度执行一次恢复演练。

自建 PostgreSQL：

- base backup + WAL 连续归档到 COS；
- 每日逻辑 `pg_dump` 作为额外便携备份，不是唯一备份；
- 监控 WAL 归档失败、磁盘、连接数、复制 / 备份延迟；
- 在隔离环境验证恢复，不能只看备份命令退出码。

完整恢复演练必须同时验证：

```text
release artifact + 配置 + PostgreSQL + object storage + DB objectKey / 对象一致性
```

COS 版本控制提高误删恢复能力，但不自动等于完整备份。历史科研档案、活跃文件和数据库备份使用独立权限与保留策略。
Bridge 数据库只保存 API key hash；仪器电脑丢失时无法取回原 key，因此运维手册必须包含吊销旧 key、重新注册和验证重传。

### 11.3 向量存储

当前向量能力不是 Pheno Lab 核心事实来源。推荐顺序：

1. 数据量较小时使用 PostgreSQL + pgvector；
2. 只有压测证明对主库有明显影响，才使用独立向量服务器；
3. 独立向量服务器只保存可重建索引；
4. source document、chunk metadata、embedding model、版本和权限归属仍在 PostgreSQL / COS；
5. 独立向量端口只允许应用 CVM 内网访问；
6. 快照写 COS，并定期验证重建。

如果现有“向量存储服务器”已经确定，需在接入任务中补充产品、版本、端口、备份和恢复手册；
本次模块化重构只定义 `VectorStore` adapter，不把具体 SDK 渗透到领域服务。

---

## 12. 腾讯云部署

### 12.1 生产拓扑

```text
VPC
├─ App Subnet
│  └─ Ubuntu CVM
│     ├─ nginx.service          :443
│     └─ pheno-lab.service      127.0.0.1:3457
├─ Data Subnet
│  ├─ PostgreSQL               :5432
│  └─ Vector Store（可选）      :产品端口
└─ COS 私有桶                  同地域内网访问
```

初期一台应用 CVM 即可。若需公网访问，推荐 CLB / WAF 在前；若只在企业 VPN / 专线内访问，Nginx 仍负责 TLS。

应用运行时统一使用 Node.js 24 LTS，并在 `package.json`、`.node-version` 与部署镜像 / CVM 中固定同一大版本；
pnpm 使用仓库声明的精确版本。systemd 不通过 nvm 或交互 shell 查找 Node。

### 12.2 Linux 目录

统一采用 `/srv`，与 Pheno Talent 的服务器约定一致：

```text
/srv/pheno-lab/
├─ releases/
│  ├─ 20260824-001/
│  └─ 20260825-001/
└─ current -> releases/20260825-001

/etc/pheno-lab/
└─ pheno-lab.env

/var/lib/pheno-lab/
├─ uploads/                     # 仅 COS 切换前过渡使用
└─ runtime/
```

权限：

| 路径 | Owner | 权限 / 原则 |
| --- | --- | --- |
| `/srv/pheno-lab/releases` | `root:pheno` | 运行用户只读 |
| `/srv/pheno-lab/current` | root 管理软链接 | 发布脚本切换 |
| `/etc/pheno-lab/pheno-lab.env` | `root:pheno` | `0640` |
| `/var/lib/pheno-lab` | `pheno:pheno` | 运行用户可写 |

### 12.3 systemd

```ini
# /etc/systemd/system/pheno-lab.service
[Unit]
Description=Pheno Lab Data Platform
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pheno
Group=pheno
WorkingDirectory=/srv/pheno-lab/current/pheno-lab

Environment=NODE_ENV=production
EnvironmentFile=/etc/pheno-lab/pheno-lab.env

ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3457

Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

StandardOutput=journal
StandardError=journal
SyslogIdentifier=pheno-lab

[Install]
WantedBy=multi-user.target
```

说明：

- 使用绝对 Node 路径，不依赖交互 shell、nvm 或用户 profile；
- Next 只监听 loopback，不对公网暴露 3457；
- production secret 不写入 Git 和 release；
- 允许 SIGTERM + 30 秒完成在途请求；
- `Restart=on-failure` 处理进程崩溃，不掩盖配置错误；
- 数据库迁移不放在 `ExecStartPre`，避免每次重启都修改 schema。

### 12.4 Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name lab.example.com;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3457;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        proxy_buffering off;
    }
}
```

补充：

- TLS 证书由 CLB 或 Nginx 承担；
- `client_max_body_size` 必须与应用级限制配套，不能替代文件类型 / 内容校验；
- `/api/ingest/*` 可单独设置速率、超时和固定仪器网段规则；
- 不在 Nginx 信任来自公网的身份头；真实用户身份由应用 session 判定；
- 登录、动态 HTML、文件下载不得被公共 CDN 缓存。

### 12.5 安全组

| 目标 | 端口 | 来源 |
| --- | ---: | --- |
| Nginx / CLB | 443 | 企业出口、VPN 或公网策略 |
| SSH | 22 | 堡垒机 / 固定运维 IP |
| Next.js | 3457 | 不开放；仅本机 loopback |
| PostgreSQL | 5432 | App CVM 安全组 |
| Vector Store | 产品端口 | App CVM 安全组 |

默认拒绝其他入站。数据库和向量服务器不配置公网访问。

### 12.6 健康检查

新增：

- `/api/health/live`：进程可以响应，不访问外部依赖；
- `/api/health/ready`：短超时检查 PostgreSQL；返回 COS / vector 状态但区分是否为关键依赖；
- 响应包含 service、timestamp、requestId，不包含 URL、secret 或内部错误堆栈。

访问约束：

- `/live` 可供 Nginx / CLB 探针访问，但设置速率限制；
- `/ready` 只允许 loopback、VPC / CLB 探针网段或专用健康检查令牌；
- COS 状态使用短期缓存的 `HEAD` / 配置状态，不在每次探测时上传或下载对象；
- 第一里程碑 `STORAGE_DRIVER=local` 时，readiness 检查目录可写性和剩余空间；向量服务不参与 readiness。

部署脚本在 restart 后轮询 readiness；失败则保留旧 release 并告警。

### 12.7 发布流程

```text
CI：format / lint / typecheck / test / build
→ 生成不可变 release artifact
→ 上传到 /srv/pheno-lab/releases/<release-id>
→ 校验环境与数据库连接
→ 受控执行 prisma migrate deploy
→ 切换 /srv/pheno-lab/current 软链接
→ systemctl restart pheno-lab
→ 轮询 /api/health/ready
→ 执行最小 smoke test
```

readiness / smoke 失败时必须执行真正的代码回滚：

```text
current 重新指向 previous release
→ restart 旧 release
→ 验证旧版本 readiness
→ 告警并停止发布
```

禁止在当前运行目录直接 `git pull` 后覆盖文件。

第一阶段 release artifact 包含 `.next/`、`public/`、生产运行所需的 `node_modules/`、Prisma Client / engine、
`prisma/migrations/`、`package.json` 和 lockfile。构建环境必须与生产 Linux 架构一致，避免 Prisma engine 或原生依赖不匹配。

等普通部署稳定后，可单独评估 Next.js `output: "standalone"` 以缩小 artifact；启用前必须验证 Prisma、`public/`、
`.next/static/`、图片优化和 migration 文件都被正确包含。本次不把 standalone 当成上线前置条件。

数据库迁移遵循 expand / contract：

1. 添加新字段 / 表，保持旧应用兼容；
2. 发布同时兼容新旧结构的应用；
3. 回填；
4. 后续版本删除旧字段。

因为数据库迁移发生在代码切换前，而且失败时会回滚到 N-1 release，同一次发布中的 migration 必须兼容 N-1 代码。
删除 / 政名字段、增加无法回填的非空约束等 contract 操作必须进入后续独立发布，并在确认不再需要代码回滚后人工批准。

应用回滚通过切换 `current` 软链接完成。已执行的数据库迁移通常用向前修复，不把自动 downgrade 作为常规回滚手段。

### 12.8 单实例与高可用

第一阶段允许 systemd restart 带来数秒维护窗口。要零停机时：

1. COS 已成为唯一文件存储；
2. session 保持无状态；
3. Next.js deployment ID、Server Action encryption key 和缓存策略固定；
4. `revalidatePath` / tag 在多实例间有协调机制；
5. CLB readiness 和连接 drain 已验证；
6. 再增加第二台 App CVM。

这些条件完成前，不使用两个独立 Next 实例轮流提供可能不一致的缓存。

### 12.9 日志与监控

最小可用：

- 应用 JSON 结构化日志写 stdout / stderr，由 journald 收集；
- journald 接入腾讯云 CLS；
- 每个请求生成或透传 request ID；
- Nginx access / error log；
- CVM CPU、内存、磁盘和进程告警；
- PostgreSQL 连接数、磁盘、慢查询和备份告警；
- COS 请求错误；
- instrument heartbeat 过期；
- unmatched ingest 数量和 rematch 失败；
- 最近一次可恢复备份时间。

日志不得记录 session cookie、API key、OTP、数据库 URL、完整文件内容和 AI secret。
Heartbeat 属于高频运行遥测，只更新仪器当前状态并进入监控，不为每次心跳追加不可变 AuditEvent；注册、上传、匹配、
rematch、发布和人工变更仍进入事务审计。

---

## 13. 本地开发与测试环境

推荐本地 Compose 只运行基础设施，应用进程继续在宿主机运行：

```yaml
services:
  postgres:
    image: postgres:18-alpine
    ports:
      - "127.0.0.1:55432:5432"
    environment:
      POSTGRES_DB: pheno_lab
      POSTGRES_USER: pheno
      POSTGRES_PASSWORD: local_only

  postgres-test:
    image: postgres:18-alpine
    ports:
      - "127.0.0.1:55433:5432"
    environment:
      POSTGRES_DB: pheno_lab_test
      POSTGRES_USER: pheno
      POSTGRES_PASSWORD: test_only
```

文件开发模式使用 `/tmp` 或仓库外固定目录；COS 集成测试使用独立 test bucket / prefix，默认单元测试不触达生产 COS。

每个 worktree 使用独立端口、数据库 / schema 和上传目录，避免并行任务互相污染。

---

## 14. 实施计划

估算以一名熟悉现代码的工程师为参考，不是交付承诺。每个阶段必须独立可验证、可提交、可回退。

| # | 阶段 | 内容 | 验收 | 初步人日 |
| --- | --- | --- | --- | ---: |
| 00 | 决策与数据基线 | 本文档、只读数据盘点模板、范围和不变量 | 文档批准；生产迁移门槛明确 | 1–2 |
| 01 | 配置基础 | server config、Zod fail-fast、env example | 配置测试通过 | 0.5–1.5 |
| 02 | 测试与 CI | Vitest、真测试库保护、Playwright 基建、CI、`verify` | DB guard、登录 smoke、CI 通过 | 3–5 |
| 03 | 仪器安全网 | 4 个 fixture、serial、match、dedupe、rematch | parser / ingest 测试通过 | 2–3 |
| 04 | Authorization | actor、policy、scope、权限矩阵 | 跨组织集成测试通过 | 3–5 |
| 05 | 审计基础 | AuditEvent migration、writer、查询 | 事务一致性测试通过 | 2–3 |
| 06 | Ingest / instruments | Action / Route 变薄、Zod、审计、契约 | Bridge 兼容测试通过 | 3–5 |
| 06R | 重估门 | 按首个完整领域闭环重估 07–10；确认生产数据盘点 | 文档、范围和工期更新 | 0.5–1 |
| 07 | Experiments / runs | service 抽取、事务、审计 | 核心实验 E2E 通过 | 5–8 |
| 08 | 其他领域 | materials、workflow、org、export 等 | 分域测试通过 | 5–10 |
| 09A | 存储抽象 | Local / COS adapter、外置本地目录、授权下载 | 本地模式恢复和部署验证 | 2–4 |
| 09B | COS 新写路径 | 新上传切 COS、双读、幂等与孤立对象策略 | 新写 / 下载 / 重试通过 | 2–4 |
| 09C | 存量迁移 | `uploads/` 迁移；`pheno-data/` 独立档案任务 | hash、一致性和恢复演练 | 数据盘点后估算 |
| 10 | 腾讯云部署 | Nginx、systemd、release、health、监控 | 部署 / 真实回滚演练 | 3–5 |

旧版 `23–44` 与逐项求和不一致，已废弃。09C 必须按实际文件数量、体积、网络和停机要求估算，不能在盘点前伪精确。

仓库内的 **00–08、09A、09B 代码部分和 10 的部署制品**已经完成。默认首次启动仍使用
`/var/lib/pheno-lab/uploads`；COS adapter 可在云资源就绪后通过配置启用。

剩余工作均属于受控部署 / 数据操作：腾讯云 CVM、PostgreSQL、COS bucket 和 CAM 实例角色的实际创建，生产 secret，
真实数据库导入与恢复演练，09C 存量对象迁移，systemd / Nginx 安装，CLS / 告警接入，以及真实 release / rollback 演练。
这些步骤需要生产资源和数据所有者批准，不在仓库内模拟执行。

### 14.1 每阶段门槛

每个阶段必须：

- 不改变未声明的产品行为；
- 相关测试通过；
- 不扩大未测试的权限表面积；
- migration 经人工审查；
- 更新本文档的实施状态；
- 记录回滚方式；
- 不自动 commit、push 或部署。

---

## 15. 风险与缓解

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 零测试起步 | 不是“补测试”，而是从零建立框架、fixture 和数据工厂 | 先测高风险路径，不追求覆盖率数字 |
| 权限行为漂移 | 权限错误可能静默泄露跨组织数据 | characterization test + 真 DB + policy / scope 分层 |
| 重构范围膨胀 | 容易同时拆目录、UI、API 和 ORM | 严格遵守 §2 非目标；按领域小步迁移 |
| 审计数据泄露 | changes 可能包含 secret / 敏感数据 | allowlist 字段、摘要、审计 payload 测试 |
| COS 迁移丢文件 | DB key 与对象上传不同步 | hash 验证、双读过渡、原目录保留、迁移审计 |
| 单点故障 | 一台 App CVM 重启时服务不可用 | 内部系统接受短窗口；架构为后续双实例留条件 |
| 数据库误操作 | 测试或 migration 误连生产 | `_test` 硬保护、分离凭据、受控 deploy |
| Bridge 兼容性 | 服务端响应改变会让实验室 Agent 重试或丢数据 | 契约测试、保持旧 URL、服务端向后兼容 |
| Next 多实例缓存 | 过早扩容导致页面或 Action 缓存不一致 | 第一阶段单实例；扩容前完成缓存协调 |
| 自建 PostgreSQL 运维 | 备份存在但无法恢复 | WAL + base backup + 定期恢复演练；优先托管库 |

---

## 16. 明确范围外与后续触发条件

### 后续按触发条件评估

| 能力 | 触发条件 |
| --- | --- |
| 独立 Hono API | 原生 App、合作方 API、第二 Web、独立团队或扩容需求 |
| Vite SPA | Web 已完全 API 化且 Next 服务端能力不再使用 |
| Drizzle | Prisma migration / SQL 控制或性能成为有证据的问题 |
| 独立向量数据库 | pgvector 压测不满足延迟 / 吞吐，或主库受明显影响 |
| Redis / 队列 | 出现可靠后台任务、跨进程协调或缓存需求 |
| 双 App 实例 | 业务要求高可用，且缓存协调完成 |
| Docker / Kubernetes | 多服务、资源隔离、标准化调度产生实际收益 |
| 大组件主动拆分 | 对应功能要改，且已有 E2E / 行为测试保护 |

### 本次不承诺

- 新功能开发；
- 视觉重做；
- 历史科研数据清洗；
- 自动 AI 功能扩展；
- 合规认证或法律意义上的不可篡改存证；
- 跨地域双活。

---

## 附录 A · 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | 是 | production / development / test |
| `DATABASE_URL` | 是 | PostgreSQL VPC 内网连接串 |
| `TEST_DATABASE_URL` | test | 必须指向 `_test` 数据库 |
| `SESSION_SECRET` | 是 | 至少 32 字节，禁止示例值 |
| `INGEST_CRON_SECRET` | 按功能 | rematch cron 认证 |
| `STORAGE_DRIVER` | 是 | local / cos |
| `UPLOAD_DIR` | local | 仓库外绝对路径 |
| `COS_REGION` | cos | 例如 ap-guangzhou |
| `COS_FILES_BUCKET` | cos | 应用活跃文件私有 bucket；不包含 archive / backup |
| `COS_AUTH_MODE` | cos | `instance-role` / `static`；生产优先 instance role |
| `COS_SECRET_ID` | static | 仅静态凭据模式；不得写入 release |
| `COS_SECRET_KEY` | static | 同上 |
| `COS_LEGACY_UPLOAD_DIR` | 迁移期可选 | COS 为主写路径时的旧本地只读回落目录；验证后删除配置 |
| `VECTOR_DATABASE_URL` | 可选 | 独立向量服务时使用 |
| `SMTP_HOST` / `SMTP_PORT` | 可选组 | 必须成组配置 |
| `SMTP_USER` / `SMTP_PASS` | 可选组 | 必须成组配置 |
| `SMTP_FROM` | 可选 | 默认 SMTP_USER |

AI provider 的用户配置当前存数据库，实施 config 重构时需明确哪些 provider secret 属于系统 env、哪些属于组织级加密配置，
不得把密钥明文写入 AuditEvent。

---

## 附录 B · 生产检查清单

### 应用

- [ ] `pnpm run verify` 通过
- [ ] production build 通过
- [ ] `/api/health/live` 与 `/api/health/ready` 正常
- [ ] systemd 以非 root 用户运行
- [ ] Node 只监听 127.0.0.1
- [ ] SIGTERM 可在 30 秒内优雅退出
- [ ] journald / CLS 可按 requestId 查询

### 数据库

- [ ] 只允许 VPC 内网连接
- [ ] App 与 migration 身份权限最小化
- [ ] pending migration 已人工审查
- [ ] 自动全量和 WAL / 日志备份开启
- [ ] 最近一次恢复演练有记录

### COS

- [ ] bucket 私有
- [ ] CAM 最小权限
- [ ] 同地域内网访问
- [ ] 版本控制开启
- [ ] object key 不含 PII / secret
- [ ] 上传、下载、删除与审计测试通过
- [ ] 存量文件 hash 校验完成
- [ ] 应用身份不能访问 research archive / database backup
- [ ] COS 未启用时，`UPLOAD_DIR=/var/lib/pheno-lab/uploads` 位于 release 外并已备份

### 网络与安全

- [ ] 443 暴露范围符合企业策略
- [ ] 22 只允许堡垒机 / 固定运维地址
- [ ] PostgreSQL / vector 无公网入口
- [ ] 配置缺失会启动失败
- [ ] 默认账号密码已更换
- [ ] Nginx 和应用上传大小一致
- [ ] Go Bridge API key 可轮换

### 回滚

- [ ] 上一个 release 仍保留
- [ ] current 软链接切换脚本已演练
- [ ] migration 为向后兼容或有明确向前修复方案
- [ ] COS 迁移保留本地只读副本
- [ ] readiness 失败会自动切回 previous 并重启旧 release

### 数据恢复

- [ ] 数据所有者批准 RPO / RTO
- [ ] PostgreSQL 恢复已在隔离环境演练
- [ ] objectKey 与本地 / COS 对象一致性检查通过
- [ ] Bridge 吊销旧 key、重新注册和测试上传手册已演练

---

## 附录 C · 参考资料

- Next.js Self-Hosting：<https://nextjs.org/docs/app/guides/self-hosting>
- Next.js Deployment：<https://nextjs.org/docs/app/guides/deploying-to-platforms>
- Prisma production migrations：<https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production>
- PostgreSQL PITR：<https://www.postgresql.org/docs/current/continuous-archiving.html>
- 腾讯云 COS 内网域名：<https://cloud.tencent.com/document/product/436/56556>
- 腾讯云 COS 最小权限：<https://cloud.tencent.com/document/product/436/38618>
- 腾讯云 CVM 安全最佳实践：<https://cloud.tencent.com/document/product/213/5421>
- 腾讯云 PostgreSQL 备份：<https://cloud.tencent.com/document/product/409/33945>
- pgvector：<https://github.com/pgvector/pgvector>

---

*本文档随实施推进更新。架构决策变化请在 §4 追加新的 Decision Record，而不是静默改写历史决定。*
