import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const RPC_URL = 'https://ethereum-rpc.publicnode.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY env var required');
  process.exit(1);
}

const abi = parseAbi([
  'function register(string _uri) external returns (uint256)'
]);

async function registerAgent() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log('Wallet:', account.address);
  
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(RPC_URL)
  });

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL)
  });

  const agentURI = 'https://tech-signals-agent-production.up.railway.app/.well-known/erc8004.json';
  console.log('Registering with agentURI:', agentURI);
  
  try {
    const hash = await walletClient.writeContract({
      address: REGISTRY,
      abi,
      functionName: 'register',
      args: [agentURI]
    });

    console.log('TX Hash:', hash);
    console.log('Etherscan: https://etherscan.io/tx/' + hash);
    
    console.log('Waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('Status:', receipt.status);
    console.log('Block:', receipt.blockNumber);
    
    return hash;
  } catch (error) {
    console.error('Registration failed:', error.message);
    throw error;
  }
}

registerAgent().catch(console.error);
