import express, { Request, Response } from 'express';
import config from './config';
import { DbGatewayClient } from './clients/DbGatewayClient';
import { EvmClient } from './clients/EvmClient';
import { RiskControlClient } from './clients/RiskControlClient';
import { SignerClient } from './clients/SignerClient';
import { SolanaClient } from './clients/SolanaClient';
import { FundRebalanceService } from './services/FundRebalanceService';
import { Ed25519Signer } from './utils/crypto';

const app = express();
app.use(express.json());

// fund_rebalance 复用 WALLET_PRIVATE_KEY，作为 db_gateway 和 signer 认可的业务签名身份。
const businessSigner = new Ed25519Signer(config.walletPrivateKey);
const riskClient = new RiskControlClient(config.riskControlUrl);
const dbClient = new DbGatewayClient(config.dbGatewayBaseUrl, businessSigner, riskClient);
const evmClient = new EvmClient(config.evmRpcUrl);
const solanaClient = new SolanaClient(config.solanaRpcUrl, config.solanaRpcUrlBackup || undefined);
const signerClient = new SignerClient(config.signerBaseUrl, businessSigner, riskClient);
const fundService = new FundRebalanceService(dbClient, evmClient, solanaClient, signerClient);

let lastRun: { startedAt: string; result?: unknown; error?: string } | null = null;

app.get('/health', async (_req: Request, res: Response) => {
  // 健康检查同时探测上下游，方便判断归集卡在服务依赖还是业务条件。
  const [db, risk, signer, evm, solana] = await Promise.all([
    dbClient.healthCheck(),
    riskClient.healthCheck(),
    signerClient.healthCheck(),
    evmClient.healthCheck(),
    solanaClient.healthCheck()
  ]);

  res.json({
    // success 继续以 EVM 归集的原有依赖为准；Solana 状态单独暴露，避免 Solana RPC 暂不可用时误判 EVM 归集不可用。
    success: db && risk && signer && evm,
    service: 'fund_rebalance',
    chainTypes: ['evm', 'solana'],
    chainIds: { evm: config.chainId, solana: config.solanaChainId },
    dependencies: { db_gateway: db, risk_control: risk, signer, evm_rpc: evm, solana_rpc: solana },
    lastRun
  });
});

app.get('/api/tasks', async (req: Request, res: Response) => {
  try {
    // 查询接口只做轻量筛选，方便运营按状态、token 或地址排查归集任务。
    const tokenId = req.query.tokenId ? Number.parseInt(String(req.query.tokenId), 10) : undefined;
    const filters: { status?: string; tokenId?: number; address?: string } = {};
    if (req.query.status) filters.status = String(req.query.status);
    if (tokenId !== undefined && Number.isFinite(tokenId)) filters.tokenId = tokenId;
    if (req.query.address) filters.address = String(req.query.address);

    const tasks = await dbClient.getTasks(filters);

    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/collect/run-once', async (_req: Request, res: Response) => {
  // 手动触发和定时扫描走同一条逻辑，内部 running 标记会防止并发扫描。
  const startedAt = new Date().toISOString();
  lastRun = { startedAt };

  try {
    const result = await fundService.runOnce();
    lastRun = { startedAt, result };
    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastRun = { startedAt, error: message };
    res.status(500).json({ success: false, error: message });
  }
});

app.post('/api/tasks/:id/retry', async (req: Request, res: Response) => {
  try {
    // retry 只允许 failed/skipped，由服务层重新校验余额、gas 和幂等条件。
    const rawId = req.params.id;
    if (!rawId) {
      return res.status(400).json({ success: false, error: 'invalid task id' });
    }

    const id = Number.parseInt(Array.isArray(rawId) ? rawId[0] || '' : rawId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'invalid task id' });
    }

    const result = await fundService.retryTask(id);
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

setInterval(() => {
  // 第一版采用轮询扫描，不依赖 scan 服务的充值事件实时触发。
  const startedAt = new Date().toISOString();
  lastRun = { startedAt };

  fundService.runOnce()
    .then(result => {
      lastRun = { startedAt, result };
    })
    .catch(error => {
      lastRun = {
        startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
      console.error('fund collection interval failed:', error);
    });
}, config.collectIntervalSeconds * 1000);

app.listen(config.port, () => {
  console.log(`fund_rebalance service listening on port ${config.port}`);
  console.log(`EVM chain id: ${config.chainId}, Solana chain id: ${config.solanaChainId}, interval: ${config.collectIntervalSeconds}s`);
});
