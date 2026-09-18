import { Address, Cell, beginCell, toNano, SendMode } from '@ton/core';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey, mnemonicValidate, KeyPair } from '@ton/crypto';
import { config } from './config';
import logger, { sanitizeLogValue } from './logger';

/**
 * Strict USDT-style (6 decimal) human amount → nano. Rejects anything that is
 * not `^\d+(\.\d{1,6})?$` — notably multi-dot strings like "1.2.3" (which naive
 * split('.') parsing silently truncates to 1.2) and hex/negative forms.
 */
export function parseJettonAmountToNano(amount: string): bigint {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error('invalid jetton amount: must be a non-negative decimal with ≤6 fraction digits');
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const nano = BigInt(whole) * 1000000n + BigInt(fracPadded);
  if (nano <= 0n) throw new Error('jetton amount must be > 0');
  return nano;
}

function parseTonValue(value: string): bigint {
  let v: bigint;
  try {
    v = toNano(String(value));
  } catch {
    throw new Error(`invalid_value: cannot parse TON value ${JSON.stringify(String(value ?? ''))}`);
  }
  return v;
}

/** Optional per-transfer TON cap (MAX_SEND_TON, 0/unset = unlimited). Null = no cap. */
function maxSendNano(): bigint | null {
  const raw = String(config.maxSendTon ?? '').trim();
  if (!raw || raw === '0') return null;
  try {
    const cap = toNano(raw);
    return cap > 0n ? cap : null;
  } catch {
    logger.warn(`MAX_SEND_TON=${raw} unparsable — cap disabled`);
    return null;
  }
}

function assertSendCap(valueNano: bigint): void {
  const cap = maxSendNano();
  if (cap !== null && valueNano > cap) {
    throw new Error(`send_cap_exceeded: transfer exceeds MAX_SEND_TON cap`);
  }
}

const TONCENTER_MAINNET = 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC';

function resolveEndpoint(): string {
  if (config.tonApiEndpoint && config.tonApiEndpoint.trim() !== '') {
    return config.tonApiEndpoint.trim();
  }
  return config.network === 'testnet' ? TONCENTER_TESTNET : TONCENTER_MAINNET;
}

