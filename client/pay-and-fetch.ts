/**
 * Pay for one call, for real, and print what came back.
 *
 * This is the other half of the service: an agent that holds a wallet, hits a
 * 402, signs a payment authorization and retries. It runs in Node, not in the
 * Worker, and it talks to whatever URL you point it at.
 *
 *   EVM_PRIVATE_KEY=0x... QUANTA_URL=https://quanta.themeknock.net npm run pay
 *
 * The key is read from the environment and never written anywhere - not to a
 * file, not to the log line below, not into git. What IS printed is the payer
 * address (public), the HTTP status, the settlement tx hash and its BaseScan
 * link, because those are the proof the loop actually closed.
 *
 * There is no try/catch around the payment. If it fails, the failure is the
 * output: a client that swallows the error and prints "done" is worse than no
 * client at all.
 */

import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_SEPOLIA_CHAIN_ID = 84532;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    console.error(
      name === "EVM_PRIVATE_KEY"
        ? "Put a FUNDED Base Sepolia test key in the shell for one command, never in a file:\n" +
            "  EVM_PRIVATE_KEY=0x... QUANTA_URL=https://quanta.themeknock.net npm run pay"
        : "  QUANTA_URL=https://quanta.themeknock.net npm run pay",
    );
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const key = required("EVM_PRIVATE_KEY");
  const baseUrl = (process.env.QUANTA_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const target = process.env.TARGET_URL ?? "https://example.com";

  const account = privateKeyToAccount(key as `0x${string}`);
  console.log(`[wallet] ${account.address} on Base Sepolia (eip155:${BASE_SEPOLIA_CHAIN_ID})`);

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const url = `${baseUrl}/v1/check?url=${encodeURIComponent(target)}`;

  // What an unpaid caller sees, so the price is visible before anything is signed.
  const unpaid = await fetch(url);
  console.log(`[unpaid] ${unpaid.status} ${unpaid.statusText}`);

  console.log(`[paying] ${url}`);
  const response = await fetchWithPayment(url);
  const body = await response.text();
  console.log(`[paid] ${response.status} ${response.statusText}`);

  const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
  if (!settlementHeader) {
    // A second 402 means the payment was built and sent but the facilitator
    // refused it. The reason is in the challenge it sends back, and printing it
    // is the whole point of this client - "it failed" is not a useful answer.
    console.error("[settlement] nothing settled.");
    const challenge = response.headers.get("PAYMENT-REQUIRED");
    if (challenge) {
      const decoded = decodePaymentRequiredHeader(challenge) as { error?: string };
      console.error(`[settlement] the facilitator refused it: ${decoded.error ?? "no reason given"}`);
    }
    if (response.status === 402) {
      console.error(
        `[settlement] check the payer's testnet USDC balance:\n` +
          `             https://sepolia.basescan.org/token/0x036CbD53842c5426634e7929541eC2318f3dCF7e?a=${account.address}`,
      );
    }
    process.exitCode = 1;
  } else {
    const settlement = decodePaymentResponseHeader(settlementHeader) as {
      success?: boolean;
      transaction?: string;
      network?: string;
      payer?: string;
    };
    console.log(`[settlement] success=${settlement.success} network=${settlement.network}`);
    console.log(`[settlement] tx ${settlement.transaction}`);
    console.log(`[settlement] https://sepolia.basescan.org/tx/${settlement.transaction}`);
    if (!settlement.success) process.exitCode = 1;
  }

  console.log("[verdict]");
  console.log(JSON.stringify(JSON.parse(body), null, 2));
}

// No catch that turns a failure into a clean exit. A broken paid loop must look broken.
await main();
