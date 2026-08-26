# Pheno Lab 生产数据导入规范

本文规定如何把同事手头的 PostgreSQL 数据、表格、仪器文件、图片、附件和历史资料安全导入
Pheno Lab。适用架构是当前已上线的：

```text
数据所有者 / 原始系统
        │
        ├─ 结构化记录 ─> 受控 importer ─> PostgreSQL 服务器 / pheno_lab
        │                                      │
        └─ 文件二进制 ─> storage adapter ─> 私有 COS
                                               │
                              PostgreSQL 只保存 object key / metadata

App CVM：运行 importer、连接私网 PostgreSQL、通过 CVM instance role 访问 COS
App release/source：不保存导入原件、附件、dump 或长期 staging 数据
```

数据导入是独立的生产数据变更，不是普通代码发布，也不是“把文件复制到服务器”。任何生产批次都
必须先获得 Louis 和数据所有者批准，并遵守根
[`AGENTS.md`](../AGENTS.md)、[开发规范](development-standards.md)与
[部署手册](../pheno-lab/deploy/README.md)。

最后核对：2026-08-26。

## 1. 数据应该进入哪里

| 数据类型                                                         | 正确目标                                                                | 禁止做法                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 组织、用户、实验、样品、流程、执行、测量、材料、设备等结构化数据 | PostgreSQL `pheno_lab`，按现有 Prisma schema 和 organization scope 写入 | 把表格/JSON 放在 release 里当数据库；直接覆盖生产表                          |
| 图片、附件、仪器原始 CSV、仪器配套图片                           | 私有 COS；数据库保存 object key、MIME、size、hash 和业务关联            | 写 App CVM uploads 目录、数据库 bytea、Git 或 public 目录                    |
| 仪器持续产生的新文件                                             | 现有 Go Bridge → `/api/ingest/*`                                        | 人工 SQL 插入 `InstrumentUpload`/`JvMeasurement`，绕过 parser、dedupe 和审计 |
| 材料/设备/配方等待人工确认的资料抽取结果                         | `/ingest` quality gate，经理/管理员复核后发布                           | agent 把低置信度抽取直接写正式 library                                       |
| PostgreSQL dump                                                  | 独立数据库服务器的备份/隔离恢复环境                                     | restore 到现有 `pheno_lab`；把 dump 放 App CVM source/release                |
| 仅作留档、暂不进入业务模型的原始资料                             | Louis 批准的 archive 权限域/独立前缀或 bucket                           | 混进 active files 前缀，或假装成 Attachment 建无业务归属记录                 |
| 向量/embedding                                                   | 当前不导入；以后从事实数据重新计算                                      | 把向量当原始数据或写 COS 后宣称搜索可用                                      |
| 密码、OTP、Session、API key、AI/CAM 凭据                         | 默认不迁移；重新签发/重置                                               | 从旧库复制明文密码、OTP、Session、Bridge key 或云密钥                        |

COS 是对象存储，不是向量数据库，也不是 PostgreSQL 备份的默认目的地。active files、archive 和
backup 是不同权限域；是否新增 archive/backup bucket 必须由 Louis 决定，agent 不得自行创建。

## 2. 导入方式优先级

优先使用最高层、已有权限和校验的入口：

1. 少量日常业务数据：通过现有 UI/Server Action 创建。
2. 仪器原始文件：通过已注册 Go Bridge 和现有 ingest API。
3. 材料、设备、配方和历史文档抽取：进入 `IngestItem`，由人在 `/ingest` 复核发布。
4. 旧本地附件且数据库字段仍是 legacy bare filename：仅在完全匹配适用条件时使用现有
   `scripts/migrate-uploads-to-cos.ts`。
5. 大量关系型历史数据或不同 schema 的数据库：为该数据集设计、测试并审查专用 importer。

不得为了快而降级到 raw SQL、`createMany({ skipDuplicates: true })`、直接 COS 控制台上传或
`pg_restore` 覆盖生产库。越过业务入口必须有明确理由、映射方案和额外验收。

## 3. 生产导入的绝对前置门槛

以下任一项未完成时，只能盘点、开发 importer 和在隔离环境演练，不能 `--apply` 到生产：

