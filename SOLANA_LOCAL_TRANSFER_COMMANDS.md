---
title: SOLANA_LOCAL_TRANSFER_COMMANDS
type: note
permalink: cex-wallet/solana-local-transfer-commands
---

# Solana 本地网转账常用命令

本文档整理本地 Solana 测试网中，从一个钱包地址向另一个钱包地址转 SOL、普通 SPL Token、SPL Token 2022 的常用命令。命令默认在本仓库根目录或 `wallet/` 目录执行，RPC 使用本地网 `http://127.0.0.1:8899`。

## 1. 本地示例信息

当前本地部署记录里常见的测试资产如下：

| 类型 | 名称 | Mint / 地址 | decimals | token program |
| --- | --- | --- | --- | --- |
| SOL | 原生 SOL | 无 mint | 9 | System Program |
| SPL Token | lUSDC | `GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT` | 6 | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| SPL Token 2022 | lUSDT | `CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj` | 6 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |

示例转账地址：

```bash
FROM_OWNER=5eY3Di9JfGPDz4J87nLgkRsBb2RELfhN3Yc5Lh2Cosui
TO_OWNER=21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX
RPC_URL=http://127.0.0.1:8899
```

业务说明：

- `FROM_OWNER` 是转出方钱包 owner 地址，真正发起转账时必须有它对应的私钥文件。
- `TO_OWNER` 是接收方钱包 owner 地址。接收 SPL Token 时，链上实际收款账户通常是这个 owner 派生出来的 ATA。
- SOL 是 Solana 原生币，直接转到 owner 地址。
- SPL Token 和 SPL Token 2022 都是代币资产，转账时必须指定 mint，并且接收方通常需要对应 mint 的 ATA。

## 2. 前置检查

### 2.1 检查本地 Solana 节点是否运行

```bash
solana cluster-version --url http://127.0.0.1:8899
```

技术说明：

- 这个命令会连接本地 RPC，确认 local validator 是否可用。
- 如果连接失败，说明本地链没有启动或 RPC 地址不对。

如果本地链没有启动，可以在仓库根目录执行：

```bash
./start_solana_localnet.sh
```

### 2.2 检查 keypair 文件对应的钱包地址

如果你准备用 `wallet/solana-payer-keypair.json` 作为转出方私钥：

```bash
solana address -k wallet/solana-payer-keypair.json
```

如果你当前已经在 `wallet/` 目录下：

```bash
solana address -k solana-payer-keypair.json
```

技术说明：

- `solana address -k` 不会打印私钥，只会根据 keypair 文件计算公钥地址。
- 输出地址必须等于转出方钱包地址，才能从该钱包转出 SOL 或代币。
- 不能从公钥反推出私钥；如果输出不是你要的转出钱包，就必须找到正确的 keypair 文件或重新部署测试资产。

### 2.3 检查转出方 SOL 余额

```bash
solana balance 5eY3Di9JfGPDz4J87nLgkRsBb2RELfhN3Yc5Lh2Cosui --url http://127.0.0.1:8899
```

业务说明：

- SOL 余额用于支付交易手续费。
- 创建接收方 ATA 时，也需要由交易 payer 支付租金。
- 本地网可以使用 airdrop 补 SOL；正式网不能这样做。

### 2.4 本地网给地址空投 SOL

```bash
solana airdrop 1 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX --url http://127.0.0.1:8899
```

业务说明：

- 这个命令只适用于本地网或测试网。
- 当接收方地址提示 `The recipient address is not funded` 时，可以先给接收方空投一点 SOL，让 owner 账户在本地链上存在。

## 3. SOL 转账

### 3.1 从一个钱包向另一个钱包转 SOL

在仓库根目录执行：

```bash
solana transfer \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  1 \
  --from wallet/solana-payer-keypair.json \
  --allow-unfunded-recipient \
  --url http://127.0.0.1:8899
```

如果你当前在 `wallet/` 目录下：

