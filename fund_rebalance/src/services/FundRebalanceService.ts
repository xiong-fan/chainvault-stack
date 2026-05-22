import { v4 as uuidv4 } from 'uuid';
import { DbGatewayClient } from '../clients/DbGatewayClient';
import { EvmClient } from '../clients/EvmClient';
import { SignerClient } from '../clients/SignerClient';
import { SolanaClient } from '../clients/SolanaClient';
import { config } from '../config';
import {
  CreditRecord,
  FundTaskRecord,
  FundTaskStatus,
  GasQuote,
  SolanaFeeQuote,
  TokenRecord,
  TransactionRecord,
  WalletRecord
} from '../types';
import { nowIso } from '../utils/time';

const OPEN_STATUSES: FundTaskStatus[] = ['planned', 'gas_funding', 'gas_pending', 'gas_funded', 'signing', 'pending', 'confirmed'];
const SERVICE_NAME = 'fund_rebalance';
const DEPOSIT_CURSOR_PREFIX = 'evm_deposit_candidates';
const INVENTORY_RECONCILE_CURSOR_PREFIX = 'evm_inventory_reconcile';
const SOLANA_DEPOSIT_CURSOR_PREFIX = 'solana_deposit_candidates';
const SOLANA_INVENTORY_RECONCILE_CURSOR_PREFIX = 'solana_inventory_reconcile';
const COLLECTABLE_DEPOSIT_STATUSES = ['finalized'];

interface CollectionCandidateInput {
  token: TokenRecord;
  wallet: WalletRecord;
  source: 'deposit_cursor' | 'inventory_reconcile';
  inventoryBalance: bigint;
}

interface DepositCursor {
  blockNo: number;
  rowId: number;
}

interface GasTopUpPlan {
  amount: bigint;
  requiredGasFee: bigint;
  gasFundingFee: bigint;
  gasQuote: GasQuote;
}

function log(message: string, details?: Record<string, unknown>): void {
  const prefix = `[fund_rebalance] ${new Date().toISOString()} ${message}`;
  if (details) {
    console.log(prefix, details);
    return;
  }

  console.log(prefix);
}

function logError(message: string, error: unknown, details?: Record<string, unknown>): void {
  console.error(`[fund_rebalance] ${new Date().toISOString()} ${message}`, {
    ...details,
    error: error instanceof Error ? error.message : String(error)
  });
}

/**
 * EVM 资金归集编排服务。
 *
 * 这个服务不直接持有私钥，也不绕过现有风控链路：
 * 1. 先把“计划归集”的事实写入 fund_tasks，形成可追踪任务。
 * 2. 再通过 risk_control 获取交易风控签名。
 * 3. 再通过 signer 对用户充值地址发起的归集交易签名。
 * 4. 广播后持续检查 receipt，确认成功才写 collect 流水。
 */
export class FundRebalanceService {
  // 防止定时任务和手动 run-once 同时扫描，导致同一地址重复规划归集。
  private running = false;
  private nativeBalanceCache = new Map<string, bigint>();

  constructor(
    private readonly db: DbGatewayClient,
    private readonly evm: EvmClient,
    private readonly solana: SolanaClient,
    private readonly signer: SignerClient
  ) {}

  async runOnce(): Promise<{ scanned: number; created: number; skipped: number; errors: string[] }> {
    if (this.running) {
      log('collection scan ignored because another scan is running');
      return { scanned: 0, created: 0, skipped: 0, errors: ['collection scan is already running'] };
    }

    this.running = true;
    const errors: string[] = [];
    let scanned = 0;
    let created = 0;
    let skipped = 0;

    try {
      log('collection scan started', { evmChainId: config.chainId, solanaChainId: config.solanaChainId });
      this.nativeBalanceCache.clear();

      // 每次扫描前先推进历史 pending/confirmed 任务，避免旧任务已上链但状态没落库。
      await this.monitorReceipts();
      const recoveredTasks = await this.recoverSkippedTasks();
      created += recoveredTasks.retried;
      skipped += recoveredTasks.skipped;
      errors.push(...recoveredTasks.errors);

      // EVM 继续沿用原有候选游标和低频库存校准。
      const [tokens, userWallets, hotWallets, solanaTokens, solanaUserWallets, solanaHotWallets] = await Promise.all([
        this.db.getCollectableEvmTokens(config.chainId),
        this.db.getActiveUserWallets('evm'),
        this.db.getActiveHotWallets('evm'),
        this.db.getCollectableSolanaTokens(config.solanaChainId),
        this.db.getActiveUserWallets('solana'),
        this.db.getActiveHotWallets('solana')
      ]);

      if (hotWallets.length === 0) {
        throw new Error('no active EVM hot wallet available');
      }

      if (solanaTokens.length > 0 && solanaHotWallets.length === 0) {
        throw new Error('no active Solana hot wallet available');
      }

      const hotWallet = await this.pickHotWallet(hotWallets);
      log('collection scan loaded inputs', {
        evmTokens: tokens.length,
        evmUserWallets: userWallets.length,
        evmHotWallets: hotWallets.length,
        evmTargetHotWallet: hotWallet.address,
        solanaTokens: solanaTokens.length,
        solanaUserWallets: solanaUserWallets.length,
        solanaHotWallets: solanaHotWallets.length,
        solanaTargetHotWallet: solanaHotWallets[0]?.address || null
      });

      const candidates = await this.loadCollectionCandidates(tokens, userWallets);

      await this.mapConcurrent(candidates, config.maxConcurrentTasks, async candidate => {
        scanned += 1;
        try {
          const result = await this.evaluateAndCreateTask(candidate.token, candidate.wallet, hotWallet, candidate.inventoryBalance, candidate.source);
          if (result === 'created') created += 1;
          if (result === 'skipped') skipped += 1;
        } catch (error) {
          logError('collection candidate failed', error, {
            tokenId: candidate.token.id,
            tokenSymbol: candidate.token.token_symbol,
            fromAddress: candidate.wallet.address
          });
          errors.push(`${candidate.wallet.address}/${candidate.token.token_symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      if (solanaTokens.length > 0 && solanaHotWallets.length > 0) {
        const solanaHotWallet = solanaHotWallets[0]!;
        const solanaCandidates = await this.loadSolanaCollectionCandidates(solanaTokens, solanaUserWallets);

        await this.mapConcurrent(solanaCandidates, config.maxConcurrentTasks, async candidate => {
          scanned += 1;
          try {
            const result = await this.evaluateAndCreateSolanaTask(
              candidate.token,
              candidate.wallet,
              solanaHotWallet,
              candidate.inventoryBalance,
              candidate.source
            );
            if (result === 'created') created += 1;
            if (result === 'skipped') skipped += 1;
          } catch (error) {
            logError('solana collection candidate failed', error, {
              tokenId: candidate.token.id,
              tokenSymbol: candidate.token.token_symbol,
              fromAddress: candidate.wallet.address
            });
            errors.push(`solana ${candidate.wallet.address}/${candidate.token.token_symbol}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }

      log('collection scan finished', {
        scanned,
        created,
        skipped,
        errors: errors.length,
        evmRpcStats: this.evm.flushRpcStats(),
        solanaRpcStats: this.solana.flushRpcStats()
      });
      return { scanned, created, skipped, errors };
    } catch (error) {
      logError('collection scan failed', error, { scanned, created, skipped });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async retryTask(id: number): Promise<{ task: FundTaskRecord; txHash?: string; status: FundTaskStatus }> {
    // 重试不是简单重发原交易：先重新检查任务、token、钱包可用性，再重新取链上 pending nonce。
    const tasks = await this.db.getTasks({ id });
    const task = tasks[0];
    if (!task) {
      throw new Error(`fund task ${id} not found`);
    }

    if (task.status !== 'failed' && task.status !== 'skipped') {
      throw new Error(`only failed/skipped tasks can be retried, current status is ${task.status}`);
    }

    if (await this.db.hasOpenTask(task.from_address, task.token_id, task.chain_id)) {
      throw new Error('an open task already exists for this address/token/chain');
    }

    const tokenLoader = task.chain_type === 'solana'
      ? this.db.getCollectableSolanaTokens(task.chain_id)
      : this.db.getCollectableEvmTokens(task.chain_id);
    const [token] = await tokenLoader.then(tokens => tokens.filter(item => item.id === task.token_id));
    if (!token) {
      throw new Error(`token ${task.token_id} is not collectable`);
    }

    const [fromWallet] = await this.db.getActiveUserWallets(task.chain_type).then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.from_address.toLowerCase())
    );
    if (!fromWallet) {
      throw new Error(`source wallet ${task.from_address} is not active`);
    }

    const [toWallet] = await this.db.getActiveHotWallets(task.chain_type).then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.to_address.toLowerCase())
    );
    if (!toWallet) {
      throw new Error(`target hot wallet ${task.to_address} is not active`);
    }

    const result = task.chain_type === 'solana'
      ? await this.replanAndExecuteExistingSolanaTask(task, token, fromWallet, toWallet)
      : await this.replanAndExecuteExistingTask(task, token, fromWallet, toWallet);
    const refreshed = await this.db.getTasks({ id });
    return {
      task: refreshed[0] || task,
      status: result.status,
      ...(result.txHash && { txHash: result.txHash })
    };
  }

  private async recoverSkippedTasks(): Promise<{ retried: number; skipped: number; errors: string[] }> {
    const tasks = await this.db.getTasks({ status: 'skipped' });
    let retried = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const task of tasks) {
      if (task.task_type !== 'collect') continue;
      if (task.chain_type !== 'evm' && task.chain_type !== 'solana') continue;

      try {
        const result = await this.retryTask(task.id);
        if (result.status === 'pending' || result.status === 'gas_pending') {
          retried += 1;
        } else {
          skipped += 1;
        }
        log('skipped fund task recovered', {
          taskId: task.id,
          chainType: task.chain_type,
          tokenId: task.token_id,
          status: result.status,
          txHash: result.txHash || null
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`recover skipped task ${task.id}: ${message}`);
        logError('recover skipped fund task failed', error, {
          taskId: task.id,
          chainType: task.chain_type,
          tokenId: task.token_id
        });
      }
    }

    if (tasks.length > 0) {
      log('skipped fund task recovery finished', {
        scanned: tasks.length,
        retried,
        skipped,
        errors: errors.length
      });
    }

    return { retried, skipped, errors };
  }

  async monitorReceipts(): Promise<void> {
    log('receipt monitor started');

    // gas_pending 是补给交易等待确认；pending 是归集交易等待确认；confirmed 是链上成功但流水可能还没全部写完。
    const pendingTasks = [
      ...(await this.db.getTasks({ status: 'gas_pending' })),
      ...(await this.db.getTasks({ status: 'pending' })),
      ...(await this.db.getTasks({ status: 'confirmed' }))
    ];

    log('receipt monitor loaded tasks', { gasPendingOrPendingOrConfirmed: pendingTasks.length });

    for (const task of pendingTasks) {
      const metadata = this.parseMetadata(task.metadata);
      if (!this.shouldCheckReceipt(metadata)) {
        log('receipt check skipped by backoff', {
          taskId: task.id,
          status: task.status,
          nextReceiptCheckAt: metadata.nextReceiptCheckAt
        });
        continue;
      }

      const txHash = task.status === 'gas_pending'
        ? String(metadata.gasFundingTxHash || '')
        : task.tx_hash;
      if (!txHash) continue;

      if (task.chain_type === 'solana') {
        await this.monitorSolanaTaskReceipt(task, metadata, txHash);
        continue;
      }

      log('receipt monitor checking task', { taskId: task.id, status: task.status, txHash });
      const receipt = await this.evm.getReceipt(txHash);
      if (!receipt) {
        await this.scheduleNextReceiptCheck(task, metadata);
        log('receipt not available yet', { taskId: task.id, txHash });
        continue;
      }

      if (receipt.status === 'success') {
        if (task.status === 'gas_pending') {
          await this.handleGasFundingReceipt(task, Number(receipt.blockNumber));
          continue;
        }

        // 链上成功后才写 collect 流水；这样账务审计和链上结果保持一致。
        if (task.status !== 'finalized') {
          log('receipt success, finalizing task', {
            taskId: task.id,
            txHash,
            blockNumber: receipt.blockNumber.toString()
          });
          await this.finalizeTask(task, Number(receipt.blockNumber));
        }
      } else {
        // 链上失败不写流水，只保留失败原因，后续可人工排查或重试。
        await this.db.updateTask(task.id, {
          status: 'failed',
          error_message: 'on-chain transaction failed',
          metadata: this.mergeMetadata(task.metadata, {
            receiptStatus: receipt.status,
            blockNumber: receipt.blockNumber.toString(),
            failedTxHash: txHash
          }),
          updated_at: nowIso()
        });
        log('receipt failed, task marked failed', {
          taskId: task.id,
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          receiptStatus: receipt.status
        });
      }
    }
  }

  private async evaluateAndCreateTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    inventoryBalance: bigint,
    source: 'deposit_cursor' | 'inventory_reconcile'
  ): Promise<'created' | 'skipped' | 'ignored'> {
    log('candidate evaluation started', {
      tokenId: token.id,
      tokenSymbol: token.token_symbol,
      chainId: token.chain_id,
      fromAddress: fromWallet.address,
      toAddress: toWallet.address,
      source,
      inventoryBalance: inventoryBalance.toString()
    });

    // 幂等保护：同一个充值地址、同一个 token、同一条链上，只允许一个未完成归集任务。
    if (await this.db.hasOpenTask(fromWallet.address, token.id, token.chain_id)) {
      log('candidate ignored: open task exists', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address
      });
      return 'ignored';
    }

