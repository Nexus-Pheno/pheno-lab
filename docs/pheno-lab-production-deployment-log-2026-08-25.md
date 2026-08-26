# Pheno Lab 生产部署实录（2026-08-25）

本文记录 Pheno Lab 从部署准备到应用、PostgreSQL、COS、systemd 和 Nginx 验收完成的
**实际经过**。它不是对 [`pheno-lab/deploy/README.md`](../pheno-lab/deploy/README.md)
的替代：前者记录这一次真实环境、执行结果和故障处理，后者是以后可重复执行的标准手册。

记录截止时间：2026-08-26 11:10 CST。

## 0. 阅读前先明确三件事

1. 本文不保存数据库密码、管理员邮箱、管理员密码、Session Secret、健康检查 Token、
   AI 加密密钥或 COS 临时凭证。所有示例中的敏感值均为占位符。
2. 本次决定不迁移开发者本地数据，也不执行 demo seed。生产库只保留正式运行所需的
   一个组织、一个管理员和一条 bootstrap 审计记录。
3. 截止记录时，应用、数据库、COS、DNS、HTTPS、证书自动续期演练、管理员登录和浏览器
   上传/下载验收均已完成。尚未完成的是 PostgreSQL 备份恢复闭环、COS 版本控制及若干长期
   权限加固项；这些不影响网站当前提供服务，但必须在承载不可替代的科研数据前完成。

## 1. 最终结论

已完成：

- 代码从 GitHub 私有仓库拉取并在 Ubuntu CVM 上构建；
- 第一个不可变 release `20260825-001` 已发布；
- systemd 服务已启用并持续运行；
- PostgreSQL 独立服务器已创建 `pheno_lab` 数据库并应用全部 6 个迁移；
- 生产库已完成一次性正式 bootstrap，没有 demo、实验、材料、设备或附件数据；
- COS 私有桶、最小权限 CAM 策略和 CVM 实例角色已配置；
- COS 的 Put、Head、Get、内容校验、Delete 完整冒烟测试已通过；
- Nginx 已按 Host 分流 Pheno Lab 和 Talent Platform；
- 直接访问公网 IP 返回 404，不再暴露 Talent Platform；
- `lab.szkl.com` 和 `talent.szkl.com` 的 DNS、独立 HTTPS 证书及 HTTP → HTTPS 跳转已完成；
- Certbot 自动续期定时器已启用，两个证书的 dry run 均成功；
- HTTPS 下的管理员登录、浏览器上传、浏览器下载和受控清理已通过；
- `/api/health/ready` 在最终清理后仍确认数据库和 COS 为 `ready`。

仍需完成的数据保护和长期加固项：

- PostgreSQL 服务器侧自动备份、异机保留和恢复演练；
- COS 版本控制；
- SMTP（不阻塞首个管理员登录）；
- PostgreSQL 专用最小权限 runtime 角色、凭据轮换和 TLS 评估。

## 2. 实际生产拓扑

```text
Internet
  ├─ lab.szkl.com      ─┐
  ├─ talent.szkl.com   ─┼─> 101.32.44.37:80/443
  └─ 101.32.44.37      ─┘        │
                                  ▼
                       Nginx @ Ubuntu App CVM
                         ├─ Host: lab.szkl.com
                         │    └─ 127.0.0.1:3457
                         │         └─ pheno-lab.service
                         │              ├─ PostgreSQL @ 192.168.0.16:5432
                         │              └─ COS @ ap-hongkong
                         ├─ Host: talent.szkl.com
                         │    └─ /srv/talent-platform/apps/web/dist
                         └─ unmatched Host / direct IP
                              └─ HTTP 404
```

应用 CVM 不承担以下职责：

- 不保存上传附件；
- 不保存 PostgreSQL 主数据；
- 不运行 PostgreSQL 生产备份；
- 不把长期 COS `SecretId` / `SecretKey` 写进环境变量；
- 不运行 Docker、PM2 或第二套 API 进程。

## 3. 真实环境基线

### 3.1 App CVM

| 项目              | 实际值                                        |
| ----------------- | --------------------------------------------- |
| 主机名            | `VM-0-6-ubuntu`                               |
| 云厂商/地域       | 腾讯云，`ap-hongkong`，可用区 `ap-hongkong-3` |
| 公网 IP           | `101.32.44.37`                                |
| 操作系统          | Ubuntu 26.04 LTS（Resolute Raccoon）          |
| 架构              | x86_64                                        |
| CPU               | 4 vCPU                                        |
| 内存              | 7.4 GiB                                       |
| Swap              | 2.0 GiB                                       |
| 系统盘            | 98 GiB，部署前可用约 87 GiB                   |
| Node.js           | `v24.19.0`                                    |
| pnpm              | 项目固定 `11.1.2`                             |
| Git               | `2.53.0`                                      |
| Nginx             | `1.28.3`                                      |
| PostgreSQL client | `18.6`                                        |

部署前 Nginx 只监听 `80`，SSH 监听 `22`；`3457`、`443` 当时均未监听。

### 3.2 已存在的 Talent Platform

服务器上原来已有：

```text
/srv/talent-platform
```

它当时是一个只由 Nginx 提供的 Vite 静态前端：

- 根目录为 `/srv/talent-platform/apps/web/dist`；
- 没有 Talent systemd 服务；
- 没有 Node、Hono、PM2 或 Docker API 进程；
- `/api/` 由 Nginx 固定返回 503；
- 原 Nginx 配置使用 `default_server` 和 `server_name _`，所以公网 IP 会直接打开 Talent。

这决定了 Pheno Lab 不能覆盖原配置，而必须新增独立 Host，并将 Talent 从默认站点改为
`talent.szkl.com`。

### 3.3 PostgreSQL

| 项目                   | 实际值                          |
| ---------------------- | ------------------------------- |
| App CVM 使用的连接地址 | `192.168.0.16:5432`             |
| PostgreSQL 版本        | `18.6`                          |
| Pheno Lab 数据库       | `pheno_lab`                     |
| 临时共用角色           | `pheno`                         |
| 连接加密               | 当前为 VPC 内 `sslmode=disable` |

`pheno` 不是 superuser，但当前拥有 `CREATEDB` 和 `CREATEROLE`。这是为了快速部署和未来
Talent/Pheno 整合而接受的临时决定，不是长期最小权限状态。

### 3.4 COS

| 项目         | 实际值                            |
| ------------ | --------------------------------- |
| 地域         | `ap-hongkong`                     |
| AppID        | `1443319577`                      |
| 存储桶       | `pheno-lab-prod-files-1443319577` |
| 桶权限       | 私有读写                          |
| CAM 策略     | `PhenoLabCosFilesAccess`          |
| CVM 角色     | `PhenoLabCvmRole`                 |
| 应用鉴权模式 | `instance-role`                   |

没有启用 CDN、自定义 COS 源站域名或全球加速；`lab.szkl.com` 属于 Nginx 应用域名，
不是 COS 域名。浏览器不直接访问 COS，因此没有为桶配置浏览器 CORS。

## 4. 目录、身份和权限

### 4.1 实际目录