```bash
solana transfer \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  1 \
  --from solana-payer-keypair.json \
  --allow-unfunded-recipient \
  --url http://127.0.0.1:8899
  
上面这个命令会报错：Error: Dynamic program error: No default signer found, run "solana-keygen new -o /Users/tangao/.config/solana/id.json" to create a new one
这个错误的意思是：Solana CLI 在构造交易时找不到“默认签名者 / 默认 fee payer”。

  你命令里虽然传了：

  --from solana-payer-keypair.json

  但当前 Solana CLI 的 transfer 仍然会默认从 CLI config 的 keypair 取 fee payer。你的机器上没有默认 keypair：

  /Users/tangao/.config/solana/id.json

  所以报：

  No default signer found

  原因
  --from 表示资金来源账户，但不一定等于 fee payer。CLI 仍会找默认 keypair 作为交易费支付者。你没有默认 keypair，就失败了。

  直接修复命令
  你这次转账可以显式指定 --fee-payer，让同一个 keypair 既作为转出账户，也作为手续费支付账户：

  solana transfer \
    21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
    23 \
    --from solana-payer-keypair.json \
    --fee-payer solana-payer-keypair.json \
    --allow-unfunded-recipient \
    --url http://127.0.0.1:8899

  或者更常用一点，直接用 --keypair 设置默认签名 keypair：

  solana transfer \
    21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
    23 \
    --keypair solana-payer-keypair.json \
    --allow-unfunded-recipient \
    --url http://127.0.0.1:8899

  如果你想同时明确 source 和 fee payer，用第一种更清楚。

  长期修复
  你也可以设置 Solana CLI 默认 keypair：

  solana config set --keypair solana-payer-keypair.json
  solana config set --url http://127.0.0.1:8899

  然后以后命令可以简化成：

  solana transfer \
    21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
    23 \
    --allow-unfunded-recipient

  不建议现在按报错去执行
  报错提示你：

  solana-keygen new -o /Users/tangao/.config/solana/id.json

  这个只是创建一个新的默认 keypair。新 keypair 默认没钱，创建后你再转账还是可能因为余额不足失败。你当前已经有 solana-payer-keypair.json，直接让它做 --fee-payer 更符合你的场景。

  可以先检查这个 payer 是否有余额：

  solana balance --keypair solana-payer-keypair.json --url http://127.0.0.1:8899

  如果余额够，再执行带 --fee-payer 的 transfer。


```

业务说明：

- 这里的 `1` 表示转 `1 SOL`，不是 lamports。
- `--from` 指定转出方 keypair 文件。
- `--allow-unfunded-recipient` 允许转给尚未 funded 的新地址，适合本地测试。

### 3.2 查看 SOL 余额

查看转出方：

```bash
solana balance 5eY3Di9JfGPDz4J87nLgkRsBb2RELfhN3Yc5Lh2Cosui --url http://127.0.0.1:8899
```

查看接收方：

```bash
solana balance 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX --url http://127.0.0.1:8899
```

技术说明：

- SOL 余额直接挂在 owner 地址上。
- SPL Token 余额不在 owner 地址本身，而是在 owner 对应 mint 的 ATA 上。

## 4. 普通 SPL Token 转账

本地普通 SPL Token 示例：

```bash
SPL_MINT=GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT
```

### 4.1 转 100 个普通 SPL Token

在仓库根目录执行：

```bash
spl-token transfer \
  GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT \
  100 \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --fund-recipient \
  --owner wallet/solana-payer-keypair.json \
  --url http://127.0.0.1:8899
```

如果你当前在 `wallet/` 目录下：

```bash
spl-token transfer \
  GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT \
  100 \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --fund-recipient \
  --owner solana-payer-keypair.json \
  --url http://127.0.0.1:8899
```

业务说明：

- 第一个参数是代币 mint 地址。
- `100` 表示转 100 个展示单位。CLI 会按 mint 的 decimals 换算成链上最小单位。
- `--owner` 是转出方 owner 的 keypair。
- `--fund-recipient` 表示如果接收方没有该 mint 的 ATA，就自动创建 ATA。

