import { DatabaseConnection } from '../db/connection';
import { SignerClient } from './signerClient';
import { getDbGatewayClient } from './dbGatewayClient';

export type BroadcastNonceState =
  | 'ready'
  | 'skip'
  | 'diagnostic';

export interface BroadcastNonceCheckResult {
  state: BroadcastNonceState;
  address: string;
  chainId: number;
  chainPendingNonce: number;
  dbNonce: number;
  effectiveNonce: number;
  reason?: string;
  openWithdraws: {
    id: number;
    status: string;
    nonce: number | null;
    tx_hash: string | null;
  }[];
}

export interface HotWalletNonceDiagnostic {
  address: string;
  chainId: number;
  chainType: 'evm';
  dbNonce: number;
  chainPendingNonce: number | null;
  state: BroadcastNonceState | 'error';
  reason?: string;
  error?: string;
  openWithdraws: {
    id: number;
    user_id: number;
    status: string;
    nonce: number | null;
    tx_hash: string | null;
    amount: string;
    token_id: number;
    token_symbol?: string | null;
    to_address: string;
    error_message?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }[];
  queuedWithdraws: {
    id: number;
    user_id: number;
    status: string;
    amount: string;
    token_id: number;
    token_symbol?: string | null;
    to_address: string;
    error_message?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }[];
  suggestedActions: string[];
}

/**
 * 热钱包管理服务，支持高并发提现场景下的 nonce 管理
 */
export class HotWalletService {
  private db: DatabaseConnection;
  private signerClient: SignerClient;
  private dbGatewayClient = getDbGatewayClient();

  constructor(db: DatabaseConnection) {
    this.db = db;
    this.signerClient = new SignerClient();
  }

  /**
   * 获取链上 pending nonce。pending 会包含已广播但未确认交易，适合提现签名前对齐。
   */
  async getPendingNonceFromChain(address: string, chainId: number): Promise<number> {
    const { chainConfigManager } = await import('../utils/chains');
    return await chainConfigManager.getNonce(address, chainId);
  }

  /**
   * 获取当前可用 nonce（不递增）。
   * EVM 提现必须用 max(本地 DB nonce, 链上 pending nonce)，避免本地旧值导致 nonce too low。
   */
  async getCurrentNonce(address: string, chainId: number): Promise<number> {
    const currentNonce = await this.db.getCurrentNonce(address, chainId);
    console.log('🔢 EVM nonce 本地值:', { address, chainId, currentNonce });

    try {
      const chainNonce = await this.getPendingNonceFromChain(address, chainId);
      const effectiveNonce = Math.max(currentNonce, chainNonce);

      console.log('🔢 EVM nonce 对齐结果:', {
        address,
        chainId,
        dbNonce: currentNonce,
        chainPendingNonce: chainNonce,
        effectiveNonce
      });

      if (effectiveNonce > currentNonce) {
        await this.syncNonceFromChain(address, chainId, chainNonce);
      }

      return effectiveNonce;
    } catch (error) {
      if (currentNonce >= 0) {
        console.error('获取链上pending nonce失败，临时使用本地nonce:', error);
        return currentNonce;
      }

      console.error('获取链上pending nonce失败，且本地无nonce记录，使用默认值0:', error);
      return 0;
    }
  }

