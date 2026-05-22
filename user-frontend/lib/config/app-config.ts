export const APP_CONFIG = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000',
  riskControlUrl: process.env.NEXT_PUBLIC_RISK_CONTROL_URL || 'http://localhost:3004',
  signerUrl: process.env.NEXT_PUBLIC_SIGNER_URL || 'http://localhost:3001',
  dashboardPageSize: 20
};
