# Pheno Lab 腾讯云部署手册

2026-08-25 首次真实生产部署的环境、逐步执行结果、问题修正和当前待办，见
[`../../docs/pheno-lab-production-deployment-log-2026-08-25.md`](../../docs/pheno-lab-production-deployment-log-2026-08-25.md)。

这是 `https://lab.szkl.com` 的生产部署手册。当前阶段采用易于快速迭代、但仍能安全回滚的方式：

- Ubuntu CVM 在 `/srv/pheno-lab/source` 拉取 Git 源码并本地构建；
- 构建结果发布到 `/srv/pheno-lab/releases/<release-id>`；
- systemd 只运行 `/srv/pheno-lab/current` 指向的已验证 release；
- Nginx 负责 `lab.szkl.com` 的 HTTPS 和反向代理；
- PostgreSQL 从第一天就运行在独立数据库服务器；
- 附件、图片和仪器原始文件从第一天就直接写入私有 COS。

应用 CVM 不保存 PostgreSQL 主数据、数据库备份或上传附件。数据库备份和恢复在
PostgreSQL 服务器侧统一管理。COS 是对象存储，不是向量数据库；本次上线不依赖向量服务。

> 命令默认 SSH 用户是 `ubuntu`。如果你的用户名不同，统一替换文中的 `ubuntu`。
> 不要把真实密码、数据库 URL、session secret 或云密钥粘贴到 GitHub Issue / PR。

## 0. 生产部署契约（coding agent 必读）

本文件是 Pheno Lab **唯一**的生产部署、更新和回滚手册。首次真实部署的逐条命令、输出、故障和
验收证据记录在
[`../../docs/pheno-lab-production-deployment-log-2026-08-25.md`](../../docs/pheno-lab-production-deployment-log-2026-08-25.md)。
任何 agent 都不得根据常见 Node.js 部署习惯发明第三种流程。

### 0.1 当前已验证的生产事实

截至 2026-08-26：

- `https://lab.szkl.com` 已上线，HTTP 301 到 HTTPS；
- `https://talent.szkl.com` 与 Pheno Lab 共用同一台 Nginx，但提供独立静态站点和证书；
- Pheno Lab 由 `pheno-lab.service` 以非登录用户 `pheno` 运行，只监听 `127.0.0.1:3457`；
- source 为 `/srv/pheno-lab/source`，不可变 release 位于 `/srv/pheno-lab/releases`，运行入口是
  `/srv/pheno-lab/current`；
- PostgreSQL 为独立服务器上的 `pheno_lab`；生产附件只写私有 COS；
- `/api/health/ready` 已验证 PostgreSQL 和 COS；浏览器登录、上传、下载和受控清理已通过；
- DNS、两张独立 Let's Encrypt 证书、`certbot.timer` 和续期 deploy hook 已配置；
- 数据库服务器自动备份/异机副本/恢复演练和 COS 版本控制仍是待办。

### 0.2 现有生产文件白名单

日常部署只能使用或增量修改以下**已经存在**的生产配置；修改前必须备份、展示 diff、运行校验，
并取得 Louis 对该配置变更的明确同意：

```text
/etc/pheno-lab/pheno-lab.env
/etc/systemd/system/pheno-lab.service
/etc/nginx/conf.d/pheno-lab.conf
/etc/nginx/conf.d/00-default.conf
/etc/nginx/conf.d/01-proxy-headers-hash.conf
/etc/nginx/sites-available/talent-platform
/etc/nginx/sites-enabled/talent-platform
/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
/etc/letsencrypt/live/lab.szkl.com/*
/etc/letsencrypt/live/talent.szkl.com/*
```

仓库内可维护的部署源文件只有：

```text
deploy/README.md
deploy/pheno-lab.env.example
deploy/nginx/pheno-lab.conf.example
deploy/systemd/pheno-lab.service
deploy/systemd/pheno-lab-backup.service
deploy/systemd/pheno-lab-backup.timer
deploy/scripts/build-release.sh
deploy/scripts/deploy-release.sh
scripts/validate-runtime-config.ts
scripts/check-deploy.ts
```