```text
/srv/pheno-lab/
├─ source/                         # Git 工作区，root 用于拉取和构建
│  └─ pheno-lab/                  # Next.js 项目目录
├─ releases/
│  └─ 20260825-001/
│     └─ pheno-lab/               # 已解包的不可变 release
└─ current -> releases/20260825-001

/etc/pheno-lab/
└─ pheno-lab.env                  # root:pheno 0640，不进入 Git

/etc/systemd/system/
└─ pheno-lab.service

/etc/nginx/conf.d/
├─ 00-default.conf                # 未匹配 Host 返回 404
├─ 01-proxy-headers-hash.conf     # 消除 proxy header hash 警告
└─ pheno-lab.conf                 # 当前为 HTTP 临时反向代理

/etc/nginx/sites-available/
└─ talent-platform                # server_name 已改为 talent.szkl.com
```

没有创建：

```text
/var/lib/pheno-lab/uploads
/var/lib/pheno-lab/backups
```

附件直接进入 COS；数据库备份属于 PostgreSQL 服务器。

### 4.2 运行身份

实际创建：

```text
user:  pheno (system user, nologin)
group: pheno
home field: /var/lib/pheno-lab
```

目录权限为：

```text
root pheno 750 /srv/pheno-lab
root pheno 750 /srv/pheno-lab/source
root pheno 750 /srv/pheno-lab/releases
root pheno 750 /etc/pheno-lab
```

用户明确选择由 `root` 完成 Git 拉取、依赖安装、构建和 release 发布；systemd 运行时仍使用
低权限 `pheno` 用户。这个实际选择与标准手册中推荐的普通 deploy 用户略有不同。

## 5. 从零到上线的真实执行过程

### 5.1 主机盘点

先执行了以下只读检查：

```bash
whoami
cat /etc/os-release
uname -m
getconf _NPROCESSORS_ONLN
free -h
df -h /

node --version
pnpm --version
git --version
nginx -v
psql --version

systemctl is-active nginx
ss -lntp
find /srv -mindepth 1 -maxdepth 2 -type d -print
```

结果确认主机资源足够，Node 24、pnpm、Git、Nginx 和 psql client 都已存在，因此没有执行
第二次系统级安装。

随后检查了 Talent Platform 的 package、Nginx、systemd 和进程状态，确认它只是静态前端，
不会与 `127.0.0.1:3457` 冲突。

### 5.2 创建目录和 systemd 运行用户

实际使用：

```bash
getent group pheno >/dev/null || groupadd --system pheno

getent passwd pheno >/dev/null || \
  useradd \
    --system \
    --gid pheno \
    --home-dir /var/lib/pheno-lab \
    --shell /usr/sbin/nologin \
    pheno

install -d -m 0750 -o root -g pheno /srv/pheno-lab
install -d -m 0750 -o root -g pheno /srv/pheno-lab/source
install -d -m 0750 -o root -g pheno /srv/pheno-lab/releases
install -d -m 0750 -o root -g pheno /etc/pheno-lab
```

随后用 `getent`、`stat` 和 `test ! -e` 验证了用户、组、权限，以及 uploads/backups 目录确实
不存在。

### 5.3 配置 GitHub Deploy Key

Deploy key 位于：

```text
/root/.ssh/pheno_lab_deploy
```

仓库中的 Deploy key 是只读的。GitHub ED25519 主机密钥写入
`/root/.ssh/known_hosts` 前先核对官方指纹：

```text
SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
```

测试结果：

```text
Hi Nexus-Pheno/pheno-lab! You've successfully authenticated,
but GitHub does not provide shell access.
```

然后拉取：

```bash
GIT_SSH_COMMAND='ssh -i /root/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes' \
  git clone \
  --branch main \
  --single-branch \
  git@github.com:Nexus-Pheno/pheno-lab.git \
  /srv/pheno-lab/source

git -C /srv/pheno-lab/source config core.sshCommand \
  'ssh -i /root/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes'
```

实际部署的 Git 状态：

```text
branch: main
commit: c0f7258
subject: Merge pull request #3 from Nexus-Pheno/codex/deploy-lab-szkl
```

Next.js 项目位于仓库内的：

```text
/srv/pheno-lab/source/pheno-lab
```

### 5.4 安装依赖和第一次代码校验

Corepack 按 `package.json` 下载并使用 `pnpm 11.1.2`。执行：

```bash
cd /srv/pheno-lab/source/pheno-lab
pnpm install --frozen-lockfile
pnpm run deploy:check
pnpm run typecheck
pnpm test
```

结果：

```text
Test Files  15 passed (15)
Tests       55 passed (55)
```

### 5.5 安装 systemd 单元，但暂不启动

在数据库、COS 和 env 尚未就绪时，只安装并启用 unit：

```bash
install -m 0644 \
  deploy/systemd/pheno-lab.service \
  /etc/systemd/system/pheno-lab.service

systemctl daemon-reload
systemctl enable pheno-lab.service
systemd-analyze verify /etc/systemd/system/pheno-lab.service
```

此时服务显示 `inactive (dead)` 是预期状态，因为还没有 `/srv/pheno-lab/current` release。

`systemd-analyze verify` 当时显示的 Tencent TAT `/var/run` 和 Ubuntu XFS
`CPUAccounting` 警告来自其他系统 unit，与 Pheno Lab 无关。

没有安装：

```text
pheno-lab-backup.service
pheno-lab-backup.timer
```

### 5.6 核对并创建 PostgreSQL 数据库

先通过既有 Talent 配置找到数据库连接文件：

```text
/etc/talent-platform/api.env
```

该文件只是历史配置；当时 Talent API 并没有运行。本文不记录其中的真实密码。

先连接既有数据库检查角色能力，确认：

```text
current_user = pheno
rolsuper = false
rolcreaterole = true
rolcreatedb = true
PostgreSQL = 18.6
```

用户决定暂时复用 `pheno` 角色，而不是新建 `pheno_app`。随后创建：

```sql
CREATE DATABASE pheno_lab
  OWNER pheno
  ENCODING 'UTF8'
  TEMPLATE template0;

REVOKE ALL ON DATABASE pheno_lab FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE pheno_lab TO pheno;
```

连接新库后收紧 public schema：

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO pheno;
```

最终检查：

```text
current_database = pheno_lab
current_user     = pheno
can_create       = true
```

部署过程中曾在 `psql` 交互提示符内粘贴 shell 命令，出现 `invalid command \\` 和连接参数错误；
退出 `psql` 后在 Bash 中重新执行即可，没有损坏数据库。

### 5.7 创建 COS 桶和最小权限策略

创建的桶：

```text
pheno-lab-prod-files-1443319577
```

设置：

- Region：香港 `ap-hongkong`；
- 访问权限：私有读写；
- CDN：关闭；
- 自定义源站域名：不配置；
- 全球加速：关闭；
- CORS：不需要；
- 生命周期自动删除：不设置；
- 版本控制：本次先跳过，作为上线后待办。

创建自定义 CAM 策略 `PhenoLabCosFilesAccess`，实际权限模型为：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["name/cos:HeadBucket"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1443319577:pheno-lab-prod-files-1443319577/"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "name/cos:PutObject",
        "name/cos:GetObject",
        "name/cos:HeadObject",
        "name/cos:DeleteObject"
      ],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1443319577:pheno-lab-prod-files-1443319577/*"
      ]
    }
  ]
}
```

