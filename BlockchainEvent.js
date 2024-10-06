import { EventEmitter } from "events";
import { Web3 } from "web3";
import { Logger } from "./Utils.js";

export class KeyValidatedEvent extends EventEmitter {
    #_contract = null;
    #_subscription = null;
    #_wsProvider = null;

    constructor(contractAbi, contractAddress, infuraApyKey) {
        super();
        const options = {
            clientConfig: {
                keepalive: true,
                keepaliveInterval: 60000
            },
            // Enable auto reconnection
            reconnect: {
                auto: true,
                delay: 5000,
                maxAttempts: 5,
                onTimeout: false
            }
          };
        this.#_wsProvider = new Web3.providers.WebsocketProvider('wss://avalanche-mainnet.infura.io/ws/v3/' + infuraApyKey, options);
        this.#_wsProvider.on('connect', () => {
            Logger.Log("WSS PROVIDER", "Websocket connected.");
            this.#_listen();
        });
        this.#_wsProvider.on('disconnect', () => {
            Logger.Log("WSS PROVIDER", "Websocket disconnected.");
        });
        this.#_wsProvider.on('close', (event) => {
            Logger.Log("WSS PROVIDER", event);
            Logger.Log("WSS PROVIDER", "Websocket closed.");
        });
        this.#_wsProvider.on('error', (error) => {
            Logger.Log("WSS PROVIDER ERROR", error);
        });

        const web3 = new Web3(this.#_wsProvider);
        this.#_contract = new web3.eth.Contract(contractAbi, contractAddress);
    }

    async #_listen () {
        this.#_subscription = await this.#_contract.events.KeyValidated();
        this.#_subscription.on("connected", (id) => {
            Logger.Log(`KeyValidated subscription connected (${id})`);
        });
        this.#_subscription.on("data", (eventData) => {
            this.emit('key-validated', eventData.returnValues);
        });
        this.#_subscription.on("error", (error) => {
            Logger.Log("KeyValidated subs error::", error);
        });
    }

    terminate () {
        try {
            this.#_subscription.removeAllListeners();
            //this.#_subscription.unsubscribe();
            this.#_wsProvider.disconnect();
        } catch (error) {}
        this.#_subscription = null;
    }
}