技术说明：

- 普通 SPL Token 使用 Token Program：`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`。
- 接收方看到的 token 余额实际记录在 ATA 中，不是直接记录在 owner 地址中。

### 4.2 如果接收方未 funded

如果遇到：

```text
The recipient address is not funded. Add `--allow-unfunded-recipient` to complete the transfer.
```

可以先给接收方空投 SOL：

```bash
solana airdrop 1 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX --url http://127.0.0.1:8899
```

也可以在转账命令里加：

```bash
--allow-unfunded-recipient
```

完整命令：

```bash
spl-token transfer \
  GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT \
  100 \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --fund-recipient \
  --allow-unfunded-recipient \
  --owner wallet/solana-payer-keypair.json \
  --url http://127.0.0.1:8899
```

建议：

- 本地测试时优先先给接收方 airdrop 一点 SOL，后续查看账户和调试扫描更直观。
- `--allow-unfunded-recipient` 适合临时绕过 CLI 的保护。

## 5. SPL Token 2022 转账

本地 SPL Token 2022 示例：

```bash
TOKEN_2022_MINT=CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj
TOKEN_2022_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### 5.1 转 100 个 SPL Token 2022

在仓库根目录执行：

```bash
spl-token transfer \
  CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj \
  100 \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --fund-recipient \
  --allow-unfunded-recipient \
  --owner wallet/solana-payer-keypair.json \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

如果你当前在 `wallet/` 目录下：

```bash
spl-token transfer \
  CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj \
  100 \
  21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --fund-recipient \
  --allow-unfunded-recipient \
  --owner solana-payer-keypair.json \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

业务说明：

- Token-2022 和普通 SPL Token 的转账命令很像，但必须指定 `--program-id`。
- 如果 mint 是 Token-2022，但是命令没有指定 Token-2022 program，CLI 可能会按普通 SPL Token 处理，导致找不到账户或 owner 不匹配。

技术说明：

- Token-2022 Program ID 是：`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`。
- 本项目的 Solana 代币配置里，`token_type = spl-token-2022` 的 mint 应该使用这个 program。

## 6. 查看 SPL Token 账户和余额

### 6.1 查看某个 owner 下所有普通 SPL Token 账户

```bash
spl-token accounts \
  --owner 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --url http://127.0.0.1:8899
```

业务说明：

- 这个命令列出 owner 地址下的普通 SPL Token ATA 和余额。
- 如果你刚转了普通 `lUSDC`，这里应该能看到对应 mint 和余额。

### 6.2 查看某个普通 SPL Token 的余额

```bash
spl-token balance \
  GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT \
  --owner 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --url http://127.0.0.1:8899
```

技术说明：

- `balance` 查询的是指定 owner 在指定 mint 下的 ATA 余额。
- 如果 ATA 不存在，通常会返回找不到账户或余额为 0 的相关提示。

### 6.3 查看 Token-2022 账户

```bash
spl-token accounts \
  --owner 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

### 6.4 查看某个 Token-2022 的余额

```bash
spl-token balance \
  CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj \
  --owner 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

业务说明：

- 查 Token-2022 时也要带 `--program-id`。
- 普通 SPL Token 和 Token-2022 的 ATA 派生时使用的 token program 不同，不能混用。

## 7. 查看交易状态

转账成功后 CLI 会输出交易签名。可以用下面命令确认：

```bash
solana confirm -v <TX_SIGNATURE> --url http://127.0.0.1:8899
```

查看交易详情：

```bash
solana transaction <TX_SIGNATURE> --url http://127.0.0.1:8899
```

技术说明：

- `confirm -v` 适合快速确认交易是否落链。
- `transaction` 能看到交易指令、账户列表和执行结果，排查转账失败时更有用。

## 8. 查看 mint 信息

### 8.1 普通 SPL Token mint 信息

```bash
spl-token display \
  GqsCFxb5sUYGBqgmkX3bguATMV9j9TAex7WBUPcoXejT \
  --url http://127.0.0.1:8899
