
import '../src/loadEnv';
/**
 * 启动带 Metaplex Token Metadata Program 的本地 Solana 验证器
 * 运行: npx ts-node mock/deploy-metaplex-program.ts
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Metaplex Token Metadata Program ID
const METAPLEX_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/**
 * 下载 Metaplex 程序文件
 */
async function downloadMetaplexProgram(): Promise<string> {
  const programDir = path.join(__dirname, '../programs');
  const programPath = path.join(programDir, 'mpl_token_metadata.so');
  
  if (!fs.existsSync(programDir)) {
    fs.mkdirSync(programDir, { recursive: true });
  }
  
  if (!fs.existsSync(programPath)) {
    console.log('📥 正在下载 Metaplex Token Metadata Program...');
    
    const downloadUrl = 'https://github.com/metaplex-foundation/mpl-token-metadata/releases/download/v3.2.0/mpl_token_metadata.so';
    
    try {
      const response = await fetch(downloadUrl);
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(programPath, Buffer.from(buffer));
      console.log('✅ 下载完成');
      console.log(`📁 保存路径: ${programPath}`);
    } catch (error) {
      console.error('❌ 下载失败:', error);
      throw error;
    }
  } else {
    console.log('✅ Metaplex 程序文件已存在');
  }
  
  return programPath;
}

/**
 * 停止现有验证器
 */
async function stopExistingValidator() {
  return new Promise<void>((resolve) => {
    const { exec } = require('child_process');
    exec('pkill -f solana-test-validator', (error: any) => {
      if (!error) {
        console.log('✅ 已停止现有验证器');
      }
      setTimeout(resolve, 2000);
    });
  });
}

/**
 * 启动本地验证器并显示详细输出
 */
async function startValidator() {
  try {
    console.log('\n🚀 正在启动带 Metaplex 程序的本地验证器...\n');
    
    // 停止现有验证器
    await stopExistingValidator();
    
    // 下载程序文件
    const programPath = await downloadMetaplexProgram();
    
    // 启动验证器 - 不使用 --quiet，让控制台显示完整信息
    const validatorProcess = spawn('solana-test-validator', [
      '--reset',
      '--bpf-program', METAPLEX_PROGRAM_ID, programPath
    ], {
      stdio: 'inherit', // 直接继承父进程的 stdio，这样会显示所有输出
      shell: true
    });
    
    console.log('\n✅ 验证器已启动');
    console.log(`📦 Metaplex Program ID: ${METAPLEX_PROGRAM_ID}`);
    console.log(`🔗 RPC URL: http://127.0.0.1:8899`);
    console.log(`🔌 WebSocket URL: ws://127.0.0.1:8900`);
    console.log('\n📊 验证器输出信息:\n');
    
    // 监听进程退出
    validatorProcess.on('close', (code) => {
      console.log(`\n🛑 验证器已停止 (exit code: ${code})`);
      process.exit(code || 0);
    });
    
    // 监听错误
    validatorProcess.on('error', (error) => {
      console.error(`❌ 验证器错误: ${error.message}`);
      process.exit(1);
    });
    
    // 保持进程运行
    await new Promise(() => {});
    
  } catch (error) {
    console.error('❌ 启动失败:', error);
    process.exit(1);
  }
}

// 处理退出信号
process.on('SIGINT', () => {
  console.log('\n\n🛑 正在停止验证器...');
  process.exit(0);
});

// 启动验证器
startValidator();