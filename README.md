# skin-station

独立部署的 TypeScript 全栈皮肤站：Fastify、React/Vite、Node SQLite、SMTP。无 serverless 依赖。Node >=22.22；本地使用 Bun 安装依赖，运行时由 tsx 调用 Node。

```sh
bun install --frozen-lockfile
bun run build
bun run test
mkdir -p .local/textures
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .local/textures.pem
chmod 600 .local/textures.pem
SKIN_CONFIG=.local/config.json SMTP_USER=... SMTP_PASSWORD=... bun start
```

配置样例（路径相对于进程工作目录；秘密文件不要进 Git）：

```json
{
  "listen":"127.0.0.1", "port":8080,
  "origin":"https://skin.example.edu.cn",
  "database":".local/skin.sqlite", "textures":".local/textures",
  "signingKey":".local/textures.pem", "webRoot":"dist",
  "schools":{
    "jlu":{"emailDomains":["mails.jlu.edu.cn"],"issuerKey":".local/issuer.key","delegation":".local/delegation.json","roots":["SCHOOL_ROOT_PEER_ID"]}
  },
  "peers":[],
  "smtp":{"host":"smtp.example.edu.cn","port":465,"from":"noreply@example.edu.cn"}
}
```

反向代理 HTTPS 到本站；用户页面 `/portal/`。校邮域名须由社团核实配置。现支持单账号单游戏角色、验证码注册、邮件找回密码及会话撤销、Yggdrasil authenticate/refresh/validate/invalidate/signout、join/hasJoined/profile、PNG 上传、设备绑定的学生凭据。

学校根和 issuer 使用 `unionctl keygen` 生成；根签署 delegation 后可离线保存。签署示例：

```sh
unionctl delegate-students --key school-root.key --claims delegation-claims.json --out delegation.json
```

claims 必须含 `id, school, issuer(PeerId), not_before, expires_at, max_credential_seconds, evidence:["institutional_email"]`，时间为 Unix 秒。TS 站只按这份限定授权签名，不持有学校根。邮箱验证当前设置 180 天重新验证，凭据最长一小时且受委托期限限制。邮箱不是当前学籍证明。

可选 `mua` 配置：`apiRoot: "https://skin.mualliance.ltd/api/union"`、`hostPublicKey: "PEM..."`、`oauth: {"clientId":"...","clientSecretEnv":"MUA_CLIENT_SECRET"}`。成员站可配置 `member: {"keyEnv":"MUA_MEMBER_KEY"}`，支持签名控制请求、密钥轮换、UUID 映射与持久同步重试；详见工作区 `docs/mua.md`。尚不是可直接申请验收的完整 MUA 成员站。

数据库、游戏材质私钥和 issuer.key 需一起备份；账号 token 不写前端持久存储。备份工具见工作区 `scripts/backup-skin.py` 与 `scripts/verify-skin-backup.py`。此版已含披风上传与 MUA 联合黑名单管理操作；尚无多角色和完整 authlib-injector 兼容验收。MUA 仍需要实际申请与生产联调。
