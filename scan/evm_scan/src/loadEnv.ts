import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

function loadProjectEnv() {
  const cwd = process.cwd();
  let loaded = false;
  const shouldLogEnvLoad = process.env.LOG_ENV_LOAD === 'true';

  // 1. 加载根目录统一密钥配置（keys.env）
  const rootEnvPath = path.resolve(cwd, '../../keys.env');
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
    if (shouldLogEnvLoad) {
      console.log('根目录 keys.env 已加载');
    }
    loaded = true;
  } else if (shouldLogEnvLoad) {
    console.warn('根目录未找到 keys.env 配置文件');
  }

  // 2. 加载当前子项目自己的 .env（允许覆盖）
  const localEnvPath = path.resolve(cwd, '.env');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ 
      path: localEnvPath, 
      override: true 
    });
    if (shouldLogEnvLoad) {
      console.log('当前项目 .env 已加载并覆盖');
    }
    loaded = true;
  }

  if (!loaded && shouldLogEnvLoad) {
    console.warn('未找到任何 .env 配置文件');
  }
}

loadProjectEnv();
export {};
