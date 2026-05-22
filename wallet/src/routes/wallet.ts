import { Router, Request, Response } from 'express';
import { createPublicClient, http, parseAbi } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionData,
  getMetadataPointerState,
  unpackMint,
  ExtensionType
} from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import { DatabaseReader } from '../db';

import { WalletBusinessService } from '../services/walletBusinessService';
import { HotWalletService } from '../services/hotWalletService';
import { chainConfigManager } from '../utils/chains';
import { getAssociatedTokenAddress } from '../utils/solana';
import { AuthError, AuthService, SafeAuthUser, extractBearerToken } from '../services/authService';
import { getDbGatewayClient } from '../services/dbGatewayClient';

// API响应接口
interface ApiResponse<T = any> {
  details?: unknown;
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
}

interface AuthContext {
  user: SafeAuthUser;
  session: unknown;
  wallet?: unknown;
}

interface AuthenticatedRequest<
  P = Record<string, string>,
  ResBody = ApiResponse,
  ReqBody = any,
  ReqQuery = any
> extends Request<P, ResBody, ReqBody, ReqQuery> {
  auth?: AuthContext;
}

type OnboardingChainType = 'evm' | 'solana';
type OnboardingTokenType = 'erc20' | 'spl-token' | 'spl-token-2022';
const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

interface ChainTokenOnboardingOption {
  chain_type: OnboardingChainType;
  chain_id: number;
  name: string;
  token_types: OnboardingTokenType[];
}

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

interface SolanaMintMetadataReadResult {
  metadata: TokenMetadata | null;
  decimals: number;
}

interface SolanaAtaBackfillResult {
  walletsScanned: number;
  created: number;
  skippedExisting: number;
  failed: number;
  errors: string[];
}

