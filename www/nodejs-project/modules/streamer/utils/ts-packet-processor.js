const Events = require('events'), fs = require('fs')

const SYNC_BYTE = 0x47
const PACKET_SIZE = 188

class MPEGTSPacketProcessor extends Events {
	constructor(){
        super()
        this.joining = true // false for proxy hls
        this.packetFilterPolicy = global.config.get('ts-packet-filter-policy') // what to do with packets with bad size? 0=bypass, 1=force size by trimming or removing if minor, 2=remove
        this.lastFlushTime = 0
        this.minFlushInterval = 3 // secs
        this.buffering = []
        this.bufferSize = 5 * (512 * 1024) // 5MB
        this.maxBufferSize = 10 * (1024 * 1024) // 10MB, if buffer grows more than this, something is going wrong and may fill up memory
        this.maxPcrJournalSize = 2048 // 256 was not enough
        this.pcrJournal = []
        this.debug = false
    }
	len(data){
		if(!data){
			return 0
		} else if(Array.isArray(data)) {
			let len = 0
			data.forEach(d => {
				len += this.len(d)
			})
			return len
		} else if(typeof(data.byteLength) != 'undefined') {
			return data.byteLength
		} else {
			return data.length
		}
	}
    pcr(x, offset=0){
        const header = x.readUInt32BE(offset), adaptationFieldControl = (header & 0x30) >>> 4
        if ((adaptationFieldControl & 0x2) !== 0) {
            var adaptationLength = x.readUInt8(offset + 4)
            if (adaptationLength !== 0) {
                let flags = x.readUInt8(offset + 5), pcrFlag = (flags & 0x10) !== 0
                if (pcrFlag === true) {
                    let adaptationPosition = 6, pcrBase = x.readUInt32BE(offset + adaptationPosition), pcrExtension = x.readUInt16BE(offset + adaptationPosition + 4)
                    pcrBase = pcrBase * 2 + (((pcrExtension & 0x8000) !== 0) ? 1 : 0)
                    pcrExtension = pcrExtension & 0x1ff
                    return pcrBase * 300 + pcrExtension
                }
            }
        }
    }
    readPCRs(buf){
        let pointer = 0, pcrs = [], positions = {}, errorCount = 0, iterationsCounter = 0
        if(!this.checkSyncByte(buf, 0)){
            pointer = this.nextSyncByte(buf, 0)
            if(pointer == -1){
                return {err: null, buf: null, positions: null} // keep this.buffering untouched (if no clear) and stop processing, positions ignored
            } else {
                if(this.debug){
                    console.log('skipping first '+ pointer +' bytes')
                }
            }
        }
        while(pointer >= 0 && (pointer + PACKET_SIZE) <= buf.length){
            if(this.debug){
                iterationsCounter++
            }
            let offset = -1
            if((pointer + PACKET_SIZE) < (buf.length + 4)){ // has a next packet start
                if(!this.checkSyncByte(buf, pointer + PACKET_SIZE)){
                    offset = this.nextSyncByte(buf, pointer + PACKET_SIZE)
                    errorCount++
                    if(errorCount > 10){ // seems not mpegts, discard it all and break
                        if(this.debug){
                            console.log('seems not mpegts, discarding it')
                        }
                        return {err: 'seems not mpegts', buffer: null, positions: null}
                    }
                }
            }
            let size = offset == -1 ? PACKET_SIZE : (offset - pointer)
            if(size == PACKET_SIZE){
                errorCount = 0
            } else {
                switch(this.packetFilterPolicy){
                    case 1:
                        if(size < PACKET_SIZE){
                            if(this.debug){
                                console.log('bad packet size: '+ size +', removing it') //, buf.slice(pointer, pointer + size))
                            }
                            buf = Buffer.concat([buf.slice(0, pointer), buf.slice(pointer + size)])
                            size = 0
                        } else { 
                            if(this.debug){
                                console.log('bad packet size: '+ size +', trimming it') //, buf.slice(pointer, pointer + size))
                            }
                            buf = Buffer.concat([buf.slice(0, pointer + PACKET_SIZE), buf.slice(pointer + size)]) // trim
                            size = PACKET_SIZE
                        }
                        break
                    case 2:
                        if(this.debug){
                            console.log('bad packet size: '+ size +', removing it')
                        }
                        buf = Buffer.concat([buf.slice(0, pointer), buf.slice(pointer + size)])
                        size = 0
                        break
                    default:
                        if(this.debug){
                            console.log('bad packet size: '+ size +', bypassing it')
                        }
                }
            }
            if(!size) continue
            const pcr = this.pcr(buf, pointer)
            if(pcr){
                pcrs.push(pcr)
                if(typeof(positions[pcr]) == 'undefined') {
                    positions[pcr] = pointer
                } else {
                    console.error('PCR dup?', pcr, pointer, Object.assign({}, positions))
                }
            }
            pointer += size
        }
        if(this.debug){
            console.log('pcr iterations', iterationsCounter)
        }
        return {err: null, buf, pcrs, positions} // position keys order is not preserved, so we still need pcrs array
    }
    process(clear){
        if(this.len(this.buffering) < 4) {
            if(clear) {
                this.buffering = []
            }
            return null // nothing to process
        } 
        if(this.debug) {
            console.log('process start')
        }
        try {
            var {err, buf, pcrs, positions} = this.readPCRs(Buffer.concat(this.buffering))
        } catch(e) {
            console.error(e)
        }
        if(typeof(buf) == 'undefined') { // RangeError: Array buffer allocation failed | OOM?
            this.emit('fail')
            this.destroy()
            return
        }
        if(err == null && buf == null) { // insufficient buffer size, keep this.buffering
            if(this.len(this.buffering) > this.maxBufferSize) {
                this.emit('fail')
                this.destroy()
            }
            return
        } else {
            this.buffering = []
            if(err){ // seems not mpegts
                return
            }
        }
        let ret, result = {}
        if(this.joining) {
            let pcrsPerBatch = buf.length / positions.length
            let minMaxPcrJournalSize = Math.min(100000, pcrsPerBatch * 60) // limit maxPcrJournalSize
            if(this.maxPcrJournalSize < minMaxPcrJournalSize) { // increase maxPcrJournalSize adaptively
                this.maxPcrJournalSize = minMaxPcrJournalSize
            }
            if(pcrs.length) {
                let lastKnownPCR
                pcrs.some(pcr => {
                    if(this.pcrJournal.includes(pcr)) {
                        lastKnownPCR = pcr
                    } else {
                        return true
                    }
                })
                if(lastKnownPCR) {
                    let lastKnownPCRPos
                    pcrs.some((pcr, i) => {
                        delete positions[pcr]
                        if(!this.pcrJournal.includes(pcr)) {
                            this.pcrJournal.push(pcr) // a past pcr not collected
                        }
                        if(pcr == lastKnownPCR) {
                            lastKnownPCRPos = i
                            return true
                        }
                    })
                    pcrs = pcrs.slice(lastKnownPCRPos + 1) // update var
                }
                if(pcrs.length > 1){
                    pcrs.slice(0, -1).forEach(pcr => this.pcrJournal.push(pcr)) // collect new pcrs, except the last one which may be partial yet
                }
            }
            if(pcrs.length > 1) {
                const batchLastPCR = pcrs.pop()
                if(pcrs.length){
                    if(this.debug){
                        console.log('new pcrs received', pcrs, JSON.stringify(positions))
                    }
                    result = {
                        start: positions[pcrs[0]],
                        end: positions[batchLastPCR],
                        leftover: positions[batchLastPCR]
                    }
                } else {
                    if(this.debug){
                        console.log('no new complete pcrs received', JSON.stringify(positions))
                    }
                    result = {
                        leftover: 0
                    }
                }
            } else { // no pcr found
                if(this.debug){
                    console.log('no new pcrs received', pcrs.length, global.kbfmt(buf.length), JSON.stringify(positions))
                }
                result = {
                    leftover: 0
                }
            }
        } else {
            result = {
                start: 0,
                end: buf.length,
                leftover: buf.length
            }
        }
        if(typeof(result.start) != 'undefined') {
            ret = buf.slice(result.start, result.end)
            if(this.debug){
                console.log('process*', result, ret.length, ret.length % PACKET_SIZE, global.kbfmt(ret.length))
            }
        }
        if(result.leftover < buf.length) {
            if(clear){
                this.buffering = []
                if(this.debug){
                    console.log('process', 'no leftover due to clear')
                }
            } else {
                this.buffering = [
                    buf.slice(result.leftover)
                ]
                if(this.debug){
                    console.log('process', 'leftover: ' + global.kbfmt(buf.length - result.leftover), result, buf.length)
                }
            }
        } else {
            if(this.debug){
                console.log('process', 'no leftover')
            }
            this.buffering = []
        }
        if(this.debug){
            console.log('process end', time())
        }
        return ret
    }
    checkSyncByte(c, pos){
        if(pos < 0 || pos > (c.length - 4)){
            //console.error('bad checkSyncByte', c.length, c.length - 4, pos)
            return false
        } else {
            const header = c.readUInt32BE(pos || 0), packetSync = (header & 0xff000000) >> 24
            return packetSync == SYNC_BYTE
        }
    }
    nextSyncByte(c, pos){
        while(pos < (c.length - 4)){
            if(this.checkSyncByte(c, pos)){
                return pos
            }
            pos++
        }
        return -1
    }
	push(chunk){
        if(this.destroyed){
            return
        }
        if(!Buffer.isBuffer(chunk)){ // is buffer
            chunk = Buffer.from(chunk)
        }
        this.buffering.push(chunk)
        const now = global.time()
        if(this.len(this.buffering) > this.bufferSize || ((now - this.lastFlushTime) >= this.minFlushInterval)){
            this.flush(false)
        }
    }
    flush(clear){
        if(this.buffering.length){
            if(this.debug){
                console.log('preproc', global.kbfmt(this.len(this.buffering)))
            }
            const now = global.time()
            this.lastFlushTime = now // keep it after process()
            let data = this.process(clear)
            if(data){
                if(this.debug){
                    console.log('posproc', global.kbfmt(this.len(data)))
                }
                this.emit('data', data)
            }
            if(this.debug){
                console.log('flushtime', global.time() - now, clear)
            }
            if(clear){
                this.clear()
            }
        }        
    }
    clear(){
        if(this.debug){
            console.log('clear')
        }
        this.buffering = []
        if(this.pcrJournal.length > this.maxPcrJournalSize){
            let s = this.pcrJournal.length - this.maxPcrJournalSize
            this.pcrJournal = this.pcrJournal.slice(s)
        }
    }
    destroy(){
        this.destroyed = true
        this.buffering = []
        this.pcrJournal = []
        this.removeAllListeners()
    }
}

module.exports = MPEGTSPacketProcessor