  /**
   * 广播前检查热钱包 nonce 是否可安全使用。
   *
   * 业务规则：
   * - 链上 pending nonce 是真实发交易依据。
   * - DB nonce 只表示本地已预占到的下一个 nonce。
   * - 如果本地有同热钱包未完成提现，先保护这些低 nonce 交易，不继续制造更高 nonce gap。
   */
  async checkNonceForBroadcast(address: string, chainId: number): Promise<BroadcastNonceCheckResult> {
    const [chainPendingNonce, dbNonce, openWithdraws] = await Promise.all([
      this.getPendingNonceFromChain(address, chainId),
      this.db.getCurrentNonce(address, chainId),
      this.getOpenWithdrawsForAddress(address, chainId)
    ]);

    const diagnosticOpenWithdraws = openWithdraws.map(withdraw => ({
      id: Number(withdraw.id),
      status: String(withdraw.status),
      nonce: withdraw.nonce === null || withdraw.nonce === undefined ? null : Number(withdraw.nonce),
      tx_hash: withdraw.tx_hash || null
    }));

    const blockingWithdraw = diagnosticOpenWithdraws.find(withdraw =>
      withdraw.nonce !== null && withdraw.nonce >= chainPendingNonce
    );

    if (blockingWithdraw) {
      const reason = `热钱包存在未收口提现 nonce=${blockingWithdraw.nonce}，链上 pending nonce=${chainPendingNonce}`;
      console.warn('⏸️ EVM 热钱包 nonce 暂不可广播，跳过该热钱包:', {
        address,
        chainId,
        chainPendingNonce,
        dbNonce,
        blockingWithdraw,
        openWithdraws: diagnosticOpenWithdraws
      });

      return {
        state: 'skip',
        address,
        chainId,
        chainPendingNonce,
        dbNonce,
        effectiveNonce: Math.max(dbNonce, chainPendingNonce),
        reason,
        openWithdraws: diagnosticOpenWithdraws
      };
    }

    if (diagnosticOpenWithdraws.some(withdraw => withdraw.nonce === null)) {
      const reason = '热钱包存在未绑定 nonce 的 signing/pending 提现，需要先诊断状态';
      console.warn('⚠️ EVM 热钱包存在未绑定 nonce 的未完成提现:', {
        address,
        chainId,
        chainPendingNonce,
        dbNonce,
        openWithdraws: diagnosticOpenWithdraws
      });

      return {
        state: 'diagnostic',
        address,
        chainId,
        chainPendingNonce,
        dbNonce,
        effectiveNonce: Math.max(dbNonce, chainPendingNonce),
        reason,
        openWithdraws: diagnosticOpenWithdraws
      };
    }

    const syncedNonce = await this.syncNonceFromChainForBroadcast(address, chainId, chainPendingNonce, dbNonce);
    return {
      state: 'ready',
      address,
      chainId,
      chainPendingNonce,
      dbNonce,
      effectiveNonce: syncedNonce,
      openWithdraws: diagnosticOpenWithdraws
    };
  }

  /**
   * 广播前把本地 nonce 对齐到链上 pending nonce。
   * 只有在调用方确认没有本地未完成提现冲突时才允许安全回落。
   */
  async syncNonceFromChainForBroadcast(
    address: string,
    chainId: number,
    chainPendingNonce?: number,
    dbNonce?: number
  ): Promise<number> {
    const chainNonce = chainPendingNonce ?? await this.getPendingNonceFromChain(address, chainId);
    const currentDbNonce = dbNonce ?? await this.db.getCurrentNonce(address, chainId);

    if (currentDbNonce === chainNonce) {
      return chainNonce;
    }

    if (currentDbNonce < chainNonce || currentDbNonce === -1) {
      await this.dbGatewayClient.ensureNonceAtLeast(address, chainId, chainNonce);
      return chainNonce;
    }

    const openWithdraws = await this.getOpenWithdrawsForAddress(address, chainId);
    if (openWithdraws.length > 0) {
      throw new Error(`本地nonce(${currentDbNonce})高于链上pending(${chainNonce})，且存在未完成提现，禁止回落`);
    }

    const synced = await this.dbGatewayClient.setWalletNonceForBroadcast(address, chainId, chainNonce);
    if (!synced) {
      throw new Error(`广播前同步nonce失败: address=${address}, chainId=${chainId}, chainPendingNonce=${chainNonce}`);
    }

    console.warn('↩️ EVM nonce 已按链上 pending 安全回落:', {
      address,
      chainId,
      previousDbNonce: currentDbNonce,
      chainPendingNonce: chainNonce
    });
    return chainNonce;
  }

  /**
   * 签名前预占 nonce。预占成功后 DB nonce 已推进到 nonce + 1。
   */
  async reserveNonce(address: string, chainId: number): Promise<number> {
    const nonce = await this.getCurrentNonce(address, chainId);
    const result = await this.dbGatewayClient.reserveNonce(address, chainId, nonce);

    if (!result.success) {
      throw new Error(`Nonce 已被其他提现占用，请重试。address=${address}, chainId=${chainId}, expected=${nonce}, current=${result.newNonce}`);
    }

    console.log('✅ EVM nonce 已预占:', {
      address,
      chainId,
      reservedNonce: nonce,
      nextNonce: result.newNonce
    });

    return nonce;
  }

