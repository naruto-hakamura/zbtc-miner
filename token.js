import dotenv from 'dotenv';
import minimist from "minimist";
import { Web3 } from "web3";
import { readFileSync } from 'node:fs';
import { isAddress } from "web3-validator";
import { TransferTokens } from "./BlockchainInteraction.js";
import { solveSigner, Logger } from "./Utils.js";


dotenv.config();

const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://avalanche-mainnet.infura.io/v3/" + process.env.INFURA_API_KEY,
  ),
);

const jsonABI = JSON.parse(readFileSync("./abi/ZBTC.json")).abi;
const tokenContractAddress = "0x8a640bde38533b0A3918a65bfc68446204d29963";
const contract = new web3.eth.Contract(jsonABI, tokenContractAddress);

var signer = null;

async function __main() {
  if (process.argv[2] !== "--transfer" && process.argv[2] !== "--balance") {
    console.log("\x1b[31m Error! Expected --transfer, or --balance command \x1b[0m");
    process.exit(1);
  }
  const argv = minimist(process.argv.slice(2), { string:['to', 'address'], boolean: ['DEBUG']});
  Logger.enabled = argv.DEBUG === true;

  signer = await solveSigner(web3);
  if (signer == null || signer == false) {
    console.log("\x1b[41m ERROR \x1b[0m \x1b[31m Run 'node run.js --test' for details\x1b[0m");
    process.exitCode = 1;
    return;
  }

  // GET BALANCE
  if (argv.balance !== undefined) {
    let address;
    if (argv.address !== undefined && argv.address !== '') {
      if (!isAddress(argv.address)) {
        console.error("\x1b[41m ERROR \x1b[0m \x1b[31m Provided --address argument is not a valid Avalanche/Ethereum address! \x1b[0m");
        process.exit(1);
      }
      address = argv.address;
    } else {
      address = signer.address;
    }
    loadBalance(address);
    return;
  }
  
  // TRANSFER
  if (argv.transfer !== undefined) {
    if (argv.to === undefined || argv.amount === undefined) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[31m Expected --to and --amount arguments! \x1b[0m");
      process.exit(1);
    }
    let to;
    let amount = 0n;
    if (!isAddress(argv.to)) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[31m Provided --to argument is not a valid Avalanche/Ethereum address! \x1b[0m");
      process.exit(1);
    }
    to = argv.to;
    amount = web3.utils.toWei(argv.amount, "ether");
    transferTokens(to, amount);
  }
}

async function loadBalance(address) {
  const result = await contract.methods.balanceOf(address).call();
  console.log("Balance of %s: \x1b[33m%s ZBTC\x1b[0m", address, web3.utils.fromWei(result, 'ether'));
}
function transferTokens(to, amount) {
  console.log("\x1b[44m INIT TRANSFER \x1b[0m \x1b[33m%s ZBTC\x1b[0m from \x1b[36m%s\x1b[0m -> \x1b[36m%s\x1b[0m", web3.utils.fromWei(amount, 'ether'), signer.address, to);
  let service = new TransferTokens(contract, web3);
  service.transfer(to, amount);
}

__main();