- [ ] Louis 明确批准数据集、目标组织、范围、导入负责人和执行窗口；
- [ ] 数据所有者完成 [`data-inventory-template.md`](data-inventory-template.md)，区分 production、
      demo、test、archive 和重复数据；
- [ ] 原始数据有不可变副本，数据库和文件分别生成数量、大小和 SHA-256 基线；
- [ ] 当前生产 PostgreSQL 已成功备份，并真实恢复到隔离数据库完成校验；
- [ ] COS 版本控制/保留策略已由 Louis 决定；如未开启，导入必须保证只写全新 content-addressed
      key，绝不覆盖现有对象，并具备独立源副本；
- [ ] source schema → Prisma schema 的字段、枚举、单位、时区、ID、外键和去重映射已书面审查；
- [ ] importer 在独立 `_test`/staging PostgreSQL 和非生产 COS prefix/bucket 完整演练；
- [ ] 同一份输入连续执行两次，第二次不新增重复记录、不覆盖人工修改，证明幂等；
- [ ] dry run 输出的计划数量、拒绝数量、冲突和未知映射均由数据所有者确认；
- [ ] 回滚能精确识别该批次创建/修改的数据库记录和 COS 对象，不依赖“按时间大概删除”；
- [ ] 生产期间是否需要停写、只读或低流量窗口已经明确；
- [ ] 验收查询、文件 hash 校验、浏览器抽检、readiness 和签字负责人已确定。

“备份文件存在”不等于可恢复；必须有本次导入前的恢复证据。当前生产部署日志中数据库备份恢复
和 COS 版本控制仍列为待办，因此大量不可替代数据导入前要优先补齐这些保护。

## 4. 只读盘点和导入清单

### 4.1 PostgreSQL/结构化数据

只读收集：

- source PostgreSQL 版本、schema/migration 版本和数据库大小；
- 每张相关表的行数、主键、unique constraint、外键、最早/最新时间；
- organization、user、experiment、sample、run、measurement 之间的关系；
- null、非法枚举、孤儿外键、重复自然键和跨组织引用数量；
- 日期时区、数值单位、小数精度、JSON shape 和编码；
- 用户/仪器 credential、OTP、Session、AI key 等必须排除或重签的数据；
- 哪些记录已经存在于目标库，以及“相同”的业务判定标准。

不要把真实邮箱、password hash、连接串或实验正文复制进 Git 文档。仓库只保存字段映射、统计、
决策和脱敏样例；原始 manifest 放在 Louis 批准的受控位置。

### 4.2 文件数据

为每个文件记录：

```text
source-relative-path
size
SHA-256
detected MIME / extension
modified timestamp + source timezone
目标 organization
目标业务实体/记录
计划 COS object key
是否唯一原件
```

同时统计：空文件、同 hash 多文件、同名不同 hash、数据库引用但文件缺失、文件存在但无业务引用、
不支持的类型、超限大小和疑似敏感内容。文件名可能包含人员姓名、样品编号或商业信息，不应直接
拼进公开 URL 或无保护日志。

### 4.3 批次身份

每次导入必须有不可复用的 `batchId`，例如 `legacy-20260826-001`。同一个 batchId 贯穿：

- 批准记录、source manifest 和 mapping 版本；
- dry run/apply 输出；
- `AuditEvent.metadata` 中的脱敏批次标识；
- reconciliation 报告；
- 回滚清单和最终验收。

当前 schema 没有通用 `ImportBatch` 表。如果导入规模需要持久化 source ID → target ID 映射或状态，
必须先提出并测试 additive schema 设计，取得 Louis 批准；不要把唯一映射只放在 App CVM 临时文件
或 agent 对话里。

## 5. 字段映射和合并规则

### 5.1 Organization 是第一边界

- 每条记录和每个 COS key 在导入前必须确定唯一目标 organization。
- 不接受“没有组织，先导入再补”；不使用客户端提交的 organization 作为可信事实。
- 跨组织重复名称不能合并；按名称查找时必须同时带 `organizationId`。
- 发现一条记录引用另一组织的 user/process/equipment/material/experiment 时停止该记录并报告。

### 5.2 ID、自然键和重复策略

对每个实体书面指定：

