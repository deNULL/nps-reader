const zlib = require('zlib');
const NPS_MAGIC = "nBpRoFiLeR";

class SequentialReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readByte() {
    return this.buffer.readInt8(this.offset++);
  }

  readInt() {
    this.offset += 4;
    return this.buffer.readInt32BE(this.offset - 4);
  }

  readLong() {
    this.offset += 8;
    return this.buffer.readInt32BE(this.offset - 8) * 4294967296 + this.buffer.readUInt32BE(this.offset - 4);
  }

  readDouble() {
    this.offset += 8;
    return this.buffer.readDoubleBE(this.offset - 8);
  }

  readBoolean() {
    return !!this.readByte();
  }

  readUTF() {
    const length = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return this.readString(length);
  }

  readSlice(length) {
    this.offset += length; 
    return this.buffer.slice(this.offset - length, this.offset);
  }

  readString(length) {
    this.offset += length; 
    return this.buffer.toString('utf8', this.offset - length, this.offset);
  }
}

function readCompactCallTree(buffer, collectingTwoTimeStamps, childOffsetSize, offset = 0) {
  const node = {
    methodId:   buffer.readUInt16BE(offset),
    nCalls:     buffer.readUInt32BE(offset + 2),
    time0:      buffer.readUInt8(offset + 6) * 4294967296 + buffer.readUInt32BE(offset + 7),
    selfTime0:  buffer.readUInt8(offset + 11) * 4294967296 + buffer.readUInt32BE(offset + 12),
  }
  offset += 16;
  if (collectingTwoTimeStamps) {
    node.time1 = buffer.readUInt8(offset) * 4294967296 + buffer.readUInt32BE(offset + 1);
    node.selfTime1 = buffer.readUInt8(offset + 5) * 4294967296 + buffer.readUInt32BE(offset + 6);
    offset += 10;
  }
  const nChilds = buffer.readUInt16BE(offset);
  offset += 2;
  node.childs = new Array(nChilds);
  for (let i = 0; i < nChilds; i++) {
    const childOffset = (childOffsetSize == 3) ? buffer.readUInt8(offset) * 65536 + buffer.readUInt16BE(offset + 1) : buffer.readUInt32BE(offset);
    node.childs[i] = readCompactCallTree(buffer, collectingTwoTimeStamps, childOffsetSize, childOffset);
    offset += childOffsetSize;
  }
  return node;
}

class CPUSnapshot {
  static readFromBuffer(buffer) {
    const snap = new CPUSnapshot();
    let reader = new SequentialReader(buffer);
    snap.version = reader.readInt();
    snap.beginTime = reader.readLong();
    snap.timeTaken = reader.readLong();
    snap.collectingTwoTimeStamps = reader.readBoolean();
    const nInstrMethods = reader.readInt();
    snap.methods = new Array(nInstrMethods);
    for (let i = 0; i < nInstrMethods; i++) {
      snap.methods[i] = {
        className: reader.readUTF(),
        methodName: reader.readUTF(),
        methodSignature: reader.readUTF(),
      }
    }
    const nThreads = reader.readInt();
    snap.threads = new Array(nThreads);
    for (let i = 0; i < nThreads; i++) {
      snap.threads[i] = {
        threadId: reader.readInt(),
        threadName: reader.readUTF(),
        collectingTwoTimeStamps: reader.readBoolean(),
      }
      const length = reader.readInt();
      const data = reader.readSlice(length);
      snap.threads[i].nodeSize = reader.readInt();
      snap.threads[i].wholeGraphGrossTimeAbs = reader.readLong();
      snap.threads[i].wholeGraphGrossTimeThreadCPU = reader.readLong();
      snap.threads[i].timeInInjectedCodeInAbsCounts = reader.readDouble();
      snap.threads[i].timeInInjectedCodeInThreadCPUCounts = reader.readDouble();
      snap.threads[i].wholeGraphPureTimeAbs = reader.readLong();
      snap.threads[i].wholeGraphPureTimeThreadCPU = reader.readLong();
      snap.threads[i].wholeGraphNetTime0 = reader.readLong();
      snap.threads[i].wholeGraphNetTime1 = reader.readLong();
      snap.threads[i].totalInvNo = reader.readLong();
      snap.threads[i].displayWholeThreadCPUTime = reader.readBoolean();

      snap.threads[i].callTree = readCompactCallTree(data, snap.collectingTwoTimeStamps, data.length > 0xFFFFFF ? 4 : 3);
    }
    return snap;
  }
}

class NPS {
  static readFromBuffer(buffer) {
    const reader = new SequentialReader(buffer);
    if (reader.readString(NPS_MAGIC.length) !== NPS_MAGIC) {
      throw new Error('Missing file signature (not a NPS snapshot?)');
    }
    const nps = new NPS();
    reader.offset = NPS_MAGIC.length;
    nps.version = [reader.readByte(), reader.readByte()];
    nps.type = reader.readInt();
    const compressedDataLength = reader.readInt();
    const uncompressedDataLength = reader.readInt();
    const data = zlib.inflateSync(reader.readSlice(compressedDataLength));
    if (data.length !== uncompressedDataLength) {
      throw new Error('Invalid uncompressed data length');
    }
    const settingsLength = reader.readInt();
    nps.settings = reader.readString(settingsLength);
    // nps.comments = reader.readUTF();
  
    if (nps.type in NPS.SNAPSHOT_TYPES) {
      nps.snapshot = NPS.SNAPSHOT_TYPES[nps.type].readFromBuffer(data);
    } else {
      throw new Error('Snapshot type ' + nps.type + ' is not yet supported.');
    }
    return nps;
  }
}

NPS.SNAPSHOT_TYPE_UNKNOWN = 0;
NPS.SNAPSHOT_TYPE_CPU = 1;
NPS.SNAPSHOT_TYPE_CODEFRAGMENT = 2;
NPS.SNAPSHOT_TYPE_MEMORY_ALLOCATIONS = 4;
NPS.SNAPSHOT_TYPE_MEMORY_LIVENESS = 8;
NPS.SNAPSHOT_TYPE_MEMORY_SAMPLED = 16;
NPS.SNAPSHOT_TYPE_CPU_JDBC = 32;
NPS.SNAPSHOT_TYPE_MEMORY = NPS.SNAPSHOT_TYPE_MEMORY_ALLOCATIONS | NPS.SNAPSHOT_TYPE_MEMORY_LIVENESS | NPS.SNAPSHOT_TYPE_MEMORY_SAMPLED;

NPS.SNAPSHOT_TYPES = {};
NPS.SNAPSHOT_TYPES[NPS.SNAPSHOT_TYPE_CPU] = CPUSnapshot;

exports = NPS;