import { EventEmitter } from "events";
import { Logger } from "./Utils.js";
import { TransactionRevertInstructionError, ContractExecutionError } from "web3";

export class AvaxBalanceGetter extends EventEmitter {
    #_web3 = null;
    constructor (web3){
        super();
        this.#_web3 = web3;
    }
    get (address) {
        this.#_web3.eth.getBalance(address)
        .then((data) => {
            this.emit('loaded', data);
        }).catch((error) => {
            this.emit('error', error);
        });
    }
}

export class BlockchainTimestampGetter extends EventEmitter {
    #_web3 = null;
    constructor (web3){
        super();
        this.#_web3 = web3;
    }
    get () {
        this.#_web3.eth.getBlock("latest")
        .then((data) => {
            this.emit('loaded', data.timestamp);
        }).catch((error) => {
            this.emit('error', error);
        });
    }
}

export class KeySubmitter extends EventEmitter {
    #_contract = null;
    #_web3 = null;
    #_queue = [];
    #_avaxBalance = 0n;
    #_flag = false;
    #_disposed = false;

    constructor(contract, web3) {
        super();
        this.#_contract = contract;
        this.#_web3 = web3;
    }
    postKey (postData) {
        this.#_queue.push(postData);
        this.#_next();
    }
    updateBalance (avaxBalance) {
        this.#_avaxBalance = avaxBalance;
    }
    
    #_next () {
        if (this.#_disposed === true || this.#_flag === true || this.#_queue.length == 0) {
            return;
        }
        this.#_flag = true;
        const data = this.#_queue.pop();
        const method_abi = this.#_contract.methods.postKey(data.address, data.key, data.salt).encodeABI();
        const tx = {
            from: this.#_web3.eth.accounts.wallet[0].address,
            to: this.#_contract.options.address,
            data: method_abi,
            value: '0',
        };
        this.#_web3.eth.getGasPrice().
        then(gasPrice => {
            if (this.#_disposed === true) {
                return;
            }
            Logger.Log("gasPrice:%s", gasPrice);
            tx.gasPrice = gasPrice * (100n + 5n) / 100n;
            this.#_web3.eth.estimateGas(tx)
            .then(async (gas) => {
                if (this.#_disposed === true) {
                    return;
                }
                Logger.Log("GAS:::%s", gas);
                if (gas > this.#_avaxBalance) {
                    this.emit('low-gas');
                    return;
                }
                tx.gas = gas;
                // proceed w the transaction
                const signedTx = await this.#_web3.eth.accounts.signTransaction(tx, this.#_web3.eth.accounts.wallet[0].privateKey);
                // Sending the transaction to the network
                this.#_web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .then(receipt => {
                    if (this.#_disposed === true) {
                        return;
                    }
                    if (receipt.cumulativeGasUsed != undefined && receipt.effectiveGasPrice != undefined) {
                        const avaxUsed = receipt.cumulativeGasUsed * receipt.effectiveGasPrice;
                        this.emit('avax-used', avaxUsed);
                    } else {
                        this.emit('avax-used', 0n);
                    }
                    this.#_flag = false;
                    this.emit('key-posted', data);
                    setTimeout(() => {
                        this.#_next();
                    }, 500);
                })
                .catch(error => {
                    this.#_flag = false;
                    this.#_parseError(error);
                });
            })
            .catch((error) => {
                this.#_flag = false;
                this.#_parseError(error);
            });
        })
        .catch(error => {
            this.#_flag = false;
            this.#_parseError(error);
        });
        return;
    }

    #_parseError (error) {
        if (this.#_disposed === true) {
            return;
        }
        Logger.Log("ERROR:", error);
        if (error.code === undefined) {
            this.emit('fatal', error);
            return;
        }
        if (error.code === 402) {
            this.emit('out-of-gas');
            return;
        }
        if (error.code === 310) {//CONTRACT_REVERTED_ERROR
            if (error.cause === undefined || error.cause === null || error.cause.message === undefined || error.cause.message === null) {
                this.emit('fatal', error);
            }
            const expectedErrors = ["DIFFICULTY_LOW", "DUPLICATE_ENTRY", "BAD_KEY"];
            for (let i = 0; i < expectedErrors.length; i++) {
                if (error.cause.message.includes(expectedErrors[i])) {
                    Logger.Log("KeySubmitter emit %o", expectedErrors[i]);
                    this.emit(expectedErrors[i]);
                    return;
                }
            }
            this.emit('fatal', error);
            return;
        }
        if (error.code === "ECONNRESET") {
            //to handle this in the future versions
            return;
        }
        this.emit('fatal', error);
    }
    dispose () {
        this.#_queue.length = 0;
        this.#_disposed = true;
    }
}