`pheno-lab-backup.*` 只保留给 local/旧部署参考，当前 App CVM 明确不安装；生产数据库备份在
PostgreSQL 服务器管理。

### 0.3 禁止创建平行部署配置

未经 Louis 明确批准，不得：

- 创建 `.env.production`、`.env.local`、`prod.env`、第二份 secret 文件或新的 `/etc/pheno-lab/*`；
- 创建新的 systemd unit、Nginx vhost/include、Certbot hook、cron、PM2、Docker/Compose 或 API
  进程；
- 改用 `/opt`、`/var/www/pheno-lab`、另一个 `/srv` 目录或在当前 release 内原地构建/修改；
- 创建 `/var/lib/pheno-lab/uploads` 或 `/var/lib/pheno-lab/backups`；
- 把附件、数据库 dump、env 或日志放进 source、artifact 或 release；
- 覆盖现有 env，自动生成或轮换生产 secret，或把 CVM instance role 改为长期 COS 静态密钥；
- 修改同机 Talent Platform 配置、DNS、证书、端口、安全组、CAM、COS 或 PostgreSQL 权限；
- 直接部署未合并分支，或在生产 source 有未知改动时继续发布。

如果功能确实需要新生产环境变量，先在代码 PR 中增量修改现有 config schema、配置测试、
`.env.example`、`deploy/pheno-lab.env.example` 和本文；由 Louis 决定生产值，再只修改现有
`/etc/pheno-lab/pheno-lab.env`。不要为新变量新建 env 文件。

如果现有文件缺失、真实服务器状态与本文不一致，或下一步需要白名单外的文件/服务，停止操作并
询问 Louis。不要用“临时文件先跑起来”代替确认；用于原子写入且会立即删除的 `mktemp` 不属于
长期配置文件，但仍必须由已审阅的操作步骤明确要求。

### 0.4 首次建机与日常更新不可混用

- 第 3 节只用于 Louis 明确批准的**全新服务器首次部署**。现有生产 CVM 不得重复执行目录创建、
  Deploy Key、数据库创建、bootstrap、CAM、Nginx、证书或 systemd 初始化步骤。
- 已上线环境的普通代码发布只执行第 4 节。普通发布不修改 Nginx/systemd/COS/PostgreSQL/DNS。
- 功能开发、合并 PR 与生产部署是三个独立授权；代码合并不等于允许 agent SSH 或发布。
- 批量数据库/文件导入是第四种独立授权，不和 release 同时执行；必须遵守
  [`../../docs/data-import-rules.md`](../../docs/data-import-rules.md)。

## 1. 生产拓扑

```text
Internet
  └─ https://lab.szkl.com:443
       └─ Nginx @ Ubuntu App CVM (101.32.44.37)
            └─ http://127.0.0.1:3457
                 └─ pheno-lab.service (User=pheno)
                      ├─ PostgreSQL server:5432（同 VPC 私网）
                      └─ COS 私有标准存储桶（同地域内网）
```

```text
/srv/pheno-lab/
├─ source/                         # root 管理的 Git 工作区
├─ releases/
│  ├─ 20260825-001/              # root:pheno，除 .next/cache 外只读
│  └─ 20260825-002/
└─ current -> releases/20260825-002

/etc/pheno-lab/
└─ pheno-lab.env                   # root:pheno 0640，不进 Git
```

`git pull` 只改 source，不会覆盖当前运行的 release。发布脚本会先校验和构建，再原子切换
`current` 软链接；新版 readiness 失败时会自动切回上一版代码。

## 2. 上线前硬条件

1. `lab.szkl.com` A 记录解析到 `101.32.44.37`。
2. 如 CVM 在中国大陆，域名已满足备案和腾讯云接入要求。
3. 安全组对预期用户开放 `80/tcp` 和 `443/tcp`，`22/tcp` 只对固定管理 IP 开放。
4. 不对公网开放 `3457` 或 `5432`。
5. 首次发布前，App CVM 已可通过私网连接 PostgreSQL，且已绑定能访问目标 COS 桶的 CVM 角色。

数据库或 COS 还没就绪时，可先完成主机、Node、目录、Nginx 和证书配置。但应用的
`/api/health/ready` 会真实检查 PostgreSQL 和 COS，两者未就绪时不会伪装成可上线状态。