  /**
   * 签名失败或未广播前失败时尝试回退预占 nonce。
   */
  async releaseReservedNonce(address: string, chainId: number, reservedNonce: number): Promise<boolean> {
    const released = await this.dbGatewayClient.releaseReservedNonce(address, chainId, reservedNonce);
    console.log(released ? '↩️ EVM nonce 预占已回退' : 'ℹ️ EVM nonce 未回退，可能已有后续交易占用', {
      address,
      chainId,
      reservedNonce
    });
    return released;
  }

  /**
   * 广播成功后确保 DB nonce 至少为 usedNonce + 1。
   */
  async ensureNonceUsed(address: string, chainId: number, usedNonce: number): Promise<void> {
    const result = await this.dbGatewayClient.ensureNonceAtLeast(address, chainId, usedNonce + 1);
    if (!result.success) {
      throw new Error(`Failed to ensure nonce ${usedNonce} as used for wallet ${address} on chain ${chainId}`);
    }

    console.log(`✅ Nonce ${usedNonce} 已确认占用，下一个nonce至少为: ${result.newNonce}`);
  }

  /**
   * 标记nonce已使用（在交易发出后调用）
   */
  async markNonceUsed(address: string, chainId: number, usedNonce: number): Promise<void> {
    try {
      await this.ensureNonceUsed(address, chainId, usedNonce);
    } catch (error) {
      console.error('标记nonce已使用失败:', error);
      throw error;
    }
  }


  /**
   * 获取所有可用的热钱包（按 last_used_at 排序）
   */
  async getAllAvailableHotWallets(
    chainId: number, 
    chainType: string
  ): Promise<{
    address: string;
    nonce: number;
    device?: string;
  }[]> {
    return await this.db.getAllAvailableHotWallets(chainId, chainType);
  }

  async diagnoseEvmHotWalletNonces(chainId?: number): Promise<HotWalletNonceDiagnostic[]> {
    const wallets = await this.db.query<{
      address: string;
      chain_id: number;
      db_nonce: number | null;
    }>(
      `
        SELECT
          w.address,
          COALESCE(t.chain_id, wn.chain_id, ?) as chain_id,
          wn.nonce as db_nonce
        FROM wallets w
        LEFT JOIN wallet_nonces wn ON LOWER(wn.address) = LOWER(w.address)
        LEFT JOIN tokens t ON t.chain_type = 'evm' AND t.is_native = 1 AND t.status = 1
        WHERE w.wallet_type = 'hot'
          AND w.chain_type = 'evm'
          AND w.is_active = 1
          ${chainId !== undefined ? 'AND COALESCE(t.chain_id, wn.chain_id) = ?' : ''}
        GROUP BY w.address, COALESCE(t.chain_id, wn.chain_id, ?), wn.nonce
        ORDER BY w.address ASC
      `,
      chainId !== undefined ? [chainId, chainId, chainId] : [1, 1]
    );

    const diagnostics: HotWalletNonceDiagnostic[] = [];
    for (const wallet of wallets) {
      const walletChainId = Number(wallet.chain_id);
      const dbNonce = wallet.db_nonce === null || wallet.db_nonce === undefined ? -1 : Number(wallet.db_nonce);
      const [openWithdraws, queuedWithdraws] = await Promise.all([
        this.getOpenWithdrawDetailsForAddress(wallet.address, walletChainId),
        this.getQueuedWithdrawsForChain(walletChainId)
      ]);

      try {
        const nonceCheck = await this.checkNonceForBroadcast(wallet.address, walletChainId);
        diagnostics.push({
          address: wallet.address,
          chainId: walletChainId,
          chainType: 'evm',
          dbNonce,
          chainPendingNonce: nonceCheck.chainPendingNonce,
          state: nonceCheck.state,
          ...(nonceCheck.reason ? { reason: nonceCheck.reason } : {}),
          openWithdraws,
          queuedWithdraws,
          suggestedActions: this.buildNonceDiagnosticActions(nonceCheck.state, nonceCheck.chainPendingNonce, openWithdraws, queuedWithdraws)
        });
      } catch (error) {
        diagnostics.push({
          address: wallet.address,
          chainId: walletChainId,
          chainType: 'evm',
          dbNonce,
          chainPendingNonce: null,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          openWithdraws,
          queuedWithdraws,
          suggestedActions: ['检查当前链 RPC 是否可用，再重新刷新 nonce 诊断。']
        });
      }
    }

    return diagnostics;
  }


