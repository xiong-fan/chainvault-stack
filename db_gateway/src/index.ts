import './loadEnv';  // 加载 .env 环境变量
import express from 'express'; // Web 服务框架
import cors from 'cors'; // 处理跨域
import helmet from 'helmet';  //安全头设置（防 XSS、点击劫持等）
import rateLimit from 'express-rate-limit';  // 速率限制（虽然代码中后续未使用，但已导入）
// import dotenv from 'dotenv';  // 加载 .env 环境变量
import { GatewayController } from './controllers/gateway';  // 处理实际数据库操作的控制器
import { SignatureMiddleware } from './middleware/signature';  // 核心安全中间件（签名验证）
import { logger } from './utils/logger';
import { Ed25519Verifier } from './utils/crypto';  // Ed25519 签名验证工具类
// import path from 'path';

// // 加载根目录的 keys.env
// dotenv.config({ path: path.resolve(process.cwd(), '../key.env') });

// // 再加载本模块自己的 .env（覆盖优先级更高）
// dotenv.config(); // 默认加载本目录 .env

class DatabaseGatewayService {
  private app: express.Application;
  private port: number;
  private gatewayController: GatewayController;
  private signatureMiddleware: SignatureMiddleware;
  private dbService: import('./services/database').DatabaseService;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || '3003');

    // 创建共享的DatabaseService实例
    // 使用 require 动态引入 DatabaseService 并实例化（注意这里用了 CommonJS 的 require，可能是为了避免循环依赖）
    const { DatabaseService } = require('./services/database');
    this.dbService = new DatabaseService();

    // 将 dbService 传递给 GatewayController 和 SignatureMiddleware
    // 把同一个 dbService 实例分别注入到控制器和中间件中（共享数据库连接）
    this.gatewayController = new GatewayController(this.dbService);
    this.signatureMiddleware = new SignatureMiddleware(this.dbService);

    // 依次调用三个初始化方法：中间件 → 路由 → 错误处理
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupMiddleware() {
    // 安全中间件--添加安全响应头
    this.app.use(helmet());

    // CORS配置--仅允许本地 wallet（3001）和 scan（3002）等模块访问，生产环境应改为内网 IP 白名单
    this.app.use(cors({
      origin: ['http://localhost:3001', 'http://localhost:3002'], // wallet和scan服务
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }));

    // JSON解析--限制 body 大小为 10MB
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // 请求日志记录--记录每一次请求的 method、url、IP、User-Agent，便于审计
    this.app.use((req, res, next) => {
      logger.info('Incoming request', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }

  private setupRoutes() {
    // 健康检查--健康检查接口
    this.app.get('/health', (req, res) => {
      res.json({
        success: true,
        service: 'Database Gateway Service',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // 密钥管理端点（仅用于开发和部署时生成密钥）
    if (process.env.NODE_ENV === 'development') {
      // 仅开发环境可用，用于生成 Ed25519 密钥对（生产环境禁用）
      this.app.post('/generate-keypair', (req, res) => {
        const verifier = new Ed25519Verifier();
        const keyPair = verifier.generateKeyPair();

        logger.warn('Generated new key pair', {
          publicKey: keyPair.publicKey,
          // 注意：在生产环境中绝不要记录私钥
          note: 'Private key should be stored securely and never logged'
        });

        res.json({
          success: true,
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          note: 'Store the private key securely. The public key should be configured in the environment variables.'
        });
      });
    }

    // 数据库操作API--这是整个 db_gateway 最核心的接口
    // 中间件执行顺序严格：
    //   validateRequest：基础校验（timestamp、operation_id 等）
    //   verifyBusinessSignature：验证业务模块（wallet/scan）签名
    //   verifyRiskControlSignature：验证风控模块签名（sensitive 操作必填）
    //   最后才进入 executeOperation 执行 SQL。
    this.app.post('/api/database/execute',
      this.signatureMiddleware.validateRequest,
      this.signatureMiddleware.verifyBusinessSignature,
      this.signatureMiddleware.verifyRiskControlSignature,
      this.gatewayController.executeOperation
    );

    // 批量数据库操作API（支持事务）
    this.app.post('/api/database/batch',
      this.signatureMiddleware.validateBatchRequest,
      this.signatureMiddleware.verifyBatchBusinessSignature,
      this.signatureMiddleware.verifyBatchRiskControlSignature,
      this.gatewayController.executeBatchOperation
    );


    // 404 处理
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'API endpoint not found',
          details: `${req.method} ${req.originalUrl} is not a valid endpoint`
        }
      });
    });
  }

  private setupErrorHandling() {
    // 全局错误处理
    this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Unhandled error', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method
      });

      if (res.headersSent) {
        return next(error);
      }

      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        }
      });
    });

    // 未处理的Promise拒绝
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection', { reason, promise });
    });

    // 未捕获的异常
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception', { error });
      process.exit(1);
    });

    // 优雅关闭
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('SIGINT', this.gracefulShutdown.bind(this));
  }

  private async gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}, starting graceful shutdown`);

    try {
      await this.gatewayController.close();
      logger.info('Database connections closed');

      logger.close();

      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', { error });
      process.exit(1);
    }
  }

  public async start() {
    // 先连接数据库
    try {
      await this.dbService.connect();
    } catch (error) {
      logger.error('Failed to connect to database', { error });
      process.exit(1);
    }

    // 启动 HTTP 服务，监听 0.0.0.0:3003（允许外部访问，生产环境建议限制）
    this.app.listen(this.port, '0.0.0.0', () => {
      logger.info('Database Gateway Service started', {
        port: this.port,
        nodeEnv: process.env.NODE_ENV || 'development',
        pid: process.pid
      });

      // 验证配置--启动成功后，检查 .env 中是否配置了 wallet、scan、risk 的公钥，并打印日志提醒
      const verifier = new Ed25519Verifier();
      const hasWalletKey = verifier.hasPublicKey('wallet');
      const hasScanKey = verifier.hasPublicKey('scan');
      const hasRiskKey = verifier.hasPublicKey('risk');

      logger.info('Public key configuration', {
        wallet: hasWalletKey ? 'configured' : 'missing',
        scan: hasScanKey ? 'configured' : 'missing',
        risk: hasRiskKey ? 'configured' : 'missing'
      });

      if (!hasWalletKey || !hasScanKey) {
        logger.warn('Some public keys are missing. Service will reject requests from modules without configured keys.');
      }

      if (!hasRiskKey) {
        logger.warn('Risk control public key is missing. Sensitive operations will be rejected.');
      }
    });
  }
}

// 启动服务
const service = new DatabaseGatewayService();
service.start();