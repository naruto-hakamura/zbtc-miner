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

var isAirdropMining = false;
const airdropEndDate = '2024-12-01T00:00:00';

const MIN_DIFFICULTY = 5;//todo - put 8

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
        await setupWallet();
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
    currentBlockLoader.on('new-block-loaded', async (newBlockData) => {
        Logger.Log("currentBlockLoader.on - new-block-loaded", newBlockData);
        if (isAirdropMining && argDifficulty < 9) {
            try {
                const airdropData = LocalVariable.get('airdrop');
                Logger.Log('airdropData:', airdropData);
                if (airdropData == 'nov24') {
                    Logger.Log("Increase difficulty for airdrop");
                    argDifficulty = 9;
                }
            } catch(error) {}
        }
        timingCtrl.setNewBlock(newBlockData);
    });
    currentBlockLoader.on('block-updated', (currBlockData) => {
        Logger.Log("currentBlockLoader.on - block-updated", currBlockData);
        timingCtrl.updateBlock(currBlockData);
        if (_zMinerCtrl != null) {
            _zMinerCtrl.updateBlock(currBlockData);
        }
        if (currBlockData.winnerscnt === 1n) {
            reloadAndPrintZbtcBalance();// reload ZBTC balance
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
            if (isAirdropMining) {
                console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[33m 0 AVAX for address %s \x1b[0m", signer.address);
                console.log("\x1b[40m\x1b[33m OPTION 1. Get free AVAX for mining by sending me on X/Twitter a screenshot of this window (https://x.com/naruto_hakamura) \x1b[0m");
                console.log("\x1b[40m\x1b[33m OPTION 2. Consider sending from MetaMask/Binance/etc at least 0.05 AVAX (Avalanche C Chain) to your address to start mining \x1b[0m");
            } else {
                console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[33m 0 AVAX for address %s. Consider depositing some AVAX (Avalanche C Chain) to your address to start mining! \x1b[0m", signer.address);
            }
            process.exit(1);
        }
        signerAvaxAmount = avaxAmount;
        loadTimestamp();
        reloadAndPrintZbtcBalance();
    });
    avaxBalanceGetter.on('error', (error) => {
        if (error instanceof ConnectionNotOpenError) {
            console.log("\x1b[33m Connection not open! No internet connection or wrong Infura Api Key! \x1b[0m");
        } else {
            console.log(error);
        }
        process.exit(1);
    });
    avaxBalanceGetter.get(signer.address);
}
async function reloadAndPrintZbtcBalance() {
    const balance = await loadZbtcBalance(argAddress);
    if (balance !== null) {
        console.log("Your Balance is \x1b[33m%s ZBTC\x1b[0m", web3.utils.fromWei(balance, 'ether'));
    }
}
async function loadZbtcBalance(address) {
    try {
        const result = await tokenContract.methods.balanceOf(address).call();
        return result;
    } catch (error) {
        Logger.Log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[33m Cannot load ZBTC balance \x1b[0m");
        return null;
    }
}

function loadTimestamp () {
    const _blockchainTimestampGetter = new BlockchainTimestampGetter(web3);
    _blockchainTimestampGetter.on('loaded', (timestamp) => {
        _blockchainTimestampGetter.removeAllListeners();
        if (isAirdropMining && timestamp > BigInt(Date.parse(airdropEndDate)/1000)) {
            console.log("\x1b[33m Airdrop not available! Type 'node run.js --mine' instead! \x1b[0m");
            process.exit(1);
        }
        LocalSyncedTimestamp.sync(timestamp);
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
    _keySubmitter.on('fatal', async (error) => {
        console.log("\x1b[41m Fatal error %s \x1b[0m Check the AVAX balance of %s", error.code, signer.address);
        process.exit(1);
    });
    _keySubmitter.on('key-posted', (data) => {
        console.log("\x1b[42m KEY VALIDATED \x1b[0m\x1b[36m %s\x1b[0m [%s]", data.key, new Date().toLocaleString());
        _zMinerCtrl.incrementDifficulty();
        if (isAirdropMining) {
            console.log("\x1b[42m YOU ARE ELIGIBLE FOR THE AIRDROP. KEEP MINING! \x1b[0m");
            try {
                LocalVariable.set('airdrop', 'nov24');
            } catch (error){}
        }
    });
    _keySubmitter.on('out-of-gas', () => {
        console.log("\x1b[41m OUT OF GAS \x1b[0m \x1b[41m Deposit some AVAX to your address %s \x1b[0m", signer.address);
        process.exit(1);
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
        //_keySubmitter.updateBalance(signerAvaxAmount);
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
            console.clear();
            if (isAirdropMining) {
                console.log("\x1b[42m SUCCESS \x1b[0m Type again 'node run.js --airdrop' to proceed to the next step");
            } else {
                console.log("\x1b[42m SUCCESS \x1b[0m Type 'node run.js --test' to proceed to the next step");
            }
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
            console.clear();
            console.log("\x1b[42m SUCCESS \x1b[0m Run 'node run.js --test' to proceed to the next step");
            await LocalVariable.setEncrypted("pkey", wallet.privateKey);
            process.exitCode = 0;
        });
        walletGen.once('error', (error) => {
            console.clear();
            console.log("\x1b[41m ERROR \x1b[0m \x1b[33m %s %s \x1b[0m", error.code || '', error.shortMessage || '');
            console.log("Type 'node run.js --wallet' to restart the wallet import process")
            process.exitCode = 1;
        });
    });
    if (isAirdropMining) {
        console.clear();
        setTimeout(() => {
            walletGen.emit('generate');
        }, 0);
    }
}
async function setupWallet() {
    if (isAirdropMining) {
        console.log("\x1b[36m=== AIRDROP COMPETITION ===\x1b[0m");
        console.log("\x1b[33m In order to join the airdop you need to setup a wallet first! Press keyboard [W] to continue or press keyboard [Q] to quit\x1b[0m");
    } else {
        console.log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[31m No wallet found and SIGNER_PRIVATE_KEY not set in .env file! \x1b[0m");
        console.log("\x1b[33m Option 1: Press keyboard [W] to start the wallet setup (recommended) \x1b[0m");
        console.log("\x1b[33m Option 2: Press keyboard [I] to learn how to import a private key (for advanced users) \x1b[0m");
        console.log("or press keyboard [Q] to quit");
    }
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
            console.log("\x1b[42m TEST SUCCESSFULL \x1b[0m type \x1b[36mnode run.js --mine\x1b[0m or \x1b[36mnode run.js --airdrop\x1b[0m to start mining");
        } else {            
            console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[33m 0 AVAX for address %s. Consider depositing some AVAX (Avalanche C Chain) to your address to start mining! \x1b[0m", signer.address);
        }
        process.exit(0);
    });
    avaxBalanceGetter.on('error', (error) => {
        if (error instanceof ConnectionNotOpenError) {
            console.log("\x1b[41m TEST FAILED \x1b[0m \x1b[40m\x1b[33m No internet connection or wrong Infura Api Key! \x1b[0m");
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
    if (process.argv[2] !== "--airdrop" && process.argv[2] !== "--mine" && process.argv[2] !== "--seal" && process.argv[2] !== "--test" && process.argv[2] !== "--wallet") {
        console.log("\x1b[40m\x1b[31m Error! Expected --mine, --seal, --test or --wallet command \x1b[0m");
        return false;
    }
    const argv = minimist(process.argv.slice(2), { string: ['address', 'salt'], boolean: ['DEBUG']});
    Logger.enabled = argv.DEBUG === true;

    switch (process.argv[2]) {
        case "--test":
            argTest = true;
            return true;
        case "--wallet":
            argWallet = true;
            return true;

        case "--mine":
        case "--airdrop":
            isAirdropMining = process.argv[2] === '--airdrop';
            if (isAirdropMining && Date.now() > Date.parse(airdropEndDate)) {
                console.log("\x1b[33m Airdrop not available! Type 'node run.js --mine' instead! \x1b[0m");
                process.exit(1);
            }
            // --difficulty
            if (argv.difficulty === undefined) {
                argDifficulty = MIN_DIFFICULTY;
            } else {
                argDifficulty = parseInt(argv.difficulty);
                if (argDifficulty < MIN_DIFFICULTY) {
                    console.log("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[33m Difficulty too low! Min difficulty is 8 \x1b[0m");
                    return false;
                }
            }
            // --address
            if (argv.address !== undefined && argv.address !== "") {
                if (!isAddress(argv.address)) {
                    console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[33m Provided --address argument is not a valid Avalanche/Ethereum address! \x1b[0m");
                    return false;
                }
                argAddress = argv.address;
            }
            // --salt
            if (argv.salt !== undefined) {
                if (isAirdropMining === true) {
                    console.error("\x1b[41m ERROR \x1b[0m \x1b[40m\x1b[33m You cannot set a salt while airdrop mining! \x1b[0m");
                    return false;
                }
                argSalt = argv.salt;
                if (!isValidSalt(argSalt)) {
                    console.log("\x1b[41m ERROR \x1b[0m \x1b[33m Provided --salt phase is invalid! \x1b[0m");
                    return false;
                }
            }
            if (isAirdropMining === true) {
                argSalt = 'air';
            }
            // --threads
            const cpuCnt = BigInt(cpus().length);
            if (argv.threads === undefined) {
                argThreads = cpuCnt / 2n;
            } else if (argv.threads === 0) {
                argThreads = cpuCnt;//max available threads
            } else {
                try {
                    argThreads = BigInt(argv.threads);
                } catch (error) {
                    console.log("\x1b[41m ERROR \x1b[0m \x1b[33m Provided --threads argument is not a valid number! \x1b[0m");
                    return false;
                }
                if (argThreads > cpuCnt) {
                    console.log("\x1b[41m ERROR \x1b[0m Max %o threads allowed!", Number(cpuCnt));
                    return false;
                }
            }
            return true;

        case "--seal":
            let blockId = false;
            try {
                blockId = parseInt(argv.seal);
            } catch (error) {
                console.log("\x1b[40m\x1b[33m Seal Error! \x1b[0m");
                process.exit(1);
            }
            if (isNaN(blockId)) {
                console.log("\x1b[40m\x1b[33m Error: Seal is not a number! \x1b[0m");
                process.exit(1);
            }
            argSealBlockId = blockId;
            return true;
    }
    return false;

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
        argThreads = cpuCnt / 2n;
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