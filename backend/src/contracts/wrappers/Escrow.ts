/**
 * LEGACY stub — TypeScript cell helpers once intended for a Tact Escrow contract.
 *
 * There is no `contracts/Escrow.tact` in this repo and no on-chain per-deal
 * escrow: custody is entirely off-chain in the signer W5 wallet with Postgres
 * as the source of truth. This file is kept only because
 * `blockchain/contractDeployer.ts` and `index.ts` import its pure cell
 * builders; ESCROW_CODE_HEX stays empty and any deploy path throws
 * `deploy_not_configured`. Do not present this as deployed on-chain escrow.
 *
 * Init-data layout mirrors the Tact init() signature EXACTLY, order matters:
 *   uint64 dealId | Address buyer | Address seller | Address admin |
 *   Address feeAddress | uint8 assetType | coins amount | uint16 feeBps |
 *   uint32 deadline | maybe-ref Address jettonMaster |
 *   maybe-ref Address contractJettonWallet | Address owner
 *
 * Tact serializes `X?` fields as a MAYBE-REF: one selector bit followed by the
 * value in a cell reference (1 + ref when Some, bare 0 bit when None).
 */
import { Address, Builder, beginCell, Cell, Contract, ContractProvider, contractAddress } from '@ton/core';

/** Placeholder — stays empty (no Tact build is wired; see header). */
export const ESCROW_CODE_HEX = '';

/** message(0x65787464) ExtendDeadline { newDeadline: Int as uint32 } */
export const OP_EXTEND_DEADLINE = 0x65787464;

export type EscrowTextOp = 'release' | 'refund' | 'confirm' | 'pause' | 'unpause';

export interface EscrowConfig {
  dealId: bigint;
  buyer: Address;
  seller: Address;
  admin: Address;
  feeAddress: Address;
  /** 0 = TON, 1 = jetton */
  assetType: number;
  amount: bigint;
  feeBps: number;
  /** Unix timestamp (seconds). */
  deadline: number;
  jettonMaster?: Address | null;
  contractJettonWallet?: Address | null;
  /** Bot wallet that controls pause/unpause; set at deploy time. */
  owner: Address;
  /** Compiled contract code cell. */
  code: Cell;
}

export interface EscrowStateInit {
  code: Cell;
  data: Cell;
}

export interface EscrowDealInfo {
  dealId: bigint;
  buyer: Address;
  seller: Address;
  admin: Address;
  assetType: number;
  amount: bigint;
  feeBps: number;
  deadline: number;
  status: number;
}

function storeMaybeAddr(builder: Builder, addr: Address | null | undefined): Builder {
  if (addr == null) {
    return builder.storeBit(0);
  }
  return builder.storeBit(1).storeRef(beginCell().storeAddress(addr).endCell());
}

/** Builds the init-data Cell matching the legacy (never-deployed) init ordering. */
export function buildEscrowData(config: Omit<EscrowConfig, 'code'>): Cell {
  const b = beginCell()
    .storeUint(config.dealId, 64)
    .storeAddress(config.buyer)
    .storeAddress(config.seller)
    .storeAddress(config.admin)
    .storeAddress(config.feeAddress)
    .storeUint(config.assetType, 8)
    .storeCoins(config.amount)
    .storeUint(config.feeBps, 16)
    .storeUint(config.deadline, 32);
  storeMaybeAddr(b, config.jettonMaster ?? null);
  storeMaybeAddr(b, config.contractJettonWallet ?? null);
  return b.storeAddress(config.owner).endCell();
}

export class Escrow implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: EscrowStateInit,
  ) {}

  /** Parses hex BOC of the compiled contract code (e.g. from env). */
  static codeFromBoc(hex: string): Cell {
    if (!hex) {
      throw new Error('Escrow: empty code hex — set ESCROW_CONTRACT_CODE_HEX or pass a code Cell');
    }
    return Cell.fromBoc(Buffer.from(hex, 'hex'))[0];
  }

  static create(config: EscrowConfig): Escrow {
    const init: EscrowStateInit = { code: config.code, data: buildEscrowData(config) };
    return new Escrow(contractAddress(0, init), init);
  }

  /** get fun getStatus(): Int */
  async getStatus(provider: ContractProvider): Promise<number> {
    const { stack } = await provider.get('getStatus', []);
    return stack.readNumber();
  }

  /** get fun dealInfo(): DealInfo (fields pushed to stack in declaration order) */
  async getDealInfo(provider: ContractProvider): Promise<EscrowDealInfo> {
    const { stack } = await provider.get('dealInfo', []);
    return {
      dealId: stack.readBigNumber(),
      buyer: stack.readAddress(),
      seller: stack.readAddress(),
      admin: stack.readAddress(),
      assetType: stack.readNumber(),
      amount: stack.readBigNumber(),
      feeBps: stack.readNumber(),
      deadline: stack.readNumber(),
      status: stack.readNumber(),
    };
  }
}

/** Body for Tact text receivers (`receive("confirm")` etc.). */
export function escrowTextOp(op: EscrowTextOp): Cell {
  return beginCell().storeBuffer(Buffer.from(op, 'ascii')).endCell();
}

/** message(0x65787464) ExtendDeadline body. */
export function extendDeadlineMsg(newDeadline: number): Cell {
  return beginCell().storeUint(OP_EXTEND_DEADLINE, 32).storeUint(newDeadline, 32).endCell();
}

/** Deployable trait expects Deploy{queryId}: op = 0 (u32), then queryId (u64). */
export function deployBody(queryId: bigint = 0n): Cell {
  return beginCell().storeUint(0, 32).storeUint(queryId, 64).endCell();
}

/** Opens an Escrow handle against any client exposing `open()` (TonClient, sandbox…). */
export function openEscrow<C extends { open<T extends Contract>(c: T): T }>(clientLike: C, escrow: Escrow): Escrow {
  return clientLike.open(escrow);
}
