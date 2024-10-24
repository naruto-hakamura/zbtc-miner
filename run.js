import dotenv from 'dotenv';
import minimist from "minimist";
import { Web3, ConnectionNotOpenError } from "web3";
import { isAddress } from "web3-validator";
import { cpus } from 'node:os';
import { readFileSync } from "node:fs";
import { CurrentBlockLoader } from './BlockLoader.js';
import { ZMinerController } from './ZMinerController.js';
import { AvaxBalanceGetter, BlockchainTimestampGetter, KeySubmitter, BlockSealer } from "./BlockchainInteraction.js";
import { LocalSyncedTimestamp, LocalVariable, Logger, WalletGenerator, solveSigner, awaitKeyPress } from "./Utils.js";
import { TimingController } from "./TimingController.js";
import { emitKeypressEvents } from "node:readline";

dotenv.config();

const web3 = new Web3(
    new Web3.providers.HttpProvider(
        "https://avalanche-mainnet.infura.io/v3/" + process.env.INFURA_API_KEY        
    )
);

var signer = null;
var signerAvaxAmount = 0n;

// token contract
const tokenContractAddress = "0x8a640bde38533b0A3918a65bfc68446204d29963";
const tokenAbi = JSON.parse(readFileSync("./abi/ZBTC.json")).abi;
const tokenContract = new web3.eth.Contract(tokenAbi, tokenContractAddress);

const miningContractAddress = "0x4d52288Fd12CB8Ce68D7485Bf29970B4Dc84E0c4";
const miningAbi = JSON.parse(readFileSync("./abi/Mining.json")).abi;
//const miningContract = new web3.eth.Contract(miningAbi, miningContractAddress);

const currentBlockLoader = new CurrentBlockLoader(tokenContract);

const avaxBalanceGetter = new AvaxBalanceGetter(web3);

const timingCtrl = new TimingController();
var _zMinerCtrl = null;

var _keySubmitter = null;

var argAddress = false;
var argThreads;
var argDifficulty;
var argSalt = "";
var argTest = false;
var argSealBlockId = false;
var argWallet = false;

const MIN_DIFFICULTY = 8;

async function __main() {
    if (processArgv() === false) {
        process.exitCode = 1;
        return;
    }
    //> wallet
    if (argWallet === true) {
        launchWalletService();
        return;
    }
    //> signer
    signer = await solveSigner(web3);
    if (signer === false) {
        const x = await setupWallet();
        return;
    }
    if (signer === null) {
        process.exitCode = 1;
        return;
    }
    //> test
    if (argTest === true) {
        runTest();
        return;
    }
    //> seal
    if (argSealBlockId !== false) {
        let blockSealer = new BlockSealer(tokenContract, web3);
        blockSealer.sealBlock(argSealBlockId);
        return;
    }
    //> extract address from signer
    if (argAddress === false) {
        argAddress = signer.address;
    }
    onSIGINT();

    // >timing controller
    timingCtrl.on('run', (blockid) => {
        Logger.Log("timingController.on - run");
        createZMinerController(timingCtrl.getCurrentBlock());
        createKeySubmitter();
        console.log(">>> Mining started for block \x1b[44m %i \x1b[0m ", Number(blockid));
    });
    timingCtrl.on('stop', (blockid) => {
        Logger.Log("timingController.on - stop");
        destroyKeySubmitter();
        killZMinerController();
    });
    timingCtrl.on('load-next-block', (blockid) => {
        Logger.Log("timingController.on - load-next-block");
        currentBlockLoader.loadCurrentBlock(blockid);
    });

    // >current block loader subscriptions
    currentBlockLoader.on('new-block-loaded', (newBlockData) => {
        Logger.Log("currentBlockLoader.on - new-block-loaded", newBlockData);
        timingCtrl.setNewBlock(newBlockData);
    });
    currentBlockLoader.on('block-updated', (currBlockData) => {
        Logger.Log("currentBlockLoader.on - block-updated", currBlockData);
        timingCtrl.updateBlock(currBlockData);
        if (_zMinerCtrl != null) {
            _zMinerCtrl.updateBlock(currBlockData);
        }
    });
    currentBlockLoader.on('error', (error) => {
        console.log(error);
        process.exit(1);
    });

    // >signer avax balance
    avaxBalanceGetter.once('loaded', (avaxAmount) => {
        avaxBalanceGetter.removeAllListeners();
        Logger.Log("AVAX Balance:%o", avaxAmount);
        if (avaxAmount == 0n) {
            console.log("\x1b[41m ERROR \x1b[0m \x1b[31m 0 AVAX for address %s. Consider deposit some AVAX (Avalanche C Chain) to your address to start mining! \x1b[0m", signer.address);
            process.exit(1);
            return;
        }
        signerAvaxAmount = avaxAmount;
        loadTimestamp();
    });
    avaxBalanceGetter.on('error', (error) => {
        if (error instanceof ConnectionNotOpenError) {
            console.log("\x1b[31m Connection not open! No internet connection or wrong Infura Api Key! \x1b[0m");
        } else {
            console.log(error);
        }
        process.exit(1);
    });
    avaxBalanceGetter.get(signer.address);
}

