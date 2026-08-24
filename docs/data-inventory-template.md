# Pheno Lab 生产数据只读盘点模板

> 状态：待数据所有者在开发者工作站 / 实验室服务器填写
> 原则：只记录统计与恢复证据，不复制实验正文、密码、连接串、API key 或文件内容。

## 1. 数据分类结论

| 数据集 | 位置 | 负责人 | 分类 | 是否不可再生 | 迁移决定 |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | 待填 | 待填 | production / demo / test / mixed | 待填 | 待填 |
| `uploads/` | 待填 | 待填 | active / historical / mixed | 待填 | 待填 |
| `backups/` | 待填 | 待填 | backup | 是 | 待填 |
| `pheno-data/` | 待填 | 待填 | research archive | 待填 | 待填 |
| 仪器电脑源目录 | 待填 | 待填 | instrument source | 待填 | 待填 |

## 2. PostgreSQL

- PostgreSQL 版本：待填
- 数据库名（不记录主机、用户或密码）：待填
- Prisma migration 状态：待填
- 数据库大小：待填
- 是否仍有活跃写入：待填
- 最近写入时间：待填

| 表 / 领域 | 行数 | 最早时间 | 最新时间 | 备注 |
| --- | ---: | --- | --- | --- |
| Organization / User | 待填 | 待填 | 待填 | 不记录邮箱和密码哈希 |
| Experiment / Sample | 待填 | 待填 | 待填 | |
| Run / StepExecution | 待填 | 待填 | 待填 | |
| CharacterizationResult | 待填 | 待填 | 待填 | |
| InstrumentUpload | 待填 | 待填 | 待填 | |
| JvMeasurement | 待填 | 待填 | 待填 | |
| Attachment | 待填 | 待填 | 待填 | |

## 3. 文件存储

### `uploads/`

- 绝对路径：待填
- 文件数量：待填
- 总大小：待填
- 最早 / 最新修改时间：待填
- 根目录图片数量 / 大小：待填
- `instruments/` 数量 / 大小：待填
- 数据库引用但文件不存在：待填
- 文件存在但数据库无引用：待填
- SHA-256 清单位置：待填（清单本身不得包含 secret）

### `pheno-data/`

- 绝对路径：待填
- 文件数量 / 总大小：待填
- 数据类型：CSV / XLS(X) / image / document / other
- 是否包含 Pheno 自有分子结构、配方或其他商业秘密：待填
- 哪些目录已经导入应用：待填
- 哪些目录仍是唯一原件：待填

## 4. 备份与恢复证据

- 最近一次 PostgreSQL 备份：待填
- 备份类型：logical / physical / managed snapshot
- 最近一次成功恢复时间：待填
- 恢复到的隔离环境：待填
- 恢复后验证的表和文件引用：待填
- `uploads/` 是否有独立备份：待填
- 数据所有者批准的 RPO：待填
- 数据所有者批准的 RTO：待填

## 5. Bridge 与仪器电脑

| 仪器 | Bridge 版本 | source 目录 | `config.json` | `state.json` | 可重新注册 |
| --- | --- | --- | --- | --- | --- |
| GiantForce | 待填 | 待填 | 有 / 无 | 有 / 无 | 是 / 否 |
| LIGHTSKY | 待填 | 待填 | 有 / 无 | 有 / 无 | 是 / 否 |

不在本文记录原始 API key。只确认吊销旧 key、签发新 key和测试上传的流程是否可执行。

## 6. 迁移批准门槛

- [ ] 数据所有者确认 production / demo / test / archive 分类
- [ ] PostgreSQL 备份已在隔离环境恢复
- [ ] `uploads/` 已生成数量、大小和 hash 基线
- [ ] 数据库引用和文件断链已统计
- [ ] `pheno-data/` 保密等级和访问人群已批准
- [ ] Bridge 重新注册和上传测试流程可执行
- [ ] COS files / archive / backup 权限域已确定
- [ ] 停机窗口、RPO、RTO 和回滚负责人已确认

以上门槛完成前，可以开发和部署兼容代码，但不得执行生产数据清理、覆盖或存量 COS 切换。
