/**
 * LEGACY — deploy helper for a Tact Escrow contract that does not exist in
 * this repo. Custody is off-chain in the signer W5 wallet; this module is
 * kept for API compatibility and always throws `deploy_not_configured`
 * unless someone wires a real code BOC. Do not call it in the deal flow.
 *
 * Deployment body: the Deployable trait expects Deploy{queryId}, i.e.
 * op = 0x00000000 (u32) followed by queryId (u64).
 */
import { Address, Cell } from '@ton/core';
import { config } from '../config';
import { ESCROW_CODE_HEX, deployBody, Escrow } from '../contracts/wrappers/Escrow';
import { computeJettonWalletAddress } from './jettonUtils';
import { getSignerAddress, deployEscrowViaSigner } from './signerClient';
import { toBaseUnits } from '../utils/money';

/** Human amount -> base units (nanoTON for TON deals, 6dp for USDT-style jettons). */
export function parseDealAmount(amount: string | number, assetType: number): bigint {
  const asset = assetType === 0 ? 'TON' : 'USDT';
  return BigInt(toBaseUnits(amount, asset));
}

/**
 * Deploys a new Escrow instance and returns its address.
 *
 * NOTE: `sellerJettonWallet` / `feeJettonWallet` are kept in the signature for
 * API compatibility with existing callers; the current contract version takes
 * only the contract's own jetton wallet (release transfers the full jetton
 * amount to the seller; fee split is handled off-chain).
 */
export async function deployEscrowContract(
  dealId: bigint,
  buyer: Address,
  seller: Address,
  assetType: number,
  amount: bigint,
  deadline: number,
  _sellerJettonWallet?: Address,
  _feeJettonWallet?: Address,
): Promise<string> {
  if (!config.signerUrl) {
    throw new Error(
      'deploy_not_configured: SIGNER_URL missing — set SIGNER_URL (e.g. http://signer:3001) and SIGNER_MNEMONIC in signer/.env',
    );
  }
  const codeHex = config.escrowContractCodeHex || ESCROW_CODE_HEX;
  if (!codeHex) {
    throw new Error(
      'deploy_not_configured: ESCROW_CONTRACT_CODE_HEX is empty — no on-chain escrow contract exists in this repo (custodial off-chain model)',
    );
  }
  if (!config.adminAddress || !config.feeAddress) {
    throw new Error('deploy_not_configured: ADMIN_ADDRESS and FEE_ADDRESS are required');
  }

  let code: Cell;
  try {
    code = Cell.fromBoc(Buffer.from(codeHex, 'hex'))[0];
  } catch (err) {
    throw new Error(`deploy_not_configured: invalid ESCROW_CONTRACT_CODE_HEX (${String(err)})`);
  }

  let jettonMaster: Address | null = null;
  let contractJettonWallet: Address | null = null;
  // Resolve deployer (signer) address for jetton wallet derivation + Escrow owner
  let signerAddr: Address;
  try {
    signerAddr = Address.parse(await getSignerAddress());
  } catch (e) {
    throw new Error(
      `deploy_not_configured: signer unavailable (${String(e)}) — check signer service and SIGNER_API_KEY`,
    );
  }

  if (assetType === 1) {
    const masterStr = config.jettonMasterAddress || config.usdtJettonAddress;
    if (!masterStr) {
      throw new Error('deploy_not_configured: JETTON_MASTER_ADDRESS is required for jetton deals');
    }
    jettonMaster = Address.parse(masterStr);
    try {
      contractJettonWallet = await computeJettonWalletAddress(jettonMaster, signerAddr);
    } catch {
      // best-effort: null flows into the explicit "could not derive" throw below.
      contractJettonWallet = null;
    }
    if (!contractJettonWallet) {
      throw new Error('deploy_not_configured: could not derive contract jetton wallet address (RPC unreachable?)');
    }
  }

  const escrow = Escrow.create({
    dealId,
    buyer,
    seller,
    admin: Address.parse(config.adminAddress),
    feeAddress: Address.parse(config.feeAddress),
    assetType,
    amount,
    feeBps: config.feeBps,
    deadline,
    jettonMaster,
    contractJettonWallet,
    owner: signerAddr,
    code,
  });

  // Delegate signing/sending to signer microservice
  const deployBodyCell = deployBody(0n);
  const stateInit = escrow.init;
  if (!stateInit) throw new Error('deploy_not_configured: escrow init missing (code?)');

  const codeBoc = stateInit.code.toBoc().toString('base64');
  const dataBoc = stateInit.data.toBoc().toString('base64');
  const bodyBoc = deployBodyCell.toBoc().toString('base64');

  await deployEscrowViaSigner({
    escrowAddress: escrow.address.toString(),
    escrowStateInit: { codeBoc, dataBoc },
    value: '0.12',
    bodyBoc,
  });

  return escrow.address.toString();
}