没有授予 `AdministratorAccess`、`QCloudResourceFullAccess` 或跨桶权限。

随后创建 CVM 角色 `PhenoLabCvmRole`：

- 角色载体：CVM / `cvm.qcloud.com`；
- 关联策略：`PhenoLabCosFilesAccess`；
- 绑定实例：`VM-0-6-ubuntu`；
- 无需重启 CVM。

metadata 验证：

```bash
curl -fsS \
  http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/
```

输出：

```text
PhenoLabCvmRole
```

没有把 metadata 子接口返回的临时密钥复制到终端记录或仓库。

### 5.8 生成生产环境配置

实际文件：

```text
/etc/pheno-lab/pheno-lab.env
owner: root
group: pheno
mode: 0640
```

数据库密码通过 `read -s` 读取，不出现在 shell history；使用 Node 的
`encodeURIComponent` 做 URL 编码。四个应用 secret 分别用 OpenSSL 随机生成，未复用。

脱敏后的实际配置结构：

```dotenv
APP_VERSION=20260825-001
DATABASE_URL='postgresql://pheno:<URL_ENCODED_PASSWORD>@192.168.0.16:5432/pheno_lab?connection_limit=10&sslmode=disable'
SESSION_SECRET='<RANDOM_BASE64>'
SESSION_COOKIE_SECURE=true
INGEST_CRON_SECRET='<RANDOM_BASE64>'
HEALTHCHECK_TOKEN='<RANDOM_BASE64>'
AI_CREDENTIAL_KEY='<RANDOM_BASE64_32_BYTES>'

STORAGE_DRIVER=cos
COS_REGION=ap-hongkong
COS_FILES_BUCKET=pheno-lab-prod-files-1443319577
COS_AUTH_MODE=instance-role

BACKUP_MODE=external
```

明确没有设置：

```text
UPLOAD_DIR
BACKUP_DIR
COS_LEGACY_UPLOAD_DIR
COS_SECRET_ID
COS_SECRET_KEY
```

配置校验：

```bash
set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

node node_modules/tsx/dist/cli.mjs scripts/validate-runtime-config.ts
```

输出：

```text
Runtime configuration is valid.
```

#### `psql` 与 Prisma URL 的差异

直接执行：

```bash
psql "$DATABASE_URL"
```

曾返回：

```text
psql: error: invalid URI query parameter: "connection_limit"
```

这是因为 `connection_limit` 是 Prisma 参数，不是 libpq 参数；生产 env 不应删除它。
人工使用 `psql` 验证时临时派生：

```bash
TASK_PSQL_URL="${DATABASE_URL/connection_limit=10&/}"
psql "$TASK_PSQL_URL" \
  -v ON_ERROR_STOP=1 \
  -c 'SELECT current_database(), current_user, version();'
unset TASK_PSQL_URL
```

验证结果为数据库 `pheno_lab`、用户 `pheno`、PostgreSQL `18.6`。

### 5.9 构建第一个 release artifact

在 source 目录加载生产 env 后执行：

```bash
cd /srv/pheno-lab/source/pheno-lab
set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

RELEASE_ID="$APP_VERSION"
ARTIFACT="/tmp/pheno-lab-$RELEASE_ID.tar.gz"

./deploy/scripts/build-release.sh "$ARTIFACT"
```

构建脚本实际执行：

1. `pnpm install --frozen-lockfile`；
2. Prettier 检查；
3. ESLint；
4. 架构边界检查；
5. 部署脚本检查；
6. TypeScript；
7. 55 个 Vitest 测试；
8. Next.js 16.3.1 production build；
9. 打包 artifact 并生成 SHA-256 文件。

结果：

```text
[verify] all checks passed
release artifact: /tmp/pheno-lab-20260825-001.tar.gz
artifact size: about 323 MiB
```

#### checksum 工作目录问题

第一次从项目目录执行：

```bash
sha256sum --check /tmp/pheno-lab-20260825-001.tar.gz.sha256
```

校验文件内部只记录 artifact 的 basename，所以命令在错误目录查找文件并报
`No such file or directory`。artifact 并未损坏。正确方式：

```bash
(
  cd /tmp
  sha256sum --check pheno-lab-20260825-001.tar.gz.sha256
)
```

输出：

```text
pheno-lab-20260825-001.tar.gz: OK
```

### 5.10 发布、迁移和启动

执行：

```bash
cd /srv/pheno-lab/source/pheno-lab

./deploy/scripts/deploy-release.sh \
  /tmp/pheno-lab-20260825-001.tar.gz \
  20260825-001
```

脚本完成：

1. checksum 校验；
2. 解包到 staging；
3. 校验 artifact 内容；
4. 以生产模式校验 env；
5. `prisma migrate deploy`；
6. 迁移旧版明文 AI 凭据（本次为 0 条）；
7. 原子移动到 `/srv/pheno-lab/releases/20260825-001`；
8. 原子更新 `/srv/pheno-lab/current`；
9. `systemctl restart pheno-lab.service`；
10. 轮询 authenticated readiness。

应用的 6 个迁移：

```text
20260819131300_init
20260819133900_profile_feedback
20260819141432_registration_otp
20260819142926_ids_campaign_multirun
20260824120000_reconcile_schema_baseline
20260824123000_add_audit_events
```

全部成功应用。

第一次 readiness 轮询曾显示：

```text
curl: (7) Failed to connect to 127.0.0.1 port 3457
```

这是 Next.js 尚未完成监听时的短暂启动窗口。脚本继续轮询并最终输出：

```text
deployed 20260825-001
```

如果最后没有 `deployed`，则不能把中间一次连接失败当作成功；本次以最终状态和后续
readiness 为准。

### 5.11 systemd 与健康检查验收

实际状态：

```text
pheno-lab.service = active (running)
enabled           = enabled
runtime user      = pheno
listen            = 127.0.0.1:3457 only
current release   = /srv/pheno-lab/releases/20260825-001
```

首次验收时 Next.js 内存约 73.6 MiB，峰值约 101.7 MiB。

Liveness：

```json
{
  "service": "pheno-lab",
  "version": "20260825-001",
  "status": "live"
}
```

Readiness：

```json
{
  "service": "pheno-lab",
  "version": "20260825-001",
  "status": "ready",
  "dependencies": {
    "database": "ready",
    "storage": "ready",
    "storageDriver": "cos"
  }
}
```

Node 日志中出现 `url.parse()` deprecation warning，来自依赖兼容路径，不影响当前启动；
后续升级依赖时应重新检查。

### 5.12 Nginx：从公网 IP 默认站点改为按域名分流

#### 修改 Talent

原配置：

```nginx
listen 80 default_server;
listen [::]:80 default_server;
server_name _;
```

改为：

```nginx
listen 80;
listen [::]:80;
server_name talent.szkl.com;
```

修改前在 `/root/` 保存了带时间戳的配置备份。

#### 新增 unmatched Host 默认站点

