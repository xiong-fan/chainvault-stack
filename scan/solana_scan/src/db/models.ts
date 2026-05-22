import { database } from './connection';
import logger from '../utils/logger';

export interface SolanaSlot {
  slot: number;
  block_hash?: string;
  parent_slot?: number;
  block_time?: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SolanaTransaction {
  id: number;
  slot: number;
  tx_hash: string;
  from_addr?: string;
  to_addr: string;
  token_mint?: string;
  amount: string;
  type: string;
  status: string;
  block_time?: number;
  created_at: string;
  updated_at?: string;
}

export interface Wallet {
  id: number;
  user_id: number;
  address: string;
  device?: string;
  path?: string;
  chain_type: string;
  wallet_type: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Token {
  id: number;
  chain_type: string;
  chain_id: number;
  token_address?: string;
  token_symbol: string;
  token_name?: string;
  token_type?: string | null;
  decimals: number;
  is_native: boolean;
  collect_amount: string;
  status: number;
  created_at: string;
  updated_at: string;
}

export interface SolanaTokenAccount {
  id: number;
  user_id?: number;
  wallet_id: number;
  wallet_address: string;
  token_mint: string;
  ata_address: string;
  created_at: string;
  updated_at: string;
}

/**
 * Solana槽位数据访问对象
 */
export class SolanaSlotDAO {
  /**
   * 获取槽位信息
   */
  async getSlot(slot: number): Promise<SolanaSlot | null> {
    try {
      const row = await database.get('SELECT * FROM solana_slots WHERE slot = ?', [slot]);
      return row || null;
    } catch (error) {
      logger.error('获取槽位失败', { slot, error });
      throw error;
    }
  }

  async getSlotsInRange(startSlot: number, endSlot: number): Promise<SolanaSlot[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM solana_slots WHERE slot >= ? AND slot <= ? ORDER BY slot',
        [startSlot, endSlot]
      );
      return rows;
    } catch (error) {
      logger.error('批量获取槽位失败', { startSlot, endSlot, error });
      throw error;
    }
  }

  /**
   * 获取最后扫描的槽位
   */
  async getLastScannedSlot(startSlot: number = 0): Promise<number | null> {
    try {
      const rows = await database.all(
        'SELECT slot FROM solana_slots WHERE slot >= ? ORDER BY slot ASC',
        [startSlot]
      );

      if (rows.length === 0) {
        return null;
      }

      let expectedSlot = startSlot;
      let lastContinuousSlot: number | null = null;
      for (const row of rows) {
        if (row.slot !== expectedSlot) {
          break;
        }
        lastContinuousSlot = row.slot;
        expectedSlot++;
      }

      return lastContinuousSlot;
    } catch (error) {
      logger.error('获取最后扫描槽位失败', { error });
      throw error;
    }
  }

  /**
   * 获取最近的槽位（排除跳过的槽位）
   */
  async getRecentSlots(limit: number = 100): Promise<SolanaSlot[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM solana_slots WHERE status != "skipped" ORDER BY slot DESC LIMIT ?',
        [limit]
      );
      return rows;
    } catch (error) {
      logger.error('获取最近槽位失败', { limit, error });
      throw error;
    }
  }

  /**
   * 获取最近的 confirmed 状态的槽位（用于重新验证）
   */
  async getRecentConfirmedSlots(limit: number): Promise<SolanaSlot[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM solana_slots WHERE status = "confirmed" ORDER BY slot DESC LIMIT ?',
        [limit]
      );
      return rows;
    } catch (error) {
      logger.error('获取最近confirmed槽位失败', { limit, error });
      throw error;
    }
  }

  /**
   * 检查槽位范围内是否有空槽
   */
  async checkForMissingSlots(startSlot: number, endSlot: number): Promise<number[]> {
    try {
      const existingSlots = await database.all(
        'SELECT slot FROM solana_slots WHERE slot >= ? AND slot <= ? ORDER BY slot',
        [startSlot, endSlot]
      );

      const missing: number[] = [];
      const existingSet = new Set(existingSlots.map((r: any) => r.slot));

      for (let slot = startSlot; slot <= endSlot; slot++) {
        if (!existingSet.has(slot)) {
          missing.push(slot);
        }
      }

      return missing;
    } catch (error) {
      logger.error('检查缺失槽位失败', { startSlot, endSlot, error });
      throw error;
    }
  }
}

/**
 * Solana交易数据访问对象
 */
export class SolanaTransactionDAO {
  /**
   * 获取需要进一步确认的Solana交易
   */
  async getPendingSolanaTransactions(): Promise<SolanaTransaction[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM solana_transactions WHERE status IN (?) ORDER BY slot ASC',
        ['confirmed']
      );
      return rows;
    } catch (error) {
      logger.error('获取待确认Solana交易失败', { error });
      throw error;
    }
  }

  /**
   * 根据槽位号获取交易
   */
  async getTransactionsBySlot(slot: number): Promise<SolanaTransaction[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM solana_transactions WHERE slot = ?',
        [slot]
      );
      return rows;
    } catch (error) {
      logger.error('根据槽位获取交易失败', { slot, error });
      throw error;
    }
  }
}