## 3. 第一次部署

### 3.1 验证 DNS 和 CVM

在本地电脑执行：

```bash
dig +short lab.szkl.com A
nc -vz lab.szkl.com 22
ssh ubuntu@101.32.44.37
```

`dig` 应输出 `101.32.44.37`。登录 CVM 后执行：

```bash
whoami
cat /etc/os-release
uname -m
hostname -I
```

除非特别标注“本地电脑”，后续命令都在 App CVM 上执行。

### 3.2 安装系统软件和 Node.js 24

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates curl git nginx certbot postgresql-client tar gzip openssl

curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
sudo npm install --global pnpm@11.1.2
rm /tmp/nodesource_setup.sh

node --version
pnpm --version
psql --version
nginx -v
```

Node 必须是 `v24.x`，pnpm 必须是 `11.1.2`。

### 3.3 创建运行身份和目录

首次真实部署采用 root 管理 source/release/config，`pheno` 只负责运行应用。登录后先进入 root
shell：

```bash
sudo -i

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

验证：

```bash
getent passwd pheno
getent group pheno
stat -c '%U %G %a %n' \
  /srv/pheno-lab \
  /srv/pheno-lab/source \
  /srv/pheno-lab/releases \
  /etc/pheno-lab
```

不创建 `/var/lib/pheno-lab/uploads` 或 `/var/lib/pheno-lab/backups`。`pheno` 用户的 home 字段仅是系统身份元数据，
`useradd` 没有使用 `--create-home`。

### 3.4 为 CVM 配置 GitHub 只读拉取权限

私有仓库推荐使用这台 CVM 专用的只读 Deploy key：

```bash
ssh-keygen -t ed25519 \
  -f /root/.ssh/pheno_lab_deploy \
  -C 'pheno-lab-production-cvm'
cat /root/.ssh/pheno_lab_deploy.pub
```

把公钥添加到 GitHub 仓库的 **Settings → Deploy keys → Add deploy key**，不勾选写权限。
然后把 GitHub 官方公布并已核对 fingerprint 的 host key 写入 `/root/.ssh/known_hosts`。不要不经
核对直接信任 `ssh-keyscan` 输出。测试专用 key：

```bash
chmod 0600 /root/.ssh/known_hosts
ssh -T \
  -i /root/.ssh/pheno_lab_deploy \
  -o IdentitiesOnly=yes \
  git@github.com
```

GitHub 通常会返回“认证成功但不提供 shell”，这个测试仍可能以状态码 1 结束。
这个项目的 SSH clone URL 是 `git@github.com:Nexus-Pheno/pheno-lab.git`：

```bash
GIT_SSH_COMMAND='ssh -i /root/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes' \
  git clone \
    --branch main \
    --single-branch \
    git@github.com:Nexus-Pheno/pheno-lab.git \
    /srv/pheno-lab/source

git -C /srv/pheno-lab/source config core.sshCommand \
  'ssh -i /root/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes'
git -C /srv/pheno-lab/source status --short --branch
```

如果仓库是公开的，可直接用 HTTPS clone URL，不需要 Deploy key。

### 3.5 配置 COS

在腾讯云控制台完成：

1. 在与 App CVM 相同地域创建一个“私有读写”的 COS **标准存储**桶，例如
   `pheno-lab-prod-files-APPID`。
2. 创建 CVM 实例角色并绑定到 App CVM。
3. 仅授予目标桶的 `HeadBucket`、`PutObject`、`GetObject`、`HeadObject` 和
   `DeleteObject`。不授予删除 bucket、更改 bucket ACL 或访问其他 bucket 的权限。
4. 开启版本控制，并配置符合数据保留要求的生命周期 / 备份策略。

应用从 CVM metadata 取得轮换的临时凭据，生产 env 不写长期 `SecretId` / `SecretKey`。
在 App CVM 确认角色已绑定：

```bash
curl -fsS \
  http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/
```

应输出角色名，不应返回 404。不要把查到的临时密钥粘贴到聊天或日志中。
readiness 会调用 `HeadBucket`，缺少该权限会使发布失败。