HTTPS 切换前的 `/etc/nginx/conf.d/00-default.conf`：

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    access_log off;
    return 404;
}
```

因此直接访问 `101.32.44.37` 不再显示 Talent。

#### 新增 Pheno Lab HTTP 临时 vhost（签发前阶段）

当时的 `/etc/nginx/conf.d/pheno-lab.conf` 包含：

- `server_name lab.szkl.com`；
- upstream `127.0.0.1:3457`；
- 登录、ingest 和 health 限流区；
- `client_max_body_size 25m`；
- ACME webroot `/var/www/certbot`；
- readiness 仅允许 loopback；
- ingest 关闭 request buffering；
- 传递 Host、真实 IP、Forwarded-For、Forwarded-Proto 和 Request ID。

这是 HTTPS 签发前的临时 HTTP 代理。由于 `SESSION_COOKIE_SECURE=true`，此阶段不做登录测试。

#### 消除 proxy header hash 警告

初次 `nginx -t` 显示：

```text
could not build optimal proxy_headers_hash
```

新增 `/etc/nginx/conf.d/01-proxy-headers-hash.conf`：

```nginx
proxy_headers_hash_max_size 1024;
proxy_headers_hash_bucket_size 128;
```

随后 `nginx -t` 不再显示该警告。

HTTP 阶段 Host 验证：

```text
Host: lab.szkl.com      -> 307（未登录用户跳转）
Host: talent.szkl.com   -> 200
direct IP / unmatched  -> 404
```

每次修改都先执行 `nginx -t`，只有成功后才 `systemctl reload nginx`，因此没有主动中断
Talent Platform。

### 5.13 COS 完整 CRUD 验收

readiness 的 `HeadBucket` 只能证明桶可访问，不能证明上传和删除权限。部署后使用应用自己的
`objectStorage()` 适配器执行了一次一次性测试：

1. 在 `deployment-smoke/` 前缀写入随机 `.txt` 对象；
2. `HeadObject` 确认存在；
3. `GetObject` 下载；
4. 逐字节比较下载内容；
5. `DeleteObject` 删除；
6. 再次 `HeadObject` 确认不存在；
7. finally 中带补偿删除，避免失败时留下对象。

输出：

```text
COS CRUD smoke test passed; disposable object removed.
```

这证明最小权限策略实际支持应用当前的 Put、Head、Get、Delete 行为，且测试对象没有保留。

### 5.14 空库正式 bootstrap

#### 为什么不能运行 seed

`prisma/seed.ts` 包含固定 demo 账号、演示密码、材料、设备、工艺、实验等数据。生产环境明确
禁止执行：

```bash
pnpm prisma db seed
```

全新生产库没有组织或用户，而组织邀请又要求 `orgNumber=1` 的平台管理员，因此必须安全创建
首个正式组织和管理员。

#### 第一次输入校验失败

第一次 bootstrap 输入的允许邮箱域名没有包含管理员邮箱的域名，脚本在事务前返回：

```text
The administrator email domain must be included in allowed domains.
```

因为错误发生在 bcrypt 和数据库事务之前，没有写入任何组织或用户。

#### 修正后的 bootstrap

第二次流程自动从管理员邮箱提取 `@` 后面的域名，并把其他域名作为可选输入；所有提示和密码
都在带 `set -euo pipefail` 的子 shell 中处理，结束后敏感变量不会留在父 shell。

事务内执行：

1. 获取 PostgreSQL advisory lock；
2. 确认 `Organization.count() === 0`；
3. 确认 `User.count() === 0`；
4. 创建 `orgNumber=1`、`status=ACTIVE` 的正式组织；
5. 创建 `role=ADMIN`、`active=true`、`userNumber=1` 的正式管理员；
6. 写入 `platform.production.bootstrap` 审计事件；
7. 任一步失败则整个事务回滚。

管理员密码由操作者在 CVM TTY 中输入两次，没有进入本文、Git 或 shell history。

最终只读检查：

```json
{
  "organizations": 1,
  "users": 1,
  "administrators": 1,
  "activeAdministrators": 1,
  "experiments": 0,
  "processes": 0,
  "equipment": 0,
  "materials": 0,
  "attachments": 0,
  "auditEvents": 1
}
```

输出：

```text
Clean production bootstrap state verified.
```

随后 readiness 仍为数据库和 COS 双 `ready`。

### 5.15 DNS、ACME 与最终 HTTPS

域名管理员完成记录后，从独立公共解析器验证：

```text
lab.szkl.com    -> 101.32.44.37
talent.szkl.com -> 101.32.44.37
```

签发证书前，在 `/var/www/certbot/.well-known/acme-challenge/` 放置一次性测试文件，并分别经
两个公网域名读取。两次请求均返回预期内容，证明 DNS、80 端口、Nginx Host 分流和 ACME
webroot 已形成完整路径。

随后使用 Certbot webroot 模式分别签发两个独立的 ECDSA 证书：

| 站点            | 证书名称          | 证书路径                                              | 到期时间（UTC）     |
| --------------- | ----------------- | ----------------------------------------------------- | ------------------- |
| Pheno Lab       | `lab.szkl.com`    | `/etc/letsencrypt/live/lab.szkl.com/fullchain.pem`    | 2026-11-24 01:14:23 |
| Talent Platform | `talent.szkl.com` | `/etc/letsencrypt/live/talent.szkl.com/fullchain.pem` | 2026-11-24 01:14:33 |

私钥分别位于同名目录下的 `privkey.pem`，没有复制到仓库或应用 env。

最终 Nginx 行为：

- `http://lab.szkl.com/*`：保留 ACME challenge，其余 301 到 HTTPS；
- `https://lab.szkl.com/*`：反向代理到 `127.0.0.1:3457`；
- `http://talent.szkl.com/*`：保留 ACME challenge，其余 301 到 HTTPS；
- `https://talent.szkl.com/*`：提供 `/srv/talent-platform/apps/web/dist` 静态 SPA；
- unmatched HTTP / 直接 IP：404；
- unmatched HTTPS：`ssl_reject_handshake on`；
- Nginx 在 IPv4 和 IPv6 的 443 上监听。

#### HTTPS 切换时遇到的失败及恢复

第一次批量安装最终 Nginx 配置时，在通过 `/dev/stdin` 安装 Talent 配置的步骤出现：

```text
install: No such file or directory
```

该命令运行在 `set -euo pipefail` 子 shell 内，所以立即停止，没有执行 `nginx -t` 或 reload；
当时仍由原 HTTP 配置继续服务，没有把一份未经校验的配置加载进 Nginx。

排查确认：Pheno Lab HTTPS 文件已写入磁盘，Talent 和 default 配置仍为旧版本，仓库模板与
`/usr/bin/install` 本身均存在。恢复时先保留时间戳备份，再通过普通临时文件写入 Talent 和
default 配置，执行 `nginx -t` 成功后才 reload。

最终验证：

```text
Lab HTTP       -> 301 https://lab.szkl.com/
Lab HTTPS live -> 200 / status=live
Talent HTTP    -> 301 https://talent.szkl.com/
Talent HTTPS   -> 200
Direct HTTP    -> 404
```

### 5.16 Certbot 自动续期

Certbot 安装时创建了 systemd 定时器，服务器上可通过以下命令确认：

