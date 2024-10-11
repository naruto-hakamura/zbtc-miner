import dotenv from 'dotenv';
import minimist from "minimist";
import { Web3 } from "web3";
import { readFileSync } from 'node:fs';
import { StakeTokens } from "./BlockchainInteraction.js";
import { emitKeypressEvents } from "node:readline";
import { solveSigner, Logger, awaitKeyPress } from "./Utils.js";


dotenv.config();

const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://avalanche-mainnet.infura.io/v3/" + process.env.INFURA_API_KEY,
  ),
);

const jsonABI = JSON.parse(readFileSync("./abi/ZBTC.json")).abi;
const zbtcContractAddress = "0x8a640bde38533b0A3918a65bfc68446204d29963";
const contract = new web3.eth.Contract(jsonABI, zbtcContractAddress);

const jsonStakingABI = JSON.parse(readFileSync("./abi/Staking.json")).abi;
const stakingContractAddress = "0x8FE7Cf4D445905fFd6777A63da7857644a9240f3";
const stakingContract = new web3.eth.Contract(jsonStakingABI, stakingContractAddress);

var signer = null;

var stakeTokens = null;

async function __main() {
  if (process.argv[2] !== "--get" && process.argv[2] !== "--stake" && process.argv[2] !== "--withdraw") {
    console.log("\x1b[40m\x1b[31m Error! Expected --stake, --get or --withdraw command \x1b[0m");
    process.exit(1);
  }
  const argv = minimist(process.argv.slice(2), {boolean:['upfront', 'DEBUG'], string:['period', 'cliff']});
  Logger.enabled = argv.DEBUG === true;

  signer = await solveSigner(web3);
  if (signer == null || signer == false) {
    console.log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Run 'node run.js --test' for details\x1b[0m");
    process.exitCode = 1;
    return;
  }
  // get
  if (argv.get !== undefined) {
    getStake(argv.get);
    return;
  }

  // stake
  if (argv.stake !== undefined) {
    if (argv.stake !== true) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong arguments! Expected '--stake --amount [value] --period [value]' \x1b[0m");
      process.exitCode = 1;
      return;
    }
    // --amount and --period are mandatory
    if (argv.amount === undefined || argv.period === undefined) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Missing --amount or --period argument! \x1b[0m");
      process.exitCode = 1;
      return;
    }
    let amountWei = web3.utils.toWei(argv.amount, "ether");

    // --period
    let period = 360;
    if (argv.period !== undefined) {
      try {
        period = parseIntOrThrow(argv.period);
      } catch (error) {
        console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --period argument! Expected integer values only! \x1b[0m");
        process.exitCode = 1;
        return;
      }
    }

    // --cliff
    let cliff = 100;
    if (argv.cliff !== undefined) {
      try {
        cliff = parseIntOrThrow(argv.cliff);
      } catch (error) {
        console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --cliff argument! Expected integer values only! \x1b[0m");
        process.exitCode = 1;
        return;
      }
    }

    // --upfront
    let upfront = argv.upfront === true;
    
    stake(amountWei, period, upfront, cliff);
    return;
  }
  
  // withdraw
  if (argv.withdraw !== undefined) {
    withdraw(argv.withdraw);
    return;
  }
}

async function getStake (param) {
  if (typeof param == "boolean") {
    let ids = await stakingContract.methods.getStakingsIds(signer.address).call();
    console.log("ids:", ids);
    process.exitCode = 0;
    return;
  }
  if (typeof param == "number") {
    if (!Number.isInteger(param)) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --get argument! Expected integer values only! \x1b[0m");
      process.exitCode = 1;
      return;
    }
    let stakeData = await stakingContract.methods.getStake(param).call();
    console.log("stake:", stakeData);
    process.exitCode = 0;
    return;
  }
  console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --get argument! \x1b[0m");
}

function stake (amountWei, period, upfront, cliff) {
    stakeTokens = new StakeTokens(contract, web3);
    stakeTokens.once('interest-amount', async (interestAmountWei) => {
      let apr = Number(10_000n * interestAmountWei / BigInt(amountWei)) * 3.60 / period;
      apr = (Math.round(apr * 100) / 100).toFixed(2);
      console.log("InterestAmount: \x1b[33m%s ZBTC\x1b[0m (\x1b[36mAPR %s%\x1b[0m)", web3.utils.fromWei(interestAmountWei, 'ether'), apr);
      console.log("Press the [A] key to accept or any other key to quit");
      // waiting for keyboard input
      const key = await awaitKeyPress();
      if (key == 'a') {
        console.log("[a] pressed");
        console.log(amountWei, period, upfront, cliff, interestAmountWei);
        //stakeTokens.stake(amountWei, period, upfront, cliff, interestAmountWei);
        return;
      }
      process.exit(0);
    });
    stakeTokens.once('success', () => {
      console.log("\x1b[42m SUCCESS \x1b[0m");
      process.exit(1);
    });
    stakeTokens.once('error', () => {
      process.exit(1);
    });

    stakeTokens.getInterestAmount(amountWei, period, upfront, cliff);
}

async function withdraw (param) {
  let positions = [];
  if (typeof param == "boolean") {
    //do nothing
  } else if (typeof param == "number") {
    if (!Number.isInteger(param)) {
      console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --withdraw argument! Expected integer values only! \x1b[0m");
      process.exitCode = 1;
      return;
    }
    positions.push(param);
  } else {
    console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Wrong value for --withdraw argument! \x1b[0m");
  }
  console.log("proceeding...", positions);

  await loadBalance(signer.address, "BEFORE");

  stakeTokens = new StakeTokens(contract, web3);
  stakeTokens.once('success', async () => {
    console.log("\x1b[42m SUCCESS \x1b[0m");
    await loadBalance(signer.address, "AFTER");
    process.exit(0);
  });
  stakeTokens.once('error', () => {
    process.exit(1);
  });
  stakeTokens.withdraw(positions);
}

function parseIntOrThrow (stringNumber) {
  let result = false;
  result = parseInt(stringNumber);
  if (isNaN(result)) {
    throw new Error();
  }
  if (stringNumber !== '' + result.toString()) {
    throw new Error();
  }
  return result;
}

async function loadBalance(address, s) {
  const result = await contract.methods.balanceOf(address).call();
  console.log("Balance %s: \x1b[33m%s ZBTC\x1b[0m", s, web3.utils.fromWei(result, 'ether'));
}

__main();