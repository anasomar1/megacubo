const StreamerBaseIntent = require('./base.js'), StreamerAdapterAAC = require('../adapters/aac.js'), Any2HLS = require('../utils/any2hls'), fs = require('fs')

class StreamerAACIntent extends StreamerBaseIntent {    
    constructor(data, opts, info){
        console.log('AACOPTS', opts)
        opts = Object.assign(opts, {
            audioCodec: null,
            videoCodec: null
        })
        super(data, opts, info)
        this.type = 'aac'
        this.mediaType = 'audio'
        this.mimetype = this.mimeTypes.hls
    }  
    _start(){ 
        return new Promise((resolve, reject) => {
            this.downloader = new StreamerAdapterAAC(this.data.url, this.opts)
            this.connectAdapter(this.downloader)
            this.downloader.start().then(() => {
                this.ts2hls = new Any2HLS(this.downloader.source.endpoint, this.opts)
                this.ts2hls.opts.audioCodec = this.opts.audioCodec
                this.connectAdapter(this.ts2hls)
                this.ts2hls.start().then(() => {
                    this.endpoint = this.ts2hls.endpoint
                    resolve()
                }).catch(reject)
            }).catch(reject)
        })
    }
}

StreamerAACIntent.mediaType = 'audio'
StreamerAACIntent.supports = (info) => {
    if(info.contentType){
        let c = info.contentType.toLowerCase()
        if(c.indexOf('audio/') != -1 && c.indexOf('mpegurl') == -1){
            return true
        }
    }
    if(info.ext && ['aac', 'ogg', 'mp3', 'm4a', 'flac'].includes(info.ext)){
        return true
    }
    return false
}

module.exports = StreamerAACIntent

