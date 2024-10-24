import { parentPort, workerData } from 'worker_threads';
import { numberToHex, soliditySha3 } from 'web3-utils';
import { Logger } from "./Utils.js";

parentPort.on('message', data => {
  if (data.code == 3) {
    run(data.difficulty, data.random, data.address, data.num0, data.num1, data.salt);
  }
});

function keccak256(random, address, keysalt) {
    const hash = soliditySha3(
      { type: 'uint256', value: random },
      { type: 'address', value: address },
      { type: 'string', value: keysalt });
    return hash;
}

function keyMatch(key, keccakHash) {
  return keccakHash.toString().match(key);
}

async function run(difficulty, random, p_address, num0, num1, salt) {
  let hashCount = 0n;
  const size = 2_000n;
  const sTime = Date.now();
  parentPort.postMessage({code:210, ts:sTime, hashCount:0n});
  for (let i = num1; i >= num0; --i) {
    // generate the key
    let hexKey = numberToHex(i).slice(2);
    while (hexKey.length < difficulty) {
      hexKey = '0' + hexKey;
    }
    // keccak hash
    let keysalt = (salt == '') ? hexKey : hexKey + '~' + salt;
    let keccakHash = keccak256(random, p_address, keysalt);
    if (keyMatch(hexKey, keccakHash)) {
      parentPort.postMessage({code:200, address:p_address, key: hexKey, keccakHash:keccakHash, salt:salt});
    }

    ++hashCount;
    if (hashCount % size == 0n) {
      parentPort.postMessage({code:210, ts:Date.now(), hashCount:size});
    }
  }

  parentPort.postMessage({code:100, dt:Date.now() - sTime, hashCount:hashCount});
}
function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
} 