```bash
systemctl list-timers --all | grep -i certbot
```

部署了续期成功后的 Nginx reload hook：

```text
/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
owner: root:root
mode:  0755
```

该 hook 先校验 Nginx 配置，再 reload `nginx.service`。第一次 dry run 中，`nginx -t` 把成功
信息写到 stderr，Certbot 因而显示 `Hook 'deploy-hook' ran with error output`；这不是 hook
失败，两个模拟续期均明确显示 `success`。可以在后续受控变更中让成功输出静默、失败时再输出
完整 `nginx -t` 错误，但本次没有把这项可读性改进作为验收前提。

使用以下命令完成了包含 deploy hook 的续期演练：

```bash
certbot renew --dry-run --run-deploy-hooks
```

两个证书模拟续期成功，演练后 `nginx -t` 和 Lab HTTPS liveness 仍正常。

### 5.17 HTTPS 登录与浏览器附件闭环

操作者从浏览器打开两个 HTTPS 站点，页面均正常。Pheno Lab 正式管理员登录成功，说明
`SESSION_COOKIE_SECURE=true` 下的域名、TLS、Nginx 转发、Session Cookie 和数据库用户链路均
可用。

随后通过已登录页面执行一个 1×1 PNG 的最小附件 smoke test：

```json
{
  "uploadStatus": 200,
  "downloadStatus": 200,
  "contentType": "image/png",
  "downloadedBytes": 68
}
```

对象位于当前组织和用户的标准前缀下：

```text
organizations/<organization-id>/users/<user-id>/images/2026/08/<uuid>.png
```

本文不记录完整 object key，以免把内部标识写入仓库。测试后使用应用存储适配器按已核对的 key
受控清理，并在删除前确认所有业务引用均为 0：

```json
{
  "references": {
    "attachments": 0,
    "feedback": 0,
    "equipment": 0,
    "instrumentUploads": 0,
    "measurementImages": 0
  },
  "cosObjectDeleted": true,
  "uploadAuditRecordsPreserved": 1
}
```

清理后 authenticated readiness 再次返回 `ready`，其中 database、storage 均为 `ready`，
`storageDriver=cos`。这证明浏览器 → Next.js → PostgreSQL/COS → 下载 → 受控清理的完整生产路径
已经通过，测试对象未污染业务数据，审计证据得到保留。

## 6. 当前数据实际存在哪里

### 6.1 PostgreSQL

PostgreSQL 保存结构化数据：

- 组织、用户和权限；
- 实验、样品、流程、执行记录；
- 材料、设备、配方；
- 仪器上传元数据和解析结果；
- COS object key 与业务记录的关联；
- 审计事件。

它不保存附件二进制本体。

### 6.2 COS

COS 保存附件、图片、仪器原始 CSV 和仪器图片。应用生成的主要 object key：

```text
organizations/<organization-id>/users/<user-id>/images/YYYY/MM/<uuid>.<ext>

organizations/<organization-id>/instruments/<instrument-id>/YYYY/MM/<sha256>.<ext>

organizations/<organization-id>/instruments/<instrument-id>/YYYY/MM/images/<sha256>.<ext>
```

COS 是扁平对象存储，控制台把 `/` 前缀显示成类似文件夹的结构。可在腾讯云 COS 控制台的
“存储桶列表 → pheno-lab-prod-files-1443319577 → 文件列表”查看。

不要直接在 COS 控制台删除生产对象；应用的数据库关联不会自动跟随人工删除。

### 6.3 App CVM

App CVM 只保存：

- Git source；
- release artifact 和已解包 release；
- Nginx/systemd 配置；
- root-only 生产 env；
- 可丢弃的 `.next/cache`；
- systemd journal 和 Nginx 日志。

## 7. 当前状态矩阵

| 层                    | 状态   | 证据                                          |
| --------------------- | ------ | --------------------------------------------- |
| Git source            | 完成   | `main@c0f7258`                                |
| 依赖安装              | 完成   | frozen lockfile 成功                          |
| 静态检查              | 完成   | format/lint/structure/deploy/typecheck 全通过 |
| 自动化测试            | 完成   | 15 files / 55 tests                           |
| Next production build | 完成   | Next 16.3.1 build 成功                        |
| Release               | 完成   | `20260825-001`                                |
| systemd               | 完成   | enabled + active                              |
| Loopback 隔离         | 完成   | 只监听 `127.0.0.1:3457`                       |
| PostgreSQL 数据库     | 完成   | `pheno_lab` 可读写                            |
| Prisma migrations     | 完成   | 6/6 applied                                   |
| 正式 bootstrap        | 完成   | 1 org / 1 active admin / 0 demo data          |
| COS 桶                | 完成   | 私有桶                                        |
| CVM instance role     | 完成   | metadata 返回 `PhenoLabCvmRole`               |
| COS CRUD              | 完成   | Put/Head/Get/compare/Delete 通过              |
| 应用 readiness        | 完成   | database + storage ready                      |
| Talent Host 分流      | 完成   | Host 200                                      |
| Lab Host 分流         | 完成   | HTTP 301；HTTPS health 200                    |
| 直接 IP 隔离          | 完成   | HTTP 404；HTTPS 拒绝未知握手                  |
| 公共 DNS              | 完成   | 两个域名均解析到 `101.32.44.37`               |
| HTTPS                 | 完成   | 两张独立 ECDSA 证书；HTTP 均 301 到 HTTPS     |
| 证书续期演练          | 完成   | 两张证书 dry run 成功                         |
| 浏览器登录            | 完成   | 正式管理员在 HTTPS 下登录成功                 |
| 浏览器附件验收        | 完成   | 上传/下载 200；对象清理；审计保留             |
| PostgreSQL 自动备份   | 未完成 | 需在数据库服务器配置                          |
| 恢复演练              | 未完成 | 需恢复到隔离测试库                            |
| COS 版本控制          | 未完成 | 推荐上线后开启                                |

## 8. 不依赖 DNS 的日常验收命令

### 8.1 服务与监听

```bash
systemctl is-enabled pheno-lab.service
systemctl is-active pheno-lab.service
systemctl status pheno-lab.service --no-pager
readlink -f /srv/pheno-lab/current
ss -lntp | grep ':3457'
```

预期 `3457` 只绑定 `127.0.0.1`，不能是 `0.0.0.0`。

### 8.2 Liveness

```bash
curl -fsS http://127.0.0.1:3457/api/health/live
printf '\n'
```

### 8.3 Authenticated readiness

使用子 shell 避免把 env 留在当前 shell：

```bash
(
  set -a
  source /etc/pheno-lab/pheno-lab.env
  set +a

  curl -fsS \
    -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
    http://127.0.0.1:3457/api/health/ready
  printf '\n'
)
```

### 8.4 Nginx Host 分流

```bash
nginx -t

curl -sS -o /dev/null -w 'lab=%{http_code}\n' \
  -H 'Host: lab.szkl.com' http://127.0.0.1/

curl -sS -o /dev/null -w 'talent=%{http_code}\n' \
  -H 'Host: talent.szkl.com' http://127.0.0.1/

curl -sS -o /dev/null -w 'direct=%{http_code}\n' \
  http://127.0.0.1/
```