function loadTimestamp () {
    const _blockchainTimestampGetter = new BlockchainTimestampGetter(web3);
    _blockchainTimestampGetter.on('loaded', (data) => {
        _blockchainTimestampGetter.removeAllListeners();
        LocalSyncedTimestamp.sync(data);
        Logger.Log("Local timestamp:%o", LocalSyncedTimestamp.getTimestamp());
        currentBlockLoader.loadCurrentBlock(0n);
    });
    _blockchainTimestampGetter.on('error', (error) => {
        console.log(error);
        process.exit(1);
    });
    _blockchainTimestampGetter.get();
}

function destroyKeySubmitter () {
    if (_keySubmitter === null) {
        return;
    }
    _keySubmitter.dispose();
    _keySubmitter.removeAllListeners();
}

function createKeySubmitter () {
    destroyKeySubmitter();
    _keySubmitter = new KeySubmitter(tokenContract, web3);
    _keySubmitter.on('fatal', error => {
        console.log("Fatal error:", error);
        process.exit(1);
    });
    _keySubmitter.on('key-posted', (data) => {
        console.log("\x1b[42m KEY VALIDATED \x1b[0m\x1b[36m %s\x1b[0m [%s]", data.key, new Date().toLocaleString());
        _zMinerCtrl.incrementDifficulty();
    });
    _keySubmitter.on('out-of-gas', () => {
        console.log("\x1b[41m OUT OF GAS \x1b[0m \x1b[41m Deposit some AVAX to your address %s \x1b[0m", signer.address);
        process.exit(1);
    });
    _keySubmitter.on('avax-used', avaxUsedAmount => {
        if (avaxUsedAmount > 0n) {
            signerAvaxAmount -= avaxUsedAmount;
            _keySubmitter.updateBalance(signerAvaxAmount);
        } else {
            avaxBalanceGetter.once('loaded', amount => {
                signerAvaxAmount = amount;
                Logger.Log("AVAX Balance:%o", signerAvaxAmount);
                if (_keySubmitter != null) {
                    _keySubmitter.updateBalance(signerAvaxAmount);
                }
            });
            avaxBalanceGetter.get(signer.address);
        }
    });
    _keySubmitter.on("DIFFICULTY_LOW", () => {
        Logger.Log("+++DIFFICULTY_LOW");
        destroyKeySubmitter();
        killZMinerController();
        currentBlockLoader.loadCurrentBlock(0n);
    });
}

function createZMinerController (p_currentBlock) {
    killZMinerController();
    _zMinerCtrl = new ZMinerController(p_currentBlock, argDifficulty, argAddress, argSalt, argThreads, miningAbi, miningContractAddress, process.env.INFURA_API_KEY);
    _zMinerCtrl.on('key-found', (keyData) => {
        Logger.Log("KEY::%o", keyData);
        _keySubmitter.updateBalance(signerAvaxAmount);
        _keySubmitter.postKey(keyData);
    });
    _zMinerCtrl.on('reload-block', () => {
        Logger.Log("_zMinerCtrl.on - reload-block");
        currentBlockLoader.loadCurrentBlock(0n);
    });
}

function killZMinerController () {
    if (_zMinerCtrl != null) {
        Logger.Log(">>> killZMinerController()");
        _zMinerCtrl.removeAllListeners();
        try {
            _zMinerCtrl.terminate();
        } catch (error) {
            process.exit(1);
        }
    }
    _zMinerCtrl = null;
}

