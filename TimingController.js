import { EventEmitter } from "events";
import { Logger } from "./Utils.js";
import { LocalSyncedTimestamp } from "./Utils.js";

export class TimingController extends EventEmitter {

    #_blockDeadlineTimeoutId = false;
    #_nextBlockTimeoutId = false;

    #_currentBlock = null;
    #_running = false;

    constructor () {
        super();
    }

    getCurrentBlock () {
        if (this.#_running == true) {
            return this.#_currentBlock;
        }
        return null;
    }

    setNewBlock (p_currentBlock) {
        this.#_clearTimeouts();
        this.#_stop();
        this.#_currentBlock = p_currentBlock;
        this.#_setDeadline(this.#_currentBlock.deadline);
    }

    updateBlock (p_currBlock) {
        if (p_currBlock.deadline > 0 && this.#_currentBlock.deadline == 0) {
            this.#_currentBlock = p_currBlock;
            this.#_setDeadline(this.#_currentBlock.deadline);
            return;
        }
        this.#_currentBlock = p_currBlock;
    }

    #_setDeadline (deadline) {
        if (deadline == 0) {
            this.#_run();
            return;
        }
        const remainingTime = Number(deadline - LocalSyncedTimestamp.getTimestamp());
        const t1 = 60;
        if (remainingTime > t1) {
            this.#_run();
            this.#_setDeadlineTimeout(remainingTime - t1 + 15);
        } else {
            this.#_stop();
            this.#_setLoadNextBlockTimeout(remainingTime <= 0 ? 30 : remainingTime + 30);
        }
    }
    // start - stop
    #_run () {
        if (this.#_running == true) {
            return;
        }
        this.#_running = true;
        this.emit('run', this.#_currentBlock.id);
    }
    #_stop () {
        if (this.#_running == false) {
            return;
        }
        this.#_running = false;
        this.emit('stop', this.#_currentBlock.id);
    }
    // deadline timeout
    #_setDeadlineTimeout (timeoutSeconds) {
        Logger.Log(">>>>>TimingController._setDeadlineTimeout in:", timeoutSeconds, "seconds");
        this.#_clearTimeouts();
        this.#_blockDeadlineTimeoutId = setTimeout(() => {
            this.#_onDeadlineTimeout();
        }, timeoutSeconds * 1000);
    }
    #_onDeadlineTimeout () {
        Logger.Log(">>>>>TimingController._onDeadlineTimeout()");
        this.#_blockDeadlineTimeoutId = false;
        this.#_stop();
        const remainingTime = Number(this.#_currentBlock.deadline - LocalSyncedTimestamp.getTimestamp());
        this.#_setLoadNextBlockTimeout (remainingTime <= 0 ? 30 : remainingTime + 30);
    }
    // next block timeout
    #_setLoadNextBlockTimeout (timeoutSeconds) {
        Logger.Log(">>>>>TimingController._setLoadNextBlockTimeout() in", timeoutSeconds, "seconds");
        console.log("\x1b[33m Mining will resume in aprox %i seconds \x1b[0m ", timeoutSeconds);
        this.#_clearTimeouts();
        this.#_nextBlockTimeoutId = setTimeout(() => {
            this.#_loadNextBlockTimeout();
        }, timeoutSeconds * 1000);
    }
    #_loadNextBlockTimeout () {
        Logger.Log(">>>>>TimingController._loadNextBlockTimeout()");
        this.#_nextBlockTimeoutId = false;
        this.emit('load-next-block', this.#_currentBlock.id + 1n);
    }
    #_clearTimeouts () {
        if (this.#_blockDeadlineTimeoutId != false) {
            clearTimeout(this.#_blockDeadlineTimeoutId);
            this.#_blockDeadlineTimeoutId = false;
        }
        if (this.#_nextBlockTimeoutId != false) {
            clearTimeout(this.#_nextBlockTimeoutId);
            this.#_nextBlockTimeoutId = false;
        }
    }
}