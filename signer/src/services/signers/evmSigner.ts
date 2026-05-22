import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, keccak256, parseUnits } from 'viem';
import { SignTransactionRequest, SignTransactionResponse } from '../../types/wallet';
import { DatabaseConnection } from '../../db/connection';

type HexString = `0x${string}`;
const EVM_BASE_PATH = "m/44'/60'/0'/0";

export interface EvmSignerDependencies {
  db: DatabaseConnection;
  mnemonic: string;
  password: string;
}

export async function signEvmTransaction(
  request: SignTransactionRequest,
  deps: EvmSignerDependencies
): Promise<SignTransactionResponse> {
  const { db, mnemonic, password } = deps;

  const addressInfo = await db.findAddressByAddress(request.address);
  if (!addressInfo) {
    const error = `地址 ${request.address} 未找到，请确保地址是通过此系统生成的`;
    console.error('❌ 地址查找失败:', error);
    return {
      success: false,
      error
    };
  }

  console.log('📍 派生路径:', addressInfo.path);

  const accountData = deriveEvmAccountFromPath(mnemonic, password, addressInfo.path);
  console.log('✅ 账户数据生成完成，地址:', accountData.address);

  if (accountData.address.toLowerCase() !== request.address.toLowerCase()) {
    const error = '地址验证失败，密码可能不正确';
    console.error('❌ 地址验证失败:');
    console.error('   生成的地址:', accountData.address);
    console.error('   请求的地址:', request.address);
    return {
      success: false,
      error
    };
  }

  const account = privateKeyToAccount(accountData.privateKey);
  console.log('✅ 签名账户地址:', account.address);

  const nonce = request.nonce;
  console.log('🔢 使用nonce:', nonce);

  const isEip1559 = request.type === 2;
  console.log('💡 交易类型:', isEip1559 ? 'EIP-1559' : 'Legacy', `(type=${request.type})`);

  console.log('💰 处理EVM链交易 :', request.chainId, '代币地址:', request.tokenAddress || '原生代币');
  console.log('💵 转账金额:', request.amount);
  console.log('⛽ Gas限制:', request.gas);

  const baseTransaction: Record<string, unknown> = {
    to: request.tokenAddress ? (request.tokenAddress as HexString) : (request.to as HexString),
    value: request.tokenAddress ? 0n : BigInt(request.amount),
    gas: request.gas
      ? BigInt(request.gas)
      : request.tokenAddress
        ? 100000n
        : 50000n,
    nonce,
    chainId: request.chainId
  };

  if (request.tokenAddress) {
    const encodedData = encodeErc20Transfer(request.to, request.amount);
    baseTransaction.data = encodedData;
    console.log('✅ ERC20数据编码完成:', encodedData);
  }

  let transaction: Record<string, unknown>;

  if (isEip1559) {
    console.log('🚀 构建EIP-1559交易');
    const maxPriorityFee = request.maxPriorityFeePerGas ? BigInt(request.maxPriorityFeePerGas) : getDefaultPriorityFee();
    const maxFeePerGas = request.maxFeePerGas ? BigInt(request.maxFeePerGas) : getDefaultMaxFeePerGas();

    console.log('💰 最大费用:', maxFeePerGas.toString());
    console.log('🎯 优先费用:', maxPriorityFee.toString());

    transaction = {
      ...baseTransaction,
      type: 'eip1559' as const,
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee
    };
    console.log('✅ EIP-1559交易构建完成');
  } else {
    console.log('🏁 构建Legacy交易');
    const gasPrice = request.gasPrice ? BigInt(request.gasPrice) : getDefaultGasPrice();
    console.log('💰 Gas价格:', gasPrice.toString());

    transaction = {
      ...baseTransaction,
      gasPrice
    };
    console.log('✅ Legacy交易构建完成');
  }

  console.log(
    '📝 最终交易对象:',
    JSON.stringify(transaction, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)
  );

  console.log('📝 开始签名交易...');
  const signedTransaction = await account.signTransaction(transaction);
  console.log('📄 已签名交易 (前64字符):', `${signedTransaction.substring(0, 64)}...`);

  const transactionHash = keccak256(signedTransaction as HexString);
  console.log('🔑 交易哈希:', transactionHash);

  return {
    success: true,
    data: {
      signedTransaction,
      transactionHash
    }
  };
}

export function deriveEvmAccountFromPath(
  mnemonic: string,
  password: string,
  path: string
): { address: string; privateKey: HexString } {
  const seed = mnemonicToSeedSync(mnemonic, password);   // mnemonicToSeed(mnemonic, passphrase?)  MetaMask 通常 passphrase 留空
  const hdKey = HDKey.fromMasterSeed(seed);  // 生成 Master Key（根密钥）
  const derivedKey = hdKey.derive(path); // 通过不同 Derivation Path 派生子密钥


  if (!derivedKey.privateKey) {
    throw new Error('无法派生私钥');
  }

  const privateKeyHex = `0x${Buffer.from(derivedKey.privateKey).toString('hex')}` as HexString;
  const account = privateKeyToAccount(privateKeyHex);

  return {
    address: account.address,
    privateKey: privateKeyHex
  };
}

export function deriveEvmAccountFromIndex(
  mnemonic: string,
  password: string,
  index: string
): { address: string; privateKey: HexString; path: string } {
  const path = getEvmDerivationPath(index);
  const { address, privateKey } = deriveEvmAccountFromPath(mnemonic, password, path);
  return { address, privateKey, path };
}

export function getEvmDerivationPath(index: string): string {
  return `${EVM_BASE_PATH}/${index}`;
}

function encodeErc20Transfer(to: string, amount: string): HexString {
  const methodId = '0xa9059cbb';

  const encodedParams = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' }
    ],
    [to as HexString, BigInt(amount)]
  );

  return `${methodId}${encodedParams.slice(2)}` as HexString;
}

function getDefaultPriorityFee(): bigint {
  return parseUnits('2', 9);
}

function getDefaultMaxFeePerGas(): bigint {
  return parseUnits('30', 9);
}

function getDefaultGasPrice(): bigint {
  return parseUnits('25', 9);
}