### 3.6 配置独立 PostgreSQL 服务器

PostgreSQL 从首次发布就必须在同 VPC 内通过私网访问，不开放公网 `5432`。
数据库服务器的安全组只允许 App CVM 的安全组或私网 IP 访问 5432。

创建生产库和独立应用用户后，在 App CVM 测试：

```bash
read -rsp 'DATABASE_URL: ' DATABASE_URL_INPUT
echo
psql "$DATABASE_URL_INPUT" -v ON_ERROR_STOP=1 \
  -c 'select current_database(), current_user;'
unset DATABASE_URL_INPUT
```

不要在 shell 命令行中明文写密码，避免进入 history。生产库只使用 `prisma migrate deploy`，
不执行 `prisma migrate dev`、`prisma db push` 或 demo seed。

数据库服务器必须单独配置定时备份、异机保留和恢复演练；应用 CVM 不安装仓库中的
`pheno-lab-backup.timer`。

开发者本地的真实数据不在 Git 中。如需保留，必须另行完成 `pg_dump` / 恢复演练和历史附件
hash 迁移；这些操作不随首次应用发布自动执行。

### 3.7 写入生产环境变量

以下复制模板动作**只允许在全新服务器且目标文件不存在时执行**。现有生产机已经有该文件，
不得再次复制模板或创建其他 env 文件；需要批准的增量修改时使用 `sudoedit` 编辑现有文件。

```bash
test ! -e /etc/pheno-lab/pheno-lab.env

install -m 0640 -o root -g pheno \
  /srv/pheno-lab/source/pheno-lab/deploy/pheno-lab.env.example \
  /etc/pheno-lab/pheno-lab.env
sudoedit /etc/pheno-lab/pheno-lab.env
```

使用下面的命令生成四个彼此独立的值：

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 36   # INGEST_CRON_SECRET
openssl rand -base64 36   # HEALTHCHECK_TOKEN
openssl rand -base64 32   # AI_CREDENTIAL_KEY，必须刚好解码为 32 bytes
```

替换模板中所有占位值，并确认：

```text
SESSION_COOKIE_SECURE=true
STORAGE_DRIVER=cos
COS_AUTH_MODE=instance-role
BACKUP_MODE=external
```

不设置 `UPLOAD_DIR`、`BACKUP_DIR` 或 `COS_LEGACY_UPLOAD_DIR`。最后确认权限：

```bash
sudo chown root:pheno /etc/pheno-lab/pheno-lab.env
sudo chmod 0640 /etc/pheno-lab/pheno-lab.env
sudo stat -c '%U %G %a %n' /etc/pheno-lab/pheno-lab.env
```

生产 env 的当前文件名和路径固定为 `/etc/pheno-lab/pheno-lab.env`。禁止创建
`.env.production`、`.env.local`、`pheno-lab.env.new` 或任何按 release 复制的 env；systemd
持续通过 `EnvironmentFile=/etc/pheno-lab/pheno-lab.env` 加载这一份文件。

### 3.8 安装 systemd 单元

同样只用于首次部署；已有 unit 的服务器不得重复初始化或另建 `pheno-lab-v2.service`。

```bash
cd /srv/pheno-lab/source/pheno-lab
sudo install -m 0644 deploy/systemd/pheno-lab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pheno-lab.service
sudo systemd-analyze verify /etc/systemd/system/pheno-lab.service
```

不安装 `pheno-lab-backup.service` 和 `pheno-lab-backup.timer`；备份属于 PostgreSQL 服务器。
此时也不手动启动应用，因为首个 release 还没有创建。

### 3.9 配置 Nginx 和 HTTPS

本节仅用于全新服务器。现有生产机的 Lab/Talent vhost、default server、证书和续期 hook 已存在，
普通发布不得重写。新服务器如果也承载 Talent 或其他站点，必须先只读盘点
`/etc/nginx/sites-enabled`、`/etc/nginx/conf.d` 和 80/443 监听，再让 Louis 确认合并方案。

用 ACME webroot 签发证书，不需要停止整台服务器的 Nginx，不会主动中断同机其他站点。
先创建临时 HTTP vhost：

```bash
sudo install -d -m 0755 -o root -g root /var/www/certbot/.well-known/acme-challenge
sudo tee /etc/nginx/conf.d/pheno-lab.conf >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name lab.szkl.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 200 'Pheno Lab deployment in progress\n';
        add_header Content-Type text/plain;
    }
}
NGINX
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

