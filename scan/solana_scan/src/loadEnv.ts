import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

function loadProjectEnv() {
  const cwd = process.cwd();
  let loaded = false;
  const verbose = process.env.LOG_ENV_LOAD === 'true';

  // 1. 加载根目录统一密钥配置（keys.env）
  const rootEnvPath = path.resolve(cwd, '../../keys.env');
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
    if (verbose) {
      console.log('Root keys.env loaded');
    }
    loaded = true;
  }else{
    if (verbose) {
      console.warn('Root keys.env not found');
    }
  }

  // 2. 加载当前子项目自己的 .env（允许覆盖）
  const localEnvPath = path.resolve(cwd, '.env');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ 
      path: localEnvPath, 
      override: true 
    });
    if (verbose) {
      console.log('Local .env loaded with override');
    }
    loaded = true;
  }

  if (!loaded && verbose) {
    console.warn('No env file found');
  }
}

loadProjectEnv();
export {};
