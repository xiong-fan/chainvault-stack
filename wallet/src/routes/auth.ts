import { Router, Request, Response } from 'express';
import { DatabaseReader } from '../db';
import { AuthError, AuthService, extractBearerToken } from '../services/authService';

interface ApiResponse<T = any> {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
}

function sendAuthError(res: Response, error: unknown) {
  if (error instanceof AuthError) {
    const response: ApiResponse = {
      success: false,
      error: error.message,
      data: { code: error.code }
    };
    res.status(error.statusCode).json(response);
    return;
  }

  const response: ApiResponse = {
    success: false,
    error: error instanceof Error ? error.message : '认证服务错误'
  };
  res.status(500).json(response);
}

export function authRoutes(dbService: DatabaseReader): Router {
  const router = Router();
  const authService = new AuthService(dbService);

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { username, email, password } = req.body || {};
      const data = await authService.register({
        username: String(username || ''),
        email: String(email || ''),
        password: String(password || '')
      });

      const response: ApiResponse = {
        success: true,
        message: '注册成功',
        data
      };
      res.status(201).json(response);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password } = req.body || {};
      const data = await authService.login({
        identifier: String(identifier || ''),
        password: String(password || '')
      });

      const response: ApiResponse = {
        success: true,
        message: '登录成功',
        data
      };
      res.json(response);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw new AuthError('缺少认证 token', 401, 'MISSING_TOKEN');
      }

      await authService.logout(token);
      res.json({ success: true, message: '已登出' });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get('/me', async (req: Request, res: Response) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw new AuthError('缺少认证 token', 401, 'MISSING_TOKEN');
      }

      const data = await authService.authenticateToken(token);
      res.json({
        success: true,
        message: '获取当前用户成功',
        data
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  return router;
}