    const isNative = Boolean(token.is_native);
    const collectAmount = BigInt(token.collect_amount);
    if (source === 'inventory_reconcile' && inventoryBalance < collectAmount) {
      log('candidate ignored: local inventory below collect amount', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address,
        inventoryBalance: inventoryBalance.toString(),
        collectAmount: collectAmount.toString()
      });
      return 'ignored';
    }

    if (isNative) {
      const balance = await this.getCachedNativeBalance(fromWallet.address);
      if (balance <= collectAmount) {
        log('candidate ignored: native balance below collect amount', {
          tokenId: token.id,
          tokenSymbol: token.token_symbol,
          fromAddress: fromWallet.address,
          balance: balance.toString(),
          collectAmount: collectAmount.toString()
        });
        return 'ignored';
      }

      // 原生币归集需要预留交易 gas，实际转出金额为链上余额减预计手续费。
      const gasQuote = await this.evm.quoteNativeTransfer(fromWallet.address, toWallet.address, balance);
      if (balance <= collectAmount + gasQuote.estimatedFee) {
        log('candidate ignored: native balance cannot cover threshold plus gas', {
          tokenId: token.id,
          tokenSymbol: token.token_symbol,
          fromAddress: fromWallet.address,
          balance: balance.toString(),
          collectAmount: collectAmount.toString(),
          estimatedFee: gasQuote.estimatedFee.toString()
        });
        return 'ignored';
      }

      const amount = balance - gasQuote.estimatedFee;
      log('candidate eligible: creating native fund task', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address,
        toAddress: toWallet.address,
        amount: amount.toString(),
        estimatedFee: gasQuote.estimatedFee.toString()
      });
      const task = await this.planTask(token, fromWallet, toWallet, amount, gasQuote, null);
      await this.executeTask(task, token, fromWallet, toWallet);
      return 'created';
    }

    if (!token.token_address) {
      log('candidate ignored: ERC20 token address missing', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address
      });
      return 'ignored';
    }

    // ERC20 归集要同时看 token 余额和原生币余额，因为 gas 仍由用户充值地址支付。
    const [tokenBalance, nativeBalance] = await Promise.all([
      this.evm.getErc20Balance(token.token_address, fromWallet.address),
      this.getCachedNativeBalance(fromWallet.address)
    ]);

    if (tokenBalance < collectAmount) {
      log('candidate ignored: ERC20 balance below collect amount', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address,
        tokenBalance: tokenBalance.toString(),
        collectAmount: collectAmount.toString()
      });
      return 'ignored';
    }

    const gasQuote = await this.evm.quoteErc20Transfer(fromWallet.address, token.token_address, toWallet.address, tokenBalance);
    if (nativeBalance < gasQuote.estimatedFee) {
      if (!config.erc20GasTopUpEnabled) {
        log('candidate eligible but skipped: ERC20 gas top-up disabled', {
          tokenId: token.id,
          tokenSymbol: token.token_symbol,
          fromAddress: fromWallet.address,
          toAddress: toWallet.address,
          tokenBalance: tokenBalance.toString(),
          nativeBalance: nativeBalance.toString(),
          estimatedFee: gasQuote.estimatedFee.toString()
        });
        await this.planSkippedTask(token, fromWallet, toWallet, tokenBalance, gasQuote, 'insufficient native gas');
        return 'skipped';
      }

      log('candidate eligible: insufficient native gas, creating gas funding task', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address,
        toAddress: toWallet.address,
        tokenBalance: tokenBalance.toString(),
        nativeBalance: nativeBalance.toString(),
        estimatedFee: gasQuote.estimatedFee.toString()
      });
      const task = await this.planTask(token, fromWallet, toWallet, tokenBalance, gasQuote, token.token_address, 'gas_funding');
      await this.executeGasFundingTask(task, token, fromWallet, toWallet, nativeBalance, gasQuote);
      return 'created';
    }

    log('candidate eligible: creating ERC20 fund task', {
      tokenId: token.id,
      tokenSymbol: token.token_symbol,
      fromAddress: fromWallet.address,
      toAddress: toWallet.address,
      tokenBalance: tokenBalance.toString(),
      nativeBalance: nativeBalance.toString(),
      estimatedFee: gasQuote.estimatedFee.toString()
    });
    const task = await this.planTask(token, fromWallet, toWallet, tokenBalance, gasQuote, token.token_address);
    await this.executeTask(task, token, fromWallet, toWallet);
    return 'created';
  }

  private async evaluateAndCreateSolanaTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    inventoryBalance: bigint,
    source: 'deposit_cursor' | 'inventory_reconcile'
  ): Promise<'created' | 'skipped' | 'ignored'> {
    log('solana candidate evaluation started', {
      tokenId: token.id,
      tokenSymbol: token.token_symbol,
      chainId: token.chain_id,
      fromAddress: fromWallet.address,
      toAddress: toWallet.address,
      source,
      inventoryBalance: inventoryBalance.toString()
    });

    if (await this.db.hasOpenTask(fromWallet.address, token.id, token.chain_id)) {
      log('solana candidate ignored: open task exists', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address
      });
      return 'ignored';
    }

    const collectAmount = BigInt(token.collect_amount);
    if (source === 'inventory_reconcile' && inventoryBalance < collectAmount) {
      return 'ignored';
    }

    if (Boolean(token.is_native)) {
      const balance = await this.solana.getNativeBalance(fromWallet.address);
      const feeQuote = this.solana.quoteNativeTransfer();
      if (balance <= collectAmount || balance <= collectAmount + feeQuote.estimatedFee) {
        log('solana native candidate ignored: balance cannot cover threshold plus fee', {
          tokenId: token.id,
          tokenSymbol: token.token_symbol,
          fromAddress: fromWallet.address,
          balance: balance.toString(),
          collectAmount: collectAmount.toString(),
          estimatedFee: feeQuote.estimatedFee.toString()
        });
        return 'ignored';
      }

      const amount = balance - feeQuote.estimatedFee;
      const task = await this.planSolanaTask(token, fromWallet, toWallet, amount, feeQuote, null);
      await this.executeSolanaTask(task, token, fromWallet, toWallet);
      return 'created';
    }

    if (!token.token_address) {
      log('solana token candidate ignored: token mint missing', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address
      });
      return 'ignored';
    }

    const [sourceAta, targetAta] = await Promise.all([
      this.db.getSolanaTokenAccount(fromWallet.address, token.token_address),
      this.db.getSolanaTokenAccount(toWallet.address, token.token_address)
    ]);
    if (!sourceAta || !targetAta) {
      await this.planSolanaSkippedTask(token, fromWallet, toWallet, 0n, this.solana.quoteTokenTransfer(), 'missing Solana token account mapping');
      return 'skipped';
    }

    const [tokenBalance, nativeBalance] = await Promise.all([
      this.solana.getTokenAccountBalance(sourceAta.ata_address),
      this.solana.getNativeBalance(fromWallet.address)
    ]);
    const feeQuote = this.solana.quoteTokenTransfer();

    if (tokenBalance < collectAmount) {
      log('solana token candidate ignored: token balance below collect amount', {
        tokenId: token.id,
        tokenSymbol: token.token_symbol,
        fromAddress: fromWallet.address,
        tokenBalance: tokenBalance.toString(),
        collectAmount: collectAmount.toString()
      });
      return 'ignored';
    }

    if (nativeBalance < feeQuote.estimatedFee) {
      if (!config.solanaFeeTopUpEnabled) {
        await this.planSolanaSkippedTask(token, fromWallet, toWallet, tokenBalance, feeQuote, 'insufficient SOL fee');
        return 'skipped';
      }

      const task = await this.planSolanaTask(token, fromWallet, toWallet, tokenBalance, feeQuote, token.token_address, 'gas_funding', {
        sourceAta: sourceAta.ata_address,
        targetAta: targetAta.ata_address
      });
      await this.executeSolanaFeeFundingTask(task, token, fromWallet, toWallet, nativeBalance, feeQuote);
      return 'created';
    }

    const task = await this.planSolanaTask(token, fromWallet, toWallet, tokenBalance, feeQuote, token.token_address, 'planned', {
      sourceAta: sourceAta.ata_address,
      targetAta: targetAta.ata_address
    });
    await this.executeSolanaTask(task, token, fromWallet, toWallet);
    return 'created';
  }

  private async planTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    amount: bigint,
    gasQuote: GasQuote,
    tokenAddress: string | null,
    status: FundTaskStatus = 'planned'
  ): Promise<FundTaskRecord> {
    const operationId = uuidv4();
    const timestamp = nowIso();

    // gas 估算写入 metadata，后续签名和排障都复用同一份归集计划。
    const metadata = {
      tokenAddress,
      gas: this.evm.describeGas(gasQuote)
    };

    const createPayload = {
      operation_id: operationId,
      task_type: 'collect',
      chain_type: 'evm',
      chain_id: token.chain_id,
      token_id: token.id,
      token_symbol: token.token_symbol,
      from_address: fromWallet.address,
      to_address: toWallet.address,
      amount: amount.toString(),
      fee_amount: gasQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      status,
      error_message: null,
      retry_count: 0,
      metadata: JSON.stringify(metadata),
      created_at: timestamp,
      updated_at: timestamp
    } as Omit<FundTaskRecord, 'id'>;

    log('fund_tasks insert started', {
      operationId,
      status: createPayload.status,
      tokenId: createPayload.token_id,
      tokenSymbol: createPayload.token_symbol,
      fromAddress: createPayload.from_address,
      toAddress: createPayload.to_address,
      amount: createPayload.amount,
      feeAmount: createPayload.fee_amount
    });

    const taskId = await this.db.createTask(createPayload);
    log('fund_tasks insert success', {
      taskId,
      operationId,
      status: createPayload.status,
      tokenId: createPayload.token_id,
      tokenSymbol: createPayload.token_symbol,
      fromAddress: createPayload.from_address,
      toAddress: createPayload.to_address,
      amount: createPayload.amount
    });

    const [created] = await this.db.getTasks({ id: taskId });
    if (!created) {
      throw new Error(`created fund task ${taskId} not found`);
    }

    return created;
  }

  private async planSkippedTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    amount: bigint,
    gasQuote: GasQuote,
    reason: string
  ): Promise<void> {
    const timestamp = nowIso();

    // skipped 也是任务状态，不只是日志。这样任务查询接口能展示未归集原因。
    const createPayload = {
      operation_id: uuidv4(),
      task_type: 'collect',
      chain_type: 'evm',
      chain_id: token.chain_id,
      token_id: token.id,
      token_symbol: token.token_symbol,
      from_address: fromWallet.address,
      to_address: toWallet.address,
      amount: amount.toString(),
      fee_amount: gasQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      status: 'skipped',
      error_message: reason,
      retry_count: 0,
      metadata: JSON.stringify({
        tokenAddress: token.token_address,
        gas: this.evm.describeGas(gasQuote)
      }),
      created_at: timestamp,
      updated_at: timestamp
    } as Omit<FundTaskRecord, 'id'>;

    log('fund_tasks insert started', {
      operationId: createPayload.operation_id,
      status: createPayload.status,
      reason,
      tokenId: createPayload.token_id,
      tokenSymbol: createPayload.token_symbol,
      fromAddress: createPayload.from_address,
      toAddress: createPayload.to_address,
      amount: createPayload.amount,
      feeAmount: createPayload.fee_amount
    });

    const taskId = await this.db.createTask(createPayload);
    log('fund_tasks insert success', {
      taskId,
      operationId: createPayload.operation_id,
      status: createPayload.status,
      reason,
      tokenId: createPayload.token_id,
      tokenSymbol: createPayload.token_symbol,
      fromAddress: createPayload.from_address,
      toAddress: createPayload.to_address,
      amount: createPayload.amount
    });
  }

  private async planSolanaTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    amount: bigint,
    feeQuote: SolanaFeeQuote,
    tokenAddress: string | null,
    status: FundTaskStatus = 'planned',
    extraMetadata: Record<string, unknown> = {}
  ): Promise<FundTaskRecord> {
    const operationId = uuidv4();
    const timestamp = nowIso();

    const createPayload = {
      operation_id: operationId,
      task_type: 'collect',
      chain_type: 'solana',
      chain_id: token.chain_id,
      token_id: token.id,
      token_symbol: token.token_symbol,
      from_address: fromWallet.address,
      to_address: toWallet.address,
      amount: amount.toString(),
      fee_amount: feeQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      status,
      error_message: null,
      retry_count: 0,
      metadata: JSON.stringify({
        chain_type: 'solana',
        tokenAddress,
        token_type: token.token_type || (Boolean(token.is_native) ? 'sol-native' : 'spl-token'),
        estimatedFeeLamports: feeQuote.estimatedFee.toString(),
        ...extraMetadata
      }),
      created_at: timestamp,
      updated_at: timestamp
    } as Omit<FundTaskRecord, 'id'>;

    const taskId = await this.db.createTask(createPayload);
    log('solana fund_tasks insert success', {
      taskId,
      operationId,
      status,
      tokenId: token.id,
      tokenSymbol: token.token_symbol,
      fromAddress: fromWallet.address,
      toAddress: toWallet.address,
      amount: amount.toString()
    });

    const [created] = await this.db.getTasks({ id: taskId });
    if (!created) {
      throw new Error(`created solana fund task ${taskId} not found`);
    }
    return created;
  }

  private async planSolanaSkippedTask(
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    amount: bigint,
    feeQuote: SolanaFeeQuote,
    reason: string
  ): Promise<void> {
    const timestamp = nowIso();
    await this.db.createTask({
      operation_id: uuidv4(),
      task_type: 'collect',
      chain_type: 'solana',
      chain_id: token.chain_id,
      token_id: token.id,
      token_symbol: token.token_symbol,
      from_address: fromWallet.address,
      to_address: toWallet.address,
      amount: amount.toString(),
      fee_amount: feeQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      status: 'skipped',
      error_message: reason,
      retry_count: 0,
      metadata: JSON.stringify({
        chain_type: 'solana',
        tokenAddress: token.token_address,
        token_type: token.token_type || (Boolean(token.is_native) ? 'sol-native' : 'spl-token'),
        estimatedFeeLamports: feeQuote.estimatedFee.toString()
      }),
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  private async executeTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord
  ): Promise<string> {
    try {
      log('fund task execution started', {
        taskId: task.id,
        operationId: task.operation_id,
        tokenId: task.token_id,
        tokenSymbol: task.token_symbol,
        fromAddress: task.from_address,
        toAddress: task.to_address,
        amount: task.amount
      });

      // 归集从“用户充值地址”发起，所以 nonce 必须取该地址链上 pending nonce。
      // 不复用 wallet_nonces，避免污染热钱包提现的 nonce 管理。
      const nonce = await this.evm.getPendingNonce(fromWallet.address);
      const metadata = this.parseMetadata(task.metadata);
      const gas = metadata.gas as Record<string, string> | undefined;

      // 进入 signing 后，任务已经绑定 nonce。失败时会写 failed，方便追踪卡在哪一步。
      await this.db.updateTask(task.id, {
        status: 'signing',
        nonce,
        to_address: toWallet.address,
        updated_at: nowIso()
      });
      log('fund task status updated to signing', { taskId: task.id, nonce });

      // signer 需要的字段保持和 wallet 提现一致：原生币直接转 to，ERC20 则 tokenAddress=合约地址。
      const signRequest = {
        address: fromWallet.address,
        to: toWallet.address,
        amount: task.amount,
        ...(token.token_address && !Boolean(token.is_native) && { tokenAddress: token.token_address }),
        ...(gas?.gas && { gas: gas.gas }),
        ...(gas?.maxFeePerGas && { maxFeePerGas: gas.maxFeePerGas }),
        ...(gas?.maxPriorityFeePerGas && { maxPriorityFeePerGas: gas.maxPriorityFeePerGas }),
        ...(gas?.gasPrice && { gasPrice: gas.gasPrice }),
        nonce,
        type: gas?.gasPrice ? 0 as const : 2 as const,
        chainId: token.chain_id,
        chainType: 'evm' as const,
        tokenType: token.token_type || (Boolean(token.is_native) ? 'native' : 'erc20'),
        businessType: 'collect' as const
      };

      // 风控签名和业务签名都在 SignerClient 内完成；这里拿到的是已签名原始交易。
      log('requesting transaction signature', { taskId: task.id, operationId: task.operation_id, nonce });
      const signed = await this.signer.signTransaction(signRequest, task.operation_id);
      log('transaction signed, broadcasting', { taskId: task.id, operationId: task.operation_id });
      const txHash = await this.evm.sendRawTransaction(signed.signedTransaction);

      // pending 表示交易已广播，后续由 monitorReceipts 根据链上 receipt 推进状态。
      await this.db.updateTask(task.id, {
        status: 'pending',
        tx_hash: txHash,
        updated_at: nowIso()
      });
      log('fund task status updated to pending', { taskId: task.id, txHash });

      return txHash;
    } catch (error) {
      // 任何签名、广播或上游服务异常都落到任务上，避免只出现在进程日志里。
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: nowIso()
      });
      logError('fund task execution failed, task marked failed', error, { taskId: task.id });
      throw error;
    }
  }

  private async executeSolanaTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord
  ): Promise<string> {
    try {
      const blockhash = await this.solana.getLatestBlockhash();
      const metadata = this.parseMetadata(task.metadata);
      const tokenType = token.token_type || (Boolean(token.is_native) ? 'sol-native' : 'spl-token');

      await this.db.updateTask(task.id, {
        status: 'signing',
        nonce: 0,
        to_address: toWallet.address,
        metadata: this.mergeMetadata(task.metadata, {
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight
        }),
        updated_at: nowIso()
      });
      log('solana fund task status updated to signing', { taskId: task.id, blockhash: blockhash.blockhash });

      const signRequest = {
        address: fromWallet.address,
        to: toWallet.address,
        amount: task.amount,
        ...(token.token_address && !Boolean(token.is_native) && { tokenAddress: token.token_address }),
        nonce: 0,
        type: 0 as const,
        chainId: token.chain_id,
        chainType: 'solana' as const,
        tokenType,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        fee: String(metadata.estimatedFeeLamports || task.fee_amount),
        businessType: 'collect' as const
      };

      const signed = await this.signer.signTransaction(signRequest, task.operation_id);
      const txHash = await this.solana.sendRawTransaction(signed.signedTransaction);

      await this.db.updateTask(task.id, {
        status: 'pending',
        tx_hash: txHash,
        metadata: this.mergeMetadata(task.metadata, {
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          signedTransactionHash: signed.transactionHash
        }),
        updated_at: nowIso()
      });
      log('solana fund task status updated to pending', { taskId: task.id, txHash });

      return txHash;
    } catch (error) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: nowIso()
      });
      logError('solana fund task execution failed, task marked failed', error, { taskId: task.id });
      throw error;
    }
  }

  private async executeGasFundingTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    nativeBalanceBefore: bigint,
    collectGasQuote: GasQuote
  ): Promise<string> {
    try {
      const topUp = await this.buildGasTopUpPlan(toWallet.address, fromWallet.address, nativeBalanceBefore, collectGasQuote);
      const hotWalletBalance = await this.evm.getNativeBalance(toWallet.address);
      const hotWalletRequired = topUp.amount + topUp.gasFundingFee;

      if (hotWalletBalance < hotWalletRequired) {
        throw new Error(`hot wallet native balance insufficient for ERC20 gas top-up: required ${hotWalletRequired}, available ${hotWalletBalance}`);
      }

      const nonce = await this.evm.getPendingNonce(toWallet.address);
      const gas = this.evm.describeGas(topUp.gasQuote);

      await this.db.updateTask(task.id, {
        status: 'gas_funding',
        fee_amount: (topUp.amount + topUp.gasFundingFee).toString(),
        metadata: this.mergeMetadata(task.metadata, {
          tokenAddress: token.token_address,
          gas: this.evm.describeGas(collectGasQuote),
          gasFundingGas: gas,
          gasFundingAmount: topUp.amount.toString(),
          gasFundingFee: topUp.gasFundingFee.toString(),
          nativeBalanceBefore: nativeBalanceBefore.toString(),
          requiredGasFee: topUp.requiredGasFee.toString(),
          gasFundingFromAddress: toWallet.address,
          gasFundingToAddress: fromWallet.address,
          gasFundingNonce: nonce
        }),
        updated_at: nowIso()
      });
      log('fund task status updated to gas_funding', {
        taskId: task.id,
        fromAddress: toWallet.address,
        toAddress: fromWallet.address,
        gasFundingAmount: topUp.amount.toString(),
        nonce
      });

      const signRequest = {
        address: toWallet.address,
        to: fromWallet.address,
        amount: topUp.amount.toString(),
        ...(gas.gas && { gas: gas.gas }),
        ...(gas.maxFeePerGas && { maxFeePerGas: gas.maxFeePerGas }),
        ...(gas.maxPriorityFeePerGas && { maxPriorityFeePerGas: gas.maxPriorityFeePerGas }),
        ...(gas.gasPrice && { gasPrice: gas.gasPrice }),
        nonce,
        type: gas.gasPrice ? 0 as const : 2 as const,
        chainId: token.chain_id,
        chainType: 'evm' as const,
        tokenType: 'native',
        fee: topUp.gasFundingFee.toString(),
        businessType: 'collect' as const
      };

      // 这笔 ETH 是平台给充值地址补 ERC20 归集 gas，不是用户充值；扫描器会按 txHash 跳过入账。
      const signed = await this.signer.signTransaction(signRequest, task.operation_id);
      const txHash = await this.evm.sendRawTransaction(signed.signedTransaction);
      const gasFundingMetadata = {
        tokenAddress: token.token_address,
        gas: this.evm.describeGas(collectGasQuote),
        gasFundingGas: gas,
        gasFundingTxHash: txHash,
        gasFundingAmount: topUp.amount.toString(),
        gasFundingFee: topUp.gasFundingFee.toString(),
        nativeBalanceBefore: nativeBalanceBefore.toString(),
        requiredGasFee: topUp.requiredGasFee.toString(),
        gasFundingFromAddress: toWallet.address,
        gasFundingToAddress: fromWallet.address,
        gasFundingNonce: nonce
      };

      await this.db.updateTask(task.id, {
        status: 'gas_pending',
        metadata: this.mergeMetadata(task.metadata, gasFundingMetadata),
        updated_at: nowIso()
      });
      log('gas funding transaction broadcasted', { taskId: task.id, txHash, gasFundingAmount: topUp.amount.toString() });

      return txHash;
    } catch (error) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: nowIso()
      });
      logError('gas funding failed, task marked failed', error, { taskId: task.id });
      throw error;
    }
  }

  private async executeSolanaFeeFundingTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord,
    nativeBalanceBefore: bigint,
    collectFeeQuote: SolanaFeeQuote
  ): Promise<string> {
    try {
      const topUp = this.buildSolanaFeeTopUpPlan(nativeBalanceBefore, collectFeeQuote);
      const hotWalletBalance = await this.solana.getNativeBalance(toWallet.address);
      const hotWalletRequired = topUp.amount + topUp.gasFundingFee;
      if (hotWalletBalance < hotWalletRequired) {
        throw new Error(`Solana hot wallet SOL insufficient for fee top-up: required ${hotWalletRequired}, available ${hotWalletBalance}`);
      }

      const blockhash = await this.solana.getLatestBlockhash();
      await this.db.updateTask(task.id, {
        status: 'gas_funding',
        fee_amount: hotWalletRequired.toString(),
        metadata: this.mergeMetadata(task.metadata, {
          gasFundingFromAddress: toWallet.address,
          gasFundingToAddress: fromWallet.address,
          gasFundingAmount: topUp.amount.toString(),
          gasFundingFee: topUp.gasFundingFee.toString(),
          requiredFeeLamports: topUp.requiredFeeLamports.toString(),
          nativeBalanceBefore: nativeBalanceBefore.toString(),
          gasFundingBlockhash: blockhash.blockhash,
          gasFundingLastValidBlockHeight: blockhash.lastValidBlockHeight
        }),
        updated_at: nowIso()
      });

      const signed = await this.signer.signTransaction({
        address: toWallet.address,
        to: fromWallet.address,
        amount: topUp.amount.toString(),
        nonce: 0,
        type: 0 as const,
        chainId: token.chain_id,
        chainType: 'solana' as const,
        tokenType: 'sol-native',
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        fee: topUp.gasFundingFee.toString(),
        businessType: 'collect' as const
      }, task.operation_id);
      const txHash = await this.solana.sendRawTransaction(signed.signedTransaction);

      await this.db.updateTask(task.id, {
        status: 'gas_pending',
        metadata: this.mergeMetadata(task.metadata, {
          gasFundingFromAddress: toWallet.address,
          gasFundingToAddress: fromWallet.address,
          gasFundingAmount: topUp.amount.toString(),
          gasFundingFee: topUp.gasFundingFee.toString(),
          gasFundingTxHash: txHash,
          requiredFeeLamports: topUp.requiredFeeLamports.toString(),
          nativeBalanceBefore: nativeBalanceBefore.toString(),
          gasFundingBlockhash: blockhash.blockhash,
          gasFundingLastValidBlockHeight: blockhash.lastValidBlockHeight
        }),
        updated_at: nowIso()
      });
      log('solana fee funding transaction broadcasted', { taskId: task.id, txHash, gasFundingAmount: topUp.amount.toString() });

      return txHash;
    } catch (error) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: nowIso()
      });
      logError('solana fee funding failed, task marked failed', error, { taskId: task.id });
      throw error;
    }
  }

  private async replanAndExecuteExistingTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord
  ): Promise<{ txHash?: string; status: FundTaskStatus }> {
    const retryCount = task.retry_count + 1;
    const isNative = Boolean(token.is_native);

    if (isNative) {
      const balance = await this.evm.getNativeBalance(fromWallet.address);
      const collectAmount = BigInt(token.collect_amount);
      if (balance <= collectAmount) {
        await this.db.updateTask(task.id, {
          retry_count: retryCount,
          status: 'skipped',
          amount: '0',
          fee_amount: '0',
          tx_hash: null,
          nonce: null,
          error_message: 'native balance below collect amount on retry',
          updated_at: nowIso()
        });
        return { status: 'skipped' };
      }

      const gasQuote = await this.evm.quoteNativeTransfer(fromWallet.address, toWallet.address, balance);
      if (balance <= collectAmount + gasQuote.estimatedFee) {
        await this.db.updateTask(task.id, {
          retry_count: retryCount,
          status: 'skipped',
          amount: '0',
          fee_amount: gasQuote.estimatedFee.toString(),
          tx_hash: null,
          nonce: null,
          error_message: 'native balance cannot cover threshold plus gas on retry',
          metadata: JSON.stringify({ tokenAddress: null, gas: this.evm.describeGas(gasQuote) }),
          updated_at: nowIso()
        });
        return { status: 'skipped' };
      }

      const amount = balance - gasQuote.estimatedFee;
      await this.db.updateTask(task.id, {
        retry_count: retryCount,
        status: 'planned',
        amount: amount.toString(),
        fee_amount: gasQuote.estimatedFee.toString(),
        tx_hash: null,
        nonce: null,
        error_message: null,
        metadata: JSON.stringify({ tokenAddress: null, gas: this.evm.describeGas(gasQuote) }),
        updated_at: nowIso()
      });

      const [updated] = await this.db.getTasks({ id: task.id });
      const txHash = await this.executeTask(updated || task, token, fromWallet, toWallet);
      return { txHash, status: 'pending' };
    }

    if (!token.token_address) {
      throw new Error(`token ${token.id} token_address is required`);
    }

    const [tokenBalance, nativeBalance] = await Promise.all([
      this.evm.getErc20Balance(token.token_address, fromWallet.address),
      this.evm.getNativeBalance(fromWallet.address)
    ]);
    const collectAmount = BigInt(token.collect_amount);
    if (tokenBalance < collectAmount) {
      await this.db.updateTask(task.id, {
        retry_count: retryCount,
        status: 'skipped',
        amount: tokenBalance.toString(),
        fee_amount: '0',
        tx_hash: null,
        nonce: null,
        error_message: 'ERC20 balance below collect amount on retry',
        updated_at: nowIso()
      });
      return { status: 'skipped' };
    }

    const gasQuote = await this.evm.quoteErc20Transfer(fromWallet.address, token.token_address, toWallet.address, tokenBalance);
    await this.db.updateTask(task.id, {
      retry_count: retryCount,
      status: nativeBalance < gasQuote.estimatedFee && config.erc20GasTopUpEnabled ? 'gas_funding' : 'planned',
      amount: tokenBalance.toString(),
      fee_amount: gasQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      error_message: nativeBalance < gasQuote.estimatedFee && !config.erc20GasTopUpEnabled ? 'insufficient native gas' : null,
      metadata: JSON.stringify({ tokenAddress: token.token_address, gas: this.evm.describeGas(gasQuote) }),
      updated_at: nowIso()
    });

    const [updated] = await this.db.getTasks({ id: task.id });
    const updatedTask = updated || task;
    if (nativeBalance < gasQuote.estimatedFee) {
      if (!config.erc20GasTopUpEnabled) {
        await this.db.updateTask(task.id, { status: 'skipped', updated_at: nowIso() });
        return { status: 'skipped' };
      }
      const txHash = await this.executeGasFundingTask(updatedTask, token, fromWallet, toWallet, nativeBalance, gasQuote);
      return { txHash, status: 'gas_pending' };
    }

    const txHash = await this.executeTask(updatedTask, token, fromWallet, toWallet);
    return { txHash, status: 'pending' };
  }

  private async replanAndExecuteExistingSolanaTask(
    task: FundTaskRecord,
    token: TokenRecord,
    fromWallet: WalletRecord,
    toWallet: WalletRecord
  ): Promise<{ txHash?: string; status: FundTaskStatus }> {
    const retryCount = task.retry_count + 1;
    const collectAmount = BigInt(token.collect_amount);

    if (Boolean(token.is_native)) {
      const balance = await this.solana.getNativeBalance(fromWallet.address);
      const feeQuote = this.solana.quoteNativeTransfer();
      if (balance <= collectAmount || balance <= collectAmount + feeQuote.estimatedFee) {
        await this.db.updateTask(task.id, {
          retry_count: retryCount,
          status: 'skipped',
          amount: '0',
          fee_amount: feeQuote.estimatedFee.toString(),
          tx_hash: null,
          nonce: null,
          error_message: 'SOL balance cannot cover threshold plus fee on retry',
          updated_at: nowIso()
        });
        return { status: 'skipped' };
      }

      await this.db.updateTask(task.id, {
        retry_count: retryCount,
        status: 'planned',
        amount: (balance - feeQuote.estimatedFee).toString(),
        fee_amount: feeQuote.estimatedFee.toString(),
        tx_hash: null,
        nonce: null,
        error_message: null,
        metadata: this.mergeMetadata(task.metadata, {
          chain_type: 'solana',
          tokenAddress: null,
          token_type: 'sol-native',
          estimatedFeeLamports: feeQuote.estimatedFee.toString()
        }),
        updated_at: nowIso()
      });
      const [updated] = await this.db.getTasks({ id: task.id });
      const txHash = await this.executeSolanaTask(updated || task, token, fromWallet, toWallet);
      return { txHash, status: 'pending' };
    }

    if (!token.token_address) {
      throw new Error(`Solana token ${token.id} token_address is required`);
    }

    const sourceAta = await this.db.getSolanaTokenAccount(fromWallet.address, token.token_address);
    const targetAta = await this.db.getSolanaTokenAccount(toWallet.address, token.token_address);
    if (!sourceAta || !targetAta) {
      await this.db.updateTask(task.id, {
        retry_count: retryCount,
        status: 'skipped',
        error_message: 'missing Solana token account mapping on retry',
        updated_at: nowIso()
      });
      return { status: 'skipped' };
    }

    const [tokenBalance, nativeBalance] = await Promise.all([
      this.solana.getTokenAccountBalance(sourceAta.ata_address),
      this.solana.getNativeBalance(fromWallet.address)
    ]);
    const feeQuote = this.solana.quoteTokenTransfer();

    if (tokenBalance < collectAmount) {
      await this.db.updateTask(task.id, {
        retry_count: retryCount,
        status: 'skipped',
        amount: tokenBalance.toString(),
        fee_amount: feeQuote.estimatedFee.toString(),
        tx_hash: null,
        nonce: null,
        error_message: 'Solana token balance below collect amount on retry',
        updated_at: nowIso()
      });
      return { status: 'skipped' };
    }

    await this.db.updateTask(task.id, {
      retry_count: retryCount,
      status: nativeBalance < feeQuote.estimatedFee && config.solanaFeeTopUpEnabled ? 'gas_funding' : 'planned',
      amount: tokenBalance.toString(),
      fee_amount: feeQuote.estimatedFee.toString(),
      tx_hash: null,
      nonce: null,
      error_message: nativeBalance < feeQuote.estimatedFee && !config.solanaFeeTopUpEnabled ? 'insufficient SOL fee' : null,
      metadata: this.mergeMetadata(task.metadata, {
        chain_type: 'solana',
        tokenAddress: token.token_address,
        token_type: token.token_type || 'spl-token',
        estimatedFeeLamports: feeQuote.estimatedFee.toString(),
        sourceAta: sourceAta.ata_address,
        targetAta: targetAta.ata_address
      }),
      updated_at: nowIso()
    });

    const [updated] = await this.db.getTasks({ id: task.id });
    const updatedTask = updated || task;
    if (nativeBalance < feeQuote.estimatedFee) {
      if (!config.solanaFeeTopUpEnabled) {
        await this.db.updateTask(task.id, { status: 'skipped', updated_at: nowIso() });
        return { status: 'skipped' };
      }
      const txHash = await this.executeSolanaFeeFundingTask(updatedTask, token, fromWallet, toWallet, nativeBalance, feeQuote);
      return { txHash, status: 'gas_pending' };
    }

    const txHash = await this.executeSolanaTask(updatedTask, token, fromWallet, toWallet);
    return { txHash, status: 'pending' };
  }

  private async handleGasFundingReceipt(task: FundTaskRecord, blockNumber: number): Promise<void> {
    const [token] = await this.db.getCollectableEvmTokens(task.chain_id).then(tokens => tokens.filter(item => item.id === task.token_id));
    if (!token || !token.token_address) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: `token ${task.token_id} is not collectable after gas funding`,
        updated_at: nowIso()
      });
      return;
    }

    const [fromWallet] = await this.db.getActiveUserWallets().then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.from_address.toLowerCase())
    );
    const [toWallet] = await this.db.getActiveHotWallets().then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.to_address.toLowerCase())
    );

    if (!fromWallet || !toWallet) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: 'source user wallet or target hot wallet is inactive after gas funding',
        updated_at: nowIso()
      });
      return;
    }

    const metadata = this.parseMetadata(task.metadata);
    const gasMetadata = metadata.gas as Record<string, string> | undefined;
    const requiredGasFee = BigInt(String(metadata.requiredGasFee || gasMetadata?.estimatedFee || '0'));
    const nativeBalance = await this.evm.getNativeBalance(task.from_address);

    await this.db.updateTask(task.id, {
      status: 'gas_funded',
      error_message: null,
      metadata: this.mergeMetadata(task.metadata, {
        gasFundingBlockNumber: blockNumber,
        nativeBalanceAfterFunding: nativeBalance.toString()
      }),
      updated_at: nowIso()
    });
    log('gas funding confirmed', {
      taskId: task.id,
      blockNumber,
      nativeBalanceAfterFunding: nativeBalance.toString(),
      requiredGasFee: requiredGasFee.toString()
    });

    if (nativeBalance < requiredGasFee) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: `native gas still insufficient after top-up: required ${requiredGasFee}, available ${nativeBalance}`,
        updated_at: nowIso()
      });
      log('gas funding confirmed but balance still insufficient', { taskId: task.id });
      return;
    }

    const refreshed = (await this.db.getTasks({ id: task.id }))[0] || task;
    await this.executeTask(refreshed, token, fromWallet, toWallet);
  }

  private async handleSolanaFeeFundingReceipt(task: FundTaskRecord, slot: number, feeLamports: bigint): Promise<void> {
    const [token] = await this.db.getCollectableSolanaTokens(task.chain_id).then(tokens => tokens.filter(item => item.id === task.token_id));
    if (!token || !token.token_address) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: `Solana token ${task.token_id} is not collectable after fee funding`,
        updated_at: nowIso()
      });
      return;
    }

    const [fromWallet] = await this.db.getActiveUserWallets('solana').then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.from_address.toLowerCase())
    );
    const [toWallet] = await this.db.getActiveHotWallets('solana').then(wallets =>
      wallets.filter(wallet => wallet.address.toLowerCase() === task.to_address.toLowerCase())
    );
    if (!fromWallet || !toWallet) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: 'source Solana wallet or target hot wallet is inactive after fee funding',
        updated_at: nowIso()
      });
      return;
    }

    const metadata = this.parseMetadata(task.metadata);
    const requiredFeeLamports = BigInt(String(metadata.requiredFeeLamports || task.fee_amount || '0'));
    const nativeBalance = await this.solana.getNativeBalance(task.from_address);

    await this.db.updateTask(task.id, {
      status: 'gas_funded',
      error_message: null,
      metadata: this.mergeMetadata(task.metadata, {
        gasFundingSlot: slot,
        gasFundingFeeLamports: feeLamports.toString(),
        nativeBalanceAfterFunding: nativeBalance.toString()
      }),
      updated_at: nowIso()
    });

    if (nativeBalance < requiredFeeLamports) {
      await this.db.updateTask(task.id, {
        status: 'failed',
        error_message: `SOL fee still insufficient after top-up: required ${requiredFeeLamports}, available ${nativeBalance}`,
        updated_at: nowIso()
      });
      return;
    }

    const refreshed = (await this.db.getTasks({ id: task.id }))[0] || task;
    await this.executeSolanaTask(refreshed, token, fromWallet, toWallet);
  }

  private async buildGasTopUpPlan(
    hotWalletAddress: string,
    userAddress: string,
    nativeBalance: bigint,
    collectGasQuote: GasQuote
  ): Promise<GasTopUpPlan> {
    const bufferedRequired = (collectGasQuote.estimatedFee * BigInt(config.erc20GasTopUpBufferBps) + 9999n) / 10000n;
    let amount = bufferedRequired > nativeBalance ? bufferedRequired - nativeBalance : 0n;
    if (amount < config.erc20GasTopUpMinWei) {
      amount = config.erc20GasTopUpMinWei;
    }
    if (config.erc20GasTopUpMaxWei !== undefined && amount > config.erc20GasTopUpMaxWei) {
      throw new Error(`ERC20 gas top-up amount ${amount} exceeds ERC20_GAS_TOP_UP_MAX_WEI ${config.erc20GasTopUpMaxWei}`);
    }

    const gasQuote = await this.evm.quoteGasTopUpTransfer(hotWalletAddress, userAddress, amount);
    return {
      amount,
      requiredGasFee: collectGasQuote.estimatedFee,
      gasFundingFee: gasQuote.estimatedFee,
      gasQuote
    };
  }

  private buildSolanaFeeTopUpPlan(
    nativeBalance: bigint,
    collectFeeQuote: SolanaFeeQuote
  ): { amount: bigint; requiredFeeLamports: bigint; gasFundingFee: bigint } {
    const bufferedRequired = (collectFeeQuote.estimatedFee * BigInt(config.solanaFeeTopUpBufferBps) + 9999n) / 10000n;
    let amount = bufferedRequired > nativeBalance ? bufferedRequired - nativeBalance : 0n;
    if (amount < config.solanaFeeTopUpMinLamports) {
      amount = config.solanaFeeTopUpMinLamports;
    }
    if (config.solanaFeeTopUpMaxLamports !== undefined && amount > config.solanaFeeTopUpMaxLamports) {
      throw new Error(`Solana fee top-up amount ${amount} exceeds SOLANA_FEE_TOP_UP_MAX_LAMPORTS ${config.solanaFeeTopUpMaxLamports}`);
    }

    return {
      amount,
      requiredFeeLamports: collectFeeQuote.estimatedFee,
      gasFundingFee: this.solana.quoteNativeTransfer().estimatedFee
    };
  }

  private async finalizeTask(task: FundTaskRecord, blockNumber: number): Promise<void> {
    // 先标记 confirmed，表示链上已成功；只有两条 collect 流水都写完后才 finalized。
    await this.db.updateTask(task.id, {
      status: 'confirmed',
      error_message: null,
      metadata: this.mergeMetadata(task.metadata, { blockNumber }),
      updated_at: nowIso()
    });
    log('fund task status updated to confirmed', { taskId: task.id, blockNumber });

    const referenceId = String(task.id);
    const timestamp = nowIso();
    const sourceUserId = await this.getWalletUserId(task.from_address);
    const targetUserId = await this.getWalletUserId(task.to_address);

    // 用户充值地址侧记负数 collect：表示地址库存从用户充值地址迁出。
    // 这不是用户提现，不应该改变用户资产展示口径；余额视图需只统计 deposit/withdraw 等业务口径。
    await this.db.insertCredit({
      user_id: sourceUserId,
      address: task.from_address,
      token_id: task.token_id,
      token_symbol: task.token_symbol,
      amount: `-${task.amount}`,
      credit_type: 'collect',
      business_type: 'blockchain',
      reference_id: referenceId,
      reference_type: 'fund_task',
      chain_id: task.chain_id,
      chain_type: task.chain_type,
      status: 'finalized',
      block_number: blockNumber,
      tx_hash: task.tx_hash,
      event_index: 0,
      metadata: JSON.stringify({ fund_task_id: task.id }),
      created_at: timestamp,
      updated_at: timestamp
    });
    log('source collect credit inserted', {
      taskId: task.id,
      address: task.from_address,
      amount: `-${task.amount}`,
      blockNumber,
      txHash: task.tx_hash
    });

    // 热钱包地址侧记正数 collect：表示系统热钱包库存增加，便于后续提现资金来源审计。
    await this.db.insertCredit({
      user_id: targetUserId,
      address: task.to_address,
      token_id: task.token_id,
      token_symbol: task.token_symbol,
      amount: task.amount,
      credit_type: 'collect',
      business_type: 'blockchain',
      reference_id: referenceId,
      reference_type: 'fund_task',
      chain_id: task.chain_id,
      chain_type: task.chain_type,
      status: 'finalized',
      block_number: blockNumber,
      tx_hash: task.tx_hash,
      event_index: 1,
      metadata: JSON.stringify({ fund_task_id: task.id }),
      created_at: timestamp,
      updated_at: timestamp
    });
    log('target collect credit inserted', {
      taskId: task.id,
      address: task.to_address,
      amount: task.amount,
      blockNumber,
      txHash: task.tx_hash
    });

    await this.db.updateTask(task.id, {
      status: 'finalized',
      updated_at: nowIso()
    });
    log('fund task finalized', { taskId: task.id, blockNumber, txHash: task.tx_hash });
  }

  private async finalizeSolanaTask(task: FundTaskRecord, slot: number, feeLamports: bigint): Promise<void> {
    await this.db.updateTask(task.id, {
      status: 'confirmed',
      error_message: null,
      fee_amount: feeLamports > 0n ? feeLamports.toString() : task.fee_amount,
      metadata: this.mergeMetadata(task.metadata, {
        chain_type: 'solana',
        slot,
        feeLamports: feeLamports.toString()
      }),
      updated_at: nowIso()
    });

    const referenceId = String(task.id);
    const timestamp = nowIso();
    const sourceUserId = await this.getWalletUserId(task.from_address, 'solana');
    const targetUserId = await this.getWalletUserId(task.to_address, 'solana');
    const metadata = this.parseMetadata(task.metadata);
    const tokenType = String(metadata.token_type || '');

    await this.db.insertCredit({
      user_id: sourceUserId,
      address: task.from_address,
      token_id: task.token_id,
      token_symbol: task.token_symbol,
      amount: `-${task.amount}`,
      credit_type: 'collect',
      business_type: 'blockchain',
      reference_id: referenceId,
      reference_type: 'fund_task',
      chain_id: task.chain_id,
      chain_type: 'solana',
      status: 'finalized',
      block_number: slot,
      tx_hash: task.tx_hash,
      event_index: 0,
      metadata: JSON.stringify({ fund_task_id: task.id, chain_type: 'solana', token_type: tokenType, slot, feeLamports: feeLamports.toString() }),
      created_at: timestamp,
      updated_at: timestamp
    });

    await this.db.insertCredit({
      user_id: targetUserId,
      address: task.to_address,
      token_id: task.token_id,
      token_symbol: task.token_symbol,
      amount: task.amount,
      credit_type: 'collect',
      business_type: 'blockchain',
      reference_id: referenceId,
      reference_type: 'fund_task',
      chain_id: task.chain_id,
      chain_type: 'solana',
      status: 'finalized',
      block_number: slot,
      tx_hash: task.tx_hash,
      event_index: 1,
      metadata: JSON.stringify({ fund_task_id: task.id, chain_type: 'solana', token_type: tokenType, slot, feeLamports: feeLamports.toString() }),
      created_at: timestamp,
      updated_at: timestamp
    });

    await this.db.updateTask(task.id, {
      status: 'finalized',
      updated_at: nowIso()
    });
    log('solana fund task finalized', { taskId: task.id, slot, txHash: task.tx_hash });
  }

  private async monitorSolanaTaskReceipt(
    task: FundTaskRecord,
    metadata: Record<string, unknown>,
    txHash: string
  ): Promise<void> {
    log('solana receipt monitor checking task', { taskId: task.id, status: task.status, txHash });
    const receipt = await this.solana.getReceipt(txHash);
    if (!receipt) {
      await this.scheduleNextReceiptCheck(task, metadata);
      log('solana receipt not available yet', { taskId: task.id, txHash });
      return;
    }

    if (receipt.status === 'success') {
      if (task.status === 'gas_pending') {
        await this.handleSolanaFeeFundingReceipt(task, receipt.slot, receipt.feeLamports);
        return;
      }

      if (task.status !== 'finalized') {
        await this.finalizeSolanaTask(task, receipt.slot, receipt.feeLamports);
      }
      return;
    }

    await this.db.updateTask(task.id, {
      status: 'failed',
      error_message: 'Solana transaction failed',
      metadata: this.mergeMetadata(task.metadata, {
        receiptStatus: receipt.status,
        slot: receipt.slot,
        failedTxHash: txHash,
        solanaError: receipt.err ? JSON.stringify(receipt.err) : null
      }),
      updated_at: nowIso()
    });
    log('solana receipt failed, task marked failed', { taskId: task.id, txHash, slot: receipt.slot });
  }

  private async loadCollectionCandidates(tokens: TokenRecord[], wallets: WalletRecord[]): Promise<CollectionCandidateInput[]> {
    const tokenById = new Map(tokens.map(token => [token.id, token]));
    const walletByAddress = new Map(wallets.map(wallet => [wallet.address.toLowerCase(), wallet]));
    const inventoryByPair = await this.loadInventoryByPair();

    const candidates = new Map<string, CollectionCandidateInput>();
    const depositCursorCandidates = await this.loadDepositCursorCandidates(tokenById, walletByAddress, inventoryByPair);
    for (const candidate of depositCursorCandidates) {
      candidates.set(this.candidateKey(candidate.wallet.address, candidate.token.id), candidate);
    }

    const reconcileCandidates = await this.loadInventoryReconcileCandidates(tokenById, walletByAddress, inventoryByPair);
    for (const candidate of reconcileCandidates) {
      const key = this.candidateKey(candidate.wallet.address, candidate.token.id);
      if (!candidates.has(key)) {
        candidates.set(key, candidate);
      }
    }

    log('collection candidates prepared', {
      depositCursorCandidates: depositCursorCandidates.length,
      inventoryReconcileCandidates: reconcileCandidates.length,
      dedupedCandidates: candidates.size
    });

    return [...candidates.values()];
  }

  private async loadSolanaCollectionCandidates(tokens: TokenRecord[], wallets: WalletRecord[]): Promise<CollectionCandidateInput[]> {
    const tokenById = new Map(tokens.map(token => [token.id, token]));
    const walletByAddress = new Map(wallets.map(wallet => [wallet.address.toLowerCase(), wallet]));
    const inventoryByPair = await this.loadSolanaInventoryByPair();

    const candidates = new Map<string, CollectionCandidateInput>();
    const depositCursorCandidates = await this.loadSolanaDepositCursorCandidates(tokenById, walletByAddress, inventoryByPair);
    for (const candidate of depositCursorCandidates) {
      candidates.set(this.candidateKey(candidate.wallet.address, candidate.token.id), candidate);
    }

    const reconcileCandidates = await this.loadSolanaInventoryReconcileCandidates(tokenById, walletByAddress, inventoryByPair);
    for (const candidate of reconcileCandidates) {
      const key = this.candidateKey(candidate.wallet.address, candidate.token.id);
      if (!candidates.has(key)) {
        candidates.set(key, candidate);
      }
    }

    log('solana collection candidates prepared', {
      depositCursorCandidates: depositCursorCandidates.length,
      inventoryReconcileCandidates: reconcileCandidates.length,
      dedupedCandidates: candidates.size
    });

    return [...candidates.values()];
  }

  private async loadDepositCursorCandidates(
    tokenById: Map<number, TokenRecord>,
    walletByAddress: Map<string, WalletRecord>,
    inventoryByPair: Map<string, bigint>
  ): Promise<CollectionCandidateInput[]> {
    const cursorName = this.depositCursorName();
    const cursor = await this.getOrCreateCursor(cursorName);
    const rows = await this.db.getDepositTransactionsAfterCursor({
      lastBlockNo: cursor.blockNo,
      lastRowId: cursor.rowId,
      limit: config.depositCandidateBatchSize,
      statuses: COLLECTABLE_DEPOSIT_STATUSES
    });

    if (rows.length === 0) {
      log('deposit cursor has no new rows', { cursorName, blockNo: cursor.blockNo, rowId: cursor.rowId });
      return [];
    }

    const candidates = this.buildCandidatesFromTransactions(rows, tokenById, walletByAddress, inventoryByPair, 'deposit_cursor');
    const lastRow = rows[rows.length - 1]!;
    await this.saveCursor(cursorName, {
      blockNo: Number(lastRow.block_no || cursor.blockNo),
      rowId: lastRow.id
    }, {
      rowsSeen: rows.length,
      candidates: candidates.length,
      lastTxHash: lastRow.tx_hash
    });

    log('deposit cursor advanced', {
      cursorName,
      rowsSeen: rows.length,
      candidates: candidates.length,
      blockNo: lastRow.block_no,
      rowId: lastRow.id
    });

    return candidates;
  }

  private async loadSolanaDepositCursorCandidates(
    tokenById: Map<number, TokenRecord>,
    walletByAddress: Map<string, WalletRecord>,
    inventoryByPair: Map<string, bigint>
  ): Promise<CollectionCandidateInput[]> {
    const cursorName = this.solanaDepositCursorName();
    const cursor = await this.getOrCreateCursor(cursorName);
    const rows = await this.db.getSolanaDepositTransactionsAfterCursor({
      lastSlot: cursor.blockNo,
      lastRowId: cursor.rowId,
      limit: config.depositCandidateBatchSize,
      statuses: COLLECTABLE_DEPOSIT_STATUSES
    });

    if (rows.length === 0) {
      log('solana deposit cursor has no new rows', { cursorName, slot: cursor.blockNo, rowId: cursor.rowId });
      return [];
    }

    const candidates = new Map<string, CollectionCandidateInput>();
    for (const row of rows) {
      const address = row.to_addr?.toLowerCase();
      if (!address) continue;

      const wallet = walletByAddress.get(address);
      if (!wallet) continue;

      const token = this.findTokenForSolanaTransaction(row.token_mint || null, tokenById);
      if (!token) continue;

      const key = this.candidateKey(wallet.address, token.id);
      if (candidates.has(key)) continue;

      candidates.set(key, {
        token,
        wallet,
        source: 'deposit_cursor',
        inventoryBalance: inventoryByPair.get(key) || 0n
      });
    }

    const lastRow = rows[rows.length - 1]!;
    await this.saveCursor(cursorName, {
      blockNo: Number(lastRow.slot || cursor.blockNo),
      rowId: lastRow.id
    }, {
      rowsSeen: rows.length,
      candidates: candidates.size,
      lastTxHash: lastRow.tx_hash
    });

    log('solana deposit cursor advanced', {
      cursorName,
      rowsSeen: rows.length,
      candidates: candidates.size,
      slot: lastRow.slot,
      rowId: lastRow.id
    });

    return [...candidates.values()];
  }

  private buildCandidatesFromTransactions(
    rows: TransactionRecord[],
    tokenById: Map<number, TokenRecord>,
    walletByAddress: Map<string, WalletRecord>,
    inventoryByPair: Map<string, bigint>,
    source: 'deposit_cursor'
  ): CollectionCandidateInput[] {
    const candidates = new Map<string, CollectionCandidateInput>();

    for (const row of rows) {
      const address = row.to_addr?.toLowerCase();
      if (!address) continue;

      const wallet = walletByAddress.get(address);
      if (!wallet) continue;

      const token = this.findTokenForTransaction(row, tokenById);
      if (!token) continue;

      const key = this.candidateKey(wallet.address, token.id);
      if (candidates.has(key)) continue;

      const inventoryBalance = inventoryByPair.get(key) || 0n;
      candidates.set(key, {
        token,
        wallet,
        source,
        inventoryBalance
      });
    }

    return [...candidates.values()];
  }

  private async loadInventoryReconcileCandidates(
    tokenById: Map<number, TokenRecord>,
    walletByAddress: Map<string, WalletRecord>,
    inventoryByPair: Map<string, bigint>
  ): Promise<CollectionCandidateInput[]> {
    const cursorName = this.inventoryReconcileCursorName();
    const cursor = await this.getOrCreateCursor(cursorName);
    const metadata = this.parseMetadata(cursor.metadata);
    const lastRunAt = typeof metadata.lastRunAt === 'string' ? Date.parse(metadata.lastRunAt) : 0;
    const nextRunAt = lastRunAt + config.inventoryReconcileIntervalSeconds * 1000;

    if (Number.isFinite(lastRunAt) && lastRunAt > 0 && Date.now() < nextRunAt) {
      log('inventory reconcile skipped by interval', {
        cursorName,
        lastRunAt: metadata.lastRunAt,
        nextRunAt: new Date(nextRunAt).toISOString()
      });
      return [];
    }

    const candidates: CollectionCandidateInput[] = [];
    for (const [key, inventoryBalance] of inventoryByPair.entries()) {
      const [address, tokenIdPart] = key.split(':');
      const tokenId = Number(tokenIdPart);
      if (!address || !Number.isFinite(tokenId)) continue;

      const token = tokenById.get(tokenId);
      const wallet = walletByAddress.get(address);
      if (!token || !wallet) continue;
      if (inventoryBalance < BigInt(token.collect_amount)) continue;

      candidates.push({
        token,
        wallet,
        source: 'inventory_reconcile',
        inventoryBalance
      });
    }

    await this.saveCursor(cursorName, cursor, {
      lastRunAt: nowIso(),
      candidates: candidates.length
    });

    log('inventory reconcile candidates loaded', {
      cursorName,
      candidates: candidates.length
    });

    return candidates;
  }

  private async loadSolanaInventoryReconcileCandidates(
    tokenById: Map<number, TokenRecord>,
    walletByAddress: Map<string, WalletRecord>,
    inventoryByPair: Map<string, bigint>
  ): Promise<CollectionCandidateInput[]> {
    const cursorName = this.solanaInventoryReconcileCursorName();
    const cursor = await this.getOrCreateCursor(cursorName);
    const metadata = this.parseMetadata(cursor.metadata);
    const lastRunAt = typeof metadata.lastRunAt === 'string' ? Date.parse(metadata.lastRunAt) : 0;
    const nextRunAt = lastRunAt + config.inventoryReconcileIntervalSeconds * 1000;

    if (Number.isFinite(lastRunAt) && lastRunAt > 0 && Date.now() < nextRunAt) {
      log('solana inventory reconcile skipped by interval', {
        cursorName,
        lastRunAt: metadata.lastRunAt,
        nextRunAt: new Date(nextRunAt).toISOString()
      });
      return [];
    }

    const candidates: CollectionCandidateInput[] = [];
    for (const [key, inventoryBalance] of inventoryByPair.entries()) {
      const [address, tokenIdPart] = key.split(':');
      const tokenId = Number(tokenIdPart);
      if (!address || !Number.isFinite(tokenId)) continue;

      const token = tokenById.get(tokenId);
      const wallet = walletByAddress.get(address);
      if (!token || !wallet) continue;
      if (inventoryBalance < BigInt(token.collect_amount)) continue;

      candidates.push({
        token,
        wallet,
        source: 'inventory_reconcile',
        inventoryBalance
      });
    }

    await this.saveCursor(cursorName, cursor, {
      lastRunAt: nowIso(),
      candidates: candidates.length
    });

    log('solana inventory reconcile candidates loaded', {
      cursorName,
      candidates: candidates.length
    });

    return candidates;
  }

  private async loadInventoryByPair(): Promise<Map<string, bigint>> {
    const credits = await this.db.getInventoryCredits(config.chainId, 'evm');
    const inventory = new Map<string, bigint>();

    for (const credit of credits) {
      const key = this.creditKey(credit);
      if (!key) continue;
      inventory.set(key, (inventory.get(key) || 0n) + BigInt(credit.amount));
    }

    return inventory;
  }

  private async loadSolanaInventoryByPair(): Promise<Map<string, bigint>> {
    const credits = await this.db.getInventoryCredits(config.solanaChainId, 'solana');
    const inventory = new Map<string, bigint>();

    for (const credit of credits) {
      const key = this.creditKey(credit);
      if (!key) continue;
      inventory.set(key, (inventory.get(key) || 0n) + BigInt(credit.amount));
    }

    return inventory;
  }

  private findTokenForTransaction(row: TransactionRecord, tokenById: Map<number, TokenRecord>): TokenRecord | null {
    const tokenAddress = row.token_addr?.toLowerCase() || null;
    for (const token of tokenById.values()) {
      if (Boolean(token.is_native) && !tokenAddress) {
        return token;
      }
      if (token.token_address && token.token_address.toLowerCase() === tokenAddress) {
        return token;
      }
    }
    return null;
  }

  private findTokenForSolanaTransaction(tokenMint: string | null, tokenById: Map<number, TokenRecord>): TokenRecord | null {
    const normalizedMint = tokenMint?.toLowerCase() || null;
    for (const token of tokenById.values()) {
      if (Boolean(token.is_native) && !normalizedMint) {
        return token;
      }
      if (token.token_address && token.token_address.toLowerCase() === normalizedMint) {
        return token;
      }
    }
    return null;
  }

  private async getOrCreateCursor(cursorName: string): Promise<DepositCursor & { metadata?: string | null }> {
    const existing = await this.db.getServiceCursor(SERVICE_NAME, cursorName);
    if (existing) {
      return {
        blockNo: existing.cursor_block_no,
        rowId: existing.cursor_row_id,
        metadata: existing.metadata || null
      };
    }

    await this.db.createServiceCursor({
      service_name: SERVICE_NAME,
      cursor_name: cursorName,
      cursor_block_no: 0,
      cursor_row_id: 0,
      metadata: JSON.stringify({ createdAt: nowIso() })
    });

    return { blockNo: 0, rowId: 0, metadata: null };
  }

  private async saveCursor(cursorName: string, cursor: DepositCursor, metadata: Record<string, unknown>): Promise<void> {
    await this.db.updateServiceCursor(SERVICE_NAME, cursorName, {
      cursor_block_no: cursor.blockNo,
      cursor_row_id: cursor.rowId,
      metadata: JSON.stringify({
        ...metadata,
        updatedAt: nowIso()
      }),
      updated_at: nowIso()
    });
  }

  private async getCachedNativeBalance(address: string): Promise<bigint> {
    const key = address.toLowerCase();
    const cached = this.nativeBalanceCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const balance = await this.evm.getNativeBalance(address);
    this.nativeBalanceCache.set(key, balance);
    return balance;
  }

  private shouldCheckReceipt(metadata: Record<string, unknown>): boolean {
    const nextReceiptCheckAt = typeof metadata.nextReceiptCheckAt === 'string'
      ? Date.parse(metadata.nextReceiptCheckAt)
      : 0;
    return !Number.isFinite(nextReceiptCheckAt) || nextReceiptCheckAt <= Date.now();
  }

  private async scheduleNextReceiptCheck(task: FundTaskRecord, metadata: Record<string, unknown>): Promise<void> {
    const currentCount = Number(metadata.receiptCheckCount || 0);
    const nextCount = Number.isFinite(currentCount) ? currentCount + 1 : 1;
    const delaySeconds = Math.min(
      config.receiptMaxCheckDelaySeconds,
      config.receiptInitialCheckDelaySeconds * Math.max(1, nextCount)
    );
    const nextReceiptCheckAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

    await this.db.updateTask(task.id, {
      metadata: this.mergeMetadata(task.metadata, {
        receiptCheckCount: nextCount,
        nextReceiptCheckAt
      }),
      updated_at: nowIso()
    });
  }

  private candidateKey(address: string, tokenId: number): string {
    return `${address.toLowerCase()}:${tokenId}`;
  }

  private creditKey(credit: CreditRecord): string | null {
    if (!credit.address || !credit.token_id) {
      return null;
    }
    return this.candidateKey(credit.address, credit.token_id);
  }

  private depositCursorName(): string {
    return `${DEPOSIT_CURSOR_PREFIX}:${config.chainId}`;
  }

  private inventoryReconcileCursorName(): string {
    return `${INVENTORY_RECONCILE_CURSOR_PREFIX}:${config.chainId}`;
  }

  private solanaDepositCursorName(): string {
    return `${SOLANA_DEPOSIT_CURSOR_PREFIX}:${config.solanaChainId}`;
  }

  private solanaInventoryReconcileCursorName(): string {
    return `${SOLANA_INVENTORY_RECONCILE_CURSOR_PREFIX}:${config.solanaChainId}`;
  }

  private async getWalletUserId(address: string, chainType: 'evm' | 'solana' = 'evm'): Promise<number> {
    const wallets = [...await this.db.getActiveUserWallets(chainType), ...await this.db.getActiveHotWallets(chainType)];
    const wallet = wallets.find(item => item.address.toLowerCase() === address.toLowerCase());
    return wallet?.user_id || 0;
  }

  private async pickHotWallet(hotWallets: WalletRecord[]): Promise<WalletRecord> {
    // 热钱包选择先看 wallet_nonces.last_used_at，尽量把归集目标分散到较少使用的钱包。
    // 注意：这里只读 wallet_nonces，不写入，因为归集交易的发起方不是热钱包。
    const nonces = await this.db.getWalletNonces(config.chainId);
    const lastUsedByAddress = new Map(
      nonces.map(nonce => [nonce.address.toLowerCase(), nonce.last_used_at || ''])
    );

    return [...hotWallets].sort((a, b) => {
      const aLast = lastUsedByAddress.get(a.address.toLowerCase()) || '';
      const bLast = lastUsedByAddress.get(b.address.toLowerCase()) || '';
      if (aLast !== bLast) return aLast.localeCompare(bLast);
      return a.id - b.id;
    })[0]!;
  }

  private parseMetadata(metadata?: string | null): Record<string, unknown> {
    if (!metadata) return {};
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private mergeMetadata(metadata: string | null | undefined, patch: Record<string, unknown>): string {
    return JSON.stringify({
      ...this.parseMetadata(metadata),
      ...patch
    });
  }

  private async mapConcurrent<T>(
    items: T[],
    limit: number,
    handler: (item: T) => Promise<void>
  ): Promise<void> {
    // 简单并发池，避免一次性对 RPC 和 signer 打满请求。
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await handler(item);
        }
      }
    });

    await Promise.all(workers);
  }
}

export { OPEN_STATUSES };
