import { soliditySha3 } from 'web3-utils';
import { writeFileSync, readFileSync } from "fs";
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createInterface } from "node:readline";
import { system, uuid } from 'systeminformation';
import { LocalStorage } from 'node-localstorage';
import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from 'crypto';


export class LocalSyncedTimestamp {
    static #_deltaSeconds = 0n;

    static sync (blockchainTimestamp) {
        this.#_deltaSeconds = 0n;
        this.#_deltaSeconds = blockchainTimestamp - this.getTimestamp();
        Logger.Log("Delta seconds:%s", this.#_deltaSeconds);
    }

    static getTimestamp () {
        return BigInt(Math.floor(Date.now() / 1000)) + this.#_deltaSeconds;
    }
}

export async function getUuid () {
    try {
        const data = await uuid();
        if (data.hardware != undefined || data.hardware != '') {
            return data.hardware;
        }
        if (data.os != undefined || data.os != '') {
            return data.os;
        }
        const sysinfo = await system();
        return sysinfo.serial || sysinfo.sku || "default-uuid";
    } catch (error) {
        return "default-uuid";
    }
}
export function awaitKeyPress () {
    return new Promise(resolve => {
        const wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once("data", (data) => {
            process.stdin.pause();
            process.stdin.setRawMode(wasRaw);
            resolve(data.toString().toLowerCase());
        });
    });
}

export async function solveSigner(web3) {
    let privateKey = null;
    let flag = false;
    if (process.env.SIGNER_PRIVATE_KEY !== undefined && process.env.SIGNER_PRIVATE_KEY !== '' && process.env.SIGNER_PRIVATE_KEY !== 'paste_here_your_private_key') {
        privateKey = process.env.SIGNER_PRIVATE_KEY;
        flag = true;
    } else {
        privateKey = await LocalVariable.getEncrypted("pkey");
        if (privateKey === undefined || privateKey === null || privateKey == '') {
            return false;
        }
    }
    try {
        if (privateKey.indexOf("0x") === -1) {
            privateKey = "0x" + privateKey;
        }
        let sgnr = web3.eth.accounts.privateKeyToAccount(privateKey);
        web3.eth.accounts.wallet.add(sgnr);
        return sgnr;
    } catch (error) {
        if (flag) {
            console.log("\x1b[41m FATAL ERROR \x1b[0m \x1b[31m Wrong SIGNER_PRIVATE_KEY in .env file! \x1b[0m"); 
        } else {
            console.log("\x1b[41m FATAL ERROR \x1b[0m \x1b[31m Wrong private key! Import your wallet again by running 'node run.js --wallet' \x1b[0m"); 
        }
        return null;
    }
}

export class WalletGenerator extends EventEmitter {
    #_wallet = null;
    #_words = [];
    constructor () {
        super();
    }

    getMnemonic () {
        return this.#_words.join(' ');
    }

    async waitForInstruction () {
        console.log('Press keyboard [G] to generate a new wallet or [I] to import an existing mnemonic phrase. Press [Q] to quit');
        const choice = await awaitKeyPress();
        if (choice === 'g') {
            this.emit('generate');
            return;
        }
        if (choice === 'i') {
            this.emit('import');
            return;
        }
        if (choice === 'q') {
            console.log("Exiting...");
            process.exitCode = 0;
        }
    }

    generate () {
        const entropy = ethers.randomBytes(16)
        const mnemonic = ethers.Mnemonic.fromEntropy(entropy);
        this.#_words = mnemonic.phrase.split(' ');
        this.#_wallet = ethers.Wallet.fromPhrase(mnemonic.phrase);
        this.emit('mnemonic', mnemonic);
    }

    async clearOnEnter (printMessage) {
        if (printMessage === true) {
            console.log("When you're done, press keyboard [C] to continue or [Q] to quit");
        }
        const choice = await awaitKeyPress();
        if (choice === 'c') {
            console.clear();
            this.emit('wait');
            return;
        }
        if (choice === 'q') {
            console.clear();
            console.log("Exiting...");
            process.exitCode = 0;
            return;
        }
        this.clearOnEnter();
    }