function launchWalletService() {
    let walletGen = new WalletGenerator();
    walletGen.waitForInstruction();
    walletGen.once('generate', () => {
        console.log("\x1b[33m=== GENERATE WALLET ===\x1b[0m");
        walletGen.once('mnemonic', (mnemonic) => {
            console.log("\x1b[42m SUCCESS \x1b[0m Your mnemonic phrase is:\x1b[40m\x1b[32m %s \x1b[0m", mnemonic.phrase);
            console.log("\x1b[44m IMPORTANT \x1b[0m The mnemonic is the only way you can recover your wallet! Write the mnemonic phrase down on a piece of paper, keep it in a safe place and DO NOT SHARE with anyone!")
            walletGen.clearOnEnter(true);
        });
        walletGen.on('wait', () => {
            console.log("\x1b[44m Mnemonic phrase validation \x1b[0m Type the 1st, 3rd, 7th, 9th and 12th words of your mnemonic phrase separated by blank spaces and press [Enter]");
            console.log("Eg: word1 word3 word7 word9 word12");
            walletGen.listen();
        });
        walletGen.once('valid', async (wallet) => {
            console.log("\x1b[42m SUCCESS \x1b[0m Run 'node run.js --test' to proceed to the next step");
            await LocalVariable.setEncrypted("pkey", wallet.privateKey);
            process.exitCode = 0;
        });
        walletGen.on('invalid', () => {
            console.log('\x1b[31m Wrong words!\x1b[0m Your mnemonic phrase is:\x1b[32m %s \x1b[0m', walletGen.getMnemonic());
            console.log("Write the mnemonic down on a piece of paper, keep it in a safe place and DO NOT SHARE with anyone!")
            walletGen.clearOnEnter(true);
        });
        walletGen.generate();
    });
    walletGen.once('import', () => {
        console.log("\x1b[33m=== IMPORT WALLET ===\x1b[0m");
        walletGen.importWallet();
        walletGen.once('success', async (wallet) => {
            console.log("\x1b[42m SUCCESS \x1b[0m Run 'node run.js --test' to proceed to the next step");
            await LocalVariable.setEncrypted("pkey", wallet.privateKey);
            process.exitCode = 0;
        });
        walletGen.once('error', (error) => {
            console.log("\x1b[31m ERROR %s %s \x1b[0m", error.code || '', error.shortMessage || '');
            process.exitCode = 1;
        });
    });
}
async function setupWallet() {
    console.log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m No wallet found and SIGNER_PRIVATE_KEY not set in .env file! \x1b[0m");
    console.log("\x1b[33m Option 1: Press keyboard [W] to start the wallet setup (recommended) \x1b[0m");
    console.log("\x1b[33m Option 2: Press keyboard [I] to learn how to import a private key (for advanced users) \x1b[0m");
    console.log("or press keyboard [Q] to quit");
    while(true) {
        const key = await awaitKeyPress();
        if (key === 'w') {
            console.clear();
            console.log("\x1b[33m=== WALLET SETUP ===\x1b[0m");
            launchWalletService();
            return true;
        }
        if (key === 'i') {
            console.clear();
            console.log("\x1b[33m=== IMPORT PRIVATE KEY ===\x1b[0m");
            console.log("Step 1: Retrieve your private key from Metamask");
            console.log('Step 2: Open the .env file and paste the private key \x1b[33mSIGNER_PRIVATE_KEY = "paste_here_your_private_key"\x1b[0m');
            console.log("Step 3: Switch back to PowerShell/Terminal and run again 'node run.js --test'");
            return false;
        }
        if (key === 'q') {
            return false;
        }
    }
}

function runTest() {
    console.log("\x1b[36m TEST STARTED (this may take up to 1 minute) \x1b[0m");

    avaxBalanceGetter.on('loaded', (avaxAmount) => {
        Logger.Log("AVAX Balance:%o", avaxAmount);
        console.log("\x1b[36m BLOCKCHAIN CONNECTION ESTABLISHED! wait... \x1b[0m");
        console.log(" Your public address is:", signer.address);
        if (avaxAmount > 0n) {
            console.log("\x1b[42m TEST SUCCESSFULL \x1b[0m type \x1b[36mnode run.js --mine\x1b[0m to start mining");
        } else {
            console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[31m 0 AVAX for address %s. Consider deposit some AVAX (Avalanche C Chain) to your address to start mining! \x1b[0m", signer.address);
        }
        process.exit(0);
        
    });
    avaxBalanceGetter.on('error', (error) => {
        if (error instanceof ConnectionNotOpenError) {
            console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[31m No internet connection or wrong Infura Api Key! \x1b[0m");
        } else {
            console.log("\x1b[41m TEST FAILED \x1b[0m");
        }
        process.exit(1);
    });
    avaxBalanceGetter.get(signer.address);
}

function isValidSalt(salt){
    for (let i = 0; i < salt.length; i++) {
        if (salt.charCodeAt(i) < 32 || salt.charCodeAt(i) > 125) {
            return false;
        }
    }
    return true;
}
function processArgv() {
    if (process.argv[2] !== "--mine" && process.argv[2] !== "--seal" && process.argv[2] !== "--test" && process.argv[2] !== "--wallet") {
        console.log("\x1b[40m\x1b[31m Error! Expected --mine, --seal, --test or --wallet command \x1b[0m");
        return false;
    }
    const argv = minimist(process.argv.slice(2), { string: ['address', 'salt'], boolean: ['DEBUG']});
    Logger.enabled = argv.DEBUG === true;

    // --seal
    if (argv.seal !== undefined) {
        let blockId = false;
        try {
            blockId = parseInt(argv.seal);
        } catch (error) {
            console.log("\x1b[40m\x1b[31m Seal Error! \x1b[0m");
            process.exit(1);
        }
        if (isNaN(blockId)) {
            console.log("\x1b[40m\x1b[31m Error: Seal is not a number! \x1b[0m");
            process.exit(1);
        }
        argSealBlockId = blockId;
        return true;
    }
    // --gen
    if (argv.wallet !== undefined) {
        argWallet = true;
        return true;
    }
    // --test
    if (argv.test !== undefined) {
        argTest = true;
        return true;
    }
    // --difficulty
    if (argv.difficulty === undefined) {
        argDifficulty = MIN_DIFFICULTY;
    } else {
        argDifficulty = parseInt(argv.difficulty);
        if (argDifficulty < MIN_DIFFICULTY) {
            console.log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Difficulty too low \x1b[0m");
            return false;
        }
    }
    // --address
    if (argv.address !== undefined && argv.address !== "") {
        if (!isAddress(argv.address)) {
            console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m Provided --address argument is not a valid Avalanche/Ethereum address! \x1b[0m");
            return false;
        }
        argAddress = argv.address;
    }
    // --salt
    if (argv.salt !== undefined) {
        argSalt = argv.salt;
        if (!isValidSalt(argSalt)) {
            console.log("\x1b[41m ERROR \x1b[0m \x1b[31m Provided --salt phase is invalid! \x1b[0m");
            return false;
        }
    }
    // --threads
    const cpuCnt = BigInt(cpus().length);
    if (argv.threads === undefined) {
        argThreads = 1n;
    } else if (argv.threads === 0) {
        argThreads = cpuCnt;
    } else {
        try {
            argThreads = BigInt(argv.threads);
        } catch (error) {
            console.log("\x1b[41m FATAL ERROR \x1b[0m \x1b[31m Provided --threads argument is not a valid number! \x1b[0m");
            return false;
        }
        if (argThreads > cpuCnt) {
            console.log("Max %o threads allowed", Number(cpuCnt));
            return false;
        }
    }
    return true;
}

function onSIGINT() {
    emitKeypressEvents(process.stdin);

    if (process.stdin.isTTY)
        process.stdin.setRawMode(true);

    process.stdin.on('keypress', (chunk, key) => {
        if (key && key.name == 'q') {
            console.log("Quitting...");
            process.exit(0);
        }
    });
    console.log("Launched. Press [Q] to quit")
    
    const originalWrite = process.stdout.write;
    let flag = false;
    let maxLogLen = 0;

    process.stdout.write = (data, callback) => {
        let logIsHrate = (typeof data == 'string' && data.substring(0, 7) == '[HRATE]');
        if (flag === true) {
            flag = false;
            process.stdout.cursorTo(0);
            if (logIsHrate == false) {
                process.stdout.clearLine(1);
            }
        }
        if (logIsHrate) {
            flag = true;
            data = data.substring(7);
            if (data.length < maxLogLen) {
                data += " ".repeat(maxLogLen-data.length);
            }
            maxLogLen = data.length;
        }
        originalWrite.apply(process.stdout, [data, callback]);
    };
}

__main();