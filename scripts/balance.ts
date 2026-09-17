/**
 * Is the payer funded? Read it from the chain, never from memory.
 *
 * `npm run pay` fails with invalid_exact_evm_insufficient_balance when the payer
 * holds no testnet USDC, and that error looks the same whether funding never
 * arrived, went to a different address, or landed on a different network. This
 * answers that question before any signing happens.
 *
 *   npm run balance                  # derives the address from EVM_PRIVATE_KEY
 *   npm run balance -- 0xabc...      # any address, no key needed
 */

import { createPublicClient, formatUnits, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Circle's USDC on Base Sepolia. Testnet only - this script never reads mainnet.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const BALANCE_OF = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function payerAddress(): `0x${string}` {
  const argument = process.argv[2];
  if (argument) {
    if (!isAddress(argument)) throw new Error(`not an address: ${argument}`);
    return argument;
  }
  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) {
    console.error("Pass an address, or put the payer key in EVM_PRIVATE_KEY for one command:");
    console.error("  npm run balance -- 0xYourPayerAddress");
    process.exit(1);
  }
  return privateKeyToAccount(key as `0x${string}`).address;
}

const address = payerAddress();
const client = createPublicClient({ chain: baseSepolia, transport: http() });

const [usdc, gas, nonce] = await Promise.all([
  client.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [address] }),
  client.getBalance({ address }),
  client.getTransactionCount({ address }),
]);

const price = 1000n; // one call, in atomic units, as quoted by the live 402
console.log(`payer   ${address}`);
console.log(`chain   Base Sepolia (eip155:84532), block ${await client.getBlockNumber()}`);
console.log(`USDC    ${formatUnits(usdc, 6)}  (${usdc} atomic)`);
console.log(`gas     ${formatUnits(gas, 18)} ETH`);
console.log(`nonce   ${nonce}${nonce === 0 ? "  - this wallet has never sent a transaction" : ""}`);
console.log(
  usdc >= price
    ? `\nFunded: enough for ${usdc / price} call(s) at 0.001 USDC. Run: npm run pay`
    : `\nNot funded. npm run pay will fail with invalid_exact_evm_insufficient_balance.`,
);
console.log(`https://sepolia.basescan.org/token/${USDC}?a=${address}`);