当前预期：Lab 301、Talent 301、direct 404。业务内容应通过 HTTPS 验证。

### 8.5 日志

```bash
journalctl -u pheno-lab.service -n 100 --no-pager
journalctl -u pheno-lab.service --since '30 minutes ago' --no-pager
tail -n 100 /var/log/nginx/talent-platform.error.log
```

Pheno Lab 当前 vhost 未在仓库模板中指定独立 access/error log 路径，因此按 Nginx 全局配置查看；
不要假设存在 `/var/log/nginx/pheno-lab.*.log`。如以后需要拆分日志，先更新现有模板、本文和
轮转策略，并取得 Louis 批准。

## 9. DNS、HTTPS 与浏览器验收复核手册

本节最初是 DNS 生效后的待办清单；这些工作已于 2026-08-26 完成。保留以下步骤用于证书
续期故障、Nginx 变更或新环境上线后的复核。域名由外部管理员配置；DNS 与 COS 自定义域名
无关。

应添加：

| 主机记录 | 类型 | 值             | TTL |
| -------- | ---- | -------------- | --- |
| `lab`    | A    | `101.32.44.37` | 600 |
| `talent` | A    | `101.32.44.37` | 600 |

### 9.1 验证公共 DNS（已完成）

在 CVM 上执行：

```bash
dig +short A lab.szkl.com @dns15.hichina.com
dig +short A talent.szkl.com @dns15.hichina.com
```

两条应返回：

```text
101.32.44.37
```

还应从一个独立公网网络或 DoH resolver 验证，不能只依赖本机代理可能返回的
`198.18.0.0/15` synthetic 地址。

### 9.2 检查安全组（公网路径已验证）

确认 CVM 安全组允许：

- `80/tcp`：ACME 和 HTTP redirect；
- `443/tcp`：正式 HTTPS；
- `22/tcp`：只允许管理来源；
- 不开放 `3457/tcp`；
- 不开放 PostgreSQL `5432/tcp` 到公网。

### 9.3 签发证书（已完成）

确认 `/var/www/certbot/.well-known/acme-challenge` 已存在，并安装 Certbot：

```bash
certbot --version
```

分别签发，便于两个站点独立维护：

```bash
certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  --domain lab.szkl.com \
  --cert-name lab.szkl.com \
  --email <OPERATIONS_EMAIL> \
  --agree-tos --no-eff-email --non-interactive

certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  --domain talent.szkl.com \
  --cert-name talent.szkl.com \
  --email <OPERATIONS_EMAIL> \
  --agree-tos --no-eff-email --non-interactive
```

当前两个证书均已签发，日常不要重复执行 `certonly`；交给 `certbot.timer` 续期。只有域名、证书
名称或部署方式发生变化时才重新签发。

### 9.4 最终 HTTPS Nginx（已完成）

Pheno Lab 使用仓库模板：

```bash
install -m 0644 \
  /srv/pheno-lab/source/pheno-lab/deploy/nginx/pheno-lab.conf.example \
  /etc/nginx/conf.d/pheno-lab.conf
```

该模板会：

- HTTP 只保留 ACME challenge，其余 301 到 HTTPS；
- HTTPS 反向代理到 `127.0.0.1:3457`；
- readiness 保持私有；
- 登录、health、ingest 使用不同限流；
- 使用 `lab.szkl.com` 的证书。

Talent Platform 已有独立 `443 ssl` server，HTTP 为 ACME + 301；两个 server 块分别引用自己
的证书路径。

每次都执行：

```bash
nginx -t && systemctl reload nginx
certbot renew --dry-run --run-deploy-hooks
```

### 9.5 HTTPS 浏览器最终验收（已完成）

1. 打开 `https://lab.szkl.com`；
2. 确认证书、域名和强制 HTTPS；
3. 使用正式管理员登录；
4. 确认 Session Cookie 为 Secure、HttpOnly；
5. 创建一个明确标记为 smoke test 的最小对象；
6. 上传一张可识别、可受控清理的测试图片，并在临时安全位置记录返回的 object key；
7. 在应用内打开/下载图片；
8. 在 COS 文件列表确认对象位于正确 organization/user 前缀；
9. 检查当前 UI 是否有与该业务记录匹配的附件删除能力，不要假设删除数据库记录会自动删除 COS；
10. 若当前版本没有业务删除入口，使用经过复核的应用存储适配器按已记录 key 做一次性清理；
11. 分别确认数据库引用和 COS 对象均未留下测试污染，并保留审计记录。

本次实际结果：上传 200、下载 200、下载内容类型和字节数正确；5 类数据库引用均为 0；COS
对象删除成功；1 条上传审计记录保留；清理后 readiness 继续为 ready。

## 10. PostgreSQL 备份仍需在数据库服务器完成

应用 CVM 设置 `BACKUP_MODE=external`，只表示应用不会在本机执行 `pg_dump`；它不等于数据库
已经有备份。

数据库服务器还需要单独完成：

1. 专用备份目录和最小权限；
2. 定时 `pg_dump --format=custom`；
3. checksum；
4. 本机保留周期；
5. 异机或对象存储副本；
6. 备份失败告警；
7. 恢复到隔离测试数据库；
8. 校验迁移表、组织、用户和核心业务表；
9. 记录实际 RPO/RTO。

最低恢复演练不能只做“备份文件存在”检查。必须实际执行类似：

```text
pg_restore -> 隔离测试数据库 -> 应用/SQL 校验 -> 删除隔离测试数据库
```

在备份完成前，不应把当前环境描述成“数据保护闭环已经完成”。

## 11. 后续快速发布流程

首次部署之后，每次更新仍采用“source 拉取 + 本机构建 + 不可变 release”，不是在当前 release
内原地覆盖。

### 11.1 拉取并检查

```bash
cd /srv/pheno-lab/source
git fetch --prune origin
git switch main
git pull --ff-only origin main
git status --short
git log -1 --oneline
```

工作区必须干净。如果出现未知修改，先调查，不要使用 `git reset --hard`。

### 11.2 选择 release ID

格式：

```text
YYYYMMDD-NNN
```

同一天依次使用 `001`、`002`、`003`。同时更新
`/etc/pheno-lab/pheno-lab.env` 中的 `APP_VERSION`。

### 11.3 构建

```bash
cd /srv/pheno-lab/source/pheno-lab

set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

RELEASE_ID="$APP_VERSION"
ARTIFACT="/tmp/pheno-lab-$RELEASE_ID.tar.gz"

test ! -e "$ARTIFACT"
test ! -e "$ARTIFACT.sha256"

./deploy/scripts/build-release.sh "$ARTIFACT"

(
  cd /tmp
  sha256sum --check "pheno-lab-$RELEASE_ID.tar.gz.sha256"
)
```

### 11.4 发布

```bash
./deploy/scripts/deploy-release.sh \
  "/tmp/pheno-lab-$RELEASE_ID.tar.gz" \
  "$RELEASE_ID"
```

发布脚本会执行生产迁移、切换软链接、重启服务并验证 readiness。迁移发生在代码切换前，
所以 schema 变更必须遵循 expand/contract，保证旧代码能在新 schema 上短暂运行。