- source 主键；
- target ID 是保留、重新生成还是映射；
- 自然键/unique constraint；
- 冲突时是 `reject`、`skip-identical`、`create-new` 还是经人工批准的 `update`；
- 哪些字段绝不由导入覆盖，例如人工复核内容、权限、状态、审计和当前计数器。

默认策略是 `reject conflict`，不是覆盖。只有 byte/field 等价才能 `skip-identical`。使用 upsert 必须
明确 update 分支的每个字段；禁止无提示 `skipDuplicates`，因为它会隐藏不一致数据。

实验 code、shortCode、userNumber、runNo 和各种 counter 不能只按 source 最大值复制。导入后必须在
同一受控事务中校准目标 counter，并验证下一次由应用生成的编号不会碰撞或复用。

### 5.3 用户和凭据

- 默认只映射到已存在的目标用户，或通过正常邀请/重置流程创建用户。
- 不导入明文密码、OTP、Session Cookie、reset token、Bridge API key、AI provider secret 或 CAM
  credential。
- 兼容的 bcrypt hash 是否保留属于安全决策，必须由 Louis 单独批准；无法证明算法/成本兼容时强制
  重置密码。
- 旧仪器必须重新注册/签发 key，数据库只保存新 key 的 hash。

### 5.4 时间、单位和科研语义

- source timezone 必须显式；统一转换到应用预期的 UTC/DateTime，不把无时区字符串猜成本地时间。
- 数值保留 source 原精度和单位；单位转换必须有公式、测试和原值追溯，不能靠 agent 猜测。
- 未知枚举、材料别名、仪器 serial、sample code 和 JSON 字段进入 reject/review，不静默归为 OTHER。
- 原始测量数据和人工录入结果不能互相覆盖；保持 `source`、measuredAt/capturedAt 和 lineage。

## 6. Importer 必须具备的能力

每个专用 importer 都是普通代码变更：进入仓库、接受 review、带测试、通过 CI 后才能在生产使用。
禁止把长 Node/SQL 片段直接粘贴进生产 shell，禁止只存在于个人电脑或 agent 聊天中。

最低要求：

1. 默认 dry run；只有显式 `--apply` 才写入。
2. 明确 `batchId`、目标 organization 和 source manifest hash；生产 apply 时再次确认。
3. 启动时校验数据库名、migration 状态、storage driver、COS bucket/region 和当前 APP_VERSION；
   发现示例值、测试库/生产库混淆或目标不符立即退出。
4. 输入用 Zod/等价 runtime schema 校验；未知字段、非法 enum、孤儿关系进入 reject report。
5. 支持 `--limit`/小批次、断点续跑和确定性顺序；重跑必须幂等。
6. 不把整库放进一个长事务。以一个完整 aggregate 或有界批次事务提交，保证内部外键一致。
7. 使用现有 Prisma/module/storage/audit 能力；不新建 database client、COS client 或第二套 config。
8. 每个成功 aggregate 写 system/user audit，包含 batchId、source record ID/hash 和变更摘要，不包含
   secret 或整份科研内容。
9. 输出 planned/created/skipped/updated/rejected/failed 数量，任何 missing/failed 默认非零退出。
10. 失败可安全重试；不吞掉错误，不以“多数成功”返回 0。
11. 提供只读 reconciliation 和 rollback/detach 方案；rollback 默认 dry run，且不删除审计记录。

如果 importer 需要新 schema、env、临时 CAM、archive bucket、队列或长期 staging 目录，先问 Louis；
不能把这些当成脚本内部实现细节。

## 7. 文件与数据库的提交顺序

包含文件的记录必须使用以下顺序，避免数据库指向不存在的对象：

1. 从只读 source 读取文件，计算 size 和 SHA-256；
2. 用现有 key builder 生成带 organization scope 的确定性 key；
3. 检查目标 key：不存在则上传；存在则完整读取并验证 hash 相同，hash 不同立即冲突退出；
4. 从 COS read-back，比较字节数和 SHA-256；科研原件默认全量校验，不只抽样；
5. 在 PostgreSQL 有界事务中创建/更新业务记录、object key 和 `AuditEvent`；
6. DB 事务失败时，仅补偿删除本批次刚创建且没有其他引用的 COS 对象；不得删除预先存在或被复用
   的 content-addressed 对象；
