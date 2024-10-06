import { EventEmitter } from "events";
import { ZMiner } from "./ZMiner.js";
import { KeyValidatedEvent } from "./BlockchainEvent.js";
import { KeyUtils, Logger, LocalSeedStorage } from "./Utils.js";

export class ZMinerController extends EventEmitter {

    #_zMiner = null;
    #_minerRunning = false;
    #_currentBlock = null;
    #_currentMiningDifficulty = 0;
    #_address = '0x0';
    #_salt = '';
    #_threads = 0n;

    #_keyValidatedEvent = null;

    IncreaseDiffDebug () {
        this.#_zMiner.updateDifficulty(10);
    }

    constructor(p_currBlock, p_difficulty, p_address, p_salt, p_threads, p_miningContractAbi, p_miningContractAddress, p_infuraApiKey) {
        super();
        this.#_currentBlock = p_currBlock;
        this.#_currentMiningDifficulty = p_difficulty;
        this.#_processCurrentDifficulty();
        this.#_address = p_address;
        this.#_salt = p_salt;
        this.#_threads = p_threads;
        this.#_keyValidatedEvent = new KeyValidatedEvent(p_miningContractAbi, p_miningContractAddress, p_infuraApiKey);
        const seed = LocalSeedStorage.loadSeed(this.#_currentBlock.id, this.#_address, this.#_currentMiningDifficulty, this.#_salt);
        this.#_runMiner(seed);
    }
    
    #_createZMiner (p_seed) {
        if (this.#_zMiner != null) {
            killZMiner();
        }
        this.#_zMiner = new ZMiner(this.#_address, this.#_salt, this.#_threads, p_seed, this.#_currentMiningDifficulty, this.#_currentBlock.random);
        this.#_zMiner.on('key-found', keyData => {
            this.emit('key-found', keyData);
        });
        this.#_zMiner.on('save-json', seed => {
            LocalSeedStorage.saveSeed(this.#_currentBlock.id, this.#_address, this.#_currentMiningDifficulty, this.#_salt, seed);
        });
        this.#_zMiner.on('mining-started', difficulty => {
            this.emit('mining-started', difficulty);
            Logger.Log("mining-started diff:%o", difficulty);
        });
        this.#_zMiner.run();
    }
    #_killZMiner () {
        if (this.#_zMiner == null) {
            return;
        }
        try {
            this.#_zMiner.removeAllListeners();
            this.#_zMiner.terminate();
        } catch (error) { }
        this.#_zMiner = null;
    }

    updateBlock(p_currentBlock) {
        this.#_currentBlock = p_currentBlock;
        this.#_processCurrentDifficulty();
        this.#_runMiner();
    }

    #_runMiner (p_seed) {
        if (this.#_minerRunning == false) {
            this.#_minerRunning = true;
            this.#_createZMiner(p_seed);
            this.#_registerKeyValidatedEvent();// listen for contract's "KeyValidated" event
        } else {
            this.#_zMiner.updateDifficulty(this.#_currentMiningDifficulty);
        }
    }
    #_stopMiner () {
        if (this.#_minerRunning == false) {
            return;
        }
        this.#_minerRunning = false;
        this.#_keyValidatedEvent.removeAllListeners();
        this.#_keyValidatedEvent.terminate();
        this.#_killZMiner();
    }

    #_registerKeyValidatedEvent () {
        this.#_keyValidatedEvent.on('key-validated', (data) => {
            if (data.blockid != this.#_currentBlock.id) {
                this.emit('non-fatal');
                return;
            }
            this.#_currentBlock.winnerscnt++;
            const keyDifficulty = KeyUtils.getKeyLength(data.key);
            if (keyDifficulty > this.#_currentBlock.difficulty) {
                this.#_currentBlock.difficulty = keyDifficulty;
                this.#_currentBlock.winnerscnt = 1;
            }
            this.#_processCurrentDifficulty();
            this.#_zMiner.updateDifficulty(this.#_currentMiningDifficulty);
            if (this.#_currentBlock.deadline == 0) {
                this.emit('reload-block');//reload the current block to get the block's deadline
            }
        });
    }
    #_processCurrentDifficulty () {
        const minDifficulty = this.#_processMinDifficulty();
        if (minDifficulty > this.#_currentMiningDifficulty) {
            this.#_currentMiningDifficulty = minDifficulty;
        }
    }
    #_processMinDifficulty () {
        let minDiff = this.#_currentBlock.difficulty;
        const maxWinnersPerCurrentEpoch = KeyUtils.getMaxWinnersForBlock(this.#_currentBlock.id);
        if (this.#_currentBlock.winnerscnt >= maxWinnersPerCurrentEpoch) {
            ++minDiff;
        }
        return minDiff;
    }

    terminate () {
        this.#_stopMiner();
    }
}