export class BlockSealer extends EventEmitter {
    #_contract = null;
    #_web3 = null;

    constructor(contract, web3) {
        super();
        this.#_contract = contract;
        this.#_web3 = web3;
    }
    
    sealBlock (blockId) {
        const method_abi = this.#_contract.methods.sealBlock(blockId).encodeABI();
        const tx = {
            from: this.#_web3.eth.accounts.wallet[0].address,
            to: this.#_contract.options.address,
            data: method_abi,
            value: '0',
        };
        this.#_web3.eth.getGasPrice().
        then(gasPrice => {
            Logger.Log("gasPrice:%o", gasPrice);
            tx.gasPrice = gasPrice * (100n + 0n) / 100n;
            this.#_web3.eth.estimateGas(tx)
            .then(async (gas) => {
                Logger.Log("GAS:::%o", gas);
                tx.gas = gas;// - 1000n;
                // proceed w the transaction
                const signedTx = await this.#_web3.eth.accounts.signTransaction(tx, this.#_web3.eth.accounts.wallet[0].privateKey);
                // Sending the transaction to the network
                this.#_web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .then(receipt => {
                    Logger.Log("sealBlock() RECEIPT", receipt);
                })
                .catch(error => {
                    this.#_parseError(error);
                });
            })
            .catch((error) => {
                this.#_parseError(error);
            });
        })
        .catch(error => {
            this.#_parseError(error);
        });
        return;
    }

    #_parseError (error) {
        Logger.Log("ERROR:", error);
        if (error.code === undefined) {
            this.emit('fatal', error);
            return;
        }
        if (error.code === 402) {
            this.emit('out-of-gas');
            return;
        }
        if (error.code === 310) {//CONTRACT_REVERTED_ERROR
            if (error.cause === undefined || error.cause === null || error.cause.message === undefined || error.cause.message === null) {
                this.emit('fatal', error);
            }
            const expectedErrors = [];
            for (let i = 0; i < expectedErrors.length; i++) {
                if (error.cause.message.includes(expectedErrors[i])) {
                    return;
                }
            }
            this.emit('fatal', error);
            return;
        }
        if (error.code === "ECONNRESET") {
            //to handle this in the future versions
            return;
        }
        this.emit('fatal', error);
    }
}


export class TransferTokens {
    #_contract = null;
    #_web3 = null;

    constructor(contract, web3) {
        this.#_contract = contract;
        this.#_web3 = web3;
    }
    
    transfer (to, amountWei) {
        const method_abi = this.#_contract.methods.transfer(to, amountWei).encodeABI();
        const tx = {
            from: this.#_web3.eth.accounts.wallet[0].address,
            to: this.#_contract.options.address,
            data: method_abi,
            value: '0',
        };
        this.#_web3.eth.getGasPrice().
        then(gasPrice => {
            tx.gasPrice = gasPrice * (100n + 0n) / 100n;
            this.#_web3.eth.estimateGas(tx)
            .then(async (gas) => {
                Logger.Log(to, amountWei);
                tx.gas = gas;
                // proceed w the transaction
                const signedTx = await this.#_web3.eth.accounts.signTransaction(tx, this.#_web3.eth.accounts.wallet[0].privateKey);
                // Sending the transaction to the network
                this.#_web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .then(receipt => {
                    console.log("\x1b[42m SUCCESS \x1b[0m")
                    Logger.Log("transfer() RECEIPT", receipt);
                })
                .catch(error => {
                    this.#_parseError(error);
                });
            })
            .catch((error) => {
                this.#_parseError(error);
            });
        })
        .catch(error => {
            this.#_parseError(error);
        });
        return;
    }

    #_parseError (error) {
        console.log("\x1b[41m ERROR \x1b[0m");
        if (error.cause != undefined && error.cause.message != undefined) {
            console.log("\x1b[31m %s \x1b[0m", error.cause.message);
            return;
        }
        console.log(error);
    }
}


