const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

const sizeBytes = parseInt(workerData.sizeBytes) || (256 * 1024 * 1024); // Default 256MB
let isRunning = true;

parentPort.on('message', (msg) => {
  if (msg === 'stop') {
    isRunning = false;
  }
});

function runTest() {
  try {
    parentPort.postMessage({ type: 'status', message: `Allocating ${(sizeBytes / (1024 * 1024)).toFixed(0)} MB...` });
    const buffer = Buffer.alloc(sizeBytes);
    parentPort.postMessage({ type: 'status', message: `Allocated. Starting read/write stress loops.` });

    let iterations = 0;
    const chunkSize = 4 * 1024 * 1024; // 4MB chunks
    const randomChunk = crypto.randomBytes(chunkSize);

    function runIteration() {
      if (!isRunning) {
        parentPort.postMessage({ type: 'status', message: 'Test stopped by user.' });
        parentPort.postMessage({ type: 'done' });
        return;
      }

      try {
        // 1. Write Phase: Fill buffer with random chunk repetitions
        for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
          const currentChunkSize = Math.min(chunkSize, sizeBytes - offset);
          randomChunk.copy(buffer, offset, 0, currentChunkSize);
        }

        // 2. Read / Verify Phase: Calculate a checksum by sampling buffer bytes
        let checksum = 0;
        for (let i = 0; i < sizeBytes; i += 4096) {
          checksum = (checksum + buffer[i]) % 1000000007;
        }

        iterations++;
        parentPort.postMessage({ 
          type: 'progress', 
          iterations, 
          bytesTested: sizeBytes,
          checksum 
        });

        // Yield control to the event loop so it can handle "stop" messages from parentPort
        setTimeout(runIteration, 10);
      } catch (innerErr) {
        parentPort.postMessage({ type: 'error', error: innerErr.message });
      }
    }

    // Start iterations
    runIteration();
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
}

runTest();