### 11.5 发布后

```bash
systemctl status pheno-lab.service --no-pager
readlink -f /srv/pheno-lab/current
curl -fsS http://127.0.0.1:3457/api/health/live
journalctl -u pheno-lab.service -n 100 --no-pager
```

稳定后才删除 `/tmp` 中旧 artifact；不要删除仍被 `current` 或回滚目标引用的 release 目录。

## 12. 回滚和故障处理

### 12.1 自动回滚

`deploy-release.sh` 在新 release readiness 失败时：

- 如果存在上一 release，把 `current` 切回上一版本并重启；
- 保留失败 release 供诊断；
- 如果是首次部署没有上一 release，则停止服务，避免错误版本继续提供流量。

### 12.2 手工诊断顺序

```bash
systemctl status pheno-lab.service --no-pager
journalctl -u pheno-lab.service -n 200 --no-pager
readlink -f /srv/pheno-lab/current
ss -lntp | grep ':3457'
nginx -t
```

然后分别检查：

1. `scripts/validate-runtime-config.ts`；
2. PostgreSQL 私网连通性；
3. CVM metadata 是否仍返回 `PhenoLabCvmRole`；
4. authenticated readiness；
5. Nginx Host header；
6. 最近一次 migration；
7. COS CAM 策略是否被修改。

不要在生产故障中运行：

```text
prisma migrate dev
prisma db push
prisma db seed
git reset --hard
```

### 12.3 数据库迁移与代码回滚的边界

代码软链接可以回滚，数据库 migration 默认不会自动回滚。因此任何 destructive schema change
必须分多个 release 完成：先 expand，再迁移读写，再 contract。不能假设切回旧 release 就能撤销
数据库变更。

## 13. 本次发现的风险和技术债

### 13.1 数据库角色权限过大

当前 `pheno` 同时服务 Talent 和 Pheno Lab，并拥有 `CREATEDB`、`CREATEROLE`。长期应拆成：

- 迁移/管理员角色；
- Pheno Lab runtime 角色；
- Talent runtime 角色；
- backup 角色。

应用 runtime 不需要创建数据库或角色。

### 13.2 数据库凭据应轮换

数据库凭据曾在人工部署沟通中明文出现。虽然没有写入仓库，仍建议在合适窗口轮换，并同步：

- `/etc/pheno-lab/pheno-lab.env`；
- 其他仍使用该共享角色的服务；
- 数据库端认证配置。

轮换后必须重启服务并重新跑 readiness。

### 13.3 PostgreSQL 当前未启用 TLS

当前通过腾讯云私网并使用 `sslmode=disable`。安全组隔离是必要条件，但长期仍应评估 PostgreSQL
TLS、证书验证和更严格的 `pg_hba.conf`。

### 13.4 COS 版本控制未启用

私有权限和应用审计不能替代误删恢复。正式科研附件开始写入前，建议开启版本控制，并明确旧版本
保留和清理成本。

### 13.5 SMTP 未配置

首个管理员可登录，管理员也可以直接创建用户；但 OTP 邮件不会自动发送。正式面向更多用户前应
配置 SMTP，并验证失败不会把 OTP 写入日志。

### 13.6 生产 bootstrap 尚无仓库脚本

本次使用一次性、带空库保护和事务保护的 Node 流程完成 bootstrap。以后新环境应将该能力收敛为
仓库内受测试的专用命令，避免再次复制长命令；该命令仍必须拒绝非空数据库并禁止固定密码。

### 13.7 COS 对象生命周期删除尚未形成通用闭环

当前代码会在“文件已写入 COS、但审计写入失败”时执行补偿删除，也具备底层
`objectStorage.delete()` 能力；但尚未看到一个覆盖所有业务实体删除场景的通用对象清理流程。
因此删除数据库中的实验、附件或反馈记录时，不能默认对应 COS 对象一定同步删除。

长期应选择并实现一种明确模型：

- 业务事务写入待删除 object key，由 outbox/worker 删除 COS 并重试；或
- 先软删除业务记录，COS 删除确认后再完成最终清理；或
- 使用定期孤儿扫描，以数据库引用和审计记录为依据生成清理清单，并要求人工确认。

在该闭环完成前，浏览器附件测试必须记录 object key 并做数据库/COS 双边确认，不能只看 UI
中的记录是否消失。

## 14. 安全边界复核

当前已经实现：

- runtime 不使用 root；
- source/build 与 runtime 分离；
- release 除 `.next/cache` 外不可由 runtime 写入；
- `NoNewPrivileges=true`；
- `ProtectSystem=strict`；
- `PrivateTmp=true`；
- `PrivateDevices=true`；
- `ProtectHome=true`；
- 应用只监听 loopback；
- Nginx 是唯一公网入口；
- 直接 IP 不展示业务站点；
- 两个业务域名都强制跳转 HTTPS；
- Lab 与 Talent 使用独立证书；
- Certbot 定时器和续期后 Nginx reload hook 已配置并完成 dry run；
- COS 为私有桶；
- COS 使用短期实例角色凭据；
- CAM 限定到单一 bucket；
- env 为 `root:pheno 0640`；
- readiness 需要 Bearer token，且 Nginx 不对公网开放 readiness；
- 数据写入有组织隔离、权限检查和审计层。

仍要外部确认：

- CVM 安全组中 SSH 仅允许管理来源，3457 不对公网开放；
- PostgreSQL 安全组和 `pg_hba.conf`；
- 数据库备份访问权限；
- COS 版本和保留策略。

## 15. 交接清单

### 应用 CVM

- [x] Node 24 / pnpm 11.1.2
- [x] GitHub 只读 Deploy key
- [x] `/srv/pheno-lab/source`
- [x] immutable releases + `current`
- [x] systemd enabled/active
- [x] runtime env 权限
- [x] loopback-only 3457
- [x] Nginx Host 分流
- [x] direct IP 404
- [x] 443 / HTTPS
- [x] HTTP → HTTPS
- [x] unmatched HTTPS 拒绝握手
- [x] Certbot timer / deploy hook / dry run

### PostgreSQL

- [x] `pheno_lab` database
- [x] public schema 权限收紧
- [x] 6 migrations
- [x] clean production bootstrap
- [x] application read/write
- [ ] dedicated least-privilege runtime role
- [ ] credential rotation
- [ ] TLS evaluation
- [ ] scheduled backup
- [ ] off-host copy
- [ ] restore drill

### COS

- [x] private bucket
- [x] least-scope CAM policy
- [x] CVM role
- [x] no static cloud key in env
- [x] full CRUD smoke test
- [x] disposable object removed
- [ ] versioning
- [ ] retention/lifecycle review

### DNS / TLS / Product

- [x] `lab.szkl.com` A record
- [x] `talent.szkl.com` A record
- [x] Lab certificate
- [x] Talent certificate
- [x] HTTP → HTTPS
- [x] administrator browser login
- [x] browser attachment upload/download
- [x] smoke object controlled cleanup
- [x] upload audit record preserved
- [ ] SMTP decision

## 16. 最终判断

