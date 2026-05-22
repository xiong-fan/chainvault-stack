import { DatabaseReader } from '../db';
import { SignerClient } from './signerClient';
import { BalanceService } from './balanceService';
import { GasEstimationService } from '../utils/gasEstimation';
import { HotWalletService } from './hotWalletService';
import { getDbGatewayClient } from './dbGatewayClient';
import { formatUnits, normalizeBigIntString, isBigIntStringGreaterOrEqual } from '../utils/numberUtils';
import { chainConfigManager, SupportedChain } from '../utils/chains';
import { type TransactionReceipt } from 'viem';
import { getAssociatedTokenAddress } from '../utils/solana';
import { TransactionParams, WithdrawHandlerFactory, WithdrawContext, IWithdrawHandler, SignRequest } from './withdraw';

// 钱包业务逻辑服务
export class WalletBusinessService {
  private dbReader: DatabaseReader;
  private signerClient: SignerClient;
  private balanceService: BalanceService;
  private gasEstimationService: GasEstimationService;
  private hotWalletService: HotWalletService;
  private dbGatewayClient = getDbGatewayClient();
  private withdrawHandlerFactory: WithdrawHandlerFactory;

  constructor(dbReader: DatabaseReader) {
    this.dbReader = dbReader;
    this.signerClient = new SignerClient();
    this.balanceService = new BalanceService(dbReader);
    this.gasEstimationService = new GasEstimationService();
    this.hotWalletService = new HotWalletService(dbReader.getConnection());
    this.withdrawHandlerFactory = new WithdrawHandlerFactory(
      this.gasEstimationService,
      this.hotWalletService
    );
  }