/**
 * 钱包数据访问对象
 */
export class WalletDAO {
  /**
   * 获取所有Solana钱包地址
   */
  async getAllSolanaWalletAddresses(): Promise<string[]> {
    try {
      const rows = await database.all(
        'SELECT DISTINCT address FROM wallets WHERE chain_type = ? AND is_active = 1',
        ['solana']
      );
      return rows.map((row: any) => row.address);
    } catch (error) {
      logger.error('获取所有Solana钱包地址失败', { error });
      throw error;
    }
  }

  async getAllSolanaWallets(): Promise<Wallet[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM wallets WHERE chain_type = ? AND is_active = 1',
        ['solana']
      );
      return rows;
    } catch (error) {
      logger.error('获取所有Solana钱包失败', { error });
      throw error;
    }
  }

  /**
   * 根据地址获取钱包信息
   */
  async getWalletByAddress(address: string): Promise<Wallet | null> {
    try {
      const row = await database.get(
        'SELECT * FROM wallets WHERE address = ? AND chain_type = ?',
        [address, 'solana']
      );
      return row || null;
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
   * 获取所有Solana代币
   */
  async getAllSolanaTokens(): Promise<Token[]> {
    try {
      const rows = await database.all(
        'SELECT * FROM tokens WHERE chain_type = ? AND status = 1',
        ['solana']
      );
      return rows;
    } catch (error) {
      logger.error('获取所有Solana代币失败', { error });
      throw error;
    }
  }

  /**
   * 根据Mint地址获取代币信息
   */
  async getTokenByMintAddress(mintAddress: string): Promise<Token | null> {
    try {
      const row = await database.get(
        'SELECT * FROM tokens WHERE chain_type = ? AND token_address = ? AND status = 1',
        ['solana', mintAddress]
      );
      return row || null;
    } catch (error) {
      logger.error('根据Mint地址获取代币失败', { mintAddress, error });
      throw error;
    }
  }

  /**
   * 获取Solana原生代币（SOL）
   */
  async getSolNativeToken(): Promise<Token | null> {
    try {
      const row = await database.get(
        'SELECT * FROM tokens WHERE chain_type = ? AND is_native = 1 AND status = 1',
        ['solana']
      );
      return row || null;
    } catch (error) {
      logger.error('获取SOL原生代币失败', { error });
      throw error;
    }
  }
}

/**
 * Solana代币账户数据访问对象（只读）
 * 注意：所有写操作必须通过 db_gateway 服务
 */
export class SolanaTokenAccountDAO {
  /**
   * 获取ATA到钱包地址的映射
   */
  async getATAToWalletMap(): Promise<Map<string, string>> {
    try {
      const rows = await database.all(
        'SELECT ata_address, wallet_address FROM solana_token_accounts'
      );
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.ata_address.toLowerCase(), row.wallet_address);
      }
      return map;
    } catch (error) {
      logger.error('获取ATA到钱包地址映射失败', { error });
      throw error;
    }
  }

  /**
   * 获取ATA到Token Mint的映射
   */
  async getATAToMintMap(): Promise<Map<string, string>> {
    try {
      const rows = await database.all(
        'SELECT ata_address, token_mint FROM solana_token_accounts'
      );
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.ata_address.toLowerCase(), row.token_mint);
      }
      return map;
    } catch (error) {
      logger.error('获取ATA到Mint映射失败', { error });
      throw error;
    }
  }
}

export class FundTaskDAO {
  /**
   * fund_rebalance 发出的 Solana 归集和手续费补给都是平台内部资金调度；
   * scanner 看到这些交易转入热钱包或用户地址时，不能再按用户充值写 deposit。
   */
  async getInternalTransferTaskByTxHash(txHash: string): Promise<{
    id: number;
    status: string;
    tx_hash?: string | null;
    metadata?: string | null;
  } | null> {
    try {
      const rows = await database.all(
        'SELECT id, status, tx_hash, metadata FROM fund_tasks WHERE chain_type = ?',
        ['solana']
      );
      const normalized = txHash.toLowerCase();

      return rows.find(row => {
        if (String(row.tx_hash || '').toLowerCase() === normalized) {
          return true;
        }

        try {
          const metadata = JSON.parse(row.metadata || '{}');
          return String(metadata.gasFundingTxHash || '').toLowerCase() === normalized;
        } catch {
          return false;
        }
      }) || null;
    } catch (error) {
      logger.error('查询 Solana 归集内部交易失败', { txHash, error });
      throw error;
    }
  }
}

// 导出DAO实例
export const solanaSlotDAO = new SolanaSlotDAO();
export const solanaTransactionDAO = new SolanaTransactionDAO();
export const walletDAO = new WalletDAO();
export const tokenDAO = new TokenDAO();
export const solanaTokenAccountDAO = new SolanaTokenAccountDAO();
export const fundTaskDAO = new FundTaskDAO();

// 导出数据库实例
export { database } from './connection';