截至本文记录时，Pheno Lab 的**网站生产部署和公网访问闭环已经完成**：代码、release、
systemd、PostgreSQL、COS、正式空库 bootstrap、DNS、HTTPS、证书续期演练、管理员登录以及
浏览器附件上传/下载/清理均已验证。`https://lab.szkl.com` 可以正常提供服务；
`https://talent.szkl.com` 的现有静态前端也保持正常。

这不等于**数据保护闭环**已经完成。下一项最高优先级工作是在 PostgreSQL 服务器上建立自动
备份、异机副本和真实恢复演练；随后开启 COS 版本控制并决定保留策略。在这些工作完成前，
不要把系统描述成已经具备不可替代科研数据的完整灾难恢复能力，也不要重新执行数据库创建、
migration、COS 策略或 production bootstrap。

## 17. 后续发布记录

本节只追加**已经发生并验证**的发布事件，按时间顺序排列。首发过程仍以第 5 节为准。

### 17.1 release `20260826-001`（2026-08-26）

**内容**：`main` 从 `c0f7258` 推进到 `4abb21d`，共两部分——
2026-08-25 合入的文档/部署守则（PR #4，无应用代码），以及本次的设备附件能力
（PR #5）与 release 脚本修复（PR #6）。

**授权**：Michael 明确要求直接部署，并确认本次不需要 Louis 签字。

**migration**：`20260826140000_add_equipment_attachments`，只做
`ALTER TABLE "Attachment" ADD COLUMN "equipmentId" TEXT` 加一条级联外键。属于
expand-only：上一版代码忽略该列，回滚后仍可运行；不回填、不改动任何既有行。

**执行**：严格按 `deploy/README.md` 第 4 节。

| 步骤 | 结果 |
| --- | --- |
| 4.1 只读预检 | 服务 active；`current` = `20260825-001`；source 工作区干净，fast-forward 到 `4abb21d` |
| 4.2 `APP_VERSION` | `20260825-001` → `20260826-001`，只改这一行；权限仍为 `root pheno 0640`；`validate-runtime-config.ts` 通过 |
| 4.3 构建 | `build-release.sh` 首次失败（见下），修复后通过完整 `pnpm run verify`；artifact sha256 校验 OK |
| 4.4 发布 | `prisma migrate deploy` 应用 1 条 migration；脚本输出 `deployed 20260826-001` |
| 4.5 验收 | 见下 |

**4.3 首次失败与根因**：`build-release.sh` 只执行
`pnpm install --frozen-lockfile`。lockfile 未变时该命令是 no-op，pnpm 因此跳过 Prisma 的
postinstall，`node_modules` 中仍是上一版 schema 生成的 client，`pnpm run typecheck` 报出
10 个 `'equipmentId' does not exist in type 'AttachmentWhereInput'`。CI 每次都是冷装
`node_modules`，所以从不复现；只有长期保留 `node_modules` 的构建机（即
`/srv/pheno-lab/source`）会中招。修复方式是在 install 与 verify 之间显式执行
`pnpm exec prisma generate`（PR #6），不是在服务器上临时手工生成。

**数据前后对照**（同一生产库 `pheno_lab`）：

| 指标 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `Attachment` 行数 | 45776 | 45776 |
| `Equipment` 行数 | 19 | 19 |
| `IngestItem` PENDING | 1 | 1 |
| `Attachment.equipmentId` 列 | absent | `text`, nullable |
| `equipmentId` 非空行数 | — | 0 |

**验收证据**：`pheno-lab.service` active；`current` →
`/srv/pheno-lab/releases/20260826-001`；3457 仅监听 `127.0.0.1`；
`/api/health/live` 与带 token 的 `/api/health/ready` 均返回
`version: 20260826-001`，`database: ready`，`storage: ready (cos)`；
公网 `http://lab.szkl.com/` 301 到 HTTPS，`https://lab.szkl.com/api/health/live` 正常，
`/` 307 到 `/login`。保留 release：`20260825-001`、`20260826-001`（回滚目标已存在，
首发时没有）。

**未做**：本次没有在 App CVM 上做 `pg_dump`。第 2 节和第 10 节明确规定应用 CVM 不保存
数据库备份，备份归 PostgreSQL 服务器统一管理；本次变更是纯增列，安全证据取的是上表的
前后行数对照，而不是一份落在应用机上的 dump。数据库服务器侧的自动备份、异机副本和恢复
演练**仍然是未完成的最高优先级工作**，本次发布没有改变这一点。

**浏览器 smoke test**：本次改动涉及上传与文件读取路径，但设备附件要等设备记录入库后才有
可点开的对象，浏览器端点击验证尚未执行，记为待办。

### 17.2 release `20260826-004`（2026-08-26）

**内容**：`main` 推进到 `4b69274`。除本次的 LabEnvironment 说明/附件能力（PR #7）外，
还一并带上另一位 agent 已合入的 PWA manifest 与 service worker。

**migration**：`20260826160000_environment_details_and_documents` —
`LabEnvironment` 增加 `notes TEXT NOT NULL DEFAULT ''`，`Attachment` 增加可空
`labEnvironmentId` 加级联外键。expand-only，不回填。

**发布前发现的不一致（必须记录）**：预检时 `current` 已指向
`/srv/pheno-lab/releases/20260826-003`，但 `/etc/pheno-lab/pheno-lab.env` 里的
`APP_VERSION` 仍是 `20260826-001`，因此 `/api/health/live` 报告的版本是错的。核对
`/proc/<MainPID>/cwd` 确认真正在跑的是 003 的代码，服务启动时间与 `current` 软链接
mtime 相差 1 秒，说明 003 确实已经生效，只是版本标签没跟上。002 和 003 由另一位 agent
在 15:55 / 16:09 发布，第 4.2 节要求的 `APP_VERSION` 同步更新被跳过了。本次发布把
`APP_VERSION` 设为 `20260826-004`，标签恢复正确。

**并发发布是真实风险**：本机同一天由多个 agent 发布。开始前必须 `pgrep` 确认没有
`build-release.sh` / `deploy-release.sh` / `next build` 在跑，并确认 release ID 未被占用
（本次 `20260826-002` 和 `-003` 都已被别人用掉，第 4.2 节的 `test ! -e` 直接挡下了覆盖）。

**数据前后对照**：

| 指标 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `LabEnvironment` 行数 | 7 | 7 |
| `Attachment` 行数 | 45776 | 45776 |
| `IngestItem` PENDING EQUIPMENT | 20 | 20 |
| `LabEnvironment.notes` 列 | absent | `text`, NOT NULL |
| `notes` 非空行数 | — | 0 |
| `Attachment.labEnvironmentId` 列 | absent | `text`, nullable |

**验收**：`current` → `20260826-004`；3457 仅监听 loopback；`/api/health/live` 与带 token 的
`/api/health/ready` 都返回 `version: 20260826-004`、`database: ready`、`storage: ready (cos)`；
公网 301 到 HTTPS，公网 liveness 正常。

**仍未做**：与 17.1 相同——应用 CVM 不做 `pg_dump`（两次都是纯增列，安全证据是上面的前后
行数对照），数据库服务器侧备份/异机副本/恢复演练依旧是最高优先级欠账。新的附件读取路径
仍未做浏览器点击验收。