7. 记录 manifest 状态，允许中断后从确定位置继续。

禁止先写数据库引用、以后再慢慢传文件；禁止同 key 覆盖。对于数据库记录先天存在、只迁移旧本地
文件字段的场景，现有 `migrate-uploads-to-cos.ts` 已实现 upload → read-back/hash → transaction
repoint + audit，仍必须遵守第 10 节限定。

## 8. 隔离演练

### 8.1 数据库

- 把 source dump 恢复到独立 source/staging 数据库，不 restore 到 `pheno_lab`。
- importer 的 target 使用独立 `_test`/staging 数据库，通过现有 test database guard。
- 目标 schema 由当前 migration 从空库建立；不要用 `db push` 伪造目标结构。
- 从生产的脱敏/授权副本演练时，保留 production snapshot 只读，不在副本上修数据后假装 source
  原本正确。

### 8.2 COS

- 单元测试 mock SDK；集成演练使用 Louis 批准的非生产 bucket 或隔离 prefix。
- object key 保持与生产相同结构，但 prefix/bucket 必须清楚表明 test/staging。
- 演练完成生成清单后受控清理；不得让测试代码持有生产 DeleteObject 权限。

### 8.3 必须验证两次

第一次完整 apply 后做 reconciliation；不清库，用完全相同的输入、mapping 和 batch identity 再运行。
第二次预期只出现 `skip-identical`/`reused`，created/updated 必须为 0。否则 importer 不具备生产幂等性。

## 9. 生产执行规则

1. 生产 import 与代码 deploy 分开安排；import 窗口内不同时发布新 release。
2. 开始前记录当前 git commit、APP_VERSION、migration、`current` release、数据库/COS readiness 和
   核心表行数。
3. source 文件只允许放在 Louis 批准的只读临时 staging；不得进入 `/srv/pheno-lab/source`、
   `/srv/pheno-lab/releases`、`/srv/pheno-lab/current` 或 `/var/lib/pheno-lab/uploads`。
4. 如必须经过 App CVM 暂存，先检查磁盘空间，使用权限 0700 的 `mktemp` 临时目录和批准的安全传输；
   路径、容量、owner、保留时间写进执行计划。大量数据优先采用专门批准的流式/云迁移方案。
5. importer 只读取现有 `/etc/pheno-lab/pheno-lab.env`；不得复制、覆盖或新建 env，不输出其中内容。
6. 先 dry run，保存脱敏摘要并由数据所有者复核；再用很小的 `--limit` canary apply。
7. canary 完成数据库、COS、UI、权限和审计验收后，才逐批扩大；每批之间检查 error rate、锁、磁盘、
   DB/COS readiness 和应用日志。
8. 遇到未知映射、hash 冲突、跨组织引用、constraint error、missing 文件或 reconciliation 差异立即
   停止；不要边跑边改生产数据或现场放宽规则。
9. 完成后 source/staging 保持只读至少一个完整备份周期和验收期；只有 Louis 与数据所有者批准后
   才清理，清理前再次核对路径，不能用宽泛 glob/rm。

生产 apply 是外部状态变更，coding agent 不能因“代码已合并”自动执行。Louis 必须明确授权具体
batchId、commit、数据集和窗口。

## 10. 现有脚本的适用边界

### 10.1 `scripts/migrate-uploads-to-cos.ts`

只适用于：

- Equipment.photoPath、Feedback.screenshotPath、InstrumentUpload.storedPath、Attachment.storedPath；
- 数据库仍保存不含 `/` 的 legacy bare filename；
- 文件位于一个已盘点的本地 legacy source 目录；
- 目标是当前私有 COS，且 organization/父级关系可由数据库解析。

它默认 dry run，`--apply` 后会计算 content hash、上传/read-back 校验、事务更新字段并写
`storage.migrated` 审计；source 不删除。它不是任意文件夹上传器，不处理不同 schema 的数据库，
也不能把无业务引用的 archive 批量塞进 COS。

使用前必须审查候选数、missing/failed、目标 key 和源目录；生产 `--apply` 仍需 Louis 针对该批次
批准。source 至少保留一个完整备份周期和生产下载验收期。