```

### 8.2 Token-2022 mint 信息

```bash
spl-token display \
  CG3BcE743FWzWjF5tNv4vkVTQZ2fo5PrJic8ick87rPj \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

业务说明：

- mint 信息里可以确认 decimals、mint authority、supply 等关键字段。
- 本项目新增 Solana 代币配置时，后端会读取 mint 和 metadata，确认 token type、symbol、name、decimals。

## 9. 常见问题

### 9.1 keypair 地址和转出钱包不一致

现象：

```bash
solana address -k wallet/solana-payer-keypair.json
```

输出不是你想转出的地址。

原因：

- keypair 文件里保存的是另一个钱包的私钥。
- 不能用公钥地址反推出私钥。

处理：

- 找到转出钱包对应的 keypair 文件。
- 如果是本地测试资产，可以重新用当前 keypair 部署或 mint 测试 token。
- 不要把私钥内容提交到 Git，也不要粘贴到聊天或日志里。

### 9.2 The recipient address is not funded

现象：

```text
The recipient address is not funded. Add `--allow-unfunded-recipient` to complete the transfer.
```

原因：

- 接收方 owner 地址在本地链上还没有 SOL 账户余额。
- CLI 默认保护你不要误转给一个没有 funded 的地址。

处理方式一，推荐本地测试使用：

```bash
solana airdrop 1 21YZUgx5DwsaTUEQVeouPwaav7qoRuRvDdbASVHLGuKX --url http://127.0.0.1:8899
```

处理方式二，转账时允许未 funded 接收方：

```bash
--allow-unfunded-recipient
```

### 9.3 Recipient ATA 不存在

现象：

- SPL Token 转账失败，提示找不到接收方 token account。

原因：

- 接收方 owner 还没有这个 mint 对应的 ATA。

处理：

```bash
--fund-recipient
```

业务说明：

- `--fund-recipient` 会帮接收方创建 ATA。
- 创建 ATA 的租金由交易 payer 支付。

### 9.4 普通 SPL Token 和 Token-2022 混用

现象：

- mint 存在，但转账或查余额失败。
- 报 owner 不匹配、账户不存在、program 不匹配等错误。

原因：

- 普通 SPL Token 和 Token-2022 使用不同 token program。

处理：

- 普通 SPL Token 不需要加 Token-2022 program id。
- Token-2022 必须加：

```bash
--program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### 9.5 Shell 换行反斜杠后面不能有空格

错误写法：

```bash
--owner solana-payer-keypair.json \ 
```

正确写法：

```bash
--owner solana-payer-keypair.json \
```

技术说明：

- 反斜杠必须是行尾最后一个字符。
- 如果反斜杠后面有空格，shell 可能不会把下一行当作同一条命令的一部分。

## 10. 推荐排查顺序

当转账失败时，建议按下面顺序检查：

1. RPC 是否可用：

```bash
solana cluster-version --url http://127.0.0.1:8899
```

2. keypair 是否对应转出钱包：

```bash
solana address -k wallet/solana-payer-keypair.json
```

3. 转出方是否有 SOL 支付手续费：

```bash
solana balance <FROM_OWNER> --url http://127.0.0.1:8899
```

4. 普通 SPL Token 是否能查到 mint：

```bash
spl-token display <SPL_MINT> --url http://127.0.0.1:8899
```

5. Token-2022 是否带了 program id：

```bash
spl-token display <TOKEN_2022_MINT> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```

6. 接收方是否 funded：

```bash
solana balance <TO_OWNER> --url http://127.0.0.1:8899
```

7. 接收方是否已有对应 token account：

```bash
spl-token accounts --owner <TO_OWNER> --url http://127.0.0.1:8899
```

8. 如果是 Token-2022：

```bash
spl-token accounts \
  --owner <TO_OWNER> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --url http://127.0.0.1:8899
```