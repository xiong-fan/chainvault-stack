import crypto from 'crypto';
import { promisify } from 'util';
import { DatabaseReader } from '../db';
import { getDbGatewayClient } from './dbGatewayClient';
import { WalletBusinessService } from './walletBusinessService';

const scryptAsync = promisify(crypto.scrypt);
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SafeAuthUser {
  id: number;
  username: string;
  email: string | null;
  user_type: string;
  status: number;
  kyc_status: number;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string
  ) {
    super(message);
  }
}

function normalizeUsername(username: string): string {
  return username.trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeUser(user: any): SafeAuthUser {
  return {
    id: Number(user.id),
    username: user.username,
    email: user.email ?? null,
    user_type: user.user_type || 'normal',
    status: Number(user.status ?? 0),
    kyc_status: Number(user.kyc_status ?? 0),
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at ?? null
  };
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password: string, storedHash?: string | null): Promise<boolean> {
  if (!storedHash) return false;
  const [scheme, salt, expectedHex] = storedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;

  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

export class AuthService {
  private dbGatewayClient = getDbGatewayClient();
  private walletBusinessService: WalletBusinessService;

  constructor(private dbReader: DatabaseReader) {
    this.walletBusinessService = new WalletBusinessService(dbReader);
  }

  async register(params: { username: string; email: string; password: string }): Promise<{
    user: SafeAuthUser;
    wallet: any;
    token: string;
    expiresAt: string;
  }> {
    const username = normalizeUsername(params.username);
    const email = normalizeEmail(params.email);
    this.validateRegistration(username, email, params.password);

    const existingUsername = await this.dbReader.users.findByUsername(username);
    if (existingUsername) {
      throw new AuthError('用户名已存在', 409, 'USERNAME_EXISTS');
    }

    const existingEmail = await this.dbReader.users.findByEmail(email);
    if (existingEmail) {
      throw new AuthError('邮箱已存在', 409, 'EMAIL_EXISTS');
    }

    const password_hash = await hashPassword(params.password);
    const createdUser = await this.dbGatewayClient.createUser({
      username,
      email,
      password_hash,
      user_type: 'normal',
      status: 0,
      kyc_status: 0
    });

    if (!createdUser.id) {
      throw new AuthError('用户创建失败', 500, 'USER_CREATE_FAILED');
    }

    try {
      const walletResult = await this.walletBusinessService.getUserWallet(createdUser.id, 'evm');
      if (!walletResult.success || !walletResult.data) {
        throw new Error(walletResult.error || '默认钱包创建失败');
      }

      const session = await this.createSession(createdUser.id);
      const persistedUser = await this.dbReader.users.findById(createdUser.id);

      return {
        user: safeUser(persistedUser || createdUser),
        wallet: walletResult.data,
        token: session.token,
        expiresAt: session.expiresAt
      };
    } catch (error) {
      try {
        await this.dbGatewayClient.deleteUser(createdUser.id);
      } catch (rollbackError) {
        console.error('注册回滚用户失败:', rollbackError);
      }
      throw new AuthError(
        `注册失败，默认钱包未创建: ${error instanceof Error ? error.message : '未知错误'}`,
        503,
        'DEFAULT_WALLET_FAILED'
      );
    }
  }

  async login(params: { identifier: string; password: string }): Promise<{
    user: SafeAuthUser;
    wallet?: any;
    token: string;
    expiresAt: string;
  }> {
    const identifier = params.identifier.trim();
    if (!identifier || !params.password) {
      throw new AuthError('账号和密码不能为空', 400, 'INVALID_LOGIN');
    }

    const user = identifier.includes('@')
      ? await this.dbReader.users.findByEmail(normalizeEmail(identifier))
      : await this.dbReader.users.findByUsername(identifier);

    if (!user || !(await verifyPassword(params.password, user.password_hash))) {
      throw new AuthError('账号或密码错误', 401, 'INVALID_CREDENTIALS');
    }

    if (user.status !== 0) {
      throw new AuthError('用户状态不可登录', 403, 'USER_DISABLED');
    }

    await this.dbGatewayClient.updateUserLastLogin(Number(user.id));
    const session = await this.createSession(Number(user.id));
    const wallets = await this.dbGatewayClient.getWallets({ user_id: Number(user.id), chain_type: 'evm' });
    const refreshedUser = await this.dbReader.users.findById(Number(user.id));

    return {
      user: safeUser(refreshedUser || user),
      wallet: wallets[0],
      token: session.token,
      expiresAt: session.expiresAt
    };
  }

  async logout(token: string): Promise<void> {
    await this.dbGatewayClient.revokeAuthSession(tokenHash(token));
  }

  async authenticateToken(token: string): Promise<{
    user: SafeAuthUser;
    session: any;
    wallet?: any;
  }> {
    const sessions = await this.dbGatewayClient.getAuthSessions({ token_hash: tokenHash(token) });
    const session = sessions[0];
    if (!session || session.revoked_at) {
      throw new AuthError('会话无效', 401, 'INVALID_SESSION');
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AuthError('会话已过期', 401, 'SESSION_EXPIRED');
    }

    const user = await this.dbReader.users.findById(Number(session.user_id));
    if (!user || user.status !== 0) {
      throw new AuthError('用户不可用', 401, 'USER_UNAVAILABLE');
    }

    const wallets = await this.dbGatewayClient.getWallets({ user_id: Number(user.id), chain_type: 'evm' });
    return {
      user: safeUser(user),
      session,
      wallet: wallets[0]
    };
  }

  private async createSession(userId: number): Promise<{ token: string; expiresAt: string }> {
    const ttlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

    await this.dbGatewayClient.createAuthSession({
      user_id: userId,
      token_hash: tokenHash(token),
      expires_at: expiresAt
    });

    return { token, expiresAt };
  }

  private validateRegistration(username: string, email: string, password: string) {
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw new AuthError('用户名需为 3-32 位字母、数字或下划线', 400, 'INVALID_USERNAME');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError('邮箱格式不正确', 400, 'INVALID_EMAIL');
    }

    if (password.length < 8 || password.length > 128) {
      throw new AuthError('密码需为 8-128 位', 400, 'INVALID_PASSWORD');
    }
  }
}

export function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