在本地电脑确认 `curl -i http://lab.szkl.com/` 可达，然后在 App CVM 签发证书：

```bash
sudo certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  --domain lab.szkl.com \
  --cert-name lab.szkl.com \
  --email YOUR_EMAIL \
  --agree-tos --no-eff-email --non-interactive

sudo install -m 0644 \
  /srv/pheno-lab/source/pheno-lab/deploy/nginx/pheno-lab.conf.example \
  /etc/nginx/conf.d/pheno-lab.conf
sudo nginx -t
sudo systemctl reload nginx
```

创建或确认现有 deploy hook。全新服务器才创建；现有服务器只检查内容和权限，不创建第二份：

```bash
sudo test -x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo systemctl list-timers --all | grep -i certbot
sudo certbot renew --dry-run --run-deploy-hooks
```

正式环境已测试的 hook 在续期后执行 `nginx -t`，成功后 reload 现有 `nginx.service`。因为
`nginx -t` 会把成功信息写到 stderr，dry run 可能显示 `ran with error output`，但要以每张证书
最终的 `success` 和命令退出状态为准。如果 hook 缺失或内容不同，不要临时新建，先对照部署
实录并问 Louis。

应用发布前，HTTPS 可能返回 502，因为 `127.0.0.1:3457` 尚无进程监听；这不代表证书失败。

### 3.10 首次构建和发布

```bash
cd /srv/pheno-lab/source
git fetch --prune origin
git switch main
git pull --ff-only origin main
git status --short

cd /srv/pheno-lab/source/pheno-lab
set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

RELEASE_ID="$(date +%Y%m%d)-001"
./deploy/scripts/build-release.sh "/tmp/pheno-lab-$RELEASE_ID.tar.gz"
sudo ./deploy/scripts/deploy-release.sh \
  "/tmp/pheno-lab-$RELEASE_ID.tar.gz" "$RELEASE_ID"

unset DATABASE_URL SESSION_SECRET INGEST_CRON_SECRET HEALTHCHECK_TOKEN \
  AI_CREDENTIAL_KEY COS_SECRET_ID COS_SECRET_KEY
```

`build-release.sh` 会执行 `pnpm install --frozen-lockfile` 和完整 `pnpm run verify`。
`deploy-release.sh` 会校验 checksum / env，执行 `prisma migrate deploy`，切换 `current`，
重启 systemd 并轮询 readiness。

首次发布如果 readiness 失败，因为没有旧 release 可回滚，服务会停止，失败 release 会保留供诊断。
不要对生产库运行 `pnpm prisma db seed`；仓库 seed 包含 demo 用户。

### 3.11 全新空库的正式 bootstrap

当前生产库已经完成 bootstrap，**现有环境永远跳过本节**。仓库目前没有可重复运行的 production
bootstrap 命令，只有带空库保护、advisory lock、事务和审计的一次性已验证流程；不得用
`prisma/seed.ts`、固定 demo 账号或 agent 临时编写的脚本代替。

全新环境在完成 migration 后，必须先让 Louis 确认正式组织资料、管理员身份和 allowed domain，
再对照首次部署实录执行经过复核的 bootstrap。执行前后都做只读计数；任何 Organization/User
已存在时停止。成功状态应是一个正式组织、一个 active ADMIN、一条 bootstrap 审计和零 demo
实验/材料/设备/附件。

如果未来把 bootstrap 收敛为仓库命令，必须单独 PR、测试“非空库拒绝”和事务回滚，并经 Louis
批准；不要新增一个部署时自动运行的 seed 文件。

### 3.12 验收

在 App CVM：

```bash
sudo systemctl status pheno-lab --no-pager
sudo journalctl -u pheno-lab -n 100 --no-pager
curl -fsS http://127.0.0.1:3457/api/health/live

set -a
source /etc/pheno-lab/pheno-lab.env
set +a
curl -fsS \
  -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3457/api/health/ready
unset HEALTHCHECK_TOKEN
```