export function walletRoutes(dbService: DatabaseReader): Router {
  const router = Router();
  const walletBusinessService = new WalletBusinessService(dbService);
  const hotWalletService = new HotWalletService(dbService.getConnection());
  const authService = new AuthService(dbService);
  const dbGatewayClient = getDbGatewayClient();

  const sendAuthError = (res: Response, error: unknown): void => {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        data: { code: error.code }
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '认证服务错误'
    });
  };

  const requireAuth = async (req: AuthenticatedRequest, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw new AuthError('缺少认证 token', 401, 'MISSING_TOKEN');
      }

      const auth = await authService.authenticateToken(token);
      req.auth = {
        user: auth.user,
        session: auth.session,
        ...(auth.wallet !== undefined && { wallet: auth.wallet })
      };
      next();
    } catch (error) {
      sendAuthError(res, error);
    }
  };

  const getAuthenticatedUser = (req: AuthenticatedRequest): SafeAuthUser => {
    if (!req.auth?.user) {
      throw new AuthError('缺少认证上下文', 401, 'MISSING_AUTH_CONTEXT');
    }
    return req.auth.user;
  };

  const isPrivilegedUser = (user: SafeAuthUser): boolean => user.user_type !== 'normal';
  const canAccessRiskAdmin = (user: SafeAuthUser): boolean =>
    ['sys_admin', 'admin', 'risk_operator', 'customer_service', 'support'].includes(user.user_type);
  const canManageTokens = (user: SafeAuthUser): boolean =>
    ['sys_admin', 'admin', 'risk_operator', 'customer_service', 'support'].includes(user.user_type);
  const canManageUserTypes = (user: SafeAuthUser): boolean => ['sys_admin', 'admin'].includes(user.user_type);
  const allowedUserTypes = new Set(['normal', 'customer_service', 'risk_operator', 'support', 'admin', 'sys_admin']);
  const erc20MetadataAbi = parseAbi([
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)'
  ]);
  const safeUserFields = (user: Awaited<ReturnType<typeof dbService.users.findById>>) => {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone || null,
      user_type: user.user_type || 'normal',
      status: user.status,
      kyc_status: user.kyc_status,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at || null
    };
  };

  const proxyRiskAdmin = async (req: AuthenticatedRequest, res: Response, path: string, method: 'GET' | 'POST' | 'PATCH') => {
    const authUser = getAuthenticatedUser(req);
    if (!canAccessRiskAdmin(authUser)) {
      res.status(403).json({ success: false, error: '无权访问风控后台' });
      return;
    }

    const riskControlUrl = (process.env.RISK_CONTROL_URL || 'http://localhost:3004').replace(/\/$/, '');
    const riskAdminToken = process.env.RISK_ADMIN_TOKEN;
    const response = await fetch(`${riskControlUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(riskAdminToken ? { 'x-risk-admin-token': riskAdminToken } : {})
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(req.body || {}) })
    });

    const text = await response.text();
    res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(text);
  };

  const isHumanReadableAmountString = (value: string): boolean => /^(0|[1-9]\d*)(\.\d+)?$/.test(value);

  const toMinimalUnitAmount = (value: string, decimals: number): string => {
    if (!isHumanReadableAmountString(value)) {
      throw new Error('金额必须是非负数字');
    }

    const [integerPart = '0', fractionPart = ''] = value.split('.');
    if (fractionPart.length > decimals) {
      throw new Error(`最多支持 ${decimals} 位小数`);
    }

    const paddedFraction = fractionPart.padEnd(decimals, '0');
    const combined = `${integerPart}${paddedFraction}`.replace(/^0+(?=\d)/, '');
    return combined || '0';
  };

  const readErc20Metadata = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenMetadata> => {
    const chain = chainConfigManager.getChainByChainId(chainId);
    const chainConfig = chainConfigManager.getChainConfig(chain);
    if (!chainConfig || chainConfig.chainType !== 'evm') {
      throw new Error(`不支持的 EVM chain_id: ${chainId}`);
    }

    const publicClient = createPublicClient({
      chain: chainConfig.chain,
      transport: http(chainConfig.rpcUrl)
    });

    const [symbol, name, decimals] = await Promise.all([
      publicClient.readContract({ address: tokenAddress, abi: erc20MetadataAbi, functionName: 'symbol' }),
      publicClient.readContract({ address: tokenAddress, abi: erc20MetadataAbi, functionName: 'name' }),
      publicClient.readContract({ address: tokenAddress, abi: erc20MetadataAbi, functionName: 'decimals' })
    ]);

    return {
      symbol: String(symbol).trim().toUpperCase(),
      name: String(name).trim(),
      decimals: Number(decimals)
    };
  };

  const getTokenOnboardingOptions = (): ChainTokenOnboardingOption[] =>
    chainConfigManager
      .getSupportedChains()
      .map((chain) => chainConfigManager.getChainConfig(chain))
      .filter((config): config is NonNullable<typeof config> => Boolean(config))
      .flatMap<ChainTokenOnboardingOption>((config) => {
        if (config.chainType === 'evm') {
          return [{
            chain_type: 'evm' as const,
            chain_id: config.chainId,
            name: config.name,
            token_types: ['erc20' as const]
          }];
        }

        if (config.chainType === 'solana') {
          return [{
            chain_type: 'solana' as const,
            chain_id: config.chainId,
            name: config.name,
            token_types: ['spl-token' as const, 'spl-token-2022' as const]
          }];
        }

        return [];
      });

  const getOnboardingOption = (chainType: string, chainId: number): ChainTokenOnboardingOption | undefined =>
    getTokenOnboardingOptions().find((item) => item.chain_type === chainType && item.chain_id === chainId);

  const isValidTokenTypeForChain = (
    chainType: OnboardingChainType,
    tokenType: string
  ): tokenType is OnboardingTokenType => {
    if (chainType === 'evm') return tokenType === 'erc20';
    return tokenType === 'spl-token' || tokenType === 'spl-token-2022';
  };

  const normalizeCreateTokenBody = (body: any): {
    chainType: string;
    chainId: number;
    tokenType: string;
    tokenAddress: string;
    collectAmount: string;
    withdrawFee: string;
    minWithdrawAmount: string;
  } => ({
    chainType: String(body?.chain_type ?? body?.chainType ?? '').trim(),
    chainId: Number(body?.chain_id ?? body?.chainId),
    tokenType: String(body?.token_type ?? body?.tokenType ?? '').trim(),
    tokenAddress: String(body?.token_address ?? body?.tokenAddress ?? '').trim(),
    collectAmount: String(body?.collect_amount ?? body?.collectAmount ?? '0').trim() || '0',
    withdrawFee: String(body?.withdraw_fee ?? body?.withdrawFee ?? '0').trim() || '0',
    minWithdrawAmount: String(body?.min_withdraw_amount ?? body?.minWithdrawAmount ?? '0').trim() || '0'
  });

  const validateTokenMetadata = (metadata: TokenMetadata): string | null => {
    if (!/^[A-Z0-9]{2,20}$/.test(metadata.symbol)) {
      return `链上 symbol 不符合系统规则: ${metadata.symbol}`;
    }

    if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 36) {
      return `链上 decimals 不符合系统规则: ${metadata.decimals}`;
    }

    return null;
  };

  const readBorshString = (buffer: Buffer, offset: number): { value: string; nextOffset: number } | null => {
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt32LE(offset);
    const start = offset + 4;
    const end = start + length;
    if (length > 1024 || end > buffer.length) return null;

    return {
      value: buffer.subarray(start, end).toString('utf8').replace(/\0/g, '').trim(),
      nextOffset: end
    };
  };

  const readMetaplexTokenMetadata = async (
    connection: Connection,
    mintPublicKey: PublicKey,
    decimals: number
  ): Promise<TokenMetadata | null> => {
    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mintPublicKey.toBuffer()
      ],
      METAPLEX_TOKEN_METADATA_PROGRAM_ID
    );
    const metadataAccount = await connection.getAccountInfo(metadataAddress, 'confirmed');
    if (!metadataAccount?.data || !metadataAccount.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID)) {
      return null;
    }

    const data = metadataAccount.data;
    if (data.length < 65) return null;
    const metadataMint = new PublicKey(data.subarray(33, 65));
    if (!metadataMint.equals(mintPublicKey)) return null;

    // Metaplex Metadata 的 name/symbol/uri 是按 Borsh string 顺序存储。
    const name = readBorshString(data, 65);
    if (!name) return null;
    const symbol = readBorshString(data, name.nextOffset);
    if (!symbol || !symbol.value) return null;

    return {
      symbol: symbol.value.toUpperCase(),
      name: name.value || symbol.value.toUpperCase(),
      decimals
    };
  };

  const readSolanaTokenMetadata = async (
    chainId: number,
    mintAddress: string,
    tokenType: 'spl-token' | 'spl-token-2022'
  ): Promise<SolanaMintMetadataReadResult> => {
    const chain = chainConfigManager.getChainByChainId(chainId);
    const chainConfig = chainConfigManager.getChainConfig(chain);
    if (!chainConfig || chainConfig.chainType !== 'solana') {
      throw new Error(`不支持的 Solana chain_id: ${chainId}`);
    }

    let mintPublicKey: PublicKey;
    try {
      mintPublicKey = new PublicKey(mintAddress);
    } catch {
      throw new Error('无效的 Solana mint 地址');
    }

    const expectedProgramId = tokenType === 'spl-token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const connection = new Connection(chainConfig.rpcUrl, 'confirmed');
    const mintAccount = await connection.getAccountInfo(mintPublicKey, 'confirmed');
    if (!mintAccount) {
      throw new Error('Solana mint 账户不存在');
    }

    if (!mintAccount.owner.equals(expectedProgramId)) {
      const actualType = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? 'spl-token-2022'
        : mintAccount.owner.equals(TOKEN_PROGRAM_ID)
          ? 'spl-token'
          : mintAccount.owner.toBase58();
      throw new Error(`前端选择的 token_type 与链上 mint owner 不一致，链上实际为 ${actualType}`);
    }

    const mint = unpackMint(mintPublicKey, mintAccount, expectedProgramId);
    const metadataCandidates: Buffer[] = [];

    // Token-2022 可以把 TokenMetadata 扩展直接写在 mint 账户 TLV 中。
    const inlineMetadata = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
    if (inlineMetadata) {
      metadataCandidates.push(inlineMetadata);
    }

    // MetadataPointer 指向的账户可能是 mint 自身，也可能是独立 metadata 账户。
    const metadataPointer = getMetadataPointerState(mint);
    const metadataAddress = metadataPointer?.metadataAddress;
    if (metadataAddress && !metadataAddress.equals(mintPublicKey)) {
      const metadataAccount = await connection.getAccountInfo(metadataAddress, 'confirmed');
      if (metadataAccount?.data) {
        metadataCandidates.push(metadataAccount.data);
      }
    }

    for (const candidate of metadataCandidates) {
      try {
        const metadata = unpackTokenMetadata(candidate);
        if (metadata.mint.equals(mintPublicKey)) {
          return {
            metadata: {
              symbol: metadata.symbol.trim().toUpperCase(),
              name: metadata.name.trim(),
              decimals: mint.decimals
            },
            decimals: mint.decimals
          };
        }
      } catch {
        // 继续尝试下一个 metadata 来源，避免一个坏指针阻断可用来源。
      }
    }

    const metaplexMetadata = await readMetaplexTokenMetadata(connection, mintPublicKey, mint.decimals);
    if (metaplexMetadata) {
      return {
        metadata: metaplexMetadata,
        decimals: mint.decimals
      };
    }

    return {
      metadata: null,
      decimals: mint.decimals
    };
  };

  const backfillSolanaTokenAccountsForToken = async (params: {
    tokenMint: string;
    tokenType: 'spl-token' | 'spl-token-2022';
  }): Promise<SolanaAtaBackfillResult> => {
    const result: SolanaAtaBackfillResult = {
      walletsScanned: 0,
      created: 0,
      skippedExisting: 0,
      failed: 0,
      errors: []
    };

    // 新增 Solana token 后，要给历史用户钱包和热钱包补齐 ATA 映射；
    // scanner 和归集服务都依赖这张表把 ATA 还原成 owner 钱包地址。
    const wallets = await dbGatewayClient.getWallets({ chain_type: 'solana' });
    const activeWallets = wallets.filter(wallet => Number(wallet.is_active ?? 1) === 1);

    for (const wallet of activeWallets) {
      result.walletsScanned += 1;
      const walletId = Number(wallet.id);
      const walletAddress = String(wallet.address || '').trim();
      if (!Number.isFinite(walletId) || !walletAddress) {
        result.failed += 1;
        result.errors.push(`invalid solana wallet row: ${JSON.stringify({ id: wallet.id, address: wallet.address })}`);
        continue;
      }

      const existing = await dbGatewayClient.queryData('solana_token_accounts', {
        wallet_address: walletAddress,
        token_mint: params.tokenMint
      });
      if (existing.length > 0) {
        result.skippedExisting += 1;
        continue;
      }

      try {
        const ataAddress = await getAssociatedTokenAddress(walletAddress, params.tokenMint, params.tokenType);
        await dbGatewayClient.insertData('solana_token_accounts', {
          user_id: wallet.user_id ?? null,
          wallet_id: walletId,
          wallet_address: walletAddress,
          token_mint: params.tokenMint,
          ata_address: ataAddress
        });
        result.created += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push(`${walletAddress}: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    return result;
  };

  const createOnboardedToken = async (body: any): Promise<{ status: number; response: ApiResponse }> => {
    const {
      chainType,
      chainId,
      tokenType,
      tokenAddress,
      collectAmount,
      withdrawFee,
      minWithdrawAmount
    } = normalizeCreateTokenBody(body);

    if (chainType !== 'evm' && chainType !== 'solana') {
      return { status: 400, response: { success: false, error: 'chain_type 只支持 evm 或 solana' } };
    }

    if (!Number.isInteger(chainId) || chainId <= 0) {
      return { status: 400, response: { success: false, error: 'chain_id 必须是正整数' } };
    }

    const onboardingOption = getOnboardingOption(chainType, chainId);
    if (!onboardingOption) {
      return { status: 400, response: { success: false, error: '该链不支持新增代币配置' } };
    }

    if (!isValidTokenTypeForChain(chainType, tokenType) || !onboardingOption.token_types.includes(tokenType)) {
      return { status: 400, response: { success: false, error: 'token_type 与当前链类型不匹配' } };
    }

    if (![collectAmount, withdrawFee, minWithdrawAmount].every(isHumanReadableAmountString)) {
      return {
        status: 400,
        response: { success: false, error: '归集阈值、提现手续费和最小提现额必须是人类可读的非负数字' }
      };
    }

    let normalizedAddress = tokenAddress;
    let metadata: TokenMetadata;
    try {
      if (chainType === 'evm') {
        if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
          return { status: 400, response: { success: false, error: '无效的 ERC20 合约地址' } };
        }
        normalizedAddress = tokenAddress.toLowerCase();
        metadata = await readErc20Metadata(chainId, normalizedAddress as `0x${string}`);
      } else {
        const mintPublicKey = new PublicKey(tokenAddress);
        normalizedAddress = mintPublicKey.toBase58();
        const solanaTokenType = tokenType === 'spl-token-2022' ? 'spl-token-2022' : 'spl-token';
        const solanaMint = await readSolanaTokenMetadata(chainId, normalizedAddress, solanaTokenType);
        if (!solanaMint.metadata) {
          return {
            status: 400,
            response: {
              success: false,
              error: '该 Solana mint 缺少链上 metadata，无法新增'
            }
          };
        }
        metadata = solanaMint.metadata;
      }
    } catch (error) {
      const metadataName = chainType === 'evm' ? 'ERC20 合约 metadata' : 'Solana mint 信息';
      return {
        status: 400,
        response: {
          success: false,
          error: `无法读取 ${metadataName}: ${error instanceof Error ? error.message : '未知错误'}`
        }
      };
    }

    const metadataError = validateTokenMetadata(metadata);
    if (metadataError) {
      return { status: 400, response: { success: false, error: metadataError } };
    }

    if (chainType === 'solana' && !metadata.name.trim()) {
      return { status: 400, response: { success: false, error: 'Solana 代币名称不能为空' } };
    }

    let collectAmountMinimal: string;
    let withdrawFeeMinimal: string;
    let minWithdrawAmountMinimal: string;
    try {
      collectAmountMinimal = toMinimalUnitAmount(collectAmount, metadata.decimals);
      withdrawFeeMinimal = toMinimalUnitAmount(withdrawFee, metadata.decimals);
      minWithdrawAmountMinimal = toMinimalUnitAmount(minWithdrawAmount, metadata.decimals);
    } catch (error) {
      return {
        status: 400,
        response: {
          success: false,
          error: `金额精度不符合 ${metadata.symbol} 的 decimals=${metadata.decimals}: ${error instanceof Error ? error.message : '未知错误'}`
        }
      };
    }

    const sameChainTokens = await dbGatewayClient.getTokens({
      chain_type: chainType,
      chain_id: chainId
    });
    const normalizedAddressKey = chainType === 'evm' ? normalizedAddress.toLowerCase() : normalizedAddress;
    if (sameChainTokens.some((token) => {
      const existingAddress = String(token.token_address || '');
      const existingKey = chainType === 'evm' ? existingAddress.toLowerCase() : existingAddress;
      return existingKey === normalizedAddressKey;
    })) {
      return {
        status: 409,
        response: { success: false, error: chainType === 'evm' ? '该链上已存在相同合约地址的代币配置' : '该链上已存在相同 mint 地址的代币配置' }
      };
    }

    const tokenId = await dbGatewayClient.createToken({
      chain_type: chainType,
      chain_id: chainId,
      token_address: normalizedAddress,
      token_symbol: metadata.symbol,
      token_name: metadata.name || metadata.symbol,
      token_type: tokenType,
      decimals: metadata.decimals,
      is_native: false,
      collect_amount: collectAmountMinimal,
      withdraw_fee: withdrawFeeMinimal,
      min_withdraw_amount: minWithdrawAmountMinimal,
      status: 1
    });

    let solanaAtaBackfill: SolanaAtaBackfillResult | undefined;
    if (chainType === 'solana') {
      solanaAtaBackfill = await backfillSolanaTokenAccountsForToken({
        tokenMint: normalizedAddress,
        tokenType: tokenType === 'spl-token-2022' ? 'spl-token-2022' : 'spl-token'
      });
    }

    return {
      status: solanaAtaBackfill && solanaAtaBackfill.failed > 0 ? 207 : 201,
      response: {
        success: !(solanaAtaBackfill && solanaAtaBackfill.failed > 0),
        message: tokenType === 'erc20'
          ? 'ERC20 代币配置已新增'
          : solanaAtaBackfill && solanaAtaBackfill.failed > 0
            ? 'Solana 代币配置已新增，部分历史钱包 ATA 映射补齐失败'
            : 'Solana 代币配置已新增，历史钱包 ATA 映射已补齐',
        data: {
          id: tokenId,
          token_symbol: metadata.symbol,
          token_name: metadata.name || metadata.symbol,
          decimals: metadata.decimals,
          token_address: normalizedAddress,
          chain_id: chainId,
          chain_type: chainType,
          token_type: tokenType,
          is_native: false,
          collect_amount: collectAmountMinimal,
          withdraw_fee: withdrawFeeMinimal,
          min_withdraw_amount: minWithdrawAmountMinimal,
          status: 1,
          ...(solanaAtaBackfill && { solana_ata_backfill: solanaAtaBackfill })
        }
      }
    };
  };

  const getAuthorizedUserIdFromParam = (req: AuthenticatedRequest<{ id: string }>, res: Response): number | null => {
    const requestedUserId = parseInt(req.params.id, 10);

    if (isNaN(requestedUserId)) {
      const errorResponse: ApiResponse = { success: false, error: '无效的用户ID' };
      res.status(400).json(errorResponse);
      return null;
    }

    const authUser = getAuthenticatedUser(req);
    if (!isPrivilegedUser(authUser) && requestedUserId !== authUser.id) {
      const errorResponse: ApiResponse = { success: false, error: '无权访问其他用户资源' };
      res.status(403).json(errorResponse);
      return null;
    }

    return requestedUserId;
  };

  router.get('/admin/risk/withdraw-risk-rules', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await proxyRiskAdmin(req, res, '/api/admin/withdraw-risk-rules', 'GET');
  });

  router.patch('/admin/risk/withdraw-risk-rules/:id', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    await proxyRiskAdmin(req, res, `/api/admin/withdraw-risk-rules/${encodeURIComponent(req.params.id)}`, 'PATCH');
  });

  router.get('/admin/risk/address-risks', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await proxyRiskAdmin(req, res, '/api/admin/address-risks', 'GET');
  });

  router.post('/admin/risk/address-risks', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await proxyRiskAdmin(req, res, '/api/admin/address-risks', 'POST');
  });

  router.patch('/admin/risk/address-risks/:id/enabled', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    await proxyRiskAdmin(req, res, `/api/admin/address-risks/${encodeURIComponent(req.params.id)}/enabled`, 'PATCH');
  });

  router.get('/admin/risk/pending-reviews', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await proxyRiskAdmin(req, res, '/api/pending-reviews', 'GET');
  });

  router.post('/admin/risk/manual-review', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await proxyRiskAdmin(req, res, '/api/manual-review', 'POST');
  });

  router.get('/admin/tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageTokens(authUser)) {
      res.status(403).json({ success: false, error: '无权访问代币管理' });
      return;
    }

    const conditions: {
      chain_type?: string;
      chain_id?: number;
      token_symbol?: string;
      token_address?: string;
      status?: number;
    } = {};

    const chainType = String(req.query.chain_type || '').trim();
    const chainId = Number(req.query.chain_id);
    const tokenSymbol = String(req.query.token_symbol || '').trim().toUpperCase();
    const tokenAddress = String(req.query.token_address || '').trim();

    if (chainType) conditions.chain_type = chainType;
    if (Number.isInteger(chainId) && chainId > 0) conditions.chain_id = chainId;
    if (tokenSymbol) conditions.token_symbol = tokenSymbol;
    if (tokenAddress) conditions.token_address = tokenAddress;

    const tokens = await dbGatewayClient.getTokens(conditions);
    res.json({
      success: true,
      message: '获取代币配置成功',
      data: tokens.sort((a, b) => {
        const chainCompare = Number(a.chain_id || 0) - Number(b.chain_id || 0);
        if (chainCompare !== 0) return chainCompare;
        return String(a.token_symbol || '').localeCompare(String(b.token_symbol || ''));
      })
    });
  });

  router.get('/admin/chains/token-onboarding-options', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageTokens(authUser)) {
      res.status(403).json({ success: false, error: '无权访问代币管理' });
      return;
    }

    res.json({
      success: true,
      message: '获取新增代币链选项成功',
      data: getTokenOnboardingOptions()
    });
  });

  router.get('/tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const conditions: {
      chain_type?: string;
      chain_id?: number;
      status?: number;
    } = { status: 1 };

    const chainType = String(req.query.chain_type || '').trim();
    const chainId = Number(req.query.chain_id);
    if (chainType) conditions.chain_type = chainType;
    if (Number.isInteger(chainId) && chainId > 0) conditions.chain_id = chainId;

    const tokens = await dbGatewayClient.getTokens(conditions);
    res.json({
      success: true,
      message: '获取可用代币成功',
      data: tokens
        .filter((token) => Number(token.status) === 1)
        .sort((a, b) => {
          const nativeCompare = Number(b.is_native || 0) - Number(a.is_native || 0);
          if (nativeCompare !== 0) return nativeCompare;
          return String(a.token_symbol || '').localeCompare(String(b.token_symbol || ''));
        })
    });
  });

  router.get('/tokens/:id', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const tokenId = Number(req.params.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      res.status(400).json({ success: false, error: '代币ID无效' });
      return;
    }

    const token = await dbService.getConnection().findTokenById(tokenId);
    if (!token) {
      res.status(404).json({ success: false, error: '代币不存在或已停用' });
      return;
    }

    res.json({ success: true, message: '获取代币成功', data: token });
  });

  router.post('/admin/tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageTokens(authUser)) {
      res.status(403).json({ success: false, error: '无权新增代币配置' });
      return;
    }

    const result = await createOnboardedToken(req.body);
    res.status(result.status).json(result.response);
  });

  router.post('/admin/tokens/erc20', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageTokens(authUser)) {
      res.status(403).json({ success: false, error: '无权新增代币配置' });
      return;
    }

    // 兼容旧调用方：旧接口仍只负责 EVM ERC20，并复用通用新增代币闭环。
    const result = await createOnboardedToken({
      ...req.body,
      chain_type: 'evm',
      token_type: 'erc20'
    });
    res.status(result.status).json(result.response);
  });

  router.post('/admin/bootstrap', async (req: Request, res: Response) => {
    const configuredToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
    if (!configuredToken) {
      res.status(403).json({ success: false, error: 'BOOTSTRAP_ADMIN_TOKEN 未配置' });
      return;
    }

    const token = String(req.headers['x-bootstrap-admin-token'] || req.body?.bootstrapToken || '');
    if (token !== configuredToken) {
      res.status(403).json({ success: false, error: '初始化管理员 token 不正确' });
      return;
    }

    const requestedUserId = Number(req.body?.userId);
    const identifier = String(req.body?.identifier || '').trim();
    const userType = String(req.body?.userType || 'sys_admin');

    if (!['sys_admin', 'admin'].includes(userType)) {
      res.status(400).json({ success: false, error: 'bootstrap 只能设置 sys_admin 或 admin' });
      return;
    }

    const users = await dbService.users.findAll({ limit: 1000 });
    const hasAdmin = users.some(user => ['sys_admin', 'admin'].includes((user as any).user_type || 'normal'));
    if (hasAdmin) {
      res.status(409).json({ success: false, error: '已存在管理员，请使用管理员账号设置角色' });
      return;
    }

    let targetUser: Awaited<ReturnType<typeof dbService.users.findById>> = null;
    if (Number.isInteger(requestedUserId) && requestedUserId > 0) {
      targetUser = await dbService.users.findById(requestedUserId);
    } else if (identifier) {
      targetUser = identifier.includes('@')
        ? await dbService.users.findByEmail(identifier)
        : await dbService.users.findByUsername(identifier);
    } else {
      res.status(400).json({ success: false, error: '请提供 userId 或 identifier（用户名/邮箱）' });
      return;
    }

    if (!targetUser) {
      res.status(404).json({ success: false, error: '用户不存在' });
      return;
    }

    const userId = Number(targetUser.id);
    await dbGatewayClient.updateUserType(userId, userType);
    res.json({ success: true, message: '管理员初始化成功', data: { userId, userType } });
  });

  router.get('/admin/users', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageUserTypes(authUser)) {
      res.status(403).json({ success: false, error: '只有管理员可以查看账号权限' });
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const users = await dbService.users.findAll({
      limit,
      offset,
      orderBy: 'created_at',
      orderDirection: 'DESC'
    });

    res.json({
      success: true,
      data: users.map(safeUserFields).filter(Boolean)
    });
  });

  router.patch('/admin/users/:id/type', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!canManageUserTypes(authUser)) {
      res.status(403).json({ success: false, error: '只有管理员可以设置用户类型' });
      return;
    }

    const userId = Number(req.params.id);
    const userType = String(req.body?.user_type || req.body?.userType || '');
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ success: false, error: '用户ID无效' });
      return;
    }

    if (!allowedUserTypes.has(userType)) {
      res.status(400).json({ success: false, error: '不支持的用户类型' });
      return;
    }

    const targetUser = await dbService.users.findById(userId);
    if (!targetUser) {
      res.status(404).json({ success: false, error: '用户不存在' });
      return;
    }

    await dbGatewayClient.updateUserType(userId, userType);
    res.json({ success: true, message: '用户类型已更新', data: { userId, userType } });
  });

  // 获取用户的钱包地址
  router.get('/user/:id/address', requireAuth, async (req: AuthenticatedRequest<{ id: string }, ApiResponse>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);
    const chain_type = req.query.chain_type as 'evm' | 'btc' | 'solana';
    
    if (userId === null) {
      return;
    }

    if (!chain_type) {
      const errorResponse: ApiResponse = { error: '链类型是必需的' };
      res.status(400).json(errorResponse);
      return;
    }

    if (!['evm', 'btc', 'solana'].includes(chain_type)) {
      const errorResponse: ApiResponse = { error: '不支持的链类型，支持的类型: evm, btc, solana' };
      res.status(400).json(errorResponse);
      return;
    }

    // 调用业务逻辑服务
    const result = await walletBusinessService.getUserWallet(userId, chain_type);
    
    if (result.success) {
      const successResponse: ApiResponse = { 
        message: '获取用户钱包成功',
        data: result.data
      };
      res.json(successResponse);
    } else {
      const errorResponse: ApiResponse = { error: result.error || '未知错误' };
      
      // 根据错误类型设置不同的状态码
      if (result.error?.includes('Signer 模块不可用')) {
        res.status(503).json(errorResponse);
      } else if (result.error?.includes('生成的钱包地址已被使用')) {
        res.status(409).json(errorResponse);
      } else {
        res.status(500).json(errorResponse);
      }
    }
  });


  // 获取用户余额总和（所有链的总和）
  router.get('/user/:id/balance/total', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);
    
    if (userId === null) {
      return;
    }
    // console.log('userIddddddddddddddd', userId);
    const result = await walletBusinessService.getUserTotalBalance(userId);
    // console.log('resultttttttttttt', result);
    if (result.success) {
      const response: ApiResponse = { 
        message: '获取用户余额总和成功',
        data: result.data 
      };
      res.json(response);
    } else {
      const errorResponse: ApiResponse = { error: result.error || '未知错误' };
      res.status(500).json(errorResponse);
    }
  });

  // 获取用户余额统计概览
  router.get('/user/:id/balance/stats', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);

    if (userId === null) {
      return;
    }

    const result = await walletBusinessService.getUserBalanceStats(userId);

    if (result.success) {
      const response: ApiResponse = {
        message: '获取用户余额统计成功',
        data: result.data
      };
      res.json(response);
    } else {
      const errorResponse: ApiResponse = { error: result.error || '未知错误' };
      res.status(500).json(errorResponse);
    }
  });

  // 获取用户地址级余额明细
  router.get('/user/:id/balance/details', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);

    if (userId === null) {
      return;
    }

    const result = await walletBusinessService.getUserBalanceDetails(userId);

    if (result.success) {
      const response: ApiResponse = {
        message: '获取用户余额明细成功',
        data: result.data
      };
      res.json(response);
    } else {
      const errorResponse: ApiResponse = { error: result.error || '未知错误' };
      res.status(500).json(errorResponse);
    }
  });

  // 获取用户充值中的余额
  router.get('/user/:id/balance/pending', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);
    
    if (userId === null) {
      return;
    }

    const result = await walletBusinessService.getUserPendingDeposits(userId);
    
    if (result.success) {
      const response: ApiResponse = { 
        message: '获取充值中余额成功',
        data: result.data 
      };
      res.json(response);
    } else {
      const errorResponse: ApiResponse = { error: result.error || '未知错误' };
      res.status(500).json(errorResponse);
    }
  });

  // 获取用户指定代币的余额详情
  router.get('/user/:id/balance/token/:symbol', requireAuth, async (req: AuthenticatedRequest<{ id: string; symbol: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);
    const tokenSymbol = req.params.symbol;
    
    if (userId === null) {
      return;
    }

    if (!tokenSymbol || tokenSymbol.trim() === '') {
      const errorResponse: ApiResponse = { error: '代币符号不能为空' };
      res.status(400).json(errorResponse);
      return;
    }

    const result = await walletBusinessService.getUserTokenBalance(userId, tokenSymbol.toUpperCase());
    
    if (result.success) {
      const response: ApiResponse = { 
        message: `获取${tokenSymbol.toUpperCase()}余额详情成功`,
        data: result.data 
      };
      res.json(response);
    } else {
      if (result.error?.includes('用户没有')) {
        const errorResponse: ApiResponse = { error: result.error };
        res.status(404).json(errorResponse);
      } else {
        const errorResponse: ApiResponse = { error: result.error || '未知错误' };
        res.status(500).json(errorResponse);
      }
    }
  });

  // 用户提现
  router.post('/user/withdraw', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { 
      userId, 
      to, 
      amount, 
      tokenId,
      tokenSymbol,
      chainId,
      chainType
    } = req.body;
    const authUser = getAuthenticatedUser(req);
    
    // 参数验证
    if (!to || !amount || (!tokenId && !tokenSymbol) || !chainId || !chainType) {
      const errorResponse: ApiResponse = { error: '缺少必需参数: to, amount, tokenId, chainId, chainType' };
      res.status(400).json(errorResponse);
      return;
    }

    // 兼容旧客户端传 userId，但不信任 body 里的用户身份。
    if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
      const requestedUserId = parseInt(String(userId), 10);
      if (isNaN(requestedUserId)) {
        const errorResponse: ApiResponse = { error: '无效的用户ID' };
        res.status(400).json(errorResponse);
        return;
      }

      if (!isPrivilegedUser(authUser) && requestedUserId !== authUser.id) {
        const errorResponse: ApiResponse = { success: false, error: '无权为其他用户发起提现' };
        res.status(403).json(errorResponse);
        return;
      }
    }

    // 验证地址格式（根据链类型）
    let isValidAddress = false;
    if (chainType === 'evm') {
      // EVM 地址: 0x + 40 个十六进制字符
      isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(to);
    } else if (chainType === 'solana') {
      // Solana 地址: Base58 编码，32-44 个字符
      isValidAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to);
    } else if (chainType === 'btc') {
      // BTC 地址: 支持 Legacy (P2PKH, P2SH) 和 Bech32 格式
      isValidAddress = /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,89}$/.test(to);
    }

    if (!isValidAddress) {
      const errorResponse: ApiResponse = { error: `无效的${chainType.toUpperCase()}地址格式` };
      res.status(400).json(errorResponse);
      return;
    }

    // 验证金额格式
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      const errorResponse: ApiResponse = { error: '无效的提现金额' };
      res.status(400).json(errorResponse);
      return;
    }

    // 验证链类型
    if (!['evm', 'btc', 'solana'].includes(chainType)) {
      const errorResponse: ApiResponse = { error: '不支持的链类型，支持的类型: evm, btc, solana' };
      res.status(400).json(errorResponse);
      return;
    }

    // 验证链ID格式
    const chainIdNum = parseInt(chainId, 10);
    if (isNaN(chainIdNum) || chainIdNum <= 0) {
      const errorResponse: ApiResponse = { error: '无效的链ID格式' };
      res.status(400).json(errorResponse);
      return;
    }

    const tokenIdNum = tokenId !== undefined && tokenId !== null && String(tokenId).trim() !== ''
      ? Number(tokenId)
      : undefined;
    if (tokenIdNum !== undefined && (!Number.isInteger(tokenIdNum) || tokenIdNum <= 0)) {
      const errorResponse: ApiResponse = { error: '无效的代币ID' };
      res.status(400).json(errorResponse);
      return;
    }

    // 调用业务逻辑服务（Gas 费用将自动估算）
    const result = await walletBusinessService.withdrawFunds({
      userId: authUser.id,
      to: to,
      amount: amount,
      ...(tokenIdNum !== undefined ? { tokenId: tokenIdNum } : { tokenSymbol: String(tokenSymbol).toUpperCase() }),
      chainId: chainIdNum,
      chainType: chainType as 'evm' | 'btc' | 'solana'
    });
    
    if (result.success) {
      const successResponse: ApiResponse = {
        success: true,
        message: '提现签名成功',
        data: result.data
      };
      res.json(successResponse);
    } else {
      const errorResponse: ApiResponse = {
        success: false,
        error: result.error || '提现失败'
      };
      if ('errorDetail' in result && (result as any).errorDetail) {
        errorResponse.details = (result as any).errorDetail;
      }

      // 根据错误类型设置不同的状态码
      if (result.error?.includes('余额不足')) {
        res.status(400).json(errorResponse);
      } else if (result.error?.includes('钱包不存在')) {
        res.status(404).json(errorResponse);
      } else if (result.error?.includes('Signer 模块不可用')) {
        res.status(503).json(errorResponse);
      } else if (result.error?.includes('不支持的代币')) {
        res.status(400).json(errorResponse);
      } else if (result.error?.includes('提现被拒绝')) {
        // 风控拒绝 - 返回 403 Forbidden
        res.status(403).json(errorResponse);
      } else {
        res.status(500).json(errorResponse);
      }
    }
  });

  // 获取用户提现记录
  router.get('/user/:id/withdraws', requireAuth, async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
    const userId = getAuthorizedUserIdFromParam(req, res);
    const status = req.query.status as string;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    
    if (userId === null) {
      return;
    }

    try {
      const withdraws = await dbService.getConnection().getUserWithdraws(userId, status);
      
      // 分页处理
      const total = withdraws.length;
      const paginatedWithdraws = withdraws.slice(offset, offset + limit);
      
      const response: ApiResponse = {
        message: '获取用户提现记录成功',
        data: {
          withdraws: paginatedWithdraws,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total
          }
        }
      };
      
      res.json(response);
    } catch (error) {
      const errorResponse: ApiResponse = { 
        error: error instanceof Error ? error.message : '获取提现记录失败' 
      };
      res.status(500).json(errorResponse);
    }
  });

  // 获取待处理的提现
  router.get('/withdraws/pending', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!isPrivilegedUser(authUser)) {
      const errorResponse: ApiResponse = { success: false, error: '无权访问待处理提现列表' };
      res.status(403).json(errorResponse);
      return;
    }

    try {
      const pendingWithdraws = await dbService.getConnection().getPendingWithdraws();
      
      const response: ApiResponse = {
        message: '获取待处理提现成功',
        data: {
          withdraws: pendingWithdraws,
          count: pendingWithdraws.length
        }
      };
      
      res.json(response);
    } catch (error) {
      const errorResponse: ApiResponse = { 
        error: error instanceof Error ? error.message : '获取待处理提现失败' 
      };
      res.status(500).json(errorResponse);
    }
  });

  // EVM 热钱包 nonce 堵塞诊断。用于运营判断哪笔低 nonce 提现需要先收口。
  router.get('/admin/evm/nonce-diagnostics', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!isPrivilegedUser(authUser)) {
      const errorResponse: ApiResponse = { success: false, error: '无权访问 nonce 诊断' };
      res.status(403).json(errorResponse);
      return;
    }

    const chainId = req.query.chainId !== undefined ? Number(req.query.chainId) : undefined;
    if (chainId !== undefined && (!Number.isInteger(chainId) || chainId <= 0)) {
      const errorResponse: ApiResponse = { success: false, error: '无效的 chainId' };
      res.status(400).json(errorResponse);
      return;
    }

    try {
      const diagnostics = await hotWalletService.diagnoseEvmHotWalletNonces(chainId);
      const response: ApiResponse = {
        message: '获取 EVM nonce 诊断成功',
        data: {
          diagnostics,
          count: diagnostics.length
        }
      };
      res.json(response);
    } catch (error) {
      const errorResponse: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : '获取 EVM nonce 诊断失败'
      };
      res.status(500).json(errorResponse);
    }
  });

  // 重新尝试仍处于 user_withdraw_request 的排队提现。
  router.post('/admin/withdraws/:withdrawId/retry-broadcast', requireAuth, async (req: AuthenticatedRequest<{ withdrawId: string }>, res: Response) => {
    const authUser = getAuthenticatedUser(req);
    if (!isPrivilegedUser(authUser)) {
      const errorResponse: ApiResponse = { success: false, error: '无权重试排队提现' };
      res.status(403).json(errorResponse);
      return;
    }

    const withdrawId = Number(req.params.withdrawId);
    if (!Number.isInteger(withdrawId) || withdrawId <= 0) {
      const errorResponse: ApiResponse = { success: false, error: '无效的提现ID' };
      res.status(400).json(errorResponse);
      return;
    }

    try {
      const withdraw = await dbService.getConnection().getWithdrawById(withdrawId);
      if (!withdraw) {
        const errorResponse: ApiResponse = { success: false, error: '提现记录不存在' };
        res.status(404).json(errorResponse);
        return;
      }

      if (withdraw.status !== 'user_withdraw_request') {
        const errorResponse: ApiResponse = {
          success: false,
          error: `只有待广播排队提现可以重试，当前状态为 ${withdraw.status}`
        };
        res.status(400).json(errorResponse);
        return;
      }

      await walletBusinessService.continueWithdrawAfterReview(withdraw);
      const refreshed = await dbService.getConnection().getWithdrawById(withdrawId);
      const response: ApiResponse = {
        success: true,
        message: '排队提现已重新尝试广播',
        data: {
          withdraw: refreshed
        }
      };
      res.json(response);
    } catch (error) {
      const errorResponse: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : '重试排队提现失败'
      };
      res.status(500).json(errorResponse);
    }
  });

  // 获取特定提现记录详情
  router.get('/withdraws/:withdrawId', requireAuth, async (req: AuthenticatedRequest<{ withdrawId: string }>, res: Response) => {
    const withdrawId = parseInt(req.params.withdrawId, 10);
    
    if (isNaN(withdrawId)) {
      const errorResponse: ApiResponse = { error: '无效的提现ID' };
      res.status(400).json(errorResponse);
      return;
    }

    try {
      const withdraw = await dbService.getConnection().getWithdrawById(withdrawId);
      
      if (!withdraw) {
        const errorResponse: ApiResponse = { error: '提现记录不存在' };
        res.status(404).json(errorResponse);
        return;
      }

      const authUser = getAuthenticatedUser(req);
      if (!isPrivilegedUser(authUser) && Number(withdraw.user_id) !== authUser.id) {
        const errorResponse: ApiResponse = { success: false, error: '无权访问该提现记录' };
        res.status(403).json(errorResponse);
        return;
      }

      // 获取关联的 credit 记录
      const credits = await dbService.getConnection().getCreditsByWithdrawId(withdrawId);
      
      const response: ApiResponse = {
        message: '获取提现记录详情成功',
        data: {
          withdraw,
          credits
        }
      };
      
      res.json(response);
    } catch (error) {
      const errorResponse: ApiResponse = { 
        error: error instanceof Error ? error.message : '获取提现记录详情失败' 
      };
      res.status(500).json(errorResponse);
    }
  });


  return router;
}
