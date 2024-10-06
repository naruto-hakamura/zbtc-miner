import { EventEmitter } from "events";
export class CurrentBlockLoader extends EventEmitter {
    #_tokenContract = null;
    #_currentBlock = null;
    #_loading = false;
    #_minBlockId = 0n;
    #_reloadTimeoutId = false;

    constructor(contract) {
        super();
        this.#_tokenContract = contract;
    }

    loadCurrentBlock (minBlockId) {
        if (minBlockId > this.#_minBlockId) {
            this.#_minBlockId = minBlockId;
        }
        this.#_loadCurrentBlock();
    }
    #_loadCurrentBlock() {
        //console.log("CurrentBlockLoader.loadCurrentBlock()");
        if (this.#_reloadTimeoutId !== false) {
            clearTimeout(this.#_reloadTimeoutId);
            this.#_reloadTimeoutId = false;
        }
        if (this.#_loading) {
            return;
        }
        this.#_loading = true;
        this.#_load();
    }

    #_load () {
        //console.log("CurrentBlockLoader.#_load()");
        this.#_tokenContract.methods.getCurrentBlock().call()
        .then((block) => {
            this.#_loading = false;
            //console.log('getCurrentBlock() response: %o', block);
            try {
                if (this.#_currentBlock === null) {
                    this.#_currentBlock = block;
                    this.#_minBlockId = this.#_currentBlock.id;
                    //console.log("=== emit new-block-loaded");
                    this.emit('new-block-loaded', this.#_currentBlock);
                    return;
                }
                if (block.id < this.#_minBlockId) {
                    this.#_reloadTimeoutId = setTimeout(() => {
                        this.#_loadCurrentBlock();
                    }, 30000);
                    return;
                }
                this.#_minBlockId = block.id;
                
                if (block.id > this.#_currentBlock.id) {
                    this.#_currentBlock = block;
                    //console.log("=== emit new-block-loaded");
                    this.emit('new-block-loaded', this.#_currentBlock);
                    return;
                }
                this.#_currentBlock = block;
                //console.log("=== emit block-updated");
                this.emit('block-updated', this.#_currentBlock);
            } catch (err) { // catching any runtime error here and exit
                console.error("ERR:" + err.stack);
                process.exit(2);
            }
        }).catch((error) => {
            this.#_loading = false;
            this.emit('error', error);
        });
    }
}