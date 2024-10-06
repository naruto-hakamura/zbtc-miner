import { EventEmitter } from "events";
import { Worker } from "worker_threads";
import { numberToHex } from 'web3-utils';
import { Logger } from "./Utils.js";

export class ZMiner extends EventEmitter {
    #_address = '0x0';
    #_salt = '';
    #_difficulty = 0n;
    #_random = 0n;
    #_threads = 1n;
    #_seed = 0n;
    #_workers = [];
    #_hashLogs = [];
    #_hashrateInterval = false;

    constructor (address, salt, threads, seed, difficulty, random) {
        super();
        this.#_address = address;
        this.#_salt = salt;
        this.#_threads = threads;
        this.#_difficulty = difficulty;
        this.#_random = random;
        this.#_seed = seed;
    }
    
    run() {
        this.#_fireupWorkers();
        this.#_startHashrate();
    }

    updateDifficulty (p_newDifficulty) {
        if (p_newDifficulty <= this.#_difficulty) {
            return;
        }
        this.#_terminateAllWorkers();
        this.#_seed = 0n;
        this.#_difficulty = p_newDifficulty;
        this.#_fireupWorkers();
    }    
    
    #_fireupWorkers() {
        for (let i = 0; i < this.#_threads; ++i) {
            this.#_startWorker(i);
        }
        this.emit('mining-started', this.#_difficulty);
    }
    #_startWorker(idx) {
        const w = this.#_createWorker(idx);
        const miningData = this.#_genMiningData();
        miningData.code = 3;
        this.#_workers[idx] = w;
        w.postMessage(miningData);
        Logger.Log(miningData);
    }
    #_createWorker(idx) {
        Logger.Log("createWorker ", idx);
        const worker = new Worker('./ZWorker.js', { workerData: null });
        worker.on('message', (data) => {
            if (data.code == 100) {
                let miningData = this.#_genMiningData();
                miningData.code = 3;
                worker.postMessage(miningData);
                return;
            }
            if (data.code == 200) {
                Logger.Log('key-found', data);
                this.emit('key-found', {address:data.address, key:data.key, salt:data.salt});
                return;
            }
            if (data.code == 210) {
                this.#_hashLogs.push({ts:data.ts, hashCount:data.hashCount});
                return;
            }
        });
        worker.on('exit', (exitCode) => {
            Logger.Log("worker exit code", exitCode);
        });
        worker.on('error', (error) => {
            Logger.Log(error);
            this.#_startWorker(idx);
        });
        return worker;
    }
    #_genMiningData() {
        const n = 16n**BigInt(this.#_difficulty);
        const delta = n / this.#_threads;
        const i = this.#_seed % this.#_threads;
        const num0 = delta * i;
        const num1 = i == this.#_threads - 1n ? n - 1n : num0 - 1n + delta;
        let salt = this.#_salt;
        if (this.#_seed > 0n) {
            salt = (this.#_salt == '' ? '' : this.#_salt  + '-') + numberToHex((this.#_seed-1n) / this.#_threads).slice(2);
        }
        ++this.#_seed;
        if (this.#_seed % this.#_threads == 0) {
            this.emit('save-json', this.#_seed);
        }
        return {difficulty:this.#_difficulty, random:this.#_random, address:this.#_address, num0:num0, num1:num1, salt:salt};
    }

    #_getHashRate () {
        const now = Date.now();
        while (this.#_hashLogs.length > 0 && this.#_hashLogs[0].ts < now - 60_000) {
            this.#_hashLogs.shift();
        }
        const dt = BigInt(now - this.#_hashLogs[0].ts);
        if (dt < 10_000n) {
            return null;
        }
        let hashCount = 0n;
        for (let i = 0; i < this.#_hashLogs.length; ++i) {
            hashCount += this.#_hashLogs[i].hashCount;
        }
        const hps = 1000n * hashCount / dt;
        return hps;
    }
    
    #_startHashrate () {
        Logger.Log(">>>>> START HASHRATE()");
        let count = 0;
        let t = '';
        let symbols = ['/', '-', '\\'];
        const regex = /z/gi;
        t = t + "(z)".repeat(Number(this.#_threads));
        this.#_hashrateInterval = setInterval(() => {
            const hps = this.#_getHashRate();
            if (hps == null) {
                process.stdout.write("[HRATE] " + t.replaceAll(regex, symbols[++count%3]) + " Hrate: \x1b[33m---\x1b[0m H/s");
                return;
            }
            process.stdout.write("[HRATE] " + t.replaceAll(regex, symbols[++count%3]) + " Hrate: \x1b[33m" + hps.toLocaleString() + "\x1b[0m H/s");
        }, 1000);
    }

    #_terminateAllWorkers() {
        this.#_workers.forEach((w) => {
            if (w !== undefined && w !== null) {
                w.terminate();
            }
        });
        this.#_workers.length = 0;
    }
    
    terminate () {
        this.#_terminateAllWorkers();
        if (this.#_hashrateInterval != false) {
            clearInterval(this.#_hashrateInterval);
            this.#_hashrateInterval = false;
        }
    }
}