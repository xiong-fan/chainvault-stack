import { database } from './connection';
import logger from '../utils/logger';


export interface Block {
  hash: string;
  parent_hash: string;
  number: string;
  timestamp: number;
  created_at: string;
  updated_at: string;
  status?: string;
}

export interface Transaction {
  id: number;
  block_hash: string;
  block_no: number;
  tx_hash: string;
  from_addr: string;
  to_addr: string;
  token_addr?: string;
  amount: string;
  type: string;
  status: string;
  confirmation_count?: number;
  created_at: string;
  updated_at?: string;
}

export interface Wallet {
  id: number;
  user_id: number;
  address: string;
  device: string;
  path: string;
  chain_type: string;
  created_at: string;
  updated_at: string;
}

export interface Token {
  id: number;
  chain_type: string;
  chain_id: number;
  token_address: string;
  token_symbol: string;
  token_name: string;
  decimals: number;
  is_native: boolean;
  collect_amount: string;
  status: number;
  created_at: string;
  updated_at: string;
}



/**
 * 区块数据访问对象
 */
export class BlockDAO {

  /**
   * 获取区块
   */
  async getBlock(hash: string): Promise<Block | null> {
    try {
      const row = await database.get('SELECT * FROM blocks WHERE hash = ?', [hash]);
      return row;
    } catch (error) {
      logger.error('获取区块失败', { hash, error });
      throw error;
    }
  }

  /**
   * 根据区块号获取区块（排除孤块）
   */
  async getBlockByNumber(number: number): Promise<Block | null> {
    try {
      const row = await database.get(
        'SELECT * FROM blocks WHERE number = ? AND status != "orphaned" ORDER BY created_at DESC LIMIT 1', 
        [number.toString()]
      );
      return row;
    } catch (error) {
      logger.error('根据区块号获取区块失败', { number, error });
      throw error;
    }
  }

  /**
   * 获取最近的区块（排除孤块）
   */
  async getRecentBlocks(limit: number = 100): Promise<Block[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM blocks WHERE status != "orphaned" ORDER BY CAST(number AS INTEGER) DESC LIMIT ?',
        [limit]
      );
      return rows;
    } catch (error) {
      logger.error('获取最近区块失败', { limit, error });
      throw error;
    }
  }

}


/**
 * 交易数据访问对象
 */
export class TransactionDAO {
  /**
   * 获取需要进一步确认的交易
   */
  async getPendingTransactions(): Promise<Transaction[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM transactions WHERE status IN (?, ?) ORDER BY block_no ASC',
        ['confirmed', 'safe'] // 获取 confirmed 和 safe 状态的交易
      );
      return rows;
    } catch (error) {
      logger.error('获取未确认交易失败', { error });
      throw error;
    }
  }

}

/**
 * 钱包数据访问对象
 */
export class WalletDAO {
  /**
   * 获取所有活跃 EVM 用户钱包地址
   */
  async getAllWalletAddresses(): Promise<string[]> {
    try {
      const rows = await database.all(
        'SELECT DISTINCT address FROM wallets WHERE chain_type = ? AND wallet_type = ? AND is_active = ?',
        ['evm', 'user', 1]
      );
      return rows.map(row => row.address.toLowerCase());
    } catch (error) {
      logger.error('获取活跃 EVM 用户钱包地址失败', { error });
      throw error;
    }
  }

  /**
   * 根据地址获取钱包信息
   */
  async getWalletByAddress(address: string): Promise<Wallet | null> {
    try {
      const row = await database.get('SELECT * FROM wallets WHERE LOWER(address) = LOWER(?)', [address]);
      return row;
    } catch (error) {
      logger.error('根据地址获取钱包失败', { address, error });
      throw error;
    }
  }
}

/**
 * 代币数据访问对象
 */
export class TokenDAO {
  /**
   * 获取所有支持的代币
   */
  async getAllTokens(): Promise<Token[]> {
    try {
      const rows = await database.all('SELECT * FROM tokens');
      return rows;
    } catch (error) {
      logger.error('获取所有代币失败', { error });
      throw error;
    }
  }

  /**
   * 根据合约地址和链ID获取代币信息
   */
  async getTokenByAddress(tokenAddress: string, chainType?: string, chainId?: number): Promise<Token | null> {
    try {
      let query = 'SELECT * FROM tokens WHERE LOWER(token_address) = LOWER(?)';
      let params: any[] = [tokenAddress];
      
      if (chainType && chainId) {
        query += ' AND chain_type = ? AND chain_id = ?';
        params.push(chainType, chainId);
      }
      
      const row = await database.get(query, params);
      return row;
    } catch (error) {
      logger.error('根据地址获取代币失败', { tokenAddress, chainType, chainId, error });
      throw error;
    }
  }

  /**
   * 根据链信息和代币符号获取代币
   */
  async getTokenBySymbol(chainType: string, chainId: number, tokenSymbol: string): Promise<Token | null> {
    try {
      const row = await database.get(
        'SELECT * FROM tokens WHERE chain_type = ? AND chain_id = ? AND token_symbol = ?',
        [chainType, chainId, tokenSymbol]
      );
      return row;
    } catch (error) {
      logger.error('根据符号获取代币失败', { chainType, chainId, tokenSymbol, error });
      throw error;
    }
  }

  /**
   * 获取指定链的所有代币
   */
  async getTokensByChain(chainId: number): Promise<Token[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM tokens WHERE chain_id = ? AND status = 1',
        [chainId]
      );
      return rows;
    } catch (error) {
      logger.error('获取链代币失败', { chainId, error });
      throw error;
    }
  }

  /**
   * 获取指定链的原生代币
   */
  async getNativeToken(chainId: number): Promise<Token | null> {
    try {
      const row = await database.get(
        'SELECT * FROM tokens WHERE chain_id = ? AND is_native = 1 AND status = 1',
        [chainId]
      );
      return row;
    } catch (error) {
      logger.error('获取原生代币失败', { chainId, error });
      throw error;
    }
  }
}

export class FundTaskDAO {
  /**
   * 归集服务给 ERC20 用户地址补 ETH gas 时，链上表现是“热钱包 -> 用户地址”的原生币转账。
   * 这不是用户充值，扫描器需要按 fund_tasks.metadata 里的 gasFundingTxHash 跳过入账。
   */
  async getGasFundingTaskByTxHash(txHash: string): Promise<{ id: number; status: string; metadata?: string } | null> {
    try {
      const rows = await database.all(
        'SELECT id, status, metadata FROM fund_tasks WHERE metadata IS NOT NULL'
      );
      const normalized = txHash.toLowerCase();
      return rows.find(row => {
        try {
          const metadata = JSON.parse(row.metadata || '{}');
          return String(metadata.gasFundingTxHash || '').toLowerCase() === normalized;
        } catch {
          return false;
        }
      }) || null;
    } catch (error) {
      logger.error('查询归集 gas 补给任务失败', { txHash, error });
      throw error;
    }
  }
}


// 导出DAO实例
export const blockDAO = new BlockDAO();
export const transactionDAO = new TransactionDAO();
export const walletDAO = new WalletDAO();
export const tokenDAO = new TokenDAO();
export const fundTaskDAO = new FundTaskDAO();

// 导出数据库实例
export { database } from './connection';