在本地电脑：

```bash
curl -I https://lab.szkl.com/
curl -fsS https://lab.szkl.com/api/health/live
```

再用浏览器完成：

1. 打开 `https://lab.szkl.com`，确认 HTTPS 和证书正常。
2. 使用真实管理员账号登录，确认组织隔离和角色正确。
3. 上传一个可删除的测试附件，确认 COS 产生对象且可从应用下载。
4. 删除测试数据，确认没有用测试对象污染正式实验。
5. 在 PostgreSQL 服务器执行一次备份并恢复到隔离测试库，不将“有备份文件”当作“可恢复”。

## 4. 后续快速更新

本节是现有生产环境的**唯一日常发布流程**。开始前必须满足：目标代码已合并到 `main`、GitHub
Actions 全绿、Louis 明确批准本次部署、migration 已人工审查为 expand/contract，且没有要求
修改 Nginx/systemd/COS/PostgreSQL/DNS。

每次发布使用新的 `YYYYMMDD-NNN`，同一天依次使用 `001`、`002`。不要复用、覆盖或删除已有
release ID。

### 4.1 只读预检

```bash
sudo -i

systemctl is-active pheno-lab.service
systemctl is-active nginx.service
readlink -f /srv/pheno-lab/current
git -C /srv/pheno-lab/source status --short --branch

cd /srv/pheno-lab/source
git fetch --prune origin
git switch main
git pull --ff-only origin main
git status --short --branch
git log -1 --oneline
```

`git status --short` 必须为空。发现生产 source 有本地修改、未知文件、非 `main` commit 或无法
fast-forward 时立即停止，问 Louis；禁止 `reset --hard`、stash 后强行部署或在服务器修代码。

### 4.2 选择 release ID，并只增量修改现有 APP_VERSION

先列出现有 release，再选择未使用的 ID：

```bash
find /srv/pheno-lab/releases \
  -mindepth 1 -maxdepth 1 -type d \
  -printf '%f\n' | sort

RELEASE_ID=YYYYMMDD-NNN
test "$RELEASE_ID" != 'YYYYMMDD-NNN'
test ! -e "/srv/pheno-lab/releases/$RELEASE_ID"
test ! -e "/tmp/pheno-lab-$RELEASE_ID.tar.gz"
test ! -e "/tmp/pheno-lab-$RELEASE_ID.tar.gz.sha256"
```

使用 `sudoedit /etc/pheno-lab/pheno-lab.env`，只把现有 `APP_VERSION=` 改成相同的
`$RELEASE_ID`。不要复制 env、不要新建 env、不要更改其他 secret。编辑后验证（不输出 secret）：

```bash
grep -x "APP_VERSION=$RELEASE_ID" /etc/pheno-lab/pheno-lab.env

cd /srv/pheno-lab/source/pheno-lab
set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

test "$APP_VERSION" = "$RELEASE_ID"
node node_modules/tsx/dist/cli.mjs scripts/validate-runtime-config.ts
```

如果在 artifact 发布前失败，恢复原 `APP_VERSION`，不要修改或轮换其他配置。

### 4.3 使用现有脚本构建和校验

```bash
cd /srv/pheno-lab/source/pheno-lab

./deploy/scripts/build-release.sh \
  "/tmp/pheno-lab-$RELEASE_ID.tar.gz"

(
  cd /tmp
  sha256sum --check \
    "pheno-lab-$RELEASE_ID.tar.gz.sha256"
)
```

脚本会重新执行 frozen install 和完整 `pnpm run verify`。任一检查失败都停止发布；不得修改
production source、跳过测试或手工打包。

### 4.4 发布

```bash
cd /srv/pheno-lab/source/pheno-lab

./deploy/scripts/deploy-release.sh \
  "/tmp/pheno-lab-$RELEASE_ID.tar.gz" \
  "$RELEASE_ID"
```

必须看到最终 `deployed <release-id>` 才算脚本成功。启动窗口中一次短暂 curl 失败不等于发布
失败；脚本会继续轮询 authenticated readiness。最终 readiness 失败时脚本自动切回上一代码
release，但数据库 migration 不会自动回滚。

