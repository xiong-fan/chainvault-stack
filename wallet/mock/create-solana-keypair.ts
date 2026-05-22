import 'dotenv/config';

import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';


const privateKeyHex = process.env.WALLET_PRIVATE_KEY;
if (!privateKeyHex){
    throw new Error('❌ WALLET_PRIVATE_KEY 未找到！请检查 wallet/.env 文件是否正确配置');
}
// 转为 Uint8Array
const secretKey = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));

const keypair = Keypair.fromSecretKey(secretKey);

const keypairPath = path.join(process.cwd(), 'solana-payer-keypair.json');

fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));

console.log("✅ Keypair 文件已生成！");
console.log("路径:", keypairPath);
console.log("钱包地址 (Public Key):", keypair.publicKey.toBase58());