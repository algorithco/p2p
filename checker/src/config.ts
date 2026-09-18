import dotenv from 'dotenv';
dotenv.config();

const network = (process.env.TON_NETWORK || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';

const TONCENTER_V2_MAINNET = 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_V2_TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TONCENTER_V3_MAINNET = 'https://toncenter.com/api/v3';
const TONCENTER_V3_TESTNET = 'https://testnet.toncenter.com/api/v3';

export const config = {
  port: Number(process.env.PORT || 3004),
  tonNetwork: network,
  tonApiEndpoint:
    process.env.TON_API_ENDPOINT && process.env.TON_API_ENDPOINT.trim() !== ''
      ? process.env.TON_API_ENDPOINT.trim()
      : network === 'testnet'
        ? TONCENTER_V2_TESTNET
        : TONCENTER_V2_MAINNET,
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  tonApiV3Base: network === 'testnet' ? TONCENTER_V3_TESTNET : TONCENTER_V3_MAINNET,
  tonApiKey: process.env.TONAPI_KEY || '',
  getgemsApiKey: process.env.GETGEMS_API_KEY || '',
  botToken: process.env.BOT_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL || '',
  dnsRootAddress: process.env.DNS_ROOT_ADDRESS || '',
  tmeResolverAddress: process.env.TME_RESOLVER_ADDRESS || '',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  // Comma-separated allowlisted NFT collection addresses (in addition to the
  // discovered .t.me resolver). Empty = only the discovered resolver is trusted.
  collectionAllowlist: (process.env.COLLECTION_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
