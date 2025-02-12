
const path = require('path'), http = require('http'), stoppable = require('stoppable'), StreamerAdapterBase = require('../adapters/base.js'), closed = require('../../on-closed')

const SYNC_BYTE = 0x47

class Downloader extends StreamerAdapterBase {
	constructor(url, opts){
		opts = Object.assign({
            debug: false,
			initialErrorLimit: 2, // at last 2
			errorLimit: 5,
			sniffingSizeLimit: 196 * 1024, // if minor, check if is binary or ascii (maybe some error page)
			checkSyncByte: false
		}, opts || {})
		super(url, opts)
		this.type = 'downloader'
		this.internalErrorLevel = 0
		this.internalErrors = []
		this.connectable = false
        this._destroyed = false
        this.timer = 0
		this.connectTime = -1
		this.lastConnectionStartTime = 0
		this.lastConnectionEndTime = 0
		this.lastConnectionReceived = 0
		this.buffer = []
		this.ext = 'ts'
		this.debugConns = false
		this.currentDownloadUID = undefined
		this.collectBitrateSampleOffset = {}
		let m = url.match(new RegExp('\\.([a-z0-9]{2,4})($|[\\?#])', 'i'))
		if(m && m.length > 1){
			this.ext = m[1]
		}
		this.on('destroy', () => {
			if(!this._destroyed){
				console.log('DOWNLOADER DESTROY', this._destroyed)
				this._destroyed = true
				this.endRequest()
				if(this.server){
					this.server.close()
				}
				this.currentRequest = null
			}
		})
		process.nextTick(() => this.pump())
	}
	getContentType(){
		if(this.opts.contentType){
			return this.opts.contentType
		} else {
			switch(this.ext){
				case 'aac':
				case 'aacp':
					return 'audio/aacp'
				case 'mp3':
					return 'audio/mpeg'
			}
			return 'video/MP2T'
		}
	}
    checkSyncByte(c, pos){
        if(pos < 0 || pos > (c.length - 4)){
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
	start(){
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, response) => {
				if(path.basename(req.url) == 'stream.'+ this.ext){
					response.writeHead(200, {
						'content-type': this.getContentType(),
						'connection': 'close'
					})
					let byteSyncFound, finished
					const listener = (url, chunk) => {
						if(!byteSyncFound && this.opts.checkSyncByte){
							let pos = this.nextSyncByte(chunk, 0)
							if(pos == -1){
								return // ignore this chunk
							}
							byteSyncFound = true
							if(pos > 0){
								chunk = chunk.slice(pos)
							}
						}
						if(chunk.length){
							response.write(chunk)
						}
					}, finish = () => {
						if(!finished){
							finished = true
							this.removeListener('data', listener)
							this.removeListener('destroy', finish)
							response.end()
						}
					}
					closed(req, response, finish)
					if(this.buffer.length){
						listener('', Buffer.concat(this.buffer))
						this.buffer = []
					}
					this.on('data', listener)
					this.on('destroy', finish)
				} else {
					response.statusCode = 404
					response.end('File not found!')
				}
			})
            this.serverStopper = stoppable(this.server)
			this.server.listen(this.opts.port, '127.0.0.1', err => {
				if(err){
					console.error('unable to listen on port', err)
					return reject(err)
				}
				if(!this.server){
					return reject('destroyed')
				}
				this.opts.port = this.server.address().port
				this.endpoint = 'http://127.0.0.1:'+ this.opts.port +'/stream.'+ this.ext
				resolve(this.opts.port)
			}) 
		})
	}
	internalError(e){
		if(!this.committed){
			this.internalErrorLevel++
			this.internalErrors.push(e)
			if(this.internalErrorLevel >= (this.connectable ? this.opts.errorLimit : this.opts.initialErrorLimit)){
				let status = this.internalErrorStatusCode()
				console.error('[' + this.type + '] error limit reached', this.committed, this.internalErrorLevel, this.internalErrors, status, this.opts.errorLimit)
				this.fail(status)
			}
		}
		return this.destroyed || this._destroyed
	}
	internalErrorStatusCode(){
		let status = 0
		this.internalErrors.some(code => {
			if(code >= 400 && code < 500){
				status = code
				return true
			}
		})
		if(!status){
			this.internalErrors.some(code => {
				if(code >= 500){
					status = code
					return true
				}
			})
		}
		return status
	}
	isMetaData(data){
		let sample, limit = 4096
		if(data.length > limit){
			sample = String(data.slice(0, limit / 2)) + String(data.slice(0, -1 * (limit / 2)))
		} else {
			sample = String(data)
		}
		if(sample){
			if(sample.match(new RegExp('<\/?(xmp|rdf)'))){
				return true
			}
		}
	}
	handleDataValidate(data){
		if(!data || this.destroyed || this._destroyed){
			return
		}
		/*
		if(this.opts.debug){
			console.log('[' + this.type + '] data received', String(data))
		}
		*/
		let skip, len = this.len(data)
		if(!len){
			skip = true
		} else if(len < this.opts.sniffingSizeLimit){
			if(!global.streamer.isBin(data) && !this.isMetaData(data)){
				skip = true
				console.error('bad data', len, data, this.url)
			}
        }
		if(!skip){
			this.internalErrorLevel = 0
			this.connectable = true
            return true
		}
	}
	handleData(data){
		if(this.handleDataValidate(data)){
			this.output(data)
		}
	}
	output(data, len){
		if(this.destroyed || this._destroyed){
			return
		}
        if(typeof(len) != 'number'){
            len = this.len(data)
        }
		if(len > 1){
			if(typeof(this.collectBitrateSampleOffset[this.currentDownloadUID]) == 'undefined'){
				this.collectBitrateSampleOffset[this.currentDownloadUID] = 0
			}
		    this.collectBitrateSample(data, this.collectBitrateSampleOffset[this.currentDownloadUID], len, this.currentDownloadUID)
			this.collectBitrateSampleOffset[this.currentDownloadUID] += data.length
			if(this.listenerCount('data')){
				this.emit('data', this.url, data, len)
			} else {
				this.buffer.push(data)
			}
		}
    }
    afterDownload(err, callback, data){
        this.endRequest()
        if(this.destroyed || this._destroyed){
            return
        }
        if(this.opts.debug){
            if(err){
                console.log('[' + this.type + '] DOWNLOAD ERR', err, data)   
            } else {
                console.log('[' + this.type + '] after download', data)
            }
        }
        if(callback){
            process.nextTick(callback.bind(this, err, data))
        }
    }
	download(callback){
        clearTimeout(this.timer)
		if(this.destroyed || this._destroyed) return
		let connTime, received = 0, connStart = global.time()
		this.finishBitrateSample(this.currentDownloadUID)
		this.currentDownloadUID = String(connStart)
		this.lastConnectionStartTime = connStart
		const download = this.currentRequest = new global.Download({
			url: this.url,
			authURL: this.opts.authURL || false,
			keepalive: this.committed && global.config.get('use-keepalive'),
			followRedirect: true,
			acceptRanges: false,
			retries: 3, // strangely, some servers always abort the first try, throwing "The server aborted pending request"
			debug: this.debugConns
		})
		download.on('error', error => {
			let elapsed = global.time() - connStart
            console.warn('['+ this.type +'] ERR after '+ elapsed +'s', error, this.url)
			if(this.committed){
				let statusCode = 0
				if(error && error.response && error.response.statusCode){
					statusCode = error.response.statusCode
				}
				global.osd.show(global.streamer.humanizeFailureMessage(statusCode || 'timeout'), 'fas fa-times-circle', 'debug-conn-err', 'normal')
			}
		})
		download.once('response', (statusCode, headers) => {
			let contentType = ''
            if(this.opts.debug){
                console.log('[' + this.type + '] response', statusCode, headers)
            }
			statusCode = statusCode
			headers = headers
			contentType = typeof(headers['content-type']) != 'undefined' ? headers['content-type'] : ''
			if(this.opts.debug){
				console.log('[' + this.type + '] headers received', headers, statusCode, contentType) // 200
			}
			if(statusCode >= 200 && statusCode <= 300){
				if(!this.opts.contentType && contentType.match(new RegExp('^(audio|video)'))){
					this.opts.contentType = contentType
				}
				download.on('data', chunk => {
					if(typeof(connTime) == 'undefined'){
						connTime = global.time() - connStart
						this.connectTime = connTime
						if(this.opts.debug){
							console.log('[' + this.type + '] receiving data, took '+ connTime +'s to connect') // 200
						}
					}
					received += chunk.length
					this.handleData(chunk)
				})
				download.once('end', () => {
					this.lastConnectionEndTime = global.time()
					this.lastConnectionReceived = received
					if(this.opts.debug){
						console.log('[' + this.type + '] received '+ global.kbfmt(received) +' in '+ (this.lastConnectionEndTime - connStart) +'s to connect') // 200
					}
					this.endRequest()
					if(callback){
						this.afterDownload(null, callback, {contentType, statusCode, headers})
						callback = null
					}
				})
			} else {
				download.end()
				if(this.committed && (!statusCode || statusCode < 200 || statusCode >= 400)){ // skip redirects
					//global.osd.show(global.streamer.humanizeFailureMessage(statusCode || 'timeout'), 'fas fa-times-circle', 'debug-conn-err', 'normal')
					global.osd.show(global.lang.CONNECTION_FAILURE +' ('+ (statusCode || 'timeout') +')', 'fas fa-times-circle', 'debug-conn-err', 'normal')				
				}
				this.internalError(statusCode)
				if(statusCode){
					setTimeout(() => this.afterDownload('bad response', callback, {contentType, statusCode, headers}), 1000) // delay to avoid abusing
				} else {
					this.afterDownload('bad response', callback, {contentType, statusCode, headers}) // timeout, no delay so
				}
			}
		})
		download.start()
	}
	pump(){
		this.download(() => {
			if(this.opts.debug){
				console.log('[' + this.type + '] host closed', Array.isArray(this.nextBuffer))
			}
			this.endRequest()
			if(this.destroyed || this._destroyed){
				return
			}
            this.timer = setTimeout(this.pump.bind(this), 0) 
			/* avoiding nested call to next pump to prevent mem leaking */
		})
	}
	endRequest(){
		if(this.currentRequest){
			this.currentRequest.destroy()
			this.currentRequest = null
		}
	}
}
	
module.exports = Downloader