export class StakeTokens extends EventEmitter {
    #_contract = null;
    #_web3 = null;

    constructor(contract, web3) {
        super();
        this.#_contract = contract;
        this.#_web3 = web3;
    }

    getInterestAmount (amountWei, period, upfrontInterest, cliff) {
        this.#_contract.methods.getStakingInterestAmount(amountWei, period, upfrontInterest, cliff).call()
        .then((value) => {
            this.emit('interest-amount', value);
        })
        .catch((error) => {
            this.#_parseError(error);
        });
    }
    
    stake (amountWei, period, upfrontInterest, cliff, minInterestAmountWei) {
        const method_abi = this.#_contract.methods.stake(amountWei, period, upfrontInterest, cliff, minInterestAmountWei).encodeABI();
        const tx = {
            from: this.#_web3.eth.accounts.wallet[0].address,
            to: this.#_contract.options.address,
            data: method_abi,
            value: '0',
        };
        this.#_web3.eth.getGasPrice().
        then(gasPrice => {
            tx.gasPrice = gasPrice * (100n + 0n) / 100n;
            this.#_web3.eth.estimateGas(tx)
            .then(async (gas) => {
                tx.gas = gas;
                // proceed w the transaction
                const signedTx = await this.#_web3.eth.accounts.signTransaction(tx, this.#_web3.eth.accounts.wallet[0].privateKey);
                // Sending the transaction to the network
                this.#_web3.eth.sendSignedTransaction(signedTx.rawTransaction)
                .then(receipt => {
                    Logger.Log("transfer() RECEIPT", receipt);
                    this.emit('success');
                })
                .catch(error => {
                    this.#_parseError(error);
                });
            })
            .catch((error) => {
                this.#_parseError(error);
            });
        })
        .catch(error => {
            this.#_parseError(error);
        });
        return;
    }

    withdraw (positions) {
        const method_abi = this.#_contract.methods.withdrawStakings(positions).encodeABI();
        const tx = {
            from: this.#_web3.eth.accounts.wallet[0].address,
            to: this.#_contract.options.address,
            data: method_abi,
            value: '0',
        };
        this.#_web3.eth.getGasPrice().
        then(gasPrice => {
            Logger.Log("gasPrice:%o", gasPrice);
            tx.gasPrice = gasPrice * (100n + 0n) / 100n;
            this.#_web3.eth.estimateGas(tx)
            .then(async (gas) => {
                Logger.Log("GAS:::%o", gas);
                //this.emit('success');
                //return;
                tx.gas = gas;
                // proceed w the transaction
                const signedTx = await this.#_web3.eth.accounts.signTransaction(tx, this.#_web3.eth.accounts.wallet[0].privateKey);
                Logger.Log("Raw transaction data: " + signedTx.rawTransaction);
                // Sending the transaction to the network
                const prom = this.#_web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                prom.then(receipt => {
                    //Logger.Log("transfer() RECEIPT", receipt);
                    this.emit('success');
                })
                .catch(error => {
                    this.#_parseError(error);
                });
            })
            .catch((error) => {
                this.#_parseError(error);
            });
        })
        .catch(error => {
            this.#_parseError(error);
        });
        return;
    }

    #_parseError (error) {
        console.log("\x1b[41m ERROR \x1b[0m");
        if (error.cause != undefined && error.cause.message != undefined) {
            console.log("\x1b[31m %s \x1b[0m", error.cause.message);
        } else {
            console.log(error);
        }
        this.emit('error');
    }
}