  /**
   * 选择合适的热钱包
   */
  private async selectHotWallet(params: {
    chainId: number;
    chainType: 'evm' | 'btc' | 'solana';
    requiredAmount: string;
    tokenId: number;
  }): Promise<{
    success: boolean;
    wallet?: {
      address: string;
      nonce: number;
      device?: string;
      userId: number;
    };
    error?: string;
  }> {
    try {
      // 1. 获取所有可用的热钱包
      const availableWallets = await this.hotWalletService.getAllAvailableHotWallets(
        params.chainId, 
        params.chainType
      );
      
      if (availableWallets.length === 0) {
        return {
          success: false,
          error: '没有可用的热钱包'
        };
      }

      // 2. 依次检查热钱包余额，找到第一个余额足够的钱包
      for (const wallet of availableWallets) {
        const walletBalance = await this.balanceService.getWalletBalance(
          wallet.address, 
          params.tokenId,
          params.chainId
        );

        console.log('🔍 WalletBusinessService: 热钱包余额:', wallet.address, walletBalance);
        
        const normalizedBalance = normalizeBigIntString(walletBalance);
        const normalizedRequiredAmount = normalizeBigIntString(params.requiredAmount);
        
        if (isBigIntStringGreaterOrEqual(normalizedBalance, normalizedRequiredAmount)) {
          // 获取钱包的 nonce 和用户ID
          let nonce: number = 0;
          if (params.chainType === 'evm') {
            nonce = await this.hotWalletService.getCurrentNonce(
              wallet.address, 
              params.chainId
            );
          }

          // 获取钱包信息以获取用户ID
          const walletInfo = await this.dbReader.getConnection().getWallet(wallet.address);
          if (!walletInfo || !walletInfo.user_id) {
            continue; // 跳过没有用户ID的钱包
          }

          const result: {
            success: true;
            wallet: {
              address: string;
              nonce: number;
              device?: string;
              userId: number;
            };
          } = {
            success: true,
            wallet: {
              address: wallet.address,
              nonce: nonce,
              userId: walletInfo.user_id
            }
          };
          
          if (wallet.device) {
            result.wallet.device = wallet.device;
          }
          
          return result;
        }
      }

      return {
        success: false,
        error: '所有热钱包余额都不足，无法完成提现'
      };

    } catch (error) {
      console.error('选择热钱包失败:', error);
      return {
        success: false,
        error: `选择热钱包失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  private async selectHotWalletWithPreparedTransaction(params: {
    chainId: number;
    chainType: 'evm' | 'btc' | 'solana';
    tokenInfo: any;
    tokenSymbol: string;
    requestedAmountBigInt: bigint;
    withdrawFee: string;
    actualAmount: bigint;
    withdrawId: number;
    userId: number;
    to: string;
    displayAmount: string;
  }): Promise<{
    success: boolean;
    wallet?: {
      address: string;
      nonce: number;
      device?: string;
      userId: number;
    };
    transactionParams?: TransactionParams;
    context?: WithdrawContext;
    error?: string;
  }> {
    try {
      const availableWallets = await this.hotWalletService.getAllAvailableHotWallets(
        params.chainId,
        params.chainType
      );

      if (availableWallets.length === 0) {
        return { success: false, error: '没有可用的热钱包' };
      }

      const handler = this.withdrawHandlerFactory.getHandler(params.chainType);
      const insufficient: string[] = [];
      const unavailableForNonce: string[] = [];

      for (const wallet of availableWallets) {
        const walletInfo = await this.dbReader.getConnection().getWallet(wallet.address);
        if (!walletInfo?.user_id) {
          continue;
        }

        let evmNonce: number = 0;
        if (params.chainType === 'evm') {
          const nonceCheck = await this.hotWalletService.checkNonceForBroadcast(wallet.address, params.chainId);
          if (nonceCheck.state !== 'ready') {
            unavailableForNonce.push(`${wallet.address}: ${nonceCheck.reason || 'nonce状态不可安全广播'}`);
            continue;
          }
          evmNonce = nonceCheck.effectiveNonce;
        }

        const hotWallet: {
          address: string;
          nonce: number;
          device?: string;
          userId: number;
        } = {
          address: wallet.address,
          nonce: evmNonce,
          userId: walletInfo.user_id
        };
        if (wallet.device) {
          hotWallet.device = wallet.device;
        }

        const context: WithdrawContext = {
          userId: params.userId,
          to: params.to,
          amount: params.displayAmount,
          tokenSymbol: params.tokenSymbol,
          chainId: params.chainId,
          chainType: params.chainType,
          tokenInfo: params.tokenInfo,
          requestedAmountBigInt: params.requestedAmountBigInt,
          withdrawFee: params.withdrawFee,
          actualAmount: params.actualAmount,
          withdrawId: params.withdrawId,
          hotWallet
        };

        const transactionParams = await handler.prepareTransactionParams(context, params.tokenInfo);
        const gasEstimation = transactionParams.gasEstimation;
        const gasReserve =
          params.chainType === 'evm' && params.tokenInfo.is_native && gasEstimation?.gasLimit && gasEstimation?.maxFeePerGas
            ? BigInt(gasEstimation.gasLimit) * BigInt(gasEstimation.maxFeePerGas)
            : 0n;
        const requiredAmount = params.actualAmount + gasReserve;

        const walletBalance = await this.balanceService.getWalletBalance(
          wallet.address,
          params.tokenInfo.id,
          params.chainId
        );
        const normalizedBalance = normalizeBigIntString(walletBalance);
        const normalizedRequiredAmount = normalizeBigIntString(requiredAmount.toString());

        console.log('🔍 WalletBusinessService: 热钱包余额与提现需求:', {
          address: wallet.address,
          balance: normalizedBalance,
          actualAmount: params.actualAmount.toString(),
          gasReserve: gasReserve.toString(),
          requiredAmount: normalizedRequiredAmount,
          gasLimit: gasEstimation?.gasLimit,
          maxFeePerGas: gasEstimation?.maxFeePerGas
        });

        if (isBigIntStringGreaterOrEqual(normalizedBalance, normalizedRequiredAmount)) {
          return {
            success: true,
            wallet: hotWallet,
            transactionParams,
            context
          };
        }

        insufficient.push(`${wallet.address} 余额 ${normalizedBalance} < 需要 ${normalizedRequiredAmount}`);
      }

      if (unavailableForNonce.length > 0) {
        return {
          success: false,
          error: `所有余额足够的热钱包当前都在等待链上 nonce 收口，提现保持待广播排队。${unavailableForNonce.join('; ')}`
        };
      }

      return {
        success: false,
        error: `所有热钱包余额都不足，无法完成提现${insufficient.length ? `。${insufficient.join('; ')}` : ''}`
      };
    } catch (error) {
      console.error('选择热钱包并准备交易参数失败:', error);
      return {
        success: false,
        error: `选择热钱包并准备交易参数失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 获取指定链的公共客户端
   */
  private getPublicClient(chain: SupportedChain): any {
    return chainConfigManager.getPublicClient(chain);
  }

  /**
   * 根据chainId获取对应的链类型
   */
  private getChainByChainId(chainId: number): SupportedChain {
    return chainConfigManager.getChainByChainId(chainId);
  }

  /**
   * 获取用户钱包地址
   */
  async getUserWallet(userId: number, chainType: 'evm' | 'btc' | 'solana'): Promise<{
    success: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      // 首先检查用户是否已有该链类型的钱包
      const existingWallet = await this.dbReader.wallets.findByUserIdAndChainType(userId, chainType);
      if (existingWallet) {
        const responseData = {
          id: existingWallet.id,
          user_id: existingWallet.user_id,
          address: existingWallet.address,
          chain_type: existingWallet.chain_type,
          wallet_type: existingWallet.wallet_type,
          path: existingWallet.path,
          created_at: existingWallet.created_at,
          updated_at: existingWallet.updated_at
        };
        
        return {
          success: true,
          data: responseData
        };
      }

      // 用户没有钱包，需要创建新钱包
      // 检查 signer 模块是否可用
      const isSignerHealthy = await this.signerClient.checkHealth();
      if (!isSignerHealthy) {
        return {
          success: false,
          error: 'Signer 模块不可用，请检查服务状态'
        };
      }

      // 通过 signer 服务创建钱包
      const walletData = await this.signerClient.createWallet(chainType);

      // 检查生成的地址是否已被其他用户使用
      const addressExists = await this.dbReader.wallets.findByAddress(walletData.address);
      if (addressExists) {
        return {
          success: false,
          error: '生成的钱包地址已被使用，请重试'
        };
      }


      // 通过 db_gateway 服务创建钱包
      const wallet = await this.dbGatewayClient.createWallet({
        user_id: userId,
        address: walletData.address,
        chain_type: walletData.chainType,
        device: walletData.device,
        path: walletData.path,
        wallet_type: 'user'
      });

      // 如果是 Solana 钱包，为所有 Solana 代币生成并保存 ATA
      if (chainType === 'solana') {
        try {
          console.log('🔗 为 Solana 钱包生成 ATA...');

          // 获取所有 Solana 代币
          const solanaTokens = await this.dbReader.getConnection().findAllTokensByChain('solana');
          console.log(`📋 找到 ${solanaTokens.length} 个 Solana 代币`);

          // 批量生成并保存 ATA
          for (const token of solanaTokens) {
            // 跳过原生代币 SOL：
            // - token_address 为 null/undefined/空字符串
            // - token_address 为零地址（0x0000...或全0地址）
            // - is_native 为 true
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
                walletData.address,
                token.token_address,
                tokenType
              );

              // 通过 db_gateway 保存 ATA 记录
              await this.dbGatewayClient.insertData('solana_token_accounts', {
                user_id: userId,
                wallet_id: wallet.id,
                wallet_address: walletData.address,
                token_mint: token.token_address,
                ata_address: ataAddress
              });

              console.log(`✅ 保存 ATA: ${token.token_symbol} (${tokenType}) -> ${ataAddress.substring(0, 8)}...`);
            } catch (error) {
              console.error(`❌ 为代币 ${token.token_symbol} 生成 ATA 失败:`, error);
              // 继续处理其他代币
            }
          }

          console.log('✅ Solana ATA 生成完成');
        } catch (error) {
          console.error('❌ 生成 Solana ATA 失败:', error);
          // 不影响钱包创建流程
        }
      }

      // 返回给前端的数据，移除 device 字段
      const responseData = {
        id: wallet.id,
        user_id: wallet.user_id,
        address: wallet.address,
        chain_type: wallet.chain_type,
        wallet_type: wallet.wallet_type,
        path: wallet.path,
        created_at: wallet.created_at,
        updated_at: wallet.updated_at
      };

      return {
        success: true,
        data: responseData
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取用户钱包失败'
      };
    }
  }