### 4.5 发布后验收

```bash
systemctl status pheno-lab.service --no-pager
readlink -f /srv/pheno-lab/current
ss -lntp | grep ':3457'
curl -fsS http://127.0.0.1:3457/api/health/live

curl -fsS \
  -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3457/api/health/ready

curl -sS -o /dev/null \
  -w 'http=%{http_code} redirect=%{redirect_url}\n' \
  http://lab.szkl.com/
curl -fsS https://lab.szkl.com/api/health/live

journalctl -u pheno-lab.service -n 100 --no-pager
```

预期：`current` 指向本次 release；3457 只监听 `127.0.0.1`；liveness/readiness 成功；HTTP 301
到 HTTPS；公网 liveness 成功。涉及登录、上传、权限或用户流程的版本还必须做对应浏览器 smoke
test，并清理测试数据。

完成后清除当前 shell 中的敏感变量：

```bash
unset DATABASE_URL SESSION_SECRET INGEST_CRON_SECRET HEALTHCHECK_TOKEN
unset AI_CREDENTIAL_KEY COS_SECRET_ID COS_SECRET_KEY NODE_ENV APP_VERSION
unset RELEASE_ID
```

### 4.6 日常发布明确不做的事

普通发布不运行：目录/user/Deploy Key 初始化、数据库创建、production bootstrap、CAM/COS 配置、
Nginx/Certbot/systemd 安装、数据库 seed、备份目录创建或 Talent Platform 修改。

普通发布也不运行 data importer、`stage-*`、`seed-*`、`backfill-*` 或存量文件迁移；数据导入必须
使用独立 batchId、执行窗口、备份/恢复证据和验收流程。

如果功能需要上述变更，它不是“快速更新”，必须单独写变更计划、回滚步骤和验收清单，并先问
Louis。

## 5. 回滚和诊断

新版本在约 60 秒内未通过 readiness，脚本会让 `current` 指回上一 release 并重启旧代码。数据库 migration 不自动降级，
因此所有生产 migration 必须遵守 expand / contract，保持上一版代码兼容。

手动回滚前先确认明确的目标 release：

```bash
readlink -f /srv/pheno-lab/current
sudo find /srv/pheno-lab/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort

ROLLBACK_RELEASE=20260825-001
sudo ln -sfn "/srv/pheno-lab/releases/$ROLLBACK_RELEASE" /srv/pheno-lab/current.next
sudo mv -Tf /srv/pheno-lab/current.next /srv/pheno-lab/current
sudo systemctl restart pheno-lab
sudo systemctl status pheno-lab --no-pager
```

常用诊断命令：

```bash
sudo systemctl status pheno-lab --no-pager
sudo journalctl -u pheno-lab -n 200 --no-pager
sudo journalctl -u nginx -n 100 --no-pager
sudo nginx -t
sudo ss -lntp | grep -E ':(80|443|3457)\b'
readlink -f /srv/pheno-lab/current
df -h
free -h
```

| 现象               | 首先检查                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| Nginx 502          | `pheno-lab.service` 是否运行；3457 是否只监听 loopback                  |
| readiness 503      | PostgreSQL 私网连接、CVM 角色、COS 地域 / bucket 名和 `HeadBucket` 权限 |
| 启动立即失败       | `journalctl`；env 是否仍有示例 secret 或缺失值                          |
| 图片请求 500       | 当前 release 的 `.next/cache` owner 和 systemd `ReadWritePaths`         |
| 登录后反复回登录页 | HTTPS、`SESSION_COOKIE_SECURE=true`、反向代理头和系统时间               |

至少保留当前 release 和上一个已知可用 release。不要手动删除当前版本，也不要把 `.env`、数据库 dump 或附件放进 source / release。

## 6. 参考

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Certbot webroot](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)
- [腾讯云 CVM 实例角色](https://cloud.tencent.com/document/product/213/47668)
- [腾讯云 COS 内网访问](https://cloud.tencent.com/document/product/436/56556)
- [腾讯云 COS 最小权限指南](https://cloud.tencent.com/document/product/436/38618)
- [腾讯云备案](https://cloud.tencent.com/document/product/243/39038)
