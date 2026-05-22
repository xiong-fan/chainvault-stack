/**
 * 部署两个 SPL Token 到本地 Solana 测试验证器（带 Metadata）
 * 使用 UMI 框架处理 Token Metadata
 */
import '../src/loadEnv';
import { Connection, Keypair } from '@solana/web3.js';
import { 
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  ExtensionType,
  getMintLen,
  mintTo, 
  getOrCreateAssociatedTokenAccount, 
  tokenMetadataInitializeWithRentTransfer,
  TOKEN_2022_PROGRAM_ID 
} from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, generateSigner, percentAmount, signerIdentity, some } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import { 
  createFungible,
  findMetadataPda 
} from '@metaplex-foundation/mpl-token-metadata';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';
import { sendAndConfirmTransaction, SystemProgram, Transaction } from '@solana/web3.js';

const connection = new Connection(process.env.SOLANA_DEVNET_RPC_URL || 'http://127.0.0.1:8899', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});
console.log('🔗 连接网络:', connection.rpcEndpoint);
function loadDevnetWallet(): Keypair {
  const privateKeyBase58 = process.env.SOLANA_DEVNET_PRIVATE_KEY;
  if (!privateKeyBase58) {
    throw new Error('请设置环境变量 SOLANA_DEVNET_PRIVATE_KEY');
  }

  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  console.log("👤 钱包地址:", keypair.publicKey.toBase58());
  return keypair;
}

async function createSplTokenWithMetaplexMetadata(
  payer: Keypair,
  decimals: number,
  name: string,
  symbol: string
) {
  console.log(`\n📦 正在创建 ${symbol}...`);

  const umi = createUmi(connection.rpcEndpoint);
  const umiKeypair = fromWeb3JsKeypair(payer);
  const umiSigner = createSignerFromKeypair(umi, umiKeypair);
  umi.use(signerIdentity(umiSigner));

  const mintSigner = generateSigner(umi);
  const metadataPda = findMetadataPda(umi, { mint: mintSigner.publicKey });

  // 本地 Metadata 程序对旧 createMetadataAccountV3 的 token standard 推断容易 panic。
  // createFungible/createV1 会让 mint 在同一笔交易里签名，并显式写入 Fungible 标准和 decimals。
  await createFungible(umi, {
    metadata: metadataPda,
    mint: mintSigner,
    authority: umiSigner,
    payer: umiSigner,
    updateAuthority: umiSigner.publicKey,
    name,
    symbol,
    uri: '',
    sellerFeeBasisPoints: percentAmount(0),
    creators: null,
    decimals: some(decimals),
    isMutable: true,
  }).sendAndConfirm(umi);

  console.log(`✅ ${symbol} Mint + Metadata 创建成功:`, mintSigner.publicKey);
  return toWeb3JsPublicKey(mintSigner.publicKey);
}

async function createToken2022WithInlineMetadata(
  payer: Keypair,
  decimals: number,
  name: string,
  symbol: string
) {
  const mintKeypair = Keypair.generate();
  // Token-2022 初始化 mint 时只预留固定扩展空间；metadata TLV 后续由官方 helper 追加并补租金。
  // 直接把 TokenMetadata 预分配进 mint 账户会让当前本地 Token-2022 程序在 InitializeMint 阶段判为 InvalidAccountData。
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  console.log(`\n📦 正在创建 ${symbol}...`);

  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID
    }),
    createInitializeMetadataPointerInstruction(
      mintKeypair.publicKey,
      payer.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      payer.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID
    )
  );

  await sendAndConfirmTransaction(connection, transaction, [payer, mintKeypair], {
    commitment: 'confirmed',
    maxRetries: 3
  });

  await tokenMetadataInitializeWithRentTransfer(
    connection,
    payer,
    mintKeypair.publicKey,
    payer.publicKey,
    payer.publicKey,
    name,
    symbol,
    '',
    [],
    {
      commitment: 'confirmed',
      maxRetries: 3
    },
    TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ ${symbol} Mint + Token-2022 Metadata 创建成功:`, mintKeypair.publicKey.toBase58());
  return mintKeypair.publicKey;
}

async function deployTokens() {
  try {
    const payer = loadDevnetWallet();

    const balance = await connection.getBalance(payer.publicKey);
    console.log('💵 当前余额:', (balance / 1e9).toFixed(2), 'SOL');

    // ==================== 创建带 Metadata 的 Token ====================
    console.log('\n🚀 开始部署带 Metadata 的 SPL Tokens...\n');

    const usdcMint = await createSplTokenWithMetaplexMetadata(
      payer,
      6,
      "Local USDC",
      "lUSDC"
    );

    const usdtMint = await createToken2022WithInlineMetadata(
      payer,
      6,
      "Local USDT",
      "lUSDT"
    );

    // 创建 ATA 并 Mint 代币
    console.log('\n🏦 创建 Token Account 并铸造测试代币...');

    // USDC
    const usdcATA = await getOrCreateAssociatedTokenAccount(
      connection, 
      payer, 
      usdcMint, 
      payer.publicKey
    );
    await mintTo(
      connection, 
      payer, 
      usdcMint, 
      usdcATA.address, 
      payer.publicKey, 
      1_000_000 * 10 ** 6
    );
    console.log(`✅ 已铸造 1,000,000 lUSDC`);

    // USDT (Token-2022)
    const usdtATA = await getOrCreateAssociatedTokenAccount(
      connection, 
      payer, 
      usdtMint, 
      payer.publicKey, 
      false, 
      'confirmed', 
      undefined, 
      TOKEN_2022_PROGRAM_ID
    );
    await mintTo(
      connection, 
      payer, 
      usdtMint, 
      usdtATA.address, 
      payer.publicKey, 
      1_000_000 * 10 ** 6, 
      undefined, 
      undefined, 
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`✅ 已铸造 1,000,000 lUSDT`);

    // 保存部署信息
    const tokenInfo = {
      deployedAt: new Date().toISOString(),
      payer: payer.publicKey.toBase58(),
      tokens: [
        { 
          symbol: 'lUSDC', 
          name: 'Local USDC', 
          mint: usdcMint.toBase58(), 
          decimals: 6, 
          tokenType: 'spl-token',
          ata: usdcATA.address.toBase58()
        },
        { 
          symbol: 'lUSDT', 
          name: 'Local USDT', 
          mint: usdtMint.toBase58(), 
          decimals: 6, 
          tokenType: 'spl-token-2022',
          ata: usdtATA.address.toBase58()
        }
      ]
    };

    const outputPath = path.join(__dirname, 'deployed-tokens.json');
    fs.writeFileSync(outputPath, JSON.stringify(tokenInfo, null, 2));

    console.log('\n✅ 部署完成！');
    console.log('📁 信息已保存到:', outputPath);
    console.log('\n📊 部署详情:');
    console.log(`  lUSDC Mint: ${usdcMint.toBase58()}`);
    console.log(`  lUSDT Mint: ${usdtMint.toBase58()}`);
    console.log(`  lUSDC ATA: ${usdcATA.address.toBase58()}`);
    console.log(`  lUSDT ATA: ${usdtATA.address.toBase58()}`);

  } catch (error) {
    console.error('❌ 部署失败:', error);
    process.exit(1);
  }
}

// 执行部署
deployTokens();