  /**
   * 获取用户余额总和（所有链的总和）- 使用 Credits 
   */
  async getUserTotalBalance(userId: number): Promise<{
    success: boolean;
    data?: {
      chain_id: number | null;
      chain_type: string | null;
      token_symbol: string;
      total_balance: string;
      available_balance: string;
      frozen_balance: string;
      address_count: number;
    }[];
    error?: string;
  }> {
    try {
      // 使用Credits系统获取用户余额
      const balances = await this.balanceService.getUserTotalBalancesByToken(userId);
      
      return {
        success: true,
        data: balances
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取用户余额失败'
      };
    }
  }

  /**
   * 获取用户余额统计概览
   */
  async getUserBalanceStats(userId: number): Promise<{
    success: boolean;
    data?: {
      user_id: number;
      chain_count: number;
      token_count: number;
      address_count: number;
      positive_balance_count: number;
      last_balance_update: string | null;
    };
    error?: string;
  }> {
    try {
      const stats = await this.balanceService.getUserBalanceStats(userId);

      return {
        success: true,
        data: stats
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取用户余额统计失败'
      };
    }
  }

  /**
   * 获取用户地址级余额明细
   */
  async getUserBalanceDetails(userId: number): Promise<{
    success: boolean;
    data?: {
      user_id: number;
      chain_id?: number | null;
      chain_type?: string | null;
      address: string;
      token_id: number;
      token_symbol: string;
      decimals: number;
      available_balance: string;
      frozen_balance: string;
      total_balance: string;
      available_balance_formatted: string;
      frozen_balance_formatted: string;
      total_balance_formatted: string;
    }[];
    error?: string;
  }> {
    try {
      const balances = await this.balanceService.getUserBalances(userId);

      return {
        success: true,
        data: balances
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取用户余额明细失败'
      };
    }
  }

  /**
   * 获取用户充值中的余额
   */
  async getUserPendingDeposits(userId: number): Promise<{
    success: boolean;
    data?: {
      chain_id: number | null;
      chain_type: string | null;
      token_id: number;
      token_symbol: string;
      pending_amount: string;
      transaction_count: number;
      scanned_count: number;
      confirming_count: number;
      safe_count: number;
      latest_status: 'confirmed' | 'safe';
      latest_confirmation_count: number;
      required_confirmations: number | null;
      deposits: {
        tx_hash: string;
        amount: string;
        status: 'confirmed' | 'safe';
        confirmation_count: number;
        required_confirmations: number | null;
        progress_label: string;
        block_number: number | null;
        address: string;
        created_at: string | null;
        updated_at: string | null;
      }[];
    }[];
    error?: string;
  }> {
    try {
      const pendingDeposits = await this.dbReader.transactions.getUserPendingDepositBalances(userId);
      return {
        success: true,
        data: pendingDeposits
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取充值中余额失败'
      };
    }
  }

