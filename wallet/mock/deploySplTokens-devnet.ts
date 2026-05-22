/**
 * 部署两个 SPL Token 到本地 Solana 测试验证器
 *
 * 运行前确保:
 * 1. solana-test-validator 已启动
 * 2. 已安装 @solana/web3.js 和 @solana/spl-token
 *
 * 使用方法:
 * ts-node src/scripts/deploySplTokens.ts
 * solana airdrop 100 5eY3Di9JfGPDz4J87nLgkRsBb2RELfhN3Yc5Lh2Cosui --url http://127.0.0.1:8899
 * solana balance 5eY3Di9JfGPDz4J87nLgkRsBb2RELfhN3Yc5Lh2Cosui --url http://127.0.0.1:8899
 * 
 */
import '../src/loadEnv';  // 加载 .env 环境变量
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';

// 连接到本地测试验证器

console.log("rpc_url: ", process.env.SOLANA_DEVNET_RPC_URL);
const connection = new Connection(process.env.SOLANA_DEVNET_RPC_URL || '', {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,   // 60秒（单位：毫秒）
    });

// 从环境变量读取（推荐）
function loadDevnetWallet(): Keypair {
  const privateKeyBase58 = process.env.SOLANA_DEVNET_PRIVATE_KEY;
  
  if (!privateKeyBase58) {
    throw new Error('请设置环境变量 SOLANA_DEVNET_PRIVATE_KEY');
  }

  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  
  console.log("wallet address", keypair.publicKey.toBase58());
  return keypair;
}

async function deployTokens() {
  try {
    // console.log('🚀 开始部署 SPL Tokens...\n');

    // 加载钱包
    const payer = loadDevnetWallet();

    console.log('💰 Payer 地址:', payer.publicKey.toBase58());

    // 检查余额
    const balance = await connection.getBalance(payer.publicKey);
    console.log('💵 Payer 余额:', balance / 1e9, 'SOL\n');

    if (balance === 0) {
      console.log('⚠️  余额不足，正在空投 SOL...');
      const airdropSignature = await connection.requestAirdrop(
        payer.publicKey,
        2 * 1e9 // 2 SOL
      );
      console.log("xxxxx");
      await connection.confirmTransaction(airdropSignature);
      console.log('✅ 空投成功\n');
    }

    // ==================== 动态生成新的 Mint Keypair ====================
    console.log('\n🔑 正在为本次部署生成新的 Mint Keypair...');

    const usdcMintKeypair = Keypair.generate();
    console.log('✅ USDC Mint 地址:', usdcMintKeypair.publicKey.toBase58());

    const usdtMintKeypair = Keypair.generate();
    console.log('✅ USDT Mint 地址:', usdtMintKeypair.publicKey.toBase58());
    // =================================================================

    // 部署第一个 Token (USDC)
    console.log('\n📦 部署 Token 1: Mock USDC');
    const usdcMint = await createMint(
      connection,
      payer,
      payer.publicKey,      // mint authority
      payer.publicKey,      // freeze authority
      6,                    // decimals (USDC 使用 6 位小数)
      usdcMintKeypair       // 使用指定的 mint keypair
    );
    console.log('✅ USDC Mint 地址:', usdcMint.toBase58());

    // 部署第二个 Token (USDT) - 使用 Token2022 程序
    console.log('\n📦 部署 Token 2: Mock Token2022 USDT');
    const usdtMint = await createMint(
      connection,
      payer,
      payer.publicKey,      // mint authority
      payer.publicKey,      // freeze authority
      6,                    // decimals (USDT 使用 6 位小数)
      usdtMintKeypair,      // 使用指定的 mint keypair
      undefined,            // multisig
      TOKEN_2022_PROGRAM_ID // 使用 Token2022 程序
    );
    console.log('✅ USDT (Token2022) Mint 地址:', usdtMint.toBase58());

    // 创建 token account 并铸造一些代币给 payer（用于测试）
    console.log('\n🏦 为 Payer 创建 Token Accounts 并铸造代币...');

    const usdcTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      payer.publicKey
    );
    console.log('USDC Token Account:', usdcTokenAccount.address.toBase58());

    await mintTo(
      connection,
      payer,
      usdcMint,
      usdcTokenAccount.address,
      payer.publicKey,
      1000000 * 1e6 // 1,000,000 USDC
    );
    console.log('✅ 铸造 1,000,000 USDC');

    // 对于 Token2022，需要指定 programId 参数
    const usdtTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdtMint,
      payer.publicKey,
      false,                  // allowOwnerOffCurve
      'confirmed',            // commitment
      undefined,              // confirmOptions
      TOKEN_2022_PROGRAM_ID  // programId - 使用 Token2022 程序
    );
    console.log('USDT (Token2022) Token Account:', usdtTokenAccount.address.toBase58());

    await mintTo(
      connection,
      payer,
      usdtMint,
      usdtTokenAccount.address,
      payer.publicKey,
      1000000 * 1e6,         // 1,000,000 USDT
      undefined,             // multiSigners
      undefined,             // confirmOptions
      TOKEN_2022_PROGRAM_ID  // programId - 使用 Token2022 程序
    );
    console.log('✅ 铸造 1,000,000 USDT (Token2022)');

    // 保存 mint 地址到文件
    const tokenInfo = {
      payer: payer.publicKey.toBase58(),
      tokens: [
        {
          symbol: 'USDC',
          name: 'USD Coin (Test)',
          mint: usdcMint.toBase58(),
          decimals: 6,
          payerTokenAccount: usdcTokenAccount.address.toBase58(),
          tokenType: 'spl-token'
        },
        {
          symbol: 'USDT',
          name: 'Tether USD (Test)',
          mint: usdtMint.toBase58(),
          decimals: 6,
          payerTokenAccount: usdtTokenAccount.address.toBase58(),
          tokenType: 'spl-token-2022'
        }
      ]
    };

    const outputPath = path.join(__dirname, 'deployed-tokens.json');
    fs.writeFileSync(outputPath, JSON.stringify(tokenInfo, null, 2));
    console.log(`\n📝 Token 信息已保存到: ${outputPath}`);

    console.log('\n✅ 所有 Token 部署完成！');
    console.log('\n📋 Token 摘要:');
    console.log('─'.repeat(60));
    tokenInfo.tokens.forEach(token => {
      console.log(`${token.symbol}:`);
      console.log(`  Mint: ${token.mint}`);
      console.log(`  Decimals: ${token.decimals}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ 部署失败:', error);
    throw error;
  }
}

// 执行部署
deployTokens()
  .then(() => {
    console.log('🎉 部署脚本执行完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 部署脚本执行失败:', error);
    process.exit(1);
  });
