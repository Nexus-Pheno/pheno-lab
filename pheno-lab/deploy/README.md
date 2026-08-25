# Pheno Lab 腾讯云部署手册

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
├─ source/                         # ubuntu 所有的 Git 工作区
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

```bash
getent passwd pheno >/dev/null || \
  sudo useradd --system --home /var/lib/pheno-lab --shell /usr/sbin/nologin pheno

sudo install -d -m 0750 -o ubuntu -g pheno /srv/pheno-lab/source
sudo install -d -m 0750 -o root -g pheno /srv/pheno-lab/releases /etc/pheno-lab
sudo usermod -aG pheno ubuntu
```

退出 SSH 并重新登录，使新组生效：

```bash
id
namei -l /srv/pheno-lab/source
```

不创建 `/var/lib/pheno-lab/uploads` 或 `/var/lib/pheno-lab/backups`。`pheno` 用户的 home 字段仅是系统身份元数据，
`useradd` 没有使用 `--create-home`。

### 3.4 为 CVM 配置 GitHub 只读拉取权限

私有仓库推荐使用这台 CVM 专用的只读 Deploy key：

```bash
ssh-keygen -t ed25519 \
  -f /home/ubuntu/.ssh/pheno_lab_deploy \
  -C 'pheno-lab-production-cvm'
cat /home/ubuntu/.ssh/pheno_lab_deploy.pub
```

把公钥添加到 GitHub 仓库的 **Settings → Deploy keys → Add deploy key**，不勾选写权限。
然后记录 GitHub 主机密钥并测试：

```bash
ssh-keyscan -t ed25519 github.com >> /home/ubuntu/.ssh/known_hosts
chmod 0600 /home/ubuntu/.ssh/known_hosts
ssh -T -i /home/ubuntu/.ssh/pheno_lab_deploy git@github.com
```

GitHub 通常会返回“认证成功但不提供 shell”，这个测试仍可能以状态码 1 结束。
这个项目的 SSH clone URL 是 `git@github.com:Nexus-Pheno/pheno-lab.git`：

```bash
GIT_SSH_COMMAND='ssh -i /home/ubuntu/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes' \
  git clone git@github.com:Nexus-Pheno/pheno-lab.git /srv/pheno-lab/source

git -C /srv/pheno-lab/source config core.sshCommand \
  'ssh -i /home/ubuntu/.ssh/pheno_lab_deploy -o IdentitiesOnly=yes'
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

```bash
sudo install -m 0640 -o root -g pheno \
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

### 3.8 安装 systemd 单元

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

用 ACME webroot 签发证书，不需要停止整台服务器的 Nginx，不会主动中断同机其他站点。
先创建临时 HTTP vhost：

```bash
sudo install -d -m 0755 -o root -g root /var/www/certbot/.well-known/acme-challenge
sudo tee /etc/nginx/conf.d/pheno-lab.conf >/dev/null <<'NGINX'
server {
    listen 80;
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
  --email YOUR_EMAIL \
  --agree-tos --no-eff-email

sudo install -m 0644 \
  /srv/pheno-lab/source/pheno-lab/deploy/nginx/pheno-lab.conf.example \
  /etc/nginx/conf.d/pheno-lab.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

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

### 3.11 验收

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

每次发布使用新的 `YYYYMMDD-NNN`，同一天依次使用 `001`、`002`。

```bash
cd /srv/pheno-lab/source
git status --short
git fetch --prune origin
git switch main
git pull --ff-only origin main

cd /srv/pheno-lab/source/pheno-lab
set -a
source /etc/pheno-lab/pheno-lab.env
set +a
export NODE_ENV=production

RELEASE_ID=20260825-002
./deploy/scripts/build-release.sh "/tmp/pheno-lab-$RELEASE_ID.tar.gz"
sudo ./deploy/scripts/deploy-release.sh \
  "/tmp/pheno-lab-$RELEASE_ID.tar.gz" "$RELEASE_ID"

unset DATABASE_URL SESSION_SECRET INGEST_CRON_SECRET HEALTHCHECK_TOKEN \
  AI_CREDENTIAL_KEY COS_SECRET_ID COS_SECRET_KEY
```

如果 `git status --short` 非空，停止发布并查清服务器本地改动；不要在生产主机直接修改代码。

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