  /**
   * 获取用户指定代币的余额详情（处理不同链的decimals）
   */
  async getUserTokenBalance(userId: number, tokenSymbol: string): Promise<{
    success: boolean;
    data?: {
      token_symbol: string;
      chain_details: {
        chain_id: number | null;
        chain_type: string;
        address: string;
        token_id: number;
        balance: string;
        decimals: number;
        normalized_balance: string;
      }[];
      total_normalized_balance: string;
      chain_count: number;
    };
    error?: string;
  }> {
    try {
      // 使用Credits系统获取用户指定代币余额
      const balances = await this.balanceService.getUserBalances(userId);
      const tokenBalances = balances.filter(b => b.token_symbol === tokenSymbol);
      
      if (tokenBalances.length === 0) {
        return {
          success: false,
          error: `用户没有 ${tokenSymbol} 代币余额`
        };
      }

      const chainDetails = tokenBalances.map(balance => ({
        chain_id: balance.chain_id ?? null,
        chain_type: balance.chain_type || 'unknown',
        address: balance.address,
        token_id: balance.token_id,
        balance: balance.total_balance,
        decimals: balance.decimals,
        normalized_balance: balance.total_balance_formatted
      }));

      const totalNormalizedBalance = tokenBalances.reduce((sum, balance) => {
        const parsed = Number.parseFloat(balance.total_balance_formatted);
        return Number.isNaN(parsed) ? sum : sum + parsed;
      }, 0);

      return {
        success: true,
        data: {
          token_symbol: tokenSymbol,
          chain_details: chainDetails,
          total_normalized_balance: totalNormalizedBalance.toFixed(6),
          chain_count: new Set(tokenBalances.map(balance => `${balance.chain_type}:${balance.chain_id}`)).size
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取代币余额失败'
      };
    }
  }

  /**
   * 用户提现
   */
  async withdrawFunds(params: {
    userId: number;
    to: string;                // 提现目标地址
    amount: string;            // 提现金额（格式化后的金额，如 "1.5"）
    tokenId?: number;          // 优先使用代币 ID，避免同名代币冲突
    tokenSymbol?: string;      // 兼容旧客户端
    chainId: number;           // 链ID
    chainType: 'evm' | 'btc' | 'solana'; // 链类型
  }): Promise<{
    success: boolean;
    data?: {
      signedTransaction: string;
      transactionHash: string;
      withdrawAmount: string;
      actualAmount: string;    // 实际转账金额（扣除费用后）
      fee: string;             // 提现费用
      withdrawId: number;      // 提现记录ID
      gasEstimation: {
        gasLimit: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        networkCongestion: 'low' | 'medium' | 'high';
      };
    };
    error?: string;
    errorDetail?: string;
  }> {
    let withdrawId: number | undefined;
    
    try {
      // 1. 验证参数
      if (!params.to || !params.amount || (!params.tokenId && !params.tokenSymbol)) {
        return {
          success: false,
          error: '缺少必需参数: to, amount, tokenId'
        };
      }

      // 2. 获取用户钱包地址
      const wallet = await this.dbReader.wallets.findByUserIdAndChainType(params.userId, params.chainType);
      if (!wallet) {
        return {
          success: false,
          error: '用户钱包不存在'
        };
      }

      if (wallet.wallet_type !== 'user') {
        return {
          success: false,
          error: '只有用户钱包才能提现'
        };
      }

      // 3. 查找代币信息。优先使用 token_id，兼容旧客户端的 tokenSymbol。
      const tokenInfo = params.tokenId
        ? await this.dbReader.getConnection().findTokenById(params.tokenId)
        : await this.dbReader.getConnection().findTokenBySymbolAndChainType(params.tokenSymbol!, params.chainId, params.chainType);
      console.log('🔍 代币信息查询结果:', tokenInfo);
      if (!tokenInfo) {
        return {
          success: false,
          error: params.tokenId ? `不支持的代币ID: ${params.tokenId}` : `不支持的代币: ${params.tokenSymbol}`
        };
      }

      if (tokenInfo.chain_id !== params.chainId || tokenInfo.chain_type !== params.chainType) {
        return {
          success: false,
          error: `代币 ${tokenInfo.token_symbol} 不属于当前网络`
        };
      }

      const tokenSymbol = tokenInfo.token_symbol;

      // 4. 将用户输入的金额转换为最小单位
      const requestedAmountBigInt = BigInt(Math.floor(parseFloat(params.amount) * Math.pow(10, tokenInfo.decimals)));
      
      // 5. 检查最小提现金额
      const minWithdrawAmount = (tokenInfo as any).min_withdraw_amount || '0';
      console.log('🔍 最小提现金额验证:', {
        tokenSymbol,
        requestedAmount: params.amount,
        requestedAmountBigInt: requestedAmountBigInt.toString(),
        minWithdrawAmount,
        tokenInfo: tokenInfo
      });
      
      if (requestedAmountBigInt < BigInt(minWithdrawAmount)) {
        const minAmountFormatted = (BigInt(minWithdrawAmount) / BigInt(Math.pow(10, tokenInfo.decimals))).toString();
        console.log('❌ 提现金额小于最小提现金额:', {
          requested: requestedAmountBigInt.toString(),
          minRequired: minWithdrawAmount,
          minFormatted: minAmountFormatted
        });
        return {
          success: false,
          error: `提现金额不能小于最小提现金额 ${minAmountFormatted} ${tokenSymbol}`
        };
      }
      
      console.log('✅ 最小提现金额验证通过');
      
      // 6. 获取提现费用并计算实际转账金额
      const withdrawFee = (tokenInfo as any).withdraw_fee || '0';
      const actualAmount = requestedAmountBigInt - BigInt(withdrawFee);
      
      // 7. 检查用户余额是否充足（包含费用）
      const balanceCheck = await this.balanceService.checkSufficientBalance(
        params.userId,
        tokenInfo.id,
        requestedAmountBigInt.toString()
      );

      if (!balanceCheck.sufficient) {
        const formattedAvailableBalance = formatUnits(balanceCheck.availableBalance, tokenInfo.decimals);
        return {
          success: false,
          error: `用户余额不足。可用余额: ${formattedAvailableBalance} ${tokenSymbol}`
        };
      }

      // 8. 检查 signer 模块是否可用
      const isSignerHealthy = await this.signerClient.checkHealth();
      if (!isSignerHealthy) {
        return {
          success: false,
          error: 'Signer 模块不可用，请稍后再试'
        };
      }

      // 9. 创建提现记录（内部会进行风控检查）
      console.log('🛡️ 创建提现请求并进行风控检查...');
      const withdrawResult = await this.dbGatewayClient.createWithdrawRequest({
        user_id: params.userId,
        to_address: params.to,
        token_id: tokenInfo.id,
        token_symbol: tokenSymbol,
        amount: requestedAmountBigInt.toString(),
        fee: withdrawFee,
        chain_id: params.chainId,
        chain_type: params.chainType
      });

      withdrawId = withdrawResult.withdrawId;

      // 如果风控拒绝或需要人工审核，直接返回
      if (withdrawResult.rejected || withdrawResult.needsReview) {
        console.log(withdrawResult.rejected ? '❌ 提现被风控拒绝:' : '⏸️  提现需要人工审核:', withdrawResult.rejectReason);
        return {
          success: false,
          error: withdrawResult.rejected ? `提现被拒绝: ${withdrawResult.rejectReason}` : `提现需要人工审核: ${withdrawResult.rejectReason}`
        };
      }

      console.log('✅ 风控检查通过，提现记录已创建:', withdrawId);

      // 10. 选择热钱包并准备交易参数
      let transactionParams: any;
      let hotWallet: {
        address: string;
        nonce: number;
        device?: string;
        userId: number;
      };

      try {
        const preparedSelection = await this.selectHotWalletWithPreparedTransaction({
          chainId: params.chainId,
          chainType: params.chainType,
          tokenInfo,
          tokenSymbol,
          requestedAmountBigInt,
          withdrawFee,
          actualAmount,
          withdrawId,
          userId: params.userId,
          to: params.to,
          displayAmount: params.amount
        });

        if (!preparedSelection.success || !preparedSelection.wallet || !preparedSelection.transactionParams || !preparedSelection.context) {
          const errorMessage = preparedSelection.error || '选择热钱包失败';
          if (this.isWithdrawQueuedForBroadcast(errorMessage)) {
            await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'user_withdraw_request', {
              error_message: errorMessage
            });
          } else {
            await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'failed', {
              error_message: errorMessage
            });
          }

          return {
            success: false,
            error: errorMessage
          };
        }

        hotWallet = preparedSelection.wallet;
        transactionParams = preparedSelection.transactionParams;
      } catch (error) {
        // 更新提现状态为失败
        await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'failed', {
          error_message: `选择热钱包或准备交易参数失败: ${error instanceof Error ? error.message : '未知错误'}`
        });

        return {
          success: false,
          error: `选择热钱包或准备交易参数失败: ${error instanceof Error ? error.message : '未知错误'}`
        };
      }