  /**
   * 创建热钱包（通过签名机）
   */
  async createHotWallet(params: {
    chainType: 'evm' | 'btc' | 'solana';
  }): Promise<{
    walletId: number;
    address: string;
    device: string;
    path: string;
  }> {
    try {
      // 1. 查找在指定链类型上没有钱包地址的系统用户
      const systemUserId = await this.db.getSystemUserIdWithoutWallet('sys_hot_wallet', params.chainType);
      if (!systemUserId) {
        throw new Error(`没有可用的热钱包系统用户（所有系统用户在 ${params.chainType} 链上都已分配钱包）`);
      }

      // 2. 通过 SignerService 创建钱包
      const signerResult = await this.signerClient.createWallet(params.chainType);

      if (!signerResult) {
        throw new Error('签名机创建钱包失败: 返回结果为空');
      }

      const { address, device, path } = signerResult;

      // 3. 检查钱包地址是否已存在（防止签名机返回重复地址）
      const existingWallet = await this.db.getWallet(address);
      if (existingWallet) {
        throw new Error('签名机返回的地址已存在，请重试');
      }

      // 4. 通过 db_gateway API 保存到 wallets 表
      const wallet = await this.dbGatewayClient.createWallet({
        user_id: systemUserId,
        address,
        device,
        path,
        chain_type: params.chainType,
        wallet_type: 'hot'
      });

      const walletId = wallet.id;
      if (!walletId) {
        throw new Error('创建钱包后未返回有效的钱包ID');
      }

      // 5. 如果是 Solana 钱包，为所有 Solana 代币生成并保存 ATA
      if (params.chainType === 'solana') {
        try {
          console.log('🔗 为 Solana 热钱包生成 ATA...');

          // 获取所有 Solana 代币
          const solanaTokens = await this.db.findAllTokensByChain('solana');
          console.log(`📋 找到 ${solanaTokens.length} 个 Solana 代币`);

          // 动态导入 getAssociatedTokenAddress 避免循环依赖
          const { getAssociatedTokenAddress } = await import('../utils/solana');

          // 批量生成并保存 ATA
          for (const token of solanaTokens) {
            // 跳过原生代币 SOL
            if (
              !token.token_address ||
              token.token_address.trim() === '' ||
              token.token_address === '0x0000000000000000000000000000000000000000' ||
              /^0x0+$/.test(token.token_address) ||
              token.is_native === true
            ) {
              console.log(`⏭️  跳过原生代币 ${token.token_symbol}`);
              continue;
            }

            try {
              // 根据 token_type 确定代币类型，默认为 spl-token
              const tokenType = (token.token_type === 'spl-token-2022' ? 'spl-token-2022' : 'spl-token') as 'spl-token' | 'spl-token-2022';
              
              const ataAddress = await getAssociatedTokenAddress(
                address,
                token.token_address,
                tokenType
              );

              // 通过 db_gateway 保存 ATA 记录
              await this.dbGatewayClient.insertData('solana_token_accounts', {
                user_id: systemUserId,
                wallet_id: walletId,
                wallet_address: address,
                token_mint: token.token_address,
                ata_address: ataAddress
              });

              console.log(`✅ 保存 ATA: ${token.token_symbol} (${tokenType}) -> ${ataAddress.substring(0, 8)}...`);
            } catch (error) {
              console.error(`❌ 为代币 ${token.token_symbol} 生成 ATA 失败:`, error);
              // 继续处理其他代币
            }
          }

          console.log('✅ Solana 热钱包 ATA 生成完成');
        } catch (error) {
          console.error('❌ 生成 Solana 热钱包 ATA 失败:', error);
          // 不影响钱包创建流程
        }
      }

      return {
        walletId,
        address,
        device,
        path
      };

    } catch (error) {
      console.error('创建热钱包失败:', error);
      throw new Error(`创建热钱包失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 获取热钱包信息
   */
  async getHotWallet(address: string) {
    return await this.db.getWallet(address);
  }

  /**
   * 同步 nonce 从链上
   */
  async syncNonceFromChain(address: string, chainId: number, chainNonce: number): Promise<boolean> {
    return await this.dbGatewayClient.syncNonceFromChain(address, chainId, chainNonce);
  }

  /**
   * 读取链上 pending nonce 并同步到 DB（只前进，不回退）。
   */
  async syncPendingNonceFromChain(address: string, chainId: number): Promise<number> {
    const chainNonce = await this.getPendingNonceFromChain(address, chainId);
    await this.syncNonceFromChain(address, chainId, chainNonce);
    return chainNonce;
  }

  private async getOpenWithdrawsForAddress(address: string, chainId: number): Promise<any[]> {
    return await this.db.query(
      `
        SELECT id, status, nonce, tx_hash
        FROM withdraws
        WHERE LOWER(from_address) = LOWER(?)
          AND chain_id = ?
          AND chain_type = 'evm'
          AND status IN ('signing', 'pending')
        ORDER BY nonce ASC, created_at ASC
      `,
      [address, chainId]
    );
  }

  private async getOpenWithdrawDetailsForAddress(address: string, chainId: number): Promise<any[]> {
    return await this.db.query(
      `
        SELECT
          w.id,
          w.user_id,
          w.status,
          w.nonce,
          w.tx_hash,
          w.amount,
          w.token_id,
          t.token_symbol,
          w.to_address,
          w.error_message,
          w.created_at,
          w.updated_at
        FROM withdraws w
        LEFT JOIN tokens t ON w.token_id = t.id
        WHERE LOWER(w.from_address) = LOWER(?)
          AND w.chain_id = ?
          AND w.chain_type = 'evm'
          AND w.status IN ('signing', 'pending')
        ORDER BY w.nonce ASC, w.created_at ASC
      `,
      [address, chainId]
    );
  }

  private async getQueuedWithdrawsForChain(chainId: number): Promise<any[]> {
    return await this.db.query(
      `
        SELECT
          w.id,
          w.user_id,
          w.status,
          w.amount,
          w.token_id,
          t.token_symbol,
          w.to_address,
          w.error_message,
          w.created_at,
          w.updated_at
        FROM withdraws w
        LEFT JOIN tokens t ON w.token_id = t.id
        WHERE w.chain_id = ?
          AND w.chain_type = 'evm'
          AND w.status = 'user_withdraw_request'
          AND w.error_message LIKE '%待广播排队%'
        ORDER BY w.created_at ASC
      `,
      [chainId]
    );
  }

  private buildNonceDiagnosticActions(
    state: BroadcastNonceState,
    chainPendingNonce: number,
    openWithdraws: any[],
    queuedWithdraws: any[]
  ): string[] {
    if (state === 'ready') {
      return queuedWithdraws.length > 0
        ? ['热钱包 nonce 已可广播，可点击“重试排队提现”继续处理待广播提现。']
        : ['热钱包 nonce 正常，当前没有需要人工收口的排队提现。'];
    }

    const blocking = openWithdraws.find(withdraw =>
      withdraw.nonce !== null && withdraw.nonce !== undefined && Number(withdraw.nonce) >= chainPendingNonce
    );

    if (blocking) {
      return [
        `先处理阻塞提现 ID ${blocking.id}（nonce ${blocking.nonce}）。`,
        '如果 txHash 链上存在，等待 scanner 推进或人工核对 receipt。',
        '如果确认不会上链，按业务走失败/退款或用同 nonce 补发收口；低 nonce 收口后再重试排队提现。'
      ];
    }

    return [
      '存在未绑定 nonce 的 signing/pending 提现，请先核对签名/广播阶段是否中断。',
      '确认不会上链的记录不要直接改 confirmed，应按失败/退款或重发流程收口。'
    ];
  }

}