### 10.2 `stage-*` / `stage-ingest.js`

这些脚本用于把历史资料抽取结果放进 `IngestItem` quality gate，且部分脚本直接使用 Prisma、默认
组织或内置历史内容。存在于仓库不代表已获生产授权。运行前必须：

- 审查数据来源、目标 organization、Zod/字段 shape、重复语义和审计缺口；
- 先在测试库运行并确认只产生 PENDING ingest items；
- 由管理员/经理在 UI 逐项复核发布；
- 取得 Louis 对具体脚本、commit 和批次的批准。

### 10.3 明确禁止直接用于生产的脚本

`prisma/seed.ts`、`seed-*`、`mock-lab-day.ts`、`backfill-serials.ts`、历史 parser/staging 辅助脚本不
得因为名字带 `seed`、`backfill` 或“幂等”就直接运行生产。它们可能包含 demo 数据、默认 org、
删除逻辑、直接 Prisma 写入或缺少审计/批次追踪。

若某项能力确实需要用于生产，应先把它改造成符合本文第 6 节的受测 importer，作为单独 PR 审查；
不能在生产命令前口头加一句“注意一点”就视为安全。

## 11. 验收与 reconciliation

每个批次完成后至少验证：

- source manifest planned 数 = created + skip-identical + rejected（所有差异可解释）；
- 每类目标表的批次增量、unique/foreign-key/orphan/跨组织检查；
- experiment/sample/run/measurement 等关键 aggregate 的子记录数量和关系；
- counter/序列下一次由应用生成时不碰撞；
- COS 对象数量、总字节、MIME、metadata SHA-256 和 read-back hash；
- 数据库所有 object key 均存在，批次新 COS 对象均有数据库引用或明确 archive manifest；
- 没有相同 key 不同 hash，没有不明 orphan；
- `AuditEvent` 数量、organization、batchId、actorType 和脱敏内容正确；
- ADMIN/MANAGER/TECHNICIAN 从浏览器看到的数据符合权限，另一 organization 无法访问；
- 仪器数据的 parser、dedupe、serial match、rematch 和最佳结果派生符合预期；
- `/api/health/live`、authenticated readiness、Nginx HTTPS 和应用日志正常。

对科研原始文件默认做全量 hash 校验；如果数据量使全量浏览器抽检不现实，文件完整性仍全量校验，
UI/业务语义采用事先批准的分层抽样。

验收报告只保存统计、hash/批次证据和脱敏异常，不把原始科研内容或内部完整 object key 提交 Git。

## 12. 回滚原则

- 发现问题先停止后续批次和相关写入，不要立即“大范围删除重来”。
- 只按可靠 batchId/source mapping 回滚，不按 createdAt、名称前缀或猜测条件删除。
- 按外键依赖逆序处理数据库，先 dry run 列出精确 ID/数量，再由 Louis 批准 apply。
- COS 只删除本批次独占、数据库已解除引用且 source 仍安全保留的对象；共享 hash 对象和版本不得删。
- 审计事件保持 append-only，新增 `data.import.rollback` 记录原因和结果，不删除原导入审计。
- 如果 importer 没有可靠映射或修改了大量既有记录，不做临时 SQL 逆操作；使用已演练的数据库恢复
  方案，在明确停机窗口中整体恢复，并重新对齐 COS。
- 回滚后重新运行 reconciliation、readiness、权限和浏览器验收。

## 13. 每个数据集需要提交给 Louis 的批准摘要

```text
batchId:
数据所有者 / 执行人:
source 类型、位置和不可变副本:
数据分类: production / demo / test / archive / mixed
目标 organization:
结构化表/实体与预计数量:
文件类型、数量、总字节、SHA-256 manifest:
source -> target mapping 版本:
重复/冲突/更新策略:
排除的 credential/敏感字段:
importer commit + CI 结果:
staging 首次运行 + 二次幂等结果:
生产备份恢复证据:
COS 版本/不覆盖策略:
canary 大小和验收查询:
执行窗口、是否停写:
回滚方式和负责人:
完成后的 source 保留期:
```

批准必须对应具体数据集、commit 和 batchId；“以后类似数据都可以导入”不是永久授权。