    listen () {
        let rl = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('> Words:', (value) => {
            rl.close();
            let words = value.split(' ');
            if (words[0] === this.#_words[0] && words[1] === this.#_words[2] && words[2] === this.#_words[6] && 
                words[3] === this.#_words[8] && words[4] === this.#_words[11]) {
                    this.emit('valid', this.#_wallet);
            } else {
                this.emit('invalid');
            }
        });
    }

    importWallet () {
        let rl = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('> Type in the 12 words mnemonic phrase:', (mnemonicPhrase) => {
            rl.close();
            try {
                this.#_wallet = ethers.Wallet.fromPhrase(mnemonicPhrase);
                console.log(this.#_wallet);
                console.log(this.#_wallet.privateKey);
                this.emit('success', this.#_wallet);
            } catch (error) {
                this.emit('error', error);
            }
        });
    }
}

export class KeyUtils {
    static getKeyLength (key) {
        let len = key.length - (key.split("-").length - 1);
        return len;
    }
    static getMaxWinnersForBlock (blockid) {
        const epoch = this.idToEpoch(blockid);
        if (epoch == 1 ) {
            return 7;
        } else if (epoch == 2 || epoch == 3) {
            return 6;
        } else if (epoch == 4 || epoch == 5) {
            return 5;
        } else if (epoch == 6 || epoch == 7) {
            return 4;
        } else if (epoch == 8 || epoch == 9) {
            return 3;
        } else if (epoch == 10 || epoch == 11) {
            return 2;
        }
        return 1;
    }
    static idToEpoch(blockid) {
        const blocksPerEpoch = 2584n;
        return (blockid + blocksPerEpoch - 1n) / blocksPerEpoch;
    }
}

export class LocalVariable {
    static #_initialised = false;
    static #_localStorage = new LocalStorage('./DO_NOT_SHARE');
    static #_algorithm = "aes-192-cbc";
    static #_useEncryption = false;
    static get(varName) {
        return this.#_localStorage.getItem(varName);
    }
    static set(varName, value) {
        this.#_localStorage.setItem(varName, value);
    }

    static async getEncrypted(varName) {
        await this.init();
        if (this.#_useEncryption == false) {
            return this.get(varName);
        }
        const encryptedValue = this.get(varName);
        if (encryptedValue == null) {
            return null;
        }
        const [encrypted, iv] = encryptedValue.split("|");
        if (!iv) throw new Error("IV not found");
        const uuid = await getUuid();
        try {
            const key = scryptSync(uuid, 'salt', 24);
            const decipher = createDecipheriv(this.#_algorithm, key, Buffer.from(iv, "hex"));
            return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
        } catch (error) {
            return null;
        }
    }

    static async setEncrypted(varName, value) {
        await this.init();
        if (this.#_useEncryption == false) {
            this.set(varName, value);
            return;
        }
        const iv = randomBytes(16);
        const uuid = await getUuid();
        const key = scryptSync(uuid, 'salt', 24);
        const cipher = createCipheriv(this.#_algorithm, key, iv);
        const encrypted = cipher.update(value, "utf8", "hex");
        const output = [encrypted + cipher.final("hex"), Buffer.from(iv).toString("hex")].join("|");
        this.set(varName, output);
    }

    static async init() {
        if (this.#_initialised == true) {
            return;
        }
        this.#_initialised = true;
        this.#_useEncryption = true;//force use encryption during init() test
        const now = new Date().toUTCString();
        try {
            await this.setEncrypted("launched", now);
            const res = await this.getEncrypted("launched");
            this.#_useEncryption = res == now;
        } catch (error) {
            this.#_useEncryption = false;
        }
        Logger.Log("LocalVariable.useEncryption =", this.#_useEncryption);
    }
}

export class LocalSeedStorage {
    static #_saveToLocalVariable = true;
    static loadSync () {
        try {
            let jsonSavedData = JSON.parse(readFileSync("./seedData.json"));
            return jsonSavedData;
        } catch (error) {
            return null;
        }
    }
    static saveSeed (blockid, address, difficulty, salt, seed){
        const localData = {};
        localData.keccak = soliditySha3(
            { type: 'uint256', value: blockid },
            { type: 'address', value: address },
            { type: 'uint256', value: difficulty },
            { type: 'string', value: salt });
        localData.seed = seed.toString();
        if (this.#_saveToLocalVariable === true) {
            LocalVariable.set("seed", JSON.stringify(localData, null, 2));
            return;
        }
        try {
            writeFileSync('./seedData.json', JSON.stringify(localData, null, 2));
        } catch (error) {
            console.log(error);
        }
    }
    static loadSeed(blockid, address, difficulty, salt) {
        let jsonData;
        if (this.#_saveToLocalVariable === true) {
            const seed = LocalVariable.get("seed");
            if (seed == null) {
                return 0n;
            }
            jsonData = JSON.parse(seed);
        } else {
            jsonData = this.loadSync();
        }
        Logger.Log("jsonData", jsonData);
        if (jsonData == null) {
            return 0n;
        }
        const keccak = soliditySha3(
            { type: 'uint256', value: blockid },
            { type: 'address', value: address },
            { type: 'uint256', value: difficulty },
            { type: 'string', value: salt });
        Logger.Log("keccak", keccak);
        if (jsonData.keccak === undefined || jsonData.keccak !== keccak) {
            return 0n;
        }
        return BigInt(jsonData.seed);
    }
}
export class Logger {
    static enabled = false;
   
    static Log (...args) {
        if (this.enabled) {
            console.log.apply(console, args);
        }
    }
}