export class W5Signer {
  private client: TonClient;
  private wallet: WalletContractV5R1 | null = null;
  private keyPair: KeyPair | null = null;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.client = new TonClient({
      endpoint: resolveEndpoint(),
      apiKey: config.toncenterApiKey || undefined,
    });
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!config.mnemonic || config.mnemonic.length !== 24) {
        logger.warn('SIGNER_MNEMONIC not configured (need 24 words) — signer in no-wallet mode');
        return;
      }
      // Fail CLOSED on a typo'd seed: mnemonicToPrivateKey does NOT verify the
      // BIP39 checksum, so without this a single mistyped word silently derives
      // a WRONG (empty, unrecoverable-by-operator-expectation) wallet.
      let checksumOk = false;
      try {
        checksumOk = await mnemonicValidate(config.mnemonic);
      } catch (e) {
        throw new Error(`invalid_mnemonic_checksum: mnemonic validation crashed: ${String(e)}`);
      }
      if (!checksumOk) {
        throw new Error(
          'invalid_mnemonic_checksum: SIGNER_MNEMONIC fails BIP39 checksum — refusing to derive a wrong wallet (check for typos/word order)',
        );
      }
      try {
        const kp = await mnemonicToPrivateKey(config.mnemonic);
        this.keyPair = kp;
        this.wallet = WalletContractV5R1.create({
          publicKey: kp.publicKey,
          workchain: config.workchain,
        });
        logger.info(
          `W5 wallet initialized: ${sanitizeLogValue(this.wallet.address.toString({ urlSafe: true, bounceable: false }))} (workchain ${sanitizeLogValue(config.workchain)})`,
        );
      } catch (e) {
        logger.error('Failed to init W5 wallet', e);
        throw e;
      }
    })();
    return this.initPromise;
  }

  getAddress(): Address | null {
    return this.wallet ? this.wallet.address : null;
  }

  getAddressString(): string | null {
    const addr = this.getAddress();
    return addr ? addr.toString({ urlSafe: true, bounceable: false }) : null;
  }

  isConfigured(): boolean {
    return this.wallet !== null && this.keyPair !== null;
  }

  private assertConfigured(): { wallet: WalletContractV5R1; keyPair: KeyPair } {
    if (!this.wallet || !this.keyPair) {
      throw new Error('wallet_not_configured: SIGNER_MNEMONIC missing or invalid (need 24 words)');
    }
    return { wallet: this.wallet, keyPair: this.keyPair };
  }

  getClient(): TonClient {
    return this.client;
  }

  // NOTE: balance is a decimal STRING — JSON.stringify throws on raw bigint,
  // which used to make GET /info 500 on every call.
  async getState(): Promise<{ deployed: boolean; balance: string; address: string | null }> {
    const addr = this.getAddress();
    if (!addr) return { deployed: false, balance: '0', address: null };
    const st = await this.client.getContractState(addr);
    return {
      deployed: st.state === 'active',
      balance: st.balance.toString(),
      address: this.getAddressString(),
    };
  }

  async getSeqno(): Promise<number> {
    const { wallet } = this.assertConfigured();
    const provider = this.client.provider(wallet.address, null);
    return wallet.getSeqno(provider);
  }

  /**
   * Seqno fetch with a diagnosable error. A raw getSeqno failure is ambiguous:
   * the wallet may be undeployed (fund + POST /deploy first) or the TON API
   * may be unreachable — callers map this to 502 with the hint intact.
   */
  private async fetchSeqno(wallet: WalletContractV5R1, provider: ReturnType<TonClient['provider']>): Promise<number> {
    try {
      return await wallet.getSeqno(provider);
    } catch (e) {
      throw new Error(
        `seqno_fetch_failed: ${String((e as Error)?.message || e)} (wallet may be undeployed — fund + POST /deploy — or TON API unreachable)`,
      );
    }
  }

  async getBalance(): Promise<bigint> {
    const addr = this.getAddress();
    if (!addr) return 0n;
    return (await this.client.getContractState(addr)).balance;
  }

  async isDeployed(): Promise<boolean> {
    const addr = this.getAddress();
    if (!addr) return false;
    return (await this.client.getContractState(addr)).state === 'active';
  }

  async deploy(value: string = '0.05'): Promise<{ seqno: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    if (await this.isDeployed()) {
      throw new Error('already_deployed');
    }
    const balance = await this.getBalance();
    const needed = parseTonValue(value);
    assertSendCap(needed);
    // W5 deploy needs enough for self-transfer + fees (~0.02 TON)
    if (balance < needed + toNano('0.02')) {
      throw new Error(
        `insufficient_balance: have ${balance} nano, need ${needed + toNano('0.02')} (send TON to ${wallet.address.toString({ urlSafe: true, bounceable: false })})`,
      );
    }
    const provider = this.client.provider(wallet.address, null);
    const seqno = await this.fetchSeqno(wallet, provider);
    // Try simple deploy via empty transfer with sendMode; many W5 implementations deploy via seqno tx even with no messages.
    // Fallback is self-transfer if seqno didn't advance.
    const { internal } = await import('@ton/ton');
    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: wallet.address,
          value: toNano(value),
          bounce: false,
          body: beginCell().endCell(),
        }),
      ],
    });
    return { seqno };
  }

  async send(req: {
    to: string;
    value: string;
    body?: string | null;
    bounce?: boolean;
    comment?: string;
  }): Promise<{ seqno: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    const toAddr = Address.parse(req.to);
    const value = parseTonValue(req.value);
    if (value <= 0n) throw new Error('value must be > 0');
    assertSendCap(value);

    if (!req.comment || !String(req.comment).trim())
      throw new Error('memo_required: comment memo is mandatory for every TON send');
    if (String(req.comment).length > 120) throw new Error('memo_too_long');
    // Comment is mandatory — always encode as op 0 + stringTail; ignore raw body for /send to enforce memo
    const body: Cell = beginCell().storeUint(0, 32).storeStringTail(String(req.comment)).endCell();
    // If caller also supplied body BOC, we still use comment as memo (body override deprecated)
    void req.body;

    const { internal } = await import('@ton/ton');
    const provider = this.client.provider(wallet.address, null);
    const seqno = await this.fetchSeqno(wallet, provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: toAddr,
          value,
          bounce: req.bounce ?? false,
          body,
        }),
      ],
    });

    return { seqno };
  }

  async sendBatch(
    requests: Array<{ to: string; value: string; comment?: string }>,
  ): Promise<{ seqno: number; count: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    if (requests.length === 0) throw new Error('empty batch');
    if (requests.length > 255) throw new Error('batch too large (max 255)');

    const { internal } = await import('@ton/ton');

    const messages = requests.map((r) => {
      const addr = Address.parse(r.to);
      const val = parseTonValue(r.value);
      if (val <= 0n) throw new Error('value must be > 0');
      assertSendCap(val);
      if (!r.comment || !String(r.comment).trim())
        throw new Error('memo_required: every batch TON send must include comment memo');
      if (String(r.comment).length > 120) throw new Error('memo_too_long');
      const body = beginCell().storeUint(0, 32).storeStringTail(String(r.comment)).endCell();
      return internal({
        to: addr,
        value: val,
        bounce: false,
        body,
      });
    });

    const provider = this.client.provider(wallet.address, null);
    const seqno = await this.fetchSeqno(wallet, provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages,
    });

    return { seqno, count: messages.length };
  }

  /**
   * Send a Jetton (TEP-74) with forward memo.
   * Resolves the signer's jetton wallet for `jettonMasterAddress`, then sends JettonTransfer with forwardPayload = comment.
   * Memo is in forwardPayload so the receiver jetton wallet forwards it with notification op 0x7362d09c.
   */
  async sendJetton(req: {
    jettonMasterAddress: string;
    to: string;
    amount: string; // human amount, e.g. "100.5" for USDT (6 decimals)
    forwardComment?: string;
    forwardTonAmount?: string; // default 0.01 TON for forward
  }): Promise<{ seqno: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    const master = Address.parse(req.jettonMasterAddress);
    const dest = Address.parse(req.to);
    const forwardTon = parseTonValue(req.forwardTonAmount || '0.01');
    if (req.forwardComment && String(req.forwardComment).length > 120) {
      throw new Error('forward_comment_too_long: forward memo max 120 chars');
    }
    let jettonWalletAddr: Address | null = null;
    try {
      const { beginCell } = await import('@ton/core');
      const ownerSlice = beginCell().storeAddress(wallet.address).endCell();
      const res = await this.client.runMethod(master, 'get_wallet_address', [{ type: 'slice', cell: ownerSlice }]);
      jettonWalletAddr = res.stack.readAddress();
    } catch (e) {
      throw new Error(`jetton_wallet_resolve_failed: ${String(e)}`);
    }
    if (!jettonWalletAddr) throw new Error('jetton_wallet_not_found');

    // Strict 6-decimal parse (rejects "1.2.3", hex, negatives — see parseJettonAmountToNano).
    const amountNano = parseJettonAmountToNano(req.amount);

    let forwardPayload: Cell | null = null;
    if (req.forwardComment) {
      forwardPayload = beginCell().storeUint(0, 32).storeStringTail(req.forwardComment).endCell();
    }

    const body = beginCell()
      .storeUint(0x0f8a7ea5, 32) // JETTON_TRANSFER
      .storeUint(0, 64) // queryId
      .storeCoins(amountNano)
      .storeAddress(dest)
      .storeAddress(null) // responseDestination
      .storeBit(0) // customPayload null
      .storeCoins(forwardTon)
      .storeMaybeRef(forwardPayload)
      .endCell();

    const provider = this.client.provider(wallet.address, null);
    const seqno = await this.fetchSeqno(wallet, provider);
    const { internal } = await import('@ton/ton');
    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: jettonWalletAddr,
          value: toNano('0.06'), // jetton op gas
          bounce: true,
          body,
        }),
      ],
    });
    logger.info(
      `Jetton send ${sanitizeLogValue(req.amount)} from ${sanitizeLogValue(jettonWalletAddr.toString())} to ${sanitizeLogValue(dest.toString())} with memo "${sanitizeLogValue(req.forwardComment || '')}"`,
    );
    return { seqno };
  }

  /**
   * Sign and send a custom internal message carrying StateInit + body.
   * Used by backend's Escrow deployer: needs to send Deploy{queryId} body to escrow address with StateInit.
   */
  async sendEscrowDeploy(params: {
    escrowAddress: string;
    escrowStateInit: { codeBoc: string; dataBoc: string }; // base64 BOCs
    value?: string; // default 0.12 TON
    bodyBoc?: string | null; // optional body cell boc base64 (Deploy{queryId})
  }): Promise<{ seqno: number; escrowAddress: string }> {
    const { wallet, keyPair } = this.assertConfigured();
    const toAddr = Address.parse(params.escrowAddress);
    let code: Cell;
    let data: Cell;
    try {
      code = Cell.fromBoc(Buffer.from(params.escrowStateInit.codeBoc, 'base64'))[0];
      data = Cell.fromBoc(Buffer.from(params.escrowStateInit.dataBoc, 'base64'))[0];
      if (!code || !data) throw new Error('empty BOC');
    } catch (e) {
      throw new Error(`invalid_state_init_boc: codeBoc/dataBoc must be valid base64 BOCs: ${String(e)}`);
    }
    const value = parseTonValue(params.value || '0.12');
    if (value <= 0n) throw new Error('value must be > 0');
    assertSendCap(value);
    let body: Cell | undefined;
    if (params.bodyBoc) {
      try {
        body = Cell.fromBoc(Buffer.from(params.bodyBoc, 'base64'))[0];
      } catch (e) {
        throw new Error(`invalid bodyBoc: ${String(e)}`);
      }
    } else {
      body = beginCell().storeUint(0, 32).storeUint(0, 64).endCell(); // Deploy{queryId=0}
    }

    const { internal } = await import('@ton/ton');
    const provider = this.client.provider(wallet.address, null);
    const seqno = await this.fetchSeqno(wallet, provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: toAddr,
          value,
          bounce: false,
          init: { code, data },
          body,
        }),
      ],
    });

    return { seqno, escrowAddress: toAddr.toString() };
  }
}

export const signer = new W5Signer();