      // 11. 构建签名请求
      const withdrawContext: WithdrawContext = {
        userId: params.userId,
        to: params.to,
        amount: params.amount,
        tokenSymbol,
        chainId: params.chainId,
        chainType: params.chainType,
        tokenInfo,
        requestedAmountBigInt,
        withdrawFee,
        actualAmount,
        withdrawId,
        hotWallet
      };

      // 12-13. 请求 Signer 签名并发送交易到区块链网络
      let txResult: {
        signedTransaction: string;
        transactionHash: string;
        nonce?: number;
      };
      try {
        txResult = await this.signAndSendWithdrawTransaction({
          handler: this.withdrawHandlerFactory.getHandler(params.chainType),
          withdrawId,
          context: withdrawContext,
          transactionParams,
          tokenInfo
        });
      } catch (error) {
        console.error('签名或发送交易失败:', error);
        const detailedError = this.formatDetailedError(error);
        console.error('签名或发送交易失败详细信息:', detailedError);

        const responseMessage = this.buildErrorResponse('签名或发送交易失败', error, detailedError);
        console.error('签名或发送交易失败响应消息:', responseMessage);

        // 更新提现状态为失败
        await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'failed', {
          error_message: responseMessage
        });

        return {
          success: false,
          error: responseMessage,
          errorDetail: detailedError
        };
      }

      // 14. 更新提现状态为 pending，使用实际的交易哈希
      const gasEstimation = transactionParams.gasEstimation;
      await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'pending', {
        tx_hash: txResult.transactionHash, // 使用发送交易后返回的真实哈希
        gas_price: gasEstimation?.gasPrice,
        max_fee_per_gas: gasEstimation?.maxFeePerGas,
        max_priority_fee_per_gas: gasEstimation?.maxPriorityFeePerGas
      });

      // 15. 创建 credit 流水记录（扣除用户余额）
      await this.dbGatewayClient.createCredit({
        user_id: params.userId,
        token_id: tokenInfo.id,
        token_symbol: tokenSymbol,
        amount: `-${requestedAmountBigInt.toString()}`,
        chain_id: params.chainId,
        chain_type: params.chainType,
        reference_id: withdrawId,
        reference_type: 'withdraw',
        address: params.chainType === 'evm' ? wallet.address.toLowerCase() : wallet.address,
        credit_type: 'withdraw',
        business_type: 'withdraw',
        status: 'pending',
        metadata: JSON.stringify({
          to_address: params.to
        })
      });

      // 16. 创建热钱包 credit 流水记录（热钱包支出）
      await this.dbGatewayClient.createCredit({
        user_id: hotWallet.userId,
        token_id: tokenInfo.id,
        token_symbol: tokenSymbol,
        amount: `-${actualAmount.toString()}`,
        chain_id: params.chainId,
        chain_type: params.chainType,
        reference_id: withdrawId,
        reference_type: 'withdraw',
        address: hotWallet.address,
        credit_type: 'withdraw',
        business_type: 'withdraw',
        status: 'pending'
      });

      return {
        success: true,
        data: {
          signedTransaction: txResult.signedTransaction,
          transactionHash: txResult.transactionHash, // 使用实际发送的交易哈希
          withdrawAmount: params.amount,
          actualAmount: actualAmount.toString(),
          fee: withdrawFee,
          withdrawId: withdrawId,
          gasEstimation: {
            gasLimit: gasEstimation?.gasLimit,
            maxFeePerGas: gasEstimation?.maxFeePerGas,
            maxPriorityFeePerGas: gasEstimation?.maxPriorityFeePerGas,
            networkCongestion: gasEstimation?.networkCongestion
          }
        }
      };

    } catch (error) {
      const detailedError = this.formatDetailedError(error);

      // 如果有 withdrawId，更新提现状态为失败
      if (withdrawId !== undefined) {
        try {
          await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'failed', {
            error_message: this.buildErrorResponse('提现失败', error, detailedError)
          });
        } catch (updateError) {
          console.error('更新提现状态失败:', updateError);
        }
      }
      
      return {
        success: false,
        error: this.buildErrorResponse('提现失败', error, detailedError),
        errorDetail: detailedError
      };
    }
  }

  /**
   * 人工审核通过后继续提现流程
   */
  async continueWithdrawAfterReview(withdraw: any): Promise<void> {
    console.log('📝 继续提现流程（人工审核通过）', {
      withdraw_id: withdraw.id,
      operation_id: withdraw.operation_id
    });

    try {
      // 1. 获取代币信息
      const tokenInfo = await this.dbReader.getConnection().findTokenById(withdraw.token_id);
      if (!tokenInfo) {
        throw new Error(`Token not found: ${withdraw.token_id}`);
      }

      // 2. 计算实际转账金额（扣除手续费）
      const actualAmount = BigInt(withdraw.amount) - BigInt(withdraw.fee || '0');

      // 3. 获取用户在当前链的充值钱包，用户侧提现流水必须挂在系统内用户钱包地址下。
      const userWallet = await this.dbReader.wallets.findByUserIdAndChainType(
        withdraw.user_id,
        withdraw.chain_type
      );
      if (!userWallet) {
        throw new Error(`User wallet not found: user=${withdraw.user_id}, chain=${withdraw.chain_type}`);
      }

      if (userWallet.wallet_type !== 'user') {
        throw new Error(`User wallet type is not user: ${userWallet.wallet_type}`);
      }

      const tokenSymbol = tokenInfo.symbol || tokenInfo.token_symbol || withdraw.token_symbol || 'UNKNOWN';
      const displayAmount = formatUnits(withdraw.amount, tokenInfo.decimals || 18);

      // 4. 选择热钱包并准备链特定交易参数
      const preparedSelection = await this.selectHotWalletWithPreparedTransaction({
        chainId: withdraw.chain_id,
        chainType: withdraw.chain_type,
        tokenInfo,
        tokenSymbol,
        requestedAmountBigInt: BigInt(withdraw.amount),
        withdrawFee: withdraw.fee || '0',
        actualAmount,
        withdrawId: withdraw.id,
        userId: withdraw.user_id,
        to: withdraw.to_address,
        displayAmount
      });

      if (!preparedSelection.success || !preparedSelection.wallet || !preparedSelection.transactionParams || !preparedSelection.context) {
        const errorMessage = preparedSelection.error || '选择热钱包失败';
        if (this.isWithdrawQueuedForBroadcast(errorMessage)) {
          await this.dbGatewayClient.updateWithdrawStatus(withdraw.id, 'user_withdraw_request', {
            error_message: errorMessage
          });
          console.warn('⏸️ 人工审核提现暂未广播，等待热钱包 nonce 收口:', {
            withdrawId: withdraw.id,
            reason: errorMessage
          });
          return;
        }
        throw new Error(errorMessage);
      }

      const hotWallet = preparedSelection.wallet;
      const transactionParams = preparedSelection.transactionParams;
      const withdrawContext = preparedSelection.context;
      const handler = this.withdrawHandlerFactory.getHandler(withdraw.chain_type);

      // 5-9. 人工审核通过后也复用统一签名与广播流程，避免 nonce 处理路径分叉。
      const txResult = await this.signAndSendWithdrawTransaction({
        handler,
        withdrawId: withdraw.id,
        context: withdrawContext,
        transactionParams,
        tokenInfo,
        operationId: withdraw.operation_id
      });

      console.log(`✅ 交易已发送到网络，交易哈希: ${txResult.transactionHash}`);

      // 10. 更新提现状态为 pending
      const gasEstimation = transactionParams.gasEstimation;
      const pendingUpdate: {
        tx_hash: string;
        gas_price?: string;
        max_fee_per_gas?: string;
        max_priority_fee_per_gas?: string;
      } = { tx_hash: txResult.transactionHash };
      if (gasEstimation?.gasPrice) pendingUpdate.gas_price = gasEstimation.gasPrice;
      if (gasEstimation?.maxFeePerGas) pendingUpdate.max_fee_per_gas = gasEstimation.maxFeePerGas;
      if (gasEstimation?.maxPriorityFeePerGas) pendingUpdate.max_priority_fee_per_gas = gasEstimation.maxPriorityFeePerGas;
      await this.dbGatewayClient.updateWithdrawStatus(withdraw.id, 'pending', pendingUpdate);

      // 11. 创建 credit 流水记录（扣除用户余额）
      await this.dbGatewayClient.createCredit({
        user_id: withdraw.user_id,
        token_id: tokenInfo.id,
        token_symbol: tokenSymbol,
        amount: `-${withdraw.amount}`,
        chain_id: withdraw.chain_id,
        chain_type: withdraw.chain_type,
        reference_id: withdraw.id,
        reference_type: 'withdraw',
        address: withdraw.chain_type === 'evm' ? userWallet.address.toLowerCase() : userWallet.address,
        credit_type: 'withdraw',
        business_type: 'withdraw',
        status: 'pending',
        metadata: JSON.stringify({
          to_address: withdraw.to_address
        })
      });

      // 12. 创建热钱包 credit 流水记录（热钱包支出）
      await this.dbGatewayClient.createCredit({
        user_id: hotWallet.userId,
        token_id: tokenInfo.id,
        token_symbol: tokenSymbol,
        amount: `-${actualAmount.toString()}`,
        chain_id: withdraw.chain_id,
        chain_type: withdraw.chain_type,
        reference_id: withdraw.id,
        reference_type: 'withdraw',
        address: hotWallet.address,
        credit_type: 'withdraw',
        business_type: 'withdraw',
        status: 'pending'
      });

      console.log('✅ 提现流程继续完成', {
        withdraw_id: withdraw.id,
        tx_hash: txResult.transactionHash
      });

    } catch (error) {
      console.error('继续提现流程失败', {
        withdraw_id: withdraw.id,
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : String(error)
      });

      await this.dbGatewayClient.updateWithdrawStatus(
        withdraw.id,
        'failed',
        this.buildErrorResponse('人工审核通过后继续提现失败', error)
      );

      throw error;
    }
  }

  private async signAndSendWithdrawTransaction(params: {
    handler: IWithdrawHandler;
    withdrawId: number;
    context: WithdrawContext;
    transactionParams: TransactionParams;
    tokenInfo: any;
    operationId?: string;
  }): Promise<{
    signedTransaction: string;
    transactionHash: string;
    nonce?: number;
  }> {
    const { handler, withdrawId, context, transactionParams, tokenInfo, operationId } = params;

    const signTransaction = async (signRequest: SignRequest) => {
      const signingUpdate: {
        from_address: string;
        nonce?: number;
      } = {
        from_address: context.hotWallet.address,
      };
      if (signRequest.nonce !== undefined) {
        signingUpdate.nonce = signRequest.nonce;
      }

      await this.dbGatewayClient.updateWithdrawStatus(withdrawId, 'signing', signingUpdate);

      // 日志保留业务排查关键字段，避免输出完整 raw transaction 或签名材料。
      console.log('🔐 WalletBusinessService: 准备调用Signer签名', {
        withdrawId,
        operationId,
        chainType: signRequest.chainType,
        chainId: signRequest.chainId,
        from: signRequest.address,
        to: signRequest.to,
        tokenId: signRequest.tokenId,
        tokenSymbol: signRequest.tokenSymbol,
        tokenType: signRequest.tokenType,
        nonce: signRequest.nonce
      });

      const signResult = await this.signerClient.signTransaction(signRequest, operationId);
      console.log('✅ 签名成功，待广播交易哈希:', signResult.transactionHash);
      return signResult;
    };

    if (handler.signAndSendTransaction) {
      return await handler.signAndSendTransaction(context, transactionParams, tokenInfo, signTransaction);
    }

    const signRequest = handler.buildSignRequest(context, transactionParams, tokenInfo);
    const signResult = await signTransaction(signRequest);
    const txHash = await handler.sendTransaction(signResult.signedTransaction, context);
    await handler.afterSendTransaction(txHash, context, transactionParams);

    const result: {
      signedTransaction: string;
      transactionHash: string;
      nonce?: number;
    } = {
      signedTransaction: signResult.signedTransaction,
      transactionHash: txHash
    };
    if (signRequest.nonce !== undefined) {
      result.nonce = signRequest.nonce;
    }

    return result;
  }

  /**
   * 退回提现金额到用户余额
   */
  async refundWithdraw(withdraw: any): Promise<void> {
    console.log('💰 退回提现金额', {
      withdraw_id: withdraw.id,
      user_id: withdraw.user_id,
      amount: withdraw.amount
    });

    try {
      // 创建正数 credit 记录，退回余额
      const totalAmount = BigInt(withdraw.amount) + BigInt(withdraw.fee || '0');

      await this.dbGatewayClient.createCredit({
        user_id: withdraw.user_id,
        address: withdraw.from_address || 'refund',
        token_id: withdraw.token_id,
        token_symbol: 'UNKNOWN',  // 需要从 token_id 查询
        amount: totalAmount.toString(),  // 正数
        credit_type: 'refund',
        business_type: 'internal_transfer',
        reference_id: withdraw.id.toString(),
        reference_type: 'withdraw_rejected',
        chain_id: withdraw.chain_id,
        chain_type: withdraw.chain_type,
        status: 'confirmed',
        metadata: JSON.stringify({
          reason: 'manual_review_rejected',
          operation_id: withdraw.operation_id
        })
      });

      console.log('✅ 退款成功', { withdraw_id: withdraw.id });

    } catch (error) {
      console.error('退款失败', {
        withdraw_id: withdraw.id,
        error: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  }

  private buildErrorResponse(prefix: string, error: unknown, detailedError?: string): string {
    const baseMessage = this.sanitizeErrorText(error instanceof Error ? error.message : String(error ?? '未知错误'));
    const detail = detailedError ?? this.formatDetailedError(error);
    const combined = `${prefix}: ${baseMessage}`;
    const messageWithDetail = `${combined}\n详细信息: ${detail}`;
    return messageWithDetail.length > 4000 ? `${messageWithDetail.slice(0, 4000)}...` : messageWithDetail;
  }

  private isWithdrawQueuedForBroadcast(message: string): boolean {
    return message.includes('待广播排队') || message.includes('nonce 收口');
  }

  private formatDetailedError(error: unknown): string {
    try {
      const normalized = this.normalizeErrorObject(error, new WeakSet());
      return JSON.stringify(normalized, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
    } catch {
      return typeof error === 'string' ? error : String(error ?? '未知错误');
    }
  }

  private normalizeErrorObject(value: unknown, seen: WeakSet<object>): unknown {
    if (value instanceof Error) {
      const base: Record<string, unknown> = {
        name: value.name,
        message: this.sanitizeErrorText(value.message)
      };
      if (value.stack) {
        base.stack = this.sanitizeErrorText(value.stack);
      }
      const ownProps = Object.getOwnPropertyNames(value);
      for (const prop of ownProps) {
        if (prop === 'name' || prop === 'message' || prop === 'stack') continue;
        const propValue = (value as any)[prop];
        base[prop] = this.normalizeErrorObject(propValue, seen);
      }
      return base;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'string') {
      return this.sanitizeErrorText(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.normalizeErrorObject(item, seen));
    }

    if (value && typeof value === 'object') {
      if (seen.has(value as object)) {
        return '[Circular]';
      }
      seen.add(value as object);
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'body') {
          result[key] = '[redacted rpc body]';
          continue;
        }
        if (key === 'url') {
          result[key] = this.sanitizeErrorText(String(val ?? ''));
          continue;
        }
        result[key] = this.normalizeErrorObject(val, seen);
      }
      seen.delete(value as object);
      return result;
    }

    return value;
  }

  private sanitizeErrorText(text: string): string {
    return text
      .replace(/https?:\/\/[^\s"\\]+/g, (url) => {
        try {
          const parsed = new URL(url);
          return `${parsed.origin}${parsed.pathname.includes('/v3/') ? '/v3/[redacted]' : parsed.pathname}`;
        } catch {
          return '[redacted-url]';
        }
      })
      .replace(/"params":\s*\[\s*"0x[0-9a-fA-F]+"\s*\]/g, '"params":["[redacted-raw-transaction]"]')
      .replace(/"Request body:\s*\{[^]*?\}\n\nDetails:/g, 'Request body: [redacted]\n\nDetails:')
      .replace(/0x[0-9a-fA-F]{128,}/g, '[redacted-raw-transaction]');
  }

}
